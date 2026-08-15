/** Cordis mount for the independent pi-tui terminal application. */

import type { Context } from '@deepseek-ai/cordis'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { DynamicCordisRunnerService } from '@deepseek-ai/dsh-cordis-host-runner'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, DynamicCordisInventoryRow,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type { PluginInventoryGateway } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { JobId } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-cmdline'
import type {} from '@deepseek-ai/dsh-message-feedback'
import { TuiController } from './controller.ts'
import type { Config } from './index.ts'
import { InProcessApiClient, selectTuiApi } from './remote.ts'
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

function asSessionId(value: string): SessionId {
  return value as SessionId
}

function asJobId(value: string): JobId {
  return value as JobId
}

/** Mount the TUI only after the complete profile tree has settled. */
export function apply(ctx: Context, config: Config): void {
  const appExit = ctx.get('appExit')
  if (appExit === undefined) throw new Error('tui-app: the launcher must provide ctx.appExit before the tree mounts')
  const runner: DynamicCordisRunnerService | undefined = ctx.get('dynamicCordisRunner')
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
      const apiProxy = ctx.get('apiProxy') as ApiProxy | undefined
      if (apiProxy === undefined) return
      if (!internals.stdin.isTTY || !internals.stdout.isTTY) {
        internals.stderr.write('dsh-tui: 需要交互式终端（TTY）\n')
        appExit(1)
        return
      }
      const feedback = ctx.get('messageFeedback')
      const inventory = ctx.get('pluginInventory') as PluginInventoryGateway | undefined
      const agents = ctx.get('agents')
      if (agents === undefined || inventory === undefined) {
        throw new Error('tui-app: agents and pluginInventory are required')
      }
      const cordisRows = (): DynamicCordisInventoryRow[] => runner.inventory()
      const ownedCordis = (sessionId: string, pluginId: string): DynamicCordisInventoryRow => {
        const row = cordisRows().find(item => item.pluginId === pluginId && item.agentId === sessionId)
        if (row === undefined) throw new Error(`session ${sessionId} 不持有 dynamic plugin ${pluginId}`)
        return row
      }
      const localApi = new InProcessApiClient(apiProxy)
      const selected = await selectTuiApi(config, localApi)
      const controllerConfig: Config = selected.remote && config.cwd === undefined
        ? Object.assign({}, config, { cwd: process.cwd() })
        : config
      const controller = new TuiController(
        selected.api,
        selected.remote ? {} : {
          downloads: apiProxy.downloads,
          ...(feedback === undefined ? {} : { feedback }),
          plugins: { list: () => inventory.list().entries },
          jobs: {
            kill: async (id, reason) => {
              const jobs = ctx.get('jobs')
              if (jobs === undefined) throw new Error('Host 未提供背景任务注册表 ctx.jobs')
              return { status: jobs.kill(asJobId(id), undefined, reason) }
            },
          },
          cordis: {
            inventory: cordisRows,
            runHostOnly: async (sessionId, pluginId, requestedPackageId) => {
              const row = ownedCordis(sessionId, pluginId)
              const packageId = requestedPackageId
                ?? row.nextPackageId
                ?? row.currentPackageId
                ?? row.packages.at(-1)?.packageId
              if (packageId === undefined) throw new Error(`dynamic plugin ${pluginId} 没有 package`)
              const pkg = row.packages.find(item => item.packageId === packageId)
              if (pkg === undefined) throw new Error(`dynamic plugin ${pluginId} 没有 package ${packageId}`)
              if (pkg.hasClientHalf) {
                throw new Error(`package ${packageId} 含浏览器 Client half；TUI 只能运行 host-only package`)
              }
              if (!pkg.hasHostHalf) throw new Error(`package ${packageId} 没有 Host half`)
              const agent = agents.get(asSessionId(sessionId))
              if (agent === undefined) throw new Error(`session ${sessionId} 当前没有 live agent`)
              const mode = row.currentPackageId === undefined || row.currentPackageId === packageId ? 'run' : 'update'
              const result = await runner.runHostHalf(
                agent,
                pluginId as CordisDynamicPluginId,
                packageId as CordisDynamicPackageId,
                mode,
                null,
                false,
              )
              if (!result.ok) throw new Error(result.message)
              return `Cordis ${mode} 已完成：${pluginId}/${packageId}${result.waitingFor.length === 0 ? '' : `；等待 ${result.waitingFor.join(', ')}`}`
            },
            stop: async (sessionId, pluginId) => {
              const agent = agents.get(asSessionId(sessionId))
              if (agent === undefined) throw new Error(`session ${sessionId} 当前没有 live agent`)
              const result = await runner.stopFromPanel(agent, pluginId as CordisDynamicPluginId)
              if (!result.ok && result.reason !== 'not-running') throw new Error(result.message)
              return result.ok ? `已停止 dynamic plugin ${pluginId}` : `dynamic plugin ${pluginId} 当前未运行`
            },
            remove: async (sessionId, pluginId) => {
              const agent = agents.get(asSessionId(sessionId))
              if (agent === undefined) throw new Error(`session ${sessionId} 当前没有 live agent`)
              const result = await runner.undefineFromPanel(agent, pluginId as CordisDynamicPluginId)
              if (!result.ok) throw new Error(result.message)
              return `已删除 dynamic plugin ${pluginId} 及其全部 package`
            },
          },
        },
      )
      application = new TerminalApplication(controller, controllerConfig, {
        terminal: internals.createTerminal(),
        onExit: appExit,
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
