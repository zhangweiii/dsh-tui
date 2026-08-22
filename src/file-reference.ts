/**
 * Host-backed `@file` reference completion for the composer editor.
 *
 * The provider owns only the `@` token, recognized with the shared
 * dsh-file-reference grammar (`activeAtToken`), so the trigger rule is
 * identical to the Web composer: an `@path` or open `@"path with spaces`
 * token at line start or after whitespace. Every other trigger — slash
 * commands, local path prefixes, forced Tab — delegates verbatim to the
 * wrapped CombinedAutocompleteProvider, preserving pi-tui behavior exactly,
 * including `applyCompletion` @-replacement and cursor semantics.
 *
 * When the current session has a remote Web Host exposing `fileReferences`,
 * candidates come from the Host's bounded fuzzy index (scoped to the session
 * cwd); every failure — aborted signals, error responses, unmounted
 * endpoints, standalone hosts — falls back quietly to the delegate, so a
 * missing service never pops an error or interrupts the user. The optional
 * degraded logger is diagnostic only.
 */

import { activeAtToken, formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {
  AutocompleteItem, AutocompleteProvider, AutocompleteSuggestions,
} from '@earendil-works/pi-tui'
import { basename } from 'node:path'
import type { RemoteRpcCarrier } from './remote.ts'

/** Wire namespace of the Host Remote endpoint backing `@` completion. */
const FILE_REFERENCES_ENDPOINT = 'fileReferences/list'

/** Host file-reference discovery bound to one editor session. */
export interface FileReferenceClient {
  /**
   * List file and directory candidates inside the target session's cwd.
   * Rejects on transport failure, unmounted endpoint, or an error result;
   * cancellation arrives through `signal`.
   */
  list(agentId: SessionId, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]>
}

/**
 * Client for the typert Remote `fileReferences/list` method on the shared
 * `/api` Connection RPC channel — the same wire shape the Web composer uses.
 */
export class RemoteFileReferenceClient implements FileReferenceClient {
  constructor(private readonly carrier: RemoteRpcCarrier) {}

  list(agentId: SessionId, query: string, signal: AbortSignal): Promise<FileReferenceCandidate[]> {
    return this.carrier.callRemote(FILE_REFERENCES_ENDPOINT, { agentId, query }, signal)
      .then((result) => {
        if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
        if (!Array.isArray(result.value)) throw new Error(`${FILE_REFERENCES_ENDPOINT}: response is not an array`)
        return result.value as FileReferenceCandidate[]
      })
  }
}

/** Session context and diagnostics for one provider instance. */
export interface FileReferenceAutocompleteHooks {
  /** Session id of the editor's current session, when one is loaded. */
  currentSessionId(): SessionId | undefined
  /** Diagnostic sink for silent `@` fallbacks; never rendered in the view. */
  onDegraded?(detail: string): void
}

/**
 * Autocomplete provider that overlays host-backed `@` file completion on top
 * of a pi-tui provider (the slash + local-path `CombinedAutocompleteProvider`).
 */
export class FileReferenceAutocompleteProvider implements AutocompleteProvider {
  private readonly onDegraded: (detail: string) => void
  /** First fallback per outage episode is logged; repeats stay silent. */
  private degraded = false

  constructor(
    private readonly delegate: AutocompleteProvider,
    private readonly fileReferences: FileReferenceClient,
    private readonly hooks: FileReferenceAutocompleteHooks,
  ) {
    this.onDegraded = hooks.onDegraded ?? (() => {})
  }

  /** pi-tui trigger characters follow the delegate (slash defaults, `@`, `#`). */
  get triggerCharacters(): string[] | undefined {
    return this.delegate.triggerCharacters
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    // Only the shared `@` grammar is host-backed; anything else — including
    // slash commands and local path prefixes — keeps the delegate behavior.
    const token = activeAtToken(lines[cursorLine] ?? '', cursorCol)
    if (token === undefined) return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options)
    const agentId = this.hooks.currentSessionId()
    if (agentId === undefined) return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options)
    if (options.signal.aborted) return null
    try {
      const candidates = await this.fileReferences.list(agentId, token.query, options.signal)
      if (options.signal.aborted) return null
      const items = this.toItems(candidates, token.quoted)
      this.degraded = false
      return items.length === 0 ? null : { items, prefix: token.prefix }
    } catch (error) {
      // Silent degradation: a stale aborted request is dropped by the editor
      // anyway and must not trigger the local fallback.
      if (options.signal.aborted) return null
      this.logDegraded(error)
      return this.delegate.getSuggestions(lines, cursorLine, cursorCol, options)
    }
  }

  /** pi-tui `@` replacement and cursor semantics apply verbatim. */
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return this.delegate.applyCompletion(lines, cursorLine, cursorCol, item, prefix)
  }

  /** Tab-force policy stays with the delegate. */
  shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
    return this.delegate.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true
  }

  /** Map host candidates to popup items; labels keep pi-tui's `/` convention. */
  private toItems(candidates: readonly FileReferenceCandidate[], quoted: boolean): AutocompleteItem[] {
    const items: AutocompleteItem[] = []
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const normalized: FileReferenceCandidate = candidate.kind === 'directory'
        ? { path: candidate.path.replace(/\/+$/u, ''), kind: 'directory' }
        : candidate
      if (normalized.path === '' || normalized.path === '.') continue
      const name = basename(normalized.path)
      if (name === '' || name === '.' || name === '..') continue
      const value = formatFileMention(normalized, quoted)
      if (value === undefined) continue
      items.push({
        value,
        label: `${name}${normalized.kind === 'directory' ? '/' : ''}`,
        description: normalized.path,
      })
    }
    return items
  }

  /** One notice per outage episode, then silence until the index responds again. */
  private logDegraded(error: unknown): void {
    if (this.degraded) return
    this.degraded = true
    const detail = error instanceof Error ? error.message : String(error)
    this.onDegraded(`@ 文件补全回退：${detail}`)
  }
}
