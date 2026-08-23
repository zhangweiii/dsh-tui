/**
 * Shared in-process fake of the Host ApiProxy client used by controller and
 * command-sweep specs: every RPC resolves with a deterministic ok() payload,
 * and the returned vi.fn handles let tests assert individual calls.
 */

import { vi } from 'vitest'
import Schema from '@deepseek-ai/schemastery'
import {
  RpcId, type HostFrame, type IApiClient, type MuxFrame, type RpcResponse, type SessionSummary,
} from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId } from '@deepseek-ai/dsh-session'

export const SID = SessionId('session-root')
export const CHILD = SessionId('session-child')

export function ok<T>(value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: RpcId('response'), result: { ok: true, value } })
}

export function summary(sessionId = SID, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId, updatedAt: 2, running: false, blank: false, cwd: '/work',
    // The fake deployment composes presets (`sessions.create` answers
    // `agentPreset: 'standard'`), so the header passthrough mirrors it.
    agentPreset: 'standard',
    ...overrides,
  }
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

export function fakeApi(options: {
  items?: SessionSummary[]
  listItemsByCall?: SessionSummary[][]
  mux?: MuxFrame
  hostFrames?: HostFrame[]
  hostReopens?: Promise<void>[]
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
  goalCreate: ReturnType<typeof vi.fn>
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
  const goalCreate = vi.fn(() => ok({ ref: { id: 'goal-1', revision: 1 } }))
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
        const sequenced = options.listItemsByCall?.[Math.min(lists - 1, options.listItemsByCall.length - 1)]
        const items = sequenced ?? options.items ?? (lists === 1 ? [] : [summary()])
        return ok({ items })
      }),
      search: vi.fn(() => ok({ items: [], hasMore: false })),
      create,
      history,
      models: vi.fn(() => ok({
        current: { provider: 'deepseek', model: 'chat' }, routable: true,
        groups: [{
          id: 'deepseek', name: 'DeepSeek',
          models: [
            { id: 'chat', name: 'Chat' },
            {
              id: 'reasoner', name: 'Reasoner',
              reasoning: {
                efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
                defaultEffort: 'low',
              },
            },
          ],
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
      host: async function *(payload: unknown, signal: AbortSignal, onOpen?: () => void) {
        void payload
        if (signal.aborted) return
        onOpen?.()
        const frames = options.hostFrames ?? [{ type: 'host/session-status' as const, sessionId: SID, running: true }]
        for (const frame of frames) yield { rpcId: RpcId('host-frame'), payload: frame }
        for (const reopen of options.hostReopens ?? []) {
          await reopen
          if (signal.aborted) return
          onOpen?.()
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve()
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      },
    },
    host: {
      describe: vi.fn(() => ok({ version: 'test', cwd: '/work', home: '/home/test', attachedSessions: 1, canOpenPath: false })),
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
      create: goalCreate,
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
    workspaceRename, workspaceCreate, workspaceDelete, settingsMutate, subagentPrompt, goalPause, goalCreate, credentialSet, selectModel,
    discoverModelsMock,
  }
}
