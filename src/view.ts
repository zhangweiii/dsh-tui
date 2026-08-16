/** pi-tui component tree for the fixed viewport application. */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  Editor, fuzzyFilter, Input, Markdown, matchesKey, ScrollView, SelectList, stripTerminalSequences, Text, truncateToWidth, visibleWidth, VStack,
  wrapTextWithAnsi, type Component, type Focusable, type SelectItem, type TUI,
} from '@earendil-works/pi-tui'
import {
  contentText, isExpandedRow, projectionStatus, type TranscriptRow, type TuiPicker,
  type TuiPickerItem, type TuiProviderWizard, type TuiViewState,
} from './model.ts'
import { providerSetupRows, providerSetupValidation, type ProviderSetupField } from './provider-setup.ts'
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

const COLLAPSED_MARKER = '▸'
const EXPANDED_MARKER = '▾'

/**
 * One verbose card row, mirroring the Web disclosure row. Rows with a detail
 * (skill catalog, injected context, tool output, compaction, retries, …) render
 * folded into a one-line header so they do not crowd the transcript; the detail
 * is unfolded on demand with Ctrl+Shift+E, and a running row stays unfolded.
 * @param row - The card row to render.
 * @param label - Terminal label for this row kind.
 * @param expanded - Whether this row's detail is currently unfolded.
 */
function cardRow(row: TranscriptRow, label: string, expanded: boolean): Component {
  const style = row.kind === 'context' ? ansi.dim : statusStyle(row)
  const icon = row.kind === 'context' ? '' : `${statusIcon(row)} `
  const marker = expanded ? EXPANDED_MARKER : COLLAPSED_MARKER
  const children: Component[] = [
    new Text(`\n${marker} ${style(ansi.bold(`${icon}${label} · ${row.text}`))}`, 1, 0),
  ]
  if (expanded && row.detail !== undefined) children.push(new Text(ansi.dim(limitedLines(row.detail, 12)), 2, 0))
  return new VStack(children)
}

function rowComponent(row: TranscriptRow, rowExpanded: boolean): Component {
  const cardLabel = CARD_LABELS[row.kind]
  if (cardLabel !== undefined && row.kind !== 'deliverable') {
    return cardRow(row, cardLabel, rowExpanded)
  }
  if (row.kind === 'deliverable') {
    const children: Component[] = [
      new Text(`\n${ansi.green(ansi.bold(`✓ ${cardLabel} · ${row.text}`))}`, 1, 0),
    ]
    if (row.detail !== undefined) children.push(new Text(ansi.dim(limitedLines(row.detail, 12)), 2, 0))
    children.push(new Text(ansi.dim('使用 /open <path> 打开'), 2, 0))
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
      const rowExpanded = isExpandedRow(row, this.state.expanded)
      const signature = `${row.kind}\u0000${row.text}\u0000${row.detail ?? ''}\u0000${row.status ?? ''}\u0000${row.messageId ?? ''}\u0000${String(rowExpanded)}`
      let cached = this.cache.get(row.id)
      if (cached === undefined || cached.signature !== signature) {
        cached = { signature, component: rowComponent(row, rowExpanded) }
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
      new Text(ansi.dim('Esc 或 /close 关闭面板；此处可直接输入下一条命令'), 1, 0),
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

/** Sentinel `SelectItem.value` marking the trailing "custom answer" entry. */
const CUSTOM_ANSWER_VALUE = '\u0000custom-answer'

/**
 * A single-select option picker for a structured question. The candidate options
 * render as an arrow-navigable `SelectList`; Up/Down moves the highlight, Enter
 * confirms the highlighted option, and typing any printable character switches to a
 * small editor for a free-text "custom" answer (Enter submits, Escape returns to the
 * option list). This mirrors how other terminal agents let a user both pick from a
 * menu and supply an "Other" answer.
 */
class QuestionPicker implements Component, Focusable {
  private list: SelectList
  private readonly editor: Editor
  private readonly editorBox: PromptEditor
  private readonly tui: TUI
  private mode: 'select' | 'custom' = 'select'
  private _focused = false
  private optionsSignature = ''

  constructor(tui: TUI, private readonly actions: QuestionPickerActions) {
    this.tui = tui
    this.editor = new Editor(tui, editorTheme, { paddingX: 0 })
    this.editor.onSubmit = text => {
      if (this.mode !== 'custom') return
      this.setMode('select')
      this.actions.submitCustom(text)
    }
    this.editorBox = new PromptEditor(this.editor)
    this.list = new SelectList([], 8, selectListTheme)
    this.updateList([], this.actions)
  }

  /**
   * Rebuild the option list for a question. Safe to call on every view update;
   * the underlying list is only replaced when the options actually change so the
   * retained selection survives unrelated re-renders. Starting a new question also
   * returns the picker to the option list and clears any custom draft.
   */
  update(question: AskUserQuestionItem): void {
    const options = question.options ?? []
    const items: SelectItem[] = options.map(option => ({
      value: option.label,
      label: option.label,
      description: option.description,
    }))
    items.push({ value: CUSTOM_ANSWER_VALUE, label: `${ansi.bold('✎ 其他 / 自定义…')}` })
    this.updateList(items, this.actions)
  }

  private updateList(items: SelectItem[], actions: QuestionPickerActions): void {
    const signature = items.map(item => `${item.value}\u0001${item.description ?? ''}`).join('\u0002')
    if (this.optionsSignature === signature) return
    this.optionsSignature = signature
    this.mode = 'select'
    this.editor.setText('')
    this.list = new SelectList(items, 8, selectListTheme)
    this.list.onCancel = () => { if (this.mode === 'select') actions.cancel() }
    this.list.onSelect = item => {
      if (item.value === CUSTOM_ANSWER_VALUE) this.enterCustom()
      else actions.chooseOption(item.value)
    }
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.editor.focused = value
  }

  invalidate(): void {
    this.editor.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (this.mode === 'custom') {
      // Escape leaves the custom editor and returns to the option menu.
      if (matchesKey(data, 'escape') && this.editor.getText() === '') {
        this.setMode('select')
        return
      }
      this.editor.handleInput(data)
      return
    }
    // Option mode: any printable character (including the start of CJK text)
    // moves the user into the custom editor so they never have to reach the
    // trailing menu entry. Control/escape sequences stay with the list.
    if (data.charCodeAt(0) >= 32) {
      this.enterCustom(data)
      return
    }
    this.list.handleInput(data)
  }

  private enterCustom(initial = ''): void {
    if (this.mode === 'select') {
      this.editor.setText('')
      this.mode = 'custom'
    }
    if (initial !== '') this.editor.insertTextAtCursor(initial)
    this.editor.focused = this._focused
    this.tui.requestRender()
  }

  private setMode(mode: 'select' | 'custom'): void {
    if (this.mode === mode) return
    this.mode = mode
    if (mode === 'select') this.editor.setText('')
    this.editor.focused = this.mode === 'custom' && this._focused
    this.tui.requestRender()
  }

  render(width: number): string[] {
    if (this.mode === 'select') {
      return [...this.list.render(width), ansi.dim('↑/↓ 选择 · Enter 确认 · 输入即 other 自定义 · Esc 取消')]
    }
    return [
      ...this.editorBox.render(width),
      ansi.dim('输入自定义回答 · Enter 确认 · Esc 返回选项'),
    ]
  }
}

interface QuestionPickerActions {
  chooseOption(label: string): void
  submitCustom(text: string): void
  cancel(): void
}

/** Sentinel `SelectItem.value` marking the "confirm all" row. */
const REVIEW_CONFIRM_VALUE = '\u0000review-confirm'

/** Human-readable rendering of one answer item for the confirmation summary. */
function formatAnswer(item: AskUserQuestionAnswerItem | undefined): string {
  if (item === undefined) return ansi.dim('（未作答）')
  if (item.custom !== undefined) return `${ansi.bold(item.custom)}`
  if (item.selected.length > 0) return `${ansi.bold(item.selected.join('、'))}`
  return ansi.dim('（未选择）')
}

/**
 * The confirmation summary shown after the last question of a batch. Every
 * answered question is listed as "question → your answer"; the user moves the
 * highlight with Up/Down and presses Enter on a question row to revisit it, or
 * on the trailing row to submit the whole batch.
 */
class QuestionReview implements Component, Focusable {
  private list: SelectList
  private readonly tui: TUI
  private _focused = false
  private signature = ''

  constructor(tui: TUI, private readonly actions: QuestionReviewActions) {
    this.tui = tui
    this.list = new SelectList([], 8, selectListTheme)
  }

  update(questions: AskUserQuestionItem[], answers: AskUserQuestionAnswerItem[]): void {
    const rows: SelectItem[] = questions.map((question, index) => {
      const title = question.header ?? question.question
      return {
        value: String(index),
        label: `问题 ${String(index + 1)} · ${title}`,
        description: formatAnswer(answers[index]),
      }
    })
    rows.push({ value: REVIEW_CONFIRM_VALUE, label: `${ansi.bold('✅ 确认提交全部回答')}` })
    const signature = rows.map(row => `${row.value}\u0001${row.label}\u0001${row.description ?? ''}`).join('\u0002')
    if (this.signature === signature) return
    this.signature = signature
    this.list = new SelectList(rows, 8, selectListTheme)
    this.list.onCancel = () => { this.actions.cancel() }
    this.list.onSelect = item => {
      if (item.value === REVIEW_CONFIRM_VALUE) this.actions.confirm()
      else this.actions.edit(Number(item.value))
    }
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) { this._focused = value }

  invalidate(): void { this.list.invalidate() }

  handleInput(data: string): void {
    // The review is a plain navigable list; printable characters are ignored.
    this.list.handleInput(data)
  }

  render(width: number): string[] { return this.list.render(width) }
}

interface QuestionReviewActions {
  edit(index: number): void
  confirm(): void
  cancel(): void
}

class ProviderSearchPicker implements Component, Focusable {
  private readonly input = new Input()
  private items: TuiPickerItem[] = []
  private filtered: TuiPickerItem[] = []
  private selectedIndex = 0
  private signature = ''
  private _focused = false

  constructor(
    private readonly choose: (value: string) => void,
    private readonly cancel: () => void,
  ) {
    this.input.onSubmit = () => {
      const selected = this.filtered[this.selectedIndex]
      if (selected !== undefined) this.choose(selected.value)
    }
    this.input.onEscape = this.cancel
  }

  update(picker: TuiPicker): void {
    const signature = picker.items.map(item => `${item.value}\u0001${item.label}\u0001${item.description ?? ''}`).join('\u0002')
    if (signature === this.signature) return
    this.signature = signature
    this.items = picker.items
    this.input.setValue('')
    this.filter('')
  }

  private filter(query: string): void {
    this.filtered = query === ''
      ? this.items
      : fuzzyFilter(this.items, query, item => `${item.label} ${item.value} ${item.description ?? ''}`)
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.filtered.length - 1))
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.input.focused = value
  }

  invalidate(): void { this.input.invalidate() }

  handleInput(data: string): void {
    if (matchesKey(data, 'up')) {
      if (this.filtered.length > 0) this.selectedIndex = Math.max(0, this.selectedIndex - 1)
      return
    }
    if (matchesKey(data, 'down')) {
      if (this.filtered.length > 0) this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1)
      return
    }
    if (matchesKey(data, 'escape')) {
      this.cancel()
      return
    }
    this.input.handleInput(data)
    this.filter(this.input.getValue())
  }

  render(width: number): string[] {
    const maxVisible = 8
    const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filtered.length - maxVisible))
    const visible = this.filtered.slice(start, start + maxVisible)
    return [
      ...this.input.render(width),
      '',
      ...(visible.length === 0
        ? [ansi.dim('  没有匹配的 Provider')]
        : visible.map((item, offset) => {
            const selected = start + offset === this.selectedIndex
            const prefix = selected ? ansi.cyan('→ ') : '  '
            const label = selected ? ansi.cyan(item.label) : item.label
            const detail = item.description === undefined ? '' : ansi.dim(`  ${item.description}`)
            return truncateToWidth(`${prefix}${label}${detail}`, width)
          })),
      ...(this.filtered.length > maxVisible ? [ansi.dim(`  (${String(this.selectedIndex + 1)}/${String(this.filtered.length)})`)] : []),
      '',
      ansi.dim('输入搜索 · ↑/↓ 选择 · Enter 确认 · Esc 取消'),
    ]
  }
}

/**
 * Progressive provider setup inspired by pi's login flow: one focused prompt,
 * a small protocol selector, then a compact review. It deliberately avoids a
 * settings-form menu; advanced fields remain owned by the settings commands.
 */
class ProviderWizardPicker implements Component, Focusable {
  private list: SelectList
  /** Dedicated single-line dialog input; never reuses the chat composer Editor. */
  private readonly input: Input
  private _focused = false
  private editingRow: ProviderSetupField | undefined
  private wizard: TuiProviderWizard | undefined
  private rowsSignature = ''
  private editPrompt = ''

  constructor(_tui: TUI, private readonly actions: ProviderWizardActions) {
    this.input = new Input()
    this.input.onSubmit = text => {
      if (this.editingRow !== undefined) this.actions.submitValue(this.editingRow, text)
    }
    this.input.onEscape = () => { this.actions.cancel() }
    this.list = new SelectList([], 8, selectListTheme)
    this.updateList([])
  }

  update(wizard: TuiProviderWizard, editingRow: ProviderSetupField | undefined): void {
    this.wizard = wizard
    if (editingRow !== this.editingRow) {
      this.editingRow = editingRow
      const field = editingRow === undefined
        ? undefined
        : providerSetupRows(wizard).find(row => row.kind === 'field' && row.field === editingRow)
      this.input.setValue(field?.kind === 'field' && field.secret !== true ? field.value ?? '' : '')
    }
    if (editingRow !== undefined) {
      const prompt = wizardPrompt(wizard, editingRow)
      if (prompt !== this.editPrompt) this.editPrompt = prompt
      return
    }
    this.editPrompt = ''
    this.updateList(wizardRowsForView(wizard))
  }

  /** Rebuild the menu list when rows change; keeps selection on unrelated updates. */
  private updateList(rows: SelectItem[]): void {
    const signature = rows.map(row => `${row.value}\u0001${row.label}\u0001${row.description ?? ''}`).join('\u0002')
    if (this.rowsSignature === signature) return
    const selected = this.list.getSelectedItem()?.value
    this.rowsSignature = signature
    this.list = new SelectList(rows, 8, selectListTheme)
    const selectedIndex = selected === undefined ? -1 : rows.findIndex(row => row.value === selected)
    if (selectedIndex >= 0) this.list.setSelectedIndex(selectedIndex)
    this.list.onCancel = () => { this.actions.cancel() }
    this.list.onSelect = item => { this.actions.choose(Number(item.value)) }
  }

  get focused(): boolean { return this._focused }
  set focused(value: boolean) {
    this._focused = value
    this.input.focused = this.editingRow !== undefined && value
  }

  invalidate(): void {
    this.input.invalidate()
    this.list.invalidate()
  }

  handleInput(data: string): void {
    if (this.editingRow !== undefined) {
      this.input.handleInput(data)
      return
    }
    this.list.handleInput(data)
  }

  render(width: number): string[] {
    if (this.editingRow !== undefined) {
      return [
        ansi.yellow(ansi.bold(this.editPrompt)),
        ...this.input.render(width),
        ansi.dim('Enter 继续 · Esc 取消'),
      ]
    }
    const wizard = this.wizard
    if (wizard?.busy === true && wizard.step === 'models') {
      return [ansi.dim('⏳ 正在从 endpoint 获取模型…'), ansi.dim('Esc 取消')]
    }
    const modelRow = wizard === undefined
      ? undefined
      : providerSetupRows(wizard).find(row => row.kind === 'field' && row.field === 'models')
    const modelValue = modelRow?.kind === 'field' ? modelRow.value : undefined
    const summary = wizard?.step === 'review'
      ? [
          `${ansi.dim('Provider')}  ${wizard.providerId}`,
          `${ansi.dim('Endpoint')}  ${wizard.baseURL || '默认'}`,
          `${ansi.dim('协议')}      ${wizard.api || 'adapter 默认'}`,
          `${ansi.dim('模型')}      ${modelValue ?? 'adapter catalog'}`,
          '',
        ]
      : []
    return [
      ...summary,
      ...this.list.render(width),
      ansi.dim(wizard?.step === 'api' ? '↑/↓ 选择协议 · Enter 确认 · Esc 取消' : '↑/↓ 选择 · Enter 确认 · Esc 取消'),
    ]
  }
}

/** Header prompt for a field edit; API keys remain write-only presentation. */
function wizardPrompt(wizard: TuiProviderWizard, editing: ProviderSetupField): string {
  const row = providerSetupRows(wizard).find(item => item.kind === 'field' && item.field === editing)
  if (row?.kind !== 'field') return ''
  if (editing === 'apiKey') {
    return wizard.kind === 'existing'
      ? `输入 ${wizard.providerId} API Key（只写；Enter 保存）`
      : 'API Key（可留空使用 provider 原生认证）'
  }
  if (editing === 'models') return '模型 ID（逗号分隔；留空自动探测）'
  return `${row.label}${row.required === true ? '（必填）' : '（可选）'}${row.hint === undefined ? '' : ` · ${row.hint}`}`
}

function providerSettingsAddress(wizard: TuiProviderWizard): string {
  const path = wizard.kind === 'custom'
    ? [...wizard.settingsPath, wizard.providerId].filter(Boolean)
    : wizard.settingsPath
  return `${wizard.namespace}${path.length === 0 ? '' : `/${path.join('/')}`}`
}

/** Pi-style flow: one focused prompt at a time, then a compact review. */
function wizardRowsForView(wizard: TuiProviderWizard): SelectItem[] {
  if (wizard.step === 'api') {
    return wizard.protocols.map((protocol, index) => ({
      value: String(index), label: protocol,
      description: protocol === wizard.api ? '默认' : undefined,
    }))
  }
  if (wizard.step === 'review') {
    const failure = providerSetupValidation(wizard)
    return [
      {
        value: '0', label: ansi.bold(wizard.busy ? '⏳ 正在保存…' : '✅ 保存 Provider'),
        description: failure === undefined ? ansi.dim(`写入 ${providerSettingsAddress(wizard)}`) : ansi.yellow(failure),
      },
      { value: '1', label: '修改模型', description: '手工调整模型 ID，或重新自动探测' },
    ]
  }
  return []
}

interface ProviderWizardActions {
  choose(row: number): void
  submitValue(field: ProviderSetupField, text: string): void
  cancel(): void
}

export interface TerminalViewActions {
  choosePicker(value: string): void
  closePicker(): void
  chooseQuestionOption(label: string): void
  submitQuestionCustom(text: string): void
  cancelQuestionRequest(): void
  editQuestion(index: number): void
  confirmQuestionAnswers(): void
  chooseProviderWizardRow(row: number): void
  submitProviderWizardValue(field: ProviderSetupField, text: string): void
  cancelProviderWizard(): void
  backProviderWizardToMenu(): void
}

/** Retained pi-tui layout whose components observe immutable controller snapshots. */
export class TerminalView {
  readonly editor: Editor
  readonly questionEditor: Editor
  readonly transcript: ScrollView
  readonly layout: VStack
  readonly focusTarget: Component

  private state: TuiViewState
  private activityExpanded = false
  private readonly document: TranscriptDocument
  private readonly notice: StateLine
  private readonly activity: StateLine
  private readonly status: StateLine
  private readonly composer = new ComposerSlot()
  private readonly editorBox: PromptEditor
  private readonly questionEditorBox: PromptEditor
  private readonly questionPicker: QuestionPicker
  private readonly questionReview: QuestionReview
  private readonly providerWizardPicker: ProviderWizardPicker
  private readonly providerSearchPicker: ProviderSearchPicker
  private questionReviewing = false
  private questionAnswers: AskUserQuestionAnswerItem[] = []
  private pickerSignature = ''
  private picker: SelectList | undefined

  constructor(tui: TUI, state: TuiViewState, private readonly actions: TerminalViewActions) {
    this.state = state
    this.editor = new Editor(tui, editorTheme, { paddingX: 0, autocompleteMaxVisible: 8 })
    this.questionEditor = new Editor(tui, editorTheme, { paddingX: 0 })
    this.editorBox = new PromptEditor(this.editor)
    this.questionEditorBox = new PromptEditor(this.questionEditor)
    this.providerWizardPicker = new ProviderWizardPicker(tui, {
      choose: row => this.actions.chooseProviderWizardRow(row),
      submitValue: (row, text) => this.actions.submitProviderWizardValue(row, text),
      cancel: () => this.actions.cancelProviderWizard(),
    })
    this.providerSearchPicker = new ProviderSearchPicker(
      value => this.actions.choosePicker(value),
      () => this.actions.closePicker(),
    )
    this.questionPicker = new QuestionPicker(tui, {
      chooseOption: label => this.actions.chooseQuestionOption(label),
      submitCustom: text => this.actions.submitQuestionCustom(text),
      cancel: () => this.actions.cancelQuestionRequest(),
    })
    this.questionReview = new QuestionReview(tui, {
      edit: index => this.actions.editQuestion(index),
      confirm: () => this.actions.confirmQuestionAnswers(),
      cancel: () => this.actions.cancelQuestionRequest(),
    })
    this.document = new TranscriptDocument(state)
    this.transcript = new ScrollView(this.document, {
      follow: 'end', primary: true, overscroll: 'contain', scrollbar: 'auto', scrollbarStyle: ansi.gray,
    })
    this.notice = new StateLine(state, renderNotice)
    this.activity = new StateLine(state, (next, _width) => renderActivity(next, this.activityExpanded))
    this.status = new StateLine(state, renderStatus)
    this.focusTarget = this.composer
    this.layout = new VStack([
      { component: this.transcript, basis: 0, grow: 1, shrink: 1, minSize: 2 },
      { component: this.notice, basis: 'auto', shrink: 0, maxSize: 1 },
      { component: this.activity, basis: 'auto', shrink: 1, maxSize: 16 },
      { component: this.composer, basis: 'auto', shrink: 1, minSize: 3, maxSize: 18 },
      { component: this.status, basis: 'auto', shrink: 0, minSize: 1, maxSize: 2 },
    ])
    this.update(state, 0, false, false, [])
  }

  update(
    state: TuiViewState,
    questionIndex: number,
    questionReviewing: boolean,
    questionSubmitting: boolean,
    questionAnswers: AskUserQuestionAnswerItem[],
  ): void {
    this.state = state
    this.questionReviewing = questionReviewing
    this.questionAnswers = questionAnswers
    this.document.update(state)
    this.notice.update(state)
    this.activity.update(state)
    this.status.update(state)
    this.updateComposer(questionIndex, questionSubmitting)
  }

  invalidate(): void {
    this.layout.invalidate()
  }

  /** Toggle whether the activity bar lists every todo or collapses to a summary. */
  toggleActivityBar(): void {
    this.activityExpanded = !this.activityExpanded
    this.activity.invalidate()
  }

  private updateComposer(questionIndex: number, questionSubmitting: boolean): void {
    const wizard = this.state.providerWizard
    if (wizard !== undefined) {
      this.pickerSignature = ''
      this.picker = undefined
      this.providerWizardPicker.update(wizard, wizard.editing)
      this.composer.set([
        new Text(ansi.magenta(ansi.bold(wizard.kind === 'custom'
          ? '添加自定义 Provider'
          : `配置 ${wizard.providerId}`)), 1, 0),
        ...(wizard.error === undefined ? [] : [new Text(ansi.red(`错误：${wizard.error}`), 1, 0)]),
        this.providerWizardPicker,
      ], this.providerWizardPicker)
      return
    }
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
      // After the last question the batch moves to a confirmation summary that
      // lists every "question → answer"; the user confirms all or revisits any
      // single entry before the answer is sent to the host.
      if (this.questionReviewing) {
        this.questionReview.update(interaction.questions, this.questionAnswers)
        this.composer.set([
          new Text(ansi.green(ansi.bold('请确认你的回答')), 1, 0),
          this.questionReview,
          new Text(ansi.dim('↑/↓ 查看 · Enter 修改选中项或确认提交 · Esc 取消请求'), 1, 0),
        ], this.questionReview)
        return
      }
      const question = interaction.questions[questionIndex]
      if (question === undefined) {
        this.composer.set([new Text(ansi.yellow('正在提交回答…'), 1, 0)])
        return
      }
      const prompt = questionComponents(question, questionIndex, interaction.questions.length, false)
      // Single-select with options becomes an arrow-navigable menu with a typed
      // custom-answer fallback; multi-select or option-less questions keep the
      // number/custom-text editor.
      if (question.multiSelect !== true && (question.options?.length ?? 0) > 0) {
        this.questionPicker.update(question)
        this.composer.set([...prompt, this.questionPicker], this.questionPicker)
        return
      }
      const numberedPrompt = questionComponents(question, questionIndex, interaction.questions.length, true)
      this.questionEditor.disableSubmit = questionSubmitting
      this.composer.set([
        ...numberedPrompt,
        this.questionEditorBox,
        new Text(ansi.dim(`${question.multiSelect === true ? '多个编号用逗号分隔，或输入自定义回答 · ' : ''}Enter 确认 · Esc 取消请求`), 1, 0),
      ], this.questionEditorBox)
      return
    }
    this.editor.disableSubmit = false
    const picker = this.state.picker
    if (picker?.kind === 'provider-setup') {
      this.pickerSignature = ''
      this.picker = undefined
      this.providerSearchPicker.update(picker)
      this.composer.set([
        new Text(ansi.magenta(ansi.bold('选择要配置的 Provider')), 1, 0),
        this.providerSearchPicker,
      ], this.providerSearchPicker)
      return
    }
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

function questionComponents(question: AskUserQuestionItem, index: number, total: number, includeOptions: boolean): Component[] {
  const title = question.header ?? question.question
  const components: Component[] = [
    new Text(ansi.yellow(ansi.bold(`问题 ${String(index + 1)}/${String(total)} · ${title}`)), 1, 0),
  ]
  if (question.header !== undefined) components.push(new Text(question.question, 1, 0))
  if (question.detail !== undefined) components.push(new Text(ansi.dim(limitedLines(question.detail, 6)), 1, 0))
  // The arrow-navigable menu renders the options itself, so only the numbered
  // listing is emitted for the editor path (option-less and multi-select) where
  // the user types numbers. Rendering both would duplicate every option.
  if (includeOptions) {
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      components.push(new Text(`${ansi.cyan(`${String(optionIndex + 1)}.`)} ${option.label}${option.description === undefined ? '' : ` — ${option.description}`}`, 1, 0))
    }
  }
  return components
}

function renderNotice(state: TuiViewState): string[] {
  if (state.notice === undefined) return []
  return [state.phase === 'error' ? ansi.red(`◆ ${oneLine(state.notice)}`) : ansi.yellow(`◆ ${oneLine(state.notice)}`)]
}

/** Status marker for a single background job. */
function jobMarker(job: { status: string }): string {
  switch (job.status) {
    case 'running': return '●'
    case 'stopping': return '◌'
    case 'failed': return '✗'
    default: return '○' // completed, killed
  }
}

/** A job still worth surfacing: still live or newly failed, not one that finished. */
function isLiveJob(job: { status: string }): boolean {
  return job.status === 'running' || job.status === 'stopping' || job.status === 'failed'
}

function jobColor(job: { status: string }): (text: string) => string {
  if (job.status === 'failed') return ansi.red
  if (job.status === 'running') return ansi.cyan
  return ansi.dim
}

/** Status marker for a workflow run. */
function workflowMarker(workflow: { status: string }): string {
  switch (workflow.status) {
    case 'running': return '▶'
    case 'failed':
    case 'interrupted':
    case 'cancelled': return '✕'
    default: return '▪' // completed
  }
}

function renderActivity(state: TuiViewState, expanded: boolean): string[] {
  const goal = projectedGoal(state)
  const total = state.todos.length
  const remaining = state.todos.filter(todo => todo.status !== 'completed')
  const completed = total - remaining.length
  const inProgress = remaining.find(todo => todo.status === 'in_progress')
  const queueSummary = state.queueItems.slice(0, 2).map(item => oneLine(contentText(item.message.content))).join(' · ')
  // A settled job no longer occupies the dock; only live or failed ones stay
  // visible, mirroring how a finished todo falls out of the progress count.
  const liveJobs = state.jobs.filter(isLiveJob)
  const jobRenderer = (job: { status: string; kind: string; label: string; detail?: string }): string => {
    const detail = job.detail === undefined ? '' : `（${oneLine(job.detail)}）`
    return `${jobColor(job)(`${jobMarker(job)}`)} ${oneLine(job.kind)} · ${oneLine(job.label)}${detail}`
  }
  const lines: string[] = []
  if (expanded) {
    // Expanded: separate sections keep the plan (todo) apart from live
    // processes (job) and multi-step runs (workflow), so many of each stay
    // readable instead of collapsing into one ambiguous strip.
    if (remaining.length > 0) {
      lines.push(`${ansi.bold(`待办 已办 ${String(completed)}/${String(total)}`)}`)
      for (const todo of state.todos) {
        if (todo.status === 'in_progress') {
          lines.push(` ${ansi.cyan(ansi.bold('◆'))} ${ansi.bold(oneLine(todo.content))}`)
        } else if (todo.status === 'completed') {
          lines.push(` ${ansi.green('✓')} ${ansi.dim(oneLine(todo.content))}`)
        } else {
          lines.push(` · ${oneLine(todo.content)}`)
        }
      }
    }
    if (liveJobs.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push(`${ansi.bold(`任务 ${String(liveJobs.length)}`)}`)
      for (const job of liveJobs) lines.push(` ${jobRenderer(job)}`)
    }
    if (state.workflows.length > 0) {
      if (lines.length > 0) lines.push('')
      lines.push(`${ansi.bold(`工作流 ${String(state.workflows.length)}`)}`)
      for (const workflow of state.workflows.slice(0, 8)) {
        lines.push(` ${workflowMarker(workflow)} ${oneLine(workflow.name)}`)
      }
    }
    if (goal !== undefined) {
      if (lines.length > 0) lines.push('')
      lines.push(`${ansi.bold(`目标 · ${goal.phase}`)} · ${ansi.cyan(oneLine(goal.objective))}`)
    }
    if (queueSummary !== '' && state.queueSize > 0) lines.push(ansi.dim(`队列 ${String(state.queueSize)} · ${queueSummary}`))
    // Keep the whole block separated from both the transcript and the editor.
    if (lines.length > 0) {
      lines.unshift('')
      lines.push('')
    }
  } else {
    // Collapsed: a single strip pulling the todo summary and the live
    // job/workflow summary into the same row, followed by goal and queue.
    const todoSummary = inProgress === undefined
      ? remaining.slice(0, 3).map(todo => `· ${oneLine(todo.content)}`).join(' · ')
      : `${ansi.cyan(ansi.bold('◆'))} ${ansi.bold(oneLine(inProgress.content))}`
    const segments = [
      remaining.length > 0 ? `${ansi.bold(`待办 已办 ${String(completed)}/${String(total)}`)}${todoSummary === '' ? '' : ` · ${todoSummary}`}` : undefined,
      liveJobs.length > 0 ? `${ansi.bold(`任务 ${String(liveJobs.length)}`)} · ${liveJobs.slice(0, 2).map(jobRenderer).join(' · ')}` : undefined,
      state.workflows.length > 0 ? `${ansi.bold(`工作流 ${String(state.workflows.length)}`)}` : undefined,
    ].filter(value => value !== undefined).join(' │ ')
    // Pull the todo, job, and workflow summaries into one strip, padded above
    // so it is not glued to the transcript.
    if (segments !== '') lines.push('', segments)
    if (goal !== undefined) lines.push(`${ansi.bold(`目标 · ${goal.phase}`)} · ${ansi.cyan(oneLine(goal.objective))}`)
    if (queueSummary !== '' && state.queueSize > 0) lines.push(ansi.dim(`队列 ${String(state.queueSize)} · ${queueSummary}`))
  }
  return lines
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
    state.jobs.some(isLiveJob) ? `任务 ${String(state.jobs.filter(isLiveJob).length)}` : undefined,
    status.permission === undefined ? undefined : ansi.cyan(shorten(status.permission, 18)),
    plan,
  ].filter(value => value !== undefined), width)
}
