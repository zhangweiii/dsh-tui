import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type { ToolCallView, ToolResultView } from '../src/contract/index.ts'
import { toolCallView, toolResultView } from '../src/presentation.ts'

/** Text-only result content, the shape every shipped tool result in these fixtures uses. */
function text(value: string): ContentBlock[] {
  return [{ type: 'text', text: value }]
}

/** The computed call view for one fixture, or `undefined` when the caller should fall back. */
function callView(name: string, args: unknown): ToolCallView | undefined {
  const event = toolCallView(name, JSON.stringify(args))
  return event !== undefined && event.for === 'call' ? event.view : undefined
}

/** The computed result view for one fixture, or `undefined` when the caller should fall back. */
function resultView(
  name: string,
  args: unknown,
  result: { content: readonly ContentBlock[]; isError: boolean; meta?: unknown },
): ToolResultView | undefined {
  const event = toolResultView(name, JSON.stringify(args), result)
  return event !== undefined && event.for === 'result' ? event.view : undefined
}

describe('shell cards', () => {
  it('renders bash/pwsh terminal calls and parses the exit-status markers', () => {
    expect(callView('bash', { command: 'pwd', description: 'print the cwd', workdir: 'src' })).toEqual({
      card: 'terminal', title: 'pwd', description: 'print the cwd', cwd: 'src',
    })
    expect(callView('pwsh', { command: 'Get-Location', description: 'print the cwd' })).toEqual({
      card: 'terminal', title: 'Get-Location', description: 'print the cwd',
    })
    expect(callView('bash', { command: 'sleep 5', description: 'wait', run_in_background: true })).toEqual({
      card: 'generic', title: 'sleep 5', kind: 'execute', rawInput: 'sleep 5',
      content: [{ type: 'text', text: 'wait' }],
    })
    expect(resultView('bash', { command: 'pwd', description: 'print the cwd' }, {
      content: text('out\n\n[exit code: 2]'), isError: false,
    })).toEqual({ card: 'terminal', output: 'out\n', exitCode: 2 })
    expect(resultView('pwsh', { command: 'x', description: 'y' }, {
      content: text('partial\n[killed by signal: SIGTERM]'), isError: false,
    })).toEqual({ card: 'terminal', output: 'partial', signal: 'SIGTERM' })
    expect(resultView('bash', { command: 'pwd', description: 'print the cwd' }, {
      content: text('clean\n'), isError: false,
    })).toEqual({ card: 'terminal', output: 'clean\n', exitCode: 0 })
    expect(resultView('bash', { command: 'pwd', description: 'print the cwd', run_in_background: true }, {
      content: text('started\n'), isError: false,
    })).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nstarted\n```' }] })
    expect(resultView('bash', { command: 'pwd', description: 'print the cwd' }, {
      content: text('boom\n\n'), isError: true,
    })).toEqual({ card: 'generic', content: [{ type: 'text', text: '```console\nboom\n```' }] })
    expect(resultView('bash', { command: 'wait', description: 'wait' }, {
      content: text('chunk\n[still running after 30000ms; moved to background job job-1]\nThe command keeps running in the background.'),
      isError: false,
    })).toEqual({
      card: 'generic',
      content: [{
        type: 'text',
        text: '```console\nchunk\n[still running after 30000ms; moved to background job job-1]\nThe command keeps running in the background.\n```',
      }],
    })
  })

  it('keeps the persistent shell commands on the command-titled terminal card with a raw result', () => {
    expect(callView('bash_persistent', { command: 'tail -f log' })).toEqual({ card: 'terminal', title: 'tail -f log' })
    expect(callView('pwsh_persistent', { command: 'Get-Content log' })).toEqual({ card: 'terminal', title: 'Get-Content log' })
    expect(resultView('bash_persistent', { command: 'tail -f log' }, {
      content: text('line'), isError: false,
    })).toBeUndefined()
  })
})

describe('diff cards', () => {
  it('derives write/edit/str_replace_editor call diffs from arguments', () => {
    expect(callView('write', { file_path: 'a.txt', content: 'hello' })).toEqual({
      card: 'diff', title: 'Write a.txt',
      diffs: [{ path: 'a.txt', oldText: null, newText: 'hello' }],
      locations: [{ path: 'a.txt' }],
    })
    expect(callView('edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' })).toEqual({
      card: 'diff', title: 'Edit a.txt',
      diffs: [{ path: 'a.txt', oldText: 'x', newText: 'y' }],
      locations: [{ path: 'a.txt' }],
    })
    expect(callView('str_replace_editor', { command: 'create', path: '/a.txt', file_text: 'new' })).toEqual({
      card: 'diff', title: 'create /a.txt',
      diffs: [{ path: '/a.txt', oldText: null, newText: 'new' }],
      locations: [{ path: '/a.txt' }],
    })
    expect(callView('str_replace_editor', { command: 'str_replace', path: '/a.txt', old_str: 'a', new_str: 'b' })).toEqual({
      card: 'diff', title: 'str_replace /a.txt',
      diffs: [{ path: '/a.txt', oldText: 'a', newText: 'b' }],
      locations: [{ path: '/a.txt' }],
    })
    expect(callView('str_replace_editor', { command: 'delete', path: '/a.txt' })).toBeUndefined()
  })

  it('uses result meta diffs when present and falls back to the write arguments', () => {
    const diffs = [{ path: 'a.txt', oldText: 'before', newText: 'after' }]
    expect(resultView('edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' }, {
      content: text('edited'), isError: false, meta: { diffs },
    })).toEqual({ card: 'diff', title: 'Edit a.txt', diffs })
    expect(resultView('write', { file_path: 'a.txt', content: 'hello' }, {
      content: text('wrote'), isError: false,
    })).toEqual({
      card: 'diff', title: 'Write a.txt', diffs: [{ path: 'a.txt', oldText: null, newText: 'hello' }],
    })
    expect(resultView('edit', { file_path: 'a.txt' }, {
      content: text('edited'), isError: false, meta: { diffs: [] },
    })).toBeUndefined()
    expect(resultView('write', { file_path: 'a.txt', content: 'hello' }, {
      content: text('boom'), isError: true, meta: { diffs },
    })).toBeUndefined()
  })
})

describe('search cards', () => {
  it('titles grep/glob calls with the pattern, root, and include filter', () => {
    expect(callView('grep', { pattern: 'todo', path: 'src', include: '*.ts' })).toEqual({
      card: 'generic', title: 'Grep todo in src (*.ts)', kind: 'search', rawInput: 'todo',
    })
    expect(callView('glob', { pattern: '**/*.ts' })).toEqual({
      card: 'generic', title: 'Glob **/*.ts', kind: 'search', rawInput: '**/*.ts',
    })
  })

  it('projects grep match groups and glob path lists from result meta', () => {
    const files = [{ path: 'src/a.ts', matches: [{ lineNumber: 3, line: 'todo()' }, { lineNumber: 5, line: 'again' }] }]
    expect(resultView('grep', { pattern: 'todo' }, {
      content: text('Found 2 matches'), isError: false,
      meta: { shape: 'matches', files, truncated: false, total: 2 },
    })).toEqual({ card: 'search', shape: 'matches', files, truncated: false, total: 2 })
    expect(resultView('glob', { pattern: '**/*.ts' }, {
      content: text('Found 3 paths'), isError: false,
      meta: { shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 3 },
    })).toEqual({ card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 3 })
    expect(resultView('grep', { pattern: 'todo' }, {
      content: text('Found 3 paths'), isError: false,
      meta: { shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 },
    })).toBeUndefined()
    expect(resultView('glob', { pattern: '**/*.ts' }, {
      content: text('x'), isError: true, meta: { shape: 'paths', paths: [], truncated: false, total: 0 },
    })).toBeUndefined()
  })
})

describe('read cards', () => {
  const meta = {
    path: 'src/a.ts', offset: 10, totalLines: 12, lang: 'ts',
    lines: [{ number: 10, text: 'const a = 1' }, { number: 11, text: '' }],
  }
  const envelope = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n'
    + '10: const a = 1\n\n(Showing lines 10-11 of 12. Use offset=12 to continue.)\n</content>'

  it('titles the read call with its line window', () => {
    expect(callView('read', { file_path: 'src/a.ts', offset: 10, limit: 5 })).toEqual({
      card: 'generic', title: 'Read src/a.ts (10 - 14)', kind: 'read', locations: [{ path: 'src/a.ts', line: 10 }],
    })
    expect(callView('read', { file_path: 'src/a.ts', offset: 5 })).toEqual({
      card: 'generic', title: 'Read src/a.ts (from line 5)', kind: 'read', locations: [{ path: 'src/a.ts', line: 5 }],
    })
  })

  it('projects the structured read window and strips the envelope', () => {
    expect(resultView('read', { file_path: 'src/a.ts', offset: 10, limit: 5 }, {
      content: text(envelope), isError: false, meta,
    })).toEqual({
      card: 'read', path: 'src/a.ts', offset: 10, totalLines: 12, lang: 'ts',
      lines: [{ number: 10, text: 'const a = 1' }, { number: 11, text: '' }],
      content: [{ type: 'text', text: '10: const a = 1\n\n(Showing lines 10-11 of 12. Use offset=12 to continue.)' }],
    })
    expect(resultView('read', { file_path: 'src/a.ts' }, {
      content: text('plain text'), isError: false, meta,
    })).toBeUndefined()
  })

  it('declines malformed read meta instead of misnumbering lines', () => {
    expect(resultView('read', { file_path: 'src/a.ts' }, {
      content: text(envelope), isError: false, meta: { ...meta, lines: [{ number: 2, text: 'x' }] },
    })).toBeUndefined()
    expect(resultView('read', { file_path: 'src/a.ts' }, {
      content: text(envelope), isError: false, meta: { ...meta, offset: 0 },
    })).toBeUndefined()
    expect(resultView('read', { file_path: 'src/a.ts' }, {
      content: text(envelope), isError: true, meta,
    })).toBeUndefined()
  })
})

describe('web cards', () => {
  it('renders fetch calls and results', () => {
    expect(callView('web_fetch', { url: 'https://example.com' })).toEqual({
      card: 'generic', title: 'https://example.com', kind: 'fetch', rawInput: 'https://example.com',
    })
    expect(resultView('web_fetch', { url: 'https://example.com' }, {
      content: text('body'), isError: false,
      meta: { url: 'https://example.com/final', statusCode: 200, truncated: true },
    })).toEqual({
      card: 'web', kind: 'fetch', title: 'https://example.com',
      url: 'https://example.com/final', statusCode: 200, truncated: true,
    })
  })

  it('renders search calls and results with the faithful sources', () => {
    expect(callView('web_search', { queries: ['a', 'b'] })).toEqual({
      card: 'generic', title: 'a, b', kind: 'search', rawInput: 'a, b',
    })
    const sources = [{ url: 'https://a', title: 'A', snippet: 's' }, { url: 'https://b' }]
    expect(resultView('web_search', { queries: ['deepseek'] }, {
      content: text('results'), isError: false,
      meta: { sources, truncated: false, answer: 'hi' },
    })).toEqual({ card: 'web', kind: 'search', title: 'deepseek', sources, truncated: false, answer: 'hi' })
    expect(resultView('web_search', { queries: ['x'] }, {
      content: text('x'), isError: false, meta: { sources: [{ url: 1 }], truncated: false },
    })).toBeUndefined()
  })
})

describe('generic cards', () => {
  it('covers the remaining shipped call presenters', () => {
    expect(callView('todo_write', { todos: [{ content: 'a', status: 'pending' }] })).toEqual({
      card: 'generic', title: 'Update todo list', kind: 'other', rawInput: [{ content: 'a', status: 'pending' }],
    })
    expect(callView('job_output', { job_id: 'job-1' })).toEqual({
      card: 'generic', title: 'Read output from background job job-1', kind: 'read', rawInput: 'job-1',
    })
    expect(callView('job_list', {})).toEqual({ card: 'generic', title: 'List background jobs', kind: 'read' })
    expect(callView('job_kill', { job_id: 'job-1' })).toEqual({
      card: 'generic', title: 'Kill background job job-1', kind: 'execute', rawInput: 'job-1',
    })
    expect(callView('skill', { name: 'pdf' })).toEqual({
      card: 'generic', title: 'Load skill pdf', kind: 'read', rawInput: 'pdf',
    })
    expect(callView('get_goal', {})).toEqual({ card: 'generic', title: 'Read current goal', kind: 'read' })
    expect(callView('create_goal', { objective: 'ship it' })).toEqual({
      card: 'generic', title: 'Create goal', kind: 'other', rawInput: 'ship it',
    })
    expect(callView('update_goal', { action: 'blocked', goal_id: 'g1', revision: 1, blocked_reason: 'stuck' })).toEqual({
      card: 'generic', title: 'Mark goal', kind: 'other', rawInput: 'stuck',
    })
    expect(callView('update_goal', { action: 'pause', goal_id: 'g1', revision: 1 })).toEqual({
      card: 'generic', title: 'Pause goal', kind: 'other', rawInput: 'g1',
    })
    expect(callView('workflow', { script: 'return 1', meta: { name: 'audit' } })).toEqual({
      card: 'generic', title: 'workflow: audit', rawInput: 'return 1',
    })
    expect(callView('str_replace_editor', { command: 'view', path: '/a.ts' })).toEqual({
      card: 'generic', title: 'view /a.ts', kind: 'read', locations: [{ path: '/a.ts' }],
    })
    expect(callView('str_replace_editor', { command: 'insert', path: '/a.ts', insert_line: 2 })).toEqual({
      card: 'generic', title: 'insert /a.ts', kind: 'edit', locations: [{ path: '/a.ts', line: 3 }],
    })
    expect(callView('read_image', { file_path: 'a.png' })).toEqual({
      card: 'generic', title: 'Read image a.png', kind: 'read', locations: [{ path: 'a.png' }],
    })
    expect(callView('cordis_inspect_list', {})).toEqual({
      card: 'generic', title: 'List Cordis Inspect Providers', kind: 'read',
    })
    expect(callView('cordis_inspect_query', { platform: 'host', provider: 'tools', method: 'list' })).toEqual({
      card: 'generic', title: 'Query Cordis host tools.list', kind: 'read',
    })
    expect(callView('schedule_create', { prompt: 'ping', title: 'x' })).toEqual({
      card: 'generic', title: 'Create reminder', kind: 'other', rawInput: 'ping',
    })
    expect(callView('schedule_delete', { id: 's1' })).toEqual({
      card: 'generic', title: 'Delete reminder', kind: 'other', rawInput: 's1',
    })
    expect(callView('load_workspace_dependencies', {})).toEqual({
      card: 'generic', title: 'Load workspace dependencies', kind: 'read',
    })
    expect(callView('run_code', { code: 'return 1', description: 'probe' })).toEqual({
      card: 'generic', title: 'probe', kind: 'execute', rawInput: 'return 1',
    })
  })

  it('renders plan review cards and the keep-the-pending-title result cards', () => {
    expect(callView('exit_plan_mode', { plan: '# Ship it\n\n1. test' })).toEqual({
      card: 'generic', title: 'Ship it', kind: 'other', content: [{ type: 'text', text: '# Ship it\n\n1. test' }],
    })
    expect(resultView('exit_plan_mode', { plan: '# Ship it' }, {
      content: text('Plan approved'), isError: false,
    })).toEqual({ card: 'generic', title: 'Plan review', content: [{ type: 'text', text: 'Plan approved' }] })
    expect(resultView('workflow', { script: 'return 1', meta: { name: 'audit' } }, {
      content: text('done'), isError: false,
    })).toEqual({ card: 'generic' })
    expect(resultView('ralph', { objective: 'ship' }, {
      content: text('round 1'), isError: false,
    })).toEqual({ card: 'generic' })
  })
})

describe('fallbacks', () => {
  it('returns undefined for unknown tools and malformed argument JSON', () => {
    expect(toolCallView('mystery_tool', '{"a":1}')).toBeUndefined()
    expect(toolCallView('subagent', '{"prompt":"x"}')).toBeUndefined()
    expect(toolCallView('ask_user_question', '{"questions":[]}')).toBeUndefined()
    expect(toolCallView('present', '{"files":[]}')).toBeUndefined()
    expect(toolCallView('bash', '{"command":"ls"')).toBeUndefined()
    expect(toolCallView('bash', '[]')).toBeUndefined()
    expect(toolCallView('bash', '')).toBeUndefined()
    expect(toolResultView('bash', '{"command":', { content: text('x'), isError: false })).toBeUndefined()
  })

  it('keeps the raw result for tools without a result presenter', () => {
    expect(resultView('todo_write', { todos: [] }, {
      content: text('Updated todo list'), isError: false,
    })).toBeUndefined()
    expect(resultView('read_image', { file_path: 'a.png' }, { content: text('img'), isError: false })).toBeUndefined()
    expect(resultView('skill', { name: 'pdf' }, { content: text('skill body'), isError: false })).toBeUndefined()
  })

  it('never throws on arbitrary input', () => {
    expect(() => toolCallView('grep', '"not an object"')).not.toThrow()
    expect(() => toolResultView('read', '3', { content: [], isError: false, meta: 'junk' })).not.toThrow()
    expect(toolCallView('workflow', '{"script":"x"}')).toBeUndefined()
    expect(toolCallView('bash', 'null')).toBeUndefined()
  })
})
