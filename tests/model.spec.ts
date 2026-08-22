/** Pure history/live-frame projection into terminal render state. */

import { describe, expect, it } from 'vitest'
import { RpcId, type MuxFrame } from '@deepseek-ai/dsh-host-apiproxy'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyHistory, applyHostFrame, applyMuxFrame, applySessionEvent, createInitialState, isCollapsibleRow,
  isExpandedRow, projectionStatus, toggleFold, type TuiViewState,
} from '../src/model.ts'

const SID = SessionId('session-tui')
const event = (type: SessionEvent['type'], seq: number, data: unknown): SessionEvent => ({
  type, seq, time: seq, data,
} as SessionEvent)

describe('tui view projection', () => {
  it('folds user, streaming assistant, final reasoning, and deduplicated history', () => {
    let state = createInitialState()
    state = applySessionEvent(state, event('user/message', 0, {
      id: 'user-1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }],
    }))
    state = applySessionEvent(state, event('assistant/chunk', 1, {
      turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: '流式' },
    }))
    expect(state.partialText).toBe('流式')
    state = applySessionEvent(state, event('assistant/message', 2, {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'reasoning', text: '先想' }, { type: 'text', text: '答案' }],
      },
    }))
    expect(state.rows.map(row => [row.kind, row.text])).toEqual([
      ['user', '你好'], ['reasoning', '先想'], ['assistant', '答案'],
    ])
    expect(state.rows.at(-1)?.messageId).toBe('assistant-1')
    expect(state.partialText).toBe('')
    expect(applySessionEvent(state, event('assistant/message', 2, {}))).toBe(state)
  })

  it('marks the delivered prefix of a cancelled stream as interrupted from the durable marker', () => {
    let state = createInitialState()
    state = applySessionEvent(state, event('assistant/message', 3, {
      turn: 2,
      step: 1,
      interrupted: true,
      message: {
        id: 'assistant-interrupted', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [{ type: 'text', text: '被取消的答案前缀' }],
      },
    }))
    expect(state.rows.at(-1)).toMatchObject({
      kind: 'assistant', text: '被取消的答案前缀', status: 'interrupted',
    })
  })

  it('updates one tool row from call to result and records todos and turn failures', () => {
    const call = event('tool/call', 0, {
      turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}',
    })
    const result = event('tool/result', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
        content: [{ type: 'tool-result', toolCallId: 'call-1', content: [{ type: 'text', text: '/work' }], isError: false }],
      },
    })
    let state = applyHistory(createInitialState(), [{ event: call }, { event: result }])
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({ kind: 'tool', text: 'bash', detail: '/work', status: 'completed' })

    state = applySessionEvent(state, event('todo/write', 2, {
      todos: [{ content: '完成 TUI', status: 'in_progress' }],
    }))
    state = applySessionEvent(state, event('turn/end', 3, {
      turn: 1, reason: { kind: 'error', error: { code: 'MODEL', message: '不可用' } },
    }))
    expect(state.todos).toEqual([{ content: '完成 TUI', status: 'in_progress' }])
    expect(state.lastTurnEnd).toEqual({ seq: 3, turn: 1, kind: 'error' })
    expect(state.rows.at(-1)).toMatchObject({ kind: 'error', text: 'MODEL: 不可用' })
  })

  it('shows injected context and skips surface replacement checkpoints', () => {
    let state = applySessionEvent(createInitialState(), event('user/message', 0, {
      id: 'context-1', role: 'user',
      source: { kind: 'plugin', plugin: 'scheduler', form: 'notice', summary: '定时任务已触发' },
      content: [{ type: 'text', text: '模型可见的附加上下文' }],
    }))
    const replacement = {
      ...event('user/message', 1, {
        id: 'compact-checkpoint', role: 'user', source: { kind: 'plugin', plugin: 'compaction' },
        content: [{ type: 'text', text: '不应重复显示的摘要' }],
      }),
      surfaceOp: { op: 'replace', start: 0, end: 0 },
    } as SessionEvent
    state = applySessionEvent(state, replacement)

    expect(state.rows).toEqual([expect.objectContaining({
      kind: 'context', text: '定时任务已触发', detail: '模型可见的附加上下文',
    })])
    expect(state.lastSeq).toBe(1)
  })

  it('folds verbose rows by default and unfolds the newest folded one on demand', () => {
    const context = (seq: number) => event('user/message', seq, {
      id: `context-${String(seq)}`, role: 'user',
      source: { kind: 'skill-catalog', name: 'skills', form: 'catalog', entries: [] },
      content: [{ type: 'text', text: `目录内容 ${String(seq)}` }],
    })
    let state = applySessionEvent(createInitialState(), context(0))
    state = applySessionEvent(state, context(1))
    state = applySessionEvent(state, event('tool/call', 2, {
      turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"pwd"}',
    }))
    state = applySessionEvent(state, event('tool/result', 3, {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-1', role: 'user', source: { kind: 'tool', callId: 'call-1' },
        content: [{
          type: 'tool-result', toolCallId: 'call-1',
          content: [{ type: 'text', text: '/work' }], isError: false,
        }],
      },
    }))
    expect(state.rows.map(row => row.kind)).toEqual(['context', 'context', 'tool'])

    // Everything starts folded; nothing is explicitly expanded yet.
    expect(state.expanded).toEqual([])
    // A completed tool row is foldable but not running, so it folds too.
    expect(isCollapsibleRow(state.rows[2] as never)).toBe(true)
    expect(isExpandedRow(state.rows[2] as never, state.expanded)).toBe(false)

    // The newest still-folded row unfolds first (the completed tool), then the newer context.
    state = toggleFold(state)
    expect(state.expanded).toEqual(['tool-call-1'])
    state = toggleFold(state)
    expect(state.expanded).toEqual(['tool-call-1', 'context-1'])
    // Pressing again peels the next older one.
    state = toggleFold(state)
    expect(state.expanded).toEqual(['tool-call-1', 'context-1', 'context-0'])
    // No folded rows remain, so the next press folds them all back.
    state = toggleFold(state)
    expect(state.expanded).toEqual([])
    // Folding all back then pressing again unfolds the newest row.
    state = toggleFold(state)
    expect(state.expanded).toEqual(['tool-call-1'])
    // Idempotence: a fresh, empty projection has nothing to toggle and changes nothing.
    const fresh = { ...createInitialState(), rows: [] }
    expect(toggleFold(fresh)).toBe(fresh)
  })

  it('keeps a running tool row unfolded even when folded state is empty', () => {
    let state = applySessionEvent(createInitialState(), event('tool/call', 0, {
      turn: 1, step: 1, callId: 'live', name: 'bash', arguments: '{}',
    }))
    const running = state.rows[0]
    expect(isExpandedRow(running as never, state.expanded)).toBe(true)
    expect(state.expanded).toEqual([])
    expect(toggleFold(state)).toBe(state)
  })

  it('folds a manual command and compaction lifecycle into one rich row', () => {
    let state = applySessionEvent(createInitialState(), event('command/run', 0, {
      commandId: 'command-1', name: 'compact', source: { kind: 'user' },
    }))
    state = applySessionEvent(state, event('compaction/start', 1, {
      compactionId: 'compaction-1', sourceCommandId: 'command-1', turn: null,
    }))
    state = applySessionEvent(state, event('compaction/summary', 2, {
      compactionId: 'compaction-1', sourceCommandId: 'command-1',
      summary: [{ type: 'text', text: '保留关键约束' }],
      shadowedRange: { start: 0, end: 4 }, shadowedSeqs: [0, 1, 2, 3, 4], shadowedTokenCount: 1200,
      provider: 'deepseek', model: 'reasoner',
    }))
    state = applySessionEvent(state, event('command/done', 3, {
      commandId: 'command-1', kind: 'success', sourceEventSeq: 2,
    }))

    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      id: 'command-command-1', kind: 'compaction', text: '/compact', status: 'completed',
    })
    expect(state.rows[0]?.detail).toContain('5 条记录 · 约 1200 tokens')
    expect(state.rows[0]?.detail).toContain('保留关键约束')
  })

  it('marks failed tool results and closes open tools and retries at a turn boundary', () => {
    let state = applySessionEvent(createInitialState(), event('tool/call', 0, {
      turn: 1, step: 1, callId: 'failed-call', name: 'bash', arguments: '{}',
    }))
    state = applySessionEvent(state, event('tool/result', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'failed-result', role: 'user', source: { kind: 'tool', callId: 'failed-call' },
        content: [{
          type: 'tool-result', toolCallId: 'failed-call',
          content: [{ type: 'text', text: 'exit 1' }], isError: true,
        }],
      },
    }))
    state = applySessionEvent(state, event('tool/call', 2, {
      turn: 1, step: 2, callId: 'open-call', name: 'read', arguments: '{}',
    }))
    state = applySessionEvent(state, event('llm/retry', 3, {
      retryId: 'retry-1', turn: 1, step: 2, provider: 'deepseek', mode: 'normal', policyKey: 'default',
      retry: 1, maxRetries: 2, delayMs: 500, failure: { code: 'RATE_LIMIT', message: '稍后重试' },
    }))
    state = applySessionEvent(state, event('llm/retry-started', 4, {
      retryId: 'retry-1', turn: 1, step: 2, retry: 1,
    }))
    state = applySessionEvent(state, event('turn/end', 5, {
      turn: 1, reason: { kind: 'error', error: { code: 'RATE_LIMIT', message: '仍不可用' } },
    }))

    expect(state.rows.find(row => row.id === 'tool-failed-call')).toMatchObject({ status: 'failed' })
    expect(state.rows.find(row => row.id === 'tool-open-call')).toMatchObject({ status: 'interrupted' })
    expect(state.rows.find(row => row.id === 'retry-retry-1')).toMatchObject({ status: 'failed' })
    expect(state.lastTurnEnd).toBeUndefined()
    expect(state.rows.some(row => row.kind === 'error')).toBe(false)
  })

  it('lists successful mutation locations once after the closing assistant message', () => {
    let state = applySessionEvent(createInitialState(), event('tool/call', 0, {
      turn: 1, step: 1, callId: 'write-1', name: 'write', arguments: '{}',
    }), {
      for: 'call',
      view: {
        card: 'diff', title: 'Write src/a.ts', diffs: [],
        locations: [{ path: 'src/a.ts' }, { path: 'src/a.ts' }],
      },
    })
    state = applySessionEvent(state, event('tool/result', 1, {
      turn: 1,
      step: 1,
      message: {
        id: 'tool-write-1', role: 'user', source: { kind: 'tool', callId: 'write-1' },
        content: [{
          type: 'tool-result', toolCallId: 'write-1',
          content: [{ type: 'text', text: 'done' }], isError: false,
        }],
      },
    }))
    state = applySessionEvent(state, event('assistant/message', 2, {
      turn: 1,
      step: 2,
      message: {
        id: 'assistant-empty', role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
        content: [],
      },
    }))

    expect(state.rows.at(-1)).toMatchObject({
      kind: 'deliverable', text: '1 个文件', detail: 'src/a.ts', status: 'completed',
    })
    // Flushed into the deliverable row: per-turn accumulation is consumed, not retained.
    expect(state.producedFiles).toEqual({})
  })

  it('folds durable workflow lifecycle events into one updated terminal row', () => {
    let state = applySessionEvent(createInitialState(), event('tool-workflow/run-start', 0, {
      runId: 'workflow-1', name: 'review-repository',
    }))
    state = applySessionEvent(state, event('tool-workflow/agent-start', 1, {
      runId: 'workflow-1', seq: 1, label: '检查模型层', phase: '审查', childId: SID,
    }))
    state = applySessionEvent(state, event('tool-workflow/agent-end', 2, {
      runId: 'workflow-1', seq: 1, outcome: 'completed',
    }))
    state = applySessionEvent(state, event('tool-workflow/run-end', 3, {
      runId: 'workflow-1', stopReason: 'completed',
    }))

    expect(state.workflows).toEqual([{
      runId: 'workflow-1', name: 'review-repository', status: 'completed',
      members: [{ seq: 1, label: '检查模型层', phase: '审查', childId: SID, status: 'completed' }],
    }])
    expect(state.rows).toHaveLength(1)
    expect(state.rows[0]).toMatchObject({
      kind: 'workflow', text: 'review-repository', status: 'completed',
      detail: '已完成 · [审查] 检查模型层 · …ssion-tui',
    })
  })

  it('marks an open workflow and its active members interrupted when the turn closes', () => {
    let state = applySessionEvent(createInitialState(), event('tool-workflow/run-start', 0, {
      runId: 'workflow-open', name: 'unfinished',
    }))
    state = applySessionEvent(state, event('tool-workflow/agent-start', 1, {
      runId: 'workflow-open', seq: 1, label: '仍在运行', childId: SID,
    }))
    state = applySessionEvent(state, event('turn/end', 2, {
      turn: 1, reason: { kind: 'completed' },
    }))

    expect(state.workflows[0]).toMatchObject({
      status: 'interrupted', members: [{ status: 'interrupted' }],
    })
    expect(state.rows[0]).toMatchObject({ kind: 'workflow', status: 'interrupted' })
  })

  it('folds mux snapshots, projections, and answerable interactions only for the selected session', () => {
    let state: TuiViewState = { ...createInitialState(), sessionId: SID }
    state = applyMuxFrame(state, RpcId('queue'), {
      type: 'session/queue', sessionId: SID,
      items: [{ id: 'message-1', placement: 'queued', message: {} }],
    } as MuxFrame)
    state = applyMuxFrame(state, RpcId('jobs'), {
      type: 'session/jobs', sessionId: SID,
      jobs: [{ id: 'bash-1', kind: 'bash', label: 'pnpm test', status: 'running', startedAt: 1 }],
    } as MuxFrame)
    state = applyMuxFrame(state, RpcId('projection'), {
      type: 'session/projection', sessionId: SID, key: 'goal', value: { text: 'ship' }, seq: 4,
    })
    expect(state).toMatchObject({ queueSize: 1, projections: { goal: { text: 'ship' } } })
    expect(state.queueItems[0]?.id).toBe('message-1')
    expect(state.jobs[0]?.label).toBe('pnpm test')

    state = applyMuxFrame(state, RpcId('approval'), {
      type: 'approval/requested', sessionId: SID, approvalId: 'approval-1' as never, toolName: 'bash', reason: '需要写文件',
    })
    expect(state.interaction).toMatchObject({ kind: 'approval', toolName: 'bash' })
    state = applyMuxFrame(state, RpcId('resolved'), {
      type: 'approval/resolved', sessionId: SID, approvalId: 'approval-1' as never, outcome: 'rejected',
    })
    expect(state.interaction).toBeUndefined()

    const unchanged = applyMuxFrame(state, RpcId('other'), {
      type: 'question/requested', sessionId: SessionId('other'), questions: [],
    })
    expect(unchanged).toBe(state)
    expect(applyMuxFrame(state, RpcId('stream'), {
      type: 'stream/error', error: { code: 'internal', message: '断开', details: {} },
    }).notice).toBe('断开')
  })

  it('tracks the model route, thinking effort, and context window from request metadata', () => {
    let state = createInitialState()
    state = applySessionEvent(state, event('request/header', 0, {
      header: { config: { provider: 'deepseek', model: 'reasoner', reasoningEffort: 'high' } },
      reason: 'initial',
    }))
    expect(state).toMatchObject({
      model: 'deepseek/reasoner', reasoningEffort: 'high', modelContextWindow: undefined,
    })
    state = applySessionEvent(state, event('request/context', 1, {
      provider: 'deepseek', model: 'reasoner', contextWindow: 128_000,
    }))
    expect(state.modelContextWindow).toBe(128_000)
    state = applySessionEvent(state, event('request/header', 2, {
      header: { config: { provider: 'deepseek', model: 'chat' } },
      reason: 'change',
    }))
    expect(state).toMatchObject({ model: 'deepseek/chat', reasoningEffort: undefined })
  })

  it('keeps the current title and agent preset aligned with durable updates', () => {
    let state: TuiViewState = { ...createInitialState(), sessionId: SID }
    state = applyMuxFrame(state, RpcId('title'), {
      type: 'session/projection', sessionId: SID, key: 'title', value: '终端会话', seq: 2,
    })
    state = applySessionEvent(state, event('agent-preset/selected', 3, { agentPreset: 'minimal' }))

    expect(state).toMatchObject({ title: '终端会话', agentPreset: 'minimal' })
  })

  it('normalizes permission, plan, context, usage, stats, and image projections', () => {
    expect(projectionStatus({
      permissions: { options: [], currentValue: 'workspace-write' },
      plan: { active: false, pending: true },
      contextPressure: { pressureTokens: 20_000, projectedTokens: 25_000, contextWindow: 100_000 },
      contextBreakdown: { systemTokens: 1000, toolsTokens: 2000, messageTokens: 3000 },
      tokenUsage: { uncachedInputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
      sessionStats: { turns: 2, steps: 5 },
      imageLimits: {
        maxImagesPerMessage: 4,
        maxMessageImageBytes: 8_388_608,
        maxImageBytes: 1_048_576,
        maxImagePixels: 4_000_000,
        maxImageDimension: 2048,
        mediaTypes: ['image/png', 'image/jpeg'],
      },
    })).toEqual({
      permission: 'workspace-write',
      plan: { active: false, pending: true },
      context: { used: 25_000, window: 100_000, percent: 25 },
      contextWindow: 100_000,
      contextBreakdown: { system: 1000, tools: 2000, messages: 3000 },
      tokens: { input: 60, output: 40 },
      cacheHitRate: 33.3,
      session: { turns: 2, steps: 5 },
      images: {
        maximum: 4,
        maximumBytes: 8_388_608,
        maxBytes: 1_048_576,
        maxPixels: 4_000_000,
        maxDimension: 2048,
        mediaTypes: ['image/png', 'image/jpeg'],
      },
    })
  })

  it('keeps one decimal on the 99.x% cache band and drops malformed image mediaTypes', () => {
    expect(projectionStatus({
      tokenUsage: { uncachedInputTokens: 4, cacheReadTokens: 1992, cacheWriteTokens: 4, outputTokens: 1 },
    }).cacheHitRate).toBe(99.6)
    const images = projectionStatus({
      imageLimits: { maxImagesPerMessage: 1, maxMessageImageBytes: 10, mediaTypes: ['image/png', 42] },
    }).images
    expect(images).toEqual({ maximum: 1, maximumBytes: 10 })
  })

  it('folds current-session host status, errors, removal, and ignores unrelated frames', () => {
    let state: TuiViewState = { ...createInitialState(), sessionId: SID }
    state = applyHostFrame(state, { type: 'host/session-status', sessionId: SID, running: true })
    expect(state.running).toBe(true)
    expect(applyHostFrame(state, {
      type: 'host/session-status', sessionId: SID, running: true,
    })).toBe(state)
    state = applyHostFrame(state, { type: 'host/agent-error', sessionId: SID, message: 'agent failed' })
    expect(state.rows.at(-1)).toMatchObject({ kind: 'error', text: 'agent failed' })
    const unchanged = applyHostFrame(state, {
      type: 'host/session-status', sessionId: SessionId('other'), running: false,
    })
    expect(unchanged).toBe(state)
    state = applyHostFrame(state, { type: 'host/session-removed', sessionId: SID })
    expect(state).toMatchObject({ phase: 'error', notice: '当前会话已被删除' })
    expect(applyHostFrame(state, {
      type: 'stream/error', error: { code: 'internal', message: 'host down', details: {} },
    }).notice).toBe('host down')
  })
})
