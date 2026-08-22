/**
 * `@` file-reference completion: host-backed client, the autocomplete
 * provider overlay, and end-to-end composer behavior with a fake host index.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CombinedAutocompleteProvider, type AutocompleteItem, type AutocompleteProvider, type AutocompleteSuggestions,
} from '@earendil-works/pi-tui'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { FileReferenceClient } from '../src/file-reference.ts'
import {
  FileReferenceAutocompleteProvider, RemoteFileReferenceClient,
} from '../src/file-reference.ts'
import type { RemoteRpcCarrier } from '../src/remote.ts'
import { slashCommands } from '../src/commands.ts'
import { TerminalApplication } from '../src/terminal.ts'
import { SID } from './fake-api.ts'
import { settle, TestController, TestTerminal } from './terminal-harness.ts'

/** Fake client driven by a handler; records every invocation. */
function fakeFileReferences(
  handler: (agentId: SessionId, query: string) => FileReferenceCandidate[] | Promise<FileReferenceCandidate[]> | never,
): FileReferenceClient & { list: ReturnType<typeof vi.fn> } {
  const list = vi.fn(async (agentId: SessionId, query: string, signal: AbortSignal) => {
    if (signal.aborted) throw new Error('aborted')
    return await handler(agentId, query)
  })
  return { list }
}

function candidate(path: string, kind: 'file' | 'directory' = 'file'): FileReferenceCandidate {
  return { path, kind }
}

function carrierResult(value: unknown, error?: { code: 'internal'; message: string }): RemoteRpcCarrier {
  return {
    callRemote: vi.fn(async () => error === undefined
      ? { ok: true as const, value }
      : { ok: false as const, error: { ...error, details: {} } }),
  }
}

/** Recorder delegate: host calls never reach it; it records local fallbacks. */
class RecordingDelegate implements AutocompleteProvider {
  readonly suggestions: Array<{ lines: string[]; cursorLine: number; cursorCol: number }> = []

  async getSuggestions(
    lines: string[], cursorLine: number, cursorCol: number,
  ): Promise<AutocompleteSuggestions> {
    this.suggestions.push({ lines, cursorLine, cursorCol })
    return { items: [{ value: 'local-fallback', label: 'LOCAL-FALLBACK' }], prefix: '' }
  }

  applyCompletion(
    lines: string[], cursorLine: number, cursorCol: number,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    return { lines, cursorLine, cursorCol }
  }

  shouldTriggerFileCompletion(): boolean { return true }
}

function provider(
  client: FileReferenceClient,
  delegate: AutocompleteProvider = new RecordingDelegate(),
  getSessionId: () => SessionId | undefined = () => SID,
  onDegraded?: (detail: string) => void,
): FileReferenceAutocompleteProvider {
  return new FileReferenceAutocompleteProvider(delegate, client, {
    currentSessionId: getSessionId,
    onDegraded,
  })
}

/** Wait past pi-tui's attachment debounce and the async host round-trip. */
async function settlePopup(terminal: TestTerminal): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 80))
  await terminal.flush()
}

describe('RemoteFileReferenceClient', () => {
  it('calls fileReferences/list with agentId/query wire args and resolves candidates', async () => {
    const carrier = carrierResult([candidate('src/main.ts')])
    const client = new RemoteFileReferenceClient(carrier)
    const signal = new AbortController().signal
    await expect(client.list(SID, 'src', signal)).resolves.toEqual([{ path: 'src/main.ts', kind: 'file' }])
    expect(carrier.callRemote).toHaveBeenCalledWith('fileReferences/list', { agentId: SID, query: 'src' }, signal)
  })

  it('throws the remote error code/message for an error result', async () => {
    const client = new RemoteFileReferenceClient(carrierResult([], { code: 'internal', message: 'unmounted endpoint' }))
    await expect(client.list(SID, '', new AbortController().signal))
      .rejects.toThrow('internal: unmounted endpoint')
  })

  it('rejects when the carrier rejects (transport/abort)', async () => {
    const carrier: RemoteRpcCarrier = {
      callRemote: vi.fn(async () => { throw new Error('fetch failed') }),
    }
    await expect(new RemoteFileReferenceClient(carrier).list(SID, '', new AbortController().signal))
      .rejects.toThrow('fetch failed')
  })

  it('rejects a non-array business value', async () => {
    const client = new RemoteFileReferenceClient(carrierResult({ path: 'x' }))
    await expect(client.list(SID, '', new AbortController().signal))
      .rejects.toThrow('response is not an array')
  })
})

describe('FileReferenceAutocompleteProvider dispatch', () => {
  it('never queries the host for a slash token', async () => {
    const client = fakeFileReferences(() => [])
    const delegate = new RecordingDelegate()
    const result = await provider(client, delegate).getSuggestions(['/re'], 0, 3, { signal: new AbortController().signal })
    expect(client.list).not.toHaveBeenCalled()
    expect(delegate.suggestions).toHaveLength(1)
    expect(result?.items[0]?.value).toBe('local-fallback')
  })

  it('never queries the host outside an @ token', async () => {
    const client = fakeFileReferences(() => [])
    const delegate = new RecordingDelegate()
    await provider(client, delegate).getSuggestions(['看看这一段'], 0, 5, { signal: new AbortController().signal })
    expect(client.list).not.toHaveBeenCalled()
    expect(delegate.suggestions).toHaveLength(1)
  })

  it('does not trigger on an email-like token', async () => {
    const client = fakeFileReferences(() => [])
    const delegate = new RecordingDelegate()
    await provider(client, delegate).getSuggestions(['联系 me@example.com'], 0, 17, { signal: new AbortController().signal })
    expect(client.list).not.toHaveBeenCalled()
    expect(delegate.suggestions).toHaveLength(1)
  })

  it('queries the host for @ at line start and after whitespace', async () => {
    const client = fakeFileReferences(() => [candidate('src/main.ts'), candidate('src', 'directory')])
    const p = provider(client)
    const lineStart = await p.getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(client.list).toHaveBeenNthCalledWith(1, SID, 'src', expect.any(AbortSignal))
    expect(lineStart).toEqual({
      prefix: '@src',
      items: [
        { value: '@src/main.ts', label: 'main.ts', description: 'src/main.ts' },
        { value: '@src/', label: 'src/', description: 'src' },
      ],
    })
    const afterSpace = await p.getSuggestions(['看看 @src'], 0, 8, { signal: new AbortController().signal })
    expect(client.list).toHaveBeenNthCalledWith(2, SID, 'src', expect.any(AbortSignal))
    expect(afterSpace?.prefix).toBe('@src')
  })

  it('queries the host with the empty prefix when only @ is typed', async () => {
    const client = fakeFileReferences(() => [candidate('docs', 'directory')])
    const result = await provider(client).getSuggestions(['@'], 0, 1, { signal: new AbortController().signal })
    expect(client.list).toHaveBeenCalledWith(SID, '', expect.any(AbortSignal))
    expect(result?.items).toEqual([{ value: '@docs/', label: 'docs/', description: 'docs' }])
  })

  it('keeps an explicitly opened quote in the completion value', async () => {
    const client = fakeFileReferences(() => [
      candidate('src/my file.txt'),
      candidate('src/pkg', 'directory'),
    ])
    const result = await provider(client).getSuggestions(['@"src/my'], 0, 8, { signal: new AbortController().signal })
    expect(result?.prefix).toBe('@"src/my')
    expect(result?.items).toEqual([
      { value: '@"src/my file.txt"', label: 'my file.txt', description: 'src/my file.txt' },
      { value: '@"src/pkg/', label: 'pkg/', description: 'src/pkg' },
    ])
  })

  it('falls back locally without a loaded session (never calls the host)', async () => {
    const client = fakeFileReferences(() => [])
    const delegate = new RecordingDelegate()
    await provider(client, delegate, () => undefined).getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(client.list).not.toHaveBeenCalled()
    expect(delegate.suggestions).toHaveLength(1)
  })

  it('returns null for an empty candidate list (no popup)', async () => {
    const client = fakeFileReferences(() => [])
    await expect(provider(client).getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal }))
      .resolves.toBeNull()
  })

  it('drops candidates that cannot be represented by the grammar', async () => {
    const client = fakeFileReferences(() => [
      candidate('src/ok.ts'),
      { path: 'src/bad"quote.txt', kind: 'file' },
    ])
    const result = await provider(client).getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(result?.items).toEqual([{ value: '@src/ok.ts', label: 'ok.ts', description: 'src/ok.ts' }])
  })

  it('falls back silently on failure and logs only the first time per outage', async () => {
    let fail = true
    const client = fakeFileReferences(() => { if (fail) throw new Error('request failed'); return [candidate('src/a.ts')] })
    const delegate = new RecordingDelegate()
    const degraded = vi.fn()
    const p = provider(client, delegate, () => SID, degraded)

    const first = await p.getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(delegate.suggestions).toHaveLength(1)
    expect(first?.items[0]?.value).toBe('local-fallback')
    expect(degraded).toHaveBeenCalledTimes(1)
    expect(degraded).toHaveBeenCalledWith(expect.stringContaining('request failed'))

    const second = await p.getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(delegate.suggestions).toHaveLength(2)
    expect(second?.items[0]?.value).toBe('local-fallback')
    expect(degraded).toHaveBeenCalledTimes(1)

    // A later success re-arms the log so the next outage reports again.
    fail = false
    const recovered = await p.getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(recovered?.items[0]?.value).toBe('@src/a.ts')
    fail = true
    await p.getSuggestions(['@src'], 0, 4, { signal: new AbortController().signal })
    expect(degraded).toHaveBeenCalledTimes(2)
  })

  it('does not fall back or log for an aborted request', async () => {
    const client = fakeFileReferences(() => [])
    const delegate = new RecordingDelegate()
    const degraded = vi.fn()
    const p = provider(client, delegate, () => SID, degraded)
    const aborted = new AbortController()
    aborted.abort()
    await expect(p.getSuggestions(['@src'], 0, 4, { signal: aborted.signal })).resolves.toBeNull()
    expect(client.list).not.toHaveBeenCalled()
    expect(delegate.suggestions).toHaveLength(0)
    expect(degraded).not.toHaveBeenCalled()
  })

  it('returns null without local fallback when the host call aborts mid-flight', async () => {
    const controller = new AbortController()
    const client: FileReferenceClient = {
      list: vi.fn(() => { controller.abort(); return Promise.reject(new Error('aborted')) }),
    }
    const delegate = new RecordingDelegate()
    const degraded = vi.fn()
    await expect(provider(client, delegate, () => SID, degraded).getSuggestions(
      ['@src'], 0, 4, { signal: controller.signal },
    )).resolves.toBeNull()
    expect(delegate.suggestions).toHaveLength(0)
    expect(degraded).not.toHaveBeenCalled()
  })

  it('applies completions with pi-tui @ semantics: files end with a space, directories stay open', async () => {
    const client = fakeFileReferences(() => [candidate('src/main.ts'), candidate('src', 'directory'), candidate('src/pkg', 'directory')])
    const delegate = new CombinedAutocompleteProvider(slashCommands(), process.cwd())
    const p = provider(client, delegate)
    const suggestions = await p.getSuggestions(['前置 @src'], 0, 7, { signal: new AbortController().signal })
    expect(suggestions).not.toBeNull()

    const fileItem = suggestions!.items.find(item => item.label === 'main.ts')!
    const appliedFile = p.applyCompletion(['前置 @src'], 0, 7, fileItem, '@src')
    expect(appliedFile.lines[0]).toBe('前置 @src/main.ts ')
    expect(appliedFile.cursorCol).toBe('前置 @src/main.ts '.length)

    const dirItem = suggestions!.items.find(item => item.label === 'src/')!
    const appliedDir = p.applyCompletion(['前置 @src'], 0, 7, dirItem, '@src')
    expect(appliedDir.lines[0]).toBe('前置 @src/')
    expect(appliedDir.cursorCol).toBe('前置 @src/'.length)

    // Completing a directory inside an open quote keeps the quote open so the
    // next keystroke continues the same token.
    const quotedDir: AutocompleteItem = { value: '@"src/pkg/', label: 'pkg/', description: 'src/pkg' }
    const appliedQuoted = p.applyCompletion(['@"src/'], 0, 6, quotedDir, '@"src/')
    expect(appliedQuoted.lines[0]).toBe('@"src/pkg/')
    expect(appliedQuoted.cursorCol).toBe('@"src/pkg/'.length)
  })
})

describe('@ completion in the composer (remote host index)', () => {
  it('shows host candidates in the popup and applies the best match', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController({ sessionId: SID })
    const client = fakeFileReferences((_agentId, query) => (
      query.startsWith('src') ? [candidate('src/main.ts'), candidate('src/README.md')] : []
    ))
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, {
      terminal,
      fileReferences: client,
      onFileReferenceDegraded: () => {},
    })
    application.start()
    await settle(terminal)

    terminal.send('@')
    terminal.send('s')
    terminal.send('r')
    terminal.send('c')
    await settlePopup(terminal)
    expect(client.list).toHaveBeenCalledWith(SID, 'src', expect.any(AbortSignal))
    expect(application.view.editor.isShowingAutocomplete()).toBe(true)
    expect(terminal.viewport()).toContain('main.ts')
    expect(terminal.viewport()).toContain('README.md')

    // Without an explicit highlight the best match is selected; Tab applies
    // the mention, ending it with a space (pi-tui @ semantics).
    terminal.send('\t')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('@src/main.ts ')
    application.stop()
  })

  it('keeps completion open for a directory and queries the next prefix segment', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController({ sessionId: SID })
    const client = fakeFileReferences((_agentId, query) => {
      if (query === '') return [candidate('src', 'directory')]
      if (query === 'src/u') return [candidate('src/util', 'directory')]
      return []
    })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, {
      terminal,
      fileReferences: client,
      onFileReferenceDegraded: () => {},
    })
    application.start()
    await settle(terminal)

    terminal.send('@')
    await settlePopup(terminal)
    expect(application.view.editor.isShowingAutocomplete()).toBe(true)
    expect(terminal.viewport()).toContain('src/')
    terminal.send('\t')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('@src/')

    // The token stays active: the next query is the extended prefix.
    terminal.send('u')
    await settlePopup(terminal)
    expect(client.list).toHaveBeenCalledWith(SID, 'src/u', expect.any(AbortSignal))
    expect(application.view.editor.isShowingAutocomplete()).toBe(true)
    expect(terminal.viewport()).toContain('util/')
    application.stop()
  })

  it('falls back silently on host failure and keeps slash completion working', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController({ sessionId: SID })
    const client = fakeFileReferences(() => { throw new Error('request failed') })
    const degraded = vi.fn()
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, {
      terminal,
      fileReferences: client,
      onFileReferenceDegraded: degraded,
    })
    application.start()
    await settle(terminal)

    terminal.send('@')
    terminal.send('s')
    terminal.send('r')
    terminal.send('c')
    await settlePopup(terminal)
    expect(degraded).toHaveBeenCalledTimes(1)
    expect(degraded).toHaveBeenCalledWith(expect.stringContaining('request failed'))
    expect(application.view.editor.isShowingAutocomplete()).toBe(false)
    // No user-visible error text interrupts the composer.
    expect(terminal.viewport()).not.toContain('request failed')
    expect(application.view.editor.getText()).toBe('@src')

    // Slash completion still works with the wrapper mounted (Ctrl+N picks the
    // second row, Tab applies it, mirroring the existing slash-completion test).
    terminal.send('\u001B')
    terminal.send('/')
    terminal.send('r')
    await settle(terminal)
    expect(terminal.viewport()).toContain('rename')
    terminal.send('\u000E')
    await settle(terminal)
    terminal.send('\t')
    await settle(terminal)
    expect(application.view.editor.getText()).toBe('/rename ')
    application.stop()
  })

  it('keeps accepting input across repeated host failures', async () => {
    const terminal = new TestTerminal(110, 24)
    const controller = new TestController({ sessionId: SID })
    const client = fakeFileReferences(() => { throw new Error('request failed') })
    const application = new TerminalApplication(controller.asController(), { continueLatest: false }, {
      terminal,
      fileReferences: client,
      onFileReferenceDegraded: () => {},
    })
    application.start()
    await settle(terminal)

    terminal.send('@')
    terminal.send('x')
    await settlePopup(terminal)
    terminal.send('y')
    await settlePopup(terminal)
    expect(application.view.editor.getText()).toBe('@xy')
    expect(application.view.editor.isShowingAutocomplete()).toBe(false)
    expect(terminal.viewport()).not.toContain('错误')
    application.stop()
  })
})