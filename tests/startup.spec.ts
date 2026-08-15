/** TUI command-line parsing and ordinary service publication. */

import { Context } from '@deepseek-ai/cordis'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, internals, TUI_STARTUP_SERVICE, type TuiStartupValues } from '../src/startup.ts'

const original = { ...internals }
afterEach(() => { Object.assign(internals, original) })

function parse(args: string[]): { value: TuiStartupValues | undefined; exits: number[]; output: string } {
  const ctx = new Context()
  const exits: number[] = []
  let output = ''
  const writer = { write: (chunk: string) => { output += chunk; return true } }
  internals.stdout = writer
  internals.stderr = writer
  provideCmdline(ctx, { args, exit: (code) => { exits.push(code) } })
  apply(ctx)
  return {
    value: ctx.get(TUI_STARTUP_SERVICE) as TuiStartupValues | undefined,
    exits,
    output,
  }
}

describe('tui command-line provider', () => {
  it('publishes defaults and joins an initial prompt', () => {
    expect(parse([])).toMatchObject({ value: { continueLatest: false }, exits: [] })
    expect(parse(['explain', 'this', 'repository']).value).toEqual({
      initialPrompt: 'explain this repository',
      continueLatest: false,
    })
  })

  it('publishes resume, continue, cwd, and Host connection values', () => {
    expect(parse(['--resume', 'session-1', '-C', '/work']).value).toEqual({
      resume: 'session-1', cwd: '/work', continueLatest: false,
    })
    expect(parse(['--continue']).value).toEqual({ continueLatest: true })
    expect(parse(['--connect', 'http://127.0.0.1:4180']).value).toEqual({
      connect: 'http://127.0.0.1:4180', continueLatest: false,
    })
    expect(parse(['--standalone']).value).toEqual({ continueLatest: false, standalone: true })
  })

  it('prints help without publishing a value', () => {
    const result = parse(['--help'])
    expect(result.output).toContain('dsh --profile tui')
    expect(result.output).toContain('--resume')
    expect(result.output).toContain('--connect')
    expect(result.output).toContain('--standalone')
    expect(result.value).toBeUndefined()
    expect(result.exits).toEqual([0])
  })

  it('rejects contradictory and empty option values', () => {
    const conflict = parse(['--resume', 's', '--continue'])
    expect(conflict.output).toContain('mutually exclusive')
    expect(conflict.value).toBeUndefined()
    expect(conflict.exits).toEqual([1])

    const empty = parse(['--cwd='])
    expect(empty.output).toContain('--cwd needs a path')
    expect(empty.value).toBeUndefined()
    expect(empty.exits).toEqual([1])

    const connectionConflict = parse(['--connect', 'http://127.0.0.1:3080', '--standalone'])
    expect(connectionConflict.output).toContain('mutually exclusive')
    expect(connectionConflict.value).toBeUndefined()
    expect(connectionConflict.exits).toEqual([1])
  })
})
