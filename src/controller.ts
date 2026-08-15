/** Session lifecycle and ApiProxy orchestration for the terminal renderer. */

import { open, readFile, unlink } from 'node:fs/promises'
import { basename, extname, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type {
  DownloadsApi, GoalRef, HistoryEntry, IApiClient, ModelProviderGroup, PromptContentPart,
  QueuedInboxItem, RpcResponse, SessionSummary, SubagentAddress, WorkspaceId,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { AttachmentId, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {
  MessageFeedbackDeleteRequest, MessageFeedbackDeleteResult, MessageFeedbackListRequest,
  MessageFeedbackListResult, MessageFeedbackPutRequest, MessageFeedbackPutResult,
} from '@deepseek-ai/dsh-message-feedback/types'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiStartupValues } from './startup.ts'
import {
  applyHistory, applyHostFrame, applyMuxFrame, contentText, createInitialState, toggleFold,
  type PendingApproval, type PendingQuestion, projectedTitle, projectionStatus, type TuiPicker,
  type TuiViewState,
} from './model.ts'

type Listener = () => void

function asSessionId(value: string): SessionId {
  return value as SessionId
}

interface MessageFeedbackClient {
  list(request: MessageFeedbackListRequest): Promise<MessageFeedbackListResult>
  put(request: MessageFeedbackPutRequest): Promise<MessageFeedbackPutResult>
  delete(request: MessageFeedbackDeleteRequest): Promise<MessageFeedbackDeleteResult>
}

interface TuiCordisInventoryRow {
  pluginId: string
  agentId: string
  packages: ReadonlyArray<{
    packageId: string
    name: string
    purpose: string
    hasHostHalf: boolean
    hasClientHalf: boolean
  }>
  currentPackageId?: string
  nextPackageId?: string
  activeRun?: { packageId: string }
  latestRun?: { status: string }
}

interface TuiCordisClient {
  inventory(): TuiCordisInventoryRow[]
  runHostOnly(sessionId: string, pluginId: string, packageId?: string): Promise<string>
  stop(sessionId: string, pluginId: string): Promise<string>
  remove(sessionId: string, pluginId: string): Promise<string>
}

interface TuiPluginInventoryClient {
  list(): ReadonlyArray<{
    entryId: string
    moduleName: string
    enabled: boolean
    fiberPhase: string | null
  }>
}

/** Host-only capabilities whose transports intentionally sit outside IApiClient. */
export interface TuiHostExtensions {
  feedback?: MessageFeedbackClient
  downloads?: DownloadsApi
  cordis?: TuiCordisClient
  plugins?: TuiPluginInventoryClient
}

type TuiTarget =
  | { kind: 'session'; summary: SessionSummary }
  | { kind: 'subagent'; address: SubagentAddress; cwd?: string }

function failure<T>(response: RpcResponse<T>): Error | undefined {
  return response.result.ok
    ? undefined
    : new Error(`${response.result.error.code}: ${response.result.error.message}`)
}

function value<T>(response: RpcResponse<T>): T {
  const error = failure(response)
  if (error !== undefined) throw error
  if (!response.result.ok) throw new Error('unreachable')
  return response.result.value
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function currentTimeZone(): string | undefined {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

function rootSession(items: readonly SessionSummary[]): SessionSummary | undefined {
  return items.find(item => item.origin !== 'subagent')
}

function compactJson(input: unknown): string {
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

function prettyJson(input: unknown): string[] {
  try {
    return JSON.stringify(input, undefined, 2).split('\n')
  } catch {
    return [String(input)]
  }
}

function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : `${(value / 1024).toFixed(1)} KiB`
}

function firstArgument(input: string): { value: string; rest: string } {
  const trimmed = input.trimStart()
  if (trimmed === '') return { value: '', rest: '' }
  const quote = trimmed[0]
  if (quote !== '"' && quote !== "'") {
    const boundary = trimmed.search(/\s/)
    return boundary < 0
      ? { value: trimmed, rest: '' }
      : { value: trimmed.slice(0, boundary), rest: trimmed.slice(boundary).trimStart() }
  }
  let value = ''
  for (let index = 1; index < trimmed.length; index += 1) {
    const character = trimmed[index] as string
    if (character === quote) return { value, rest: trimmed.slice(index + 1).trimStart() }
    if (character === '\\' && index + 1 < trimmed.length) {
      index += 1
      value += trimmed[index] as string
    } else value += character
  }
  throw new Error('引号未闭合')
}

function confirmed(input: string): { confirmed: boolean; rest: string } {
  const match = /(?:^|\s)--yes\s*$/.exec(input)
  return match === null
    ? { confirmed: false, rest: input.trim() }
    : { confirmed: true, rest: input.slice(0, match.index).trim() }
}

function jsonPointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) throw new Error('设置路径必须是 JSON Pointer，例如 /profiles/default/model')
  return pointer.slice(1).split('/').map(part => part.replaceAll('~1', '/').replaceAll('~0', '~'))
}

function imageMediaType(path: string): ImageMediaType {
  switch (extname(path).toLowerCase()) {
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: throw new Error('图片仅支持 png、jpg/jpeg、webp 或 gif')
  }
}

function imageExtension(mediaType: ImageMediaType): string {
  switch (mediaType) {
    case 'image/png': return 'png'
    case 'image/jpeg': return 'jpg'
    case 'image/webp': return 'webp'
    case 'image/gif': return 'gif'
  }
}

function feedbackError(result: { ok: false; error: { code: string } }): Error {
  return new Error(`feedback: ${result.error.code}`)
}

/** Owns one terminal's selected session, streams, and answerable interactions. */
export class TuiController {
  private state = createInitialState()
  private readonly listeners = new Set<Listener>()
  private readonly muxAbort = new AbortController()
  private readonly hostAbort = new AbortController()
  private bufferedMux: Array<{ rpcId: Parameters<typeof applyMuxFrame>[1]; frame: Parameters<typeof applyMuxFrame>[2] }> = []
  private historyReady = false
  private started = false
  private target: TuiTarget | undefined
  private readonly targetStack: TuiTarget[] = []
  private historyEntries: HistoryEntry[] = []
  /** Durable event sequences already folded for the current transcript. */
  private readonly seenEventSeqs = new Set<number>()
  private hasMoreHistory = false
  private historyResyncing = false
  private modelGroups: ModelProviderGroup[] = []

  /**
   * @param api - Payload-direct client over the in-process ApiProxy fetch carrier.
   * @param extensions - Host-only services whose contracts intentionally have no unary client face.
   */
  constructor(
    private readonly api: IApiClient,
    private readonly extensions: TuiHostExtensions = {},
  ) {}

  /** Stable terminal-view snapshot getter. */
  readonly getSnapshot = (): TuiViewState => this.state

  /** Subscribe the terminal view to state publications. */
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(next: TuiViewState): void {
    if (Object.is(this.state, next)) return
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private update(update: (state: TuiViewState) => TuiViewState): void {
    this.publish(update(this.state))
  }

  private async openMux(onOpen: () => void): Promise<void> {
    try {
      for await (const envelope of this.api.events.mux({}, this.muxAbort.signal, onOpen)) {
        if (!this.historyReady) {
          this.bufferedMux.push({ rpcId: envelope.rpcId, frame: envelope.payload })
          continue
        }
        this.applyMuxEnvelope(envelope.rpcId, envelope.payload)
      }
      if (!this.muxAbort.signal.aborted) this.setNotice('会话事件流已关闭')
    } catch (error) {
      if (!this.muxAbort.signal.aborted) this.setNotice(`会话事件流错误：${message(error)}`)
    } finally {
      // Also release startup when the carrier fails before becoming readable;
      // the baseline request will surface the durable failure state.
      onOpen()
    }
  }

  private async openHost(): Promise<void> {
    try {
      for await (const envelope of this.api.events.host({}, this.hostAbort.signal)) {
        this.update(state => applyHostFrame(state, envelope.payload))
      }
      if (!this.hostAbort.signal.aborted) this.setNotice('主机事件流已关闭')
    } catch (error) {
      if (!this.hostAbort.signal.aborted) this.setNotice(`主机事件流错误：${message(error)}`)
    }
  }

  private async resolveSession(config: TuiStartupValues, initial: readonly SessionSummary[]): Promise<SessionSummary> {
    if (config.resume !== undefined) {
      const wanted = asSessionId(config.resume)
      const found = initial.find(item => item.sessionId === wanted)
      if (found === undefined) throw new Error(`找不到会话 ${config.resume}`)
      return await this.attachWorkspaceSession(found)
    }
    if (config.continueLatest) {
      const found = rootSession(initial)
      if (found !== undefined) return await this.attachWorkspaceSession(found)
    }
    const createdValue = await this.createWorkspaceSession(config.cwd)
    const refreshed = await this.api.sessions.list({})
    const listError = failure(refreshed)
    if (listError !== undefined) throw listError
    if (!refreshed.result.ok) throw new Error('unreachable')
    const found = refreshed.result.value.items.find(item => item.sessionId === createdValue.sessionId)
    return found ?? {
      sessionId: createdValue.sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd: createdValue.cwd,
      ...(createdValue.agentPreset === undefined ? {} : { agentPreset: createdValue.agentPreset }),
    }
  }

  private async refreshSessions(): Promise<SessionSummary[]> {
    const items = value(await this.api.sessions.list({})).items
    this.update(state => ({ ...state, sessions: items }))
    return items
  }

  private async createWorkspaceSession(cwd?: string): Promise<{
    sessionId: SessionId
    agentPreset?: string
    cwd: string
  }> {
    const path = cwd ?? value(await this.api.host.describe({})).cwd
    const workspace = value(await this.api.workspace.create({ path })).workspace
    const created = value(await this.api.sessions.create({ workspaceId: workspace.workspaceId }))
    return { ...created, cwd: workspace.path }
  }

  private async attachWorkspaceSession(summary: SessionSummary): Promise<SessionSummary> {
    if (summary.origin === 'subagent' || summary.cwd === undefined) return summary
    const workspace = value(await this.api.workspace.create({ path: summary.cwd })).workspace
    const attached = value(await this.api.sessions.create({
      workspaceId: workspace.workspaceId,
      sessionId: summary.sessionId,
    }))
    return {
      ...summary,
      cwd: workspace.path,
      ...(attached.agentPreset === undefined ? {} : { agentPreset: attached.agentPreset }),
    }
  }

  private drainBufferedMux(): void {
    this.historyReady = true
    const buffered = this.bufferedMux
    this.bufferedMux = []
    for (const [index, envelope] of buffered.entries()) {
      if (!this.historyReady) {
        this.bufferedMux.push(...buffered.slice(index))
        break
      }
      this.applyMuxEnvelope(envelope.rpcId, envelope.frame)
    }
  }

  /** Replace `historyEntries` and rebuild the seen-seq set from it. */
  private replaceHistory(entries: HistoryEntry[]): void {
    this.historyEntries = entries
    this.seenEventSeqs.clear()
    for (const entry of entries) this.seenEventSeqs.add(entry.event.seq)
  }

  private applyMuxEnvelope(rpcId: Parameters<typeof applyMuxFrame>[1], frame: Parameters<typeof applyMuxFrame>[2]): void {
    if (frame.type === 'session/subscribed' && frame.sessionId === this.state.sessionId
      && frame.lastSeq > this.state.lastSeq) {
      this.scheduleHistoryResync()
    }
    if (frame.type === 'session/event' && frame.sessionId === this.state.sessionId
      && !this.seenEventSeqs.has(frame.event.seq)) {
      this.seenEventSeqs.add(frame.event.seq)
      this.historyEntries.push({ event: frame.event, ...(frame.view === undefined ? {} : { view: frame.view }) })
    }
    this.update(state => applyMuxFrame(state, rpcId, frame))
  }

  private scheduleHistoryResync(): void {
    if (this.historyResyncing) return
    const target = this.target
    if (target === undefined) return
    this.historyResyncing = true
    this.historyReady = false
    void this.refetchHistory(target).then(() => {
      if (this.target === target) this.setNotice('事件流已恢复并同步遗漏记录')
    }).catch((error: unknown) => {
      if (this.target === target) this.setNotice(`事件流恢复失败：${message(error)}`)
    }).finally(() => {
      this.historyResyncing = false
      if (this.target === target) this.drainBufferedMux()
    })
  }

  private async refetchHistory(target: TuiTarget): Promise<void> {
    const boundary = this.state.lastSeq
    const fetched: HistoryEntry[] = []
    const anchors = new Set<number>()
    let beforeSeq: number | undefined
    let projections: Record<string, unknown> | undefined
    while (true) {
      const page = target.kind === 'session'
        ? value(await this.api.sessions.history({
          sessionId: target.summary.sessionId,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages: 100,
        }))
        : value(await this.api.subagents.history({
          ...target.address,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
          maxMessages: 100,
        }))
      if (this.target !== target) return
      if (beforeSeq === undefined) projections = page.projections?.values
      fetched.push(...page.events)
      const minimum = page.events.reduce<number | undefined>((current, entry) => (
        current === undefined ? entry.event.seq : Math.min(current, entry.event.seq)
      ), undefined)
      if (!page.hasMore || minimum === undefined || minimum <= boundary || anchors.has(minimum)) break
      anchors.add(minimum)
      beforeSeq = minimum
    }

    const bySeq = new Map<number, HistoryEntry>()
    for (const entry of [...this.historyEntries, ...fetched]) bySeq.set(entry.event.seq, entry)
    this.replaceHistory([...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq))
    const current = this.state
    const baselineProjections = projections ?? current.projections
    const folded = applyHistory({
      ...createInitialState(),
      phase: 'ready',
      sessionId: current.sessionId,
      title: projectedTitle(baselineProjections),
      agentPreset: current.agentPreset,
      cwd: current.cwd,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      modelContextWindow: current.modelContextWindow,
      running: current.running,
      queueSize: current.queueSize,
      queueItems: current.queueItems,
      jobs: current.jobs,
      projections: baselineProjections,
      sessions: current.sessions,
      interaction: current.interaction,
      overlay: current.overlay,
      picker: current.picker,
      notice: current.notice,
    }, this.historyEntries)
    if (this.target === target) this.publish(folded)
  }

  private async loadSession(
    summary: SessionSummary,
    sessions: SessionSummary[],
    resetNavigation = true,
  ): Promise<void> {
    if (resetNavigation) this.targetStack.length = 0
    this.target = { kind: 'session', summary }
    this.historyReady = false
    const baseline = summary.projections?.values ?? {}
    this.publish({
      ...createInitialState(),
      sessionId: summary.sessionId,
      title: projectedTitle(baseline),
      agentPreset: summary.agentPreset,
      cwd: summary.cwd,
      running: summary.running,
      projections: baseline,
      sessions,
    })
    const [historyResponse, modelsResponse] = await Promise.all([
      this.api.sessions.history({ sessionId: summary.sessionId, maxMessages: 100 }),
      this.api.sessions.models({ sessionId: summary.sessionId }),
    ])
    const history = value(historyResponse)
    this.replaceHistory([...history.events])
    this.hasMoreHistory = history.hasMore
    let next = applyHistory(this.state, history.events)
    if (modelsResponse.result.ok) this.modelGroups = modelsResponse.result.value.groups
    const model = modelsResponse.result.ok
      ? `${modelsResponse.result.value.current.provider}/${modelsResponse.result.value.current.model}`
      : undefined
    const reasoningEffort = modelsResponse.result.ok
      ? modelsResponse.result.value.current.reasoningEffort
        ?? this.catalogDefaultEffort(
          modelsResponse.result.value.current.provider,
          modelsResponse.result.value.current.model,
        )
      : undefined
    const projections = { ...next.projections, ...(history.projections?.values ?? {}) }
    next = {
      ...next,
      phase: 'ready',
      model,
      reasoningEffort,
      projections,
      title: projectedTitle(projections),
      ...(modelsResponse.result.ok
        ? {}
        : { notice: `${modelsResponse.result.error.code}: ${modelsResponse.result.error.message}` }),
    }
    this.publish(next)
    this.drainBufferedMux()
  }

  private async loadSubagent(address: SubagentAddress, cwd?: string): Promise<void> {
    this.historyReady = false
    const sessions = this.state.sessions
    const history = await (async () => {
      try {
        return value(await this.api.subagents.history({ ...address, maxMessages: 100 }))
      } catch (error) {
        this.drainBufferedMux()
        throw error
      }
    })()
    this.target = { kind: 'subagent', address, ...(cwd === undefined ? {} : { cwd }) }
    this.publish({
      ...createInitialState(),
      sessionId: address.childSessionId,
      cwd,
      sessions,
    })
    this.replaceHistory([...history.events])
    this.hasMoreHistory = history.hasMore
    const next = applyHistory(this.state, history.events)
    const projections = { ...next.projections, ...(history.projections?.values ?? {}) }
    this.publish({
      ...next,
      phase: 'ready',
      projections,
      title: projectedTitle(projections),
      notice: address.mode === 'one-shot' ? '只读 one-shot subagent' : undefined,
    })
    this.drainBufferedMux()
  }

  /**
   * Resolve/create the selected session, establish streams, and load its baseline.
   * @param config - Parsed startup values for the terminal invocation.
   */
  async start(config: TuiStartupValues): Promise<void> {
    if (this.started) return
    this.started = true
    try {
      const listed = await this.api.sessions.list({})
      const listError = failure(listed)
      if (listError !== undefined) throw listError
      if (!listed.result.ok) throw new Error('unreachable')
      const summary = await this.resolveSession(config, listed.result.value.items)
      const sessions = listed.result.value.items.some(item => item.sessionId === summary.sessionId)
        ? listed.result.value.items.map(item => item.sessionId === summary.sessionId ? summary : item)
        : [summary, ...listed.result.value.items]
      let markMuxOpen: (() => void) | undefined
      const muxOpen = new Promise<void>((resolve) => { markMuxOpen = resolve })
      void this.openMux(() => { markMuxOpen?.() })
      await muxOpen
      await this.loadSession(summary, sessions)
      void this.openHost()
      if (config.initialPrompt !== undefined) await this.send(config.initialPrompt)
    } catch (error) {
      this.historyReady = true
      // Discard frames buffered while the baseline history was loading: the
      // session failed to come up, so replaying them keeps a stale buffer
      // around that would otherwise keep growing. New frames flow straight to
      // applyMuxEnvelope now that historyReady is true.
      this.bufferedMux = []
      this.publish({ ...this.state, phase: 'error', notice: message(error) })
    }
  }

  private showOverlay(title: string, lines: string[]): void {
    this.update(state => ({ ...state, overlay: { title, lines }, picker: undefined, notice: undefined }))
  }

  private showPicker(picker: TuiPicker): void {
    this.update(state => ({ ...state, overlay: undefined, picker, notice: undefined }))
  }

  /** Close the terminal-native management panel. */
  closeOverlay(): void {
    this.update(state => ({ ...state, overlay: undefined }))
  }

  /** Close a keyboard-driven picker without changing its selected value. */
  closePicker(): void {
    this.update(state => ({ ...state, picker: undefined }))
  }

  private selectedSessionId(): SessionId {
    const sessionId = this.state.sessionId
    if (sessionId === undefined) throw new Error('当前没有可用会话')
    return sessionId
  }

  private findSession(items: readonly SessionSummary[], query: string): SessionSummary {
    const matches = items.filter(item => item.sessionId === query || item.sessionId.startsWith(query))
    if (matches.length === 0) throw new Error(`找不到会话 ${query}`)
    if (matches.length > 1) throw new Error(`会话前缀不唯一：${query}`)
    return matches[0] as SessionSummary
  }

  /** Hide blank sessions from pickers; the currently loaded session stays visible for context. */
  private pickerSessions(items: readonly SessionSummary[]): SessionSummary[] {
    return items.filter(item => !item.blank || item.sessionId === this.state.sessionId)
  }

  private showSessionPicker(items: readonly SessionSummary[], title = '选择会话'): void {
    if (items.length === 0) throw new Error('没有可选择的会话')
    this.showPicker({
      kind: 'session',
      title,
      current: this.state.sessionId,
      items: items.map((item) => {
        const status = item.running ? '执行中' : item.blank ? '空白' : '空闲'
        const name = projectedTitle(item.projections?.values ?? {})
          ?? (item.cwd === undefined ? String(item.sessionId) : basename(item.cwd) || String(item.sessionId))
        return {
          value: String(item.sessionId),
          label: `${name} · ${status}`,
          description: item.cwd ?? '未记录目录',
        }
      }),
    })
  }

  private async commandSessions(query: string): Promise<void> {
    const items = await this.refreshSessions()
    let shown = items
    if (query !== '') {
      const hits = value(await this.api.sessions.search({ query })).items
      const ids = new Set(hits.map(hit => hit.sessionId))
      shown = items.filter(item => ids.has(item.sessionId))
    }
    shown = this.pickerSessions(shown)
    if (shown.length === 0) throw new Error('没有匹配的会话')
    this.showSessionPicker(shown, query === '' ? '选择会话' : `选择会话 · ${query}`)
  }

  private async commandNew(cwd: string): Promise<void> {
    const created = await this.createWorkspaceSession(cwd === '' ? undefined : cwd)
    const items = await this.refreshSessions()
    const summary = items.find(item => item.sessionId === created.sessionId) ?? {
      sessionId: created.sessionId,
      updatedAt: Date.now(),
      running: false,
      blank: true,
      cwd: created.cwd,
      ...(created.agentPreset === undefined ? {} : { agentPreset: created.agentPreset }),
    }
    await this.loadSession(summary, items.some(item => item.sessionId === summary.sessionId) ? items : [summary, ...items])
  }

  private async commandResume(query: string): Promise<void> {
    const items = await this.refreshSessions()
    if (query === '') {
      this.showSessionPicker(this.pickerSessions(items))
      return
    }
    const summary = await this.attachWorkspaceSession(this.findSession(items, query))
    await this.loadSession(
      summary,
      items.map(item => item.sessionId === summary.sessionId ? summary : item),
    )
  }

  /** Adapter-advertised default thinking effort for one exact model route. */
  private catalogDefaultEffort(provider: string, model: string): string | undefined {
    return this.modelGroups
      .find(group => group.id === provider)
      ?.models.find(item => item.id === model)
      ?.reasoning?.defaultEffort
  }

  private async commandModels(): Promise<void> {
    await this.commandModel('', undefined)
  }

  private async commandModel(route: string, effort: string | undefined): Promise<void> {
    if (route === '') {
      const models = value(await this.api.sessions.models({ sessionId: this.selectedSessionId() }))
      this.modelGroups = models.groups
      const items = models.groups.flatMap(group => group.models.map(model => ({
        value: `${group.id}/${model.id}`,
        label: `${model.name} · ${group.name}`,
        ...(model.description === undefined ? {} : { description: model.description }),
      })))
      if (items.length === 0) throw new Error('当前没有可选择的模型')
      this.showPicker({
        kind: 'model',
        title: '选择模型',
        current: `${models.current.provider}/${models.current.model}`,
        items,
      })
      return
    }
    const separator = route.indexOf('/')
    if (separator <= 0 || separator === route.length - 1) throw new Error('用法：/model [provider/model] [reasoning-effort]')
    const provider = route.slice(0, separator)
    const model = route.slice(separator + 1)
    const selected = value(await this.api.sessions.selectModel({
      sessionId: this.selectedSessionId(), provider, model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }),
    })).selected
    this.update(state => ({
      ...state,
      model: `${selected.provider}/${selected.model}`,
      reasoningEffort: selected.reasoningEffort ?? this.catalogDefaultEffort(selected.provider, selected.model),
      overlay: undefined,
      picker: undefined,
    }))
    this.setNotice(`模型已切换为 ${selected.provider}/${selected.model}`)
  }

  /**
   * Apply the highlighted value from the active picker.
   * @param value - Opaque value owned by the active picker.
   */
  async choosePicker(value: string): Promise<void> {
    const picker = this.state.picker
    if (picker === undefined) return
    try {
      switch (picker.kind) {
        case 'directory': await this.commandDirectories(value); break
        case 'model': await this.commandModel(value, undefined); break
        case 'preset': await this.commandPreset(value); break
        case 'provider': await this.commandProviderModels(value); break
        case 'session': await this.commandResume(value); break
        case 'settings': await this.commandSettingsShow(value); break
        case 'subagent': await this.commandSubagent(value); break
      }
    } catch (error) {
      this.setNotice(`选择失败：${message(error)}`)
    }
  }

  private async commandOlder(): Promise<void> {
    if (!this.hasMoreHistory) {
      this.setNotice('已经到达 transcript 起点')
      return
    }
    const beforeSeq = this.historyEntries.reduce<number | undefined>((minimum, entry) => (
      minimum === undefined ? entry.event.seq : Math.min(minimum, entry.event.seq)
    ), undefined)
    if (beforeSeq === undefined) throw new Error('当前 transcript 没有分页锚点')
    const target = this.target
    if (target === undefined) throw new Error('当前导航目标不可用')
    const page = target.kind === 'session'
      ? value(await this.api.sessions.history({ sessionId: target.summary.sessionId, beforeSeq, maxMessages: 100 }))
      : value(await this.api.subagents.history({ ...target.address, beforeSeq, maxMessages: 100 }))
    const bySeq = new Map<number, HistoryEntry>()
    for (const entry of [...page.events, ...this.historyEntries]) bySeq.set(entry.event.seq, entry)
    this.replaceHistory([...bySeq.values()].sort((left, right) => left.event.seq - right.event.seq))
    this.hasMoreHistory = page.hasMore
    const current = this.state
    const folded = applyHistory({
      ...createInitialState(),
      phase: 'ready',
      sessionId: current.sessionId,
      title: current.title,
      agentPreset: current.agentPreset,
      cwd: current.cwd,
      model: current.model,
      reasoningEffort: current.reasoningEffort,
      modelContextWindow: current.modelContextWindow,
      running: current.running,
      queueSize: current.queueSize,
      queueItems: current.queueItems,
      jobs: current.jobs,
      projections: current.projections,
      sessions: current.sessions,
      interaction: current.interaction,
      overlay: current.overlay,
      picker: current.picker,
    }, this.historyEntries)
    this.publish({
      ...folded,
      partialText: current.partialText,
      partialReasoning: current.partialReasoning,
      partialTool: current.partialTool,
      notice: `已加载 ${String(page.events.length)} 条更早记录${page.hasMore ? '' : ' · 已到起点'}`,
    })
  }

  private queueItem(query: string): QueuedInboxItem {
    const matches = this.state.queueItems.filter(item => String(item.id) === query || String(item.id).startsWith(query))
    if (matches.length === 0) throw new Error(`找不到 queue item ${query}`)
    if (matches.length > 1) throw new Error(`queue item 前缀不唯一：${query}`)
    return matches[0] as QueuedInboxItem
  }

  private commandQueue(): void {
    this.showOverlay('Queue', this.state.queueItems.length === 0 ? ['当前队列为空'] : this.state.queueItems.map((item) => {
      const preview = contentText(item.message.content).replaceAll('\n', ' ')
      return `${item.id} · ${item.placement} · ${preview || '[非文本消息]'}`
    }))
  }

  private async commandQueueEdit(input: string): Promise<void> {
    const itemArgument = firstArgument(input)
    if (itemArgument.value === '' || itemArgument.rest.trim() === '') throw new Error('用法：/queue-edit <item-id> <text>')
    const item = this.queueItem(itemArgument.value)
    value(await this.api.sessions.updateQueue({
      sessionId: this.selectedSessionId(),
      itemId: item.id,
      action: { kind: 'edit', content: [{ type: 'text', text: itemArgument.rest.trim() }] },
    }))
    this.setNotice(`已更新 queue item ${item.id}`)
  }

  private async commandQueueRemove(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed) throw new Error('删除待处理消息需要追加 --yes')
    const item = this.queueItem(confirmation.rest)
    value(await this.api.sessions.updateQueue({
      sessionId: this.selectedSessionId(), itemId: item.id, action: { kind: 'remove' },
    }))
    this.setNotice(`已删除 queue item ${item.id}`)
  }

  private async commandQueueSteer(query: string): Promise<void> {
    if (query === '') throw new Error('用法：/queue-steer <item-id>')
    const item = this.queueItem(query)
    value(await this.api.sessions.updateQueue({
      sessionId: this.selectedSessionId(), itemId: item.id, action: { kind: 'steer' },
    }))
    this.setNotice(`已将 queue item ${item.id} 插入当前轮次`)
  }

  private async commandPresets(): Promise<void> {
    const roster = value(await this.api.agentPresets.list({}))
    if (roster.presets.length === 0) throw new Error('当前组合未启用 preset roster')
    this.showPicker({
      kind: 'preset',
      title: '选择 Agent Preset',
      current: this.state.agentPreset,
      items: roster.presets.map((preset) => {
        const flags = [preset.isDefault ? '默认' : '', preset.trust === 'user' ? '用户' : '系统', preset.broken === undefined ? '' : `损坏: ${preset.broken}`].filter(Boolean)
        return {
          value: preset.id,
          label: `${preset.name ?? preset.id} · ${flags.join('/')}`,
          ...(preset.description === undefined ? {} : { description: preset.description }),
        }
      }),
    })
  }

  private async commandPreset(agentPreset: string): Promise<void> {
    if (agentPreset === '') {
      await this.commandPresets()
      return
    }
    if (agentPreset === this.state.agentPreset) {
      this.closePicker()
      this.setNotice(`当前已使用 preset ${agentPreset}`)
      return
    }
    const sessionId = this.selectedSessionId()
    const selected = value(await this.api.agentPresets.select({ sessionId, agentPreset })).agentPreset
    this.update(state => ({
      ...state,
      agentPreset: selected,
      overlay: undefined,
      picker: undefined,
      sessions: state.sessions.map(item => item.sessionId === sessionId ? { ...item, agentPreset: selected } : item),
    }))
    this.setNotice(`Preset 已切换为 ${selected}`)
  }

  private async commandPresetRead(agentPreset: string): Promise<void> {
    if (agentPreset === '') throw new Error('用法：/preset-read <id>')
    const preset = value(await this.api.agentPresets.read({ agentPreset }))
    this.showOverlay(`Preset · ${preset.agentPreset}`, [
      `${preset.trust === 'user' ? '用户' : '系统'} · ${preset.name ?? preset.agentPreset}`,
      ...(preset.description === undefined ? [] : [preset.description]),
      '',
      ...preset.content.split('\n'),
    ])
  }

  private async commandPresetCopy(input: string): Promise<void> {
    const from = firstArgument(input)
    const target = firstArgument(from.rest)
    if (from.value === '' || target.value === '') throw new Error('用法：/preset-copy <source-id> <new-id> [display-name]')
    const copied = value(await this.api.agentPresets.copy({
      from: from.value,
      agentPreset: target.value,
      ...(target.rest === '' ? {} : { name: target.rest }),
    }))
    this.setNotice(`已创建用户 preset ${copied.agentPreset}`)
    await this.commandPresets()
  }

  private async commandPresetOpen(agentPreset: string): Promise<void> {
    if (agentPreset === '') throw new Error('用法：/preset-open <user-preset-id>')
    const result = value(await this.api.agentPresets.openDocument({ agentPreset }))
    this.setNotice(result.opened ? `已打开 preset ${agentPreset}` : `请编辑：${result.path}`)
  }

  private async commandPresetRemove(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') throw new Error('删除用户 preset 需要：/preset-remove <id> --yes')
    value(await this.api.agentPresets.remove({ agentPreset: confirmation.rest }))
    this.setNotice(`已删除用户 preset ${confirmation.rest}`)
    await this.commandPresets()
  }

  private async commandWorkspaces(): Promise<void> {
    const result = value(await this.api.workspace.list({}))
    this.showOverlay('Workspaces', result.items.length === 0 ? ['尚无 workspace；使用 /workspace-new <path> 创建'] : result.items.map(item => (
      `${item.workspaceId} · ${item.title} · ${item.path} · ${String(item.sessionIds.length)} 个会话`
    )))
  }

  private async commandWorkspaceNew(path: string): Promise<void> {
    if (path === '') throw new Error('用法：/workspace-new <existing-directory>')
    const result = value(await this.api.workspace.create({ path }))
    this.setNotice(`${result.created ? '已创建' : '已存在'} workspace：${result.workspace.title}`)
    await this.commandWorkspaces()
  }

  private async commandWorkspaceRename(input: string): Promise<void> {
    const workspace = firstArgument(input)
    if (workspace.value === '' || workspace.rest === '') throw new Error('用法：/workspace-rename <workspace-id> <title>')
    const result = value(await this.api.workspace.rename({
      workspaceId: workspace.value as WorkspaceId,
      title: workspace.rest,
    }))
    this.setNotice(`Workspace 已重命名为 ${result.workspace.title}`)
    await this.commandWorkspaces()
  }

  private async commandWorkspaceDelete(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') {
      throw new Error('移除 workspace 注册需要：/workspace-delete <workspace-id> --yes（目录和会话日志不会删除）')
    }
    value(await this.api.workspace.delete({ workspaceId: confirmation.rest as WorkspaceId }))
    this.setNotice(`已移除 workspace 注册 ${confirmation.rest}；目录和会话日志保持不变`)
    await this.commandWorkspaces()
  }

  private async commandWorkspaceMove(input: string): Promise<void> {
    const workspace = firstArgument(input)
    const before = firstArgument(workspace.rest)
    if (workspace.value === '') throw new Error('用法：/workspace-move <workspace-id> [before-workspace-id|end]')
    value(await this.api.workspace.insertBefore({
      workspaceId: workspace.value as WorkspaceId,
      ...(before.value === '' || before.value === 'end' ? {} : { beforeWorkspaceId: before.value as WorkspaceId }),
    }))
    this.setNotice(`已移动 workspace ${workspace.value}`)
    await this.commandWorkspaces()
  }

  private async commandWorkspaceSessionMove(input: string): Promise<void> {
    const workspace = firstArgument(input)
    const session = firstArgument(workspace.rest)
    const before = firstArgument(session.rest)
    if (workspace.value === '' || session.value === '') {
      throw new Error('用法：/workspace-session-move <workspace-id> <session-id> [before-session-id|end]')
    }
    value(await this.api.workspace.insertSessionBefore({
      workspaceId: workspace.value as WorkspaceId,
      sessionId: asSessionId(session.value),
      ...(before.value === '' || before.value === 'end' ? {} : { beforeSessionId: asSessionId(before.value) }),
    }))
    this.setNotice(`已在 workspace 中移动 session ${session.value}`)
  }

  private async commandArchive(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed) throw new Error('归档会话需要：/archive [session-id] --yes')
    const sessionId = confirmation.rest === '' || confirmation.rest === 'current'
      ? this.selectedSessionId()
      : asSessionId(confirmation.rest)
    value(await this.api.workspace.archiveSession({ sessionId }))
    this.setNotice(`已归档 session ${sessionId}`)
  }

  private async commandSkills(): Promise<void> {
    const result = value(await this.api.skills.list({ sessionId: this.selectedSessionId() }))
    this.showOverlay('Skills', result.skills.length === 0 ? ['当前项目没有可调用 skill'] : result.skills.map(skill => (
      `/${skill.name} · ${skill.description}${skill.modelInvocable ? '' : ' · 仅用户调用'}`
    )))
  }

  private async commandSubagents(): Promise<void> {
    const result = value(await this.api.subagents.list({ parentSessionId: this.selectedSessionId() }))
    const children = result.entries.filter(entry => entry.kind === 'child')
    if (children.length === 0) {
      const diagnostics = result.entries.filter(entry => entry.kind === 'diagnostic')
      this.showOverlay('Subagents', diagnostics.length === 0
        ? ['当前会话没有直接子代理']
        : diagnostics.map(entry => `! ${entry.id} · ${entry.reason}`))
      return
    }
    this.showPicker({
      kind: 'subagent',
      title: '选择 Subagent',
      current: undefined,
      items: children.map(entry => ({
        value: String(entry.id),
        label: entry.label ?? String(entry.id),
        description: `${entry.mode} · ${entry.activity}`,
      })),
    })
  }

  private async commandSubagent(query: string): Promise<void> {
    if (query === '') {
      await this.commandSubagents()
      return
    }
    const parentSessionId = this.selectedSessionId()
    const catalog = value(await this.api.subagents.list({ parentSessionId }))
    const matches = catalog.entries.filter(entry => entry.kind === 'child'
      && (entry.id === query || entry.id.startsWith(query)))
    if (matches.length === 0) throw new Error(`找不到 subagent ${query}`)
    if (matches.length > 1) throw new Error(`subagent 前缀不唯一：${query}`)
    const child = matches[0]
    if (child?.kind !== 'child') throw new Error(`subagent ${query} 不可用`)
    const address: SubagentAddress = child.mode === 'continuable'
      ? { parentSessionId, childSessionId: child.id, mode: 'continuable' }
      : { parentSessionId, childSessionId: child.id, mode: 'one-shot' }
    const previous = this.target
    if (previous === undefined) throw new Error('当前导航目标不可用')
    this.targetStack.push(previous)
    try {
      await this.loadSubagent(address, this.state.cwd)
    } catch (error) {
      this.targetStack.pop()
      throw error
    }
  }

  private async commandBack(): Promise<void> {
    const previous = this.targetStack.pop()
    if (previous === undefined) throw new Error('当前不在 subagent transcript 中')
    if (previous.kind === 'session') await this.loadSession(previous.summary, this.state.sessions, false)
    else await this.loadSubagent(previous.address, previous.cwd)
  }

  private async commandSettings(): Promise<void> {
    const result = value(await this.api.settings.describe({}))
    if (result.namespaces.length === 0) throw new Error('当前没有 settings namespace')
    this.showPicker({
      kind: 'settings',
      title: '选择 Settings Namespace',
      current: undefined,
      items: result.namespaces.map((namespace) => {
        const secrets = namespace.secrets.filter(secret => secret.set).length
        return {
          value: namespace.ns,
          label: namespace.ns,
          description: `${namespace.applies === 'live' ? '实时' : '重启'} · revision ${String(namespace.revision)} · ${namespace.user === undefined ? '默认值' : '有用户覆盖'}${namespace.secrets.length === 0 ? '' : ` · secret ${String(secrets)}/${String(namespace.secrets.length)}`}`,
        }
      }),
    })
  }

  private async commandSettingsShow(input: string): Promise<void> {
    const namespace = firstArgument(input)
    const schema = namespace.rest === '--schema'
    if (namespace.value === '' || (namespace.rest !== '' && !schema)) {
      throw new Error('用法：/settings-show <namespace> [--schema]')
    }
    const described = value(await this.api.settings.describe({}))
    const current = described.namespaces.find(item => item.ns === namespace.value)
    if (current === undefined) throw new Error(`未知 settings namespace：${namespace.value}`)
    const secrets = current.secrets.length === 0
      ? ['无']
      : current.secrets.map(secret => `${secret.path.join('/')} · ${secret.set ? '已配置' : '未配置'}`)
    this.showOverlay(`Settings · ${current.ns}`, [
      `生效：${current.applies === 'live' ? '实时' : '重启后'} · revision ${String(current.revision)}`,
      '',
      '有效值',
      ...prettyJson(current.value),
      '',
      '用户覆盖',
      ...prettyJson(current.user ?? {}),
      '',
      'Secret（值始终隐藏）',
      ...secrets,
      ...schema ? ['', 'Schema', ...prettyJson(current.schema)] : [],
    ])
  }

  private async commandSettingsOpen(): Promise<void> {
    value(await this.api.settings.openDocument({}))
    this.setNotice('已在宿主文本编辑器中打开 settings 文档')
  }

  private async commandSettingsSet(input: string): Promise<void> {
    const namespace = firstArgument(input)
    const path = firstArgument(namespace.rest)
    if (namespace.value === '' || path.value === '' || path.rest === '') {
      throw new Error('用法：/settings-set <namespace> <json-pointer> <json-value>')
    }
    const described = value(await this.api.settings.describe({}))
    if (!described.writable) throw new Error('当前 settings provider 只读')
    const current = described.namespaces.find(item => item.ns === namespace.value)
    if (current === undefined) throw new Error(`未知 settings namespace：${namespace.value}`)
    const parsed: unknown = JSON.parse(path.rest)
    const updated = value(await this.api.settings.mutate({
      ns: namespace.value,
      ops: [{ op: 'set', path: jsonPointer(path.value), value: parsed }],
      expectedRevision: current.revision,
    }))
    this.setNotice(`已更新 ${updated.ns}（revision ${String(updated.revision)}，${updated.applies === 'restart' ? '重启后生效' : '已实时生效'}）`)
  }

  private async commandSettingsUnset(input: string): Promise<void> {
    const confirmation = confirmed(input)
    const namespace = firstArgument(confirmation.rest)
    const path = firstArgument(namespace.rest)
    if (!confirmation.confirmed || namespace.value === '' || path.value === '') {
      throw new Error('移除设置字段需要：/settings-unset <namespace> <json-pointer> --yes')
    }
    const described = value(await this.api.settings.describe({}))
    const current = described.namespaces.find(item => item.ns === namespace.value)
    if (current === undefined) throw new Error(`未知 settings namespace：${namespace.value}`)
    const updated = value(await this.api.settings.mutate({
      ns: namespace.value,
      ops: [{ op: 'unset', path: jsonPointer(path.value) }],
      expectedRevision: current.revision,
    }))
    this.setNotice(`已移除 ${updated.ns}${path.value}`)
  }

  private async commandSettingsReset(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') {
      throw new Error('重置 namespace 需要：/settings-reset <namespace> --yes（包括已存 secret）')
    }
    const described = value(await this.api.settings.describe({}))
    const current = described.namespaces.find(item => item.ns === confirmation.rest)
    if (current === undefined) throw new Error(`未知 settings namespace：${confirmation.rest}`)
    const updated = value(await this.api.settings.replace({
      ns: confirmation.rest, section: {}, expectedRevision: current.revision,
    }))
    this.setNotice(`已重置 ${updated.ns}（包括该 namespace 的用户层 secret）`)
  }

  private goalRef(): GoalRef {
    const projection = this.state.projections.goal
    if (typeof projection !== 'object' || projection === null || !('goal' in projection)) {
      throw new Error('当前 session 没有可变更的 goal；可用 /goal <objective> 创建')
    }
    const goal = projection.goal
    if (typeof goal !== 'object' || goal === null || !('id' in goal) || !('revision' in goal)
      || typeof goal.id !== 'string' || typeof goal.revision !== 'number') {
      throw new Error('当前 goal projection 无有效 CAS ref')
    }
    return { id: goal.id as GoalRef['id'], revision: goal.revision }
  }

  private commandGoalShow(): void {
    const projection = this.state.projections.goal
    this.showOverlay('Goal', projection === undefined || projection === null
      ? ['当前 session 没有 goal']
      : compactJson(projection).split('\n'))
  }

  private async commandGoalEdit(objective: string): Promise<void> {
    if (objective === '') throw new Error('用法：/goal-edit <objective>')
    const result = value(await this.api.goals.edit({
      sessionId: this.selectedSessionId(), ref: this.goalRef(), objective,
    }))
    this.setNotice(`Goal 已更新到 revision ${String(result.ref.revision)}`)
  }

  private async commandGoalAction(action: 'pause' | 'resume' | 'complete'): Promise<void> {
    const request = { sessionId: this.selectedSessionId(), ref: this.goalRef() }
    const result = action === 'pause'
      ? value(await this.api.goals.pause(request))
      : action === 'resume'
        ? value(await this.api.goals.resume(request))
        : value(await this.api.goals.complete(request))
    this.setNotice(`Goal ${action} 已提交（revision ${String(result.ref.revision)}）`)
  }

  private async commandGoalClear(input: string): Promise<void> {
    if (!confirmed(input).confirmed) throw new Error('清除 goal 需要：/goal-clear --yes')
    value(await this.api.goals.clear({ sessionId: this.selectedSessionId(), ref: this.goalRef() }))
    this.setNotice('Goal 已清除')
  }

  private async commandProviders(): Promise<void> {
    const providers = value(await this.api.llm.providers({})).providers
    if (providers.length === 0) throw new Error('当前没有 configurable provider')
    this.showPicker({
      kind: 'provider',
      title: '选择 Provider',
      current: undefined,
      items: providers.map(provider => ({
        value: provider.provider,
        label: `${provider.displayName} · ${provider.active ? 'active' : 'inactive'}`,
        description: `${provider.settingsNs}/${provider.settingsPath.join('/')}`,
      })),
    })
  }

  private async commandProviderModels(provider = ''): Promise<void> {
    const catalog = value(await this.api.llm.models({}))
    const groups = provider === '' ? catalog.groups : catalog.groups.filter(group => group.id === provider)
    const items = groups.flatMap(group => group.models.map(model => ({
      value: `${group.id}/${model.id}`,
      label: `${model.name} · ${group.name}`,
      ...(model.description === undefined ? {} : { description: model.description }),
    })))
    if (items.length === 0) {
      const failure = catalog.failures.find(item => item.id === provider)
      throw new Error(failure === undefined ? '当前没有已注册模型' : `${failure.name}: ${failure.message}`)
    }
    this.showPicker({
      kind: 'model',
      title: provider === '' ? '选择 Provider Model' : `选择模型 · ${provider}`,
      current: this.state.model,
      items,
    })
  }

  private async commandDiscoverModels(input: string): Promise<void> {
    const namespace = firstArgument(input)
    const provider = firstArgument(namespace.rest)
    const baseURL = firstArgument(provider.rest)
    const api = firstArgument(baseURL.rest)
    const keyEnvironment = firstArgument(api.rest)
    if (namespace.value === '') {
      throw new Error('用法：/discover-models <settings-ns> [provider|-] [base-url|-] [api|-] [api-key-env]')
    }
    const apiKey = keyEnvironment.value === '' ? undefined : process.env[keyEnvironment.value]
    if (keyEnvironment.value !== '' && apiKey === undefined) throw new Error(`环境变量 ${keyEnvironment.value} 未设置`)
    const discovered = value(await this.api.llm.discoverModels({
      settingsNs: namespace.value,
      ...(provider.value === '' || provider.value === '-' ? {} : { provider: provider.value }),
      ...(baseURL.value === '' || baseURL.value === '-' ? {} : { baseURL: baseURL.value }),
      ...(api.value === '' || api.value === '-' ? {} : { api: api.value }),
      ...(apiKey === undefined ? {} : { apiKey }),
    })).models
    this.showOverlay('Discovered Models', discovered.length === 0 ? ['端点未返回模型'] : discovered.map(model => (
      `${model.id}${model.name === undefined ? '' : ` · ${model.name}`}${model.contextWindow === undefined ? '' : ` · context ${String(model.contextWindow)}`}`
    )))
  }

  private async commandCredentials(input: string): Promise<void> {
    const refs = input.split(/\s+/).filter(Boolean)
    if (refs.length === 0) throw new Error('用法：/credentials <REF> [REF...]')
    const result = value(await this.api.credentials.describe({ refs }))
    this.showOverlay('Credentials', refs.map((ref) => {
      const credential = result.credentials[ref]
      return `${ref} · ${credential?.configured === true ? `configured (${credential.source ?? 'unknown'})` : 'missing'} · ${credential?.writable === true ? 'writable' : 'read-only'}`
    }))
  }

  private async commandCredentialSet(input: string): Promise<void> {
    const reference = firstArgument(input)
    const environment = firstArgument(reference.rest)
    if (reference.value === '' || environment.value === '') {
      throw new Error('用法：/credential-set <REF> <VALUE_ENV_VAR>（secret 不进入命令历史）')
    }
    const secret = process.env[environment.value]
    if (secret === undefined || secret === '') throw new Error(`环境变量 ${environment.value} 未设置或为空`)
    value(await this.api.credentials.set({ ref: reference.value, value: secret }))
    this.setNotice(`已从环境变量 ${environment.value} 写入 credential ${reference.value}；值未进入 transcript`)
  }

  private async commandCredentialUnset(input: string): Promise<void> {
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') {
      throw new Error('移除 credential 需要：/credential-unset <REF> --yes')
    }
    value(await this.api.credentials.unset({ ref: confirmation.rest }))
    this.setNotice(`已移除 credential ${confirmation.rest}`)
  }

  private async commandDirectories(path: string): Promise<void> {
    const listing = value(await this.api.host.listDirectory(path === '' ? {} : { path }))
    const items = [
      ...listing.crumbs.filter(crumb => crumb.path !== listing.path).map(crumb => ({
        value: crumb.path,
        label: `↑ ${crumb.name}`,
        description: crumb.path,
      })),
      ...listing.entries.map(entry => ({
        value: entry.path,
        label: `${entry.hidden ? '·' : '▸'} ${entry.name}`,
        description: entry.path,
      })),
    ]
    if (items.length === 0) {
      this.showOverlay(`Directories · ${listing.path}`, ['当前目录没有可浏览的子目录'])
      return
    }
    this.showPicker({
      kind: 'directory',
      title: `浏览目录 · ${listing.path}${listing.truncated ? ' · 结果已截断' : ''}`,
      current: undefined,
      items,
    })
  }

  private async commandMkdir(input: string): Promise<void> {
    const parent = firstArgument(input)
    const name = firstArgument(parent.rest)
    if (parent.value === '' || name.value === '') throw new Error('用法：/mkdir <parent-path> <name>')
    const created = value(await this.api.host.createDirectory({ path: parent.value, name: name.value }))
    this.setNotice(`已创建目录 ${created.path}`)
  }

  private async commandOpen(path: string): Promise<void> {
    if (path === '') throw new Error('用法：/open <path>')
    const absolute = resolve(this.state.cwd ?? process.cwd(), path)
    value(await this.api.host.openPath({ path: absolute }))
    this.setNotice(`已交给宿主打开：${absolute}`)
  }

  private commandCordis(): void {
    const cordis = this.extensions.cordis
    if (cordis === undefined) throw new Error('当前组合未启用 dynamic Cordis runner')
    const rows = cordis.inventory()
    this.showOverlay('Dynamic Cordis', rows.length === 0 ? ['当前没有动态插件定义'] : rows.map((row) => {
      const selected = row.activeRun?.packageId ?? row.nextPackageId ?? row.currentPackageId ?? 'stopped'
      const packages = row.packages.map(pkg => `${pkg.packageId}${pkg.hasClientHalf ? '[browser]' : pkg.hasHostHalf ? '[host]' : '[data]'}`).join(', ')
      return `${row.pluginId} · owner ${row.agentId} · ${selected}${row.latestRun === undefined ? '' : ` · ${row.latestRun.status}`} · ${packages}`
    }))
  }

  private async commandCordisRun(input: string): Promise<void> {
    const cordis = this.extensions.cordis
    if (cordis === undefined) throw new Error('当前组合未启用 dynamic Cordis runner')
    const plugin = firstArgument(input)
    const pkg = firstArgument(plugin.rest)
    if (plugin.value === '') throw new Error('用法：/cordis-run <plugin-id> [package-id]（仅 host-only package）')
    const result = await cordis.runHostOnly(this.selectedSessionId(), plugin.value, pkg.value || undefined)
    this.commandCordis()
    this.setNotice(result)
  }

  private async commandCordisStop(input: string): Promise<void> {
    const cordis = this.extensions.cordis
    if (cordis === undefined) throw new Error('当前组合未启用 dynamic Cordis runner')
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') throw new Error('停止动态插件需要：/cordis-stop <plugin-id> --yes')
    const result = await cordis.stop(this.selectedSessionId(), confirmation.rest)
    this.commandCordis()
    this.setNotice(result)
  }

  private async commandCordisRemove(input: string): Promise<void> {
    const cordis = this.extensions.cordis
    if (cordis === undefined) throw new Error('当前组合未启用 dynamic Cordis runner')
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') {
      throw new Error('删除动态插件及全部 package 需要：/cordis-remove <plugin-id> --yes')
    }
    const result = await cordis.remove(this.selectedSessionId(), confirmation.rest)
    this.commandCordis()
    this.setNotice(result)
  }

  private commandPlugins(): void {
    const plugins = this.extensions.plugins
    if (plugins === undefined) throw new Error('当前组合未启用 Host plugin inventory')
    const entries = plugins.list()
    this.showOverlay('Host Plugins', entries.length === 0 ? ['当前没有已配置插件'] : entries.map(entry => (
      `${entry.enabled ? '●' : '○'} ${entry.entryId} · ${entry.fiberPhase ?? 'inactive'} · ${entry.moduleName}`
    )))
  }

  private feedbackTarget(query: string): MessageId {
    const candidates = this.state.rows.filter(row => row.kind === 'assistant' && row.messageId !== undefined)
    if (query === 'last') {
      const last = candidates.at(-1)?.messageId
      if (last === undefined) throw new Error('当前 transcript 没有可反馈的 assistant message')
      return last
    }
    const matches = candidates.flatMap(row => row.messageId !== undefined
      && (row.messageId === query || row.messageId.startsWith(query)) ? [row.messageId] : [])
    if (matches.length === 0) throw new Error(`找不到 assistant message ${query}`)
    if (matches.length > 1) throw new Error(`assistant message 前缀不唯一：${query}`)
    return matches[0] as MessageId
  }

  private async commandFeedback(input: string): Promise<void> {
    const feedback = this.extensions.feedback
    if (feedback === undefined) throw new Error('当前组合未启用 message feedback')
    const target = firstArgument(input)
    const rating = firstArgument(target.rest)
    if (target.value === '' || (rating.value !== 'positive' && rating.value !== 'negative')) {
      throw new Error('用法：/feedback <message-id|last> <positive|negative> [note]')
    }
    const sessionId = this.selectedSessionId()
    const messageId = this.feedbackTarget(target.value)
    const listed = await feedback.list({ sessionId })
    if (!listed.ok) throw feedbackError(listed)
    const existing = listed.value.items.find(item => item.messageId === messageId)
    const result = await feedback.put({
      sessionId,
      messageId,
      rating: rating.value,
      ...(rating.rest === '' ? {} : { note: rating.rest }),
      ifVersion: existing?.version ?? null,
    })
    if (!result.ok) throw feedbackError(result)
    this.setNotice(`已记录 ${result.value.rating} feedback：${messageId}`)
  }

  private async commandFeedbackClear(input: string): Promise<void> {
    const feedback = this.extensions.feedback
    if (feedback === undefined) throw new Error('当前组合未启用 message feedback')
    const confirmation = confirmed(input)
    if (!confirmation.confirmed || confirmation.rest === '') {
      throw new Error('删除反馈需要：/feedback-clear <message-id|last> --yes')
    }
    const sessionId = this.selectedSessionId()
    const messageId = this.feedbackTarget(confirmation.rest)
    const listed = await feedback.list({ sessionId })
    if (!listed.ok) throw feedbackError(listed)
    const existing = listed.value.items.find(item => item.messageId === messageId)
    if (existing === undefined) {
      this.setNotice(`message ${messageId} 当前没有 feedback`)
      return
    }
    const result = await feedback.delete({ sessionId, messageId, ifVersion: existing.version })
    if (!result.ok) throw feedbackError(result)
    this.setNotice(`已删除 feedback：${messageId}`)
  }

  private async commandImage(input: string, mode: 'queue' | 'steer'): Promise<void> {
    if (this.target?.kind === 'subagent') throw new Error('subagent continuation 当前只接受持久 ContentBlock，不能接收临时图片字节')
    const path = firstArgument(input)
    if (path.value === '') throw new Error('用法：/image <path> [caption] 或 /image-steer <path> [caption]')
    const absolute = resolve(path.value)
    const bytes = await readFile(absolute)
    const content: PromptContentPart[] = [
      ...(path.rest === '' ? [] : [{ type: 'text' as const, text: path.rest }]),
      { type: 'image', mediaType: imageMediaType(absolute), data: bytes.toString('base64'), name: basename(absolute) },
    ]
    const timeZone = currentTimeZone()
    const response = value(await this.api.sessions.prompt({
      sessionId: this.selectedSessionId(), mode, content,
      ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
    }))
    this.setNotice(response.command?.text ?? `已提交图片 ${basename(absolute)}`)
  }

  private async commandSaveImage(input: string): Promise<void> {
    const attachment = firstArgument(input)
    const outputArgument = firstArgument(attachment.rest)
    if (attachment.value === '') throw new Error('用法：/save-image <attachment-id> [output-path]')
    const stored = value(await this.api.sessions.attachment({
      sessionId: this.selectedSessionId(), attachmentId: attachment.value as AttachmentId,
    }))
    const safeId = attachment.value.replaceAll(/[^a-zA-Z0-9._-]/g, '_')
    const output = resolve(outputArgument.value || `dsh-image-${safeId}.${imageExtension(stored.attachment.mediaType)}`)
    const file = await open(output, 'wx')
    try {
      await file.writeFile(Buffer.from(stored.data, 'base64'))
      await file.close()
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(output).catch(() => {})
      throw error
    }
    this.setNotice(`图片已写入 ${output}`)
  }

  private async commandExport(input: string): Promise<void> {
    const downloads = this.extensions.downloads
    if (downloads === undefined) throw new Error('当前组合未启用 session export')
    const first = firstArgument(input)
    const includeDescendants = first.value === '--descendants' || first.rest === '--descendants'
    const output = first.value === '' || first.value === '--descendants'
      ? resolve(`dsh-session-${this.selectedSessionId()}.zip`)
      : resolve(first.value)
    const response = await downloads.sessionLog(
      { sessionId: this.selectedSessionId(), ...(includeDescendants ? { includeDescendants: true } : {}) },
      new AbortController().signal,
    )
    if (!response.ok) throw new Error(`session export: ${String(response.status)} ${await response.text()}`)
    if (response.body === null) throw new Error('session export: Host 返回空响应体')
    const file = await open(output, 'wx')
    try {
      await pipeline(Readable.fromWeb(response.body as never), file.createWriteStream())
    } catch (error) {
      await file.close().catch(() => {})
      await unlink(output).catch(() => {})
      throw error
    }
    this.setNotice(`Session export 已写入 ${output}`)
  }

  private async commandHost(): Promise<void> {
    const host = value(await this.api.host.describe({}))
    this.showOverlay('Host', [
      `版本：${host.version}`,
      `目录：${host.cwd}`,
      `已连接会话：${String(host.attachedSessions)}`,
      `原生打开路径：${host.canOpenPath ? '支持' : '不支持'}`,
    ])
  }

  private commandStatus(): void {
    const status = projectionStatus(this.state.projections)
    const lines = [
      `状态：${this.state.running ? '执行中' : '就绪'}`,
      `会话：${this.state.sessionId ?? '—'}`,
      `标题：${this.state.title ?? '—'}`,
      `Preset：${this.state.agentPreset ?? '—'}`,
      `模型：${this.state.model ?? '—'}${this.state.reasoningEffort === undefined ? '' : ` · ${this.state.reasoningEffort}`}`,
      `目录：${this.state.cwd ?? '—'}`,
      `队列/任务/待办/工作流：${String(this.state.queueSize)}/${String(this.state.jobs.length)}/${String(this.state.todos.length)}/${String(this.state.workflows.length)}`,
    ]
    if (status.permission !== undefined) lines.push(`权限：${status.permission}`)
    if (status.plan !== undefined) {
      const target = status.plan.pending ? !status.plan.active : status.plan.active
      lines.push(`计划模式：${target ? '开启' : '关闭'}${status.plan.pending ? '（切换中）' : ''}`)
    }
    if (status.context !== undefined) {
      lines.push(`上下文：${String(status.context.percent)}% · ${formatCount(status.context.used)}/${formatCount(status.context.window)} tokens`)
    }
    if (status.contextBreakdown !== undefined) {
      lines.push(`上下文构成（估算）：系统 ${formatCount(status.contextBreakdown.system)} · 工具 ${formatCount(status.contextBreakdown.tools)} · 消息 ${formatCount(status.contextBreakdown.messages)}`)
    }
    if (status.tokens !== undefined) {
      lines.push(`累计 Token：输入 ${formatCount(status.tokens.input)} · 输出 ${formatCount(status.tokens.output)}`)
    }
    if (status.session !== undefined) {
      lines.push(`会话统计：${formatCount(status.session.turns)} 轮 · ${formatCount(status.session.steps)} 步`)
    }
    if (status.images !== undefined) {
      lines.push(`图片限制：每条最多 ${formatCount(status.images.maximum)} 张 · 合计 ${formatBytes(status.images.maximumBytes)}`)
    }
    this.showOverlay('运行状态', lines)
  }

  private async runLocalCommand(text: string): Promise<boolean> {
    const [rawCommand = '', ...parts] = text.trim().split(/\s+/)
    const command = rawCommand.toLowerCase()
    const rest = text.trim().slice(rawCommand.length).trim()
    const local = new Set([
      '/help', '/status', '/close', '/sessions', '/new', '/resume', '/rename', '/fork', '/older', '/models', '/model',
      '/queue', '/queue-edit', '/queue-remove', '/queue-steer',
      '/presets', '/preset', '/preset-read', '/preset-copy', '/preset-open', '/preset-remove',
      '/workspaces', '/workspace-new', '/workspace-rename', '/workspace-delete', '/workspace-move',
      '/workspace-session-move', '/archive', '/skills', '/subagents', '/subagent', '/back',
      '/settings', '/settings-show', '/settings-open', '/settings-set', '/settings-unset', '/settings-reset',
      '/goal-show', '/goal-edit', '/goal-pause', '/goal-resume', '/goal-complete', '/goal-clear',
      '/providers', '/provider-models', '/discover-models', '/credentials', '/credential-set', '/credential-unset',
      '/directories', '/mkdir', '/open', '/plugins',
      '/cordis', '/cordis-run', '/cordis-stop', '/cordis-remove',
      '/feedback', '/feedback-clear', '/image', '/image-steer', '/save-image', '/export', '/host',
    ])
    if (!local.has(command)) return false
    try {
      switch (command) {
        case '/help':
          this.showOverlay('TUI 命令', [
            '/sessions [query]  方向键选择或搜索会话',
            '/new [cwd]          新建并切换会话',
            '/resume [id]        方向键选择，或按 id/唯一前缀切换',
            '/rename <title>     重命名当前会话',
            '/fork [seq]         从当前会话分叉并切换',
            '/older              加载更早的 100 条消息',
            '/models             方向键选择模型',
            '/model [p/m] [r]    方向键选择或直接切换模型',
            '/queue · /queue-edit · /queue-remove · /queue-steer',
            '/presets · /preset  方向键选择或直接切换 preset',
            '/preset-read|copy|open|remove',
            '/workspaces · /workspace-new|rename|delete|move',
            '/archive · /subagents · /subagent · /back  方向键选择子代理',
            '/settings · /settings-show  方向键选择 namespace',
            '/settings-open|set|unset|reset',
            '/goal-show|edit|pause|resume|complete|clear',
            '/providers · /provider-models  方向键选择 provider/model',
            '/discover-models',
            '/credentials · /credential-set|unset',
            '/feedback · /feedback-clear',
            '/directories · /mkdir · /open · /plugins',
            '/cordis · /cordis-run|stop|remove',
            '/image · /image-steer · /save-image · /export',
            '/skills · /host · /status',
            'Ctrl+Shift+E  展开最近的折叠行（上下文/skill 目录、工具详情等）；再按展开更早的，全开后按一下重新全部折叠',
            'Ctrl+T        展开/折叠 todo 清单（非折叠时显示进度和当前正在执行的项）',
            '/goal <objective> · /plan · /permission · /compact  交给 Harness',
            '/close              关闭当前面板',
            '其他 /command       交给 Harness 命令或 skill',
          ])
          break
        case '/status': this.commandStatus(); break
        case '/close': this.closeOverlay(); break
        case '/sessions': await this.commandSessions(rest); break
        case '/new': await this.commandNew(rest); break
        case '/resume': await this.commandResume(rest); break
        case '/rename': {
          if (rest === '') throw new Error('用法：/rename <title>')
          const result = value(await this.api.sessions.rename({ sessionId: this.selectedSessionId(), title: rest }))
          this.update(state => ({
            ...state,
            title: result.title,
            projections: { ...state.projections, title: result.title },
          }))
          this.setNotice(`会话已重命名为 ${result.title}`)
          break
        }
        case '/fork': {
          const atSeq = rest === '' ? undefined : Number(rest)
          if (atSeq !== undefined && !Number.isSafeInteger(atSeq)) throw new Error('用法：/fork [event-seq]')
          const forked = value(await this.api.sessions.fork({
            sessionId: this.selectedSessionId(), ...(atSeq === undefined ? {} : { atSeq }),
          }))
          await this.commandResume(forked.sessionId)
          break
        }
        case '/older': await this.commandOlder(); break
        case '/models': await this.commandModels(); break
        case '/model': await this.commandModel(parts[0] ?? '', parts[1]); break
        case '/queue': this.commandQueue(); break
        case '/queue-edit': await this.commandQueueEdit(rest); break
        case '/queue-remove': await this.commandQueueRemove(rest); break
        case '/queue-steer': await this.commandQueueSteer(rest); break
        case '/presets': await this.commandPresets(); break
        case '/preset': await this.commandPreset(rest); break
        case '/preset-read': await this.commandPresetRead(rest); break
        case '/preset-copy': await this.commandPresetCopy(rest); break
        case '/preset-open': await this.commandPresetOpen(rest); break
        case '/preset-remove': await this.commandPresetRemove(rest); break
        case '/workspaces': await this.commandWorkspaces(); break
        case '/workspace-new': await this.commandWorkspaceNew(rest); break
        case '/workspace-rename': await this.commandWorkspaceRename(rest); break
        case '/workspace-delete': await this.commandWorkspaceDelete(rest); break
        case '/workspace-move': await this.commandWorkspaceMove(rest); break
        case '/workspace-session-move': await this.commandWorkspaceSessionMove(rest); break
        case '/archive': await this.commandArchive(rest); break
        case '/skills': await this.commandSkills(); break
        case '/subagents': await this.commandSubagents(); break
        case '/subagent': await this.commandSubagent(rest); break
        case '/back': await this.commandBack(); break
        case '/settings': await this.commandSettings(); break
        case '/settings-show': await this.commandSettingsShow(rest); break
        case '/settings-open': await this.commandSettingsOpen(); break
        case '/settings-set': await this.commandSettingsSet(rest); break
        case '/settings-unset': await this.commandSettingsUnset(rest); break
        case '/settings-reset': await this.commandSettingsReset(rest); break
        case '/goal-show': this.commandGoalShow(); break
        case '/goal-edit': await this.commandGoalEdit(rest); break
        case '/goal-pause': await this.commandGoalAction('pause'); break
        case '/goal-resume': await this.commandGoalAction('resume'); break
        case '/goal-complete': await this.commandGoalAction('complete'); break
        case '/goal-clear': await this.commandGoalClear(rest); break
        case '/providers': await this.commandProviders(); break
        case '/provider-models': await this.commandProviderModels(rest); break
        case '/discover-models': await this.commandDiscoverModels(rest); break
        case '/credentials': await this.commandCredentials(rest); break
        case '/credential-set': await this.commandCredentialSet(rest); break
        case '/credential-unset': await this.commandCredentialUnset(rest); break
        case '/directories': await this.commandDirectories(rest); break
        case '/mkdir': await this.commandMkdir(rest); break
        case '/open': await this.commandOpen(rest); break
        case '/plugins': this.commandPlugins(); break
        case '/cordis': this.commandCordis(); break
        case '/cordis-run': await this.commandCordisRun(rest); break
        case '/cordis-stop': await this.commandCordisStop(rest); break
        case '/cordis-remove': await this.commandCordisRemove(rest); break
        case '/feedback': await this.commandFeedback(rest); break
        case '/feedback-clear': await this.commandFeedbackClear(rest); break
        case '/image': await this.commandImage(rest, 'queue'); break
        case '/image-steer': await this.commandImage(rest, 'steer'); break
        case '/save-image': await this.commandSaveImage(rest); break
        case '/export': await this.commandExport(rest); break
        case '/host': await this.commandHost(); break
      }
    } catch (error) {
      this.setNotice(`命令失败：${message(error)}`)
    }
    return true
  }

  /**
   * Dispatch a terminal-native management command or an ordinary Harness prompt.
   * @param text - Complete composer text.
   * @param mode - Queue normally or steer the active turn.
   * @returns Whether the input was accepted and may leave the composer.
   */
  async submit(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<boolean> {
    const normalized = text.trim()
    if (normalized === '') return false
    if (normalized.startsWith('/') && await this.runLocalCommand(normalized)) return true
    return this.send(normalized, mode)
  }

  /**
   * Submit one text message; ordinary Enter uses the same queue semantics as Web.
   * @param text - User-authored message text.
   * @param mode - Queue normally or steer the active turn.
   * @returns Whether the selected session accepted the message.
   */
  async send(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<boolean> {
    const normalized = text.trim()
    const sessionId = this.state.sessionId
    if (normalized === '' || sessionId === undefined || this.state.phase !== 'ready') return false
    try {
      const timeZone = currentTimeZone()
      if (this.target?.kind === 'subagent') {
        if (this.target.address.mode !== 'continuable') throw new Error('one-shot subagent transcript 只读')
        if (mode === 'steer') throw new Error('continuable subagent 不支持 strict steer；消息会进入其 FIFO inbox')
        value(await this.api.subagents.prompt({
          ...this.target.address,
          content: [{ type: 'text', text: normalized }],
          ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
        }))
        this.setNotice('已向 continuable subagent 提交消息')
        return true
      }
      const response = await this.api.sessions.prompt({
        sessionId,
        mode,
        content: [{ type: 'text', text: normalized }],
        ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
      })
      const sendError = failure(response)
      if (sendError !== undefined) throw sendError
      if (!response.result.ok) throw new Error('unreachable')
      this.setNotice(response.result.value.command?.text)
      return true
    } catch (error) {
      this.setNotice(`发送失败：${message(error)}`)
      return false
    }
  }

  /** Cancel the current active turn. */
  async cancel(): Promise<void> {
    const sessionId = this.state.sessionId
    if (sessionId === undefined || !this.state.running) return
    try {
      if (this.target?.kind === 'subagent') {
        if (this.target.address.mode !== 'continuable') return
        value(await this.api.subagents.interrupt(this.target.address))
        this.setNotice('已请求中断 continuable subagent')
        return
      }
      const response = await this.api.sessions.cancel({ sessionId })
      const cancelError = failure(response)
      if (cancelError !== undefined) throw cancelError
      this.setNotice('已请求取消当前轮次')
    } catch (error) {
      this.setNotice(`取消失败：${message(error)}`)
    }
  }

  /**
   * Answer the currently displayed approval with a fail-closed outcome.
   * @param outcome - One-shot approval or rejection chosen by the user.
   */
  async answerApproval(outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>): Promise<void> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'approval') return
    await this.respondApproval(interaction, outcome)
  }

  private async respondApproval(
    interaction: PendingApproval,
    outcome: Extract<ApprovalOutcome, 'allowed-once' | 'rejected'>,
  ): Promise<void> {
    try {
      const receipt = await this.api.respond({
        type: 'client-response',
        rpcId: interaction.rpcId,
        result: {
          ok: true,
          value: {
            sessionId: interaction.sessionId,
            approvalId: interaction.approvalId,
            outcome,
          },
        },
      })
      if (!receipt.accepted) throw new Error(`响应被拒绝：${receipt.reason}`)
      this.setNotice(outcome === 'allowed-once' ? '已允许本次操作' : '已拒绝本次操作')
    } catch (error) {
      this.setNotice(`审批响应失败：${message(error)}`)
    }
  }

  /**
   * Answer the currently displayed structured question batch.
   * @param answer - Complete answer batch for the pending request.
   * @returns Whether the answer was accepted; `false` leaves the question open
   * so the user can retry instead of being stuck on a pending submission.
   */
  async answerQuestion(answer: AskUserQuestionAnswer): Promise<boolean> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question') return false
    return await this.respondQuestion(interaction, answer)
  }

  /** Cancel the currently displayed question batch, matching the Web close action. */
  async cancelQuestion(): Promise<void> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question') return
    try {
      const receipt = await this.api.respond({
        type: 'client-response',
        rpcId: interaction.rpcId,
        result: {
          ok: false,
          error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
        },
      })
      if (!receipt.accepted) throw new Error(`响应被拒绝：${receipt.reason}`)
      this.setNotice('已取消问题请求')
    } catch (error) {
      this.setNotice(`取消问题失败：${message(error)}`)
    }
  }

  private async respondQuestion(interaction: PendingQuestion, answer: AskUserQuestionAnswer): Promise<boolean> {
    try {
      const receipt = await this.api.respond({
        type: 'client-response',
        rpcId: interaction.rpcId,
        result: { ok: true, value: { sessionId: interaction.sessionId, answer } },
      })
      if (!receipt.accepted) throw new Error(`响应被拒绝：${receipt.reason}`)
      this.setNotice('已提交回答')
      return true
    } catch (error) {
      this.setNotice(`回答失败：${message(error)}`)
      return false
    }
  }

  /**
   * Publish or clear the transient status line.
   * @param notice - Visible status text, or `undefined` to clear it.
   */
  setNotice(notice: string | undefined): void {
    this.update(state => ({ ...state, notice }))
  }

  /**
   * Toggle the newest folded verbose row open (or fold them all back), mirroring
   * the Web disclosure rows. Repeated presses peel progressively older rows;
   * once every foldable row is unfolded, the next press folds them all back into
   * their one-line headers. Running rows stay unfolded.
   */
  toggleFold(): void {
    this.update(state => toggleFold(state))
  }

  /** Abort both streams and stop publishing to the unmounted terminal. */
  dispose(): void {
    this.muxAbort.abort()
    this.hostAbort.abort()
    this.listeners.clear()
  }
}
