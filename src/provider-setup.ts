/**
 * Progressive provider setup: joins the Host's provider/settings/credential
 * facts into a draft, validates and edits it field by field, and commits it
 * through the settings-mutation and credential seams. The renderer only sees
 * `providerSetupRows`; everything else is pure draft logic the tests drive
 * without a terminal.
 */
import {
  getPath, nodeAtPath, rehydrateSchema,
} from '@deepseek-ai/dsh-client-schema-form'
import type {
  ConfigurableProviderView, CredentialView, IApiClient,
  SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-host-apiproxy'
import { normalizeApiKey } from '@deepseek-ai/dsh-llm'

/** DSH namespace that owns hand-declared pi-ai provider routes. */
export const CUSTOM_PROVIDER_NAMESPACE = 'llm-pi-ai'
export const CUSTOM_PROVIDER_VALUE = '\u0000custom-provider'

/** Dict segments are value-insensitive in DSH schema-form; this impossible route only traverses `providers.*.api`. */
const PROBE_ROUTE = '\u0000probe'
const ROUTE_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export type ProviderSetupField = 'providerId' | 'displayName' | 'baseURL' | 'api' | 'apiKey' | 'models'

export interface ProviderSetupTarget {
  entry: ConfigurableProviderView
  namespace: SettingsNamespaceView
  configured: boolean
  credentialRef: string
  credentialRefNamed: boolean
  supportsCredentialRef: boolean
  credential: CredentialView | undefined
}

export interface ProviderSetupCatalog {
  writable: boolean
  targets: ProviderSetupTarget[]
  taken: string[]
  customNamespace: SettingsNamespaceView | undefined
  customProtocols: string[]
}

export interface ProviderModelDraft {
  id: string
  name?: string | undefined
  contextWindow?: number | undefined
  maxTokens?: number | undefined
}

export interface ProviderSetupDraft {
  kind: 'existing' | 'custom'
  namespace: string
  settingsPath: string[]
  revision: number
  providerId: string
  declared: boolean
  taken: string[]
  protocols: string[]
  displayName: string
  baseURL: string
  api: string
  apiKey: string
  models: ProviderModelDraft[]
  candidates: ProviderModelDraft[]
  selectedCandidates: string[]
  credentialRef: string
  credentialRefNamed: boolean
  supportsCredentialRef: boolean
  credentialConfigured: boolean
  profileConfigured: boolean
  dirty: ProviderSetupField[]
  committed: boolean
  busy: boolean
  error?: string | undefined
  applies: 'live' | 'restart'
}

export type ProviderSetupRow =
  | { kind: 'field'; field: ProviderSetupField; label: string; value?: string; secret?: boolean; required?: boolean; hint?: string }
  | { kind: 'candidate'; model: ProviderModelDraft; selected: boolean }
  | { kind: 'discover' }
  | { kind: 'save'; disabled: boolean }

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringField(value: unknown, key: string): string {
  const field = record(value)[key]
  return typeof field === 'string' ? field : ''
}

function modelsField(value: unknown): ProviderModelDraft[] {
  const models = record(value).models
  if (!Array.isArray(models)) return []
  return models.flatMap(item => {
    const model = record(item)
    if (typeof model.id !== 'string' || model.id.trim() === '') return []
    return [{
      id: model.id,
      ...(typeof model.name === 'string' ? { name: model.name } : {}),
      ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
      ...(typeof model.maxTokens === 'number' ? { maxTokens: model.maxTokens } : {}),
    }]
  })
}

/** Conventional reference used by DSH's Models surface for a newly typed key. */
export function providerCredentialRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

/** Read protocol choices from the adapter-owned schema through DSH's schema-form module. */
export function providerProtocolChoices(namespace: SettingsNamespaceView | undefined): string[] {
  if (namespace === undefined) return []
  const node = nodeAtPath(rehydrateSchema(namespace.schema), ['providers', PROBE_ROUTE, 'api'])
  if (node?.type !== 'union' || node.list === undefined) return []
  return node.list.map(entry => entry.value).filter((value): value is string => typeof value === 'string')
}

/** Join the three Host fact sources used by provider configuration. */
export async function loadProviderSetupCatalog(
  api: Pick<IApiClient, 'llm' | 'settings' | 'credentials'>,
): Promise<ProviderSetupCatalog> {
  const [providerResponse, settingsResponse] = await Promise.all([
    api.llm.providers({}), api.settings.describe({}),
  ])
  if (!providerResponse.result.ok) throw new Error(providerResponse.result.error.message)
  if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
  const namespaces = new Map(settingsResponse.result.value.namespaces.map(namespace => [namespace.ns, namespace]))
  const joined = providerResponse.result.value.providers.flatMap(entry => {
    const namespace = namespaces.get(entry.settingsNs)
    if (namespace === undefined) return []
    const profile = getPath(namespace.value, entry.settingsPath)
    const namedRef = stringField(profile, 'apiKeyEnv')
    return [{
      entry, namespace,
      configured: entry.settingsPath.length === 0 || profile !== undefined,
      credentialRef: namedRef || providerCredentialRef(entry.provider),
      credentialRefNamed: namedRef !== '',
      supportsCredentialRef: nodeAtPath(rehydrateSchema(namespace.schema), [...entry.settingsPath, 'apiKeyEnv']) !== undefined,
    }]
  })
  const refs = [...new Set(joined.map(item => item.credentialRef))]
  let credentials: Record<string, CredentialView> = {}
  if (refs.length > 0) {
    const response = await api.credentials.describe({ refs })
    if (response.result.ok) credentials = response.result.value.credentials
  }
  const customNamespace = namespaces.get(CUSTOM_PROVIDER_NAMESPACE)
  return {
    writable: settingsResponse.result.value.writable,
    targets: joined.map(item => ({ ...item, credential: credentials[item.credentialRef] })),
    taken: providerResponse.result.value.providers.map(entry => entry.provider),
    customNamespace,
    customProtocols: providerProtocolChoices(customNamespace),
  }
}

export function createProviderSetupDraft(catalog: ProviderSetupCatalog, picked: string): ProviderSetupDraft {
  if (!catalog.writable) throw new Error('当前 settings provider 只读')
  if (picked === CUSTOM_PROVIDER_VALUE) {
    const namespace = catalog.customNamespace
    if (namespace === undefined) throw new Error('当前 Host 未挂载 llm-pi-ai，不能声明自定义 provider')
    if (catalog.customProtocols.length === 0) throw new Error('llm-pi-ai 未声明可用协议')
    return {
      kind: 'custom', namespace: namespace.ns, settingsPath: ['providers'], revision: namespace.revision,
      providerId: '', declared: true, taken: catalog.taken, protocols: catalog.customProtocols,
      displayName: '', baseURL: '', api: catalog.customProtocols[0] ?? '', apiKey: '', models: [],
      candidates: [], selectedCandidates: [], credentialRef: '', credentialRefNamed: false, supportsCredentialRef: true,
      credentialConfigured: false, profileConfigured: false,
      dirty: [], committed: false, busy: false, applies: namespace.applies,
    }
  }
  const target = catalog.targets.find(item => item.entry.provider === picked)
  if (target === undefined) throw new Error(`未知 provider：${picked}`)
  const profile = getPath(target.namespace.value, target.entry.settingsPath)
  return {
    kind: 'existing', namespace: target.namespace.ns, settingsPath: [...target.entry.settingsPath],
    revision: target.namespace.revision, providerId: target.entry.provider,
    declared: target.entry.declared === true, taken: catalog.taken,
    protocols: target.namespace.ns === CUSTOM_PROVIDER_NAMESPACE ? providerProtocolChoices(target.namespace) : [],
    displayName: stringField(profile, 'displayName'), baseURL: stringField(profile, 'baseURL'),
    api: stringField(profile, 'api'), apiKey: '', models: modelsField(profile), candidates: [], selectedCandidates: [],
    credentialRef: target.credentialRef, credentialRefNamed: target.credentialRefNamed,
    supportsCredentialRef: target.supportsCredentialRef, credentialConfigured: target.credential?.configured === true,
    profileConfigured: target.configured, dirty: [], committed: false, busy: false, applies: target.namespace.applies,
  }
}

function effectiveModels(draft: ProviderSetupDraft): ProviderModelDraft[] {
  const models = new Map(draft.models.map(model => [model.id, model]))
  for (const candidate of draft.candidates) {
    if (draft.selectedCandidates.includes(candidate.id)) models.set(candidate.id, models.get(candidate.id) ?? candidate)
  }
  return [...models.values()]
}

function fieldValue(draft: ProviderSetupDraft, field: ProviderSetupField): string {
  if (field === 'models') return effectiveModels(draft).map(model => model.id).join(', ')
  return draft[field]
}

function providerApiKeyError(apiKey: string): string | undefined {
  if (apiKey === '') return undefined
  const checked = normalizeApiKey(apiKey)
  if (checked.ok) return undefined
  return checked.reason === 'empty' ? 'API Key 不能为空' : 'API Key 含有 HTTP 标头不允许的字符'
}

export function providerSetupFieldError(
  draft: ProviderSetupDraft, field: ProviderSetupField,
): string | undefined {
  if (field === 'providerId' && draft.kind === 'custom') {
    if (!ROUTE_PATTERN.test(draft.providerId)) return 'Provider ID 必须以小写字母开头，只能包含小写字母、数字和单个连字符段'
    if (draft.taken.includes(draft.providerId)) return `Provider ${draft.providerId} 已存在`
  }
  if (field === 'baseURL' && draft.kind === 'custom' && draft.baseURL.trim() === '') return '自定义 provider 需要 Base URL'
  if (field === 'api' && draft.kind === 'custom' && !draft.protocols.includes(draft.api)) return '请选择 Host schema 声明的 API 协议'
  if (field === 'apiKey') return providerApiKeyError(draft.apiKey)
  if (field === 'models') {
    const ids = effectiveModels(draft).map(model => model.id.trim())
    if (ids.some(id => id === '')) return '模型 ID 不能为空'
    if (new Set(ids).size !== ids.length) return '模型 ID 不能重复'
  }
  return undefined
}

export function providerSetupValidation(draft: ProviderSetupDraft): string | undefined {
  for (const field of ['providerId', 'baseURL', 'api', 'apiKey', 'models'] as const) {
    const error = providerSetupFieldError(draft, field)
    if (error !== undefined) return error
  }
  if (draft.kind === 'custom' && effectiveModels(draft).length === 0) return '请手工填写或探测并选择至少一个模型'
  return undefined
}

/** Rows are the provider-setup module's interface to any terminal renderer. */
export function providerSetupRows(draft: ProviderSetupDraft): ProviderSetupRow[] {
  const fields: Array<{ field: ProviderSetupField; label: string; required?: boolean; secret?: boolean; hint?: string }> = draft.kind === 'custom'
    ? [
        { field: 'providerId', label: 'Provider ID', required: true, hint: '例如 acme-gateway' },
        { field: 'displayName', label: '显示名称' },
        { field: 'baseURL', label: 'Base URL', required: true },
        { field: 'api', label: 'API 协议', required: true, hint: draft.protocols.join(' / ') },
        { field: 'apiKey', label: 'API Key', secret: true },
        { field: 'models', label: '模型 ID', required: true, hint: '逗号分隔；也可使用下方探测' },
      ]
    : [
        ...draft.supportsCredentialRef ? [{
          field: 'apiKey' as const, label: 'API Key', secret: true,
          hint: draft.credentialConfigured ? '已配置；留空保持不变' : '未配置',
        }] : [],
        { field: 'baseURL', label: 'Base URL' },
        ...draft.declared ? [
          { field: 'displayName' as const, label: '显示名称' },
          { field: 'api' as const, label: 'API 协议', hint: draft.protocols.join(' / ') },
          { field: 'models' as const, label: '模型 ID', hint: '逗号分隔' },
        ] : [],
      ]
  const rows: ProviderSetupRow[] = fields.map(field => {
    const raw = fieldValue(draft, field.field)
    return {
      kind: 'field', ...field,
      ...(raw === '' ? {} : { value: field.secret ? '••••••（已输入）' : raw }),
    }
  })
  rows.push({ kind: 'discover' })
  for (const model of draft.candidates) {
    rows.push({ kind: 'candidate', model, selected: draft.selectedCandidates.includes(model.id) })
  }
  rows.push({ kind: 'save', disabled: providerSetupValidation(draft) !== undefined || draft.busy })
  return rows
}

export function editProviderSetup(
  draft: ProviderSetupDraft, field: ProviderSetupField, text: string,
): ProviderSetupDraft {
  const value = text.trim()
  const dirty = draft.dirty.includes(field) ? draft.dirty : [...draft.dirty, field]
  if (field === 'models') {
    const models = [...new Set(value.split(',').map(id => id.trim()).filter(Boolean))].map(id => ({ id }))
    return { ...draft, models, selectedCandidates: [], dirty, error: undefined }
  }
  const next = { ...draft, [field]: value, dirty, error: undefined }
  if (field === 'providerId') next.credentialRef = value === '' ? '' : providerCredentialRef(value)
  return next
}

export function toggleProviderCandidate(draft: ProviderSetupDraft, modelId: string): ProviderSetupDraft {
  const selected = new Set(draft.selectedCandidates)
  if (!selected.delete(modelId)) selected.add(modelId)
  const dirty = draft.dirty.includes('models') ? draft.dirty : [...draft.dirty, 'models' as const]
  return { ...draft, selectedCandidates: [...selected], dirty, error: undefined }
}

export async function discoverProviderSetupModels(
  api: Pick<IApiClient, 'llm'>, draft: ProviderSetupDraft,
): Promise<ProviderSetupDraft> {
  const keyError = providerApiKeyError(draft.apiKey)
  if (keyError !== undefined) return { ...draft, busy: false, error: keyError }
  if (draft.kind === 'custom' && draft.baseURL === '') {
    return { ...draft, busy: false, error: '请先填写 Base URL 再探测模型' }
  }
  if (draft.kind === 'custom' && !draft.protocols.includes(draft.api)) {
    return { ...draft, busy: false, error: '请先选择 Host schema 声明的 API 协议' }
  }
  const response = await api.llm.discoverModels({
    settingsNs: draft.namespace,
    ...(draft.kind === 'existing' ? { provider: draft.providerId } : {}),
    ...(draft.baseURL === '' ? {} : { baseURL: draft.baseURL }),
    ...(draft.api === '' ? {} : { api: draft.api }),
    ...(draft.apiKey === '' ? {} : { apiKey: draft.apiKey }),
  })
  if (!response.result.ok) return { ...draft, busy: false, error: response.result.error.message }
  const candidates = response.result.value.models.map(model => ({ ...model }))
  if (candidates.length === 0) return { ...draft, busy: false, error: '端点未返回模型' }
  const known = new Set(draft.models.map(model => model.id))
  const selectedCandidates = candidates.filter(model => !known.has(model.id)).map(model => model.id)
  const dirty = draft.dirty.includes('models') ? draft.dirty : [...draft.dirty, 'models' as const]
  return { ...draft, candidates, selectedCandidates, dirty, busy: false, error: undefined }
}

function setOp(path: readonly string[], key: string, value: unknown): SettingsPathOpView {
  return { op: 'set', path: [...path, key], value }
}

function existingOps(draft: ProviderSetupDraft): SettingsPathOpView[] {
  const ops: SettingsPathOpView[] = []
  for (const field of draft.dirty) {
    if (field === 'apiKey' || field === 'providerId') continue
    if (field === 'models') ops.push(setOp(draft.settingsPath, 'models', effectiveModels(draft).map(model => ({ ...model }))))
    else if (draft[field] === '') ops.push({ op: 'unset', path: [...draft.settingsPath, field] })
    else ops.push(setOp(draft.settingsPath, field, draft[field]))
  }
  if (draft.apiKey !== '' && draft.supportsCredentialRef && !draft.credentialRefNamed) {
    ops.push(setOp(draft.settingsPath, 'apiKeyEnv', draft.credentialRef))
  }
  if (ops.length === 0 && !draft.profileConfigured && draft.settingsPath.length > 0) {
    ops.push({ op: 'set', path: [...draft.settingsPath], value: {} })
  }
  return ops
}

export interface ProviderSetupCommit {
  draft: ProviderSetupDraft
  done: boolean
  notice?: string | undefined
}

/** Persist through DSH settings/credentials seams, preserving partial-commit retry state. */
export async function commitProviderSetup(
  api: Pick<IApiClient, 'settings' | 'credentials'>, draft: ProviderSetupDraft,
): Promise<ProviderSetupCommit> {
  const failure = providerSetupValidation(draft)
  if (failure !== undefined) return { draft: { ...draft, busy: false, error: failure }, done: false }
  let next = { ...draft, busy: true, error: undefined }
  if (!next.committed) {
    const ops: SettingsPathOpView[] = next.kind === 'custom'
      ? [{
          op: 'set', path: [...next.settingsPath, next.providerId], value: {
            ...(next.displayName === '' ? {} : { displayName: next.displayName }),
            ...(next.apiKey === '' ? {} : { apiKeyEnv: next.credentialRef }),
            api: next.api, baseURL: next.baseURL, models: effectiveModels(next).map(model => ({ ...model })),
          },
        }]
      : existingOps(next)
    if (ops.length > 0) {
      const response = await api.settings.mutate({ ns: next.namespace, ops, expectedRevision: next.revision })
      if (!response.result.ok) return { draft: { ...next, busy: false, error: response.result.error.message }, done: false }
      next = {
        ...next, revision: response.result.value.revision, applies: response.result.value.applies,
        committed: true, profileConfigured: true,
        dirty: next.dirty.filter(field => field === 'apiKey'),
      }
    } else {
      next = { ...next, committed: true }
    }
  }
  if (next.apiKey !== '') {
    const response = await api.credentials.set({ ref: next.credentialRef, value: next.apiKey })
    if (!response.result.ok) return { draft: { ...next, busy: false, error: response.result.error.message }, done: false }
    next = { ...next, apiKey: '', credentialConfigured: true, dirty: next.dirty.filter(field => field !== 'apiKey') }
  }
  return {
    draft: { ...next, busy: false }, done: true,
    notice: `${next.kind === 'custom' ? '已新增' : '已更新'} provider ${next.providerId}${next.applies === 'restart' ? '（重启后生效）' : ''}`,
  }
}

export interface ProviderAddArgs {
  providerId: string
  displayName?: string | undefined
  baseURL?: string | undefined
  api?: string | undefined
  keyEnvironment?: string | undefined
  models: string[]
  discover: boolean
}

/** Strict non-interactive syntax; secret values are read from an environment name. */
export function parseProviderAddArgs(input: string): ProviderAddArgs {
  const tokens = input.split(/\s+/).filter(Boolean)
  const args: ProviderAddArgs = { providerId: '', models: [], discover: false }
  let index = 0
  const take = (name: string): string => {
    const result = tokens[index + 1]
    if (result === undefined || result.startsWith('--')) throw new Error(`缺少 --${name} 的参数`)
    index += 2
    return result
  }
  while (index < tokens.length) {
    const token = tokens[index] as string
    switch (token) {
      case '--name': args.displayName = take('name'); break
      case '--base-url': args.baseURL = take('base-url'); break
      case '--api': args.api = take('api'); break
      case '--key-env': args.keyEnvironment = take('key-env'); break
      case '--model': args.models.push(take('model')); break
      case '--discover': args.discover = true; index += 1; break
      default:
        if (token.startsWith('--') || args.providerId !== '') throw new Error(`无法识别的参数：${token}`)
        args.providerId = token
        index += 1
    }
  }
  return args
}

