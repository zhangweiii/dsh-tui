/**
 * Durable-event vocabulary this client synthesizes from live-stream frames.
 *
 * DSH 0.2.x moved streaming assistant output out of the durable session log:
 * the follow stream carries process-local `assistant-stream` frames instead of
 * logged `assistant/chunk` events. The terminal folds the same incremental
 * chunks either way, so it re-declares the event here (DSH's `SessionEventMap`
 * is merge-extensible) and lets `src/host/frames.ts` rebuild it from a frame.
 *
 * @module @zhangweiii/dsh-tui/contract/stream-events
 */

import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** One incremental assistant stream chunk; process-local, never logged. */
    'assistant/chunk': {
      turn: number
      step: number
      chunk: StreamChunk
    }
  }
}

export {}
