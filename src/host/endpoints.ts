/**
 * Mapping from the terminal's frozen Host API vocabulary (`src/contract`) onto
 * the DSH 0.2.x Typert Remote endpoints served by `@deepseek-ai/dsh-api-gateway`
 * and its per-domain contributions.
 *
 * Every entry states three things: the wire endpoint, how the contract payload
 * becomes that endpoint's named wire arguments, and how its `RemoteResult` value
 * becomes the contract value. Methods that need more than one round trip (or a
 * follow generation the caller owns) live in `./client.ts` instead and are
 * listed in `DERIVED_METHODS`.
 *
 * @module @zhangweiii/dsh-tui/host/endpoints
 */

import { randomUUID } from 'node:crypto'
import type { AgentPresetRoster } from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { CredentialInfo } from '@deepseek-ai/dsh-credentials/types'
import type { DirectoryListing } from '@deepseek-ai/dsh-host-directory-picker/types'
import type { LlmConfigurableProvider, LlmDiscoveredModel } from '@deepseek-ai/dsh-llm/types'
import type { SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import type { SubagentInterruptReceipt } from '@deepseek-ai/dsh-subagent/client'
import type { SessionListValue, SessionSummary as RemoteSessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'
import type { WorkspaceCreateValue, WorkspaceView as RemoteWorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
// Load-bearing type-only import: the agent-preset registry augments the session
// projection map with the preset a session runs under.
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type { RequestPayload, RpcMethodMap, ResponseValue } from '../contract/rpc-map.ts'
import type { SessionProjectionsBlock, SessionSummary } from '../contract/sessions.ts'
import type { WorkspaceView } from '../contract/workspace.ts'

/** One unary contract method mapped onto a current Remote endpoint. */
export interface UnaryMapping<K extends keyof RpcMethodMap> {
  /** Wire endpoint (`<namespace>/<method>`). */
  readonly endpoint: string
  /** Named wire arguments for that endpoint. */
  args(payload: RequestPayload<K>): Record<string, unknown>
  /** Contract value decoded from the endpoint's RemoteResult value. */
  decode(value: unknown): ResponseValue<K>
}

/**
 * Methods the shared client implements itself: they need a follow generation's
 * cursor, a second round trip, or a subscription.
 */
export const DERIVED_METHODS = [
  'session.history',
  'session.models',
  'subagent.list',
  'subagent.history',
  'host.describe',
  'workspace.list',
  'llm.models',
  'agentPreset.copy',
  'agentPreset.openDocument',
  'agentPreset.remove',
] as const satisfies readonly (keyof RpcMethodMap)[]

function identity<T>(value: unknown): T {
  return value as T
}

/**
 * Project one current workspace view onto the contract view (the current shape
 * is readonly and carries no extra fields, so this only restores mutability).
 * @param view - workspace as the Host reports it.
 * @returns the contract workspace view.
 */
export function workspaceView(view: RemoteWorkspaceView): WorkspaceView {
  return {
    workspaceId: view.workspaceId,
    path: view.path,
    title: view.title,
    sessionIds: [...view.sessionIds],
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  }
}

/**
 * Project one current session-list row onto the contract row. The current row
 * carries `agentAvailable` (dropped: this contract derives availability from
 * `running`) and moves the agent preset out of the row into the projection
 * block, which is where the contract already reads every other live fact.
 * @param item - row as the Host reports it.
 * @returns the contract row.
 */
export function sessionSummary(item: RemoteSessionSummary): SessionSummary {
  const hints = item.projections
  const projections: SessionProjectionsBlock | undefined = hints === undefined
    ? undefined
    : { asOfSeq: hints.asOfSeq, values: hints.values }
  const preset = hints?.values.agentPreset
  return {
    sessionId: item.sessionId,
    updatedAt: item.updatedAt,
    running: item.running,
    blank: item.blank,
    ...(item.parentSessionId === undefined ? {} : { parentSessionId: item.parentSessionId }),
    ...(item.origin === undefined ? {} : { origin: item.origin }),
    ...(item.cwd === undefined ? {} : { cwd: item.cwd }),
    ...(typeof preset === 'string' ? { agentPreset: preset } : {}),
    ...(projections === undefined ? {} : { projections }),
  }
}


/** Unary endpoint table; `satisfies` keeps every row's payload/value typed. */
export const UNARY_ENDPOINTS = {
  'session.list': {
    endpoint: 'session/list',
    args: payload => ({ _request: payload.cursor === undefined ? {} : { cursor: payload.cursor } }),
    decode: (value: unknown) => ({ items: (value as SessionListValue).items.map(sessionSummary) }),
  },
  'session.search': {
    endpoint: 'session/search',
    args: payload => ({ request: { query: payload.query } }),
    decode: identity,
  },
  'session.create': {
    endpoint: 'session/create',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.selectModel': {
    endpoint: 'session/selectModel',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.rename': {
    endpoint: 'session/rename',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.fork': {
    endpoint: 'session/fork',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.attachment': {
    endpoint: 'session/attachment',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.updateQueue': {
    endpoint: 'session/updateQueue',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.cancel': {
    endpoint: 'session/cancel',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'session.prompt': {
    endpoint: 'session/prompt',
    // The current prompt endpoint reconciles the optimistic terminal row with
    // the durable message through a client-minted request id.
    args: payload => ({ request: { requestId: randomUUID(), ...payload } }),
    decode: identity,
  },
  'subagent.prompt': {
    endpoint: 'subagents/prompt',
    args: payload => ({
      request: {
        parentSessionId: payload.parentSessionId,
        childSessionId: payload.childSessionId,
        mode: payload.mode,
        content: payload.content,
        ...(payload.clientTimeZone === undefined ? {} : { clientTimeZone: payload.clientTimeZone }),
      },
    }),
    decode: identity,
  },
  'subagent.interrupt': {
    endpoint: 'subagents/interruptByParent',
    args: payload => ({
      parentSessionId: payload.parentSessionId,
      childSessionId: payload.childSessionId,
      mode: payload.mode,
    }),
    decode: (value: unknown) => value as SubagentInterruptReceipt,
  },
  'host.pickDirectory': {
    endpoint: 'directoryPicker/pick',
    args: () => ({}),
    decode: (value: unknown) => ({ path: value as string | null }),
  },
  'host.listDirectory': {
    endpoint: 'directoryPicker/list',
    args: payload => ({ path: payload.path ?? null }),
    decode: (value: unknown) => value as DirectoryListing,
  },
  'host.createDirectory': {
    endpoint: 'directoryPicker/createDirectory',
    args: payload => ({ path: payload.path, name: payload.name }),
    decode: (value: unknown) => ({ path: value as string }),
  },
  'host.openPath': {
    endpoint: 'session/openWorkspacePath',
    args: payload => ({ request: { path: payload.path } }),
    decode: () => ({ opened: true as const }),
  },
  'workspace.create': {
    endpoint: 'workspace/create',
    args: payload => ({ request: { path: payload.path } }),
    decode: (value: unknown) => {
      const created = value as WorkspaceCreateValue
      return { created: created.created, workspace: workspaceView(created.workspace) }
    },
  },
  'workspace.rename': {
    endpoint: 'workspace/rename',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'workspace.delete': {
    endpoint: 'workspace/delete',
    args: payload => ({ request: { ...payload } }),
    decode: identity,
  },
  'workspace.insertBefore': {
    endpoint: 'workspace/insertBefore',
    args: payload => ({
      request: {
        workspaceId: payload.workspaceId,
        ...(payload.beforeWorkspaceId === undefined ? {} : { beforeWorkspaceId: payload.beforeWorkspaceId }),
      },
    }),
    decode: identity,
  },
  'workspace.insertSessionBefore': {
    endpoint: 'workspace/insertSessionBefore',
    args: payload => ({
      request: {
        workspaceId: payload.workspaceId,
        sessionId: payload.sessionId,
        ...(payload.beforeSessionId === undefined ? {} : { beforeSessionId: payload.beforeSessionId }),
      },
    }),
    decode: identity,
  },
  'workspace.archiveSession': {
    endpoint: 'workspace/archiveSession',
    args: payload => ({ request: { sessionId: payload.sessionId } }),
    decode: identity,
  },

  'skill.list': {
    endpoint: 'skills/list',
    args: payload => ({ request: { sessionId: payload.sessionId } }),
    decode: identity,
  },
  'agentPreset.list': {
    endpoint: 'agentPresets/list',
    args: () => ({}),
    decode: (value: unknown) => ({
      presets: (value as AgentPresetRoster).presets.map(preset => ({
        ...preset,
        // Every roster row the Host reports is deployment-owned; user-authored
        // presets reach the row through the same registry.
        trust: 'system' as const,
      })),
      // The current roster Remote states no authorship capability: editing a
      // preset document belongs to the Host's settings document (`/settings`).
      authorable: false,
      hasDocument: false,
    }),
  },
  'agentPreset.select': {
    endpoint: 'agentPresets/select',
    args: payload => ({ agentId: payload.sessionId, agentPreset: payload.agentPreset }),
    decode: (value: unknown) => ({ agentPreset: value as string }),
  },
  'agentPreset.read': {
    endpoint: 'agentPresets/read',
    args: payload => ({ agentPreset: payload.agentPreset }),
    decode: (value: unknown) => {
      const document = value as { agentPreset: string; content: string; name?: string; description?: string }
      return {
        agentPreset: document.agentPreset,
        // The current Remote returns one normalized document without authorship
        // metadata; the terminal treats it as deployment-owned.
        trust: 'system' as const,
        content: document.content,
        ...(document.name === undefined ? {} : { name: document.name }),
        ...(document.description === undefined ? {} : { description: document.description }),
      }
    },
  },
  'goal.create': {
    endpoint: 'goals/create',
    args: payload => ({
      agentId: payload.sessionId,
      request: {
        objective: payload.objective,
        ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }),
      },
    }),
    decode: identity,
  },
  'goal.edit': {
    endpoint: 'goals/edit',
    args: payload => ({
      agentId: payload.sessionId,
      ref: payload.ref,
      request: {
        ...(payload.objective === undefined ? {} : { objective: payload.objective }),
        ...(payload.maxGoalRounds === undefined ? {} : { maxGoalRounds: payload.maxGoalRounds }),
      },
    }),
    decode: identity,
  },
  'goal.pause': {
    endpoint: 'goals/pause',
    args: payload => ({ agentId: payload.sessionId, ref: payload.ref }),
    decode: identity,
  },
  'goal.resume': {
    endpoint: 'goals/resume',
    args: payload => ({ agentId: payload.sessionId, ref: payload.ref }),
    decode: identity,
  },
  'goal.complete': {
    endpoint: 'goals/complete',
    args: payload => ({ agentId: payload.sessionId, ref: payload.ref }),
    decode: identity,
  },
  'goal.clear': {
    endpoint: 'goals/clear',
    args: payload => ({ agentId: payload.sessionId, ref: payload.ref }),
    decode: () => ({ cleared: true as const }),
  },
  'settings.describe': {
    endpoint: 'settings/describe',
    args: () => ({}),
    decode: (value: unknown) => value as SettingsDescribeValue,
  },
  'settings.openDocument': {
    endpoint: 'settings/openSettingsDocument',
    args: () => ({}),
    decode: () => ({ opened: true as const }),
  },
  'settings.update': {
    endpoint: 'settings/update',
    args: payload => ({
      ns: payload.ns,
      patch: payload.patch,
      ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
    }),
    decode: (value: unknown) => value as SettingsNamespaceView,
  },
  'settings.replace': {
    endpoint: 'settings/replace',
    args: payload => ({
      ns: payload.ns,
      section: payload.section,
      ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
    }),
    decode: (value: unknown) => value as SettingsNamespaceView,
  },
  'settings.mutate': {
    endpoint: 'settings/mutate',
    args: payload => ({
      ns: payload.ns,
      ops: payload.ops,
      ...(payload.expectedRevision === undefined ? {} : { expectedRevision: payload.expectedRevision }),
    }),
    decode: (value: unknown) => value as SettingsNamespaceView,
  },
  'credentials.describe': {
    endpoint: 'credentials/describe',
    args: payload => ({ refs: payload.refs }),
    decode: (value: unknown) => value as { credentials: Record<string, CredentialInfo> },
  },
  'credentials.set': {
    endpoint: 'credentials/set',
    args: payload => ({ ref: payload.ref, value: payload.value }),
    decode: () => ({}),
  },
  'credentials.unset': {
    endpoint: 'credentials/unset',
    args: payload => ({ ref: payload.ref }),
    decode: () => ({}),
  },
  'llm.providers': {
    endpoint: 'llm/listConfigurableProviders',
    args: () => ({}),
    decode: (value: unknown) => ({
      providers: (value as { providers: readonly LlmConfigurableProvider[] }).providers.map(provider => ({
        provider: provider.provider,
        displayName: provider.displayName,
        settingsNs: provider.settingsNs,
        settingsPath: [...provider.settingsPath],
        // A provider reporting an error is declared but not routable; the
        // contract's `active` is exactly that distinction.
        active: provider.error === undefined,
        ...(provider.declared === undefined ? {} : { declared: provider.declared }),
      })),
    }),
  },
  'llm.discoverModels': {
    endpoint: 'llm/discoverModels',
    args: (payload) => {
      const { settingsNs, ...request } = payload
      return { settingsNs, request }
    },
    decode: (value: unknown) => value as { models: LlmDiscoveredModel[] },
  },
} satisfies { [K in Exclude<keyof RpcMethodMap, typeof DERIVED_METHODS[number]>]: UnaryMapping<K> }

/** One row key of {@link UNARY_ENDPOINTS}. */
export type UnaryMethod = keyof typeof UNARY_ENDPOINTS

/**
 * Look up one unary endpoint mapping.
 * @param method - contract method key.
 * @returns the mapping row.
 */
export function unaryMapping<K extends UnaryMethod>(method: K): UnaryMapping<K> {
  return UNARY_ENDPOINTS[method] as UnaryMapping<K>
}
