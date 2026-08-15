import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, internals } from '../src/index.ts'

const original = { ...internals }

afterEach(() => { Object.assign(internals, original) })

describe('Cordis TUI mount', () => {
  it('settles the loader before rejecting a non-interactive terminal', async () => {
    const ctx = new Context()
    const exits: number[] = []
    let error = ''
    internals.stdin = { isTTY: false } as never
    internals.stdout = { isTTY: false } as never
    internals.stderr = { write: (chunk: string) => { error += chunk; return true } } as never
    const resolveRequestRun = vi.fn((_requestId: string, _resolution: unknown) => Promise.resolve({ accepted: true }))
    ctx.provide('appExit', (code: number) => { exits.push(code) })
    ctx.provide('loader', { await: async () => {} } as never)
    ctx.provide('apiProxy', {} as never)
    ctx.provide('dynamicCordisRunner', { resolveRequestRun } as never)

    apply(ctx, { continueLatest: false })
    ctx.emit('cordis/request-run', {
      requestId: 'request-1', agentId: 'session-1', pluginId: 'plugin-1', packageId: 'package-1',
      mode: 'run', name: 'Browser package', purpose: 'test', requiresApproval: true,
    } as never)

    await vi.waitFor(() => { expect(exits).toEqual([1]) })
    expect(resolveRequestRun).toHaveBeenCalledWith('request-1', {
      ok: false,
      reason: 'rejected',
      message: 'The TUI cannot load a browser Client half. Define and run a Host-only Cordis package in terminal sessions.',
    })
    expect(error).toBe('dsh-tui: 需要交互式终端（TTY）\n')
    await ctx.fiber.dispose()
  })

  it('requires the launcher-provided exit request', () => {
    expect(() => { apply(new Context(), { continueLatest: false }) })
      .toThrow('must provide ctx.appExit')
  })
})
