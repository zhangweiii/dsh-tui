/** Terminal lifecycle and input coordinator built on pi-tui. */

import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions/types'
import {
  CombinedAutocompleteProvider, isKeyRelease, KeybindingsManager, matchesKey, ProcessTerminal,
  setKeybindings, TUI_KEYBINDINGS, TuiAltScreen,
  type Terminal,
} from '@earendil-works/pi-tui'
import { slashCommands } from './commands.ts'
import type { TuiController } from './controller.ts'
import type { Config } from './index.ts'
import type { PendingQuestion, TuiViewState } from './model.ts'
import { TerminalView, type QuestionFlowSnapshot } from './view.ts'
import {
  DEFAULT_TERMINAL_TITLE, sanitizeTerminalText, terminalNotificationSequence,
  type TerminalNotificationEnvironment,
} from './terminal-controls.ts'

export interface TerminalApplicationOptions {
  terminal?: Terminal
  onExit?: (code: number) => void
  /** Explicit terminal title; when absent, the current session title is used. */
  title?: string
  /** Capability hints used to select the terminal notification protocol. */
  notificationEnvironment?: TerminalNotificationEnvironment
}

/** Mutable state machine behind one pending structured-question batch. */
class QuestionFlow implements QuestionFlowSnapshot {
  index = 0
  reviewing = false
  submitting = false
  answers: AskUserQuestionAnswerItem[] = []

  /** Reset the flow when the owned interaction changes or clears. */
  reset(): void {
    this.index = 0
    this.reviewing = false
    this.submitting = false
    this.answers = []
  }
}

function interactionKey(state: TuiViewState): string {
  return state.interaction === undefined ? '' : String(state.interaction.rpcId)
}

function optionAnswer(question: AskUserQuestionItem, value: string): AskUserQuestionAnswerItem {
  const normalized = value.trim()
  const options = question.options ?? []
  if (normalized === '') return { id: question.id, selected: [] }
  const indices = normalized.split(',').map(part => Number(part.trim()))
  const numeric = indices.length > 0 && indices.every(index => Number.isInteger(index) && index >= 1 && index <= options.length)
  if (numeric) {
    const selected = [...new Set(indices.map(index => (options[index - 1] as NonNullable<typeof options[number]>).label))]
    return { id: question.id, selected: question.multiSelect === true ? selected : selected.slice(0, 1) }
  }
  return { id: question.id, selected: [], custom: normalized }
}

const TITLE_SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const TITLE_SPINNER_INTERVAL_MS = 80

function turnCompletionMessage(kind: string): string {
  switch (kind) {
    case 'completed': return '执行完成'
    case 'error': return '执行失败'
    case 'aborted': return '执行已取消'
    case 'max-tokens': return '执行结束：达到输出上限'
    default: return `执行结束：${kind}`
  }
}

/** One complete alternate-screen application for one controller. */
export class TerminalApplication {
  readonly tui: TuiAltScreen
  readonly view: TerminalView

  private state: TuiViewState
  private readonly terminal: Terminal
  private terminalTitleOverride: string | undefined
  private appliedTerminalTitle: string | undefined
  private titleSpinnerTimer: ReturnType<typeof setInterval> | undefined
  private titleSpinnerFrame = 0
  private progressActive = false
  private notificationsArmed: boolean
  private lastNotifiedTurnEndSeq: number
  private started = false
  private stopped = false
  private unsubscribe: (() => void) | undefined
  private removeInputListener: (() => void) | undefined
  private readonly question = new QuestionFlow()
  private currentInteractionKey = ''

  constructor(
    private readonly controller: TuiController,
    private readonly config: Config,
    private readonly options: TerminalApplicationOptions = {},
  ) {
    this.state = controller.getSnapshot()
    this.terminal = options.terminal ?? new ProcessTerminal()
    this.terminalTitleOverride = options.title === undefined ? undefined : sanitizeTerminalText(options.title)
    this.notificationsArmed = this.state.phase === 'ready'
    this.lastNotifiedTurnEndSeq = this.state.lastTurnEnd?.seq ?? -1
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.top': 'ctrl+shift+home',
      'tui.altScreen.bottom': 'ctrl+shift+end',
      // Emacs-style navigation: Ctrl+N/P mirror Up/Down everywhere. In the
      // composer and question editors they move the cursor and traverse history;
      // in the slash autocomplete popup and every SelectList (pickers, question
      // menus, review, provider search, wizard) they move the highlight.
      'tui.editor.cursorUp': ['up', 'ctrl+p'],
      'tui.editor.cursorDown': ['down', 'ctrl+n'],
      'tui.select.up': ['up', 'ctrl+p'],
      'tui.select.down': ['down', 'ctrl+n'],
    }))
    this.tui = new TuiAltScreen(this.terminal, true, undefined, {
      mouse: true,
      wheelScrollLines: 3,
    })
    this.view = new TerminalView(this.tui, this.state, {
      choosePicker: (value) => { void this.controller.choosePicker(value) },
      closePicker: () => { this.controller.closePicker() },
      chooseQuestionOption: (label) => { this.submitQuestionChoice(label) },
      submitQuestionCustom: (text) => { void this.submitQuestionCustom(text) },
      cancelQuestionRequest: () => { void this.controller.cancelQuestion() },
      editQuestion: (index) => { this.editQuestion(index) },
      confirmQuestionAnswers: () => { void this.confirmQuestionAnswers() },
      chooseProviderWizardRow: (row) => { this.controller.wizardPick(row) },
      submitProviderWizardValue: (row, text) => { this.controller.wizardValue(row, text) },
      cancelProviderWizard: () => { this.controller.cancelProviderWizard() },
    })
    this.view.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(), config.cwd ?? process.cwd()))
    this.view.editor.onSubmit = text => { void this.submit(text, 'queue') }
    this.view.questionEditor.onSubmit = text => { void this.submitQuestion(text) }
    this.tui.setLayoutRoot(this.view.layout)
    this.tui.setFocus(this.view.focusTarget)
  }

  /** Enter alternate-screen mode, subscribe to controller state and start the session. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.syncTerminal(this.state)
    this.unsubscribe = this.controller.subscribe(() => { this.update(this.controller.getSnapshot()) })
    this.removeInputListener = this.tui.addInputListener(data => this.handleGlobalInput(data))
    this.tui.start()
    void this.controller.start(this.config)
  }

  /** Set an explicit terminal window/tab title using the renderer's OSC 0 implementation. */
  setTitle(title: string): void {
    if (this.stopped) return
    const normalized = sanitizeTerminalText(title)
    if (normalized === '') return
    this.terminalTitleOverride = normalized
    this.syncTerminalTitle(this.state)
  }

  /** Emit the established OSC 777/99 notification form when supported. */
  notify(message: string): void {
    if (this.stopped) return
    const sequence = terminalNotificationSequence(message, this.options.notificationEnvironment)
    if (sequence !== undefined) this.terminal.write(sequence)
  }

  /** Reach terminal quiescence and restore the main screen once. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.removeInputListener?.()
    this.removeInputListener = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.stopTitleSpinner()
    if (this.progressActive) {
      this.terminal.setProgress(false)
      this.progressActive = false
    }
    this.controller.dispose()
    if (this.started) this.tui.stop({ preserveScreen: true })
  }

  private applyTerminalTitle(title: string): void {
    if (title === this.appliedTerminalTitle) return
    this.terminal.setTitle(title)
    this.appliedTerminalTitle = title
  }

  private baseTerminalTitle(next: TuiViewState): string {
    const title = this.terminalTitleOverride
      ?? (next.title === undefined ? DEFAULT_TERMINAL_TITLE : sanitizeTerminalText(next.title))
    return title || DEFAULT_TERMINAL_TITLE
  }

  private syncTerminalTitle(next: TuiViewState): void {
    const base = this.baseTerminalTitle(next)
    const title = this.titleSpinnerTimer === undefined
      ? base
      : `${TITLE_SPINNER_FRAMES[this.titleSpinnerFrame]} ${base}`
    this.applyTerminalTitle(title)
  }

  private startTitleSpinner(): void {
    if (this.titleSpinnerTimer !== undefined) return
    this.titleSpinnerFrame = 0
    this.titleSpinnerTimer = setInterval(() => {
      if (this.stopped || !this.state.running) {
        this.stopTitleSpinner()
        return
      }
      this.titleSpinnerFrame = (this.titleSpinnerFrame + 1) % TITLE_SPINNER_FRAMES.length
      this.syncTerminalTitle(this.state)
    }, TITLE_SPINNER_INTERVAL_MS)
  }

  private stopTitleSpinner(): void {
    if (this.titleSpinnerTimer === undefined) return
    clearInterval(this.titleSpinnerTimer)
    this.titleSpinnerTimer = undefined
    this.titleSpinnerFrame = 0
    this.syncTerminalTitle(this.state)
  }

  private syncTerminal(next: TuiViewState): void {
    if (next.running) this.startTitleSpinner()
    else this.stopTitleSpinner()
    this.syncTerminalTitle(next)
    if (next.running !== this.progressActive) {
      this.terminal.setProgress(next.running)
      this.progressActive = next.running
    }
  }

  private notificationForTransition(previous: TuiViewState, next: TuiViewState): string | undefined {
    const sameSession = next.sessionId === previous.sessionId
    if (!sameSession) this.lastNotifiedTurnEndSeq = -1

    if (next.phase === 'error' && previous.phase !== 'error') {
      return next.notice === undefined ? '终端会话启动失败' : `终端会话失败：${next.notice}`
    }

    // Every loading→ready transition is a session-load baseline: hydrate the
    // notification cursor from the loaded projection so its historical
    // turn/end records stay silent. A newly pending interaction is different:
    // it still needs to wake a user who opened or switched into a session
    // while an approval/question was waiting.
    const readyBaseline = previous.phase !== 'ready' && next.phase === 'ready'
    if (readyBaseline) {
      this.lastNotifiedTurnEndSeq = next.lastTurnEnd?.seq ?? -1
      this.notificationsArmed = true
    }
    const turnEnd = next.lastTurnEnd
    const hasNewTurnEnd = sameSession && !readyBaseline && turnEnd !== undefined
      && turnEnd.seq > this.lastNotifiedTurnEndSeq
    if (hasNewTurnEnd) this.lastNotifiedTurnEndSeq = turnEnd.seq
    if (!this.notificationsArmed || !sameSession) return undefined

    if (next.interaction !== undefined && previous.interaction === undefined) {
      return next.interaction.kind === 'approval'
        ? `需要授权：${next.interaction.toolName}`
        : '需要回答问题'
    }
    if (hasNewTurnEnd) return turnCompletionMessage(turnEnd.kind)

    // Host status and durable turn/end arrive on separate streams. If the
    // latter already announced this turn, suppress the follow-up status edge.
    if (previous.running && !next.running) {
      if (turnEnd !== undefined && turnEnd.seq === this.lastNotifiedTurnEndSeq) return undefined
      return '执行结束'
    }
    return undefined
  }

  private update(next: TuiViewState): void {
    if (this.stopped) return
    const previous = this.state
    const notification = this.notificationForTransition(previous, next)
    const nextInteractionKey = interactionKey(next)
    if (nextInteractionKey !== this.currentInteractionKey) {
      this.currentInteractionKey = nextInteractionKey
      this.question.reset()
      this.view.questionEditor.setText('')
    }
    this.state = next
    this.view.update(next, this.question)
    this.syncTerminal(next)
    this.tui.setFocus(this.view.focusTarget)
    this.tui.requestRender()
    if (notification !== undefined) this.notify(notification)
  }

  /** Repaint after local flow changes that produced no new controller snapshot. */
  private refresh(): void {
    this.view.update(this.state, this.question)
    this.tui.requestRender()
  }

  private handleGlobalInput(data: string): { consume?: boolean } | undefined {
    if (isKeyRelease(data)) return undefined
    if (matchesKey(data, 'ctrl+c')) {
      this.stop()
      this.options.onExit?.(0)
      return { consume: true }
    }
    const interaction = this.state.interaction
    if (interaction?.kind === 'approval') {
      if (data.toLowerCase() === 'y') void this.controller.answerApproval('allowed-once')
      else if (data.toLowerCase() === 'n') void this.controller.answerApproval('rejected')
      return { consume: true }
    }
    if (this.state.picker !== undefined) return undefined
    if (interaction?.kind === 'question') {
      if (matchesKey(data, 'escape')) {
        // In the confirmation summary and in single-select menu questions the
        // focused component owns Escape (return to the menu, or cancel the whole
        // request). Option-less and multi-select questions keep the editor, so
        // Escape abandons the whole request right here.
        if (this.question.reviewing) return undefined
        const current = interaction.questions[this.question.index]
        if (current === undefined || current.multiSelect === true || (current.options?.length ?? 0) === 0) {
          void this.controller.cancelQuestion()
          return { consume: true }
        }
        return undefined
      }
      return undefined
    }
    if (this.state.providerWizard !== undefined) return undefined
    if (matchesKey(data, 'alt+enter')) {
      const text = this.view.editor.getExpandedText().trim()
      if (text !== '') {
        this.view.editor.setText('')
        void this.submitCaptured(text, 'steer')
      }
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+shift+e')) {
      this.controller.toggleFold()
      return { consume: true }
    }
    if (matchesKey(data, 'ctrl+t')) {
      this.view.toggleActivityBar()
      this.tui.requestRender()
      return { consume: true }
    }
    if (matchesKey(data, 'escape')) {
      if (this.view.editor.isShowingAutocomplete()) return undefined
      if (this.view.editor.getText() !== '') this.view.editor.setText('')
      else if (this.state.overlay !== undefined) this.controller.closeOverlay()
      else void this.controller.cancel()
      this.tui.requestRender()
      return { consume: true }
    }
    return undefined
  }

  private async submit(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const normalized = text.trim()
    if (normalized === '') return
    await this.submitCaptured(normalized, mode)
  }

  private async submitCaptured(text: string, mode: 'queue' | 'steer'): Promise<void> {
    const accepted = await this.controller.submit(text, mode)
    if (this.stopped) return
    if (accepted) {
      this.view.editor.addToHistory(text)
      this.view.transcript.scrollToEnd()
    } else if (this.view.editor.getText() === '') {
      this.view.editor.setText(text)
    }
    this.tui.requestRender()
  }

  /** The pending question interaction and its current item, unless a submission is in flight. */
  private currentQuestion(): { interaction: PendingQuestion; question: AskUserQuestionItem } | undefined {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question' || this.question.submitting) return undefined
    const question = interaction.questions[this.question.index]
    return question === undefined ? undefined : { interaction, question }
  }

  private async submitQuestion(text: string): Promise<void> {
    const current = this.currentQuestion()
    if (current === undefined) return
    await this.advanceQuestion(optionAnswer(current.question, text), true)
  }

  /** Submit one menu option as the current question's answer. */
  private async submitQuestionChoice(label: string): Promise<void> {
    const current = this.currentQuestion()
    if (current === undefined) return
    await this.advanceQuestion({ id: current.question.id, selected: [label] }, false)
  }

  /** Submit free-form text from the picker's custom-answer editor, verbatim. */
  private async submitQuestionCustom(text: string): Promise<void> {
    const current = this.currentQuestion()
    if (current === undefined) return
    const normalized = text.trim()
    await this.advanceQuestion(
      normalized === ''
        ? { id: current.question.id, selected: [] }
        : { id: current.question.id, selected: [], custom: normalized },
      false,
    )
  }

  /**
   * Accumulate an answer for the current question, advancing to the next one when
   * a batch has several, or answering the whole request on the final question.
   * `clearEditorAfter` controls whether the retained editor draft is cleared so
   * text-driven questions start each step fresh.
   */
  private async advanceQuestion(answerItem: AskUserQuestionAnswerItem, clearEditorAfter: boolean): Promise<void> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question') return
    if (interaction.questions[this.question.index] === undefined) return
    this.question.answers = [...this.question.answers, answerItem]
    if (this.question.index + 1 < interaction.questions.length) {
      this.question.index += 1
      if (clearEditorAfter) this.view.questionEditor.setText('')
      this.refresh()
      return
    }
    // A one-question batch has nothing to cross-check in a summary, so it is
    // sent to the host immediately instead of detouring through the review.
    if (interaction.questions.length === 1) {
      await this.submitSingleQuestion()
      return
    }
    // Every question is answered: move to the confirmation summary instead of
    // sending immediately, so the user can review "question → answer" and revise
    // any entry before it is committed to the host.
    this.question.reviewing = true
    this.question.submitting = false
    this.refresh()
  }

  /** Send the single answered question straight to the host, reopening it on rejection. */
  private async submitSingleQuestion(): Promise<void> {
    this.question.submitting = true
    this.refresh()
    const accepted = await this.controller.answerQuestion({ answers: this.question.answers })
    if (this.stopped) return
    if (accepted) {
      // Wait for the host `question/resolved` frame; update() clears the
      // pending state once the interaction is released.
      return
    }
    // The answer was rejected or the transport failed without resolving the
    // interaction. Reopen the question so the user can answer it again instead
    // of being stuck on a pending submission.
    this.question.reset()
    this.view.questionEditor.setText('')
    this.refresh()
  }

  /** Reopen one answered question so its answer can be changed. */
  private editQuestion(index: number): void {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question' || this.question.submitting) return
    if (index < 0 || index >= interaction.questions.length) return
    this.question.index = index
    this.question.answers = this.question.answers.slice(0, index)
    this.question.reviewing = false
    this.view.questionEditor.setText('')
    this.refresh()
  }

  /** Send the confirmed set of answers to the host. */
  private async confirmQuestionAnswers(): Promise<void> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question' || this.question.submitting) return
    this.question.reviewing = false
    this.question.submitting = true
    this.refresh()
    const accepted = await this.controller.answerQuestion({ answers: this.question.answers })
    if (this.stopped) return
    if (accepted) {
      // Wait for the host `question/resolved` frame; update() clears the
      // pending state once the interaction is released.
      return
    }
    // The answer was rejected or the transport failed without resolving the
    // interaction. Return to the confirmation summary so the user can retry or
    // revise an entry instead of being stuck on a pending submission.
    this.question.submitting = false
    this.question.reviewing = true
    this.refresh()
  }
}
