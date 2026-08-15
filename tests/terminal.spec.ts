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
    expect(terminal.viewport()).toContain('待办 1/1 · ◆ 只在需要时展示')
    expect(lines.findIndex(line => line.includes('待办 1/1')))
      .toBeGreaterThan(lines.findIndex(line => line.includes('Enter 发送')))
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
    expect(viewport).toContain('待办 1/1')
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

    terminal.send('\u001B')
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
    terminal.send('\u001B[B')
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
    terminal.send('2')
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
})
