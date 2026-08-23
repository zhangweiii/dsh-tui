/** Cordis mount for the independent pi-tui terminal application. */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { DynamicCordisRunnerService } from '@deepseek-ai/dsh-cordis-host-runner'
import type { PluginInventoryGateway } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { MessageFeedbackService } from '@deepseek-ai/dsh-message-feedback'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
// Load-bearing type-only imports: these packages augment the Cordis Context
// service registry (ctx.get keys) via module augmentation. Deleting them makes
// the typed ctx.get('loader') / ctx.get('agents') / … lookups below fall apart.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { TuiController } from './controller.ts'
import { createLocalExtensions, createRemoteExtensions } from './extensions.ts'
import { RemoteFileReferenceClient } from './file-reference.ts'
import type { Config } from './index.ts'
import { InProcessApiClient, selectTuiApi, type RemoteRpcCarrier } from './remote.ts'
import { TerminalApplication } from './terminal.ts'

export interface TerminalIo {
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  createTerminal: () => Terminal
}

/** Process IO and terminal factory seam used by focused lifecycle tests. */
export const internals: TerminalIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  createTerminal: () => new ProcessTerminal(),
}

/** Mount the TUI only after the complete profile tree has settled. */
export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit') as ((code: number) => void) | undefined
  if (appExit === undefined) throw new Error('tui-app: the launcher must provide ctx.appExit before the tree mounts')
  const runner = ctx.get('dynamicCordisRunner') as DynamicCordisRunnerService | undefined
  if (runner === undefined) throw new Error('tui-app: dynamicCordisRunner is required')
  ctx.effect(() => ctx.on('cordis/request-run', (request) => {
    void runner.resolveRequestRun(request.requestId, {
      ok: false,
      reason: 'rejected',
      message: 'The TUI cannot load a browser Client half. Define and run a Host-only Cordis package in terminal sessions.',
    }).catch((error: unknown) => {
      internals.stderr.write(`dsh-tui: rejecting browser Cordis activation failed: ${error instanceof Error ? error.message : String(error)}\n`)
    })
  }), 'tui: reject browser-only Cordis activations')
  ctx.effect(() => {
    const mountAbort = new AbortController()
    let application: TerminalApplication | undefined
    // Do not return the settlement promise from this effect: Loader waits for
    // async effects, so awaiting Loader from one creates a self-deadlock.
    void (async () => {
      await ctx.get('loader')?.await()
      if (mountAbort.signal.aborted) return
      // cordis ctx.get is untyped; the casts below are the local type registry.
      const apiProxy = ctx.get('apiProxy') as ApiProxy | undefined
      if (apiProxy === undefined) return
      if (!internals.stdin.isTTY || !internals.stdout.isTTY) {
        internals.stderr.write('dsh-tui: 需要交互式终端（TTY）\n')
        appExit(1)
        return
      }
      const feedback = ctx.get('messageFeedback') as MessageFeedbackService | undefined
      const inventory = ctx.get('pluginInventory') as PluginInventoryGateway | undefined
      const agents = ctx.get('agents') as AgentRegistry | undefined
      if (agents === undefined || inventory === undefined) {
        throw new Error('tui-app: agents and pluginInventory are required')
      }
      const localApi = new InProcessApiClient(apiProxy)
      const selected = await selectTuiApi(config, localApi)
      const controllerConfig: Config = selected.remote && config.cwd === undefined
        ? Object.assign({}, config, { cwd: process.cwd() })
        : config
      const controller = new TuiController(
        selected.api,
        selected.remote
          ? createRemoteExtensions(selected.api as unknown as RemoteRpcCarrier)
          : createLocalExtensions(ctx, { apiProxy, agents, inventory, runner, feedback }),
        { setTerminalTitle: title => { application?.setTitle(title) } },
      )
      // The Host file-reference index is mounted in the Web bundle only, so
      // standalone mode keeps pi-tui's local completion path untouched.
      const fileReferenceOptions = selected.remote
        ? {
          fileReferences: new RemoteFileReferenceClient(selected.api as unknown as RemoteRpcCarrier),
          // Diagnostic-only: the first silent fallback per outage episode.
          onFileReferenceDegraded: (detail: string) => { internals.stderr.write(`dsh-tui: ${detail}\n`) },
        }
        : {}
      application = new TerminalApplication(controller, controllerConfig, {
        terminal: internals.createTerminal(),
        onExit: appExit,
        ...fileReferenceOptions,
      })
      application.start()
    })().catch((error: unknown) => {
      if (mountAbort.signal.aborted) return
      application?.stop()
      internals.stderr.write(`dsh-tui: ${error instanceof Error ? error.message : String(error)}\n`)
      appExit(1)
    })
    return () => {
      mountAbort.abort()
      application?.stop()
    }
  })
}
