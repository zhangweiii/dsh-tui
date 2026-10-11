/**
 * The terminal's Host API surface: the frozen `src/contract` vocabulary plus
 * the two additive capabilities DSH 0.2.x requires — an addressed live-session
 * subscription (the current Host follows one Session address per generation
 * instead of fanning every session into one mux) and Remote failure surfacing.
 *
 * @module @zhangweiii/dsh-tui/host/api
 */

import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostFrame, IApiClient, MuxFrame, RpcResult } from '../contract/index.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '../contract/rpc.ts'

export type { SessionAddress }

/**
 * One process-local assistant chunk frame. DSH 0.2.x streams assistant output
 * outside the durable log (the follow stream's `assistant-stream` frames)
 * precisely because a chunk is not a session event: it has no durable
 * sequence, so it cannot ride the `session/event` frame without colliding with
 * the durable sequence space the renderer de-duplicates on.
 */
export type SessionChunkFrame = {
  readonly type: 'session/chunk'
  readonly sessionId: SessionId
  readonly event: SessionEvent<'assistant/chunk'>
}

/** Every frame the live-session subscription delivers. */
export type TuiMuxFrame = MuxFrame | SessionChunkFrame

/**
 * Payload of the live-session subscription. `address` names the Session (or
 * subagent child) whose frames the generation carries; omitting it subscribes
 * to host-level frames only.
 */
export interface MuxPayload {
  /** Addressed session or direct subagent child. */
  address?: SessionAddress
  /** Resume hook kept for wire compatibility; the 0.2.x Host ignores it. */
  since?: Record<string, number>
}

/** Live-session and host-level subscriptions over one carrier. */
export interface TuiEventsApi extends Omit<IApiClient['events'], 'mux'> {
  /**
   * Subscribe to one addressed session's live frames plus every host-level
   * frame. Opening the stream establishes the carrier subscription; `onOpen`
   * fires once the transport is readable, before any frame.
   */
  mux(payload: MuxPayload, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<TuiMuxFrame>>
  /** Host-level frames only. */
  host(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>
}

/** Complete Host API consumed by the controller and the model. */
export interface TuiHostApi extends Omit<IApiClient, 'events'> {
  events: TuiEventsApi
}

/**
 * Generic unary Remote face for endpoints outside the frozen vocabulary (the
 * Host's own typert Remotes such as the file-reference index). Kept structural
 * so focused tests can drive a consumer without a live carrier.
 */
export interface RemoteRpcCarrier {
  /**
   * Call one channel-relative endpoint (`<namespace>/<method>`) with its named
   * wire arguments. Resolves with the result envelope; a result error branch is
   * returned rather than thrown.
   */
  callRemote(endpoint: string, args: Readonly<Record<string, unknown>>, signal?: AbortSignal): Promise<RpcResult<unknown>>
}
