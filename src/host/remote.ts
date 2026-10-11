/**
 * Web Host carrier: unary calls travel as `POST /api/<endpoint>` on the shared
 * Connection channel, every logical stream shares the Gateway WebSocket mux,
 * and forwarded host events plus scoped waterfalls arrive on the Gateway's
 * `$events` stream and are answered through `$events/result`.
 *
 * The Host fences `/api` behind a launch token: the terminal exchanges the
 * token carried by `--connect` for the host's browser cookie and reuses it for
 * both transports.
 *
 * @module @zhangweiii/dsh-tui/host/remote
 */

import { randomUUID } from 'node:crypto'
import { RpcId } from '../contract/runtime.ts'
import { FrameQueue, type HostTransport, type WaterfallInvocation } from './client.ts'

/** Default loopback origin used by the shipped Web profile. */
export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:3080'

const AUTO_CONNECT_TIMEOUT_MS = 500
const EXPLICIT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30_000
const RECONNECT_INITIAL_DELAY_MS = 100
const RECONNECT_MAX_DELAY_MS = 2_000

/** Gateway-owned stream carrying forwarded events and scoped waterfalls. */
const EVENT_STREAM_ENDPOINT = '$events'
/** Gateway-owned unary endpoint answering one delivered waterfall. */
const EVENT_RESULT_ENDPOINT = '$events/result'
/** Exact WebSocket route carrying every Typert Remote stream. */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'

/**
 * Whether one hostname is loopback. Plain HTTP is limited to these names so a
 * deployment is never reached with unencrypted credentials by accident.
 * @param hostname - URL hostname.
 * @returns whether the name is loopback.
 */
export function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
}

/**
 * Normalize and validate one Web Host origin, keeping any launch token.
 * @param value - user-supplied origin, optionally carrying `?token=`.
 * @returns the origin and its launch token.
 */
export function webOrigin(value: string): { origin: string, token?: string } {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`无效的 Web Host 地址：${value}`)
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:')
    || url.username !== '' || url.password !== '') {
    throw new Error(`Web Host 地址必须是无凭据的 http(s) origin：${value}`)
  }
  if (url.protocol === 'http:' && !loopbackHostname(url.hostname)) {
    throw new Error(`非本机 Web Host 必须使用 HTTPS：${value}`)
  }
  const token = url.searchParams.get('token')
  return { origin: url.origin, ...(token === null || token === '' ? {} : { token }) }
}

function mintRpcId(): RpcId {
  return RpcId(randomUUID())
}

function reconnectDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, milliseconds)
    signal.addEventListener('abort', finish, { once: true })
  })
}

/** One logical stream's frame queue plus the parameters needed to reopen it. */
interface LogicalStream {
  endpoint: string
  args: Record<string, unknown>
  queue: FrameQueue<unknown>
}

/**
 * Gateway WebSocket mux client: every logical stream is reopened after a
 * transport failure and keeps feeding the same queue, so a consumer sees one
 * uninterrupted stream across reconnections.
 */
class MuxSocket {
  private socket: WebSocket | undefined
  private connecting: Promise<void> | undefined
  private readonly streams = new Map<string, LogicalStream>()
  private closed = false
  private attempt = 0

  constructor(private readonly url: string, private readonly cookie: string | undefined) {}

  private async connect(): Promise<void> {
    if (this.closed) throw new Error('Web Host 连接已关闭')
    if (this.socket?.readyState === WebSocket.OPEN) return
    if (this.connecting !== undefined) return await this.connecting
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(this.url)
      const timer = setTimeout(() => { socket.close() }, DEFAULT_TIMEOUT_MS)
      socket.addEventListener('open', () => {
        clearTimeout(timer)
        this.socket = socket
        this.attempt = 0
        resolve()
        for (const [streamId, stream] of this.streams) this.openOn(socket, streamId, stream)
      }, { once: true })
      socket.addEventListener('error', () => {
        clearTimeout(timer)
        reject(new Error(`无法连接 Web Host：${this.url}`))
      }, { once: true })
      socket.addEventListener('message', (event) => { this.handleMessage(event.data) })
      socket.addEventListener('close', () => {
        clearTimeout(timer)
        if (this.socket === socket) this.socket = undefined
        if (!this.closed) this.scheduleReconnect()
      })
    }).finally(() => { this.connecting = undefined })
    return await this.connecting
  }

  private scheduleReconnect(): void {
    const delay = Math.min(RECONNECT_INITIAL_DELAY_MS * 2 ** this.attempt, RECONNECT_MAX_DELAY_MS)
    this.attempt += 1
    setTimeout(() => {
      if (this.closed) return
      void this.connect().catch(() => { this.scheduleReconnect() })
    }, delay)
  }

  private openOn(socket: WebSocket, streamId: string, stream: LogicalStream): void {
    socket.send(JSON.stringify({
      type: 'open',
      streamId,
      endpoint: stream.endpoint,
      payload: { args: stream.args },
    }))
  }

  private send(message: unknown): void {
    const socket = this.socket
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify(message))
  }

  private handleMessage(data: unknown): void {
    let frame: Record<string, unknown>
    try {
      frame = JSON.parse(typeof data === 'string' ? data : String(data)) as Record<string, unknown>
    } catch {
      return
    }
    const streamId = frame['streamId']
    if (typeof streamId !== 'string') return
    const stream = this.streams.get(streamId)
    if (stream === undefined) return
    switch (frame['type']) {
      case 'item':
        stream.queue.push(frame['value'])
        break
      case 'error': {
        const failure = frame['error'] as { code?: string, message?: string } | undefined
        stream.queue.fail(Object.assign(
          new Error(failure?.message ?? 'Remote stream failed'),
          { code: failure?.code ?? 'internal' },
        ))
        break
      }
      case 'end':
        stream.queue.close()
        break
      default:
        break
    }
  }

  /**
   * Open one logical stream generation and yield its values until the caller
   * cancels; the generation survives transport reconnections.
   * @param endpoint - Remote endpoint or Gateway-owned stream name.
   * @param args - named wire arguments of that endpoint.
   * @param signal - caller cancellation.
   * @returns an asynchronous iterable of decoded values.
   */
  async *open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncGenerator<unknown> {
    const streamId = randomUUID()
    const stream: LogicalStream = { endpoint, args, queue: new FrameQueue<unknown>() }
    this.streams.set(streamId, stream)
    const cancel = (): void => {
      this.send({ type: 'cancel', streamId })
      stream.queue.close()
    }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      await this.connect()
      this.send({ type: 'open', streamId, endpoint, payload: { args } })
      yield* stream.queue.drain()
    } finally {
      signal.removeEventListener('abort', cancel)
      this.streams.delete(streamId)
      this.send({ type: 'cancel', streamId })
    }
  }

  close(): void {
    this.closed = true
    for (const stream of this.streams.values()) stream.queue.close()
    this.streams.clear()
    this.socket?.close()
    this.socket = undefined
  }
}


/** One delivered forwarded event frame. */
type ForwardedFrame = {
  type?: string
  clientId?: string
  host?: { home?: string }
  event?: string
  args?: readonly unknown[]
  eventId?: string
  agentId?: string
  request?: Record<string, unknown>
}

/**
 * Web Host carrier: unary calls over the shared `/api` Connection channel, every
 * logical stream over the Gateway WebSocket mux, and forwarded events plus
 * scoped waterfalls over the Gateway's own `$events` stream.
 */
export class RemoteTransport implements HostTransport {
  readonly facts: { home: string | undefined, isLoopback: boolean }
  private readonly origin: string
  private readonly mux: MuxSocket
  private token: string | undefined
  private cookie: string | undefined
  private authenticated: Promise<void> | undefined
  private eventsStarted = false
  private readonly emitListeners = new Map<string, Set<(...args: readonly unknown[]) => void>>()
  private readonly waterfallListeners = new Map<string, (invocation: WaterfallInvocation) => void>()
  private eventClientId: string | undefined
  private markReady: (() => void) | undefined
  private readonly ready = new Promise<void>((resolve) => { this.markReady = resolve })

  constructor(origin: string) {
    const parsed = webOrigin(origin)
    this.origin = parsed.origin
    this.facts = { home: undefined, isLoopback: loopbackHostname(new URL(parsed.origin).hostname) }
    this.mux = new MuxSocket(new URL(REMOTE_STREAM_MUX_PATH, parsed.origin).href.replace(/^http/u, 'ws'), undefined)
    this.token = parsed.token
  }

  /**
   * Exchange the launch token carried by `--connect` for the Host's browser
   * cookie. A Host without a token answers anonymously; a Host that refuses the
   * exchange reports what the terminal must pass instead.
   */
  private async authenticate(): Promise<void> {
    if (this.cookie !== undefined || this.token === undefined) return
    if (this.authenticated !== undefined) return await this.authenticated
    this.authenticated = (async () => {
      const url = new URL('/', this.origin)
      url.searchParams.set('token', this.token ?? '')
      const response = await fetch(url, { redirect: 'manual' })
      const raw = response.headers.getSetCookie?.()[0]
      const pair = raw?.split(';')[0] ?? ''
      if (pair.indexOf('=') > 0) this.cookie = pair
    })().finally(() => { this.authenticated = undefined })
    return await this.authenticated
  }

  /** POST one JSON envelope, mapped to an error carrying its Remote code. */
  private async post(endpoint: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    await this.authenticate()
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.cookie !== undefined) headers.cookie = this.cookie
    const response = await fetch(new URL(`/api/${endpoint}`, this.origin), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    })
    if (response.status === 401 || response.status === 403) {
      throw Object.assign(new Error(
        `Web Host 拒绝了本终端请求（HTTP ${String(response.status)}）；请使用 --connect ${this.origin}/?token=<启动令牌>`,
      ), { code: 'unauthorized' })
    }
    if (!response.ok) {
      throw Object.assign(new Error(`Web Host 请求失败：HTTP ${String(response.status)}`), { code: 'transport' })
    }
    return response
  }

  async invoke(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const rpcId = mintRpcId()
    const response = await this.post(endpoint, { type: 'client-request', rpcId, method: endpoint, payload: { args } }, signal)
    const envelope = await response.json() as { type?: unknown, rpcId?: unknown, result?: unknown }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId) {
      throw new Error(`${endpoint}: invalid server-response envelope`)
    }
    const result = envelope.result as { ok?: unknown, value?: unknown, error?: { code?: string, message?: string } }
    if (result.ok === true) return result.value
    throw Object.assign(new Error(result.error?.message ?? `${endpoint} failed`), { code: result.error?.code })
  }

  open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    return this.mux.open(endpoint, args, signal)
  }

  on(event: string, listener: (...args: readonly unknown[]) => void): () => void {
    this.startEvents()
    const listeners = this.emitListeners.get(event) ?? new Set()
    listeners.add(listener)
    this.emitListeners.set(event, listeners)
    return () => { listeners.delete(listener) }
  }

  onWaterfall(event: string, listener: (invocation: WaterfallInvocation) => void): () => void {
    this.startEvents()
    this.waterfallListeners.set(event, listener)
    return () => { this.waterfallListeners.delete(event) }
  }
  private startEvents(): void {
    if (this.eventsStarted) return
    this.eventsStarted = true
    const controller = new AbortController()
    void (async () => {
      for await (const value of this.mux.open(EVENT_STREAM_ENDPOINT, {}, controller.signal)) {
        this.handleForwarded(value as ForwardedFrame)
      }
    })().catch(() => { /* the mux reports stream failures to its own consumers */ })
  }

  /** Dispatch one forwarded-event frame to its local listener. */
  private handleForwarded(frame: ForwardedFrame): void {
    if (frame.type === 'ready') {
      this.eventClientId = frame.clientId
      if (frame.host?.home !== undefined) Object.assign(this.facts, { home: frame.host.home })
      this.markReady?.()
      this.markReady = undefined
      return
    }
    if (frame.type === 'emit' && typeof frame.event === 'string') {
      for (const listener of this.emitListeners.get(frame.event) ?? []) listener(...(frame.args ?? []))
      return
    }
    if (frame.type !== 'waterfall' || typeof frame.event !== 'string') return
    const handler = this.waterfallListeners.get(frame.event)
    const clientId = this.eventClientId
    const eventId = frame.eventId
    if (handler === undefined || clientId === undefined || eventId === undefined) return
    handler({
      rpcId: RpcId(eventId),
      event: frame.event,
      request: frame.request ?? {},
      sessionId: frame.agentId,
      settle: async (outcome) => {
        const body = outcome.kind === 'result'
          ? { clientId, eventId, outcome: { kind: 'result' as const, value: outcome.value } }
          : {
            clientId,
            eventId,
            outcome: {
              kind: 'rejected' as const,
              error: { name: outcome.error.name, message: outcome.error.message },
            },
          }
        await this.invoke(EVENT_RESULT_ENDPOINT, body)
      },
    })
  }

  /** Resolve once the forwarded-event generation reported readiness. */
  async waitForEvents(): Promise<void> {
    this.startEvents()
    await this.ready
  }

  async close(): Promise<void> {
    this.mux.close()
    this.emitListeners.clear()
    this.waterfallListeners.clear()
  }
}


