/**
 * The TUI command-line provider. It parses terminal-only invocation options
 * and publishes them as an ordinary Cordis service for the renderer row.
 * @module @zhangweiii/dsh-tui/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Service required before invocation options can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the TUI renderer. */
export const TUI_STARTUP_SERVICE = 'tuiStartup'

/** Parsed values consumed by the TUI renderer row. */
export interface TuiStartupValues {
  /** Prompt submitted after the initial session and event stream are ready. */
  initialPrompt?: string
  /** Exact persisted session id to resume. */
  resume?: string
  /** Resume the most recently updated root session, creating one when absent. */
  continueLatest: boolean
  /** Working directory for a newly created session. */
  cwd?: string
  /** Web Host origin selected explicitly; absent enables loopback auto-discovery. */
  connect?: string
  /** Force the original in-process Host even when the default Web Host is reachable. */
  standalone?: boolean
}

interface TuiOptions {
  resume?: string
  continue?: boolean
  cwd?: string
  connect?: string
  standalone?: boolean
}

/** Process streams used by command-line help and diagnostics. */
export const internals: {
  stdout: { write(chunk: string): unknown }
  stderr: { write(chunk: string): unknown }
} = {
  stdout: process.stdout,
  stderr: process.stderr,
}

function isCommanderError(error: unknown): error is { code: string; exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
}

function parseCmdline(ctx: Context, program: Command): void {
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) {
    throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`)
  }
  program
    .exitOverride()
    .configureOutput({
      writeOut: text => void internals.stdout.write(text),
      writeErr: text => void internals.stderr.write(text),
    })
  try {
    program.parse(args.get(), { from: 'user' })
  } catch (error) {
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
  }
}

/**
 * Build a fresh terminal command for one invocation.
 * @returns the TUI command with its flags and optional initial prompt.
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile tui')
    .description('Run the interactive DeepSeek Harness terminal UI.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session>', 'resume an exact persisted session id')
    .option('-c, --continue', 'resume the most recently updated root session')
    .option('-C, --cwd <path>', 'working directory for a new session')
    .option('--connect <url>', 'connect to a running Web Host (default discovery: http://127.0.0.1:3080)')
    .option('--standalone', 'force an isolated in-process Host')
    .argument('[prompt...]', 'optional prompt submitted after startup')
    .addHelpText('after', `
Examples:
  dsh --profile tui                                 start a new interactive session
  dsh --profile tui "explain this repository"       start and submit an initial prompt
  dsh --profile tui --continue                      resume the latest root session
  dsh --profile tui --resume <session-id>           resume one persisted session
  dsh --profile tui --connect http://127.0.0.1:8080 share a Web Host on another port
`)
}

/**
 * Parse and publish one immutable TUI invocation.
 * @param ctx - plugin context carrying the launcher command line.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action(() => {
    const options = program.opts<TuiOptions>()
    if (options.resume !== undefined && options.continue === true) {
      program.error('error: --resume and --continue are mutually exclusive')
    }
    if (options.connect !== undefined && options.standalone === true) {
      program.error('error: --connect and --standalone are mutually exclusive')
    }
    if (options.resume === '') program.error('error: --resume needs a session id')
    if (options.cwd === '') program.error('error: --cwd needs a path')
    const joined = program.args.join(' ').trim()
    ctx.provide(TUI_STARTUP_SERVICE, {
      ...(joined === '' ? {} : { initialPrompt: joined }),
      ...(options.resume === undefined ? {} : { resume: options.resume }),
      continueLatest: options.continue === true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.connect === undefined ? {} : { connect: options.connect }),
      ...(options.standalone === true ? { standalone: true } : {}),
    } satisfies TuiStartupValues)
  })
  parseCmdline(ctx, program)
}
