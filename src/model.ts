/** Pure projection from ApiProxy history and live frames into terminal rows. */

import type {
  HistoryEntry, HostFrame, JobView, MuxFrame, QueuedInboxItem, RpcId, SessionSummary, ToolEventView,
} from '@deepseek-ai/dsh-host-apiproxy'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { SessionEvent, SessionId, TodoItem } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type {} from '@deepseek-ai/dsh-llm-retry/types'
import type {} from '@deepseek-ai/dsh-tool-workflow/types'
import type { ProviderSetupDraft } from './provider-setup.ts'

/** Terminal status shared by tool and workflow rows. */
export type TranscriptStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** One stable, terminal-oriented conversation row. */
export interface TranscriptRow {
  id: string
  seq: number
  kind:
    | 'user'
    | 'assistant'
    | 'reasoning'
    | 'tool'
    | 'deliverable'
    | 'workflow'
    | 'context'
    | 'command'
    | 'compaction'
    | 'retry'
    | 'notice'
    | 'error'
  text: string
  detail?: string | undefined
  status?: TranscriptStatus | undefined
  callId?: string | undefined
  messageId?: MessageId | undefined
}

/** One child member folded from a durable workflow run. */
export interface WorkflowMember {
  seq: number
  label: string
  phase?: string | undefined
  childId: SessionId
  status: TranscriptStatus
}

/** Terminal projection of one durable workflow run. */
export interface WorkflowRun {
  runId: string
  name: string
  status: TranscriptStatus
  members: WorkflowMember[]
}

/** A pending tool approval delivered through the mux stream. */
export interface PendingApproval {
  kind: 'approval'
  rpcId: RpcId
  sessionId: SessionId
  approvalId: ApprovalRequestId
  toolName: string
  reason?: string
}

/** A pending structured question batch delivered through the mux stream. */
export interface PendingQuestion {
  kind: 'question'
  rpcId: RpcId
  sessionId: SessionId
  questions: AskUserQuestionItem[]
}

/** Answerable interaction currently owned by the terminal. */
export type PendingInteraction = PendingApproval | PendingQuestion

/** Terminal-native modal content produced by management commands. */
export interface TuiOverlay {
  title: string
  lines: string[]
}

/** One value in a keyboard-driven terminal picker. */
export interface TuiPickerItem {
  value: string
  label: string
  description?: string | undefined
}

/** Modal picker owned by a terminal-native command. */
export interface TuiPicker {
  kind: 'directory' | 'model' | 'permission' | 'preset' | 'provider' | 'provider-setup' | 'session' | 'settings' | 'subagent'
  title: string
  current: string | undefined
  items: TuiPickerItem[]
}

export type ProviderWizardStep = 'credential' | 'providerId' | 'baseURL' | 'api' | 'apiKey' | 'models' | 'review'

/** Provider configuration draft plus the TUI's progressive prompt position. */
export type TuiProviderWizard = ProviderSetupDraft & {
  step: ProviderWizardStep
  /** Field currently using the focused single-value prompt. */
  editing?: import('./provider-setup.ts').ProviderSetupField | undefined
}

/** Complete render state observed by the terminal application. */
export interface TuiViewState {
  phase: 'loading' | 'ready' | 'error'
  sessionId: SessionId | undefined
  title: string | undefined
  agentPreset: string | undefined
  cwd: string | undefined
  model: string | undefined
  reasoningEffort: string | undefined
  modelContextWindow: number | undefined
  running: boolean
  rows: TranscriptRow[]
  /** Ids of rows whose full detail is currently unfolded; running rows are always unfolded. */
  expanded: string[]
  partialText: string
  partialReasoning: string
  partialTool: { name: string; arguments: string } | undefined
  queueSize: number
  queueItems: QueuedInboxItem[]
  jobs: JobView[]
  todos: TodoItem[]
  workflows: WorkflowRun[]
  projections: Record<string, unknown>
  sessions: SessionSummary[]
  interaction: PendingInteraction | undefined
  overlay: TuiOverlay | undefined
  picker: TuiPicker | undefined
  providerWizard: TuiProviderWizard | undefined
  notice: string | undefined
  lastSeq: number
  mutationCalls: Record<string, { turn: number; paths: string[] }>
  producedFiles: Record<string, string[]>
  retryTurns: Record<string, number>
}

/** One switchable permission preset shown by the `/permission` picker. */
export interface TuiPermissionOption {
  value: string
  name: string
  description?: string | undefined
}

/** Readable subset of the Web composer projections shown by the TUI. */
export interface TuiProjectionStatus {
  permission?: string
  /** Switchable permission presets from the `permissions` projection. */
  permissionOptions?: TuiPermissionOption[]
  plan?: { active: boolean; pending: boolean }
  context?: { used: number; window: number; percent: number }
  contextWindow?: number
  contextBreakdown?: { system: number; tools: number; messages: number }
  tokens?: { input: number; output: number }
  session?: { turns: number; steps: number }
  images?: { maximum: number; maximumBytes: number }
}

/**
 * Create the loading state for one TUI process.
 * @returns A fresh state with no selected session or transient presentation.
 */
export function createInitialState(): TuiViewState {
  return {
    phase: 'loading',
    sessionId: undefined,
    title: undefined,
    agentPreset: undefined,
    cwd: undefined,
    model: undefined,
    reasoningEffort: undefined,
    modelContextWindow: undefined,
    running: false,
    rows: [],
    expanded: [],
    partialText: '',
    partialReasoning: '',
    partialTool: undefined,
    queueSize: 0,
    queueItems: [],
    jobs: [],
    todos: [],
    workflows: [],
    projections: {},
    sessions: [],
    interaction: undefined,
    overlay: undefined,
    picker: undefined,
    providerWizard: undefined,
    notice: undefined,
    lastSeq: -1,
    mutationCalls: {},
    producedFiles: {},
    retryTurns: {},
  }
}

/**
 * Extract readable text from provider-neutral content blocks.
 * @param content - Content blocks to flatten.
 * @param includeReasoning - Whether reasoning blocks participate in the result.
 * @returns Newline-separated readable text.
 */
export function contentText(content: readonly ContentBlock[], includeReasoning = false): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' || (includeReasoning && block.type === 'reasoning')) parts.push(block.text)
    else if (block.type === 'image') {
      parts.push(`[图片 ${block.attachment.attachmentId} · ${block.attachment.width}×${block.attachment.height}]`)
    }
    else if (block.type === 'tool-result') parts.push(contentText(block.content, includeReasoning))
  }
  return parts.filter(Boolean).join('\n')
}

/** Extract assistant reasoning separately from visible answer text. */
function reasoningText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n')
}

function json(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, undefined, 2)
  } catch {
    return String(value)
  }
}

function callTitle(event: SessionEvent<'tool/call'>, view: ToolEventView | undefined): string {
  if (view?.for !== 'call') return event.data.name
  return view.view.title
}

function callDetail(event: SessionEvent<'tool/call'>, view: ToolEventView | undefined): string | undefined {
  if (view?.for !== 'call') return event.data.arguments
  const intent = view.view
  switch (intent.card) {
    case 'terminal': return [intent.description, intent.cwd].filter(Boolean).join(' · ') || undefined
    case 'diff': return intent.diffs.map(diff => diff.path).join(', ')
    case 'generic': {
      const content = intent.content === undefined ? '' : contentText(intent.content, true)
      return [intent.rawInput === undefined ? '' : json(intent.rawInput), content].filter(Boolean).join('\n') || undefined
    }
  }
}

function resultPresentation(
  event: SessionEvent<'tool/result'>,
  view: ToolEventView | undefined,
): { title?: string | undefined; detail?: string | undefined } {
  const fallback = contentText(event.data.message.content, true)
  if (view?.for !== 'result') return { detail: fallback || undefined }
  const intent = view.view
  switch (intent.card) {
    case 'terminal': {
      const result = intent.exitCode === undefined
        ? intent.signal === undefined ? '' : `signal ${intent.signal}`
        : `exit ${String(intent.exitCode)}`
      return { title: intent.title, detail: [intent.output, result].filter(Boolean).join('\n') || undefined }
    }
    case 'diff': return {
      title: intent.title,
      detail: intent.diffs.map(diff => diff.path).join(', '),
    }
    case 'search': return {
      title: intent.title,
      detail: intent.shape === 'paths'
        ? intent.paths.join('\n')
        : intent.files.map(file => `${file.path}: ${String(file.matches.length)}`).join('\n'),
    }
    case 'read': return {
      title: intent.title,
      detail: intent.lines.map(line => `${String(line.number).padStart(4)} │ ${line.text}`).join('\n'),
    }
    case 'web': return {
      title: intent.title,
      detail: intent.kind === 'search'
        ? [intent.answer, ...intent.sources.map(source => source.title ?? source.url)].filter(Boolean).join('\n')
        : `${String(intent.statusCode)} ${intent.url}${intent.truncated ? ' · 已截断' : ''}`,
    }
    case 'generic': return {
      title: intent.title,
      detail: intent.content === undefined ? fallback || undefined : contentText(intent.content, true) || undefined,
    }
  }
}

function appendRow(state: TuiViewState, row: TranscriptRow): TuiViewState {
  return { ...state, rows: [...state.rows, row] }
}

function upsertRow(state: TuiViewState, row: TranscriptRow): TuiViewState {
  const index = state.rows.findIndex(item => item.id === row.id)
  return index < 0
    ? appendRow(state, row)
    : { ...state, rows: state.rows.toSpliced(index, 1, row) }
}

/**
 * Kinds whose rows carry a `detail` and fold into a one-line header. Message
 * rows and anonymous notices stay open; deliverable rows keep their path list
 * and `/open` hint visible so produced files are always discoverable.
 */
const COLLAPSIBLE_KINDS = new Set<TranscriptRow['kind']>([
  'context', 'tool', 'workflow', 'command', 'compaction', 'retry',
])

/** Whether a row participates in the fold/unfold interaction. */
export function isCollapsibleRow(row: TranscriptRow): boolean {
  return COLLAPSIBLE_KINDS.has(row.kind)
}

/**
 * Whether a row's detail is currently visible. A running row is always unfolded
 * so live tool/workflow output stays readable; every other foldable row shows
 * its one-line header until the user explicitly expands it.
 * @param row - The row to decide for.
 * @param expanded - Ids explicitly unfolded by the user.
 */
export function isExpandedRow(row: TranscriptRow, expanded: readonly string[]): boolean {
  if (row.status === 'running') return true
  return expanded.includes(row.id)
}

/**
 * Unfold the most recent row that is currently folded, or fold them all back.
 *
 * Mirrors the Web disclosure rows: verbose rows (skill catalog, injected
 * context, tool output, compaction, retries…) render collapsed into a one-line
 * header so they do not crowd the transcript, and are unfolded one at a time on
 * demand. Each call peels the newest still-folded row, so pressing the key
 * repeatedly reveals progressively older entries; once every foldable row is
 * unfolded, the next press folds them all back. Running rows stay unfolded.
 * @param state - Current terminal projection.
 * @returns A projection with one more row unfolded (or all folded back), else `state`.
 */
export function toggleFold(state: TuiViewState): TuiViewState {
  for (let index = state.rows.length - 1; index >= 0; index -= 1) {
    const row = state.rows[index]
    if (row === undefined || !isCollapsibleRow(row)) continue
    if (row.status === 'running' || state.expanded.includes(row.id)) continue
    return { ...state, expanded: [...state.expanded, row.id] }
  }
  return state.expanded.length === 0 ? state : { ...state, expanded: [] }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined
}

function finiteNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Normalize optional projection payloads without coupling the renderer to their Host packages.
 * @param projections - Detached projection values from history or live frames.
 * @returns The readable status fields recognized by the TUI.
 */
export function projectionStatus(projections: Record<string, unknown>): TuiProjectionStatus {
  const result: TuiProjectionStatus = {}
  const permissions = object(projections.permissions)
  if (typeof permissions?.currentValue === 'string') result.permission = permissions.currentValue
  if (Array.isArray(permissions?.options)) {
    const options = permissions.options.flatMap((item: unknown) => {
      const option = object(item)
      if (option === undefined || typeof option.value !== 'string' || typeof option.name !== 'string') return []
      return [{
        value: option.value,
        name: option.name,
        ...(typeof option.description === 'string' ? { description: option.description } : {}),
      } satisfies TuiPermissionOption]
    })
    if (options.length > 0) result.permissionOptions = options
  }

  const plan = object(projections.plan)
  if (typeof plan?.active === 'boolean' && typeof plan.pending === 'boolean') {
    result.plan = { active: plan.active, pending: plan.pending }
  }

  const pressure = object(projections.contextPressure)
  const used = finiteNumber(pressure, 'projectedTokens') ?? finiteNumber(pressure, 'pressureTokens')
  const window = finiteNumber(pressure, 'contextWindow')
  if (used !== undefined && window !== undefined && window > 0) {
    result.context = { used, window, percent: Math.max(0, Math.min(100, Math.round(used / window * 100))) }
  }
  if (window !== undefined && window > 0) result.contextWindow = window

  const breakdown = object(projections.contextBreakdown)
  const system = finiteNumber(breakdown, 'systemTokens')
  const tools = finiteNumber(breakdown, 'toolsTokens')
  const messages = finiteNumber(breakdown, 'messageTokens')
  if (system !== undefined && tools !== undefined && messages !== undefined) {
    result.contextBreakdown = { system, tools, messages }
  }

  const tokenUsage = object(projections.tokenUsage)
  const uncached = finiteNumber(tokenUsage, 'uncachedInputTokens')
  const cacheRead = finiteNumber(tokenUsage, 'cacheReadTokens')
  const cacheWrite = finiteNumber(tokenUsage, 'cacheWriteTokens')
  const output = finiteNumber(tokenUsage, 'outputTokens')
  if (uncached !== undefined && cacheRead !== undefined && cacheWrite !== undefined && output !== undefined) {
    result.tokens = { input: uncached + cacheRead + cacheWrite, output }
  }

  const stats = object(projections.sessionStats)
  const turns = finiteNumber(stats, 'turns')
  const steps = finiteNumber(stats, 'steps')
  if (turns !== undefined && steps !== undefined) result.session = { turns, steps }

  const imageLimits = object(projections.imageLimits)
  const maximum = finiteNumber(imageLimits, 'maxImagesPerMessage')
  const maximumBytes = finiteNumber(imageLimits, 'maxMessageImageBytes')
  if (maximum !== undefined && maximumBytes !== undefined) result.images = { maximum, maximumBytes }
  return result
}

/**
 * Read the durable session title from a projection snapshot.
 * @param projections - Detached projection values for one session.
 * @returns The projected title when present.
 */
export function projectedTitle(projections: Record<string, unknown>): string | undefined {
  const title = projections.title
  return typeof title === 'string' && title !== '' ? title : undefined
}

function mutationPaths(view: ToolEventView | undefined): string[] {
  if (view?.for !== 'call') return []
  const intent = view.view
  if (intent.card !== 'diff' && (intent.card !== 'generic' || intent.kind !== 'edit')) return []
  return [...new Set((intent.locations ?? []).map(location => location.path))]
}

function successfulToolResult(event: SessionEvent<'tool/result'>): boolean {
  const result = event.data.message.content[0]
  return result.isError !== true && event.data.error === undefined
}

function replacementEvent(
  event: SessionEvent<'user/message' | 'assistant/message' | 'tool/result'>,
): boolean {
  return event.surfaceOp !== undefined && event.surfaceOp !== 'append'
}

function contextPresentation(event: SessionEvent<'user/message'>): { text: string; detail?: string } {
  const source = event.data.source as unknown as Record<string, unknown>
  const content = contentText(event.data.content, true)
  if (source.form === 'notice' && typeof source.summary === 'string') {
    return { text: source.summary, ...(content === '' ? {} : { detail: content }) }
  }
  switch (source.kind) {
    case 'plugin': {
      const plugin = typeof source.plugin === 'string' ? source.plugin : '未知'
      return { text: `插件 · ${plugin}`, ...(content === '' ? {} : { detail: content }) }
    }
    case 'agent-instructions': {
      const changes = Array.isArray(source.changes) ? source.changes : []
      const paths = changes.flatMap((change) => {
        const record = object(change)
        return typeof record?.path === 'string' ? [record.path] : []
      })
      const detail = [paths.join('\n'), content].filter(Boolean).join('\n')
      return { text: '工作区指令', ...(detail === '' ? {} : { detail }) }
    }
    case 'skill-invocation': {
      const name = typeof source.name === 'string' ? source.name : '未知'
      return { text: `Skill · /${name}`, ...(content === '' ? {} : { detail: content }) }
    }
    case 'skill-catalog': return { text: 'Skill 目录', ...(content === '' ? {} : { detail: content }) }
    case 'session-reference': {
      const references = Array.isArray(source.references) ? source.references : []
      const labels = references.flatMap((reference) => {
        const record = object(reference)
        return typeof record?.label === 'string' ? [record.label] : []
      })
      return { text: `会话引用${labels.length === 0 ? '' : ` · ${labels.join(', ')}`}`, ...(content === '' ? {} : { detail: content }) }
    }
    case 'goal': return { text: '目标续行', ...(content === '' ? {} : { detail: content }) }
    default: {
      const kind = typeof source.kind === 'string' ? source.kind : '未知来源'
      return { text: `上下文 · ${kind}`, ...(content === '' ? {} : { detail: content }) }
    }
  }
}

function commandText(event: SessionEvent<'command/run'>): string {
  return `/${event.data.name}${event.data.args ?? ''}`
}

function compactionDetail(event: SessionEvent<'compaction/summary'>): string {
  const facts = `${String(event.data.shadowedSeqs.length)} 条记录 · 约 ${String(event.data.shadowedTokenCount)} tokens · ${event.data.provider}/${event.data.model}`
  const summary = contentText(event.data.summary, true)
  return summary === '' ? facts : `${facts}\n${summary}`
}

function retryDetail(event: SessionEvent<'llm/retry'>): string {
  const limit = event.data.mode === 'normal' ? `/${String(event.data.maxRetries)}` : ''
  return `${event.data.failure.code}: ${event.data.failure.message}\n等待 ${String(event.data.delayMs)} ms · 第 ${String(event.data.retry)}${limit} 次`
}

function settleRetries(
  state: TuiViewState,
  turn: number,
  status: Extract<TranscriptStatus, 'completed' | 'failed' | 'interrupted'>,
  seq: number,
): TuiViewState {
  return {
    ...state,
    rows: state.rows.map((row) => {
      if (row.kind !== 'retry' || row.status !== 'running') return row
      const retryId = row.id.slice('retry-'.length)
      return state.retryTurns[retryId] === turn ? { ...row, seq, status } : row
    }),
  }
}

function interruptRunningTools(state: TuiViewState, seq: number): TuiViewState {
  return {
    ...state,
    rows: state.rows.map(row => row.kind === 'tool' && row.status === 'running'
      ? { ...row, seq, status: 'interrupted' }
      : row),
  }
}

function appendDeliverables(state: TuiViewState, turn: number, seq: number): TuiViewState {
  const paths = state.producedFiles[String(turn)] ?? []
  if (paths.length === 0) return state
  const id = `deliverables-${String(turn)}`
  return appendRow({ ...state, rows: state.rows.filter(row => row.id !== id) }, {
    id,
    seq,
    kind: 'deliverable',
    text: `${String(paths.length)} 个文件`,
    detail: paths.join('\n'),
    status: 'completed',
  })
}

function statusLabel(status: TranscriptStatus): string {
  switch (status) {
    case 'running': return '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
  }
}

function workflowDetail(workflow: WorkflowRun): string {
  if (workflow.members.length === 0) return statusLabel(workflow.status)
  return workflow.members.map((member) => {
    const phase = member.phase === undefined ? '' : `[${member.phase || '空阶段'}] `
    const childId = String(member.childId)
    const child = childId.length <= 10 ? childId : `…${childId.slice(-9)}`
    return `${statusLabel(member.status)} · ${phase}${member.label} · ${child}`
  }).join('\n')
}

function projectWorkflowRow(state: TuiViewState, workflow: WorkflowRun, seq: number): TuiViewState {
  const id = `workflow-${workflow.runId}`
  const row: TranscriptRow = {
    id,
    seq,
    kind: 'workflow',
    text: workflow.name,
    detail: workflowDetail(workflow),
    status: workflow.status,
  }
  const index = state.rows.findIndex(item => item.id === id)
  return index < 0
    ? appendRow(state, row)
    : { ...state, rows: state.rows.toSpliced(index, 1, row) }
}

function updateWorkflow(
  state: TuiViewState,
  runId: string,
  seq: number,
  update: (workflow: WorkflowRun) => WorkflowRun,
): TuiViewState {
  const index = state.workflows.findIndex(workflow => workflow.runId === runId)
  if (index < 0) return state
  const workflow = update(state.workflows[index] as WorkflowRun)
  return projectWorkflowRow({
    ...state,
    workflows: state.workflows.toSpliced(index, 1, workflow),
  }, workflow, seq)
}

function interruptRunningWorkflows(state: TuiViewState, seq: number): TuiViewState {
  let next = state
  for (const workflow of state.workflows) {
    if (workflow.status !== 'running') continue
    next = updateWorkflow(next, workflow.runId, seq, current => ({
      ...current,
      status: 'interrupted',
      members: current.members.map(member => member.status === 'running'
        ? { ...member, status: 'interrupted' }
        : member),
    }))
  }
  return next
}

function applyChunk(state: TuiViewState, event: SessionEvent<'assistant/chunk'>): TuiViewState {
  const chunk = event.data.chunk
  switch (chunk.type) {
    case 'text-delta': return { ...state, partialText: state.partialText + chunk.text }
    case 'reasoning-delta': return { ...state, partialReasoning: state.partialReasoning + chunk.text }
    case 'tool-call-delta': return {
      ...state,
      partialTool: {
        name: chunk.name ?? state.partialTool?.name ?? '',
        arguments: (state.partialTool?.arguments ?? '') + chunk.argumentsDelta,
      },
    }
    case 'block-end': {
      if (chunk.block.type !== 'tool-call') return state
      return { ...state, partialTool: { name: chunk.block.name, arguments: chunk.block.arguments } }
    }
    default: return state
  }
}

/**
 * Fold one durable event and its optional host presentation into terminal state.
 * @param state - Current terminal projection.
 * @param event - Durable event to fold.
 * @param view - Optional Host presentation intent paired with the event.
 * @returns Updated terminal projection.
 */
export function applySessionEvent(
  state: TuiViewState,
  event: SessionEvent,
  view?: ToolEventView,
): TuiViewState {
  if (event.seq <= state.lastSeq) return state
  let next: TuiViewState = { ...state, lastSeq: event.seq }
  switch (event.type) {
    case 'user/message': {
      if (replacementEvent(event)) return next
      const text = contentText(event.data.content)
      if (event.data.source.kind === 'user') {
        return text === ''
          ? next
          : appendRow(next, { id: `event-${String(event.seq)}`, seq: event.seq, kind: 'user', text })
      }
      const presentation = contextPresentation(event)
      return appendRow(next, {
        id: `context-${String(event.seq)}`, seq: event.seq, kind: 'context', ...presentation,
      })
    }
    case 'assistant/chunk': return applyChunk(next, event)
    case 'assistant/message': {
      if (replacementEvent(event)) {
        return { ...next, partialText: '', partialReasoning: '', partialTool: undefined }
      }
      const reasoning = reasoningText(event.data.message.content)
      const text = contentText(event.data.message.content)
      next = settleRetries({
        ...next, partialText: '', partialReasoning: '', partialTool: undefined,
      }, event.data.turn, 'completed', event.seq)
      if (reasoning !== '') {
        next = appendRow(next, { id: `reasoning-${String(event.seq)}`, seq: event.seq, kind: 'reasoning', text: reasoning })
      }
      if (text !== '') {
        next = appendRow(next, {
          id: `event-${String(event.seq)}`,
          seq: event.seq,
          kind: 'assistant',
          text,
          messageId: event.data.message.id,
        })
      }
      return appendDeliverables(next, event.data.turn, event.seq)
    }
    case 'tool/call': {
      const callId = String(event.data.callId)
      next = {
        ...next,
        mutationCalls: {
          ...next.mutationCalls,
          [callId]: { turn: event.data.turn, paths: mutationPaths(view) },
        },
      }
      return appendRow(next, {
        id: `tool-${callId}`,
        seq: event.seq,
        kind: 'tool',
        text: callTitle(event, view),
        detail: callDetail(event, view),
        status: 'running',
        callId,
      })
    }
    case 'tool/result': {
      if (replacementEvent(event)) return next
      const callId = String(event.data.message.source.callId)
      const mutation = next.mutationCalls[callId]
      if (mutation !== undefined && successfulToolResult(event) && mutation.paths.length > 0) {
        const key = String(mutation.turn)
        next = {
          ...next,
          producedFiles: {
            ...next.producedFiles,
            [key]: [...new Set([...(next.producedFiles[key] ?? []), ...mutation.paths])],
          },
        }
      }
      const presentation = resultPresentation(event, view)
      const index = next.rows.findIndex(row => row.callId === callId)
      const status = successfulToolResult(event) ? 'completed' as const : 'failed' as const
      if (index < 0) {
        return appendRow(next, {
          id: `tool-${callId}`,
          seq: event.seq,
          kind: 'tool',
          text: presentation.title ?? callId,
          detail: presentation.detail,
          status,
          callId,
        })
      }
      const current = next.rows[index] as TranscriptRow
      const row: TranscriptRow = {
        ...current,
        seq: event.seq,
        text: presentation.title ?? current.text,
        detail: presentation.detail ?? current.detail,
        status,
      }
      return { ...next, rows: next.rows.toSpliced(index, 1, row) }
    }
    case 'command/run': return upsertRow(next, {
      id: `command-${String(event.data.commandId)}`,
      seq: event.seq,
      kind: 'command',
      text: commandText(event),
      status: 'running',
    })
    case 'command/done': {
      const id = `command-${String(event.data.commandId)}`
      const index = next.rows.findIndex(row => row.id === id)
      const status = event.data.kind === 'success' ? 'completed' as const : 'failed' as const
      if (index < 0) {
        return appendRow(next, {
          id, seq: event.seq, kind: 'command', text: '命令', detail: event.data.text, status,
        })
      }
      const current = next.rows[index] as TranscriptRow
      return { ...next, rows: next.rows.toSpliced(index, 1, {
        ...current,
        seq: event.seq,
        detail: event.data.text ?? current.detail,
        status,
      }) }
    }
    case 'compaction/start': {
      const id = event.data.sourceCommandId === undefined
        ? `compaction-${String(event.data.compactionId)}`
        : `command-${String(event.data.sourceCommandId)}`
      return upsertRow(next, {
        id,
        seq: event.seq,
        kind: 'compaction',
        text: event.data.sourceCommandId === undefined ? '自动压缩' : '/compact',
        detail: event.data.turn === null ? '独立压缩事务' : `第 ${String(event.data.turn)} 轮`,
        status: 'running',
      })
    }
    case 'compaction/summary': {
      const id = event.data.sourceCommandId === undefined
        ? `compaction-${String(event.data.compactionId)}`
        : `command-${String(event.data.sourceCommandId)}`
      return upsertRow(next, {
        id,
        seq: event.seq,
        kind: 'compaction',
        text: event.data.sourceCommandId === undefined ? '自动压缩' : '/compact',
        detail: compactionDetail(event),
        status: 'completed',
      })
    }
    case 'compaction/end': {
      if (event.data.error === undefined) return next
      const id = event.data.sourceCommandId === undefined
        ? `compaction-${String(event.data.compactionId)}`
        : `command-${String(event.data.sourceCommandId)}`
      const current = next.rows.find(row => row.id === id)
      return upsertRow(next, {
        id,
        seq: event.seq,
        kind: 'compaction',
        text: current?.text ?? '压缩',
        detail: event.data.error,
        status: 'failed',
      })
    }
    case 'llm/retry': {
      const retryId = String(event.data.retryId)
      next = { ...next, retryTurns: { ...next.retryTurns, [retryId]: event.data.turn } }
      return upsertRow(next, {
        id: `retry-${retryId}`,
        seq: event.seq,
        kind: 'retry',
        text: `${event.data.provider} 模型重试`,
        detail: retryDetail(event),
        status: 'running',
      })
    }
    case 'llm/retry-started': {
      const id = `retry-${String(event.data.retryId)}`
      const current = next.rows.find(row => row.id === id)
      if (current === undefined) return next
      return upsertRow(next, {
        ...current,
        seq: event.seq,
        detail: `${current.detail ?? ''}\n第 ${String(event.data.retry)} 次重试已开始`.trim(),
      })
    }
    case 'agent-preset/selected': return { ...next, agentPreset: event.data.agentPreset }
    case 'request/header': return {
      ...next,
      model: `${event.data.header.config.provider}/${event.data.header.config.model}`,
      reasoningEffort: event.data.header.config.reasoningEffort,
    }
    case 'request/context': return { ...next, modelContextWindow: event.data.contextWindow }
    case 'todo/write': return { ...next, todos: event.data.todos }
    case 'tool-workflow/run-start': {
      const workflow: WorkflowRun = {
        runId: String(event.data.runId),
        name: event.data.name,
        status: 'running',
        members: [],
      }
      next = { ...next, workflows: [...next.workflows, workflow] }
      return projectWorkflowRow(next, workflow, event.seq)
    }
    case 'tool-workflow/agent-start': return updateWorkflow(
      next,
      String(event.data.runId),
      event.seq,
      workflow => ({
        ...workflow,
        members: [...workflow.members, {
          seq: event.data.seq,
          label: event.data.label,
          ...(event.data.phase === undefined ? {} : { phase: event.data.phase }),
          childId: event.data.childId,
          status: 'running',
        }],
      }),
    )
    case 'tool-workflow/agent-end': return updateWorkflow(
      next,
      String(event.data.runId),
      event.seq,
      workflow => ({
        ...workflow,
        members: workflow.members.map(member => member.seq === event.data.seq
          ? { ...member, status: event.data.outcome }
          : member),
      }),
    )
    case 'tool-workflow/run-end': return updateWorkflow(
      next,
      String(event.data.runId),
      event.seq,
      workflow => ({
        ...workflow,
        status: event.data.stopReason === 'error' ? 'failed' : event.data.stopReason,
      }),
    )
    case 'turn/end': {
      next = interruptRunningWorkflows(next, event.seq)
      next = interruptRunningTools(next, event.seq)
      const retried = Object.values(next.retryTurns).includes(event.data.turn)
      next = settleRetries(
        next,
        event.data.turn,
        event.data.reason.kind === 'error' ? 'failed' : 'interrupted',
        event.seq,
      )
      next = { ...next, partialText: '', partialReasoning: '', partialTool: undefined }
      if (event.data.reason.kind === 'completed') return next
      if (event.data.reason.kind === 'error' && retried) return next
      const message = event.data.reason.kind === 'error'
        ? `${event.data.reason.error.code}: ${event.data.reason.error.message}`
        : event.data.reason.kind === 'aborted'
          ? '本轮已取消'
          : event.data.reason.kind === 'max-tokens'
            ? '本轮达到模型输出 token 上限'
            : `本轮结束：${event.data.reason.kind}`
      return appendRow(next, {
        id: `turn-${String(event.data.turn)}-${String(event.seq)}`,
        seq: event.seq,
        kind: event.data.reason.kind === 'error' ? 'error' : 'notice',
        text: message,
      })
    }
    default: return next
  }
}

/**
 * Fold a history page in durable sequence order.
 * @param state - Terminal projection preceding the page.
 * @param entries - History entries to fold by event sequence.
 * @returns Updated terminal projection.
 */
export function applyHistory(state: TuiViewState, entries: readonly HistoryEntry[]): TuiViewState {
  return entries.reduce((current, entry) => applySessionEvent(current, entry.event, entry.view), state)
}

/**
 * Fold one mux frame for the currently open session.
 * @param state - Current terminal projection.
 * @param rpcId - Original request identity for answerable interactions.
 * @param frame - Session or interaction frame to fold.
 * @returns Updated terminal projection.
 */
export function applyMuxFrame(state: TuiViewState, rpcId: RpcId, frame: MuxFrame): TuiViewState {
  if (frame.type === 'stream/error') return { ...state, notice: frame.error.message }
  if (state.sessionId === undefined || frame.sessionId !== state.sessionId) return state
  switch (frame.type) {
    case 'session/event': return applySessionEvent(state, frame.event, frame.view)
    case 'session/queue': {
      const queueItems = frame.items.filter(item => item.placement !== 'context')
      return { ...state, queueSize: queueItems.length, queueItems }
    }
    case 'session/jobs': return { ...state, jobs: frame.jobs }
    case 'session/projection': {
      const projections = { ...state.projections, [frame.key]: frame.value }
      return { ...state, projections, title: projectedTitle(projections) }
    }
    case 'approval/requested': return {
      ...state,
      interaction: {
        kind: 'approval', rpcId, sessionId: frame.sessionId,
        approvalId: frame.approvalId, toolName: frame.toolName,
        ...(frame.reason === undefined ? {} : { reason: frame.reason }),
      },
    }
    case 'question/requested': return {
      ...state,
      interaction: { kind: 'question', rpcId, sessionId: frame.sessionId, questions: frame.questions },
    }
    case 'approval/resolved':
    case 'question/resolved': return { ...state, interaction: undefined }
    case 'session/subscribed': return state
  }
}

/**
 * Fold a Host frame for the currently open session.
 * @param state - Current terminal projection.
 * @param frame - Host status frame to fold.
 * @returns Updated terminal projection.
 */
export function applyHostFrame(state: TuiViewState, frame: HostFrame): TuiViewState {
  if (frame.type === 'stream/error') return { ...state, notice: frame.error.message }
  if ('sessionId' in frame && frame.sessionId !== state.sessionId) return state
  switch (frame.type) {
    case 'host/session-status': return state.running === frame.running ? state : { ...state, running: frame.running }
    case 'host/agent-error': return appendRow(state, {
      id: `host-error-${String(state.rows.length)}`,
      seq: state.lastSeq,
      kind: 'error',
      text: frame.message,
    })
    case 'host/session-removed': return { ...state, phase: 'error', notice: '当前会话已被删除' }
    default: return state
  }
}
