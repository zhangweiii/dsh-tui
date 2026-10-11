/**
 * Tool render-intent computation: the local replacement for the Host-computed
 * `ToolEventView` DSH 0.1.x shipped alongside every `tool/call` and
 * `tool/result` session event. DSH 0.2.x dropped the view from the wire, so
 * this module recomputes the same card from the raw tool name, the raw
 * arguments JSON, the completed result message, and the tool-private `meta`
 * payload.
 *
 * Every presenter mirrors the shipped tool's `presentCall`/`presentResult`
 * (`@deepseek-ai/dsh-tool-*`, `dsh-plan-mode`, `dsh-schedule`, `dsh-tools`),
 * including its default card, its absent-view behavior, and the defensive
 * narrowing of opaque `meta`. Nothing here may throw: `argumentsJson` is
 * partial during streaming, `meta` may come from an older or hand-edited log,
 * and an unrecognized tool name falls back to the caller's own generic card.
 *
 * @module @zhangweiii/dsh-tui/presentation
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallView, ToolEventView, ToolResultView } from './contract/index.ts'

/** A plain JSON object parsed from raw tool arguments or a `meta` payload. */
type JsonRecord = Record<string, unknown>

/** The completed outcome a result presenter narrows (the `ToolResult` shape). */
interface ToolResultInput {
  content: readonly ContentBlock[]
  isError: boolean
  meta?: unknown
}

/** The call-kind vocabulary, derived from the contract's generic call view. */
type CallKind = NonNullable<Extract<ToolCallView, { card: 'generic' }>['kind']>

/** The contract's search result card, for narrowing helpers. */
type SearchResultCard = Extract<ToolResultView, { card: 'search' }>

/** One validated line of a structured read window (`meta.lines`). */
interface ReadLine { number: number; text: string }

/** One validated contextual hunk of a result-time diff (`meta.diffs`). */
interface FileHunk { path: string; oldText: string | null; newText: string }

/** One validated matched line inside a grep match group. */
interface SearchLine { lineNumber: number; line: string }

/** One validated grep match group (`meta.files[]`). */
interface SearchGroup { path: string; matches: SearchLine[] }

/** One validated web source (`meta.sources[]`). */
interface WebSourceEntry { url: string; title?: string; snippet?: string; publishedAt?: string }

/** The validated structured read window `dsh-tool-fs` projects through `meta`. */
interface ReadWindowMeta { path: string; offset: number; lines: ReadLine[]; totalLines: number; lang?: string }

/** The validated web-search result meta `dsh-tool-web` projects. */
interface WebSearchMeta { sources: WebSourceEntry[]; truncated: boolean; answer?: string }

/** The validated web-fetch result meta `dsh-tool-web` projects. */
interface WebFetchMeta { url: string; statusCode: number; truncated: boolean }

/** Narrow an arbitrary JSON value to a plain object. */
function asRecord(value: unknown): JsonRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonRecord : undefined
}

/** A string field, or `undefined` for an absent or mistyped value. */
function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** A finite number field, or `undefined` for an absent or mistyped value. */
function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** An all-string JSON array, or `undefined` when any item is not a string. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') return undefined
    items.push(item)
  }
  return items
}

/** Parse raw tool arguments; partial JSON during streaming fails to `undefined`. */
function parseArguments(argumentsJson: string): JsonRecord | undefined {
  try {
    return asRecord(JSON.parse(argumentsJson))
  } catch {
    return undefined
  }
}

/** The single text block body of a tool result, or `undefined` for any other content shape. */
function singleTextBlock(content: readonly ContentBlock[]): string | undefined {
  if (content.length !== 1) return undefined
  const block = content[0]
  return block !== undefined && block.type === 'text' ? block.text : undefined
}

/** Build a generic call view, omitting absent optional fields (the tools' shared `present` helper). */
function genericView(title: string, kind?: CallKind, rawInput?: unknown): ToolCallView {
  return {
    card: 'generic',
    title,
    ...(kind === undefined ? {} : { kind }),
    ...(rawInput === undefined ? {} : { rawInput }),
  }
}

/**
 * Split a rendered shell result into its output body and exit status — the
 * inverse of the `[exit code: N]` / `[killed by signal: X]` markers the shell
 * tools append (mirrors `@deepseek-ai/dsh-shell`'s `parseExitStatus`).
 */
function parseExitStatus(raw: string): { body: string; exitCode: number } | { body: string; signal: string } {
  const killed = /\n\[killed by signal: ([^\]\n]+)\]$/.exec(raw)
  const killedSignal = killed?.[1]
  if (killed !== null && killedSignal !== undefined) return { body: raw.slice(0, killed.index), signal: killedSignal }
  const exit = /\n\[exit code: (\d+)\]$/.exec(raw)
  const exitCode = exit?.[1]
  if (exit !== null && exitCode !== undefined) return { body: raw.slice(0, exit.index), exitCode: Number(exitCode) }
  return { body: raw, exitCode: 0 }
}

/** The promoted-result marker rendered when a foreground shell wait expires (the command moved to a background job). */
const PROMOTED_MARKER = /\[still running after \d+ms; moved to background job [^\]\n]+\]/

/**
 * Whether a completed shell result is the promoted (wait-expired) form. The
 * tool presenter reads the canonical value's `kind`, which the wire projection
 * does not carry; the rendered marker that same branch produces is the local
 * signal for it.
 */
function isPromotedShellResult(meta: unknown, raw: string): boolean {
  return asRecord(meta)?.kind === 'promoted' || PROMOTED_MARKER.test(raw)
}

/** Wrap raw shell text in a fenced console block, trimming trailing newlines (the shell tools' error/background fallback). */
function fencedConsole(raw: string): string {
  return '```console\n' + raw.replace(/\n+$/, '') + '\n```'
}

/** The plan's first markdown heading (any level), or `undefined` when it has none (`dsh-plan-mode`). */
function firstHeading(plan: string): string | undefined {
  for (const line of plan.split('\n')) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (match?.[1] !== undefined) return match[1]
  }
  return undefined
}

/** Whether `value` is a valid line of a read window (1-based integer line number, string text). */
function isReadLine(value: unknown): value is ReadLine {
  const record = asRecord(value)
  if (record === undefined) return false
  const { number, text } = record
  return typeof number === 'number' && Number.isInteger(number) && number >= 1 && typeof text === 'string'
}

/**
 * Narrow opaque `meta` to the structured read window `dsh-tool-fs` projects,
 * enforcing its numbering contract (a 1-based offset, strictly increasing line
 * numbers no greater than `totalLines`) so malformed replayed data declines to
 * the generic card instead of rendering misnumbered lines.
 */
function readWindowFromMeta(meta: unknown): ReadWindowMeta | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const { path, offset, lines, totalLines, lang } = record
  if (typeof path !== 'string' || typeof totalLines !== 'number' || typeof offset !== 'number') return undefined
  if (!Number.isInteger(offset) || offset < 1) return undefined
  if (!Number.isInteger(totalLines) || totalLines < 0) return undefined
  if (!Array.isArray(lines)) return undefined
  const windowLines: ReadLine[] = []
  for (const line of lines) {
    if (!isReadLine(line)) return undefined
    windowLines.push(line)
  }
  if (lang !== undefined && typeof lang !== 'string') return undefined
  let previous = offset - 1
  for (const { number } of windowLines) {
    if (number <= previous || number > totalLines) return undefined
    previous = number
  }
  return { path, offset, lines: windowLines, totalLines, ...(lang === undefined ? {} : { lang }) }
}

/** Whether `value` is a valid contextual hunk of a result-time diff. */
function isFileHunk(value: unknown): value is FileHunk {
  const record = asRecord(value)
  if (record === undefined) return false
  const { path, oldText, newText } = record
  return typeof path === 'string' && (oldText === null || typeof oldText === 'string') && typeof newText === 'string'
}

/** Narrow opaque `meta` to non-empty file diffs; malformed or empty data declines to the caller's fallback. */
function diffsFromMeta(meta: unknown): FileHunk[] | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const diffs = record.diffs
  if (!Array.isArray(diffs) || diffs.length === 0) return undefined
  const hunks: FileHunk[] = []
  for (const diff of diffs) {
    if (!isFileHunk(diff)) return undefined
    hunks.push(diff)
  }
  return hunks
}

/** Whether `value` is a valid matched line inside a grep match group. */
function isSearchLine(value: unknown): value is SearchLine {
  const record = asRecord(value)
  if (record === undefined) return false
  const { lineNumber, line } = record
  return typeof lineNumber === 'number' && typeof line === 'string'
}

/** Whether `value` is a valid grep match group. */
function isSearchGroup(value: unknown): value is SearchGroup {
  const record = asRecord(value)
  if (record === undefined) return false
  const { path, matches } = record
  if (typeof path !== 'string' || !Array.isArray(matches)) return false
  return matches.every(isSearchLine)
}

/**
 * Narrow opaque `meta` to the search card `dsh-tool-fs-search` projects. An
 * empty `files`/`paths` list is a valid zero-result card (unlike empty diffs).
 */
function searchViewFromMeta(meta: unknown): SearchResultCard | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const { truncated, total } = record
  if (typeof truncated !== 'boolean' || typeof total !== 'number') return undefined
  if (record.shape === 'matches') {
    const groups = record.files
    if (!Array.isArray(groups)) return undefined
    const files: SearchGroup[] = []
    for (const group of groups) {
      if (!isSearchGroup(group)) return undefined
      files.push(group)
    }
    return { card: 'search', shape: 'matches', files, truncated, total }
  }
  if (record.shape === 'paths') {
    const paths = stringArray(record.paths)
    if (paths === undefined) return undefined
    return { card: 'search', shape: 'paths', paths, truncated, total }
  }
  return undefined
}

/** Whether `value` is a valid web source. */
function isWebSource(value: unknown): value is WebSourceEntry {
  const record = asRecord(value)
  if (record === undefined) return false
  const { url, title, snippet, publishedAt } = record
  return typeof url === 'string'
    && (title === undefined || typeof title === 'string')
    && (snippet === undefined || typeof snippet === 'string')
    && (publishedAt === undefined || typeof publishedAt === 'string')
}

/** Narrow opaque `meta` to the web-search sources `dsh-tool-web` projects. */
function webSearchMetaFromResult(meta: unknown): WebSearchMeta | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const { sources, truncated, answer } = record
  if (!Array.isArray(sources)) return undefined
  const entries: WebSourceEntry[] = []
  for (const source of sources) {
    if (!isWebSource(source)) return undefined
    entries.push(source)
  }
  if (typeof truncated !== 'boolean') return undefined
  if (answer !== undefined && typeof answer !== 'string') return undefined
  return { sources: entries, truncated, ...(answer === undefined ? {} : { answer }) }
}

/** Narrow opaque `meta` to the web-fetch summary `dsh-tool-web` projects. */
function webFetchMetaFromResult(meta: unknown): WebFetchMeta | undefined {
  const record = asRecord(meta)
  if (record === undefined) return undefined
  const { url, statusCode, truncated } = record
  if (typeof url !== 'string' || typeof statusCode !== 'number' || typeof truncated !== 'boolean') return undefined
  return { url, statusCode, truncated }
}

/** `bash`/`pwsh`: a terminal card, or the background generic card (`dsh-tool-bash`/`dsh-tool-pwsh`). */
function shellCall(args: JsonRecord): ToolCallView | undefined {
  const command = stringValue(args.command)
  if (command === undefined) return undefined
  const description = stringValue(args.description)
  if (args.run_in_background === true) {
    return {
      card: 'generic',
      title: command,
      kind: 'execute',
      rawInput: command,
      ...(description === undefined ? {} : { content: [{ type: 'text', text: description }] }),
    }
  }
  const workdir = stringValue(args.workdir)
  return {
    card: 'terminal',
    title: command,
    ...(description === undefined ? {} : { description }),
    ...(workdir === undefined ? {} : { cwd: workdir }),
  }
}

/** `bash_persistent`/`pwsh_persistent`: the command alone — the persistent shell tools declare only this call view. */
function persistentShellCall(args: JsonRecord): ToolCallView | undefined {
  const command = stringValue(args.command)
  if (command === undefined) return undefined
  return { card: 'terminal', title: command }
}

/** `read`: a generic read card naming the requested line window, with a follow-along location. */
function readCall(args: JsonRecord): ToolCallView | undefined {
  const filePath = stringValue(args.file_path)
  if (filePath === undefined) return undefined
  const offset = numberValue(args.offset)
  const limit = numberValue(args.limit)
  const from = offset ?? 1
  const window = limit !== undefined && limit > 0
    ? ` (${from} - ${from + limit - 1})`
    : offset !== undefined ? ` (from line ${offset})` : ''
  return {
    card: 'generic',
    title: `Read ${filePath}${window}`,
    kind: 'read',
    locations: [{ path: filePath, line: from }],
  }
}

/** `read_image`: a generic read card; `dsh-tool-fs` declares no result view for it. */
function readImageCall(args: JsonRecord): ToolCallView | undefined {
  const filePath = stringValue(args.file_path)
  if (filePath === undefined) return undefined
  return { card: 'generic', title: `Read image ${filePath}`, kind: 'read', locations: [{ path: filePath }] }
}

/** `write`: a whole-file diff card with a null old side (a call cannot see the file's prior content). */
function writeCall(args: JsonRecord): ToolCallView | undefined {
  const filePath = stringValue(args.file_path)
  const content = stringValue(args.content)
  if (filePath === undefined || content === undefined) return undefined
  return {
    card: 'diff',
    title: `Write ${filePath}`,
    diffs: [{ path: filePath, oldText: null, newText: content }],
    locations: [{ path: filePath }],
  }
}

/** `edit`: a literal-replacement diff card derived from the call arguments. */
function editCall(args: JsonRecord): ToolCallView | undefined {
  const filePath = stringValue(args.file_path)
  if (filePath === undefined) return undefined
  const oldString = stringValue(args.old_string)
  const newString = stringValue(args.new_string) ?? ''
  return {
    card: 'diff',
    title: `Edit ${filePath}`,
    diffs: [{ path: filePath, oldText: oldString === undefined || oldString === '' ? null : oldString, newText: newString }],
    locations: [{ path: filePath }],
  }
}

/** `str_replace_editor`: a command-shaped card (`view`/`insert` generic, `create`/`str_replace` diff). */
function editorCall(args: JsonRecord): ToolCallView | undefined {
  const command = stringValue(args.command)
  const path = stringValue(args.path)
  if (path === undefined) return undefined
  switch (command) {
    case 'view':
      return { card: 'generic', title: `view ${path}`, kind: 'read', locations: [{ path }] }
    case 'create':
      return {
        card: 'diff',
        title: `create ${path}`,
        diffs: [{ path, oldText: null, newText: stringValue(args.file_text) ?? '' }],
        locations: [{ path }],
      }
    case 'str_replace':
      return {
        card: 'diff',
        title: `str_replace ${path}`,
        diffs: [{ path, oldText: stringValue(args.old_str) ?? null, newText: stringValue(args.new_str) ?? '' }],
        locations: [{ path }],
      }
    case 'insert': {
      const insertLine = numberValue(args.insert_line)
      return {
        card: 'generic',
        title: `insert ${path}`,
        kind: 'edit',
        locations: [{ path, ...(insertLine === undefined ? {} : { line: Math.max(1, insertLine + 1) }) }],
      }
    }
    default:
      return undefined
  }
}

/** `glob`: a search-kind generic card titled by the pattern and optional root. */
function globCall(args: JsonRecord): ToolCallView | undefined {
  const pattern = stringValue(args.pattern)
  if (pattern === undefined) return undefined
  const path = stringValue(args.path)
  return genericView(`Glob ${pattern}${path === undefined ? '' : ` in ${path}`}`, 'search', pattern)
}

/** `grep`: a search-kind generic card titled by the pattern, root, and include filter. */
function grepCall(args: JsonRecord): ToolCallView | undefined {
  const pattern = stringValue(args.pattern)
  if (pattern === undefined) return undefined
  const path = stringValue(args.path)
  const include = stringValue(args.include)
  const where = path === undefined ? '' : ` in ${path}`
  const filter = include === undefined ? '' : ` (${include})`
  return genericView(`Grep ${pattern}${where}${filter}`, 'search', pattern)
}

/** `web_search`: a search-kind generic card titled by the query list. */
function webSearchCall(args: JsonRecord): ToolCallView | undefined {
  const queries = stringArray(args.queries)
  if (queries === undefined) return undefined
  const title = queries.join(', ')
  return genericView(title, 'search', title)
}

/** `web_fetch`: a fetch-kind generic card titled by the URL. */
function webFetchCall(args: JsonRecord): ToolCallView | undefined {
  const url = stringValue(args.url)
  if (url === undefined) return undefined
  return genericView(url, 'fetch', url)
}

/** `todo_write`: a generic card whose raw input is the full todo list. */
function todoCall(args: JsonRecord): ToolCallView | undefined {
  if (!Array.isArray(args.todos)) return undefined
  return { card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args.todos }
}

/** `job_output`: a read-kind generic card naming the job. */
function jobOutputCall(args: JsonRecord): ToolCallView | undefined {
  const id = stringValue(args.job_id)
  if (id === undefined) return undefined
  return genericView(`Read output from background job ${id}`, 'read', id)
}

/** `job_kill`: an execute-kind generic card naming the job. */
function jobKillCall(args: JsonRecord): ToolCallView | undefined {
  const id = stringValue(args.job_id)
  if (id === undefined) return undefined
  return genericView(`Kill background job ${id}`, 'execute', id)
}

/** `skill`: a read-kind generic card naming the skill. */
function skillCall(args: JsonRecord): ToolCallView | undefined {
  const name = stringValue(args.name)
  if (name === undefined) return undefined
  return genericView(`Load skill ${name}`, 'read', name)
}

/** `create_goal`: a generic card whose raw input is the objective. */
function createGoalCall(args: JsonRecord): ToolCallView | undefined {
  return genericView('Create goal', 'other', stringValue(args.objective))
}

/** Whether optional goal text is meaningful rather than an empty filler (dsh-tool-goal `hasText`). */
function hasGoalText(value: unknown): value is string {
  return typeof value === 'string' && value !== ''
}

/** Whether an optional goal round cap is meaningful rather than a zero filler (dsh-tool-goal `hasRoundCap`). */
function hasRoundCap(value: unknown): value is number {
  return typeof value === 'number' && value !== 0
}

/** `update_goal`: a generic card titled by the action, with the most salient update field as raw input. */
function updateGoalCall(args: JsonRecord): ToolCallView | undefined {
  const action = stringValue(args.action)
  if (action === undefined) return undefined
  const label = action === 'blocked' ? 'Mark' : action.charAt(0).toUpperCase() + action.slice(1)
  const rawInput = hasGoalText(args.blocked_reason) ? args.blocked_reason
    : hasGoalText(args.objective) ? args.objective
      : hasRoundCap(args.max_goal_rounds) ? args.max_goal_rounds
        : stringValue(args.goal_id)
  return genericView(`${label} goal`, 'other', rawInput)
}

/** `ralph`: a generic card whose raw input is the immutable objective. */
function ralphCall(args: JsonRecord): ToolCallView | undefined {
  return genericView('ralph', undefined, stringValue(args.objective))
}

/** `workflow`: a generic card titled by the workflow's meta name, with the script as raw input. */
function workflowCall(args: JsonRecord): ToolCallView | undefined {
  const name = stringValue(asRecord(args.meta)?.name)
  if (name === undefined) return undefined
  return genericView(`workflow: ${name}`, undefined, stringValue(args.script))
}

/** `cordis_inspect_query`: a read-kind generic card naming the platform, provider, and method. */
function cordisQueryCall(args: JsonRecord): ToolCallView | undefined {
  const platform = stringValue(args.platform)
  const provider = stringValue(args.provider)
  const method = stringValue(args.method)
  if (platform === undefined || provider === undefined || method === undefined) return undefined
  return genericView(`Query Cordis ${platform} ${provider}.${method}`, 'read')
}

/** `exit_plan_mode`: a generic card titled by the plan's first heading, carrying the full plan. */
function planReviewCall(args: JsonRecord): ToolCallView | undefined {
  const plan = stringValue(args.plan)
  if (plan === undefined) return undefined
  return {
    card: 'generic',
    title: firstHeading(plan) ?? 'Plan',
    kind: 'other',
    content: [{ type: 'text', text: plan }],
  }
}

/** `schedule_create`: a generic card whose raw input is the reminder prompt. */
function scheduleCreateCall(args: JsonRecord): ToolCallView | undefined {
  return genericView('Create reminder', 'other', stringValue(args.prompt))
}

/** `schedule_delete`: a generic card whose raw input is the schedule id. */
function scheduleDeleteCall(args: JsonRecord): ToolCallView | undefined {
  return genericView('Delete reminder', 'other', stringValue(args.id))
}

/** `schedule_update`: a generic card whose raw input is the schedule id. */
function scheduleUpdateCall(args: JsonRecord): ToolCallView | undefined {
  return genericView('Update reminder', 'other', stringValue(args.id))
}

/** `run_code`: an execute-kind generic card titled by the code's description, with the code as raw input. */
function runCodeCall(args: JsonRecord): ToolCallView | undefined {
  const description = stringValue(args.description)
  if (description === undefined) return undefined
  return genericView(description, 'execute', stringValue(args.code))
}

/** `bash`/`pwsh`: a terminal card with the parsed exit pill, or the fenced-console generic fallback. */
function shellResult(args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  const raw = singleTextBlock(result.content)
  if (raw === undefined) return undefined
  if (args.run_in_background === true || isPromotedShellResult(result.meta, raw) || result.isError) {
    return { card: 'generic', content: [{ type: 'text', text: fencedConsole(raw) }] }
  }
  const status = parseExitStatus(raw)
  if ('signal' in status) return { card: 'terminal', output: status.body, signal: status.signal }
  return { card: 'terminal', output: status.body, exitCode: status.exitCode }
}

/** The `<content>` envelope `dsh-tool-fs` wraps a read result in. */
const READ_ENVELOPE = /^<path>[^\n]*<\/path>\n<type>file<\/type>\n<content>\n([\s\S]*)\n<\/content>$/u

/** `read`: a line-numbered read card narrowed from `meta`, with the envelope-stripped body as content. */
function readResult(_args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const meta = readWindowFromMeta(result.meta)
  if (meta === undefined) return undefined
  const raw = singleTextBlock(result.content)
  if (raw === undefined) return undefined
  const body = READ_ENVELOPE.exec(raw)?.[1]
  if (body === undefined) return undefined
  return {
    card: 'read',
    path: meta.path,
    offset: meta.offset,
    lines: meta.lines,
    totalLines: meta.totalLines,
    ...(meta.lang === undefined ? {} : { lang: meta.lang }),
    content: [{ type: 'text', text: body }],
  }
}

/** `write`: a diff card from `meta.diffs`, falling back to the argument-derived whole-file diff. */
function writeResult(args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const filePath = stringValue(args.file_path)
  if (filePath === undefined) return undefined
  const content = stringValue(args.content)
  const fallback = content === undefined ? undefined : [{ path: filePath, oldText: null, newText: content }]
  const diffs = diffsFromMeta(result.meta) ?? fallback
  if (diffs === undefined) return undefined
  return { card: 'diff', title: `Write ${filePath}`, diffs }
}

/** `edit`: a diff card narrowed from `meta.diffs`; absent or malformed diffs keep the raw text card. */
function editResult(args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const diffs = diffsFromMeta(result.meta)
  if (diffs === undefined) return undefined
  const filePath = stringValue(args.file_path)
  return { card: 'diff', ...(filePath === undefined ? {} : { title: `Edit ${filePath}` }), diffs }
}

/** `glob`: a search card whose shape is the projected path list. */
function globResult(_args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  return view !== undefined && view.shape === 'paths' ? view : undefined
}

/** `grep`: a search card whose shape is the projected match groups. */
function grepResult(_args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const view = searchViewFromMeta(result.meta)
  return view !== undefined && view.shape === 'matches' ? view : undefined
}

/** `web_search`: a web card carrying the faithful sources and optional provider answer. */
function webSearchResult(args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const meta = webSearchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  const queries = stringArray(args.queries)
  return {
    card: 'web',
    kind: 'search',
    ...(queries === undefined ? {} : { title: queries.join(', ') }),
    sources: meta.sources,
    truncated: meta.truncated,
    ...(meta.answer === undefined ? {} : { answer: meta.answer }),
  }
}

/** `web_fetch`: a web card carrying the final URL, status, and effective truncation. */
function webFetchResult(args: JsonRecord, result: ToolResultInput): ToolResultView | undefined {
  if (result.isError) return undefined
  const meta = webFetchMetaFromResult(result.meta)
  if (meta === undefined) return undefined
  const url = stringValue(args.url)
  return {
    card: 'web',
    kind: 'fetch',
    ...(url === undefined ? {} : { title: url }),
    url: meta.url,
    statusCode: meta.statusCode,
    truncated: meta.truncated,
  }
}

/** `ralph`/`workflow`: the completed card keeps the pending title and renders the raw result content. */
function keepPendingTitleResult(): ToolResultView {
  return { card: 'generic' }
}

/** `exit_plan_mode`: the completed card always shows the review title and the result content. */
function planReviewResult(_args: JsonRecord, result: ToolResultInput): ToolResultView {
  return { card: 'generic', title: 'Plan review', content: [...result.content] }
}

/** Presenter for one pending call: raw arguments in, a call view or the caller's fallback out. */
type CallPresenter = (args: JsonRecord) => ToolCallView | undefined

/** Presenter for one completed call: raw arguments and the result in, a result view or the caller's fallback out. */
type ResultPresenter = (args: JsonRecord, result: ToolResultInput) => ToolResultView | undefined

/**
 * Pending-call presenters by shipped tool name. A missing entry means the tool
 * declares no `presentCall` (or is unknown), so the caller keeps its generic
 * name-titled card. The `*_persistent` names are legacy aliases: the shipped
 * persistent shell packages register under `bash`/`pwsh` and declare only the
 * command-titled terminal card.
 */
const CALL_PRESENTERS: Readonly<Record<string, CallPresenter | undefined>> = {
  bash: shellCall,
  bash_persistent: persistentShellCall,
  pwsh: shellCall,
  pwsh_persistent: persistentShellCall,
  read: readCall,
  read_image: readImageCall,
  write: writeCall,
  edit: editCall,
  str_replace_editor: editorCall,
  glob: globCall,
  grep: grepCall,
  web_search: webSearchCall,
  web_fetch: webFetchCall,
  todo_write: todoCall,
  job_output: jobOutputCall,
  job_list: () => genericView('List background jobs', 'read'),
  job_kill: jobKillCall,
  skill: skillCall,
  get_goal: () => genericView('Read current goal', 'read'),
  create_goal: createGoalCall,
  update_goal: updateGoalCall,
  ralph: ralphCall,
  workflow: workflowCall,
  cordis_inspect_list: () => genericView('List Cordis Inspect Providers', 'read'),
  cordis_inspect_query: cordisQueryCall,
  exit_plan_mode: planReviewCall,
  schedule_create: scheduleCreateCall,
  schedule_list: () => genericView('List reminders', 'read'),
  schedule_delete: scheduleDeleteCall,
  schedule_update: scheduleUpdateCall,
  load_workspace_dependencies: () => genericView('Load workspace dependencies', 'read'),
  run_code: runCodeCall,
}

/**
 * Completed-call presenters by shipped tool name. A missing entry (including
 * every tool that omits `presentResult`) keeps the pending title and renders
 * the raw result content.
 */
const RESULT_PRESENTERS: Readonly<Record<string, ResultPresenter | undefined>> = {
  bash: shellResult,
  pwsh: shellResult,
  read: readResult,
  write: writeResult,
  edit: editResult,
  glob: globResult,
  grep: grepResult,
  web_search: webSearchResult,
  web_fetch: webFetchResult,
  ralph: keepPendingTitleResult,
  workflow: keepPendingTitleResult,
  exit_plan_mode: planReviewResult,
}

/**
 * Compute the render intent for one pending tool call.
 * @param name - Raw tool name from the `tool/call` event.
 * @param argumentsJson - Raw arguments JSON string (may be partial during streaming).
 * @returns The call view, or `undefined` for the caller's generic fallback.
 */
export function toolCallView(name: string, argumentsJson: string): ToolEventView | undefined {
  const present = CALL_PRESENTERS[name]
  if (present === undefined) return undefined
  try {
    const args = parseArguments(argumentsJson)
    if (args === undefined) return undefined
    const view = present(args)
    return view === undefined ? undefined : { for: 'call', view }
  } catch {
    return undefined
  }
}

/**
 * Compute the render intent for one completed tool call.
 * @param name - Raw tool name from the `tool/call` event the result pairs with.
 * @param argumentsJson - Raw arguments JSON string (may be partial during streaming).
 * @param result - Completed content, failure bit, and the tool-private `meta` payload.
 * @returns The result view, or `undefined` for the caller's fallback.
 */
export function toolResultView(
  name: string,
  argumentsJson: string,
  result: { content: readonly ContentBlock[]; isError: boolean; meta?: unknown },
): ToolEventView | undefined {
  const present = RESULT_PRESENTERS[name]
  if (present === undefined) return undefined
  try {
    const args = parseArguments(argumentsJson)
    if (args === undefined) return undefined
    const intent = present(args, result)
    return intent === undefined ? undefined : { for: 'result', view: intent }
  } catch {
    return undefined
  }
}
