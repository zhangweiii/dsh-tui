/** Host API translation: contract calls onto Remote endpoints and live frames. */

import { describe, expect, it } from 'vitest'
import { FrameQueue, HostApiClient, type HostTransport, type WaterfallInvocation } from '../src/host/client.ts'
import { RpcId } from '../src/contract/runtime.ts'
import { SID } from './fake-api.ts'

/** Carrier stub: scripted unary answers plus caller-driven streams and events. */
class FakeTransport implements HostTransport {
  readonly facts = { home: '/home/u', isLoopback: true }
  readonly calls: { endpoint: string, args: Record<string, unknown> }[] = []
  readonly answers = new Map<string, (args: Record<string, unknown>) => unknown>()
  readonly failures = new Map<string, { code: string, message: string }>()
  private readonly streams = new Map<string, FrameQueue<unknown>>()
  private readonly emits = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private waterfallHandler: ((invocation: WaterfallInvocation) => void) | undefined

  async invoke(endpoint: string, args: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ endpoint, args })
    const failure = this.failures.get(endpoint)
    if (failure !== undefined) throw Object.assign(new Error(failure.message), { code: failure.code })
    const answer = this.answers.get(endpoint)
    if (answer === undefined) throw new Error(`no scripted answer for ${endpoint}`)
    return answer(args)
  }

  open(endpoint: string, _args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    const queue = new FrameQueue<unknown>()
    this.streams.set(endpoint, queue)
    signal.addEventListener('abort', () => { queue.close() }, { once: true })
    return queue.drain()
  }

  /** Push one frame into the stream opened for `endpoint`. */
  emit(endpoint: string, frame: unknown): void {
    this.streams.get(endpoint)?.push(frame)
  }

  closeStream(endpoint: string): void {
    this.streams.get(endpoint)?.close()
  }

  on(event: string, listener: (...args: readonly unknown[]) => void): () => void {
    const listeners = this.emits.get(event) ?? new Set()
    listeners.add(listener)
    this.emits.set(event, listeners)
    return () => { listeners.delete(listener) }
  }

  fire(event: string, ...args: readonly unknown[]): void {
    for (const listener of this.emits.get(event) ?? []) listener(...args)
  }

  onWaterfall(_event: string, listener: (invocation: WaterfallInvocation) => void): () => void {
    this.waterfallHandler = listener
    return () => { this.waterfallHandler = undefined }
  }

  waterfall(invocation: WaterfallInvocation): void {
    this.waterfallHandler?.(invocation)
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

/** Collect one stream's frames until the predicate holds. */
async function collect(
  stream: AsyncIterable<{ payload: unknown }>,
  stop: (frames: unknown[]) => boolean,
): Promise<unknown[]> {
  const frames: unknown[] = []
  for await (const frame of stream) {
    frames.push(frame.payload)
    if (stop(frames)) break
  }
  return frames
}

describe('Host API translation', () => {
  it('posts the contract payload as the endpoint named wire arguments', async () => {
    const transport = new FakeTransport()
    transport.answers.set('session/list', () => ({
      items: [{
        sessionId: SID,
        updatedAt: 7,
        running: true,
        blank: false,
        agentAvailable: true,
        cwd: '/work',
        projections: { kind: 'sequenced', asOfSeq: 3, values: { agentPreset: 'standard' } },
      }],
    }))
    const client = new HostApiClient(transport)
    const response = await client.sessions.list({})
    expect(transport.calls[0]).toEqual({ endpoint: 'session/list', args: { _request: {} } })
    expect(response.result).toEqual({
      ok: true,
      value: {
        items: [{
          sessionId: SID,
          updatedAt: 7,
          running: true,
          blank: false,
          cwd: '/work',
          agentPreset: 'standard',
          projections: { asOfSeq: 3, values: { agentPreset: 'standard' } },
        }],
      },
    })
  })

  it('surfaces a Remote failure as the contract error branch', async () => {
    const transport = new FakeTransport()
    transport.failures.set('session/create', { code: 'session/conflict', message: 'worktree held' })
    const client = new HostApiClient(transport)
    const response = await client.sessions.create({})
    expect(response.result).toEqual({
      ok: false,
      error: { code: 'internal', message: 'worktree held', details: {} },
    })
  })
})


describe('live session subscription', () => {
  /** Start the client's mux subscription and answer its follow snapshot. */
  async function follow(client: HostApiClient, transport: FakeTransport): Promise<unknown[]> {
    const controller = new AbortController()
    const pending = collect(
      client.events.mux({ address: { kind: 'session', sessionId: SID } }, controller.signal),
      frames => frames.length >= 4,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('session/follow', {
      type: 'snapshot',
      cursor: 4,
      hasMore: false,
      records: [{
        event: {
          type: 'tool/call',
          seq: 3,
          time: 3,
          data: { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}' },
        },
      }],
      projections: { asOfSeq: 4, values: { inbox: { 'next-turn': [{ id: 'queued-1' }], 'next-step': [] } } },
    })
    transport.emit('session/follow', {
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 },
    })
    transport.emit('session/follow', {
      type: 'assistant-stream',
      frame: { type: 'chunk', attemptId: 'attempt-1', index: 2, time: 9, chunk: { type: 'text-delta', index: 0, text: '嗨' } },
    })
    transport.emit('session/follow', {
      type: 'event',
      event: { type: 'user/message', seq: 5, time: 5, data: { id: 'user-1' } },
    })
    const frames = await pending
    controller.abort()
    return frames
  }

  it('turns a follow generation into subscribed, projection, queue, chunk and event frames', async () => {
    const transport = new FakeTransport()
    const client = new HostApiClient(transport)
    const frames = await follow(client, transport) as { type: string, [key: string]: unknown }[]
    expect(frames[0]).toEqual({ type: 'session/subscribed', sessionId: SID, lastSeq: 4 })
    expect(frames[1]).toMatchObject({ type: 'session/projection', key: 'inbox', seq: 4 })
    expect(frames[2]).toEqual({
      type: 'session/queue',
      sessionId: SID,
      items: [{ id: 'queued-1', placement: 'queued', message: { id: 'queued-1' } }],
    })
    const chunk = frames.find(frame => frame.type === 'session/chunk') as unknown as {
      event: { type: string, data: { turn: number, step: number } }
    }
    expect(chunk.event.type).toBe('assistant/chunk')
    expect(chunk.event.data).toMatchObject({ turn: 1, step: 1 })
  })

  it('attaches the locally computed render intent to tool calls and results', async () => {
    const transport = new FakeTransport()
    const client = new HostApiClient(transport)
    const controller = new AbortController()
    const pending = collect(
      client.events.mux({ address: { kind: 'session', sessionId: SID } }, controller.signal),
      frames => frames.length >= 3,
    )
    await new Promise(resolve => setTimeout(resolve, 0))
    transport.emit('session/follow', {
      type: 'snapshot',
      cursor: 2,
      hasMore: false,
      records: [],
      projections: { asOfSeq: 2, values: {} },
    })
    // The opening snapshot is the first history page; later records are live frames.
    transport.emit('session/follow', {
      type: 'event',
      event: {
        type: 'tool/call',
        seq: 3,
        time: 3,
        data: { turn: 1, step: 1, callId: 'call-9', name: 'bash', arguments: '{"command":"ls","description":"列出文件"}' },
      },
    })
    transport.emit('session/follow', {
      type: 'event',
      event: {
        type: 'tool/result',
        seq: 4,
        time: 4,
        data: {
          turn: 1,
          step: 1,
          message: {
            id: 'tool-1',
            role: 'tool',
            source: { kind: 'tool', callId: 'call-9' },
            toolCallId: 'call-9',
            content: [{ type: 'text', text: 'file.txt' }],
          },
        },
      },
    })
    const frames = await pending as { type: string, view?: { for: string, view: { card: string } } }[]
    controller.abort()
    const views = frames
      .filter(frame => frame.type === 'session/event')
      .map(frame => frame.view)
    expect(views[0]).toMatchObject({ for: 'call', view: { card: 'terminal' } })
    expect(views[1]).toMatchObject({ for: 'result' })
  })
})
