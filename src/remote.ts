/** HTTP/WebSocket and same-process clients for the DSH Host API. */

import type {
  ApiProxy, ClientResponse, HostFrame, IApiClient, MuxFrame, RpcId, RpcReceipt,
  RpcRequest, RpcResponse, ServerRequest,
} from '@deepseek-ai/dsh-host-apiproxy'
import type {
  RequestPayload, ResponseValue, RpcMethodMap,
} from '@deepseek-ai/dsh-host-apiproxy/api/rpc-map'
import type { TuiStartupValues } from './startup.ts'

/** Default loopback origin used by the shipped Web profile. */
export const DEFAULT_WEB_ORIGIN = 'http://127.0.0.1:3080'

const MUX_EVENTS_PATH = '/api/events.mux'
const HOST_EVENTS_PATH = '/api/events.host'
const AUTO_CONNECT_TIMEOUT_MS = 500
const EXPLICIT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_TIMEOUT_MS = 30_000
const WS_CONNECT_TIMEOUT_MS = 10_000
const RECONNECT_INITIAL_DELAY_MS = 100
const RECONNECT_MAX_DELAY_MS = 2_000

type SocketItem<F> =
  | { kind: 'frame'; envelope: RpcRequest<F> }
  | { kind: 'end' }
  | { kind: 'error'; error: Error }

function mintRpcId(): RpcId {
  return crypto.randomUUID() as RpcId
}

function loopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === 'localhost'
    || normalized.endsWith('.localhost')
    || normalized === '[::1]'
    || /^127(?:\.\d{1,3}){3}$/u.test(normalized)
}

function webOrigin(value: string): string {
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
  return url.origin
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

function serverRequest(value: unknown): ServerRequest {
  if (typeof value !== 'object' || value === null) throw new Error('frame is not an object')
  const request = value as Partial<ServerRequest>
  if (request.type !== 'server-request' || typeof request.rpcId !== 'string'
    || typeof request.method !== 'string' || !('payload' in request)) {
    throw new Error('frame is not a server-request envelope')
  }
  return request as ServerRequest
}

/** Shared payload-direct method table without importing DSH runtime code. */
abstract class ApiClientBase implements IApiClient {
  protected abstract callRaw(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  protected abstract respondRaw(message: ClientResponse, signal?: AbortSignal): Promise<unknown>
  protected abstract openMux(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>>
  protected abstract openHost(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>>

  private call<K extends keyof RpcMethodMap>(
    method: K,
    payload: RequestPayload<K>,
    signal?: AbortSignal,
  ): Promise<RpcResponse<ResponseValue<K>>> {
    return this.callRaw(method, payload, signal) as Promise<RpcResponse<ResponseValue<K>>>
  }

  readonly sessions: IApiClient['sessions'] = {
    list: (payload, signal) => this.call('session.list', payload, signal),
    search: (payload, signal) => this.call('session.search', payload, signal),
    create: (payload, signal) => this.call('session.create', payload, signal),
    history: (payload, signal) => this.call('session.history', payload, signal),
    models: (payload, signal) => this.call('session.models', payload, signal),
    selectModel: (payload, signal) => this.call('session.selectModel', payload, signal),
    rename: (payload, signal) => this.call('session.rename', payload, signal),
    fork: (payload, signal) => this.call('session.fork', payload, signal),
    prompt: (payload, signal) => this.call('session.prompt', payload, signal),
    attachment: (payload, signal) => this.call('session.attachment', payload, signal),
    updateQueue: (payload, signal) => this.call('session.updateQueue', payload, signal),
    cancel: (payload, signal) => this.call('session.cancel', payload, signal),
  }

  readonly subagents: IApiClient['subagents'] = {
    list: (payload, signal) => this.call('subagent.list', payload, signal),
    history: (payload, signal) => this.call('subagent.history', payload, signal),
    prompt: (payload, signal) => this.call('subagent.prompt', payload, signal),
    interrupt: (payload, signal) => this.call('subagent.interrupt', payload, signal),
  }

  readonly host: IApiClient['host'] = {
    describe: (payload, signal) => this.call('host.describe', payload, signal),
    pickDirectory: (payload, signal) => this.call('host.pickDirectory', payload, signal),
    listDirectory: (payload, signal) => this.call('host.listDirectory', payload, signal),
    createDirectory: (payload, signal) => this.call('host.createDirectory', payload, signal),
    openPath: (payload, signal) => this.call('host.openPath', payload, signal),
  }

  readonly workspace: IApiClient['workspace'] = {
    list: (payload, signal) => this.call('workspace.list', payload, signal),
    create: (payload, signal) => this.call('workspace.create', payload, signal),
    rename: (payload, signal) => this.call('workspace.rename', payload, signal),
    delete: (payload, signal) => this.call('workspace.delete', payload, signal),
    insertBefore: (payload, signal) => this.call('workspace.insertBefore', payload, signal),
    insertSessionBefore: (payload, signal) => this.call('workspace.insertSessionBefore', payload, signal),
    archiveSession: (payload, signal) => this.call('workspace.archiveSession', payload, signal),
  }

  readonly skills: IApiClient['skills'] = {
    list: (payload, signal) => this.call('skill.list', payload, signal),
  }

  readonly agentPresets: IApiClient['agentPresets'] = {
    list: (payload, signal) => this.call('agentPreset.list', payload, signal),
    select: (payload, signal) => this.call('agentPreset.select', payload, signal),
    read: (payload, signal) => this.call('agentPreset.read', payload, signal),
    copy: (payload, signal) => this.call('agentPreset.copy', payload, signal),
    openDocument: (payload, signal) => this.call('agentPreset.openDocument', payload, signal),
    remove: (payload, signal) => this.call('agentPreset.remove', payload, signal),
  }

  readonly goals: IApiClient['goals'] = {
    create: (payload, signal) => this.call('goal.create', payload, signal),
    edit: (payload, signal) => this.call('goal.edit', payload, signal),
    pause: (payload, signal) => this.call('goal.pause', payload, signal),
    resume: (payload, signal) => this.call('goal.resume', payload, signal),
    complete: (payload, signal) => this.call('goal.complete', payload, signal),
    clear: (payload, signal) => this.call('goal.clear', payload, signal),
  }

  readonly settings: IApiClient['settings'] = {
    describe: (payload, signal) => this.call('settings.describe', payload, signal),
    openDocument: (payload, signal) => this.call('settings.openDocument', payload, signal),
    update: (payload, signal) => this.call('settings.update', payload, signal),
    replace: (payload, signal) => this.call('settings.replace', payload, signal),
    mutate: (payload, signal) => this.call('settings.mutate', payload, signal),
  }

  readonly credentials: IApiClient['credentials'] = {
    describe: (payload, signal) => this.call('credentials.describe', payload, signal),
    set: (payload, signal) => this.call('credentials.set', payload, signal),
    unset: (payload, signal) => this.call('credentials.unset', payload, signal),
  }

  readonly llm: IApiClient['llm'] = {
    providers: (payload, signal) => this.call('llm.providers', payload, signal),
    models: (payload, signal) => this.call('llm.models', payload, signal),
    discoverModels: (payload, signal) => this.call('llm.discoverModels', payload, signal),
  }

  readonly events: IApiClient['events'] = {
    mux: (payload, signal, onOpen) => this.openMux(payload, signal, onOpen),
    host: (payload, signal, onOpen) => this.openHost(payload, signal, onOpen),
  }

  async respond(message: ClientResponse, signal?: AbortSignal): Promise<RpcReceipt> {
    return this.respondRaw(message, signal) as Promise<RpcReceipt>
  }
}

const DIRECT_DOMAIN: Readonly<Record<string, string>> = {
  session: 'sessions',
  subagent: 'subagents',
  host: 'host',
  workspace: 'workspace',
  skill: 'skills',
  agentPreset: 'agentPresets',
  goal: 'goals',
  settings: 'settings',
  credentials: 'credentials',
  llm: 'llm',
}

type DirectUnary = (
  request: { rpcId: RpcId; payload: unknown },
  signal?: AbortSignal,
) => Promise<unknown>

/** Same-process adapter over the Host service already mounted by dsh-base. */
export class InProcessApiClient extends ApiClientBase {
  constructor(private readonly api: ApiProxy) {
    super()
  }

  protected callRaw(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const separator = method.indexOf('.')
    const domainName = DIRECT_DOMAIN[method.slice(0, separator)]
    const operation = method.slice(separator + 1)
    if (domainName === undefined || operation === '') throw new Error(`unknown Host API method: ${method}`)
    const domain = (this.api as unknown as Record<string, Record<string, DirectUnary>>)[domainName]
    const call = domain?.[operation]
    if (call === undefined) throw new Error(`Host API method unavailable: ${method}`)
    return call.call(domain, { rpcId: mintRpcId(), payload }, signal)
  }

  protected respondRaw(message: ClientResponse): Promise<unknown> {
    return this.api.respond(message)
  }

  protected openMux(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.openDirectMux(payload, signal, onOpen)
  }

  protected openHost(payload: {}, signal: AbortSignal, onOpen?: () => void): AsyncIterable<RpcRequest<HostFrame>> {
    return this.openDirectHost(payload, signal, onOpen)
  }

  private async *openDirectMux(
    payload: {}, signal: AbortSignal, onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<MuxFrame>> {
    const stream = this.api.events.mux({ rpcId: mintRpcId(), payload }, signal)
    onOpen?.()
    yield* stream
  }

  private async *openDirectHost(
    payload: {}, signal: AbortSignal, onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<HostFrame>> {
    const stream = this.api.events.host({ rpcId: mintRpcId(), payload }, signal)
    onOpen?.()
    yield* stream
  }
}

/** Node terminal carrier: HTTP unary upstream and WebSocket event downlinks. */
export class RemoteApiClient extends ApiClientBase {
  private readonly origin: string

  constructor(origin: string) {
    super()
    this.origin = webOrigin(origin)
  }

  protected async callRaw(method: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    const rpcId = mintRpcId()
    const request = { type: 'client-request', rpcId, method, payload }
    const response = await this.postJson(`/api/${method}`, request, signal)
    const body = await response.json()
    if (typeof body !== 'object' || body === null) throw new Error(`${method}: response is not an object`)
    const envelope = body as { type?: unknown; rpcId?: unknown; result?: unknown }
    if (envelope.type !== 'server-response' || envelope.rpcId !== rpcId || envelope.result === undefined) {
      throw new Error(`${method}: invalid server-response envelope`)
    }
    return { rpcId, result: envelope.result }
  }

  protected async respondRaw(message: ClientResponse, signal?: AbortSignal): Promise<unknown> {
    const response = await this.postJson('/api/respond', message, signal)
    return response.json()
  }

  protected openMux(
    _payload: {}, signal: AbortSignal, onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket(MUX_EVENTS_PATH, signal, onOpen)
  }

  protected openHost(
    _payload: {}, signal: AbortSignal, onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket(HOST_EVENTS_PATH, signal, onOpen)
  }

  private async postJson(
    path: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<Response> {
    const requestSignal = signal === undefined
      ? AbortSignal.timeout(DEFAULT_TIMEOUT_MS)
      : AbortSignal.any([AbortSignal.timeout(DEFAULT_TIMEOUT_MS), signal])
    const response = await globalThis.fetch(new URL(path, this.origin), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal,
    })
    if (!response.ok) throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
    return response
  }

  private async *readWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    let retry = 0
    while (!signal.aborted) {
      let opened = false
      try {
        yield* this.readSingleWebSocket<F>(path, signal, () => {
          opened = true
          onOpen?.()
        })
      } catch {
        if (signal.aborted) return
      }
      if (signal.aborted) return
      retry = opened ? 0 : retry + 1
      const delay = Math.min(
        RECONNECT_INITIAL_DELAY_MS * (2 ** Math.min(retry, 5)),
        RECONNECT_MAX_DELAY_MS,
      )
      await reconnectDelay(delay, signal)
    }
  }

  private async *readSingleWebSocket<F extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    onOpen: () => void,
  ): AsyncGenerator<RpcRequest<F>> {
    const url = new URL(path, this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(url)
    const inbox: SocketItem<F>[] = []
    let wake: (() => void) | undefined
    const enqueue = (item: SocketItem<F>): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const handleOpen = (): void => { onOpen() }
    const handleMessage = (event: MessageEvent): void => {
      try {
        if (typeof event.data !== 'string') throw new Error('binary WebSocket frame')
        const request = serverRequest(JSON.parse(event.data))
        enqueue({
          kind: 'frame',
          envelope: { rpcId: request.rpcId, payload: request.payload as F },
        })
      } catch (error) {
        console.error(`dsh-tui: 忽略 ${path} 的无效 WebSocket frame：`, error)
      }
    }
    const handleClose = (): void => { enqueue({ kind: 'end' }) }
    const handleError = (): void => {
      enqueue({ kind: 'error', error: new Error(`WebSocket 连接失败：${url.href}`) })
    }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close()
    }
    const handleConnectTimeout = (): void => {
      if (signal.aborted) return
      // Treat a stalled handshake as a connection failure so the outer layer
      // backs off and reconnects instead of hanging forever on `onOpen`.
      enqueue({ kind: 'error', error: new Error(`WebSocket 连接超时：${url.href}`) })
    }
    socket.addEventListener('open', handleOpen)
    socket.addEventListener('message', handleMessage)
    socket.addEventListener('close', handleClose, { once: true })
    socket.addEventListener('error', handleError, { once: true })
    signal.addEventListener('abort', handleAbort, { once: true })
    if (signal.aborted) handleAbort()
    // Arm the connect timeout only while the handshake is still pending. It is
    // cleared on open or abort so a late error frame never aborts a live socket.
    let connectTimer: NodeJS.Timeout | undefined
    const clearConnectTimer = (): void => { clearTimeout(connectTimer) }
    if (socket.readyState === WebSocket.CONNECTING) {
      connectTimer = setTimeout(handleConnectTimeout, WS_CONNECT_TIMEOUT_MS)
      signal.addEventListener('abort', clearConnectTimer, { once: true })
    }
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as SocketItem<F>
          if (item.kind === 'end') return
          if (item.kind === 'error') throw item.error
          yield item.envelope
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      clearTimeout(connectTimer)
      signal.removeEventListener('abort', handleAbort)
      signal.removeEventListener('abort', clearConnectTimer)
      socket.removeEventListener('open', handleOpen)
      socket.removeEventListener('message', handleMessage)
      socket.removeEventListener('close', handleClose)
      socket.removeEventListener('error', handleError)
      handleAbort()
    }
  }
}

/** Selected transport plus whether the Host belongs to the Web process. */
export interface TuiApiSelection {
  api: IApiClient
  remote: boolean
}

type RemoteFactory = (origin: string) => IApiClient

/**
 * Prefer the live Web Host, while retaining an explicit standalone escape hatch.
 * @param config - Parsed TUI connection flags.
 * @param local - Same-process client used for standalone mode and implicit fallback.
 * @param createRemote - Remote client factory overridden by focused tests.
 * @returns The selected client and whether it belongs to the Web Host.
 */
export async function selectTuiApi(
  config: TuiStartupValues,
  local: IApiClient,
  createRemote: RemoteFactory = origin => new RemoteApiClient(origin),
): Promise<TuiApiSelection> {
  if (config.standalone === true) return { api: local, remote: false }
  const explicit = config.connect !== undefined
  const origin = config.connect ?? DEFAULT_WEB_ORIGIN
  try {
    const remote = createRemote(origin)
    const response = await remote.host.describe(
      {}, AbortSignal.timeout(explicit ? EXPLICIT_CONNECT_TIMEOUT_MS : AUTO_CONNECT_TIMEOUT_MS),
    )
    if (!response.result.ok) throw new Error(response.result.error.message)
    return { api: remote, remote: true }
  } catch (error) {
    if (explicit) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`无法连接 Web Host ${origin}：${detail}`)
    }
    return { api: local, remote: false }
  }
}
