/** In-process API orchestration for session startup and terminal actions. */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import { RpcId, type IApiClient, type MuxFrame, type RpcResponse, type SessionSummary } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TuiController } from '../src/controller.ts'

const SID = SessionId('session-root')
const CHILD = SessionId('session-child')

function ok<T>(value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: RpcId('response'), result: { ok: true, value } })
}

function summary(sessionId = SID, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { sessionId, updatedAt: 2, running: false, blank: false, cwd: '/work', ...overrides }
}

function providerSchema(): unknown {
  const model = Schema.object({ id: Schema.string().required(), name: Schema.string() })
  const profile = Schema.object({
    displayName: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref').description('Credential env/ref'),
    api: Schema.union(['openai-completions', 'anthropic-messages']).description('API protocol'),
    baseURL: Schema.string().description('Base URL'),
    models: Schema.array(model),
  })
  const s = Schema.object({ providers: Schema.dict(profile).default({}) })
  return (s as unknown as { toJSON(): unknown }).toJSON()
}

function deepseekProviderSchema(): unknown {
  return Schema.object({
    apiKeyEnv: Schema.string().role('credential-ref').default('DEEPSEEK_API_KEY'),
    baseURL: Schema.string(),
  }).toJSON()
}

function fakeApi(options: {
  items?: SessionSummary[]
  mux?: MuxFrame
  listError?: boolean
  hasMoreHistory?: boolean
  subagentHistoryError?: boolean
  jobs?: Array<{ id: string; kind: string; label: string; status: string; detail?: string; startedAt: number; finishedAt?: number }>
} = {}): {
  api: IApiClient
  create: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  cancel: ReturnType<typeof vi.fn>
  respond: ReturnType<typeof vi.fn>
  history: ReturnType<typeof vi.fn>
  updateQueue: ReturnType<typeof vi.fn>
  workspaceRename: ReturnType<typeof vi.fn>
  workspaceCreate: ReturnType<typeof vi.fn>
  workspaceDelete: ReturnType<typeof vi.fn>
  settingsMutate: ReturnType<typeof vi.fn>
  subagentPrompt: ReturnType<typeof vi.fn>
  goalPause: ReturnType<typeof vi.fn>
  credentialSet: ReturnType<typeof vi.fn>
  selectModel: ReturnType<typeof vi.fn>
  discoverModelsMock: ReturnType<typeof vi.fn>
} {
  let lists = 0
  const create = vi.fn(() => ok({ sessionId: SID, agentPreset: 'standard' }))
  const prompt = vi.fn(() => ok({ accepted: true as const, command: { kind: 'success' as const, text: '命令完成' } }))
  const cancel = vi.fn(() => ok({ accepted: true as const }))
  const respond = vi.fn(() => Promise.resolve({ accepted: true as const }))
  const updateQueue = vi.fn(() => ok({ accepted: true as const }))
  const workspaceRename = vi.fn((request: { workspaceId: string; title: string }) => ok({
    workspace: {
      workspaceId: request.workspaceId, path: '/work', title: request.title, sessionIds: [SID],
      createdAt: '2026-01-01', updatedAt: '2026-01-02',
    },
  }))
  const workspaceDelete = vi.fn(() => ok({ deleted: true as const }))
  const workspaceCreate = vi.fn((request: { path: string }) => ok({
    created: true,
    workspace: {
      workspaceId: 'workspace-1', path: request.path, title: 'work', sessionIds: [],
      createdAt: '2026-01-01', updatedAt: '2026-01-01',
    },
  }))
  const settingsMutate = vi.fn((request: { ns: string; expectedRevision?: number }) => ok({
    ns: request.ns, schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: (request.expectedRevision ?? 0) + 1,
  }))
  const subagentPrompt = vi.fn(() => ok({ messageId: 'subagent-message' }))
  const goalPause = vi.fn(() => ok({ ref: { id: 'goal-1', revision: 2 } }))
  const credentialSet = vi.fn(() => ok({}))
  const discoverModelsMock = vi.fn(() => ok({ models: [{ id: 'deepseek-chat', name: 'Chat' }] }))
  const selectModel = vi.fn((request: { provider: string; model: string; reasoningEffort?: string }) => ok({
    selected: {
      provider: request.provider, model: request.model,
      ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    },
  }))
  const history = vi.fn((request: { beforeSeq?: number }) => request.beforeSeq === undefined ? ok({
    events: [
      { event: {
        type: 'user/message', seq: 10, time: 10,
        data: { id: 'm1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '历史消息' }] },
      } },
      { event: {
        type: 'assistant/message', seq: 11, time: 11,
        data: {
          turn: 1, step: 1,
          message: {
            id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
            content: [{ type: 'text', text: '历史回答' }],
          },
        },
      } },
    ],
    hasMore: options.hasMoreHistory ?? false,
    projections: {
      asOfSeq: 11,
      values: {
        goal: {
          goal: { id: 'goal-1', revision: 1, objective: '完成 TUI', phase: 'active', maxGoalRounds: 3 },
          roundsStarted: 0, createdAt: 1, updatedAt: 1,
        },
        permissions: {
          options: [
            { value: 'workspace-write', name: 'workspace-write', description: 'Write inside the workspace; wider retries require approval.' },
            { value: 'danger-full-access', name: 'danger-full-access', description: 'Full file access without approval prompts.' },
          ],
          currentValue: 'workspace-write',
        },
        plan: { active: true, pending: false },
        contextPressure: { projectedTokens: 24_000, contextWindow: 120_000 },
        contextBreakdown: { systemTokens: 1000, toolsTokens: 2000, messageTokens: 3000 },
        tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
        sessionStats: { turns: 1, steps: 2 },
        imageLimits: { maxImagesPerMessage: 4, maxMessageImageBytes: 8_388_608 },
      },
    },
  }) : ok({
    events: [{ event: {
      type: 'user/message', seq: 0, time: 0,
      data: { id: 'older', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '更早消息' }] },
    } }],
    hasMore: false,
  }))
  const api = {
    sessions: {
      list: vi.fn(() => {
        lists += 1
        if (options.listError === true) {
          return Promise.resolve({
            rpcId: RpcId('list-error'),
            result: { ok: false as const, error: { code: 'internal' as const, message: 'list failed', details: {} } },
          })
        }
        const items = options.items ?? (lists === 1 ? [] : [summary()])
        return ok({ items })
      }),
      search: vi.fn(() => ok({ items: [], hasMore: false })),
      create,
      history,
      models: vi.fn(() => ok({
        current: { provider: 'deepseek', model: 'chat' }, routable: true,
        groups: [{
          id: 'deepseek', name: 'DeepSeek',
          models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }],
        }],
        failures: [],
      })),
      selectModel,
      rename: vi.fn((request: { title: string }) => ok({ title: request.title, seq: 3 })),
      fork: vi.fn(() => ok({ sessionId: SID })),
      prompt,
      attachment: vi.fn(() => ok({
        attachment: {
          attachmentId: 'sha256:image' as never,
          mediaType: 'image/png' as const,
          bytes: 3,
          width: 1,
          height: 1,
        },
        data: 'AQID',
      })),
      updateQueue,
      cancel,
    },
    events: {
      mux: async function *(payload: unknown, signal: AbortSignal, onOpen?: () => void) {
        void payload
        if (signal.aborted) return
        onOpen?.()
        if (options.mux !== undefined) yield { rpcId: RpcId('mux-frame'), payload: options.mux }
        if (options.jobs !== undefined) {
          yield { rpcId: RpcId('mux-frame'), payload: { type: 'session/jobs' as const, sessionId: SID, jobs: options.jobs } as never }
        }
      },
      host: async function *(payload: unknown, signal: AbortSignal) {
        void payload
        if (!signal.aborted) {
          yield { rpcId: RpcId('host-frame'), payload: { type: 'host/session-status' as const, sessionId: SID, running: true } }
        }
      },
    },
    host: {
      describe: vi.fn(() => ok({ version: 'test', cwd: '/work', attachedSessions: 1, canOpenPath: false })),
      listDirectory: vi.fn(() => ok({
        path: '/work', home: '/home/test', crumbs: [{ name: '/', path: '/', hidden: false }], entries: [], truncated: false,
      })),
      createDirectory: vi.fn((request: { path: string; name: string }) => ok({ path: `${request.path}/${request.name}` })),
      openPath: vi.fn(() => ok({ opened: true as const })),
    },
    workspace: {
      list: vi.fn(() => ok({ items: [], archivedSessionIds: [] })),
      create: workspaceCreate,
      rename: workspaceRename,
      delete: workspaceDelete,
      insertBefore: vi.fn(() => ok({ workspaceIds: ['workspace-1'] })),
      insertSessionBefore: vi.fn(() => ok({
        workspace: {
          workspaceId: 'workspace-1', path: '/work', title: 'work', sessionIds: [SID],
          createdAt: '2026-01-01', updatedAt: '2026-01-02',
        },
      })),
      archiveSession: vi.fn(() => ok({ archivedSessionIds: [SID] })),
    },
    skills: { list: vi.fn(() => ok({ skills: [{ name: 'review', description: 'Review code', modelInvocable: true }] })) },
    subagents: {
      list: vi.fn(() => ok({
        entries: [{ kind: 'child' as const, id: CHILD, mode: 'continuable' as const, label: 'worker', activity: 'inactive' as const, hasChildren: false }],
        parentAvailable: true,
      })),
      history: vi.fn(() => options.subagentHistoryError === true
        ? Promise.resolve({
          rpcId: RpcId('subagent-error'),
          result: { ok: false as const, error: { code: 'session-not-found' as const, message: 'child unavailable', details: {} } },
        })
        : ok({
          events: [{ event: {
            type: 'assistant/message', seq: 0, time: 0,
            data: {
              turn: 1, step: 1,
              message: {
                id: 'child-answer', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
                content: [{ type: 'text', text: '子代理回答' }],
              },
            },
          } }],
          hasMore: false,
        })),
      prompt: subagentPrompt,
      interrupt: vi.fn(() => ok({ accepted: true as const })),
    },
    agentPresets: {
      list: vi.fn(() => ok({
        presets: [
          { id: 'standard', trust: 'system', isDefault: true },
          { id: 'minimal', name: 'Minimal', trust: 'user', isDefault: false, description: '精简配置' },
        ],
        authorable: true,
        hasDocument: false,
      })),
      select: vi.fn((request: { agentPreset: string }) => ok({ agentPreset: request.agentPreset })),
      read: vi.fn((request: { agentPreset: string }) => ok({ agentPreset: request.agentPreset, trust: 'system' as const, content: '- name: test' })),
      copy: vi.fn((request: { agentPreset: string }) => ok({ agentPreset: request.agentPreset })),
      openDocument: vi.fn(() => ok({ opened: false as const, path: '/presets/user' })),
      remove: vi.fn(() => ok({})),
    },
    settings: {
      describe: vi.fn(() => ok({
        writable: true,
        hasDocument: true,
        namespaces: [
          { ns: 'agent-loop', schema: {}, value: {}, applies: 'live' as const, secrets: [], revision: 4 },
          {
            ns: 'llm-deepseek', schema: deepseekProviderSchema(),
            value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
            applies: 'live' as const, secrets: [], revision: 6,
          },
          {
            ns: 'llm-pi-ai', schema: providerSchema(), value: { providers: {} },
            applies: 'live' as const, secrets: [], revision: 8,
          },
        ],
      })),
      openDocument: vi.fn(() => ok({ opened: true as const })),
      mutate: settingsMutate,
      replace: vi.fn((request: { ns: string }) => ok({
        ns: request.ns, schema: {}, value: {}, applies: 'restart' as const, secrets: [], revision: 5,
      })),
    },
    goals: {
      edit: vi.fn(() => ok({ ref: { id: 'goal-1', revision: 2 } })),
      pause: goalPause,
      resume: vi.fn(() => ok({ ref: { id: 'goal-1', revision: 2 } })),
      complete: vi.fn(() => ok({ ref: { id: 'goal-1', revision: 2 } })),
      clear: vi.fn(() => ok({ cleared: true as const })),
    },
    llm: {
      providers: vi.fn(() => ok({
        providers: [{ provider: 'deepseek', displayName: 'DeepSeek', settingsNs: 'llm-deepseek', settingsPath: [], active: true }],
      })),
      models: vi.fn(() => ok({
        groups: [{
          id: 'deepseek', name: 'DeepSeek',
          models: [{ id: 'chat', name: 'Chat' }, { id: 'reasoner', name: 'Reasoner' }],
        }],
        failures: [],
      })),
      discoverModels: discoverModelsMock,
    },
    credentials: {
      describe: vi.fn((request: { refs: string[] }) => ok({
        credentials: Object.fromEntries(request.refs.map(ref => [ref, { configured: false, writable: true }])),
      })),
      set: credentialSet,
      unset: vi.fn(() => ok({})),
    },
    respond,
  } as unknown as IApiClient
  return {
    api, create, prompt, cancel, respond, history, updateQueue,
    workspaceRename, workspaceCreate, workspaceDelete, settingsMutate, subagentPrompt, goalPause, credentialSet, selectModel,
    discoverModelsMock,
  }
}

describe('TuiController', () => {
  it('creates a session, stitches stream frames over history, sends, cancels, and answers approvals', async () => {
    const approval: MuxFrame = {
      type: 'approval/requested', sessionId: SID, approvalId: 'approval-1' as never, toolName: 'bash', reason: '写入文件',
    }
    const fake = fakeApi({ mux: approval })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, cwd: '/work' })

    expect(fake.workspaceCreate).toHaveBeenCalledWith({ path: '/work' })
    expect(fake.create).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'ready', sessionId: SID, model: 'deepseek/chat',
      projections: { goal: { goal: { id: 'goal-1', phase: 'active' } } },
      interaction: { kind: 'approval', toolName: 'bash' },
    })
    await vi.waitFor(() => { expect(controller.getSnapshot().running).toBe(true) })
    expect(controller.getSnapshot().rows[0]?.text).toBe('历史消息')

    await expect(controller.send('/status')).resolves.toBe(true)
    expect(fake.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SID, mode: 'queue', content: [{ type: 'text', text: '/status' }],
    }))
    await controller.cancel()
    expect(fake.cancel).toHaveBeenCalledWith({ sessionId: SID })
    await controller.answerApproval('allowed-once')
    expect(fake.respond).toHaveBeenCalledWith({
      type: 'client-response', rpcId: RpcId('mux-frame'),
      result: { ok: true, value: { sessionId: SID, approvalId: 'approval-1', outcome: 'allowed-once' } },
    })
    controller.dispose()
  })

  it('hydrates and immediately updates the current session chrome', async () => {
    const fake = fakeApi({
      items: [summary(SID, {
        agentPreset: 'standard',
        projections: { asOfSeq: 2, values: { title: '已有标题' } },
      })],
    })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    expect(controller.getSnapshot()).toMatchObject({ title: '已有标题', agentPreset: 'standard' })
    await controller.submit('/rename 新标题')
    expect(controller.getSnapshot()).toMatchObject({ title: '新标题', projections: { title: '新标题' } })
    await controller.submit('/presets')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'preset', current: 'standard',
      items: [{ value: 'standard' }, { value: 'minimal' }],
    })
    controller.closePicker()
    await controller.submit('/preset')
    expect(controller.getSnapshot().picker?.kind).toBe('preset')
    await controller.choosePicker('minimal')
    expect(controller.getSnapshot()).toMatchObject({ agentPreset: 'minimal' })
    controller.dispose()
  })

  it('attaches a resumed session to the workspace for its recorded directory', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    expect(fake.workspaceCreate).toHaveBeenCalledWith({ path: '/work' })
    expect(fake.create).toHaveBeenCalledWith({ workspaceId: 'workspace-1', sessionId: SID })
    controller.dispose()
  })

  it('does not attach a resumed subagent as a workspace root session', async () => {
    const fake = fakeApi({ items: [summary(CHILD, { origin: 'subagent', parentSessionId: SID })] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: CHILD })

    expect(fake.workspaceCreate).not.toHaveBeenCalled()
    expect(fake.create).not.toHaveBeenCalled()
    expect(controller.getSnapshot().sessionId).toBe(CHILD)
    controller.dispose()
  })

  it('continues the latest root instead of a newer subagent', async () => {
    const fake = fakeApi({
      items: [summary(CHILD, { updatedAt: 10, origin: 'subagent', parentSessionId: SID }), summary(SID, { updatedAt: 5 })],
    })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: true })
    expect(fake.create).toHaveBeenCalledWith({ workspaceId: 'workspace-1', sessionId: SID })
    expect(fake.history).toHaveBeenCalledWith({ sessionId: SID, maxMessages: 100 })
    expect(controller.getSnapshot().sessionId).toBe(SID)
    controller.dispose()
  })

  it('folds each live mux frame exactly once', async () => {
    const fake = fakeApi({
      items: [summary()],
      mux: {
        type: 'session/event',
        sessionId: SID,
        event: {
          type: 'assistant/chunk',
          seq: 12,
          time: 12,
          data: { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: '单次增量' } },
        },
      },
    })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    expect(controller.getSnapshot().partialText).toBe('单次增量')
    controller.dispose()
  })

  it('refetches history when a reconnected mux reports a later durable sequence', async () => {
    let reopen: (() => void) | undefined
    const reopened = new Promise<void>((resolve) => { reopen = resolve })
    const fake = fakeApi({ items: [summary()] })
    Object.assign(fake.api.events, {
      mux: async function *(_payload: unknown, signal: AbortSignal, onOpen?: () => void) {
        if (signal.aborted) return
        onOpen?.()
        yield {
          rpcId: RpcId('subscription-1'),
          payload: { type: 'session/subscribed' as const, sessionId: SID, lastSeq: 11 },
        }
        await reopened
        if (signal.aborted) return
        onOpen?.()
        yield {
          rpcId: RpcId('subscription-2'),
          payload: { type: 'session/subscribed' as const, sessionId: SID, lastSeq: 12 },
        }
      },
    })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })
    fake.history.mockResolvedValue({
      rpcId: RpcId('reconnected-history'),
      result: {
        ok: true,
        value: {
          events: [{ event: {
            type: 'user/message', seq: 12, time: 12,
            data: {
              id: 'reconnected-message', role: 'user', source: { kind: 'user' },
              content: [{ type: 'text', text: '断线期间消息' }],
            },
          } }],
          hasMore: false,
          projections: { asOfSeq: 12, values: {} },
        },
      },
    } as never)

    reopen?.()

    await vi.waitFor(() => { expect(fake.history).toHaveBeenCalledTimes(2) })
    await vi.waitFor(() => { expect(controller.getSnapshot().rows.at(-1)?.text).toBe('断线期间消息') })
    controller.dispose()
  })

  it('loads and refolds an older history page at the durable sequence boundary', async () => {
    const fake = fakeApi({ items: [summary()], hasMoreHistory: true })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/older')

    expect(fake.history).toHaveBeenLastCalledWith({ sessionId: SID, beforeSeq: 10, maxMessages: 100 })
    expect(controller.getSnapshot().rows.map(row => row.text)).toEqual(['更早消息', '历史消息', '历史回答'])
    await controller.submit('/older')
    expect(controller.getSnapshot().notice).toContain('到达 transcript 起点')
    expect(fake.history).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('answers structured questions and surfaces startup business errors', async () => {
    const question: MuxFrame = {
      type: 'question/requested', sessionId: SID, questions: [{ id: 'mode', question: '模式？', options: [{ label: '快' }] }],
    }
    const fake = fakeApi({ items: [summary()], mux: question })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })
    await controller.answerQuestion({ answers: [{ id: 'mode', selected: ['快'] }] })
    expect(fake.respond).toHaveBeenCalledWith({
      type: 'client-response', rpcId: RpcId('mux-frame'),
      result: { ok: true, value: { sessionId: SID, answer: { answers: [{ id: 'mode', selected: ['快'] }] } } },
    })
    controller.dispose()

    const cancelledFake = fakeApi({ items: [summary()], mux: question })
    const cancelled = new TuiController(cancelledFake.api)
    await cancelled.start({ continueLatest: false, resume: SID })
    await cancelled.cancelQuestion()
    expect(cancelledFake.respond).toHaveBeenCalledWith({
      type: 'client-response', rpcId: RpcId('mux-frame'),
      result: {
        ok: false,
        error: { code: 'cancelled', message: 'the user closed this question request', details: {} },
      },
    })
    cancelled.dispose()

    const failed = new TuiController(fakeApi({ listError: true }).api)
    await failed.start({ continueLatest: false })
    expect(failed.getSnapshot()).toMatchObject({ phase: 'error', notice: 'internal: list failed' })
    failed.dispose()
  })

  it('handles terminal-native management commands and forwards unknown slash commands', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await expect(controller.submit('/help')).resolves.toBe(true)
    expect(controller.getSnapshot().overlay?.title).toBe('TUI 命令')
    expect(controller.getSnapshot().overlay?.lines.some(line => line.includes('/permission'))).toBe(true)
    await controller.submit('/models')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'model', current: 'deepseek/chat',
      items: [{ value: 'deepseek/chat' }, { value: 'deepseek/reasoner' }],
    })
    controller.closePicker()
    await controller.submit('/model')
    expect(controller.getSnapshot().picker?.kind).toBe('model')
    await controller.choosePicker('deepseek/reasoner')
    expect(fake.selectModel).toHaveBeenLastCalledWith({
      sessionId: SID, provider: 'deepseek', model: 'reasoner',
    })
    expect(controller.getSnapshot().picker).toBeUndefined()
    await controller.submit('/model deepseek/reasoner high')
    expect(controller.getSnapshot().model).toBe('deepseek/reasoner')
    await controller.submit('/permission')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'permission', current: 'workspace-write',
      items: [{ value: 'workspace-write' }, { value: 'danger-full-access' }],
    })
    await controller.choosePicker('danger-full-access')
    expect(fake.prompt).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: SID, content: [{ type: 'text', text: '/permission danger-full-access' }],
    }))
    expect(controller.getSnapshot().picker).toBeUndefined()
    await controller.submit('/permission')
    expect(controller.getSnapshot().picker).toMatchObject({ kind: 'permission', current: 'workspace-write' })
    await controller.choosePicker('workspace-write')
    expect(fake.prompt).not.toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: '/permission workspace-write' }],
    }))
    expect(controller.getSnapshot().picker).toBeUndefined()
    await controller.submit('/skills')
    expect(controller.getSnapshot().overlay?.lines[0]).toContain('/review')
    await controller.submit('/settings')
    const settingsItems = controller.getSnapshot().picker?.items.map(item => item.value)
    expect(controller.getSnapshot().picker).toMatchObject({ kind: 'settings' })
    expect(settingsItems).toContain('agent-loop')
    expect(settingsItems).toContain('llm-deepseek')
    await controller.choosePicker('agent-loop')
    expect(controller.getSnapshot().overlay?.title).toBe('Settings · agent-loop')
    await controller.submit('/settings-show agent-loop --schema')
    expect(controller.getSnapshot().overlay?.lines).toContain('有效值')
    expect(controller.getSnapshot().overlay?.lines).toContain('Schema')
    await controller.submit('/host')
    expect(controller.getSnapshot().overlay?.lines).toContain('版本：test')
    await controller.submit('/status')
    expect(controller.getSnapshot().overlay).toMatchObject({ title: '运行状态' })
    expect(controller.getSnapshot().overlay?.lines).toContain('权限：workspace-write')
    expect(controller.getSnapshot().overlay?.lines).toContain('上下文：20% · 24,000/120,000 tokens')
    await controller.submit('/close')
    expect(controller.getSnapshot().overlay).toBeUndefined()

    await controller.submit('/compact')
    expect(fake.prompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SID, content: [{ type: 'text', text: '/compact' }],
    }))
    controller.dispose()
  })

  it('switches permission through the local Host extension instead of forwarding chat', async () => {
    const fake = fakeApi({ items: [summary()] })
    const permission = vi.fn<(_id: SessionId, preset: string) => Promise<string>>(
      async (_id, preset) => `权限模式已切换为 ${preset}`,
    )
    const controller = new TuiController(fake.api, { permission: { set: permission } })
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/permission danger-full-access')
    expect(permission).toHaveBeenCalledWith(SID, 'danger-full-access')
    // The local extension switch must not fall through to a model prompt.
    expect(fake.prompt).not.toHaveBeenCalledWith(expect.objectContaining({
      content: [{ type: 'text', text: '/permission danger-full-access' }],
    }))
    expect(controller.getSnapshot().picker).toBeUndefined()

    // A preset that is already current short-circuits and never calls set.
    permission.mockClear()
    await controller.submit('/permission')
    expect(controller.getSnapshot().picker).toMatchObject({ kind: 'permission', current: 'workspace-write' })
    await controller.choosePicker('workspace-write')
    expect(permission).not.toHaveBeenCalled()
    expect(controller.getSnapshot().picker).toBeUndefined()
    controller.dispose()
  })

  it('lists jobs and kills a background job through the jobs extension', async () => {
    const killJob = vi.fn(() => Promise.resolve({ status: 'requested' as const }))
    const fake = fakeApi({
      items: [summary()],
      jobs: [
        { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: 0 },
        { id: 'bash-2', kind: 'bash', label: 'build', status: 'failed', detail: 'exit code 3', startedAt: 0, finishedAt: 1 },
      ],
    })
    const controller = new TuiController(fake.api, { jobs: { kill: killJob } })
    await controller.start({ continueLatest: false, resume: SID })
    expect(controller.getSnapshot().jobs).toHaveLength(2)

    await controller.submit('/jobs')
    expect(controller.getSnapshot().overlay?.title).toContain('Jobs')
    expect(controller.getSnapshot().overlay?.lines.some(line => line.includes('bash-1'))).toBe(true)
    expect(controller.getSnapshot().overlay?.lines.some(line => line.includes('failed'))).toBe(true)
    await controller.submit('/close')

    await controller.submit('/job-kill bash-1 --yes')
    expect(killJob).toHaveBeenCalledWith('bash-1', expect.stringContaining('TUI'))
    expect(controller.getSnapshot().notice).toContain('bash-1')

    // kill requires --yes and a matching id.
    controller.setNotice(undefined)
    await expect(controller.submit('/job-kill bash-2')).resolves.toBe(true)
    expect(controller.getSnapshot().notice).toContain('--yes')
    controller.dispose()
  })

  it('opens resume as a keyboard picker and switches to the selected session', async () => {
    const fake = fakeApi({ items: [summary(), summary(CHILD, { updatedAt: 1 })] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })
    fake.workspaceCreate.mockClear()
    fake.create.mockClear()

    await controller.submit('/sessions')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'session', current: SID,
      items: [{ value: SID }, { value: CHILD }],
    })
    controller.closePicker()
    await controller.submit('/resume')
    expect(controller.getSnapshot().picker?.kind).toBe('session')
    await controller.choosePicker(CHILD)
    expect(fake.workspaceCreate).toHaveBeenCalledWith({ path: '/work' })
    expect(fake.create).toHaveBeenCalledWith({ workspaceId: 'workspace-1', sessionId: CHILD })
    expect(controller.getSnapshot()).toMatchObject({ sessionId: CHILD, picker: undefined })
    controller.dispose()
  })

  it('hides blank sessions from pickers but keeps the loaded one visible', async () => {
    const BLANK = SessionId('session-blank')
    const fake = fakeApi({ items: [summary(), summary(BLANK, { blank: true, updatedAt: 1 })] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/sessions')
    expect(controller.getSnapshot().picker?.items.map(item => item.value)).toEqual([SID])

    await controller.submit(`/resume ${BLANK}`)
    expect(controller.getSnapshot().sessionId).toBe(BLANK)

    await controller.submit('/sessions')
    expect(controller.getSnapshot().picker?.items.map(item => item.value)).toEqual([SID, BLANK])
    controller.dispose()
  })

  it('mutates queue items by stable id and requires confirmation before removal', async () => {
    const fake = fakeApi({
      items: [summary()],
      mux: {
        type: 'session/queue', sessionId: SID,
        items: [{
          id: 'queued-message-1' as never,
          placement: 'queued',
          message: {
            id: 'queued-message-1' as never, role: 'user', source: { kind: 'user' },
            content: [{ type: 'text', text: '旧内容' }],
          },
        }],
      },
    })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    expect(controller.getSnapshot()).toMatchObject({ queueSize: 1 })
    await controller.submit('/queue-edit queued 新内容')
    expect(fake.updateQueue).toHaveBeenCalledWith(expect.objectContaining({
      itemId: 'queued-message-1', action: { kind: 'edit', content: [{ type: 'text', text: '新内容' }] },
    }))
    await controller.submit('/queue-remove queued')
    expect(fake.updateQueue).toHaveBeenCalledTimes(1)
    expect(controller.getSnapshot().notice).toContain('--yes')
    await controller.submit('/queue-remove queued --yes')
    expect(fake.updateQueue).toHaveBeenLastCalledWith(expect.objectContaining({ action: { kind: 'remove' } }))
    controller.dispose()
  })

  it('routes workspace, preset, and revision-guarded settings mutations', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/workspace-rename workspace-1 New Workspace')
    expect(fake.workspaceRename).toHaveBeenCalledWith({ workspaceId: 'workspace-1', title: 'New Workspace' })
    await controller.submit('/workspace-delete workspace-1')
    expect(fake.workspaceDelete).not.toHaveBeenCalled()
    await controller.submit('/workspace-delete workspace-1 --yes')
    expect(fake.workspaceDelete).toHaveBeenCalledWith({ workspaceId: 'workspace-1' })

    await controller.submit('/preset-read standard')
    expect(controller.getSnapshot().overlay?.lines).toContain('- name: test')
    await controller.submit('/settings-set agent-loop /limits/rounds 12')
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'agent-loop', ops: [{ op: 'set', path: ['limits', 'rounds'], value: 12 }], expectedRevision: 4,
    })

    await controller.submit('/goal-pause')
    expect(fake.goalPause).toHaveBeenCalledWith({
      sessionId: SID, ref: { id: 'goal-1', revision: 1 },
    })
    await controller.submit('/providers')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'provider', items: [{ value: 'deepseek' }],
    })
    await controller.choosePicker('deepseek')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'model', items: [{ value: 'deepseek/chat' }, { value: 'deepseek/reasoner' }],
    })
    await controller.choosePicker('deepseek/reasoner')
    expect(fake.selectModel).toHaveBeenLastCalledWith({
      sessionId: SID, provider: 'deepseek', model: 'reasoner',
    })
    await controller.submit('/provider-models deepseek')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'model', items: [{ value: 'deepseek/chat' }, { value: 'deepseek/reasoner' }],
    })
    await controller.submit('/directories')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'directory', items: [{ value: '/' }],
    })
    const previousSecret = process.env.DSH_TUI_TEST_SECRET
    process.env.DSH_TUI_TEST_SECRET = 'secret-value'
    try {
      await controller.submit('/credential-set DEEPSEEK_API_KEY DSH_TUI_TEST_SECRET')
      expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'secret-value' })
    } finally {
      if (previousSecret === undefined) delete process.env.DSH_TUI_TEST_SECRET
      else process.env.DSH_TUI_TEST_SECRET = previousSecret
    }
    controller.dispose()
  })

  it('adds a custom provider via the /provider-add fast path (provider-id + flags)', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    const previousSecret = process.env.DSH_TUI_TEST_SECRET
    process.env.DSH_TUI_TEST_SECRET = 'sk-test'
    const previousKey = process.env.GATEWAY_API_KEY
    process.env.GATEWAY_API_KEY = 'gw-secret'
    try {
      await controller.submit(
        '/provider-add my-gateway --base-url https://gateway.example/v1 --api openai-completions --key-env GATEWAY_API_KEY --discover',
      )
    } finally {
      if (previousKey === undefined) delete process.env.GATEWAY_API_KEY
      else process.env.GATEWAY_API_KEY = previousKey
      if (previousSecret === undefined) delete process.env.DSH_TUI_TEST_SECRET
      else process.env.DSH_TUI_TEST_SECRET = previousSecret
    }

    expect(fake.discoverModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.example/v1', api: 'openai-completions', apiKey: 'gw-secret',
    }))
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'my-gateway'],
        value: {
          baseURL: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKeyEnv: 'MY_GATEWAY_API_KEY',
          models: [{ id: 'deepseek-chat', name: 'Chat' }],
        },
      }],
      expectedRevision: 8,
    })
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'MY_GATEWAY_API_KEY', value: 'gw-secret' })
    expect(controller.getSnapshot().notice).toContain('my-gateway')
    controller.dispose()
  })

  it('rejects an unknown flag on /provider-add and does not write', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/provider-add my-gateway --bogus 1')
    expect(fake.settingsMutate).not.toHaveBeenCalled()
    expect(controller.getSnapshot().notice).toContain('无法识别的参数')
    controller.dispose()
  })

  it('interactively adds a custom provider: pick custom, fill fields, fetch models, confirm', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    // The entry picker lists installed catalog providers plus a "custom" row.
    await controller.submit('/provider-add')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'provider-setup', items: [
        expect.objectContaining({ value: 'deepseek', label: 'DeepSeek' }),
        expect.objectContaining({ label: expect.stringContaining('自定义') }),
      ],
    })

    // Pick the custom entry → the wizard opens under the resolved profiles ns.
    await controller.choosePicker('\u0000custom-provider')
    const wizard = controller.getSnapshot().providerWizard
    expect(wizard?.namespace).toBe('llm-pi-ai')
    expect(wizard?.settingsPath).toEqual(['providers'])
    expect(wizard?.providerId).toBe('')

    controller.submitProviderWizardValue('providerId', 'my-gateway')
    controller.submitProviderWizardValue('baseURL', 'https://gateway.example/v1')
    controller.chooseProviderWizardRow(0) // Host-schema protocol selector
    controller.submitProviderWizardValue('apiKey', 'sk-test')
    controller.submitProviderWizardValue('models', '') // blank asks the Host to discover

    await vi.waitFor(() => {
      expect(controller.getSnapshot().providerWizard).toMatchObject({ step: 'review', candidates: [{ id: 'deepseek-chat' }] })
    })
    controller.chooseProviderWizardRow(0)
    await vi.waitFor(() => { expect(fake.settingsMutate).toHaveBeenCalled() })

    expect(fake.discoverModelsMock).toHaveBeenCalledWith(expect.objectContaining({
      settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.example/v1', api: 'openai-completions', apiKey: 'sk-test',
    }))
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai',
      ops: [{
        op: 'set',
        path: ['providers', 'my-gateway'],
        value: {
          baseURL: 'https://gateway.example/v1',
          api: 'openai-completions',
          apiKeyEnv: 'MY_GATEWAY_API_KEY',
          models: [{ id: 'deepseek-chat', name: 'Chat' }],
        },
      }],
      expectedRevision: 8,
    })
    // The typed key value is stored through the credential seam.
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'MY_GATEWAY_API_KEY', value: 'sk-test' })
    await vi.waitFor(() => { expect(controller.getSnapshot().providerWizard).toBeUndefined() })
    expect(controller.getSnapshot().notice).toContain('my-gateway')
    expect(controller.getSnapshot().notice).not.toContain('sk-test')
    controller.dispose()
  })

  it('configures a catalog provider with one focused API-key prompt', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/provider-add')
    // A catalog (non-declared) provider row shows its name, not a namespace.
    const picker = controller.getSnapshot().picker
    expect(picker?.kind).toBe('provider-setup')
    expect(picker?.items[0]).toMatchObject({ value: 'deepseek', label: 'DeepSeek' })

    // Like pi /login: choosing a provider immediately focuses one credential prompt.
    await controller.choosePicker('deepseek')
    expect(controller.getSnapshot().providerWizard).toMatchObject({
      kind: 'existing', providerId: 'deepseek', namespace: 'llm-deepseek',
      settingsPath: [], credentialRef: 'DEEPSEEK_API_KEY', step: 'credential', editing: 'apiKey',
    })
    controller.submitProviderWizardValue('apiKey', 'new-key')
    await vi.waitFor(() => { expect(controller.getSnapshot().providerWizard).toBeUndefined() })
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'DEEPSEEK_API_KEY', value: 'new-key' })
    controller.dispose()
  })

  it('supports cancelling the provider wizard without writing', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/provider-add')
    await controller.choosePicker('\u0000custom-provider')
    expect(controller.getSnapshot().providerWizard).toBeDefined()
    controller.cancelProviderWizard()
    expect(controller.getSnapshot().providerWizard).toBeUndefined()
    expect(fake.settingsMutate).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('navigates a continuable subagent transcript, prompts it, and returns to the parent', async () => {
    const fake = fakeApi({ items: [summary()] })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/subagents')
    expect(controller.getSnapshot().picker).toMatchObject({
      kind: 'subagent', items: [{ value: CHILD }],
    })
    controller.closePicker()
    await controller.submit('/subagent')
    expect(controller.getSnapshot().picker?.kind).toBe('subagent')
    await controller.choosePicker(CHILD)
    expect(controller.getSnapshot()).toMatchObject({ sessionId: CHILD, phase: 'ready' })
    expect(controller.getSnapshot().rows.at(-1)?.text).toBe('子代理回答')
    await controller.send('继续检查')
    expect(fake.subagentPrompt).toHaveBeenCalledWith(expect.objectContaining({
      parentSessionId: SID, childSessionId: CHILD, mode: 'continuable',
      content: [{ type: 'text', text: '继续检查' }],
    }))
    await controller.submit('/back')
    expect(controller.getSnapshot().sessionId).toBe(SID)
    controller.dispose()
  })

  it('keeps the parent navigation target when child history cannot load', async () => {
    const fake = fakeApi({ items: [summary()], subagentHistoryError: true })
    const controller = new TuiController(fake.api)
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/subagent session-child')
    expect(controller.getSnapshot()).toMatchObject({ sessionId: SID, phase: 'ready' })
    expect(controller.getSnapshot().notice).toContain('child unavailable')
    await controller.send('仍发送给父会话')
    expect(fake.prompt).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: SID, content: [{ type: 'text', text: '仍发送给父会话' }],
    }))
    expect(fake.subagentPrompt).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('records assistant feedback and uses host-only export and image intake', async () => {
    const fake = fakeApi({ items: [summary()] })
    const feedback = {
      list: vi.fn(() => Promise.resolve({ ok: true as const, value: { items: [] } })),
      put: vi.fn(() => Promise.resolve({
        ok: true as const,
        value: {
          messageId: 'assistant-1' as never, rating: 'positive' as const,
          version: 'feedback-v1' as never, createdAt: 1, updatedAt: 1,
        },
      })),
      delete: vi.fn(),
    }
    const downloads = {
      sessionLog: vi.fn(() => Promise.resolve(new Response('zip-bytes', { status: 200 }))),
    }
    const controller = new TuiController(fake.api, { feedback, downloads })
    await controller.start({ continueLatest: false, resume: SID })
    await controller.submit('/feedback last positive 清晰')
    expect(feedback.put).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: SID, messageId: 'assistant-1', rating: 'positive', note: '清晰', ifVersion: null,
    }))

    const directory = await mkdtemp(join(tmpdir(), 'dsh-tui-controller-'))
    try {
      const imagePath = join(directory, 'pixel.png')
      const exportPath = join(directory, 'session.zip')
      const savedImagePath = join(directory, 'saved.png')
      await writeFile(imagePath, Uint8Array.of(1, 2, 3))
      await controller.submit(`/image "${imagePath}" 截图`)
      expect(fake.prompt).toHaveBeenLastCalledWith(expect.objectContaining({
        content: [
          { type: 'text', text: '截图' },
          { type: 'image', mediaType: 'image/png', data: 'AQID', name: 'pixel.png' },
        ],
      }))
      await controller.submit(`/save-image sha256:image "${savedImagePath}"`)
      expect(await readFile(savedImagePath)).toEqual(Buffer.from([1, 2, 3]))
      await controller.submit(`/export "${exportPath}" --descendants`)
      expect(downloads.sessionLog).toHaveBeenCalledWith(
        { sessionId: SID, includeDescendants: true }, expect.any(AbortSignal),
      )
      expect(await readFile(exportPath, 'utf8')).toBe('zip-bytes')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
    controller.dispose()
  })

  it('shows Host plugin state and drives confirmed host-only Cordis controls', async () => {
    const fake = fakeApi({ items: [summary()] })
    const cordis = {
      inventory: vi.fn(() => [{
        pluginId: 'demo-plugin',
        agentId: SID,
        packages: [{
          packageId: 'demo-package', name: 'Demo', purpose: 'test', hasHostHalf: true, hasClientHalf: false,
        }],
      }]),
      runHostOnly: vi.fn(() => Promise.resolve('Cordis run 已完成')),
      stop: vi.fn(() => Promise.resolve('已停止')),
      remove: vi.fn(() => Promise.resolve('已删除')),
    }
    const plugins = {
      list: vi.fn(() => [{ entryId: 'api-gateway', moduleName: '@deepseek-ai/dsh-host-apiproxy', enabled: true, fiberPhase: 'active' }]),
    }
    const controller = new TuiController(fake.api, { cordis, plugins })
    await controller.start({ continueLatest: false, resume: SID })

    await controller.submit('/plugins')
    expect(controller.getSnapshot().overlay?.lines[0]).toContain('api-gateway')
    await controller.submit('/cordis-run demo-plugin demo-package')
    expect(cordis.runHostOnly).toHaveBeenCalledWith(SID, 'demo-plugin', 'demo-package')
    expect(controller.getSnapshot().notice).toBe('Cordis run 已完成')
    await controller.submit('/cordis-stop demo-plugin')
    expect(cordis.stop).not.toHaveBeenCalled()
    await controller.submit('/cordis-stop demo-plugin --yes')
    expect(cordis.stop).toHaveBeenCalledWith(SID, 'demo-plugin')
    await controller.submit('/cordis-remove demo-plugin --yes')
    expect(cordis.remove).toHaveBeenCalledWith(SID, 'demo-plugin')
    controller.dispose()
  })
})
