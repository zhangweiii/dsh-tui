import { describe, expect, it } from 'vitest'
import { slashCommands, TUI_COMMANDS } from '../src/commands.ts'

describe('slash command catalog', () => {
  it('maps slash-prefixed commands to pi-tui metadata', () => {
    expect(slashCommands([
      { command: '/resume', description: '恢复会话', input: '[id]' },
    ])).toEqual([{ name: 'resume', description: '恢复会话', argumentHint: '[id]' }])
  })

  it('keeps model and resume discoverable without duplicating command names', () => {
    const commands = slashCommands()
    expect(commands.some(command => command.name === 'model')).toBe(true)
    expect(commands.some(command => command.name === 'resume')).toBe(true)
    expect(new Set(TUI_COMMANDS.map(command => command.command)).size).toBe(TUI_COMMANDS.length)
  })
})
