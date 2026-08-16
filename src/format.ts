/** Shared leaf formatting helpers for terminal text, numbers, and JSON. */

/** Collapse a multi-line value into a single trimmed line. */
export function oneLine(value: string): string {
  return value.replaceAll(/\s*\n\s*/gu, ' ').trim()
}

/** Keep the tail of a long value, marking the elision with an ellipsis. */
export function shorten(value: string | undefined, maximum: number): string {
  if (value === undefined || value === '') return '—'
  return value.length <= maximum ? value : `…${value.slice(-(maximum - 1))}`
}

/**
 * Grouped count for roomy panels (`12,345`). Prefer `formatCompact` in
 * width-constrained chrome such as the footer status line.
 */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('zh-CN').format(value)
}

/** Compact count for width-constrained chrome (`12.3k`, `1.2m`). */
export function formatCompact(value: number): string {
  return value >= 1_000_000
    ? `${(value / 1_000_000).toFixed(1)}m`
    : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value)
}

/** Binary byte size with one decimal, in KiB or MiB. */
export function formatBytes(value: number): string {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MiB`
    : `${(value / 1024).toFixed(1)} KiB`
}

/** Single-line JSON for inline display; falls back to `String` on cycles. */
export function compactJson(input: unknown): string {
  try {
    return JSON.stringify(input)
  } catch {
    return String(input)
  }
}

/** Two-space JSON split into lines; falls back to `String` on cycles. */
export function prettyJson(input: unknown): string[] {
  try {
    return JSON.stringify(input, undefined, 2).split('\n')
  } catch {
    return [String(input)]
  }
}

/** Display JSON, passing string values through verbatim instead of quoting them. */
export function displayJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, undefined, 2)
  } catch {
    return String(value)
  }
}
