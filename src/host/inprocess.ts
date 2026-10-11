/**
 * In-tree carrier: the standalone terminal speaks to the Host services mounted
 * in its own Cordis tree through the same Typert Gateway the Web carrier uses,
 * and participates in the scoped waterfalls directly because the answerers live
 * in this process.
 *
 * @module @zhangweiii/dsh-tui/host/inprocess
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import { homedir } from 'node:os'
import { RpcId } from '../contract/runtime.ts'
import type { HostTransport, WaterfallInvocation } from './client.ts'

/** One forwarded waterfall listener as Cordis dispatches it. */
type WaterfallListener = (request: unknown, next: () => Promise<unknown>) => Promise<unknown>

/** Loose Cordis surface: forwarded events are Host-owned, so names stay strings here. */
interface EventContext {
  on(name: string, listener: (...args: never[]) => unknown): () => void
}

/**
 * Resolve the Typert Gateway service from a settled Host context.
 * @param ctx - Host context holding the gateway row.
 * @returns the gateway service.
 */
export function resolveGateway(ctx: Context): TypertGatewayService {
  const gateway = ctx.get('typertGateway') as TypertGatewayService | undefined
  if (gateway === undefined) throw new Error('dsh-tui: 缺少 ctx.typertGateway（dsh-base 的 typert-gateway 行）')
  return gateway
}

/** Split one `<namespace>/<method>` endpoint. */
function endpointParts(endpoint: string): { namespace: string, method: string } {
  const separator = endpoint.indexOf('/')
  if (separator <= 0 || separator === endpoint.length - 1) {
    throw new Error(`dsh-tui: 无效的 Remote endpoint ${endpoint}`)
  }
  return { namespace: endpoint.slice(0, separator), method: endpoint.slice(separator + 1) }
}

/** Session identity carried by one in-process waterfall request. */
function sessionIdOf(request: unknown): string | undefined {
  const agent = (request as { agent?: { sessionId?: unknown } } | undefined)?.agent
  return typeof agent?.sessionId === 'string' ? agent.sessionId : undefined
}

/** Same-process carrier over the mounted Host services. */
export class InProcessTransport implements HostTransport {
  readonly facts: HostTransport['facts']

  constructor(private readonly ctx: Context, private readonly gateway: TypertGatewayService) {
    // The Web carrier publishes the OS account home on its ready frame; the
    // in-tree carrier reports the same fact so `/host` abbreviates cwd alike.
    this.facts = { home: homedir(), isLoopback: true }
  }

  /**
   * The Peer this terminal speaks for. A browser request is admitted as the
   * Host's operator, and the Remote services key per-peer state (session and
   * agent scopes) by it; the in-process carrier must present the same Peer or
   * the Host would compose a session outside the scope the operator owns.
   * @returns the operator Peer, or undefined when Connection is not composed.
   */
  private peer(): unknown {
    const connection = this.ctx.get('connection') as { operator?: unknown } | undefined
    return connection?.operator
  }

  async invoke(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { namespace, method } = endpointParts(endpoint)
    const peer = this.peer()
    return await this.gateway.invoke({
      namespace,
      method,
      args,
      ...(peer === undefined ? {} : { peer: peer as never }),
      ...(signal === undefined ? {} : { signal }),
    })
  }

  open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    const { namespace, method } = endpointParts(endpoint)
    const peer = this.peer()
    return {
      [Symbol.asyncIterator]: () => (async function* (this: InProcessTransport) {
        const stream = await this.gateway.stream({
          namespace,
          method,
          args,
          ...(peer === undefined ? {} : { peer: peer as never }),
          signal,
        })
        yield* stream
      }).call(this),
    }
  }

  on(event: string, listener: (...args: readonly unknown[]) => void): () => void {
    const context = this.ctx as unknown as EventContext
    return context.on(event, listener as (...args: never[]) => unknown)
  }

  onWaterfall(event: string, listener: (invocation: WaterfallInvocation) => void): () => void {
    const context = this.ctx as unknown as EventContext
    const registered = context.on(event, ((request: unknown, next: () => Promise<unknown>) => {
      // A pending answerable request stays open until this terminal answers it;
      // the renderer owns that lifetime, so `next()` delegation is never used.
      void next
      return new Promise<unknown>((resolve, reject) => {
        listener({
          rpcId: RpcId(randomUUID()),
          event,
          request: (request ?? {}) as Record<string, unknown>,
          sessionId: sessionIdOf(request),
          settle: async (outcome) => {
            if (outcome.kind === 'result') resolve(outcome.value)
            else reject(outcome.error)
          },
        })
      })
    }) as unknown as WaterfallListener as (...args: never[]) => unknown)
    return registered
  }

  async close(): Promise<void> {
    // The Host tree owns every subscription this carrier created; a Cordis
    // effect disposes them with the plugin.
  }
}
