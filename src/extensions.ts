/** Assembly of Host-only extension adapters behind TuiHostExtensions. */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { ApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import type { DynamicCordisRunnerService } from '@deepseek-ai/dsh-cordis-host-runner'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, DynamicCordisInventoryRow,
} from '@deepseek-ai/dsh-cordis-host-runner/types'
import type { PluginInventoryGateway } from '@deepseek-ai/dsh-host-plugin-inventory'
import type { JobId, JobRegistry } from '@deepseek-ai/dsh-jobs'
import type { MessageFeedbackService } from '@deepseek-ai/dsh-message-feedback'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { TuiHostExtensions } from './controller.ts'
import type { RemoteRpcCarrier } from './remote.ts'

const COMMAND_EXECUTE_ENDPOINT = 'commands/execute'

/**
 * Minimal host-side permission-preset service face (the `permissionPresets`
 * service from `dsh-permission-presets`), kept untyped here so the TUI stays
 * decoupled from that optional Host plugin. `set` is the same imperative
 * behind the Host's `/permission` command: it writes the `permission/preset`
 * plus the changed knob events on the session's log.
 */
interface PermissionPresetLike {
  set(session: { events: readonly unknown[] }, preset: string): void
}

/** Services resolved from the settled standalone Host context. */
export interface LocalExtensionDeps {
  apiProxy: ApiProxy
  agents: AgentRegistry
  inventory: PluginInventoryGateway
  runner: DynamicCordisRunnerService
  feedback?: MessageFeedbackService | undefined
}

function asSessionId(value: string): SessionId {
  return value as SessionId
}

function asJobId(value: string): JobId {
  return value as JobId
}

/**
 * Wire the local Host's services into the controller's extension seams. These
 * adapters exist only in standalone mode; a remote-selected TUI passes no
 * extensions, so its commands report the capabilities as unavailable instead
 * of mixing remote session state with an unused local Host.
 * @param ctx - Host context used for lazily resolved optional services.
 * @param deps - Services already required by the TUI mount.
 */
export function createLocalExtensions(ctx: Context, deps: LocalExtensionDeps): TuiHostExtensions {
  const { apiProxy, agents, inventory, runner, feedback } = deps
  const cordisRows = (): DynamicCordisInventoryRow[] => runner.inventory()
  const ownedCordis = (sessionId: string, pluginId: string): DynamicCordisInventoryRow => {
    const row = cordisRows().find(item => item.pluginId === pluginId && item.agentId === sessionId)
    if (row === undefined) throw new Error(`session ${sessionId} 不持有 dynamic plugin ${pluginId}`)
    return row
  }
  return {
    downloads: apiProxy.downloads,
    ...(feedback === undefined ? {} : { feedback }),
    plugins: { list: () => inventory.list().entries },
    permission: {
      set: async (sessionId, preset) => {
        const permission = ctx.get('permissionPresets') as PermissionPresetLike | undefined
        if (permission === undefined) throw new Error('Host 未组合权限服务（dsh-permission-presets）')
        const agent = agents.get(sessionId)
        if (agent === undefined) throw new Error(`session ${sessionId} 当前没有 live agent`)
        permission.set(agent.session, preset)
        return `权限模式已切换为 ${preset}`
      },
    },
    jobs: {
      kill: async (id, reason) => {
        const jobs = ctx.get('jobs') as JobRegistry | undefined
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
  }
}

/** Wire remote-only Host capabilities through the shared typert RPC channel. */
export function createRemoteExtensions(carrier: RemoteRpcCarrier): TuiHostExtensions {
  return {
    permission: {
      set: async (sessionId, preset) => {
        const line = `/permission ${preset}`
        const response = await carrier.callRemote(COMMAND_EXECUTE_ENDPOINT, {
          agentId: sessionId,
          line,
          images: [],
        })
        if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`)
        if (typeof response.value !== 'object' || response.value === null) {
          throw new Error('Host 未提供 /permission 命令')
        }
        const execution = response.value as { result?: unknown }
        if (typeof execution.result !== 'object' || execution.result === null) {
          throw new Error(`${COMMAND_EXECUTE_ENDPOINT}: 返回结果无效`)
        }
        const result = execution.result as { kind?: unknown; text?: unknown }
        if (result.kind === 'error') {
          throw new Error(typeof result.text === 'string' ? result.text : '/permission 执行失败')
        }
        if (result.kind !== 'success') throw new Error(`${COMMAND_EXECUTE_ENDPOINT}: 返回结果无效`)
        return typeof result.text === 'string' ? result.text : `权限模式已切换为 ${preset}`
      },
    },
  }
}
