/**
 * The terminal's Host API surface: the frozen `src/contract` vocabulary plus
 * the two additive capabilities DSH 0.2.x requires — an addressed live-session
 * subscription (the current Host follows one Session address per generation
 * instead of fanning every session into one mux) and Remote failure surfacing.
 *
 * @module @zhangweiii/dsh-tui/host/api
 */

import type { SessionAddress } from '@deepseek-ai/dsh-api-session-controller/types'
import type { HostFrame, IApiClient, MuxFrame } from '../contract/index.ts'
import type { RpcRequest } from '../contract/rpc.ts'

export type { SessionAddress }

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
  mux(payload: MuxPayload, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
  /** Host-level frames only. */
  host(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>
}

/** Complete Host API consumed by the controller and the model. */
export interface TuiHostApi extends Omit<IApiClient, 'events'> {
  events: TuiEventsApi
}
