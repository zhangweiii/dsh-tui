import Schema from '@deepseek-ai/schemastery'
import { RpcId, type IApiClient, type RpcResponse } from '@deepseek-ai/dsh-host-apiproxy'
import { describe, expect, it, vi } from 'vitest'
import {
  commitProviderSetup, createProviderSetupDraft, CUSTOM_PROVIDER_VALUE, discoverProviderSetupModels,
  editProviderSetup, loadProviderSetupCatalog, providerProtocolChoices, providerSetupValidation, toggleProviderCandidate,
} from '../src/provider-setup.ts'

function ok<T>(value: T): Promise<RpcResponse<T>> {
  return Promise.resolve({ rpcId: RpcId('provider-test'), result: { ok: true, value } })
}

function piSchema(): unknown {
  const profile = Schema.object({
    displayName: Schema.string(),
    apiKeyEnv: Schema.string().role('credential-ref'),
    api: Schema.union(['openai-completions', 'anthropic-messages']),
    baseURL: Schema.string(),
    models: Schema.array(Schema.object({ id: Schema.string().required(), name: Schema.string() })),
  })
  return Schema.object({ providers: Schema.dict(profile).default({}) }).toJSON()
}

function fakeProviderApi(options: { credentialSetFails?: boolean } = {}) {
  const settingsMutate = vi.fn((request: { ns: string; expectedRevision: number }) => ok({
    ns: request.ns, schema: piSchema(), value: {}, user: {}, applies: 'live' as const,
    secrets: [], revision: request.expectedRevision + 1,
  }))
  const credentialSet = vi.fn(() => options.credentialSetFails
    ? Promise.resolve({
        rpcId: RpcId('credential-error'),
        result: { ok: false as const, error: { code: 'credential-rejected' as const, message: 'credential is read-only', details: {} } },
      })
    : ok({}))
  const api = {
    llm: {
      providers: vi.fn(() => ok({ providers: [
        {
          provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'llm-pi-ai',
          settingsPath: ['providers', 'anthropic'], active: false,
        },
        {
          provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs: 'llm-deepseek',
          settingsPath: [], active: true,
        },
      ] })),
      discoverModels: vi.fn(() => ok({ models: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000 }] })),
    },
    settings: {
      describe: vi.fn(() => ok({
        writable: true, hasDocument: true,
        namespaces: [
          {
            ns: 'llm-deepseek', schema: Schema.object({ apiKeyEnv: Schema.string(), baseURL: Schema.string() }).toJSON(),
            value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' },
            applies: 'live' as const, secrets: [], revision: 4,
          },
          {
            ns: 'llm-pi-ai', schema: piSchema(),
            value: { providers: { anthropic: { apiKeyEnv: 'TEAM_ANTHROPIC_KEY', baseURL: 'https://proxy.test' } } },
            user: { providers: { anthropic: { baseURL: 'https://proxy.test', untouched: true } } },
            applies: 'live' as const, secrets: [], revision: 9,
          },
        ],
      })),
      mutate: settingsMutate,
    },
    credentials: {
      describe: vi.fn(({ refs }: { refs: string[] }) => ok({
        credentials: Object.fromEntries(refs.map(ref => [ref, {
          configured: ref === 'DEEPSEEK_API_KEY', writable: true,
        }])),
      })),
      set: credentialSet,
    },
  } as unknown as IApiClient
  return { api, settingsMutate, credentialSet }
}

describe('provider setup Host join', () => {
  it('uses llm.providers settings addresses and DSH schema-form protocol choices', async () => {
    const fake = fakeProviderApi()
    const catalog = await loadProviderSetupCatalog(fake.api)

    expect(catalog.targets.map(target => ({
      provider: target.entry.provider, ns: target.namespace.ns, path: target.entry.settingsPath,
      ref: target.credentialRef, configured: target.credential?.configured,
    }))).toEqual([
      { provider: 'anthropic', ns: 'llm-pi-ai', path: ['providers', 'anthropic'], ref: 'TEAM_ANTHROPIC_KEY', configured: false },
      { provider: 'deepseek-official', ns: 'llm-deepseek', path: [], ref: 'DEEPSEEK_API_KEY', configured: true },
    ])
    expect(providerProtocolChoices(catalog.customNamespace)).toEqual(['openai-completions', 'anthropic-messages'])
  })

  it('materializes a dormant catalog profile for provider-native authentication', async () => {
    const fake = fakeProviderApi()
    const catalog = await loadProviderSetupCatalog(fake.api)
    const target = catalog.targets.find(item => item.entry.provider === 'anthropic')
    if (target === undefined) throw new Error('missing target')
    target.configured = false
    target.namespace.value = { providers: {} }
    const draft = createProviderSetupDraft(catalog, 'anthropic')

    const result = await commitProviderSetup(fake.api, draft)

    expect(result.done).toBe(true)
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai', expectedRevision: 9,
      ops: [{ op: 'set', path: ['providers', 'anthropic'], value: {} }],
    })
  })

  it('records a derived credential ref when a supported profile has none', async () => {
    const fake = fakeProviderApi()
    const catalog = await loadProviderSetupCatalog(fake.api)
    const target = catalog.targets.find(item => item.entry.provider === 'anthropic')
    if (target === undefined) throw new Error('missing target')
    target.credentialRef = 'ANTHROPIC_API_KEY'
    target.credentialRefNamed = false
    let draft = createProviderSetupDraft(catalog, 'anthropic')
    draft = editProviderSetup(draft, 'apiKey', 'secret-value')

    await commitProviderSetup(fake.api, draft)

    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai', expectedRevision: 9,
      ops: [{ op: 'set', path: ['providers', 'anthropic', 'apiKeyEnv'], value: 'ANTHROPIC_API_KEY' }],
    })
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'ANTHROPIC_API_KEY', value: 'secret-value' })
  })

  it('updates an existing provider with minimal path ops and its existing credential ref', async () => {
    const fake = fakeProviderApi()
    const catalog = await loadProviderSetupCatalog(fake.api)
    let draft = createProviderSetupDraft(catalog, 'anthropic')
    draft = editProviderSetup(draft, 'baseURL', 'https://new-proxy.test')
    draft = editProviderSetup(draft, 'apiKey', 'secret-value')

    const result = await commitProviderSetup(fake.api, draft)

    expect(result.done).toBe(true)
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai', expectedRevision: 9,
      ops: [{ op: 'set', path: ['providers', 'anthropic', 'baseURL'], value: 'https://new-proxy.test' }],
    })
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'TEAM_ANTHROPIC_KEY', value: 'secret-value' })
  })
})

describe('custom provider setup', () => {
  it('probes with the unsaved key and writes only to llm-pi-ai', async () => {
    const fake = fakeProviderApi()
    const catalog = await loadProviderSetupCatalog(fake.api)
    let draft = createProviderSetupDraft(catalog, CUSTOM_PROVIDER_VALUE)
    draft = editProviderSetup(draft, 'providerId', 'acme-gateway')
    draft = editProviderSetup(draft, 'baseURL', 'https://gateway.test/v1')
    draft = editProviderSetup(draft, 'api', 'openai-completions')
    draft = editProviderSetup(draft, 'apiKey', 'secret-value')
    draft = await discoverProviderSetupModels(fake.api, draft)

    expect(fake.api.llm.discoverModels).toHaveBeenCalledWith({
      settingsNs: 'llm-pi-ai', baseURL: 'https://gateway.test/v1', api: 'openai-completions', apiKey: 'secret-value',
    })
    expect(draft.candidates).toEqual([{ id: 'model-a', name: 'Model A', contextWindow: 128_000 }])
    expect(draft.selectedCandidates).toEqual(['model-a'])
    expect(providerSetupValidation(draft)).toBeUndefined()
    expect(providerSetupValidation(toggleProviderCandidate(draft, 'model-a'))).toContain('至少一个模型')

    const result = await commitProviderSetup(fake.api, draft)
    expect(result.done).toBe(true)
    expect(fake.settingsMutate).toHaveBeenCalledWith({
      ns: 'llm-pi-ai', expectedRevision: 9,
      ops: [{ op: 'set', path: ['providers', 'acme-gateway'], value: {
        apiKeyEnv: 'ACME_GATEWAY_API_KEY', api: 'openai-completions', baseURL: 'https://gateway.test/v1',
        models: [{ id: 'model-a', name: 'Model A', contextWindow: 128_000 }],
      } }],
    })
    expect(fake.credentialSet).toHaveBeenCalledWith({ ref: 'ACME_GATEWAY_API_KEY', value: 'secret-value' })
  })

  it('preserves a settings commit when credential storage fails so retry skips settings', async () => {
    const fake = fakeProviderApi({ credentialSetFails: true })
    const catalog = await loadProviderSetupCatalog(fake.api)
    let draft = createProviderSetupDraft(catalog, CUSTOM_PROVIDER_VALUE)
    draft = editProviderSetup(draft, 'providerId', 'acme-gateway')
    draft = editProviderSetup(draft, 'baseURL', 'https://gateway.test/v1')
    draft = editProviderSetup(draft, 'models', 'model-a')
    draft = editProviderSetup(draft, 'apiKey', 'secret-value')

    const first = await commitProviderSetup(fake.api, draft)
    expect(first.done).toBe(false)
    expect(first.draft.committed).toBe(true)
    expect(first.draft.error).toBe('credential is read-only')
    expect(fake.settingsMutate).toHaveBeenCalledTimes(1)

    await commitProviderSetup(fake.api, first.draft)
    expect(fake.settingsMutate).toHaveBeenCalledTimes(1)
    expect(fake.credentialSet).toHaveBeenCalledTimes(2)
  })
})
