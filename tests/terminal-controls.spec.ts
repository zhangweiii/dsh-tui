import { describe, expect, it } from 'vitest'
import { sanitizeTerminalText, terminalNotificationSequence } from '../src/terminal-controls.ts'

describe('terminal control sequences', () => {
  it('removes OSC-breaking control characters from user text', () => {
    expect(sanitizeTerminalText('  title\nwith\u0007bell\u001B]9;injection\u009d99;payload  ')).toBe('title with bell ]9;injection 99;payload')
  })

  it('uses OSC 777 for the broad compatibility path and ignores empty messages', () => {
    expect(terminalNotificationSequence('执行完成', {})).toBe('\u001B]777;notify;dsh;执行完成\u0007')
    expect(terminalNotificationSequence(' \n\u0007 ', {})).toBeUndefined()
  })

  it('uses Kitty OSC 99 only when Kitty identifies itself', () => {
    expect(terminalNotificationSequence('执行完成', { KITTY_WINDOW_ID: '42' }))
      .toBe('\u001B]99;i=1:d=0;dsh\u001B\\\u001B]99;i=1:p=body;执行完成\u001B\\')
  })

  it('uses iTerm2 OSC 9 and wraps notifications for tmux', () => {
    expect(terminalNotificationSequence('执行完成', { TERM_PROGRAM: 'iTerm.app' }))
      .toBe('\u001B]9;dsh: 执行完成\u0007')
    expect(terminalNotificationSequence('执行完成', { TMUX: '/tmp/tmux' }))
      .toBe('\u001BPtmux;\u001B\u001B]777;notify;dsh;执行完成\u0007\u001B\\')
  })
})
