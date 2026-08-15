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
import type { TuiViewState } from './model.ts'
import { TerminalView } from './view.ts'

export interface TerminalApplicationOptions {
  terminal?: Terminal
  onExit?: (code: number) => void
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

/** One complete alternate-screen application for one controller. */
export class TerminalApplication {
  readonly tui: TuiAltScreen
  readonly view: TerminalView

  private state: TuiViewState
  private started = false
  private stopped = false
  private unsubscribe: (() => void) | undefined
  private removeInputListener: (() => void) | undefined
  private questionIndex = 0
  private questionAnswers: AskUserQuestionAnswerItem[] = []
  private questionSubmitting = false
  private currentInteractionKey = ''

  constructor(
    private readonly controller: TuiController,
    private readonly config: Config,
    private readonly options: TerminalApplicationOptions = {},
  ) {
    this.state = controller.getSnapshot()
    setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, {
      'tui.altScreen.top': 'ctrl+shift+home',
      'tui.altScreen.bottom': 'ctrl+shift+end',
    }))
    this.tui = new TuiAltScreen(options.terminal ?? new ProcessTerminal(), true, undefined, {
      mouse: true,
      wheelScrollLines: 3,
    })
    this.view = new TerminalView(this.tui, this.state, {
      choosePicker: (value) => { void this.controller.choosePicker(value) },
      closePicker: () => { this.controller.closePicker() },
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
    this.unsubscribe = this.controller.subscribe(() => { this.update(this.controller.getSnapshot()) })
    this.removeInputListener = this.tui.addInputListener(data => this.handleGlobalInput(data))
    this.tui.start()
    void this.controller.start(this.config)
  }

  /** Reach terminal quiescence and restore the main screen once. */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.removeInputListener?.()
    this.removeInputListener = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.controller.dispose()
    if (this.started) this.tui.stop({ preserveScreen: true })
  }

  private update(next: TuiViewState): void {
    if (this.stopped) return
    const nextInteractionKey = interactionKey(next)
    if (nextInteractionKey !== this.currentInteractionKey) {
      this.currentInteractionKey = nextInteractionKey
      this.questionIndex = 0
      this.questionAnswers = []
      this.questionSubmitting = false
      this.view.questionEditor.setText('')
    }
    this.state = next
    this.view.update(next, this.questionIndex, this.questionSubmitting)
    this.tui.setFocus(this.view.focusTarget)
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
        void this.controller.cancelQuestion()
        return { consume: true }
      }
      return undefined
    }
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

  private async submitQuestion(text: string): Promise<void> {
    const interaction = this.state.interaction
    if (interaction?.kind !== 'question' || this.questionSubmitting) return
    const question = interaction.questions[this.questionIndex]
    if (question === undefined) return
    const answers = [...this.questionAnswers, optionAnswer(question, text)]
    if (this.questionIndex + 1 < interaction.questions.length) {
      this.questionAnswers = answers
      this.questionIndex += 1
      this.view.questionEditor.setText('')
      this.view.update(this.state, this.questionIndex, false)
      this.tui.requestRender()
      return
    }
    this.questionSubmitting = true
    this.view.update(this.state, this.questionIndex, true)
    this.tui.requestRender()
    const accepted = await this.controller.answerQuestion({ answers })
    if (this.stopped) return
    if (accepted) {
      // Wait for the host `question/resolved` frame; update() clears the
      // pending state once the interaction is released.
      return
    }
    // The answer was rejected or the transport failed without resolving the
    // interaction. Re-enable the editor and clear its text so the user can
    // retry in place instead of being stuck on a pending submission (see
    // controller.answerQuestion).
    this.questionSubmitting = false
    this.view.questionEditor.setText('')
    this.view.update(this.state, this.questionIndex, false)
    this.tui.requestRender()
  }
}
