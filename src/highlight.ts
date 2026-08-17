/**
 * Syntax highlighting for fenced code blocks, mirroring the pi coding agent:
 * a fence renders as its ``` border plus per-token colors from highlight.js.
 * Unknown languages fall back to one code-block color instead of unreliable
 * auto-detection, exactly like pi.
 */

import hljs from 'highlight.js/lib/common'

function sgr(open: string, close: string): (text: string) => string {
  return text => `\u001B[${open}m${text}\u001B[${close}m`
}

/** 256-color foreground, e.g. `fg256(74)` for the VS Code keyword blue. */
export function fg256(index: number): (text: string) => string {
  return sgr(`38;5;${String(index)}`, '39')
}

/** 256-color background, e.g. `bg256(59)` for the pi user-message bubble. */
export function bg256(index: number): (text: string) => string {
  return sgr(`48;5;${String(index)}`, '49')
}

/** True-color foreground used when the terminal reports 24-bit support. */
export function fgTrue(r: number, g: number, b: number): (text: string) => string {
  return sgr(`38;2;${String(r)};${String(g)};${String(b)}`, '39')
}

/** True-color background used when the terminal reports 24-bit support. */
export function bgTrue(r: number, g: number, b: number): (text: string) => string {
  return sgr(`48;2;${String(r)};${String(g)};${String(b)}`, '49')
}

const dim = sgr('2', '22')
const bold = sgr('1', '22')
const italic = sgr('3', '23')
const underline = sgr('4', '24')
const green = sgr('32', '39')
const red = sgr('31', '39')

/** pi dark theme (VS Code Dark+): syntax colors as nearest 256-color indices. */
const SYNTAX = {
  keyword: 74, // #569CD6
  function: 187, // #DCDCAA
  variable: 153, // #9CDCFE
  string: 174, // #CE9178
  number: 151, // #B5CEA8
  type: 79, // #4EC9B0
  comment: 65, // #6A9955
  codeBlock: 143, // #b5bd68, mdCodeBlock in the pi dark theme
} as const

/** highlight.js scope -> terminal style, keyed exactly like the pi theme. */
const SCOPE_STYLES: Record<string, (text: string) => string> = {
  keyword: fg256(SYNTAX.keyword),
  name: fg256(SYNTAX.keyword),
  built_in: fg256(SYNTAX.type),
  class: fg256(SYNTAX.type),
  type: fg256(SYNTAX.type),
  literal: fg256(SYNTAX.number),
  number: fg256(SYNTAX.number),
  regexp: fg256(SYNTAX.string),
  string: fg256(SYNTAX.string),
  comment: fg256(SYNTAX.comment),
  doctag: fg256(SYNTAX.comment),
  meta: dim,
  function: fg256(SYNTAX.function),
  title: fg256(SYNTAX.function),
  tag: dim,
  attr: fg256(SYNTAX.variable),
  variable: fg256(SYNTAX.variable),
  params: fg256(SYNTAX.variable),
  operator: text => text,
  punctuation: text => text,
  emphasis: italic,
  strong: bold,
  link: underline,
  addition: green,
  deletion: red,
}

const SPAN_CLOSE = '</span>'
const CLASS_PREFIX = 'hljs-'

function scopeFromTag(tag: string): string | undefined {
  const match = /\sclass\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(tag)
  const classes = match?.[1] ?? match?.[2] ?? ''
  for (const className of classes.split(/\s+/)) {
    if (className.startsWith(CLASS_PREFIX)) return className.slice(CLASS_PREFIX.length)
  }
  return undefined
}

function styleFor(scope: string | undefined): ((text: string) => string) | undefined {
  if (scope === undefined) return undefined
  const exact = SCOPE_STYLES[scope]
  if (exact !== undefined) return exact
  // Fall back to the base scope for compound classes like "string.strong".
  const dot = scope.indexOf('.')
  if (dot > 0) return SCOPE_STYLES[scope.slice(0, dot)]
  const dash = scope.indexOf('-')
  if (dash > 0) return SCOPE_STYLES[scope.slice(0, dash)]
  return undefined
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
}

function entityAt(html: string, index: number): { text: string; length: number } | undefined {
  const semi = html.indexOf(';', index)
  if (semi < 0 || semi - index > 12) return undefined
  const body = html.slice(index + 1, semi)
  if (body.startsWith('#x')) {
    const code = Number.parseInt(body.slice(2), 16)
    return Number.isNaN(code) ? undefined : { text: String.fromCodePoint(code), length: semi - index + 1 }
  }
  if (body.startsWith('#')) {
    const code = Number.parseInt(body.slice(1), 10)
    return Number.isNaN(code) ? undefined : { text: String.fromCodePoint(code), length: semi - index + 1 }
  }
  const named = HTML_ENTITIES[body]
  return named === undefined ? undefined : { text: named, length: semi - index + 1 }
}

/** Convert highlight.js `<span class="hljs-*">` output into ANSI-styled text. */
function renderHighlighted(html: string): string {
  let output = ''
  let buffer = ''
  const scopes: string[] = []
  const flush = (): void => {
    if (buffer === '') return
    let styled = buffer
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      const formatter = styleFor(scopes[i])
      if (formatter !== undefined) {
        styled = formatter(styled)
        break
      }
    }
    output += styled
    buffer = ''
  }
  let index = 0
  while (index < html.length) {
    if (html.startsWith('<span', index) && index + 5 < html.length) {
      const next = html[index + '<span'.length] as string
      if (next === '>' || next === ' ' || next === '\t' || next === '\n' || next === '\r') {
        const tagEnd = html.indexOf('>', index + 5)
        if (tagEnd !== -1) {
          flush()
          const scope = scopeFromTag(html.slice(index, tagEnd + 1))
          if (scope !== undefined) scopes.push(scope)
          index = tagEnd + 1
          continue
        }
      }
    }
    if (html.startsWith(SPAN_CLOSE, index)) {
      flush()
      scopes.pop()
      index += SPAN_CLOSE.length
      continue
    }
    if (html[index] === '&') {
      const entity = entityAt(html, index)
      if (entity !== undefined) {
        buffer += entity.text
        index += entity.length
        continue
      }
    }
    buffer += html[index] as string
    index += 1
  }
  flush()
  return output
}

/**
 * Highlight one fenced code block into per-line ANSI output for `Markdown`'s
 * `highlightCode` hook. Unknown languages (or parse failures) color the whole
 * block in the code-block color instead of running auto-detection.
 * @param code - Source text of the fenced block.
 * @param lang - Optional fence language tag.
 * @returns One styled line per source line.
 */
export function highlightCode(code: string, lang: string | undefined): string[] {
  if (lang === undefined || hljs.getLanguage(lang) === undefined) {
    return code.split('\n').map(line => fg256(SYNTAX.codeBlock)(line))
  }
  try {
    const html = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    return renderHighlighted(html).split('\n')
  } catch {
    return code.split('\n').map(line => fg256(SYNTAX.codeBlock)(line))
  }
}