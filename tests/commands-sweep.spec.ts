/**
 * Systematic sweep over the slash-command catalog in commands.ts: every
 * catalogued command is exercised bare, with valid arguments, and with broken
 * arguments. The "regressions" describe block pins behavior that an earlier
 * sweep round found broken and that is now fixed; each test names the
 * protected contract.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { TUI_COMMANDS } from '../src/commands.ts'
import { TuiController, type TuiHostExtensions } from '../src/controller.ts'
import { CHILD, fakeApi, SID, summary } from './fake-api.ts'

const FORWARDED = new Set(TUI_COMMANDS.filter(item => item.forwarded === true).map(item => item.command))

/** Commands whose bare invocation legitimately shows no notice/overlay/picker. */
const EXPECTED_SILENT = new Set(['/new', '/fork'])

const QUEUE_FRAME = {
  type: 'session/queue', sessionId: SID,
  items: [{
    id: 'queued-message-1' as never,
    placement: 'queued',
    message: {
      id: 'queued-message-1' as never, role: 'user', source: { kind: 'user' },
      content: [{ type: 'text', text: '旧内容' }],
    },
  }],
} as unknown as MuxFrame

function jobsExt(): TuiHostExtensions {
  return { jobs: { kill: vi.fn(async () => ({ status: 'requested' as const })) } }
}

function pluginsExt(): TuiHostExtensions {
  return {
    plugins: {
      list: () => [{ entryId: 'entry-1', moduleName: 'mod', enabled: true, fiberPhase: 'running' }],
    },
  }
}

function cordisExt(): TuiHostExtensions {
  return {
    cordis: {
      inventory: () => [{
        pluginId: 'plugin-1', agentId: 'agent-1', packages: [], nextPackageId: 'pkg-1',
      }],
      runHostOnly: vi.fn(async () => '插件已运行'),
      stop: vi.fn(async () => '插件已停止'),
      remove: vi.fn(async () => '插件已删除'),
    },
  }
}

function feedbackExt(): TuiHostExtensions {
  return {
    feedback: {
      list: vi.fn(async () => ({
        ok: true as const,
        value: {
          items: [{
            messageId: 'assistant-1' as never, rating: 'positive' as const,
            version: 'v1' as never, createdAt: 0, updatedAt: 0,
          }],
        },
      })),
      put: vi.fn(async (request: { messageId: string; rating: string }) => ({
        ok: true as const,
        value: {
          messageId: request.messageId as never, rating: request.rating as never,
          version: 'v2' as never, createdAt: 0, updatedAt: 1,
        },
      })),
      delete: vi.fn(async () => ({ ok: true as const, value: { absent: true as const } })),
    } as never,
  }
}

function downloadsExt(): TuiHostExtensions {
  return {
    downloads: {
      sessionLog: vi.fn(async () => new Response('zip-bytes', { status: 200 })),
    },
  }
}

function permissionExt(): TuiHostExtensions {
  return {
    permission: {
      set: vi.fn(async (_sessionId, preset) => `权限模式已切换为 ${preset}`),
    },
  }
}

function allExtensions(): TuiHostExtensions {
  return {
    ...jobsExt(), ...pluginsExt(), ...cordisExt(), ...feedbackExt(), ...downloadsExt(), ...permissionExt(),
  }
}

async function started(
  options: Parameters<typeof fakeApi>[0] = {},
  extensions: TuiHostExtensions = {},
): Promise<{ controller: TuiController; fake: ReturnType<typeof fakeApi> }> {
  const fake = fakeApi({ items: [summary()], ...options })
  const controller = new TuiController(fake.api, extensions)
  await controller.start({ continueLatest: false, resume: SID })
  // The fake host stream ends immediately, posting '主机事件流已关闭'; let that
  // settle before clearing notices so tests observe command effects only.
  await new Promise(resolve => setTimeout(resolve, 10))
  controller.setNotice(undefined)
  return { controller, fake }
}

/** Visible feedback after a command: notice text, overlay title, or picker kind. */
function feedbackOf(controller: TuiController): string | undefined {
  const state = controller.getSnapshot()
  return state.notice ?? state.overlay?.title ?? state.picker?.kind
}

describe('slash-command sweep', () => {
  it('resolves every catalogued command bare, never forwards local ones to the model', async () => {
    const silent: string[] = []
    for (const { command } of TUI_COMMANDS) {
      const { controller, fake } = await started()
      await expect(controller.submit(command)).resolves.toBe(true)
      if (FORWARDED.has(command)) {
        expect(fake.prompt, `${command} should reach the Harness`).toHaveBeenCalledWith(expect.objectContaining({
          content: [{ type: 'text', text: command }],
        }))
      } else {
        expect(fake.prompt, `${command} must stay local`).not.toHaveBeenCalled()
        const feedback = feedbackOf(controller)
        if (feedback === undefined) silent.push(command)
      }
      controller.dispose()
    }
    expect(silent.sort()).toEqual([...EXPECTED_SILENT].sort())
  })

  it('resolves every catalogued command bare with all Host extensions enabled', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-bare-'))
    const previousCwd = process.cwd()
    process.chdir(work)
    try {
      const silent: string[] = []
      for (const { command } of TUI_COMMANDS) {
        const { controller, fake } = await started({}, allExtensions())
        await expect(controller.submit(command)).resolves.toBe(true)
        if (!FORWARDED.has(command)) {
          expect(fake.prompt, `${command} must stay local`).not.toHaveBeenCalled()
          const feedback = feedbackOf(controller)
          if (feedback === undefined) silent.push(command)
        }
        controller.dispose()
      }
      expect(silent.sort()).toEqual([...EXPECTED_SILENT].sort())
    } finally {
      process.chdir(previousCwd)
      await rm(work, { recursive: true, force: true })
    }
  })

  it('runs every command with valid arguments to its expected effect', async () => {
    const { controller, fake } = await started(
      {
        mux: QUEUE_FRAME,
        jobs: [{ id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: 0 }],
      },
      allExtensions(),
    )
    const state = () => controller.getSnapshot()

    await controller.submit('/help')
    expect(state().overlay?.title).toBe('TUI 命令')
    await controller.submit('/status')
    expect(state().overlay?.title).toBe('运行状态')
    await controller.submit('/close')
    expect(state().overlay).toBeUndefined()

    await controller.submit('/rename 新标题')
    expect(state().title).toBe('新标题')

    await controller.submit('/queue')
    expect(state().overlay?.title).toBe('Queue')
    await controller.submit('/queue-edit queued-m 新内容')
    expect(fake.updateQueue).toHaveBeenLastCalledWith(expect.objectContaining({
      itemId: 'queued-message-1', action: { kind: 'edit', content: [{ type: 'text', text: '新内容' }] },
    }))
    await controller.submit('/queue-steer queued-m')
    expect(fake.updateQueue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: 'steer' } }))
    await controller.submit('/queue-remove queued-m --yes')
    expect(fake.updateQueue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: 'remove' } }))

    await controller.submit('/jobs')
    expect(state().overlay?.lines.some(line => line.includes('bash-1'))).toBe(true)
    await controller.submit('/job-kill bash-1 --yes')
    expect(state().notice).toContain('bash-1')

    await controller.submit('/presets')
    expect(state().picker?.kind).toBe('preset')
    await controller.submit('/preset minimal')
    expect(state().agentPreset).toBe('minimal')
    await controller.submit('/preset standard')
    await controller.submit('/preset-read standard')
    expect(state().overlay?.title).toContain('Preset')
    await controller.submit('/preset-copy standard mine 我的副本')
    expect(state().picker?.kind).toBe('preset')
    await controller.submit('/preset-open mine')
    expect(state().notice).toContain('/presets/user')
    await controller.submit('/preset-remove mine --yes')
    expect(state().picker?.kind).toBe('preset')

    await controller.submit('/workspaces')
    expect(state().overlay?.title).toBe('Workspaces')
    await controller.submit('/workspace-new /data')
    expect(state().overlay?.title).toBe('Workspaces')
    await controller.submit('/workspace-rename workspace-1 新名字')
    expect(fake.workspaceRename).toHaveBeenCalledWith({ workspaceId: 'workspace-1', title: '新名字' })
    await controller.submit('/workspace-move workspace-1 end')
    expect(state().overlay?.title).toBe('Workspaces')
    await controller.submit('/workspace-session-move workspace-1 session-root end')
    expect(state().notice).toContain('已在 workspace 中移动')
    await controller.submit('/workspace-delete workspace-1 --yes')
    expect(fake.workspaceDelete).toHaveBeenCalled()
    await controller.submit('/archive --yes')
    expect(state().notice).toContain('已归档')

    await controller.submit('/skills')
    expect(state().overlay?.title).toBe('Skills')

    await controller.submit('/settings')
    expect(state().picker?.kind).toBe('settings')
    await controller.submit('/settings-show agent-loop --schema')
    expect(state().overlay?.title).toContain('agent-loop')
    await controller.submit('/settings-open')
    expect(state().notice).toContain('settings')
    await controller.submit('/settings-set agent-loop /limits/rounds 12')
    expect(fake.settingsMutate).toHaveBeenCalled()
    await controller.submit('/settings-unset agent-loop /limits --yes')
    expect(state().notice).toContain('已移除')
    await controller.submit('/settings-reset agent-loop --yes')
    expect(state().notice).toContain('已重置')

    await controller.submit('/goal 新目标')
    expect(fake.goalCreate).toHaveBeenCalledWith({ sessionId: SID, objective: '新目标' })
    await controller.submit('/goal-show')
    expect(state().overlay?.title).toBe('Goal')
    await controller.submit('/goal-edit 修改后目标')
    expect(state().notice).toContain('revision 2')
    await controller.submit('/goal-pause')
    expect(fake.goalPause).toHaveBeenCalled()
    await controller.submit('/goal-resume')
    expect(state().notice).toContain('resume')
    await controller.submit('/goal-complete')
    expect(state().notice).toContain('complete')
    await controller.submit('/goal-clear --yes')
    expect(state().notice).toContain('已清除')

    await controller.submit('/providers')
    expect(state().picker?.kind).toBe('provider')
    await controller.submit('/provider-models deepseek')
    expect(state().picker?.kind).toBe('model')
    await controller.submit('/discover-models llm-deepseek')
    expect(state().overlay?.title).toBe('Discovered Models')
    await controller.submit('/provider-add')
    expect(state().picker?.kind).toBe('provider-setup')

    const previousSecret = process.env.DSH_TUI_SWEEP_SECRET
    process.env.DSH_TUI_SWEEP_SECRET = 'sk-sweep'
    try {
      await controller.submit('/credentials DEEPSEEK_API_KEY OTHER_REF')
      expect(state().overlay?.title).toBe('Credentials')
      await controller.submit('/credential-set DEEPSEEK_API_KEY DSH_TUI_SWEEP_SECRET')
      expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'sk-sweep' })
      await controller.submit('/credential-unset DEEPSEEK_API_KEY --yes')
      expect(state().notice).toContain('已移除 credential')
    } finally {
      if (previousSecret === undefined) delete process.env.DSH_TUI_SWEEP_SECRET
      else process.env.DSH_TUI_SWEEP_SECRET = previousSecret
    }

    await controller.submit('/directories /work')
    expect(state().picker?.kind).toBe('directory')
    await controller.submit('/mkdir /work newdir')
    expect(state().notice).toContain('/work/newdir')
    await controller.submit('/open notes.md')
    expect(state().notice).toContain('/work/notes.md')

    await controller.submit('/plugins')
    expect(state().overlay?.lines[0]).toContain('entry-1')
    await controller.submit('/cordis')
    expect(state().overlay?.lines[0]).toContain('plugin-1')
    await controller.submit('/cordis-run plugin-1')
    expect(state().notice).toContain('插件已运行')
    await controller.submit('/cordis-stop plugin-1 --yes')
    expect(state().notice).toContain('插件已停止')
    await controller.submit('/cordis-remove plugin-1 --yes')
    expect(state().notice).toContain('插件已删除')

    await controller.submit('/feedback last negative 答非所问')
    expect(state().notice).toContain('feedback')
    await controller.submit('/feedback-clear last --yes')
    expect(state().notice).toContain('已删除 feedback')

    await controller.submit('/host')
    expect(state().overlay?.title).toBe('Host')
    await controller.submit('/permission danger-full-access')
    expect(fake.prompt).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SID, content: [{ type: 'text', text: '/permission danger-full-access' }],
    }))
    expect(state().notice).toBe('权限模式已切换为 danger-full-access')

    // Session-reloading commands come last: they rebuild the state from
    // history and would wipe the queue/jobs frames asserted above.
    await controller.submit('/sessions')
    expect(state().picker?.kind).toBe('session')
    // Rows render the Host-computed summary: cwd, composition preset, and a
    // read-only 子代理 marker for subagent lineage (see controller.spec).
    expect(state().picker?.items.map(item => item.value)).toEqual([SID])
    expect(state().picker?.items[0]?.description).toBe('/work · preset standard')
    controller.closePicker()
    await controller.submit('/subagents')
    expect(state().picker?.kind).toBe('subagent')
    controller.closePicker()
    await controller.submit('/fork 5')
    expect(state().sessionId).toBe(SID)
    await controller.submit('/resume session-root')
    expect(state().sessionId).toBe(SID)
    await controller.submit(`/subagent ${CHILD}`)
    expect(state().sessionId).toBe(CHILD)
    await controller.submit('/back')
    expect(state().sessionId).toBe(SID)

    controller.dispose()
  })

  it('surfaces a 命令失败 notice for broken arguments instead of crashing', async () => {
    const { controller } = await started(
      {
        mux: QUEUE_FRAME,
        jobs: [{ id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: 0 }],
      },
      allExtensions(),
    )
    const broken = [
      '/rename',
      '/fork abc',
      '/fork 1.5',
      '/fork -5',
      '/model nomiddle',
      '/model deepseek/chat low trailing-junk',
      '/resume nonexistent-id',
      '/queue-edit',
      '/queue-edit queued-m',
      '/queue-edit missing-id 文本',
      '/queue-remove queued-m',
      '/queue-remove --yes',
      '/queue-steer',
      '/job-kill',
      '/job-kill bash-1',
      '/preset-read',
      '/preset-copy standard',
      '/preset-open',
      '/preset-remove mine',
      '/workspace-new',
      '/workspace-rename workspace-1',
      '/workspace-delete workspace-1',
      '/workspace-move',
      '/workspace-session-move workspace-1',
      '/archive',
      '/settings-show',
      '/settings-show agent-loop --bogus',
      '/settings-show unknown-ns',
      '/settings-set agent-loop /p',
      '/settings-set agent-loop not-a-pointer 1',
      '/settings-set unknown-ns /p 1',
      '/settings-unset agent-loop /p',
      '/settings-reset',
      '/settings-reset unknown-ns --yes',
      '/goal',
      '/goal-edit',
      '/goal-clear',
      '/discover-models',
      '/discover-models llm-deepseek - - - - extra',
      '/credentials',
      '/credential-set ONLY_REF',
      '/credential-set REF DSH_TUI_DEFINITELY_UNSET',
      '/credential-set REF DSH_TUI_DEFINITELY_UNSET extra',
      '/credential-unset REF',
      '/mkdir /work',
      '/mkdir /work name extra',
      '/open',
      '/cordis-run',
      '/cordis-run plugin-1 pkg-1 extra',
      '/cordis-stop plugin-1',
      '/cordis-remove plugin-1',
      '/feedback',
      '/feedback last bogus-rating',
      '/feedback-clear',
      '/image',
      '/image definitely-missing.png',
      '/save-image',
      '/save-image sha256:image out.png extra',
      '/export first.zip second.zip',
      '/subagent nonexistent-id',
      '/back',
    ]
    for (const input of broken) {
      controller.setNotice(undefined)
      await expect(controller.submit(input)).resolves.toBe(true)
      expect(controller.getSnapshot().notice, `${input} should fail with a notice`).toMatch(/^命令失败：/)
    }
    controller.dispose()
  })
})

describe('regressions pinned by the sweep', () => {
  it('/queue-remove --yes requires an explicit item id even when one item matches', async () => {
    const { controller, fake } = await started({ mux: QUEUE_FRAME })
    expect(controller.getSnapshot().queueItems).toHaveLength(1)
    await controller.submit('/queue-remove --yes')
    expect(controller.getSnapshot().notice).toMatch(/^命令失败：用法/)
    expect(fake.updateQueue).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('/export honours the output path in either argument order', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-export-'))
    const previousCwd = process.cwd()
    process.chdir(work)
    try {
      const downloads = downloadsExt()
      const { controller } = await started({}, downloads)
      await controller.submit('/export --descendants custom-name.zip')
      expect(existsSync(join(work, 'custom-name.zip'))).toBe(true)
      expect(downloads.downloads?.sessionLog).toHaveBeenCalledWith(
        expect.objectContaining({ includeDescendants: true }), expect.anything(),
      )
      await controller.submit('/export second.zip --descendants')
      expect(existsSync(join(work, 'second.zip'))).toBe(true)
      await controller.submit('/export third.zip')
      expect(existsSync(join(work, 'third.zip'))).toBe(true)
      controller.dispose()
    } finally {
      process.chdir(previousCwd)
      await rm(work, { recursive: true, force: true })
    }
  })

  it('/image resolves relative paths against the session cwd like /open', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-image-'))
    const elsewhere = await mkdtemp(join(tmpdir(), 'dsh-sweep-image-else-'))
    const previousCwd = process.cwd()
    await writeFile(join(work, 'pic.png'), Buffer.from([137, 80, 78, 71]))
    process.chdir(elsewhere)
    try {
      const { controller, fake } = await started({ items: [summary(SID, { cwd: work })] })
      expect(controller.getSnapshot().cwd).toBe(work)
      // pic.png only exists in the session cwd; the process cwd is empty.
      await controller.submit('/image pic.png 说明')
      expect(fake.prompt).toHaveBeenCalledWith(expect.objectContaining({
        content: expect.arrayContaining([expect.objectContaining({ type: 'image', name: 'pic.png' })]),
      }))
      await controller.submit('/open pic.png')
      expect(controller.getSnapshot().notice).toContain(join(work, 'pic.png'))
      controller.dispose()
    } finally {
      process.chdir(previousCwd)
      await rm(work, { recursive: true, force: true })
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('/image pre-checks host image limits before reading and submitting', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-image-limit-'))
    const previousCwd = process.cwd()
    process.chdir(work)
    try {
      await writeFile(join(work, 'pic.gif'), Buffer.from('GIF89a'))
      await writeFile(join(work, 'big.png'), Buffer.from([137, 80, 78, 71]))
      const projection = {
        type: 'session/projection', sessionId: SID, key: 'imageLimits',
        value: {
          maxImagesPerMessage: 4, maxMessageImageBytes: 8_388_608,
          maxImageBytes: 2, mediaTypes: ['image/png', 'image/jpeg'],
        },
        seq: 1,
      } as never
      const { controller, fake } = await started({ items: [summary(SID, { cwd: work })], mux: projection })
      await controller.submit('/image pic.gif')
      expect(controller.getSnapshot().notice).toMatch(/宿主不允许 image\/gif 图片/)
      await controller.submit('/image big.png')
      expect(controller.getSnapshot().notice).toMatch(/超过宿主限额/)
      expect(fake.prompt).not.toHaveBeenCalled()
      controller.dispose()
    } finally {
      process.chdir(previousCwd)
      await rm(work, { recursive: true, force: true })
    }
  })

  it('/fork rejects a negative event sequence as usage', async () => {
    const { controller, fake } = await started()
    const fork = fake.api.sessions.fork as ReturnType<typeof vi.fn>
    await controller.submit('/fork -5')
    expect(controller.getSnapshot().notice).toMatch(/^命令失败：用法/)
    expect(fork).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('/model rejects extra whitespace-separated arguments instead of dropping them', async () => {
    const { controller, fake } = await started()
    await controller.submit('/model deepseek/chat low trailing-junk')
    expect(controller.getSnapshot().notice).toMatch(/^命令失败：用法/)
    expect(fake.selectModel).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('/discover-models accepts "-" as an omitted api-key-env placeholder', async () => {
    const { controller, fake } = await started()
    await controller.submit('/discover-models llm-deepseek - - - -')
    expect(fake.discoverModelsMock).toHaveBeenCalledWith({ settingsNs: 'llm-deepseek' })
    expect(controller.getSnapshot().overlay?.title).toBe('Discovered Models')
    controller.dispose()
  })

  it('/settings-set explains malformed JSON with usage guidance', async () => {
    const { controller, fake } = await started()
    await controller.submit('/settings-set agent-loop /limits {oops')
    expect(controller.getSnapshot().notice).toMatch(/^命令失败：JSON 值无效/)
    expect(controller.getSnapshot().notice).toContain('用法')
    expect(fake.settingsMutate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('/close with no open panel says so instead of staying silent', async () => {
    const { controller } = await started()
    await controller.submit('/close')
    expect(controller.getSnapshot().notice).toBe('当前没有打开的面板')
    // With a panel open it still closes without the notice.
    await controller.submit('/status')
    expect(controller.getSnapshot().overlay?.title).toBe('运行状态')
    await controller.submit('/close')
    expect(controller.getSnapshot().overlay).toBeUndefined()
    expect(controller.getSnapshot().notice).not.toBe('当前没有打开的面板')
    controller.dispose()
  })

  it('success notices survive the follow-up panel the command opens', async () => {
    const { controller } = await started()
    await controller.submit('/preset-remove mine --yes')
    expect(controller.getSnapshot().picker?.kind).toBe('preset')
    expect(controller.getSnapshot().notice).toBe('已删除用户 preset mine')
    controller.closePicker()
    await controller.submit('/preset-copy standard mine 副本')
    expect(controller.getSnapshot().notice).toBe('已创建用户 preset mine')
    controller.closePicker()
    await controller.submit('/workspace-new /data')
    expect(controller.getSnapshot().overlay?.title).toBe('Workspaces')
    expect(controller.getSnapshot().notice).toContain('已创建')
    await controller.submit('/workspace-rename workspace-1 新名字')
    expect(controller.getSnapshot().notice).toContain('已重命名为 新名字')
    await controller.submit('/workspace-move workspace-1 end')
    expect(controller.getSnapshot().notice).toContain('已移动 workspace workspace-1')
    await controller.submit('/workspace-delete workspace-1 --yes')
    expect(controller.getSnapshot().notice).toContain('已移除 workspace 注册 workspace-1')
    controller.dispose()
  })

  it('whole-remainder quoted arguments lose their quotes; mid-text quotes stay', async () => {
    const { controller, fake } = await started()
    await controller.submit('/rename "带引号 的标题"')
    expect(controller.getSnapshot().title).toBe('带引号 的标题')
    await controller.submit('/rename 前缀"引号"后缀')
    expect(controller.getSnapshot().title).toBe('前缀"引号"后缀')
    await controller.submit('/goal "带引号 的目标"')
    expect(fake.goalCreate).toHaveBeenCalledWith({ sessionId: SID, objective: '带引号 的目标' })
    controller.dispose()
  })

  it('/image rejects a readable non-image file by extension', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-txt-'))
    await writeFile(join(work, 'notes.txt'), 'hello')
    try {
      const { controller, fake } = await started({ items: [summary(SID, { cwd: work })] })
      await controller.submit('/image notes.txt')
      expect(controller.getSnapshot().notice).toContain('图片仅支持')
      expect(fake.prompt).not.toHaveBeenCalled()
      controller.dispose()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  })

  it('/save-image writes the decoded attachment to the requested path', async () => {
    const work = await mkdtemp(join(tmpdir(), 'dsh-sweep-save-'))
    const previousCwd = process.cwd()
    process.chdir(work)
    try {
      const { controller } = await started()
      await controller.submit('/save-image sha256:image out.png')
      expect(controller.getSnapshot().notice).toContain('out.png')
      expect(existsSync(join(work, 'out.png'))).toBe(true)
      controller.dispose()
    } finally {
      process.chdir(previousCwd)
      await rm(work, { recursive: true, force: true })
    }
  })
})
