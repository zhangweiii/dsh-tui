/** Remote Web-Host transport selection and wire behavior. */

import type { ApiProxy, IApiClient, ServerRequest } from '@deepseek-ai/dsh-host-apiproxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_WEB_ORIGIN, InProcessApiClient, RemoteApiClient, selectTuiApi,
} from '../src/remote.ts'

const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function hostDescription(rpcId: string): Response {
  return Response.json({
    type: 'server-response',
    rpcId,
    result: {
      ok: true,
      value: {
        version: 'test', cwd: '/web-cwd', attachedSessions: 0, canOpenPath: false,
      },
    },
  })
}

function apiWithDescribe(result: 'ok' | 'fail'): IApiClient {
  return {
    host: {
      describe: async () => {
        if (result === 'fail') throw new Error('offline')
        return {
          rpcId: 'describe' as never,
          result: {
            ok: true,
            value: { version: 'test', cwd: '/remote', attachedSessions: 0, canOpenPath: false },
          },
        }
      },
    },
  } as unknown as IApiClient
}

describe('remote Web Host client', () => {
  it('forwards same-process calls without loading a second Host client package', async () => {
    const describe = vi.fn(async (request: { rpcId: string; payload: {} }) => ({
      rpcId: request.rpcId,
      result: {
        ok: true as const,
        value: { version: 'test', cwd: '/local', attachedSessions: 0, canOpenPath: false },
      },
    }))
    const api = { host: { describe } } as unknown as ApiProxy

    const response = await new InProcessApiClient(api).host.describe({})

    expect(response.result).toMatchObject({ ok: true, value: { cwd: '/local' } })
    expect(describe).toHaveBeenCalledWith(expect.objectContaining({ payload: {} }), undefined)
  })

  it('routes unary calls to the selected Web origin', async () => {
    const requests: URL[] = []
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init)
      requests.push(new URL(request.url))
      const body = await request.json() as { rpcId: string }
      return hostDescription(body.rpcId)
    })

    const response = await new RemoteApiClient('http://127.0.0.1:4180').host.describe({})

    expect(response.result).toMatchObject({ ok: true, value: { cwd: '/web-cwd' } })
    expect(requests.map(request => request.href)).toEqual(['http://127.0.0.1:4180/api/host.describe'])
  })

  it('requires HTTPS for non-loopback Web Hosts', () => {
    expect(() => new RemoteApiClient('http://example.com')).toThrow('非本机 Web Host 必须使用 HTTPS')
    expect(() => new RemoteApiClient('http://127.example.com')).toThrow('非本机 Web Host 必须使用 HTTPS')
    expect(() => new RemoteApiClient('http://192.168.1.20:3080')).toThrow('非本机 Web Host 必须使用 HTTPS')
    expect(() => new RemoteApiClient('https://example.com')).not.toThrow()
    expect(() => new RemoteApiClient('http://localhost:3080')).not.toThrow()
    expect(() => new RemoteApiClient('http://[::1]:3080')).not.toThrow()
  })

  it('receives live mux frames over the same Web Host WebSocket', async () => {
    class Socket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static latest: Socket | undefined
      readonly url: string
      readyState = Socket.CONNECTING
      private readonly listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>()

      constructor(url: string | URL) {
        Socket.latest = this
        this.url = String(url)
        queueMicrotask(() => {
          this.readyState = Socket.OPEN
          this.emit('open', new Event('open'))
        })
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener as (event: Event | MessageEvent) => void)
        this.listeners.set(type, listeners)
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener as (event: Event | MessageEvent) => void)
      }

      close(): void {
        this.readyState = 3
        this.emit('close', new Event('close'))
      }

      push(message: ServerRequest): void {
        this.emit('message', new MessageEvent('message', { data: JSON.stringify(message) }))
      }

      private emit(type: string, event: Event | MessageEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event)
      }
    }
    globalThis.WebSocket = Socket as never
    const client = new RemoteApiClient('http://127.0.0.1:4180')
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const next = stream.next()
    await vi.waitFor(() => { expect(Socket.latest?.url).toBe('ws://127.0.0.1:4180/api/events.mux') })
    Socket.latest?.push({
      type: 'server-request', rpcId: 'live-1' as never, method: 'session/subscribed',
      payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
    })
    expect(await next).toEqual({
      done: false,
      value: {
        rpcId: 'live-1',
        payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
      },
    })
    abort.abort()
  })

  it('reconnects a dropped WebSocket and continues yielding frames', async () => {
    class Socket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: Socket[] = []
      readonly url: string
      readyState = Socket.CONNECTING
      private readonly listeners = new Map<string, Set<(event: Event | MessageEvent) => void>>()

      constructor(url: string | URL) {
        Socket.instances.push(this)
        this.url = String(url)
        queueMicrotask(() => {
          this.readyState = Socket.OPEN
          this.emit('open', new Event('open'))
        })
      }

      addEventListener(type: string, listener: EventListener): void {
        const listeners = this.listeners.get(type) ?? new Set()
        listeners.add(listener as (event: Event | MessageEvent) => void)
        this.listeners.set(type, listeners)
      }

      removeEventListener(type: string, listener: EventListener): void {
        this.listeners.get(type)?.delete(listener as (event: Event | MessageEvent) => void)
      }

      close(): void {
        if (this.readyState === 3) return
        this.readyState = 3
        this.emit('close', new Event('close'))
      }

      push(rpcId: string): void {
        const message: ServerRequest = {
          type: 'server-request', rpcId: rpcId as never, method: 'session/subscribed',
          payload: { type: 'session/subscribed', sessionId: 'session-1', lastSeq: 4 },
        }
        this.emit('message', new MessageEvent('message', { data: JSON.stringify(message) }))
      }

      private emit(type: string, event: Event | MessageEvent): void {
        for (const listener of this.listeners.get(type) ?? []) listener(event)
      }
    }
    globalThis.WebSocket = Socket as never
    const client = new RemoteApiClient('http://127.0.0.1:4180')
    const abort = new AbortController()
    const onOpen = vi.fn()
    const stream = client.events.mux({}, abort.signal, onOpen)[Symbol.asyncIterator]()

    const first = stream.next()
    await vi.waitFor(() => { expect(Socket.instances).toHaveLength(1) })
    Socket.instances[0]?.push('live-1')
    expect((await first).value?.rpcId).toBe('live-1')

    const second = stream.next()
    Socket.instances[0]?.close()
    await vi.waitFor(() => { expect(Socket.instances).toHaveLength(2) })
    Socket.instances[1]?.push('live-2')
    expect((await second).value?.rpcId).toBe('live-2')
    expect(onOpen).toHaveBeenCalledTimes(2)

    abort.abort()
  })

  it('times out a WebSocket handshake that never completes and reconnects', async () => {
    vi.useFakeTimers()
    // A socket that never fires `open`: without a connect timeout the event
    // stream would hang forever waiting for onOpen.
    class StalledSocket {
      static readonly CONNECTING = 0
      static readonly OPEN = 1
      static readonly instances: StalledSocket[] = []
      readonly url: string
      readyState = StalledSocket.CONNECTING
      constructor(url: string | URL) {
        StalledSocket.instances.push(this)
        this.url = String(url)
      }
      addEventListener(): void {}
      removeEventListener(): void {}
      close(): void { this.readyState = 3 }
    }
    globalThis.WebSocket = StalledSocket as never
    const client = new RemoteApiClient('http://127.0.0.1:4180')
    const abort = new AbortController()
    const stream = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    void stream.next()
    await vi.waitFor(() => { expect(StalledSocket.instances).toHaveLength(1) })

    // Advancing past the 10s handshake timeout plus the first ~200ms backoff
    // must surface a retry (a second socket) instead of hanging forever.
    await vi.advanceTimersByTimeAsync(10_000 + 200)
    expect(StalledSocket.instances).toHaveLength(2)

    abort.abort()
    vi.useRealTimers()
  })
})

describe('TUI Host selection', () => {
  const local = apiWithDescribe('ok')

  it('auto-connects to the default Web Host when it is reachable', async () => {
    const remote = apiWithDescribe('ok')
    const factory = vi.fn(() => remote)
    const selected = await selectTuiApi({ continueLatest: false }, local, factory)
    expect(factory).toHaveBeenCalledWith(DEFAULT_WEB_ORIGIN)
    expect(selected).toEqual({ api: remote, remote: true })
  })

  it('falls back locally only for implicit discovery', async () => {
    const factory = vi.fn(() => apiWithDescribe('fail'))
    expect(await selectTuiApi({ continueLatest: false }, local, factory)).toEqual({ api: local, remote: false })
    await expect(selectTuiApi({ continueLatest: false, connect: 'http://127.0.0.1:4180' }, local, factory))
      .rejects.toThrow('无法连接 Web Host')
  })

  it('keeps standalone mode local without probing Web', async () => {
    const factory = vi.fn(() => apiWithDescribe('ok'))
    expect(await selectTuiApi({ continueLatest: false, standalone: true }, local, factory))
      .toEqual({ api: local, remote: false })
    expect(factory).not.toHaveBeenCalled()
  })
})
