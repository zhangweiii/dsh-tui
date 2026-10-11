/**
 * Runtime half of the frozen Host API contract: the two values the vocabulary
 * exposes (`RpcId` branding and the transport-error folder) plus the search
 * bounds. Everything else in `src/contract/` is type-only.
 *
 * @module @zhangweiii/dsh-tui/contract/runtime
 */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { RpcError, RpcResult } from './rpc.ts'

/** Message correlation id: the initiator mints it; a response echoes the request's id. */
export type RpcId = Branded<'rpc-id'>

/** Maximum number of sessions returned by one sidebar search. */
export const SESSION_SEARCH_RESULT_LIMIT = 20

/** Maximum snippet length in Unicode code points. */
export const SESSION_SEARCH_SNIPPET_MAX_CODE_POINTS = 240

/**
 * Brand one opaque correlation id. The terminal mints ids for every call it
 * makes and echoes the server's id for requests it answers.
 * @param value - non-empty correlation string.
 * @returns the same string carrying the contract brand.
 */
export function RpcId(value: string): RpcId {
  return value as RpcId
}

/** Error code used for carrier-level failures, matching the historical contract. */
const TRANSPORT_ERROR_CODE = 'internal' satisfies RpcError['code']

/**
 * Fold a thrown carrier failure into the contract's error result shape.
 * @param error - rejected transport operation.
 * @returns an `internal` failure preserving the available message.
 */
export function transportError<T>(error: unknown): RpcResult<T> {
  const message = error instanceof Error ? error.message : String(error)
  const rpcError: RpcError = {
    code: TRANSPORT_ERROR_CODE,
    message,
    details: {},
  }
  return { ok: false, error: rpcError }
}
