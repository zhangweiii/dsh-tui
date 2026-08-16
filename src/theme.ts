/** ANSI themes shared by the pi-tui components. */

import type {
  EditorTheme, MarkdownTheme, SelectListTheme,
} from '@earendil-works/pi-tui'

function sgr(open: number, close: number): (text: string) => string {
  return text => `\u001B[${String(open)}m${text}\u001B[${String(close)}m`
}

export const ansi = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  italic: sgr(3, 23),
  underline: sgr(4, 24),
  inverse: sgr(7, 27),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  gray: sgr(90, 39),
  strikethrough: sgr(9, 29),
} as const

export const selectListTheme: SelectListTheme = {
  selectedPrefix: ansi.cyan,
  selectedText: text => ansi.cyan(ansi.bold(text)),
  description: ansi.dim,
  scrollInfo: ansi.dim,
  noMatch: ansi.yellow,
}

export const editorTheme: EditorTheme = {
  borderColor: ansi.cyan,
  selectList: selectListTheme,
}

export const markdownTheme: MarkdownTheme = {
  heading: text => ansi.cyan(ansi.bold(text)),
  link: text => ansi.cyan(ansi.underline(text)),
  linkUrl: ansi.dim,
  code: ansi.yellow,
  codeBlock: ansi.green,
  codeBlockBorder: ansi.gray,
  quote: ansi.dim,
  quoteBorder: ansi.gray,
  hr: ansi.gray,
  listBullet: ansi.cyan,
  bold: ansi.bold,
  italic: ansi.italic,
  strikethrough: ansi.strikethrough,
  underline: ansi.underline,
}
