/**
 * Slash-command catalog: the single source of truth for terminal-native
 * commands. The dispatch table in controller.ts, the /help overlay, and the
 * composer autocomplete are all derived from this list — add a command here
 * and everywhere else follows.
 */

import type { SlashCommand } from '@earendil-works/pi-tui'

interface CommandDescriptor {
  command: `/${string}`
  description: string
  input?: string
  /** True when the TUI forwards the command to the Harness unchanged. */
  forwarded?: boolean
}

/** TUI-owned commands plus common Harness commands forwarded to the active session. */
export const TUI_COMMANDS: readonly CommandDescriptor[] = [
  { command: '/help', description: '查看 TUI 命令' },
  { command: '/status', description: '查看运行状态' },
  { command: '/close', description: '关闭当前面板' },
  { command: '/sessions', description: '选择或搜索会话', input: '[query]' },
  { command: '/new', description: '新建并切换会话', input: '[cwd]' },
  { command: '/resume', description: '选择、恢复并切换会话', input: '[session-id-or-prefix]' },
  { command: '/rename', description: '重命名当前会话', input: '<title>' },
  { command: '/fork', description: '分叉当前会话', input: '[event-seq]' },
  { command: '/older', description: '加载更早记录' },
  { command: '/models', description: '选择模型' },
  { command: '/model', description: '选择或直接切换模型', input: '[provider/model] [reasoning-effort]' },
  { command: '/effort', description: '设置当前模型的思考级别' },
  { command: '/queue', description: '查看待处理消息' },
  { command: '/queue-edit', description: '编辑待处理消息', input: '<item-id> <text>' },
  { command: '/queue-remove', description: '删除待处理消息', input: '<item-id> --yes' },
  { command: '/queue-steer', description: '把消息插入当前轮次', input: '<item-id>' },
  { command: '/jobs', description: '查看后台任务' },
  { command: '/job-kill', description: '停止后台任务', input: '<id-or-prefix> --yes' },
  { command: '/presets', description: '选择 Agent preset' },
  { command: '/preset', description: '选择或直接切换 Agent preset', input: '[id]' },
  { command: '/preset-read', description: '查看 preset', input: '<id>' },
  { command: '/preset-copy', description: '复制 preset', input: '<source-id> <new-id> [name]' },
  { command: '/preset-open', description: '打开用户 preset', input: '<id>' },
  { command: '/preset-remove', description: '删除用户 preset', input: '<id> --yes' },
  { command: '/workspaces', description: '查看 workspaces' },
  { command: '/workspace-new', description: '创建 workspace', input: '<path>' },
  { command: '/workspace-rename', description: '重命名 workspace', input: '<id> <title>' },
  { command: '/workspace-delete', description: '移除 workspace 注册', input: '<id> --yes' },
  { command: '/workspace-move', description: '移动 workspace', input: '<id> [before-id|end]' },
  { command: '/workspace-session-move', description: '移动 workspace 会话', input: '<workspace-id> <session-id> [before-id|end]' },
  { command: '/archive', description: '归档会话', input: '[session-id] --yes' },
  { command: '/skills', description: '查看可调用 skills' },
  { command: '/subagents', description: '选择子代理 transcript' },
  { command: '/subagent', description: '选择或进入子代理 transcript', input: '[child-id-or-prefix]' },
  { command: '/back', description: '返回父会话' },
  { command: '/settings', description: '选择设置命名空间' },
  { command: '/settings-show', description: '查看设置', input: '<namespace> [--schema]' },
  { command: '/settings-open', description: '打开设置文件' },
  { command: '/settings-set', description: '设置配置值', input: '<namespace> <json-pointer> <json>' },
  { command: '/settings-unset', description: '移除配置值', input: '<namespace> <json-pointer> --yes' },
  { command: '/settings-reset', description: '重置设置', input: '<namespace> --yes' },
  { command: '/goal', description: '创建 Harness 目标', input: '<objective>' },
  { command: '/goal-show', description: '查看目标' },
  { command: '/goal-edit', description: '编辑目标', input: '<objective>' },
  { command: '/goal-pause', description: '暂停目标' },
  { command: '/goal-resume', description: '恢复目标' },
  { command: '/goal-complete', description: '完成目标' },
  { command: '/goal-clear', description: '清除目标', input: '--yes' },
  { command: '/providers', description: '选择模型提供方' },
  { command: '/provider-models', description: '选择提供方模型', input: '[provider]' },
  { command: '/discover-models', description: '发现提供方模型', input: '<settings-ns> [provider|-] [base-url|-] [api|-] [api-key-env|-]' },
  { command: '/provider-add', description: '通过 Host 配置或新增 provider', input: '[new-provider-id] [--name <显示名>] [--base-url <url>] [--api <协议>] [--key-env <环境变量>] [--model <id>] [--discover]' },
  { command: '/credentials', description: '查看凭据状态', input: '<ref...>' },
  { command: '/credential-set', description: '从环境变量写入凭据', input: '<ref> <env-name>' },
  { command: '/credential-unset', description: '移除凭据', input: '<ref> --yes' },
  { command: '/directories', description: '浏览目录', input: '[path]' },
  { command: '/mkdir', description: '创建目录', input: '<path> <name>' },
  { command: '/open', description: '打开路径', input: '<path>' },
  { command: '/plugins', description: '查看插件' },
  { command: '/cordis', description: '查看动态 Cordis 插件' },
  { command: '/cordis-run', description: '运行动态 Cordis 插件', input: '<plugin-id> [package-id]' },
  { command: '/cordis-stop', description: '停止动态 Cordis 插件', input: '<plugin-id> --yes' },
  { command: '/cordis-remove', description: '移除动态 Cordis 插件', input: '<plugin-id> --yes' },
  { command: '/feedback', description: '记录消息反馈', input: '<message-id|last> <positive|negative> [note]' },
  { command: '/feedback-clear', description: '清除消息反馈', input: '<message-id|last> --yes' },
  { command: '/image', description: '发送图片', input: '<path> [prompt]' },
  { command: '/image-steer', description: '插入图片消息', input: '<path> [prompt]' },
  { command: '/save-image', description: '保存会话图片', input: '<attachment-id> [path]' },
  { command: '/export', description: '导出会话', input: '[path] [--descendants]' },
  { command: '/host', description: '查看 Host 信息' },
  { command: '/permission', description: '切换权限模式', input: '[mode]' },
  { command: '/plan', description: '切换计划模式', forwarded: true },
  { command: '/compact', description: '压缩上下文', forwarded: true },
]

/** Commands the TUI owns locally (everything not forwarded to the Harness). */
export const LOCAL_COMMANDS: readonly CommandDescriptor[] = TUI_COMMANDS.filter(item => item.forwarded !== true)

/** Usage string for one catalog entry, e.g. `/model [provider/model] [reasoning-effort]`. */
function usage(item: CommandDescriptor): string {
  return item.input === undefined ? item.command : `${item.command} ${item.input}`
}

/**
 * Render the `/help` overlay from the catalog, so help can never drift from
 * the dispatch table or the autocomplete entries.
 */
export function helpLines(): string[] {
  const width = Math.max(...TUI_COMMANDS.map(item => usage(item).length))
  const line = (item: CommandDescriptor): string => `${usage(item).padEnd(width)}  ${item.description}${item.forwarded === true ? '（交给 Harness）' : ''}`
  return [
    ...LOCAL_COMMANDS.map(line),
    ...TUI_COMMANDS.filter(item => item.forwarded === true).map(line),
    'Ctrl+Shift+E  展开最近的折叠行（上下文/skill 目录、工具详情等）；再按展开更早的，全开后按一下重新全部折叠',
    'Ctrl+T        展开/折叠 todo 清单（非折叠时显示进度和当前正在执行的项）',
    'Ctrl+N/P      输入框历史/光标、命令补全与选择列表上下移动',
    '其他 /command  交给 Harness 命令或 skill',
  ]
}

/** Format the command catalog for pi-tui's built-in slash autocomplete. */
export function slashCommands(commands: readonly CommandDescriptor[] = TUI_COMMANDS): SlashCommand[] {
  return commands.map(item => ({
    name: item.command.slice(1),
    description: item.description,
    ...(item.input === undefined ? {} : { argumentHint: item.input }),
  }))
}
