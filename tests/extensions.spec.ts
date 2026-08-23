import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createRemoteExtensions } from '../src/extensions.ts'
import type { RemoteRpcCarrier } from '../src/remote.ts'

describe('TUI Host extensions', () => {
  it('switches remote permissions through the Host command registry instead of chat', async () => {
    const callRemote = vi.fn(async () => ({
      ok: true as const,
      value: {
        commandId: 'permission-1',
        result: { kind: 'success' as const, text: '权限模式已切换为 danger-full-access' },
      },
    }))
    const extensions = createRemoteExtensions({ callRemote } as RemoteRpcCarrier)
    const sessionId = SessionId('session-root')

    await expect(extensions.permission?.set(sessionId, 'danger-full-access'))
      .resolves.toBe('权限模式已切换为 danger-full-access')
    expect(callRemote).toHaveBeenCalledWith('commands/execute', {
      agentId: sessionId,
      line: '/permission danger-full-access',
      images: [],
    })
  })
})
