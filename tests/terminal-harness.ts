import { Terminal as HeadlessTerminal } from '@xterm/headless'
import type { Terminal } from '@earendil-works/pi-tui'
import type { TuiController } from '../src/controller.ts'
import { createInitialState, type TuiViewState } from '../src/model.ts'
import type { ProviderSetupField } from '../src/provider-setup.ts'

/** pi-tui terminal adapter backed by xterm's real parser and screen buffers. */
export class TestTerminal implements Terminal {
  readonly emulator: HeadlessTerminal
  readonly writes: string[] = []
  startCount = 0
  stopCount = 0
  private input: ((data: string) => void) | undefined
  private resizeListener: (() => void) | undefined

  constructor(public columns = 100, public rows = 24) {
    this.emulator = new HeadlessTerminal({
      cols: columns,
      rows,
      allowProposedApi: true,
      scrollback: 2_000,
    })
  }

  get kittyProtocolActive(): boolean { return false }

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.startCount += 1
    this.input = onInput
    this.resizeListener = onResize
  }

  stop(): void {
    this.stopCount += 1
    this.input = undefined
    this.resizeListener = undefined
  }

  async drainInput(): Promise<void> {}

  write(data: string): void {
    this.writes.push(data)
    this.emulator.write(data)
  }

  moveBy(lines: number): void {
    if (lines !== 0) this.write(`\u001B[${String(Math.abs(lines))}${lines > 0 ? 'B' : 'A'}`)
  }

  hideCursor(): void { this.write('\u001B[?25l') }
  showCursor(): void { this.write('\u001B[?25h') }
  clearLine(): void { this.write('\u001B[2K') }
  clearFromCursor(): void { this.write('\u001B[0J') }
  clearScreen(): void { this.write('\u001B[2J\u001B[H') }
  setTitle(title: string): void { this.write(`\u001B]0;${title}\u0007`) }
  setProgress(_active: boolean): void {}

  send(data: string): void {
    this.input?.(data)
  }

  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.emulator.resize(columns, rows)
    this.resizeListener?.()
  }

  async flush(): Promise<void> {
    await new Promise<void>(resolve => { this.emulator.write('', resolve) })
  }

  viewportLines(): string[] {
    const buffer = this.emulator.buffer.active
    return Array.from({ length: this.rows }, (_, index) => (
      buffer.getLine(buffer.viewportY + index)?.translateToString(true) ?? ''
    ))
  }

  viewport(): string {
    return this.viewportLines().join('\n')
  }
}

export class TestController {
  state: TuiViewState
  readonly submissions: Array<{ text: string; mode: 'queue' | 'steer' }> = []
  readonly pickerValues: string[] = []
  readonly approvals: string[] = []
  readonly questionAnswers: unknown[] = []
  readonly wizardRows: number[] = []
  readonly wizardValues: Array<{ row: ProviderSetupField; text: string }> = []
  cancelCount = 0
  cancelQuestionCount = 0
  closePickerCount = 0
  closeOverlayCount = 0
  cancelWizardCount = 0
  backWizardCount = 0
  startCount = 0
  disposeCount = 0
  toggleFoldCount = 0
  submitResult: (text: string, mode: 'queue' | 'steer') => Promise<boolean> = async () => true
  answerQuestionResult = true
  private readonly listeners = new Set<() => void>()

  constructor(state: Partial<TuiViewState> = {}) {
    this.state = { ...createInitialState(), phase: 'ready', ...state }
  }

  getSnapshot = (): TuiViewState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publish(update: Partial<TuiViewState>): void {
    this.state = { ...this.state, ...update }
    for (const listener of this.listeners) listener()
  }

  async start(): Promise<void> { this.startCount += 1 }

  async submit(text: string, mode: 'queue' | 'steer' = 'queue'): Promise<boolean> {
    this.submissions.push({ text, mode })
    return this.submitResult(text, mode)
  }

  async choosePicker(value: string): Promise<void> { this.pickerValues.push(value) }
  closePicker(): void { this.closePickerCount += 1 }
  closeOverlay(): void { this.closeOverlayCount += 1 }
  async cancel(): Promise<void> { this.cancelCount += 1 }
  async answerApproval(outcome: string): Promise<void> { this.approvals.push(outcome) }
  async answerQuestion(answer: unknown): Promise<boolean> {
    this.questionAnswers.push(answer)
    return this.answerQuestionResult
  }
  async cancelQuestion(): Promise<void> { this.cancelQuestionCount += 1 }
  chooseProviderWizardRow(row: number): void { this.wizardRows.push(row) }
  submitProviderWizardValue(row: ProviderSetupField, text: string): void { this.wizardValues.push({ row, text }) }
  cancelProviderWizard(): void { this.cancelWizardCount += 1 }
  backProviderWizardToMenu(): void { this.backWizardCount += 1 }
  toggleFold(): void { this.toggleFoldCount += 1 }
  dispose(): void { this.disposeCount += 1 }

  asController(): TuiController {
    return this as unknown as TuiController
  }
}

export async function settle(terminal: TestTerminal): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 35))
  await terminal.flush()
}
