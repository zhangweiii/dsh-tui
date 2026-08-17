/** ANSI themes shared by the pi-tui components. */

import type {
  EditorTheme, MarkdownTheme, SelectListTheme,
} from '@earendil-works/pi-tui'
import { bg256, fg256, highlightCode } from './highlight.ts'

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

/**
 * pi coding agent dark theme (VS Code Dark+) palette as nearest 256-color
 * indices. Reuses these tokens across the UI so the terminal matches pi's
 * look: teal accent, soft-yellow headings, blue-gray links, dark gray-blue
 * user-message bubbles, and subdued borders instead of bright cyan.
 */
export const palette = {
  accent: fg256(109), // #8abeb7
  heading: fg256(222), // #f0c674
  link: fg256(109), // #81a2be (same 256 slot as the accent teal)
  border: fg256(69), // #5f87ff
  borderMuted: fg256(239), // #505050
  userBg: bg256(59), // #343541
  muted: fg256(244), // #808080
  text: fg256(188), // #d4d4d4
  secretLabel: fg256(104), // #9575cd
}

export const selectListTheme: SelectListTheme = {
  selectedPrefix: palette.accent,
  selectedText: text => palette.accent(text),
  description: ansi.dim,
  scrollInfo: ansi.dim,
  noMatch: ansi.yellow,
}

export const editorTheme: EditorTheme = {
  borderColor: palette.borderMuted,
  selectList: selectListTheme,
}

/**
 * Markdown theme following the pi coding agent's dark theme (VS Code Dark+):
 * soft-yellow headings, teal links and bullets, accent inline code, gray
 * fences, and per-token syntax highlighting for known languages.
 */
export const markdownTheme: MarkdownTheme = {
  heading: text => palette.heading(ansi.bold(text)),
  link: text => palette.link(ansi.underline(text)),
  linkUrl: palette.muted,
  code: palette.accent, // mdCode accent #8abeb7
  codeBlock: fg256(143), // mdCodeBlock #b5bd68
  codeBlockBorder: fg256(244), // mdCodeBlockBorder gray #808080
  quote: ansi.dim,
  quoteBorder: ansi.gray,
  hr: palette.muted,
  listBullet: palette.accent,
  bold: ansi.bold,
  italic: ansi.italic,
  strikethrough: ansi.strikethrough,
  underline: ansi.underline,
  highlightCode,
}