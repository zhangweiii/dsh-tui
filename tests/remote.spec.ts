/** Web Host carrier: origin policy, selection, unary envelopes, and live frames. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FakeSocket as FakeSocketType } from './fake-ws.ts'
import { HostApiClient, type HostTransport } from '../src/host/client.ts'
import { RemoteTransport, loopbackHostname, webOrigin } from '../src/host/remote.ts'
import { selectTuiApi } from '../src/host/selection.ts'
import { SID } from './fake-api.ts'

vi.mock('ws', async () => {
  const { FakeSocket } = await import('./fake-ws.ts')
  return { default: FakeSocket }
})

const { FakeSocket } = await import('./fake-ws.ts')

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
})

async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** In-tree client used as the standalone fallback in selection tests. */
function localClient(): HostApiClient {
  const transport: HostTransport = {
    facts: { home: '/home/u', isLoopback: true },
    invoke: () => Promise.resolve({}),
    open: () => (async function* () { /* no frames */ })(),
    on: () => () => {},
    onWaterfall: () => () => {},
    close: () => Promise.resolve(),
  }
  return new HostApiClient(transport)
}


describe('Web Host origin policy', () => {
  it('recognizes loopback names and refuses insecure or credentialed origins', () => {
    expect(loopbackHostname('localhost')).toBe(true)
    expect(loopbackHostname('tui.localhost')).toBe(true)
    expect(loopbackHostname('[::1]')).toBe(true)
    expect(loopbackHostname('127.0.0.1')).toBe(true)
    expect(loopbackHostname('example.com')).toBe(false)
    expect(() => webOrigin('http://example.com')).toThrow('非本机 Web Host 必须使用 HTTPS')
    expect(() => webOrigin('http://127.example.com')).toThrow('非本机 Web Host 必须使用 HTTPS')
    expect(() => webOrigin('http://user:pass@127.0.0.1:3080')).toThrow('无凭据')
    expect(() => webOrigin('ftp://127.0.0.1:3080')).toThrow('http(s) origin')
    expect(webOrigin('https://harness.internal')).toEqual({ origin: 'https://harness.internal' })
    expect(webOrigin('http://127.0.0.1:4180/?token=abc')).toEqual({ origin: 'http://127.0.0.1:4180', token: 'abc' })
  })
})

describe('TUI Host carrier selection', () => {
  it('forces the in-tree Host in standalone mode', async () => {
    const local = localClient()
    const selected = await selectTuiApi({ continueLatest: false, standalone: true }, local)
    expect(selected.remote).toBe(false)
    expect(selected.api).toBe(local)
  })

  it('falls back to the in-tree Host when default discovery finds no Web Host', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    const selected = await selectTuiApi({ continueLatest: false }, localClient())
    expect(selected.remote).toBe(false)
  })

  it('stops startup when an explicit Web Host target fails', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch
    await expect(selectTuiApi(
      { continueLatest: false, connect: 'http://127.0.0.1:4180' },
      localClient(),
    )).rejects.toThrow('无法连接 Web Host http://127.0.0.1:4180')
  })

  it('selects the Web Host when it answers the description call', async () => {
    const calls: string[] = []
    globalThis.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      calls.push(String(input))
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Promise.resolve(Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [] } },
      }))
    }) as unknown as typeof fetch
    const selected = await selectTuiApi({ continueLatest: false }, localClient())
    expect(selected.remote).toBe(true)
    expect(calls.some(url => url.includes('/api/'))).toBe(true)
  })
})


describe('Web Host carrier wire behavior', () => {
  it('exchanges the launch token for the cookie and posts the contract envelope', async () => {
    const requests: { url: string, init: RequestInit }[] = []
    globalThis.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init: init ?? {} })
      if (requests.length === 1) {
        return Promise.resolve(new Response('', {
          status: 303,
          headers: { 'set-cookie': 'dsh-auth-127.0.0.1=secret; Path=/; HttpOnly' },
        }))
      }
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Promise.resolve(Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: true, value: { items: [] } },
      }))
    }) as unknown as typeof fetch
    const transport = new RemoteTransport('http://127.0.0.1:4180/?token=launch-token')
    const value = await transport.invoke('session/list', { _request: {} })
    expect(value).toEqual({ items: [] })
    expect(requests[0]?.url).toContain('token=launch-token')
    expect(requests[1]?.url).toBe('http://127.0.0.1:4180/api/session/list')
    expect((requests[1]?.init.headers as Record<string, string>).cookie).toBe('dsh-auth-127.0.0.1=secret')
    const envelope = JSON.parse(String(requests[1]?.init.body)) as { method: string, payload: unknown }
    expect(envelope.method).toBe('session/list')
    expect(envelope.payload).toEqual({ args: { _request: {} } })
  })

  it('reports a refused Host with an actionable connect hint', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('unauthorized', { status: 401 }))) as unknown as typeof fetch
    const transport = new RemoteTransport('http://127.0.0.1:4180')
    await expect(transport.invoke('session/list', {})).rejects.toThrow('--connect http://127.0.0.1:4180/?token=')
  })

  it('surfaces a Remote failure branch with its code and message', async () => {
    globalThis.fetch = vi.fn((_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { rpcId: string }
      return Promise.resolve(Response.json({
        type: 'server-response',
        rpcId: body.rpcId,
        result: { ok: false, error: { code: 'session/not-found', message: 'no such session', details: {} } },
      }))
    }) as unknown as typeof fetch
    const transport = new RemoteTransport('http://127.0.0.1:4180')
    await expect(transport.invoke('session/list', {})).rejects.toMatchObject({
      code: 'session/not-found',
      message: 'no such session',
    })
  })
})

describe('Gateway mux and forwarded events', () => {
  it('carries the negotiated browser cookie on the mux handshake', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(new Response('', {
      status: 303,
      headers: { 'set-cookie': 'dsh-auth-127.0.0.1:4180=cookie-value; Path=/; HttpOnly' },
    }))) as unknown as typeof fetch
    const transport = new RemoteTransport('http://127.0.0.1:4180/?token=launch')
    const controller = new AbortController()
    const reader = (async () => {
      for await (const _frame of transport.open('session/control', {}, controller.signal)) { /* drain */ }
    })()
    await settle()
    const socket = FakeSocket.instances.at(-1) as FakeSocketType
    expect(socket.url).toBe('ws://127.0.0.1:4180/api/remote.mux')
    expect(socket.options?.headers?.cookie).toBe('dsh-auth-127.0.0.1:4180=cookie-value')
    controller.abort()
    await reader
  })

  it('opens logical streams over the WebSocket mux and decodes their values', async () => {
    const transport = new RemoteTransport('http://127.0.0.1:4180')
    const controller = new AbortController()
    const frames: unknown[] = []
    const reader = (async () => {
      for await (const value of transport.open('session/control', {}, controller.signal)) frames.push(value)
    })()
    await settle()
    const socket = FakeSocket.instances.at(-1) as FakeSocketType
    const opened = socket.last()
    expect(opened).toMatchObject({ type: 'open', endpoint: 'session/control', payload: { args: {} } })
    const streamId = opened['streamId'] as string
    socket.receive({ type: 'item', streamId, value: { type: 'baseline', value: { projections: {} } } })
    socket.receive({ type: 'end', streamId })
    await reader
    expect(frames).toEqual([{ type: 'baseline', value: { projections: {} } }])
  })

  it('dispatches emits and answers waterfalls through $events/result', async () => {
    const posts: { url: string, body: Record<string, unknown> }[] = []
    globalThis.fetch = vi.fn((input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      posts.push({ url: String(input), body })
      return Promise.resolve(Response.json({ type: 'server-response', rpcId: body['rpcId'], result: { ok: true, value: {} } }))
    }) as unknown as typeof fetch
    const transport = new RemoteTransport('http://127.0.0.1:4180')
    const emitted: unknown[][] = []
    transport.on('api-session/status', (...args) => { emitted.push([...args]) })
    const answered: string[] = []
    transport.onWaterfall('approval/request', (invocation) => {
      answered.push(invocation.sessionId ?? '')
      void invocation.settle({ kind: 'result', value: 'allowed-once' })
    })
    await settle()
    const socket = FakeSocket.instances.at(-1) as FakeSocketType
    const streamId = socket.last()['streamId'] as string
    socket.receive({ type: 'item', streamId, value: { type: 'ready', clientId: 'client-1', host: { home: '/home/u' } } })
    socket.receive({ type: 'item', streamId, value: { type: 'emit', event: 'api-session/status', args: [SID, true] } })
    socket.receive({
      type: 'item',
      streamId,
      value: { type: 'waterfall', event: 'approval/request', eventId: 'event-9', agentId: SID, request: { toolName: 'bash' } },
    })
    await settle()
    expect(emitted).toEqual([[SID, true]])
    expect(answered).toEqual([SID])
    expect(posts.at(-1)?.url).toBe('http://127.0.0.1:4180/api/$events/result')
    expect(posts.at(-1)?.body).toMatchObject({
      method: '$events/result',
      payload: {
        args: {
          clientId: 'client-1',
          eventId: 'event-9',
          outcome: { kind: 'result', value: 'allowed-once' },
        },
      },
    })
    expect(transport.facts.home).toBe('/home/u')
  })
})

