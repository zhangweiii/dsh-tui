import { describe, expect, it } from 'vitest'
import { TerminalApplication } from '../src/terminal.ts'
import type { TuiViewState } from '../src/model.ts'
import { settle, TestController, TestTerminal } from './terminal-harness.ts'

function count(value: string, pattern: string): number {
  return value.split(pattern).length - 1
}

describe('pi-tui terminal application', () => {
  it('moves essential session context below the composer and hides empty todos', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController({
      title: '终端布局',
      agentPreset: 'standard',
      cwd: '/work/dsh-tui',
      model: 'deepseek/reasoner',
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    let lines = terminal.viewportLines()
    expect(terminal.viewport()).not.toContain('DEEPSEEK HARNESS TUI')
    expect(terminal.viewport()).not.toContain('待办 0/0')
    expect(lines.findIndex(line => line.includes('standard · deepseek/reasoner')))
      .toBeGreaterThan(lines.findIndex(line => line.includes('Enter 发送')))
    expect(lines.some(line => line.includes('standard · deepseek/reasoner · /work/dsh-tui'))).toBe(true)

    controller.publish({ todos: [{ content: '已经完成', status: 'completed' }] as never })
    await settle(terminal)
    expect(terminal.viewport()).not.toContain('待办')

    controller.publish({ todos: [{ content: '只在需要时展示', status: 'in_progress' }] as never })
    await settle(terminal)
    lines = terminal.viewportLines()
    expect(terminal.viewport()).toContain('待办 已办 0/1 · ◆ 只在需要时展示')
    expect(lines.findIndex(line => line.includes('待办 已办 0/1')))
      .toBeGreaterThan(lines.findIndex(line => line.includes('Enter 发送')))
    application.stop()
  })

  it('collapses todos to progress + running item, expands them on Ctrl+T', async () => {
    const terminal = new TestTerminal(100, 18)
    const controller = new TestController({
      todos: [
        { content: '已完成步骤一', status: 'completed' },
        { content: '已完成步骤二', status: 'completed' },
        { content: '正在执行的步骤三', status: 'in_progress' },
        { content: '未开始步骤四', status: 'pending' },
      ] as never,
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    // Collapsed default: progress count (completed/total) plus the running item.
    expect(terminal.viewport()).toContain('待办 已办 2/4')
    expect(terminal.viewport()).toContain('正在执行的步骤三')
    // Completed and pending entries stay hidden while collapsed.
    expect(terminal.viewport()).not.toContain('已完成步骤一')
    expect(terminal.viewport()).not.toContain('未开始步骤四')

    // Ctrl+T expands to show every todo in order, marking done items and
    // highlighting the one running now.
    terminal.send('\u0014')
    await settle(terminal)
    expect(terminal.viewport()).toContain('待办 已办 2/4')
    expect(terminal.viewport()).toContain('✓ 已完成步骤一')
    expect(terminal.viewport()).toContain('✓ 已完成步骤二')
    expect(terminal.viewport()).toContain('◆ 正在执行的步骤三')
    expect(terminal.viewport()).toContain('· 未开始步骤四')

    // Ctrl+T again collapses back to the summary.
    terminal.send('\u0014')
    await settle(terminal)
    expect(terminal.viewport()).toContain('待办 已办 2/4')
    expect(terminal.viewport()).not.toContain('未开始步骤四')
    application.stop()
  })

  it('separates todos, jobs, and workflows into sections when expanded', async () => {
    const terminal = new TestTerminal(100, 24)
    const controller = new TestController({
      todos: [
        { content: '已完成步骤一', status: 'completed' },
        { content: '正在执行的步骤二', status: 'in_progress' },
      ] as never,
      jobs: [
        { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: 0 },
        { id: 'bash-2', kind: 'bash', label: 'build', status: 'failed', detail: 'exit code 3', startedAt: 0, finishedAt: 1 },
      ] as never,
      workflows: [{ runId: 'wf-1', name: '审计', status: 'completed', members: [] }] as never,
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    // Collapsed combines todo and job summaries into the same strip.
    expect(terminal.viewport()).toContain('待办 已办 1/2')
    expect(terminal.viewport()).toContain('任务 2')
    expect(terminal.viewport()).toContain('pytest -q')

    // Ctrl+T separates each category into its own headed section.
    terminal.send('\u0014')
    await settle(terminal)
    const viewport = terminal.viewport()
    expect(viewport).toContain('待办 已办 1/2')
    expect(viewport).toContain('✓ 已完成步骤一')
    expect(viewport).toContain('◆ 正在执行的步骤二')
    expect(viewport).toContain('任务 2')
    expect(viewport).toContain('● bash · pytest -q')
    expect(viewport).toContain('✗ bash · build（exit code 3）')
    expect(viewport).toContain('工作流 1')
    expect(viewport).toContain('▪ 审计')
    application.stop()
  })

  it('fades a settled job out of the dock while keeping live and failed ones', async () => {
    const terminal = new TestTerminal(100, 20)
    const controller = new TestController({
      todos: [{ content: '进行中的步骤', status: 'in_progress' }] as never,
      jobs: [
        { id: 'bash-1', kind: 'bash', label: 'pytest -q', status: 'running', startedAt: 0 },
        { id: 'bash-2', kind: 'bash', label: 'build', status: 'completed', detail: 'exit code 0', startedAt: 0, finishedAt: 2 },
      ] as never,
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    // Collapsed shows only the running job; the settled one is not listed.
    expect(terminal.viewport()).toContain('任务 1')
    expect(terminal.viewport()).toContain('pytest -q')
    expect(terminal.viewport()).not.toContain('build')

    // Expanded still surfaces only live jobs (not the completed build).
    terminal.send('\u0014')
    await settle(terminal)
    const viewport = terminal.viewport()
    expect(viewport).toContain('● bash · pytest -q')
    expect(viewport).not.toContain('build')
    application.stop()
  })

  it('splits the footer into two width-balanced lines when space is tight', async () => {
    const terminal = new TestTerminal(48, 14)
    const controller = new TestController({
      agentPreset: 'standard',
      cwd: '/work/dsh-tui',
      model: 'deepseek/reasoner',
      projections: { sessionStats: { turns: 3, steps: 7 } },
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    const lines = terminal.viewportLines()
    const statusLine = lines.findIndex(line => line.includes('● 就绪'))
    expect(statusLine).toBeGreaterThan(-1)
    expect(lines[statusLine]).toContain('standard · deepseek/reasoner')
    expect(lines[statusLine + 1]).toContain('/work/dsh-tui · 3 轮 · 7 步')
    application.stop()
  })

  it('shows thinking effort and model context window in the status line', async () => {
    const terminal = new TestTerminal(120, 14)
    const controller = new TestController({
      model: 'deepseek/reasoner',
      reasoningEffort: 'high',
      modelContextWindow: 128_000,
      projections: { contextPressure: { projectedTokens: 64_000, contextWindow: 128_000 } },
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    const viewport = terminal.viewport()
    expect(viewport).toContain('deepseek/reasoner')
    expect(viewport).toContain('high')
    expect(viewport).toContain('128.0k')
    expect(viewport).toContain('50%')
    application.stop()
  })

  it('keeps one fixed viewport while Markdown and streaming state update', async () => {
    const terminal = new TestTerminal(120, 20)
    const controller = new TestController({
      running: true,
      rows: [
        { id: 'user', seq: 0, kind: 'user', text: '请检查' },
        { id: 'assistant', seq: 1, kind: 'assistant', text: '**验证结果：**\n\n- 第一项\n- 第二项' },
      ],
      todos: [{ content: '修复终端布局', status: 'in_progress' }] as never,
      projections: {
        permissions: { currentValue: 'workspace-write' },
        plan: { active: false, pending: false },
        contextPressure: { projectedTokens: 20_000, contextWindow: 1_000_000 },
        tokenUsage: { uncachedInputTokens: 10_000, cacheReadTokens: 20_000, cacheWriteTokens: 5_000, outputTokens: 900 },
        sessionStats: { turns: 2, steps: 4 },
      },
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    for (let index = 1; index <= 8; index += 1) {
      controller.publish({
        partialReasoning: `第 ${String(index)} 次流式更新`,
        projections: { ...controller.state.projections, sessionStats: { turns: index, steps: index + 1 } },
      })
      await settle(terminal)
    }

    const viewport = terminal.viewport()
    expect(terminal.viewportLines()).toHaveLength(20)
    expect(count(viewport, 'DEEPSEEK HARNESS TUI')).toBe(0)
    expect(count(viewport, '轮')).toBe(1)
    expect(viewport).toContain('8 轮 · 9 步')
    expect(viewport).not.toContain('**验证结果：**')
    expect(viewport).toContain('验证结果：')
    expect(viewport).toContain('第一项')
    expect(viewport).toContain('第 8 次流式更新')
    expect(viewport).toContain('待办 已办 0/1')
    expect(viewport).toContain('> ')
    expect(application.tui.fullRedraws).toBeLessThanOrEqual(2)
    application.stop()
  })

  it('rolls the live reasoning tail with a uniform indent and no stray blank rows', async () => {
    const terminal = new TestTerminal(80, 18)
    const controller = new TestController({ running: true })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    const head = '旧内容开头'
    const middle = Array.from({ length: 40 }, (_, index) => `中间行 ${String(index)} ${'字'.repeat(30)}`).join('\n')
    const tail = '最新思考内容出现在结尾'
    // paragraph breaks and a trailing newline must not surface as empty rows
    controller.publish({ partialReasoning: `${head}\n\n${middle}\n\n${tail}\n` })
    await settle(terminal)

    const lines = terminal.viewportLines()
    const start = lines.findIndex(line => line.includes('思考中'))
    expect(start).toBeGreaterThan(-1)
    const end = lines.findIndex((line, index) => index > start && line.includes(tail))
    expect(end).toBeGreaterThan(start)
    const block = lines.slice(start, end + 1)

    expect(block[0]).toContain('思考中')
    expect(block.some(line => line.includes(tail))).toBe(true)
    expect(block.every(line => line.trim() !== '')).toBe(true)
    expect(block.every(line => line.startsWith(' '))).toBe(true)
    expect(lines.join('\n')).not.toContain(head)
    application.stop()
  })

  it('indents streaming reply text and tool lines like committed rows', async () => {
    const terminal = new TestTerminal(80, 18)
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `assistant-${String(index)}`,
      seq: index,
      kind: 'assistant' as const,
      text: `消息 ${String(index)}`,
    }))
    const controller = new TestController({ running: true, rows })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      partialReasoning: '先思考一些内容',
      partialText: '回复的第一行文字',
      partialTool: { name: 'bash', arguments: 'ls -la' },
    })
    await settle(terminal)

    const lines = terminal.viewportLines()
    const start = lines.findIndex(line => line.includes('思考中'))
    expect(start).toBeGreaterThan(-1)
    const end = lines.findIndex((line, index) => index > start && line.includes('bash ls -la'))
    expect(end).toBeGreaterThan(start)
    const block = lines.slice(start, end + 1)

    expect(block.some(line => line.includes('回复的第一行文字'))).toBe(true)
    expect(block.every(line => line.startsWith(' '))).toBe(true)
    application.stop()
  })

  it('folds context and tool rows by default, unfolds the newest on Ctrl+Shift+E', async () => {
    const terminal = new TestTerminal(90, 16)
    const rows: TuiViewState['rows'] = [
      { id: 'context-0', seq: 0, kind: 'context', text: 'Skill 目录', detail: '第一段很长的 skill 目录内容'.repeat(4) },
      { id: 'tool-1', seq: 1, kind: 'tool', text: 'bash', detail: '/work', status: 'completed' },
      { id: 'user', seq: 2, kind: 'user', text: '请开始' },
    ]
    const controller = new TestController({ rows, running: true })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    // Verbose rows render as one-line collapsed headers; long details stay folded.
    expect(terminal.viewport()).toContain('▸ 上下文 · Skill 目录')
    expect(terminal.viewport()).toContain('▸ ✓ 工具 · bash')
    expect(terminal.viewport()).not.toContain('第一段很长的 skill 目录内容')
    expect(terminal.viewport()).not.toContain('/work')

    // Unfolding a specific row reveals its detail.
    controller.publish({ expanded: ['tool-1'] })
    await settle(terminal)
    expect(terminal.viewport()).toContain('▾ ✓ 工具 · bash')
    expect(terminal.viewport()).toContain('/work')

    // The hotkey routes to the controller fold toggle.
    terminal.send('\u001B[27;6;101~')
    await settle(terminal)
    expect(controller.toggleFoldCount).toBe(1)
    application.stop()
  })

  it('uses ScrollView follow-end and preserves a manual scroll position while content grows', async () => {
    const terminal = new TestTerminal(90, 18)
    const rows: TuiViewState['rows'] = Array.from({ length: 30 }, (_, index) => ({
      id: `assistant-${String(index)}`,
      seq: index,
      kind: 'assistant',
      text: `消息 ${String(index)}`,
    }))
    const controller = new TestController({ rows })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)
    expect(terminal.viewport()).toContain('消息 29')

    terminal.send('\u001B[<64;10;8M')
    terminal.send('\u001B[<64;10;8M')
    terminal.send('\u001B[<64;10;8M')
    await settle(terminal)
    const scrollTop = application.view.transcript.scrollTop
    expect(application.view.transcript.isFollowingEnd).toBe(false)
    expect(scrollTop).toBeGreaterThan(0)

    controller.publish({ rows: [...rows, { id: 'assistant-30', seq: 30, kind: 'assistant', text: '最新消息 30' }] })
    await settle(terminal)
    expect(application.view.transcript.scrollTop).toBe(scrollTop)
    expect(terminal.viewport()).not.toContain('最新消息 30')

    application.view.transcript.scrollToEnd()
    application.tui.requestRender()
    await settle(terminal)
    expect(terminal.viewport()).toContain('最新消息 30')
    expect(application.view.transcript.isFollowingEnd).toBe(true)
    application.stop()
  })

  it('delegates editing, autocomplete, picker and interactions to pi-tui components', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    terminal.send('你')
    terminal.send('好')
    terminal.send('\u007F')
    terminal.send('呀')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.submissions).toEqual([{ text: '你呀', mode: 'queue' }])

    terminal.send('\u001B[A')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('你呀')
    terminal.send('\u001B')
    terminal.send('/')
    terminal.send('r')
    await settle(terminal)
    expect(terminal.viewport()).toContain('rename')
    expect(terminal.viewport()).toContain('resume')

    // Ctrl+N moves the autocomplete highlight down; Tab completes the item.
    terminal.send('\u000E')
    await settle(terminal)
    terminal.send('\t')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('/rename ')

    // Ctrl+N down then Ctrl+P up returns to the first item again.
    terminal.send('\u001B')
    terminal.send('/')
    terminal.send('r')
    await settle(terminal)
    terminal.send('\u000E')
    terminal.send('\u0010')
    await settle(terminal)
    terminal.send('\t')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('/resume ')

    terminal.send('\u001B')
    terminal.send('保')
    terminal.send('留')
    controller.publish({
      picker: {
        kind: 'model', title: '选择模型', current: 'p/a',
        items: [
          { value: 'p/a', label: '模型 A' },
          { value: 'p/b', label: '模型 B', description: '第二个模型' },
        ],
      },
    })
    await settle(terminal)
    // Ctrl+N moves the picker highlight down (same binding as the Down arrow);
    // Enter confirms the highlighted item.
    terminal.send('\u000E')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.pickerValues).toEqual(['p/b'])

    controller.publish({
      picker: undefined,
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [{
          id: 'choice', question: '选择一项',
          options: [{ label: 'A' }, { label: 'B' }],
        }],
      },
    })
    await settle(terminal)
    // The single-select question renders as an arrow-navigable menu: Ctrl+N
    // moves the highlight to B, Enter confirms it. A one-question batch skips the
    // review summary and sends the answer to the host right away.
    terminal.send('\u000E')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toEqual([{ answers: [{ id: 'choice', selected: ['B'] }] }])

    controller.publish({ interaction: undefined })
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('保留')

    controller.publish({
      interaction: {
        kind: 'approval', rpcId: 'rpc-approval' as never, sessionId: 'session' as never,
        approvalId: 'approval' as never, toolName: 'write_file',
      },
    })
    await settle(terminal)
    terminal.send('y')
    expect(controller.approvals).toEqual(['allowed-once'])
    application.stop()
  })

  it('mirrors Up/Down in the composer with Ctrl+P/N: history and cursor movement', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    terminal.send('历史')
    terminal.send('一')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.submissions).toEqual([{ text: '历史一', mode: 'queue' }])

    // Ctrl+P recalls the previous history entry (like Up on an empty draft)…
    terminal.send('\u0010')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('历史一')

    // …and Ctrl+N returns to the empty draft (like Down at the newest entry).
    terminal.send('\u000E')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('')

    // On a multi-line draft Ctrl+P/N move the cursor like Up/Down.
    terminal.send('第一行')
    terminal.send('\n')
    terminal.send('第二行')
    terminal.send('\u0010')
    terminal.send('插')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('第一行插\n第二行')
    application.stop()
  })

  it('reopens a single-question batch after a rejected submission so the user can retry', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController()
    controller.answerQuestionResult = false
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [{ id: 'mode', question: '选择模式？', options: [{ label: '快' }, { label: '稳' }] }],
      },
    })
    await settle(terminal)
    // The first option ('快') is highlighted by default, so Enter selects it and
    // — with only one question in the batch — sends the answer right away.
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toHaveLength(1)
    expect(controller.questionAnswers[0]).toEqual({ answers: [{ id: 'mode', selected: ['快'] }] })

    // The submission is rejected: the question must reopen (not a stuck pending
    // state) so the user can answer again.
    expect(terminal.viewport()).toContain('↑/↓ 或 Ctrl+N/P 选择')
    expect(terminal.viewport()).not.toContain('请确认你的回答')

    // Answering again with '稳' now succeeds and sends the revised answer.
    controller.answerQuestionResult = true
    terminal.send('\u001B[B')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toHaveLength(2)
    expect(controller.questionAnswers[1]).toEqual({ answers: [{ id: 'mode', selected: ['稳'] }] })
    application.stop()
  })

  it('lets a single-select question be answered by typing a custom answer, not just an option', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [{ id: 'mode', question: '选择模式？', options: [{ label: '快' }, { label: '稳' }] }],
      },
    })
    await settle(terminal)
    // The menu renders with its hint line and the trailing "other/custom" entry.
    // Options appear once, in the arrow-navigable list, without a separate
    // numbered header listing above it.
    expect(terminal.viewport()).toContain('其他 / 自定义')
    expect(terminal.viewport()).toContain('↑/↓ 或 Ctrl+N/P 选择')
    expect(terminal.viewport()).toContain('快')
    expect(terminal.viewport()).toContain('稳')
    expect(terminal.viewport()).not.toContain('1. 快')
    expect(terminal.viewport()).not.toContain('2. 稳')

    // Typing a printable character drops into the custom editor; Enter submits
    // that text verbatim as the free-text answer, and a one-question batch is
    // sent to the host right away.
    terminal.send('o')
    terminal.send('t')
    terminal.send('h')
    terminal.send('e')
    terminal.send('r')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toEqual([{ answers: [{ id: 'mode', selected: [], custom: 'other' }] }])
    application.stop()
  })

  it('enters the custom editor through the trailing entry and returns to the menu with Escape', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [{ id: 'mode', question: '选择模式？', options: [{ label: '快' }, { label: '稳' }] }],
      },
    })
    await settle(terminal)
    // Walk down to the last (自定义) entry and confirm it.
    terminal.send('\u001B[B')
    terminal.send('\u001B[B')
    terminal.send('\r')
    await settle(terminal)
    expect(terminal.viewport()).toContain('输入自定义回答')

    // Escape returns to the option menu without cancelling the whole request.
    terminal.send('\u001B')
    await settle(terminal)
    expect(controller.cancelQuestionCount).toBe(0)
    expect(terminal.viewport()).toContain('↑/↓ 或 Ctrl+N/P 选择')

    // The trailing entry stays highlighted, so Enter returns to the custom editor.
    terminal.send('\r')
    await settle(terminal)
    terminal.send('别的')
    terminal.send('\r')
    await settle(terminal)
    // A one-question batch skips the confirmation summary: the custom answer is
    // sent to the host as soon as it is typed.
    expect(controller.questionAnswers).toEqual([{ answers: [{ id: 'mode', selected: [], custom: '别的' }] }])
    application.stop()
  })

  it('cancels the whole question request with Escape in the option menu', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [{ id: 'mode', question: '选择模式？', options: [{ label: '快' }, { label: '稳' }] }],
      },
    })
    await settle(terminal)
    terminal.send('\u001B')
    await settle(terminal)
    expect(controller.cancelQuestionCount).toBe(1)
    application.stop()
  })

  it('still answers option-less and multi-select questions through the number/custom editor', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [
          { id: 'free', question: '一句话？' },
          { id: 'multi', question: '多选几个？', multiSelect: true, options: [{ label: '一' }, { label: '二' }] },
        ],
      },
    })
    await settle(terminal)
    // The first question has no options, so no arrow menu appears for it; the
    // editor path keeps its numbered option listing only on the multi-select step.
    expect(terminal.viewport()).toContain('问题 1/2 · 一句话？')
    terminal.send('随便')
    terminal.send('\r')
    await settle(terminal)
    // The multi-select step keeps the numbered option listing and the
    // comma-separated hint, since the user types numbers there.
    expect(terminal.viewport()).toContain('问题 2/2 · 多选几个？')
    expect(terminal.viewport()).toContain('1. 一')
    expect(terminal.viewport()).toContain('2. 二')
    expect(terminal.viewport()).toContain('多个编号用逗号分隔')
    terminal.send('1,2')
    terminal.send('\r')
    await settle(terminal)
    // Both answers typed; the confirmation summary lists every "question → answer"
    // before the batch is sent. The confirm row is the last of three and starts
    // highlighted, so Enter sends everything.
    expect(terminal.viewport()).toContain('请确认你的回答')
    expect(terminal.viewport()).toContain('随便')
    expect(terminal.viewport()).toContain('一、二')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toEqual([{
      answers: [
        { id: 'free', selected: [], custom: '随便' },
        { id: 'multi', selected: ['一', '二'] },
      ],
    }])
    application.stop()
  })

  it('shows a "question → answer" summary and lets the first entry be revised before sending', async () => {
    const terminal = new TestTerminal(100, 18)
    const controller = new TestController()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    controller.publish({
      interaction: {
        kind: 'question', rpcId: 'rpc-question' as never, sessionId: 'session' as never,
        questions: [
          { id: 'pick', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
          { id: 'note', question: '备注一句？' },
        ],
      },
    })
    await settle(terminal)
    // Answer Q1 (option menu → Down to 乙, Enter) and Q2 (type text, Enter).
    terminal.send('\u001B[B')
    terminal.send('\r')
    await settle(terminal)
    terminal.send('备注内容')
    terminal.send('\r')
    await settle(terminal)
    // The summary shows both "question → answer" lines and the confirm row.
    expect(terminal.viewport()).toContain('请确认你的回答')
    expect(terminal.viewport()).toContain('问题 1 · 选哪个？')
    expect(terminal.viewport()).toContain('问题 2 · 备注一句？')
    expect(terminal.viewport()).toContain('乙')
    expect(terminal.viewport()).toContain('备注内容')
    expect(terminal.viewport()).toContain('确认提交全部回答')

    // The confirm row is highlighted by default; Ctrl+P (same binding as Up)
    // moves up twice to the first question row and Enter reopens Q1 for revision.
    terminal.send('\u0010')
    terminal.send('\u0010')
    terminal.send('\r')
    await settle(terminal)
    expect(terminal.viewport()).toContain('↑/↓ 或 Ctrl+N/P 选择')
    // Switch from 乙 back to 甲: Ctrl+P clamps on the first option (default).
    terminal.send('\u0010')
    terminal.send('\r')
    await settle(terminal)
    terminal.send('改后的备注')
    terminal.send('\r')
    await settle(terminal)
    expect(terminal.viewport()).toContain('请确认你的回答')
    expect(terminal.viewport()).toContain('甲')
    expect(terminal.viewport()).toContain('改后的备注')

    // The confirm row starts highlighted again; Ctrl+P up to the second
    // question row, then Ctrl+N back down to the confirm row, which sends the
    // revised batch.
    terminal.send('\u0010')
    terminal.send('\u000E')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.questionAnswers).toEqual([{
      answers: [
        { id: 'pick', selected: ['甲'] },
        { id: 'note', selected: [], custom: '改后的备注' },
      ],
    }])
    application.stop()
  })

  it('searches provider choices before selecting, like pi /login', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController({
      picker: {
        kind: 'provider-setup', title: '配置 Provider', current: undefined,
        items: [
          { value: 'google', label: 'Google', description: '密钥未配置 · google' },
          { value: 'openai', label: 'OpenAI', description: '密钥已配置 · openai' },
        ],
      },
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    terminal.send('goo')
    await settle(terminal)

    expect(terminal.viewport()).toContain('Google')
    expect(terminal.viewport()).not.toContain('OpenAI')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.pickerValues).toEqual(['google'])
    application.stop()
  })

  it('moves the provider search highlight with Ctrl+N/P like every other list', async () => {
    const terminal = new TestTerminal(100, 16)
    const controller = new TestController({
      picker: {
        kind: 'provider-setup', title: '配置 Provider', current: undefined,
        items: [
          { value: 'google', label: 'Google', description: '密钥未配置 · google' },
          { value: 'openai', label: 'OpenAI', description: '密钥已配置 · openai' },
        ],
      },
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    // 'o' matches both; fuzzy ranking puts OpenAI first. Ctrl+N moves the
    // highlight down to Google, Ctrl+P back up to OpenAI, Enter confirms it.
    terminal.send('o')
    await settle(terminal)
    expect(terminal.viewport()).toContain('Google')
    expect(terminal.viewport()).toContain('OpenAI')
    terminal.send('\u000E')
    terminal.send('\u0010')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.pickerValues).toEqual(['openai'])
    application.stop()
  })

  it('moves the provider wizard protocol menu with Ctrl+N/P', async () => {
    const terminal = new TestTerminal(100, 16)
    const wizard = {
      kind: 'custom' as const, namespace: 'llm-pi-ai', settingsPath: ['providers'], revision: 8,
      providerId: '', declared: true, taken: [], protocols: ['openai-completions', 'anthropic'],
      displayName: '', baseURL: '', api: 'openai-completions', apiKey: '', models: [],
      candidates: [], selectedCandidates: [], credentialRef: '', credentialRefNamed: false, supportsCredentialRef: true,
      credentialConfigured: false, profileConfigured: false,
      dirty: [], committed: false, busy: false, applies: 'live' as const,
      step: 'api' as const, editing: undefined,
    }
    const controller = new TestController({ providerWizard: wizard })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)
    expect(terminal.viewport()).toContain('↑/↓ 或 Ctrl+N/P 选择协议')

    // Ctrl+N moves the highlight to anthropic, Ctrl+P back to the default
    // openai-completions, Enter confirms the highlighted row.
    terminal.send('\u000E')
    terminal.send('\u0010')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.wizardRows).toEqual([0])
    application.stop()
  })

  it('renders an existing provider address exactly once', async () => {
    const terminal = new TestTerminal(100, 16)
    const wizard = {
      kind: 'existing' as const, namespace: 'llm-pi-ai', settingsPath: ['providers', 'google'], revision: 8,
      providerId: 'google', declared: false, taken: ['google'], protocols: [],
      displayName: '', baseURL: '', api: '', apiKey: '', models: [], candidates: [], selectedCandidates: [],
      credentialRef: 'GOOGLE_API_KEY', credentialRefNamed: true, supportsCredentialRef: true,
      credentialConfigured: false, profileConfigured: true, dirty: [], committed: false, busy: false,
      applies: 'live' as const, step: 'review' as const, editing: undefined,
    }
    const controller = new TestController({ providerWizard: wizard })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    expect(terminal.viewport()).toContain('llm-pi-ai/providers/google')
    expect(terminal.viewport()).not.toContain('providers/google/google')
    application.stop()
  })

  it('uses a focused pi-style prompt instead of a provider field form', async () => {
    const terminal = new TestTerminal(100, 16)
    const wizard = {
      kind: 'custom' as const, namespace: 'llm-pi-ai', settingsPath: ['providers'], revision: 8,
      providerId: '', declared: true, taken: [], protocols: ['openai-completions'],
      displayName: '', baseURL: '', api: 'openai-completions', apiKey: '', models: [],
      candidates: [], selectedCandidates: [], credentialRef: '', credentialRefNamed: false, supportsCredentialRef: true,
      credentialConfigured: false, profileConfigured: false,
      dirty: [], committed: false, busy: false, applies: 'live' as const,
      step: 'providerId' as const, editing: 'providerId' as const,
    }
    const controller = new TestController({ providerWizard: wizard })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    expect(terminal.viewport()).toContain('添加自定义 Provider')
    expect(terminal.viewport()).toContain('Provider ID（必填）')
    expect(terminal.viewport()).not.toContain('获取可用模型')
    expect(terminal.viewport()).not.toContain('保存 Provider')

    terminal.send('my-custom')
    terminal.send('\r')
    await settle(terminal)
    expect(controller.wizardValues).toContainEqual({ row: 'providerId', text: 'my-custom' })
    application.stop()
  })

  it('does not overwrite text typed while a rejected async submission is pending', async () => {
    const terminal = new TestTerminal(90, 16)
    const controller = new TestController()
    let settleSubmission: ((accepted: boolean) => void) | undefined
    controller.submitResult = () => new Promise(resolve => { settleSubmission = resolve })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    terminal.send('旧')
    terminal.send('\r')
    terminal.send('新')
    settleSubmission?.(false)
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('新')
    application.stop()
  })

  it('restores the main screen and disposes each lifecycle owner once', async () => {
    const terminal = new TestTerminal(80, 12)
    const controller = new TestController()
    const exits: number[] = []
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, {
      terminal,
      onExit: code => { exits.push(code) },
    })
    application.start()
    await settle(terminal)
    terminal.send('\u0003')
    application.stop()
    expect(exits).toEqual([0])
    expect(controller.disposeCount).toBe(1)
    expect(terminal.startCount).toBe(1)
    expect(terminal.stopCount).toBe(1)
    expect(terminal.writes.join('')).toContain('\u001B[?1049h')
    expect(terminal.writes.join('')).toContain('\u001B[?1049l')
  })

  it('boxes fenced code blocks in assistant rows instead of showing raw fences', async () => {
    const terminal = new TestTerminal(100, 26)
    const controller = new TestController({
      rows: [{
        id: 'assistant-1', seq: 1, kind: 'assistant', text: '下面是一个示例：\n\n```ts\nconst x = 1\nconsole.log(x)\n```\n\n说明文字。',
      }] as never,
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    const viewport = terminal.viewport()
    expect(viewport).toContain('┌─ ts')
    expect(viewport).toContain('└─')
    expect(viewport).toContain('const x = 1')
    expect(viewport).toContain('console.log(x)')
    expect(viewport).not.toContain('```ts')
    expect(viewport).not.toContain('```\n')
    application.stop()
  })

  it('boxes user-sent code blocks and streamed fences instead of raw text', async () => {
    const terminal = new TestTerminal(100, 26)
    const controller = new TestController({
      rows: [{ id: 'user-1', seq: 0, kind: 'user', text: '请运行：\n\n```bash\nls -la\n```' }] as never,
      running: true,
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, { terminal })
    application.start()
    await settle(terminal)

    let viewport = terminal.viewport()
    expect(viewport).toContain('┌─ bash')
    expect(viewport).toContain('ls -la')
    expect(viewport).not.toContain('```bash')

    // The streamed tail keeps only the freshest lines: closing box and code
    // stay visible while the raw opening fence never appears on screen.
    controller.publish({ partialText: '```ts\nconst a = 1\nconsole.log(a)\n```' })
    await settle(terminal)
    viewport = terminal.viewport()
    expect(viewport).toContain('const a = 1')
    expect(viewport).toContain('console.log(a)')
    expect(viewport).toContain('└─')
    expect(viewport).not.toContain('```')
    expect(viewport).not.toContain('partialText')
    application.stop()
  })
})
