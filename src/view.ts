/** pi-tui component tree for the fixed viewport application. */

import type { AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  Editor, Markdown, ScrollView, SelectList, stripTerminalSequences, Text, truncateToWidth, visibleWidth, VStack,
  wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TUI,
} from '@earendil-works/pi-tui'
import { contentText, projectionStatus, type TranscriptRow, type TuiViewState } from './model.ts'
import { ansi, editorTheme, markdownTheme, selectListTheme } from './theme.ts'

const OSC133_PROMPT_START = '\u001B]133;A\u0007'

function shorten(value: string | undefined, maximum: number): string {
  if (value === undefined || value === '') return '—'
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`
}

function oneLine(value: string): string {
  return value.replaceAll(/\s*\n\s*/gu, ' ').trim()
}

const THINKING_LABEL = '思考中'
const THINKING_TAIL_LINES = 3

/**
 * Rolling tail of the live reasoning stream: at most `maximum` non-blank screen
 * rows of the most recent content. Older rows fall out as new reasoning arrives,
 * so the freshest thinking always stays visible instead of freezing on the head
 * of the buffer once it overflows a single truncated line. Blank rows from
 * paragraph breaks and trailing newlines are dropped so they never appear as
 * stray empty lines inside the window.
 */
function reasoningTail(text: string, width: number, maximum: number): string[] {
  const budget = Math.max(1, width * maximum)
  const suffix = text.length <= budget ? text : `…${text.slice(-Math.max(1, budget - 1))}`
  return wrapTextWithAnsi(suffix, Math.max(1, width))
    .filter(line => line.trim() !== '')
    .slice(-maximum)
}

function limitedLines(value: string, maximum: number): string {
  const lines = value.split('\n')
  return lines.length <= maximum ? value : `${lines.slice(0, maximum).join('\n')}\n… ${String(lines.length - maximum)} 行已折叠`
}

function formatCount(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

function projectedGoal(state: TuiViewState): { objective: string; phase: string } | undefined {
  const projection = state.projections.goal
  if (typeof projection !== 'object' || projection === null || !('goal' in projection)) return undefined
  const goal = projection.goal
  if (typeof goal !== 'object' || goal === null || !('objective' in goal) || !('phase' in goal)
    || typeof goal.objective !== 'string' || typeof goal.phase !== 'string') return undefined
  return { objective: goal.objective, phase: goal.phase }
}

const STATUS_SEPARATOR = ' · '

/** Join segments on one line when they fit, otherwise split into two width-balanced lines. */
function balanceSegments(segments: string[], width: number): string[] {
  if (segments.length === 0) return ['']
  const single = segments.join(STATUS_SEPARATOR)
  if (visibleWidth(single) <= width) return [single]
  let split = 1
  let score = Number.POSITIVE_INFINITY
  for (let candidate = 1; candidate < segments.length; candidate += 1) {
    const first = visibleWidth(segments.slice(0, candidate).join(STATUS_SEPARATOR))
    const second = visibleWidth(segments.slice(candidate).join(STATUS_SEPARATOR))
    if (Math.abs(first - second) < score) {
      score = Math.abs(first - second)
      split = candidate
    }
  }
  return [segments.slice(0, split).join(STATUS_SEPARATOR), segments.slice(split).join(STATUS_SEPARATOR)]
}

function statusIcon(row: TranscriptRow): string {
  if (row.status === undefined) return '·'
  if (row.status === 'running') return '◆'
  if (row.status === 'failed') return '✕'
  if (row.status === 'cancelled') return '⊘'
  if (row.status === 'interrupted') return '◇'
  return '✓'
}

function statusStyle(row: TranscriptRow): (text: string) => string {
  if (row.status === 'failed') return ansi.red
  if (row.status === 'completed') return ansi.green
  if (row.status === 'running') return ansi.cyan
  return ansi.gray
}

const CARD_LABELS: Partial<Record<TranscriptRow['kind'], string>> = {
  tool: '工具',
  workflow: '工作流',
  deliverable: '产物',
  context: '上下文',
  command: '命令',
  compaction: '压缩',
  retry: '重试',
}

function rowComponent(row: TranscriptRow): Component {
  const cardLabel = CARD_LABELS[row.kind]
  if (cardLabel !== undefined) {
    const style = statusStyle(row)
    const children: Component[] = [
      new Text(`\n${style(ansi.bold(`${statusIcon(row)} ${cardLabel} · ${row.text}`))}`, 1, 0),
    ]
    if (row.detail !== undefined) children.push(new Text(ansi.dim(limitedLines(row.detail, 12)), 2, 0))
    if (row.kind === 'deliverable') children.push(new Text(ansi.dim('使用 /open <path> 打开'), 2, 0))
    return new VStack(children)
  }

  const label = row.kind === 'user'
    ? '你'
    : row.kind === 'assistant'
      ? 'DeepSeek'
      : row.kind === 'reasoning'
        ? '思考'
        : row.kind === 'error' ? '错误' : '提示'
  const style = row.kind === 'user'
    ? ansi.magenta
    : row.kind === 'assistant'
      ? ansi.cyan
      : row.kind === 'error' ? ansi.red : ansi.yellow
  const marker = row.kind === 'user' ? OSC133_PROMPT_START : ''
  const header = new Text(`${marker}\n${style(ansi.bold(`${label}${row.messageId === undefined ? '' : ` · ${shorten(row.messageId, 14)}`}`))}`, 1, 0)
  const content = row.kind === 'assistant' || row.kind === 'reasoning'
    ? new Markdown(
      row.text,
      1,
      0,
      markdownTheme,
      row.kind === 'reasoning' ? { color: ansi.gray } : undefined,
      { preserveOrderedListMarkers: true },
    )
    : new Text(row.text, 1, 0)
  return new VStack([header, content])
}

class TranscriptDocument implements Component {
  private state: TuiViewState
  private readonly cache = new Map<string, { signature: string; component: Component }>()

  constructor(state: TuiViewState) {
    this.state = state
  }

  update(state: TuiViewState): void {
    this.state = state
  }

  invalidate(): void {
    for (const value of this.cache.values()) value.component.invalidate()
  }

  render(width: number): string[] {
    const rendered: string[] = []
    const retained = new Set<string>()
    if (this.state.rows.length === 0) {
      rendered.push(...new Text(ansi.dim([
        '输入消息开始对话；支持 / 命令、实时工具输出与持久会话。',
        'Enter 发送 · Tab/↑↓ 补全命令 · Alt+Enter 插话 · Shift+Enter 换行 · Esc 清空/取消 · Ctrl+C 退出',
      ].join('\n')), 1, 1).render(width))
    }
    for (const row of this.state.rows) {
      retained.add(row.id)
      const signature = `${row.kind}\u0000${row.text}\u0000${row.detail ?? ''}\u0000${row.status ?? ''}\u0000${row.messageId ?? ''}`
      let cached = this.cache.get(row.id)
      if (cached === undefined || cached.signature !== signature) {
        cached = { signature, component: rowComponent(row) }
        this.cache.set(row.id, cached)
      }
      rendered.push(...cached.component.render(width))
    }
    for (const key of this.cache.keys()) if (!retained.has(key)) this.cache.delete(key)
    rendered.push(...this.renderStreamTail(width))
    rendered.push(...this.renderManagementPanel(width))
    return rendered
  }

  private renderStreamTail(width: number): string[] {
    const { partialReasoning, partialText, partialTool } = this.state
    if (partialReasoning === '' && partialText === '' && partialTool === undefined) return []
    const lines: string[] = ['']
    if (partialReasoning !== '') {
      lines.push(ansi.gray(ansi.bold(` ${THINKING_LABEL}`)))
      const tail = reasoningTail(partialReasoning, Math.max(1, width - 3), THINKING_TAIL_LINES)
      tail.forEach((line, index) => {
        const marker = index === tail.length - 1 ? ' ▍' : ''
        lines.push(ansi.gray(` ${line}${marker}`))
      })
    }
    if (partialText !== '') lines.push(ansi.cyan(` ${oneLine(partialText)}▍`))
    if (partialTool !== undefined) {
      lines.push(ansi.yellow(` ◆ ${partialTool.name || '工具'} ${oneLine(partialTool.arguments)}`))
    }
    return lines.map(line => truncateToWidth(line, width, '…'))
  }

  private renderManagementPanel(width: number): string[] {
    const panel = this.state.overlay
    if (panel === undefined) return []
    return new VStack([
      new Text(`\n${ansi.magenta(ansi.bold(panel.title))}`, 1, 0),
      new Text(panel.lines.length === 0 ? ansi.dim('没有内容') : panel.lines.join('\n'), 2, 0),
      new Text(ansi.dim('/close 关闭面板；可以直接输入下一条命令'), 1, 0),
    ]).render(width)
  }
}

class StateLine implements Component {
  constructor(
    private state: TuiViewState,
    private readonly line: (state: TuiViewState, width: number) => string[],
  ) {}

  update(state: TuiViewState): void {
    this.state = state
  }

  invalidate(): void {}

  render(width: number): string[] {
    return this.line(this.state, width).map(value => truncateToWidth(value, width, '…'))
  }
}

const PROMPT_MARKER = `${ansi.cyan(ansi.bold('>'))} `
const PROMPT_INDENT = ' '.repeat(visibleWidth('> '))

/**
 * Wraps an Editor with a `> ` prompt marker in the left gutter. Wrapped and
 * multi-line input lines are indented by the same width so every line aligns
 * with the first line's text column. The editor keeps its inner padding at
 * zero; the gutter reserves the columns instead.
 */
class PromptEditor implements Component, Focusable {
  private _focused = false
  private readonly borderClose: string

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.editor.focused = value
  }

  constructor(readonly editor: Editor) {
    // Derive the SGR closing sequence borderColor appends, so borders can be
    // widened by inserting dashes before it.
    const probe = editor.borderColor('\u0001')
    this.borderClose = probe.slice(probe.indexOf('\u0001') + 1)
  }

  invalidate(): void { this.editor.invalidate() }

  handleInput(data: string): void { this.editor.handleInput(data) }

  render(width: number): string[] {
    if (width < 6) return this.editor.render(width)
    const lines = this.editor.render(width - PROMPT_INDENT.length)
    // Only show `> ` when the editor is scrolled to its very first line.
    const scrolled = stripTerminalSequences(lines[0] ?? '').includes('↑')
    let prompted = false
    return lines.map(line => {
      if (stripTerminalSequences(line).startsWith('─')) return this.widenBorder(line)
      if (!prompted && !scrolled) {
        prompted = true
        return `${PROMPT_MARKER}${line}`
      }
      return `${PROMPT_INDENT}${line}`
    })
  }

  /** Extend a border line across the prompt gutter so the box encloses `> `. */
  private widenBorder(line: string): string {
    if (this.borderClose === '') return `${line}──`
    const index = line.lastIndexOf(this.borderClose)
    return index === -1 ? line : `${line.slice(0, index)}──${line.slice(index)}`
  }
}

/** Stable focus target whose visible child changes between editor, picker and requests. */
class ComposerSlot implements Component, Focusable {
  private children: Component[] = []
  private active: Component | undefined
  private _focused = false

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    const active = this.active
    if (active !== undefined && 'focused' in active) (active as Component & Focusable).focused = value
  }

  set(children: Component[], active?: Component): void {
    if (this.active !== undefined && 'focused' in this.active) (this.active as Component & Focusable).focused = false
    this.children = children
    this.active = active
    if (active !== undefined && 'focused' in active) (active as Component & Focusable).focused = this._focused
  }

  invalidate(): void {
    for (const child of this.children) child.invalidate()
  }

  render(width: number): string[] {
    return this.children.flatMap(child => child.render(width))
  }

  handleInput(data: string): void {
    this.active?.handleInput?.(data)
  }
}

export interface TerminalViewActions {
  choosePicker(value: string): void
  closePicker(): void
}

/** Retained pi-tui layout whose components observe immutable controller snapshots. */
export class TerminalView {
  readonly editor: Editor
  readonly questionEditor: Editor
  readonly transcript: ScrollView
  readonly layout: VStack
  readonly focusTarget: Component

  private state: TuiViewState
  private readonly document: TranscriptDocument
  private readonly notice: StateLine
  private readonly activity: StateLine
  private readonly status: StateLine
  private readonly composer = new ComposerSlot()
  private readonly editorBox: PromptEditor
  private readonly questionEditorBox: PromptEditor
  private pickerSignature = ''
  private picker: SelectList | undefined

  constructor(tui: TUI, state: TuiViewState, private readonly actions: TerminalViewActions) {
    this.state = state
    this.editor = new Editor(tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 })
    this.questionEditor = new Editor(tui, editorTheme, { paddingX: 0 })
    this.editorBox = new PromptEditor(this.editor)
    this.questionEditorBox = new PromptEditor(this.questionEditor)
    this.document = new TranscriptDocument(state)
    this.transcript = new ScrollView(this.document, {
      follow: 'end', primary: true, overscroll: 'contain', scrollbar: 'auto', scrollbarStyle: ansi.gray,
    })
    this.notice = new StateLine(state, renderNotice)
    this.activity = new StateLine(state, renderActivity)
    this.status = new StateLine(state, renderStatus)
    this.focusTarget = this.composer
    this.layout = new VStack([
      { component: this.transcript, basis: 0, grow: 1, shrink: 1, minSize: 2 },
      { component: this.notice, basis: 'auto', shrink: 0, maxSize: 1 },
      { component: this.activity, basis: 'auto', shrink: 1, maxSize: 3 },
      { component: this.composer, basis: 'auto', shrink: 1, minSize: 3, maxSize: 18 },
      { component: this.status, basis: 'auto', shrink: 0, minSize: 1, maxSize: 2 },
    ])
    this.update(state, 0, false)
  }

  update(state: TuiViewState, questionIndex: number, questionSubmitting: boolean): void {
    this.state = state
    this.document.update(state)
    this.notice.update(state)
    this.activity.update(state)
    this.status.update(state)
    this.updateComposer(questionIndex, questionSubmitting)
  }

  invalidate(): void {
    this.layout.invalidate()
  }

  private updateComposer(questionIndex: number, questionSubmitting: boolean): void {
    const interaction = this.state.interaction
    if (interaction?.kind === 'approval') {
      this.pickerSignature = ''
      this.picker = undefined
      this.composer.set([
        new Text(ansi.yellow(ansi.bold(`需要授权 · ${interaction.toolName}`)), 1, 0),
        ...(interaction.reason === undefined ? [] : [new Text(interaction.reason, 1, 0)]),
        new Text(ansi.dim('按 y 仅允许本次，按 n 拒绝 · Ctrl+C 退出'), 1, 0),
      ])
      return
    }
    if (interaction?.kind === 'question') {
      this.pickerSignature = ''
      this.picker = undefined
      const question = interaction.questions[questionIndex]
      const prompt = question === undefined
        ? [new Text(ansi.yellow('正在提交回答…'), 1, 0)]
        : questionComponents(question, questionIndex, interaction.questions.length)
      this.questionEditor.disableSubmit = questionSubmitting
      this.composer.set([
        ...prompt,
        this.questionEditorBox,
        new Text(ansi.dim(`${question?.multiSelect === true ? '多个编号用逗号分隔，或输入自定义回答 · ' : ''}Enter 确认 · Esc 取消请求`), 1, 0),
      ], this.questionEditorBox)
      return
    }
    this.editor.disableSubmit = false
    const picker = this.state.picker
    if (picker !== undefined) {
      const signature = `${picker.kind}\u0000${picker.title}\u0000${picker.current ?? ''}\u0000${picker.items.map(item => `${item.value}\u0001${item.label}\u0001${item.description ?? ''}`).join('\u0002')}`
      if (signature !== this.pickerSignature) {
        this.pickerSignature = signature
        this.picker = new SelectList(picker.items, 8, selectListTheme)
        this.picker.setSelectedIndex(Math.max(0, picker.items.findIndex(item => item.value === picker.current)))
        this.picker.onSelect = (item: SelectItem) => { this.actions.choosePicker(item.value) }
        this.picker.onCancel = () => { this.actions.closePicker() }
      }
      this.composer.set([
        new Text(ansi.magenta(ansi.bold(picker.title)), 1, 0),
        this.picker as SelectList,
        new Text(ansi.dim('↑/↓ 选择 · Enter 确认 · Esc 取消'), 1, 0),
      ], this.picker)
      return
    }
    this.pickerSignature = ''
    this.picker = undefined
    this.composer.set([this.editorBox], this.editorBox)
  }
}

function questionComponents(question: AskUserQuestionItem, index: number, total: number): Component[] {
  const title = question.header ?? question.question
  const components: Component[] = [
    new Text(ansi.yellow(ansi.bold(`问题 ${String(index + 1)}/${String(total)} · ${title}`)), 1, 0),
  ]
  if (question.header !== undefined) components.push(new Text(question.question, 1, 0))
  if (question.detail !== undefined) components.push(new Text(ansi.dim(limitedLines(question.detail, 6)), 1, 0))
  for (const [optionIndex, option] of (question.options ?? []).entries()) {
    components.push(new Text(`${ansi.cyan(`${String(optionIndex + 1)}.`)} ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`, 1, 0))
  }
  return components
}

function renderNotice(state: TuiViewState): string[] {
  if (state.notice === undefined) return []
  return [state.phase === 'error' ? ansi.red(`◆ ${oneLine(state.notice)}`) : ansi.yellow(`◆ ${oneLine(state.notice)}`)]
}

function renderActivity(state: TuiViewState): string[] {
  const goal = projectedGoal(state)
  const remaining = state.todos.filter(todo => todo.status !== 'completed')
  const todoSummary = remaining.slice(0, 3).map(todo => `${todo.status === 'in_progress' ? '◆' : '·'} ${oneLine(todo.content)}`).join(' · ')
  const queueSummary = state.queueItems.slice(0, 2).map(item => oneLine(contentText(item.message.content))).join(' · ')
  const lines: string[] = []
  if (remaining.length > 0) {
    lines.push(`${ansi.bold(`待办 ${String(remaining.length)}/${String(state.todos.length)}`)} · ${todoSummary}`)
  }
  if (goal !== undefined) lines.push(`${ansi.bold(`目标 · ${goal.phase}`)} · ${ansi.cyan(oneLine(goal.objective))}`)
  const activity = [
    state.queueSize > 0 ? `队列 ${String(state.queueSize)}${queueSummary === '' ? '' : ` · ${queueSummary}`}` : undefined,
    state.jobs.length > 0 ? `任务 ${String(state.jobs.length)} · ${state.jobs.slice(0, 2).map(job => `${job.status === 'running' ? '●' : '○'} ${oneLine(job.label)}`).join(' · ')}` : undefined,
    state.workflows.length > 0 ? `工作流 ${String(state.workflows.length)} · ${state.workflows.slice(-2).map(workflow => `${workflow.status === 'running' ? '◆' : workflow.status === 'completed' ? '✓' : '◇'} ${oneLine(workflow.name)}`).join(' · ')}` : undefined,
  ].filter(value => value !== undefined).join(' │ ')
  if (activity !== '') lines.push(ansi.dim(activity))
  return lines.slice(0, 3)
}

function renderStatus(state: TuiViewState, width: number): string[] {
  const status = projectionStatus(state.projections)
  const phase = state.phase === 'loading' ? '正在连接' : state.phase === 'error' ? '启动失败' : state.running ? '执行中' : '就绪'
  const phaseLabel = state.phase === 'error'
    ? ansi.red(`● ${phase}`)
    : state.running ? ansi.yellow(`● ${phase}`) : ansi.green(`● ${phase}`)
  const context = status.context === undefined
    ? undefined
    : status.context.percent >= 85
      ? ansi.red(`${String(status.context.percent)}%`)
      : status.context.percent >= 65 ? ansi.yellow(`${String(status.context.percent)}%`) : ansi.green(`${String(status.context.percent)}%`)
  const plan = status.plan === undefined
    ? undefined
    : status.plan.pending
      ? ansi.yellow(`计划${status.plan.active ? '关闭' : '开启'} · 切换中`)
      : status.plan.active ? ansi.cyan('计划') : undefined
  const contextWindow = state.modelContextWindow ?? status.contextWindow
  return balanceSegments([
    phaseLabel,
    state.agentPreset === undefined ? undefined : ansi.bold(state.agentPreset),
    state.model === undefined ? undefined : ansi.dim(shorten(state.model, 36)),
    state.reasoningEffort,
    state.cwd === undefined ? undefined : ansi.dim(shorten(state.cwd, Math.max(18, Math.floor(width / 3)))),
    status.session === undefined ? undefined : `${String(status.session.turns)} 轮 · ${String(status.session.steps)} 步`,
    status.tokens === undefined ? undefined : `↑${formatCount(status.tokens.input)} ↓${formatCount(status.tokens.output)}`,
    context,
    contextWindow === undefined ? undefined : formatCount(contextWindow),
    state.queueSize > 0 ? `队列 ${String(state.queueSize)}` : undefined,
    state.jobs.length > 0 ? `任务 ${String(state.jobs.length)}` : undefined,
    status.permission === undefined ? undefined : ansi.cyan(shorten(status.permission, 18)),
    plan,
  ].filter(value => value !== undefined), width)
}
