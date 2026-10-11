/**
 * The Host API implementation both terminals carriers share: every contract
 * namespace, the live-frame synthesis that turns 0.2.x Remote events into the
 * frames the renderer folds, and the answer path for approvals and questions.
 *
 * Only the carrier differs between the two modes, and it is expressed as
 * {@link HostTransport}: unary invocation, logical streams, forwarded events,
 * and scoped waterfall participation.
 *
 * @module @zhangweiii/dsh-tui/host/client
 */

import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionListValue, SessionSummary as RemoteSessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalRequestEvent, ApprovalOutcome, ApprovalRequestId } from '@deepseek-ai/dsh-user-approval/types'
import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import type { ToolEventView } from '../contract/events.ts'
import type {
  ClientResponse, HostFrame, IApiClient, JobView, MuxFrame, QueuedInboxItem, RpcReceipt, RpcRequest, RpcResponse,
} from '../contract/index.ts'
import type {
  CredentialView, ModelCatalogFailure, ModelProviderGroup, ModelSelection, RpcResult, SessionModels, SettingsNamespaceView,
} from '../contract/index.ts'
import type { HistoryEntry, SessionProjectionsBlock, SessionSummary } from '../contract/sessions.ts'
import type { SubagentAddress, SubagentCatalog, SubagentListEntry } from '../contract/subagents.ts'
import type { RpcError } from '../contract/rpc.ts'
import type { RequestPayload, ResponseValue } from '../contract/rpc-map.ts'
import { RpcId } from '../contract/runtime.ts'
import type { WorkspaceView } from '../contract/workspace.ts'
import type { MuxPayload, TuiEventsApi, TuiHostApi, TuiMuxFrame } from './api.ts'
import { sessionSummary, unaryMapping, workspaceView, type UnaryMethod } from './endpoints.ts'
import { toolCallView, toolResultView } from '../presentation.ts'

/** One pending answerable request delivered by a carrier. */
export interface WaterfallInvocation {
  /** Correlation id the answer echoes. */
  rpcId: RpcId
  /** Forwarded event name that was invoked. */
  event: string
  /** Sole request argument of that waterfall. */
  request: Record<string, unknown>
  /** Agent identity the invocation is scoped to; the Session it belongs to. */
  sessionId: string | undefined
  /** Deliver the outcome, or fail the invocation. */
  settle(outcome: { kind: 'result'; value: unknown } | { kind: 'reject'; error: Error }): Promise<void>
}

/** Physical carrier of the Host API. */
export interface HostTransport {
  /** Invoke one unary Remote endpoint; resolves its value or rejects. */
  invoke(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  /** Open one logical Remote stream generation. */
  open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown>
  /** Subscribe to one forwarded emit-mode Host event. */
  on(event: string, listener: (...args: readonly unknown[]) => void): () => void
  /** Subscribe to one forwarded waterfall-mode Host event. */
  onWaterfall(event: string, listener: (invocation: WaterfallInvocation) => void): () => void
  /** Host facts published by the carrier generation. */
  readonly facts: { readonly home: string | undefined; readonly isLoopback: boolean }
  /** Release the carrier. */
  close(): Promise<void>
}

/**
 * Single-consumer frame queue with an awaiting reader: one `push` per produced
 * frame and one `shift` per consumed frame, in order. `fail` and `close` end the
 * queue for the consumer, the first by throwing.
 * @internal
 */
export class FrameQueue<T> {
  private readonly items: T[] = []
  private wake: (() => void) | undefined
  private closed = false
  private failure: { error: unknown } | undefined

  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.wake?.()
  }

  close(): void {
    this.closed = true
    this.wake?.()
  }

  fail(error: unknown): void {
    if (this.closed) return
    this.failure = { error }
    this.closed = true
    this.wake?.()
  }

  get length(): number {
    return this.items.length
  }

  async *drain(): AsyncGenerator<T> {
    while (true) {
      const item = this.items.shift()
      if (item !== undefined) {
        yield item
        continue
      }
      if (this.failure !== undefined) throw this.failure.error
      if (this.closed) return
      await new Promise<void>((resolve) => { this.wake = resolve })
      this.wake = undefined
    }
  }
}

/** Live-session generation state shared by the subscription and history reads. */
interface FollowGeneration {
  address: SessionAddress
  controller: AbortController
  ready: Promise<FollowSnapshot>
  snapshot: FollowSnapshot | undefined
}

/** Opening window of one follow generation. */
interface FollowSnapshot {
  cursor: number
  records: HistoryEntry[]
  hasMore: boolean
  projections: Readonly<Record<string, unknown>>
}

/** Opening window of a generation that never opened. */
const EMPTY_SNAPSHOT: FollowSnapshot = { cursor: 0, records: [], hasMore: false, projections: {} }

/** Message window requested for both the opening snapshot and later pages. */
const HISTORY_PAGE_MESSAGES = 100

/**
 * DSH version this terminal is aligned with. The current Host publishes no
 * version fact over the Remote surface, so `/host` reports the peer version the
 * bundle was built against rather than an unverifiable remote value.
 */
const DSH_VERSION = '0.2.0-rc.2'

/** One raw session event as the Remote journal carries it. */
interface SessionWireEvent {
  type: string
  seq: number
  time: number
  data: unknown
  ignorable?: true
  sourceEventSeqs?: unknown
  surfaceOp?: unknown
}

/** One follow-stream frame. */
type FollowFrame =
  | {
    type: 'snapshot'
    cursor: number
    records: readonly { event: SessionWireEvent }[]
    hasMore: boolean
    projections: { asOfSeq: number, values: Readonly<Record<string, unknown>> }
    assistantStream?: { activeAttempt?: { attemptId: string, turn: number, step: number } }
  }
  | { type: 'event', event: SessionWireEvent }
  | { type: 'assistant-stream', frame: AssistantStreamFrame }

/** One process-local assistant stream frame. */
type AssistantStreamFrame =
  | { type: 'start', attemptId: string, turn: number, step: number }
  | { type: 'chunk', attemptId: string, index: number, time: number, chunk: unknown }
  | { type: 'end', attemptId: string }

/**
 * Project one durable journal record onto the contract history entry, attaching
 * the render intent the 0.2.x wire no longer carries. Tool results are matched
 * to the call that produced them so a `diff`/`terminal` card can name its
 * command or file.
 * @param wire - raw journal event.
 * @param calls - call metadata seen in this generation, updated in place.
 * @returns the contract entry.
 */
export function addressSessionId(address: SessionAddress): SessionId {
  return (address.kind === 'session' ? address.sessionId : address.childSessionId) as SessionId
}

function entryFor(wire: SessionWireEvent, calls: Map<string, { name: string, arguments: string }>): HistoryEntry {
  const event = wire as unknown as SessionEvent
  if (event.type === 'tool/call') {
    calls.set(event.data.callId, { name: event.data.name, arguments: event.data.arguments })
    const view = toolCallView(event.data.name, event.data.arguments)
    return { event, ...(view === undefined ? {} : { view }) }
  }
  if (event.type === 'tool/result') {
    const call = calls.get(event.data.message.toolCallId)
    const message = event.data.message
    const view = toolResultView(call?.name ?? '', call?.arguments ?? '{}', {
      content: message.content,
      isError: message.isError === true,
      ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
    })
    return { event, ...(view === undefined ? {} : { view }) }
  }
  return { event }
}


/** Contract error codes a current Remote failure may legitimately carry over. */
const KNOWN_CODES = new Set<string>(['bad-request', 'cancelled', 'session-not-found', 'internal'])

/**
 * Fold any carrier failure into the contract's error branch. Codes the frozen
 * vocabulary does not know become `internal` and keep their original code in
 * the message, so a terminal notice still names what the Host refused.
 * @param error - rejected carrier operation.
 * @returns the contract error value.
 */
function remoteFailure(error: unknown): RpcError {
  const candidate = error as { code?: unknown; message?: unknown } | undefined
  const code = typeof candidate?.code === 'string' ? candidate.code : undefined
  const detail = typeof candidate?.message === 'string' ? candidate.message : undefined
  if (code !== undefined && KNOWN_CODES.has(code)) {
    return { code: code as RpcError['code'], message: detail ?? code, details: {} } as RpcError
  }
  return {
    code: 'internal',
    message: detail ?? (error instanceof Error ? error.message : String(error)),
    details: {},
  } as RpcError
}

/** The Host API implementation over one carrier. */
export class HostApiClient implements TuiHostApi {
  private readonly pending = new Map<string, WaterfallInvocation>()
  private readonly hostFrames = new FrameQueue<RpcRequest<HostFrame>>()
  private readonly muxFrames = new FrameQueue<RpcRequest<TuiMuxFrame>>()
  private readonly disposers: (() => void)[] = []
  private follow: FollowGeneration | undefined
  private sessionStreams: AbortController | undefined
  private sessionStreamsFor: string | undefined
  private workspaces: WorkspaceView[] = []
  private archivedSessionIds: string[] = []
  private workspaceIndex = new Map<string, WorkspaceView>()
  private workspacesReady: Promise<void> | undefined
  private jobs: JobView[] = []
  private liveStarted = false
  private closed = false

  constructor(private readonly transport: HostTransport) {}

  /** Forwarded host facts the renderer may surface (Host home, carrier locality). */
  get facts(): HostTransport['facts'] {
    return this.transport.facts
  }

  private async call<K extends UnaryMethod>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>> {
    const mapping = unaryMapping(method)
    const rpcId = RpcId(randomUUID())
    try {
      const value = await this.transport.invoke(mapping.endpoint, mapping.args(payload), signal)
      return { rpcId, result: { ok: true, value: mapping.decode(value) as ResponseValue<K> } }
    } catch (error) {
      return { rpcId, result: { ok: false, error: remoteFailure(error) } }
    }
  }

  /** Forward one emit-mode Host event into the host-frame queue. */
  private forward(event: string, listener: (...args: readonly unknown[]) => void): void {
    this.disposers.push(this.transport.on(event, listener))
  }

  /** Forward one scoped waterfall into an answerable interaction frame. */
  private forwardWaterfall(event: string, build: (invocation: WaterfallInvocation) => MuxFrame | undefined): void {
    this.disposers.push(this.transport.onWaterfall(event, (invocation) => {
      this.pending.set(invocation.rpcId, invocation)
      const frame = build(invocation)
      if (frame !== undefined) this.muxFrames.push({ rpcId: invocation.rpcId, payload: frame })
    }))
  }

  private pushHost(payload: HostFrame): void {
    this.hostFrames.push({ rpcId: RpcId(randomUUID()), payload })
  }

  private pushMux(payload: TuiMuxFrame): void {
    this.muxFrames.push({ rpcId: RpcId(randomUUID()), payload })
  }

  /**
   * Establish the host-wide subscriptions once per client: session registry
   * frames, answerable interactions, and the workspace registry.
   */
  private startLive(): void {
    if (this.liveStarted) return
    this.liveStarted = true
    this.forward('api-session/added', (summary) => {
      const item = sessionSummary(summary as RemoteSessionSummary)
      this.pushHost({
        type: 'host/session-added',
        sessionId: item.sessionId,
        blank: item.blank,
        ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
        ...(item.origin === undefined ? {} : { origin: item.origin }),
        ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
        ...(item.agentPreset === undefined ? {} : { agentPreset: item.agentPreset }),
      })
    })
    this.forward('api-session/removed', (sessionId) => {
      this.pushHost({ type: 'host/session-removed', sessionId: sessionId as SessionId })
    })
    this.forward('api-session/status', (sessionId, running) => {
      this.pushHost({ type: 'host/session-status', sessionId: sessionId as SessionId, running: running === true })
    })
    this.forward('api-session/error', (sessionId, failure) => {
      this.pushHost({
        type: 'host/agent-error',
        sessionId: sessionId as SessionId,
        message: typeof failure === 'string' ? failure : JSON.stringify(failure),
      })
    })
    this.forwardWaterfall('approval/request', (invocation) => {
      const request = invocation.request as unknown as ApprovalRequestEvent
      const sessionId = invocation.sessionId
      if (sessionId === undefined) return undefined
      return {
        type: 'approval/requested',
        sessionId: sessionId as SessionId,
        // The waterfall carries no durable approval id: the invocation's own
        // correlation id is the identity this client answers with.
        approvalId: invocation.rpcId as unknown as ApprovalRequestId,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
      }
    })
    this.forwardWaterfall('user-questions/request', (invocation) => {
      const sessionId = invocation.sessionId
      if (sessionId === undefined) return undefined
      const questions = invocation.request['questions']
      if (!Array.isArray(questions)) return undefined
      return { type: 'question/requested', sessionId: sessionId as SessionId, questions: questions as AskUserQuestionItem[] }
    })
    this.disposers.push(() => { this.hostFrames.close(); this.muxFrames.close() })
    void this.openWorkspaceFollow()
  }

  /**
   * Keep one workspace registry baseline plus its increments. The 0.2.x Host
   * exposes the registry as a stream rather than a unary list, so every
   * `workspace.list` read answers from this generation.
   */
  private async openWorkspaceFollow(): Promise<void> {
    const controller = new AbortController()
    this.disposers.push(() => { controller.abort() })
    let markReady: (() => void) | undefined
    this.workspacesReady = new Promise<void>((resolve) => { markReady = resolve })
    void (async () => {
      try {
        for await (const frame of this.transport.open('workspace/follow', {}, controller.signal)) {
        const current = frame as {
          type?: string
          value?: unknown
          workspace?: WorkspaceView
          workspaceId?: string
          workspaceIds?: readonly string[]
          archivedSessionIds?: readonly string[]
        }
        switch (current.type) {
          case 'baseline': {
            const baseline = current.value as { items: readonly WorkspaceView[]; archivedSessionIds: readonly string[] }
            this.workspaces = baseline.items.map(workspaceView)
            this.archivedSessionIds = [...baseline.archivedSessionIds]
            for (const item of this.workspaces) this.pushHost({ type: 'host/workspace-changed', workspace: item })
            this.pushHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...this.archivedSessionIds] as SessionId[] })
            markReady?.()
            markReady = undefined
            break
          }
          case 'upsert': {
            if (current.workspace === undefined) break
            const workspace = workspaceView(current.workspace)
            this.workspaces = [...this.workspaces.filter(item => item.workspaceId !== workspace.workspaceId), workspace]
            this.pushHost({ type: 'host/workspace-changed', workspace })
            break
          }
          case 'removed': {
            const removed = current.workspaceId
            if (removed === undefined) break
            this.workspaces = this.workspaces.filter(item => item.workspaceId !== removed)
            this.pushHost({ type: 'host/workspace-removed', workspaceId: removed as WorkspaceView['workspaceId'] })
            break
          }
          case 'order': {
            const order = current.workspaceIds ?? []
            this.workspaces = [...order].flatMap(id => this.workspaces.filter(item => item.workspaceId === id))
            this.pushHost({ type: 'host/workspace-order-changed', workspaceIds: [...order] as WorkspaceView['workspaceId'][] })
            break
          }
          case 'archived': {
            this.archivedSessionIds = [...(current.archivedSessionIds ?? [])]
            this.pushHost({ type: 'host/archived-sessions-changed', archivedSessionIds: [...this.archivedSessionIds] as SessionId[] })
            break
          }
          default: break
        }
      }
      } catch (error) {
        markReady?.()
        markReady = undefined
        if (!controller.signal.aborted) this.pushHost({ type: 'stream/error', error: remoteFailure(error) })
      }
    })()
  }




  /** Address equality for follow generations. */
  private ensureFollow(address: SessionAddress, signal?: AbortSignal): FollowGeneration {
    const current = this.follow
    if (current !== undefined && current.address.kind === address.kind
      && addressSessionId(current.address) === addressSessionId(address)) {
      return current
    }
    current?.controller.abort()
    const controller = new AbortController()
    signal?.addEventListener('abort', () => { controller.abort() }, { once: true })
    const generation = {
      address,
      controller,
      ready: Promise.resolve(EMPTY_SNAPSHOT),
      snapshot: undefined as FollowSnapshot | undefined,
    } satisfies FollowGeneration
    this.follow = generation
    generation.ready = this.runFollow(generation)
    return generation
  }

  /**
   * Run one follow generation: the opening snapshot becomes the first history
   * page and every later record becomes a live frame.
   */
  private async runFollow(generation: FollowGeneration): Promise<FollowSnapshot> {
    const sessionId = addressSessionId(generation.address)
    const calls = new Map<string, { name: string, arguments: string }>()
    const attempts = new Map<string, { turn: number, step: number }>()
    let settle: { resolve: (value: FollowSnapshot) => void, reject: (reason: unknown) => void } | undefined
    const ready = new Promise<FollowSnapshot>((resolve, reject) => { settle = { resolve, reject } })
    void (async () => {
      try {
        for await (const value of this.transport.open('session/follow', {
          request: { address: generation.address, assistantStream: true, maxMessages: HISTORY_PAGE_MESSAGES },
        }, generation.controller.signal)) {
          if (this.follow !== generation) return
          const frame = value as FollowFrame
          if (frame.type === 'snapshot') {
            const records = frame.records.map(record => entryFor(record.event, calls))
            const snapshot: FollowSnapshot = {
              cursor: frame.cursor,
              records,
              hasMore: frame.hasMore,
              projections: frame.projections.values,
            }
            generation.snapshot = snapshot
            settle?.resolve(snapshot)
            settle = undefined
            this.pushMux({ type: 'session/subscribed', sessionId, lastSeq: frame.cursor })
            this.pushProjections(sessionId, frame.projections.values, frame.projections.asOfSeq)
            const active = frame.assistantStream?.activeAttempt
            if (active !== undefined) attempts.set(active.attemptId, { turn: active.turn, step: active.step })
            continue
          }
          if (frame.type === 'event') {
            const entry = entryFor(frame.event, calls)
            this.pushMux({
              type: 'session/event',
              sessionId,
              event: entry.event,
              ...(entry.view === undefined ? {} : { view: entry.view }),
            })
            continue
          }
          if (frame.type === 'assistant-stream') this.pushChunk(sessionId, frame.frame, attempts)
        }
      } catch (error) {
        settle?.reject(error)
        if (!generation.controller.signal.aborted) {
          this.pushMux({ type: 'stream/error', error: remoteFailure(error) })
        }
      }
    })()
    return ready
  }

  /** Push one process-local assistant stream frame as a chunk frame. */
  private pushChunk(
    sessionId: SessionId,
    frame: AssistantStreamFrame,
    attempts: Map<string, { turn: number, step: number }>,
  ): void {
    if (frame.type === 'start') {
      attempts.set(frame.attemptId, { turn: frame.turn, step: frame.step })
      return
    }
    if (frame.type !== 'chunk') return
    const attempt = attempts.get(frame.attemptId)
    if (attempt === undefined) return
    const event = {
      type: 'assistant/chunk' as const,
      seq: SessionSeq(frame.index),
      time: frame.time,
      data: { turn: attempt.turn, step: attempt.step, chunk: frame.chunk as never },
    }
    this.pushMux({ type: 'session/chunk', sessionId, event })
  }

  /**
   * Read one durable history page for a session or direct subagent child. The
   * first page is the follow generation's opening snapshot, so a caller that
   * never pages backwards needs exactly one stream and no extra list call.
   */
  private async readHistory(
    address: SessionAddress,
    payload: { beforeSeq?: number, maxMessages?: number },
    signal?: AbortSignal,
  ): Promise<{ events: HistoryEntry[], hasMore: boolean, projections?: SessionProjectionsBlock }> {
    const generation = this.ensureFollow(address, signal)
    const snapshot = await generation.ready
    const projections: SessionProjectionsBlock = { asOfSeq: snapshot.cursor, values: snapshot.projections }
    if (payload.beforeSeq === undefined) {
      const events = payload.maxMessages === undefined
        ? snapshot.records
        : snapshot.records.slice(-payload.maxMessages)
      return { events, hasMore: snapshot.hasMore, projections }
    }
    const value = await this.transport.invoke('session/page', {
      request: {
        address,
        throughSeq: snapshot.cursor,
        beforeSeq: payload.beforeSeq,
        ...(payload.maxMessages === undefined ? {} : { maxMessages: payload.maxMessages }),
      },
    }, signal) as { records: readonly { event: SessionWireEvent }[], hasMore: boolean }
    const calls = new Map<string, { name: string, arguments: string }>()
    return { events: value.records.map(record => entryFor(record.event, calls)), hasMore: value.hasMore, projections }
  }

  /**
   * Keep the followed session's projection and job lists current. Both are
   * addressed streams in 0.2.x; one generation per follow address keeps the
   * frames in the same order the renderer folds them.
   */
  private openSessionStreams(address: SessionAddress): void {
    const sessionId = addressSessionId(address)
    if (this.sessionStreamsFor === sessionId) return
    this.sessionStreams?.abort()
    this.sessionStreamsFor = sessionId
    const controller = new AbortController()
    this.sessionStreams = controller
    void (async () => {
      try {
        for await (const value of this.transport.open('session/control', {}, controller.signal)) {
          if (controller.signal.aborted || this.follow === undefined
            || addressSessionId(this.follow.address) !== addressSessionId(address)) continue
          const frame = value as {
            type: string
            value?: { projections: Readonly<Record<string, { asOfSeq: number, values: Readonly<Record<string, unknown>> }>> }
            sessionId?: string
            key?: string
            seq?: number
          }
          if (frame.type === 'baseline') {
            const baseline = frame.value?.projections[sessionId]
            if (baseline !== undefined) this.pushProjections(sessionId, baseline.values, baseline.asOfSeq)
            continue
          }
          if (frame.type !== 'projection' || frame.sessionId !== sessionId) continue
          if (frame.key === undefined) continue
          this.pushMux({
            type: 'session/projection',
            sessionId,
            key: frame.key,
            value: (frame as { value?: unknown }).value,
            seq: frame.seq ?? 0,
          })
        }
      } catch (error) {
        if (!controller.signal.aborted) this.pushMux({ type: 'stream/error', error: remoteFailure(error) })
      }
    })()
    void (async () => {
      try {
        for await (const value of this.transport.open('job/list', { request: { sessionId } }, controller.signal)) {
          if (controller.signal.aborted) continue
          const frame = value as { type?: string, jobs?: readonly JobView[] }
          if (frame.type !== 'rows' || frame.jobs === undefined) continue
          this.jobs = [...frame.jobs]
          this.pushMux({ type: 'session/jobs', sessionId, jobs: this.jobs })
        }
      } catch (error) {
        if (!controller.signal.aborted) this.pushMux({ type: 'stream/error', error: remoteFailure(error) })
      }
    })()
  }

  /** Push one projection update per key of a baseline block. */
  private pushProjections(sessionId: SessionId, values: Readonly<Record<string, unknown>>, asOfSeq: number): void {
    for (const [key, value] of Object.entries(values)) {
      this.pushMux({ type: 'session/projection', sessionId, key, value, seq: asOfSeq })
    }
  }

  /** Answer one pending approval or question; the renderer owns the identity. */
  async respond(message: ClientResponse): Promise<RpcReceipt> {
    const invocation = this.pending.get(message.rpcId)
    if (invocation === undefined) {
      return { accepted: false, reason: 'not-pending' }
    }
    this.pending.delete(message.rpcId)
    if (!message.result.ok) {
      const { code, message: detail } = message.result.error
      await invocation.settle({ kind: 'reject', error: new Error(`${code}: ${detail}`) })
      return { accepted: true }
    }
    const value = message.result.value as Record<string, unknown>
    const sessionId = value['sessionId'] as SessionId
    if (invocation.event === 'approval/request') {
      const outcome = value['outcome'] as ApprovalOutcome
      await invocation.settle({ kind: 'result', value: outcome })
      this.pushMux({
        type: 'approval/resolved',
        sessionId,
        approvalId: value['approvalId'] as ApprovalRequestId,
        outcome,
      })
      return { accepted: true }
    }
    // A question answer travels as one whole batch, exactly as the waterfall
    // request carries every question of the call.
    await invocation.settle({ kind: 'result', value: value['answer'] })
    this.pushMux({ type: 'question/resolved', sessionId, questionRpcId: message.rpcId, outcome: 'answered' })
    return { accepted: true }
  }

  /** Release every carrier subscription this client owns. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const dispose of this.disposers.splice(0)) dispose()
    this.follow?.controller.abort()
    this.sessionStreams?.abort()
    this.hostFrames.close()
    this.muxFrames.close()
    for (const invocation of this.pending.values()) {
      await invocation.settle({ kind: 'reject', error: new Error('the terminal closed this request') })
    }
    this.pending.clear()
    await this.transport.close()
  }

  /**
   * Merge the process model catalog with one session's durable selection. The
   * current Host publishes the catalog once per process and the selection as a
   * session projection, so the session-scoped view this contract promises is
   * assembled here.
   * @param sessionId - session whose selection should win, or undefined for the process default.
   * @param signal - caller cancellation.
   * @returns the contract model view.
   */
  private async readModels(sessionId: SessionId | undefined, signal?: AbortSignal): Promise<SessionModels> {
    const catalogPromise = this.transport.invoke('session/modelCatalog', {}, signal) as Promise<ModelCatalogValue>
    const projectionsPromise = sessionId === undefined
      ? Promise.resolve(undefined)
      : this.transport.invoke('session/projections', { request: { sessionId } }, signal) as Promise<{ values: Record<string, unknown> } | null>
    const [catalog, projections] = await Promise.all([catalogPromise, projectionsPromise])
    const selection = projections?.values['modelSelection'] as
      | { lastUsed: ModelSelection | null, next: ModelSelection | null }
      | undefined
    const current = selection?.next ?? selection?.lastUsed ?? catalog.default
    return {
      current,
      routable: catalog.routableProviders.includes(current.provider),
      groups: [...catalog.groups],
      failures: [...catalog.failures],
    }
  }

  /**
   * Read one parent session's direct subagent catalog: the durable child roster
   * projection plus the live availability of each child session.
   */
  private async readSubagents(parentSessionId: SessionId, signal?: AbortSignal): Promise<SubagentCatalog> {
    const [projections, listed] = await Promise.all([
      this.transport.invoke('session/projections', { request: { sessionId: parentSessionId } }, signal) as Promise<
        { values: Record<string, unknown> } | null
      >,
      this.transport.invoke('session/list', { _request: {} }, signal) as Promise<SessionListValue>,
    ])
    const roster = (projections?.values['subagentCatalog'] ?? []) as readonly {
      id: SessionId
      mode: 'one-shot' | 'continuable' | 'unknown'
      label?: string
    }[]
    const rows = listed.items
    const entries: SubagentListEntry[] = roster.map(entry => {
      const row = rows.find(item => item.sessionId === entry.id)
      const common = {
        kind: 'child' as const,
        id: entry.id,
        activity: row?.running === true ? 'running' as const : 'inactive' as const,
        hasChildren: rows.some(item => item.parentSessionId === entry.id),
      }
      if (entry.mode === 'continuable') return { ...common, mode: 'continuable', label: entry.label ?? '' }
      return { ...common, mode: 'one-shot', ...(entry.label === undefined ? {} : { label: entry.label }) }
    })
    return { entries, parentAvailable: rows.some(item => item.sessionId === parentSessionId) }
  }

  /**
   * Assemble the Host facts this contract reports. The current Host states
   * each fact through its own endpoint or carrier frame rather than one
   * description call: the workspace opener capability, the session registry,
   * the default model route, and the carrier's Host home.
   */
  private async readHostDescription(signal?: AbortSignal): Promise<{
    version: string
    cwd: string
    provider?: string
    model?: string
    attachedSessions: number
    home: string
    canOpenPath: boolean
  }> {
    const [canOpenPath, listed, catalog] = await Promise.all([
      this.transport.invoke('session/canOpenWorkspacePath', {}, signal).catch(() => false),
      this.transport.invoke('session/list', { _request: {} }, signal) as Promise<SessionListValue>,
      this.transport.invoke('session/modelCatalog', {}, signal).catch(() => undefined) as Promise<ModelCatalogValue | undefined>,
    ])
    const selection = catalog?.default
    return {
      // The current Host publishes no version fact; the terminal reports its own
      // peer-aligned DSH version instead of inventing one.
      version: DSH_VERSION,
      cwd: process.cwd(),
      attachedSessions: listed.items.filter(item => item.agentAvailable).length,
      home: this.transport.facts.home ?? homedir(),
      canOpenPath: canOpenPath === true,
      ...(selection === undefined ? {} : { provider: selection.provider, model: selection.model }),
    }
  }

  private unary<K extends UnaryMethod>(method: K) {
    return (payload: RequestPayload<K>, signal?: AbortSignal) => this.call(method, payload, signal)
  }

  /**
   * Call one Remote endpoint outside the frozen vocabulary (the Host's own
   * typert Remotes, such as the file-reference index) and report its failure
   * branch instead of throwing, exactly like the contract's unary methods.
   * @param endpoint - `<namespace>/<method>`.
   * @param args - named wire arguments.
   * @param signal - caller cancellation.
   * @returns the Remote result envelope.
   */
  async callRemote(
    endpoint: string,
    args: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<RpcResult<unknown>> {
    try {
      return { ok: true, value: await this.transport.invoke(endpoint, { ...args }, signal) }
    } catch (error) {
      return { ok: false, error: remoteFailure(error) }
    }
  }

  private settle<T>(work: () => Promise<T>): Promise<RpcResponse<T>> {
    return work().then(
      value => ({ rpcId: RpcId(randomUUID()), result: { ok: true as const, value } }),
      (error: unknown) => ({ rpcId: RpcId(randomUUID()), result: { ok: false as const, error: remoteFailure(error) } }),
    )
  }

  readonly events: TuiEventsApi = {
    mux: (payload, signal, onOpen) => this.muxStream(payload, signal, onOpen),
    host: (_payload, signal) => this.hostStream(signal),
  }

  private async *muxStream(
    payload: MuxPayload,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<TuiMuxFrame>> {
    this.startLive()
    if (payload.address !== undefined) {
      const generation = this.ensureFollow(payload.address, signal)
      this.openSessionStreams(payload.address)
      await generation.ready
    }
    onOpen?.()
    for await (const frame of this.muxFrames.drain()) {
      if (signal.aborted) return
      yield frame
    }
  }

  private async *hostStream(signal: AbortSignal): AsyncGenerator<RpcRequest<HostFrame>> {
    this.startLive()
    for await (const frame of this.hostFrames.drain()) {
      if (signal.aborted) return
      yield frame
    }
  }


  readonly sessions: TuiHostApi['sessions'] = {
    list: this.unary('session.list'),
    search: this.unary('session.search'),
    create: this.unary('session.create'),
    history: (payload, signal) => this.settle(() => this.readHistory(
      { kind: 'session', sessionId: payload.sessionId },
      payload,
      signal,
    )),
    models: (payload, signal) => this.settle(() => this.readModels(payload.sessionId, signal)),
    selectModel: this.unary('session.selectModel'),
    rename: this.unary('session.rename'),
    fork: this.unary('session.fork'),
    prompt: this.unary('session.prompt'),
    attachment: this.unary('session.attachment'),
    updateQueue: this.unary('session.updateQueue'),
    cancel: this.unary('session.cancel'),
  }

  readonly subagents: TuiHostApi['subagents'] = {
    list: (payload, signal) => this.settle(() => this.readSubagents(payload.parentSessionId, signal)),
    history: (payload, signal) => this.settle(() => this.readHistory({
      kind: 'subagent',
      parentSessionId: payload.parentSessionId,
      childSessionId: payload.childSessionId,
      mode: payload.mode,
    }, payload, signal)),
    prompt: this.unary('subagent.prompt'),
    interrupt: this.unary('subagent.interrupt'),
  }

  readonly host: TuiHostApi['host'] = {
    describe: (_payload, signal) => this.settle(() => this.readHostDescription(signal)),
    pickDirectory: this.unary('host.pickDirectory'),
    listDirectory: this.unary('host.listDirectory'),
    createDirectory: this.unary('host.createDirectory'),
    openPath: this.unary('host.openPath'),
  }

  readonly workspace: TuiHostApi['workspace'] = {
    list: () => this.settle(async () => {
      this.startLive()
      await this.workspacesReady
      return {
        items: [...this.workspaces],
        archivedSessionIds: [...this.archivedSessionIds] as SessionId[],
      }
    }),
    create: this.unary('workspace.create'),
    rename: this.unary('workspace.rename'),
    delete: this.unary('workspace.delete'),
    insertBefore: this.unary('workspace.insertBefore'),
    insertSessionBefore: this.unary('workspace.insertSessionBefore'),
    archiveSession: this.unary('workspace.archiveSession'),
  }

  readonly skills: TuiHostApi['skills'] = {
    list: this.unary('skill.list'),
  }

  readonly agentPresets: TuiHostApi['agentPresets'] = {
    list: this.unary('agentPreset.list'),
    select: this.unary('agentPreset.select'),
    read: this.unary('agentPreset.read'),
    // The 0.2.x roster Remote exposes no document mutation: preset documents
    // are owned by the Host's settings document, reached through /settings.
    copy: () => this.settle(async () => {
      throw new Error('当前 Host 不提供 agent preset 复制能力（dsh-agent-preset-registry）')
    }),
    openDocument: () => this.settle(async () => {
      throw new Error('当前 Host 不提供 preset 文档打开能力；请使用 /settings open')
    }),
    remove: () => this.settle(async () => {
      throw new Error('当前 Host 不提供 agent preset 删除能力（dsh-agent-preset-registry）')
    }),
  }

  readonly goals: TuiHostApi['goals'] = {
    create: this.unary('goal.create'),
    edit: this.unary('goal.edit'),
    pause: this.unary('goal.pause'),
    resume: this.unary('goal.resume'),
    complete: this.unary('goal.complete'),
    clear: this.unary('goal.clear'),
  }

  readonly settings: TuiHostApi['settings'] = {
    describe: this.unary('settings.describe'),
    openDocument: this.unary('settings.openDocument'),
    update: this.unary('settings.update'),
    replace: this.unary('settings.replace'),
    mutate: this.unary('settings.mutate'),
  }

  readonly credentials: TuiHostApi['credentials'] = {
    describe: this.unary('credentials.describe'),
    set: this.unary('credentials.set'),
    unset: this.unary('credentials.unset'),
  }

  readonly llm: TuiHostApi['llm'] = {
    providers: this.unary('llm.providers'),
    models: () => this.settle(() => this.readModels(undefined)),
    discoverModels: this.unary('llm.discoverModels'),
  }
}

/** One model catalog read merged with a session's own durable selection. */
interface ModelCatalogValue {
  default: ModelSelection
  routableProviders: readonly string[]
  groups: readonly ModelProviderGroup[]
  failures: readonly ModelCatalogFailure[]
}

