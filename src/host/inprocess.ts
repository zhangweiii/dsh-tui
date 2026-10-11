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
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
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
    this.facts = { home: resolveDshHome(), isLoopback: true }
  }

  async invoke(endpoint: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const { namespace, method } = endpointParts(endpoint)
    return await this.gateway.invoke({
      namespace,
      method,
      args,
      ...(signal === undefined ? {} : { signal }),
    })
  }

  open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown> {
    const { namespace, method } = endpointParts(endpoint)
    return {
      [Symbol.asyncIterator]: () => (async function* (this: InProcessTransport) {
        const stream = await this.gateway.stream({ namespace, method, args, signal })
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
