/** Cordis entry for the independently installed TUI profile bundle. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as mount } from './app.ts'

export { internals } from './app.ts'
export { TerminalApplication, type TerminalApplicationOptions } from './terminal.ts'
export type { TerminalNotificationEnvironment } from './terminal-controls.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-app'

/** Local Host fallback and command-line values required by the terminal application. */
export const inject = [
  'apiProxy', 'tuiStartup', 'messageFeedback', 'dynamicCordisRunner', 'agents', 'pluginInventory',
]

/** Invocation values passed from the startup provider through the bundle patch. */
export interface Config {
  /** Prompt submitted after session startup. */
  initialPrompt?: string
  /** Exact persisted session id to resume. */
  resume?: string
  /** Whether to resume the latest root session. */
  continueLatest: boolean
  /** Working directory for a newly created session. */
  cwd?: string
  /** Explicit Web Host origin; absent enables default loopback discovery. */
  connect?: string
  /** Force the isolated in-process Host. */
  standalone?: boolean
}

/** Runtime configuration schema. */
export const Config: z<Config> = z.object({
  initialPrompt: z.string(),
  resume: z.string(),
  continueLatest: z.boolean().default(false),
  cwd: z.string(),
  connect: z.string(),
  standalone: z.boolean(),
})

/**
 * Mount the interactive terminal renderer.
 * @param ctx - Settled profile context with the required Host services.
 * @param config - Parsed terminal startup values.
 */
export function apply(ctx: Context, config: Config): void {
  mount(ctx, config)
}
