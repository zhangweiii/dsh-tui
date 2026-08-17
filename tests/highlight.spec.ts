import { describe, expect, it } from 'vitest'
import { highlightCode } from '../src/highlight.ts'

function strip(value: string): string {
  return value.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('highlightCode', () => {
  it('colors keywords, strings, numbers, and comments in TypeScript', () => {
    const lines = highlightCode('const answer: number = 42; // the answer\nconsole.log("hi")', 'ts')
    expect(lines.length).toBe(2)
    const keyword = lines[0] as string
    expect(keyword).toContain('\u001B[38;5;74m') // syntaxKeyword #569CD6
    expect(strip(keyword)).toContain('const')
    const stringLine = lines[1] as string
    expect(stringLine).toContain('\u001B[38;5;174m') // syntaxString #CE9178
    expect(strip(stringLine)).toContain('console.log("hi")')
  })

  it('keeps unknown languages in the code-block color without auto-detection', () => {
    const lines = highlightCode('def foo():\n    return 1', 'not-a-real-lang')
    for (const line of lines) {
      expect(line).toContain('\u001B[38;5;143m') // mdCodeBlock #b5bd68
    }
    expect(strip(lines[0] as string)).toBe('def foo():')
  })

  it('decodes HTML entities introduced by highlight.js', () => {
    const [line] = highlightCode('const a = 1 < 2', 'ts') as [string]
    expect(strip(line)).toContain('const a = 1 < 2')
    expect(strip(line)).not.toContain('&lt;')
  })
})