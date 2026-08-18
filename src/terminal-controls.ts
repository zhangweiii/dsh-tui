/** Established terminal control-sequence helpers used by the TUI lifecycle. */

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/gu
const ESC = '\u001B'
const BEL = '\u0007'
const ST = `${ESC}\\`

/** Conservative fallback title used before a session title is available. */
export const DEFAULT_TERMINAL_TITLE = 'dsh'

/** Environment hints used by terminals with a distinct notification protocol. */
export interface TerminalNotificationEnvironment {
  KITTY_WINDOW_ID?: string | undefined
  TERM_PROGRAM?: string | undefined
  ITERM_SESSION_ID?: string | undefined
  TMUX?: string | undefined
}

/**
 * Keep user/session text safe inside an OSC payload.
 *
 * OSC title and notification strings are terminated by a C0 character (BEL in
 * this package), so C0/C1 control characters must not be copied into a title or
 * notification body. Removing them also prevents a session title from
 * injecting another escape sequence into the terminal stream.
 */
export function sanitizeTerminalText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, ' ').trim()
}

function wrapForTmux(sequence: string, environment: TerminalNotificationEnvironment): string {
  if (environment.TMUX === undefined || environment.TMUX === '') return sequence
  // tmux passthrough is a DCS wrapper; every inner ESC must be doubled.
  const escaped = sequence.replaceAll(ESC, `${ESC}${ESC}`)
  return `${ESC}Ptmux;${escaped}${ST}`
}

function kittyNotificationParts(body: string): string[] {
  // This is the two-part form used by pi's notify extension: one title part and
  // one body part, both terminated with ST as required by Kitty's OSC 99
  // protocol. Keep the notification id stable because each notification is
  // complete after the body part.
  return [
    `${ESC}]99;i=1:d=0;${DEFAULT_TERMINAL_TITLE}${ST}`,
    `${ESC}]99;i=1:p=body;${body}${ST}`,
  ]
}

function isIterm2(environment: TerminalNotificationEnvironment): boolean {
  return environment.TERM_PROGRAM === 'iTerm.app'
    || (environment.ITERM_SESSION_ID !== undefined && environment.ITERM_SESSION_ID !== '')
}

/**
 * Build the established terminal desktop-notification sequence.
 *
 * This follows the same compatibility matrix as pi's notification extension:
 * Kitty uses OSC 99, iTerm2 uses OSC 9, and other terminals use OSC 777.
 * tmux passthrough is applied when TMUX is present. Only one protocol is
 * emitted so a terminal that recognizes multiple forms cannot duplicate the
 * notification. Unsupported terminals may still interpret BEL as a bell.
 */
export function terminalNotificationSequence(
  message: string,
  environment: TerminalNotificationEnvironment = process.env,
): string | undefined {
  const body = sanitizeTerminalText(message)
  if (body === '') return undefined

  const parts = environment.KITTY_WINDOW_ID !== undefined && environment.KITTY_WINDOW_ID !== ''
    ? kittyNotificationParts(body)
    : isIterm2(environment)
      ? [`${ESC}]9;${DEFAULT_TERMINAL_TITLE}: ${body}${BEL}`]
      : [`${ESC}]777;notify;${DEFAULT_TERMINAL_TITLE};${body}${BEL}`]
  return parts.map(part => wrapForTmux(part, environment)).join('')
}
