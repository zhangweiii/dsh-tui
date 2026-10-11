# DSH 0.2.0-rc.2 Host protocol — external Node client reference

Evidence base: `@deepseek-ai/dsh@0.2.0-rc.2`, `@deepseek-ai/cordis@4.0.4`, Node v24.21.0.
Host under test: `/tmp/dshref-02`, launched `DSH_HOME=/tmp/probe-home node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3199 --no-open` → `dsh web: http://127.0.0.1:3199/?token=sylmmaVeqU2xJeXTOx8DQXzN_nG-vlRElYDif2UabN4`.
Probe scripts and full raw transcripts: `/tmp/probe/*.mjs`, `/tmp/probe/*.out` (listed in §8).
Everything quoted below was observed live; statements taken from package source instead are labelled **[source-derived]**.

## 0. Corrections to the briefing's stated assumptions

1. **`session/follow` args are not `{sessionId}`.** Correct args: `{"request":{"address":{"kind":"session","sessionId":"…"}}}`; the wrong shape was rejected `gateway/input-invalid` ("wire field \"request\" failed boundary validation"). `address` is the union `{kind:'session',sessionId}` | `{kind:'subagent',parentSessionId,childSessionId,mode}`.
2. **`job/list` is per-session, not global.** Requires `{"request":{"sessionId":"…"}}`; first frame is `{"type":"rows","jobs":[]}`. An empty `request:{}` is rejected (`gateway/input-invalid`), a missing `request` is rejected (`gateway/arguments-invalid`).
3. **`session/control` takes empty args `{}`** and is WebSocket-only; over HTTP it answers `gateway/signature-invalid` ("stream Remote methods must be opened through the stream carrier"). Conversely a unary endpoint opened over the WS mux answers `gateway/signature-invalid` ("unary Remote methods cannot be opened through the stream carrier").
4. **`$events` `ready.host` is the OS account home** (`{home:"/home/node"}` in this container), not `DSH_HOME`. `clientId` is a fresh UUID per stream generation.
5. **The launch token is not persisted** anywhere under `$DSH_HOME` (grep found no trace); it is per-process random. However the **cookie signing secret is persisted** in `$DSH_HOME/.credentials.yaml`, so a local Node client that can read that file can mint its own auth cookie without the token — verified live (§6).
6. **A prompt with no model credentials still exercises the whole stream machinery.** `session/prompt` → `{"ok":true,"value":{"accepted":true}}`; then `session/follow`/`session/control`/`$events` delivered `agent/inbox/spliced`, `turn/start`, `step/start`, `system/message`, `user/message`, `request/header`, `request/context`, `assistant-stream start/chunk/end`, `session/title`, `step/end`, `turn/end`, plus emits `api-session/status`, `api-session/activity`, `api-session/error`; the assistant chunk carried `{"type":"finish","reason":{"kind":"error","failure":{"code":"MISSING_CREDENTIAL", …}}}`. No waterfall fired (see §5).
7. **Wire `args` are exact-match**: unknown field → `gateway/arguments-invalid: args fields do not match the descriptor: unexpected "extra"`; missing field → `… missing "request"`. A parameter typed `X | undefined` in the generated client face may be omitted (verified: `settings/mutate` without `expectedRevision` reached business logic, §2). The `signal` cancellation parameter is never a wire field.
8. **`skills/list` is not a lookup endpoint**; it takes `{"request":{"sessionId":"…"}}`. Lookup-parameter endpoints in the brief's list: `commands/list`, `goals/*`, `fileReferences/list`, `userQuestions/*`, `agentPresets/select`, `terminal/follow`. See §3.
9. **`settings/describe` takes no args (`{}`)**; passing `{"ns":"…"}` is rejected `unexpected "ns"`. It returns *all* namespaces in one value.
10. `session/list`'s single parameter is literally named `_request` (underscore) and it is **required** (`{}` → `missing "_request"`), even though its only field `cursor` is optional.


## 1. Transport

### 1.1 HTTP RPC (unary endpoints)

* `POST http://<authority>/api/<namespace>/<method>`; the URL path endpoint must equal the envelope `method`.
* Required headers: `Host` (protocol-level for HTTP/1.1), `content-type: application/json` (otherwise `415 content type must be application/json`), auth cookie (see §6).
* Request envelope: `{"type":"client-request","rpcId":"<any unique string>","method":"<endpoint>","payload":{"args":{…}}}`.
* Response envelope: `{"type":"server-response","rpcId":"<same>","result":{"ok":true,"value":…}}` or `{"ok":false,"error":{"code":…,"message":…,"details":{…}}}`. HTTP status is **200 even for logical errors**. A malformed envelope → 400-ish plain text; mismatched method/URL → `gateway/bad-request`.
* Error codes observed: `gateway/arguments-invalid` (top-level args fields), `gateway/input-invalid` (nested wire validation), `gateway/signature-invalid` (wrong carrier), `gateway/bad-request`, `gateway/internal`, `session/not-found`, `settings/rejected`.

### 1.2 WebSocket logical-stream mux

* One physical socket at `ws://<authority>/api/remote.mux` carries *all* logical streams (unary calls stay on HTTP). Upgrade is admitted exactly like `/api` HTTP (Host fence + cookie); no Origin required, but a cross-origin `Origin` or `sec-fetch-site: cross-site` is refused (403), and no cookie → `401 unauthorized` (§4).
* Client→host text messages (`stream-protocol.d.ts` `RemoteStreamClientMessage`, verified live):
  * `{"type":"open","streamId":"<unique>","endpoint":"<endpoint>","payload":{"args":{…}}}` — opens one logical stream (same args object as HTTP).
  * `{"type":"item","streamId":"…","value":…}` — uplink item (for logical streams that have an uplink; `value` optional).
  * `{"type":"end","streamId":"…"}` — half-close uplink.
  * `{"type":"cancel","streamId":"…"}` — cancel the logical stream.
* Host→client text messages (`RemoteStreamServerMessage`):
  * `{"type":"item","streamId":"…","value":<frame>}` — one frame.
  * `{"type":"error","streamId":"…","error":{"code":…,"message":…,"details":{…}}}` — logical failure (stream may stay open): observed `{"code":"gateway/input-invalid",…}` for bad args and `{"code":"gateway/signature-invalid",…}` for unary-over-mux.
  * `{"type":"end","streamId":"…"}` — logical stream finished (observed on `userQuestions/attachWait` when there is no pending question).
* Faults: opening a second stream under an already-active `streamId` closes the socket with WS close `1008 "invalid Remote stream request"`; an unparsable message does the same. Default heartbeat 2000 ms and 262144-byte in-flight budget **[source-derived]** (`dsh-api-gateway/lib/index.js` constants `DEFAULT_WEBSOCKET_HEARTBEAT_INTERVAL_MS`, `DEFAULT_STREAM_INBOX_BYTES`).
* Verified live: `end` on `session/control` is accepted silently (the host simply stops sending; no `end` frame is echoed); `cancel` likewise stops delivery.

## 2. Endpoint wire shapes (question 1)

Generated from `/tmp/apidump/invocations.json` (host-face descriptors) cross-checked against each package's generated client face `lib/typert.remote-client.d.ts` and the type files `lib/types/*.d.ts`.
Reading the blocks:

* `client-face signature` — the generated TS call signature (param names = wire fields). Result wrapped in `RemoteResult<T>` for unary, `RemoteStreamHandle<T, never>` for streams.
* `wire args` — the **exact** JSON `payload.args` object accepted; every listed field must be present unless its type is `X | undefined`/optional (`?`), in which case omission is valid (tested for `settings/mutate`).
* The `// arg/value type …` blocks inline the declaration of each arg type and the result/frame type. More nested types are in the Appendix (full `lib/types/*.d.ts` excerpts).
* `— **stream (WebSocket only)**` marks logical streams: these must be opened over `/api/remote.mux`; all others are HTTP unary RPCs.

Optional-parameter evidence (probe6.out):

```
>>> settings/mutate omit expectedRevision
<<< {"type":"server-response","rpcId":"xmlk2dg","result":{"ok":false,"error":{"code":"settings/rejected","message":"No configurable plugin entry \"no-such-ns\"","details":{"ns":"no-such-ns"}}}}
>>> settings/describe with ns
<<< {"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: settings/describe: args fields do not match the descriptor: unexpected \"ns\"","details":{"endpoint":"settings/describe"}}}
```

(i.e. `expectedRevision` may be omitted because its client-face type is `number | undefined`; `settings/describe` takes no args at all.)



### `session/list`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/list`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/list': (_request: SessionListRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionListValue>>
```
wire args: `{"_request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionListValue` (result.mode `strict`)
// arg/value type SessionListRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionListRequest {
    readonly cursor?: string;
}
```
// arg/value type SessionListValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionListValue {
    readonly items: readonly SessionSummary[];
}
```

### `session/search`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/search`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/search': (request: SessionSearchRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionSearchValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionSearchValue` (result.mode `strict`)
// arg/value type SessionSearchRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionSearchRequest {
    readonly query: string;
}
```
// arg/value type SessionSearchValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionSearchValue {
    readonly items: readonly SessionSearchItem[];
    readonly hasMore: boolean;
}
```

### `session/create`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/create`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/create': (request: SessionCreateRequest) => Promise<RemoteResult<SessionCreateValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionCreateValue` (result.mode `strict`)
// arg/value type SessionCreateRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionCreateRequest {
    readonly workspaceId?: WorkspaceId;
    readonly cwd?: string;
    readonly sessionId?: SessionId;
    readonly agentPreset?: string;
}
```
// arg/value type SessionCreateValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionCreateValue {
    readonly sessionId: SessionId;
    readonly agentPreset?: string;
}
```

### `session/rename`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/rename`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/rename': (request: SessionRenameRequest) => Promise<RemoteResult<SessionRenameValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionRenameValue` (result.mode `strict`)
// arg/value type SessionRenameRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionRenameRequest {
    readonly sessionId: SessionId;
    readonly title: string;
}
```
// arg/value type SessionRenameValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionRenameValue {
    readonly title: string;
    readonly seq: number;
}
```

### `session/fork`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/fork`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/fork': (request: SessionForkRequest) => Promise<RemoteResult<SessionForkValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionForkValue` (result.mode `strict`)
// arg/value type SessionForkRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionForkRequest {
    readonly sessionId: SessionId;
    /** Exact inclusive source event seq; omission selects the latest completed-turn prefix. */
    readonly atSeq?: number;
}
```
// arg/value type SessionForkValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionForkValue {
    readonly sessionId: SessionId;
}
```

### `session/prompt`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/prompt`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/prompt': (request: SessionPromptRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionPromptValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionPromptValue` (result.mode `strict`)
// arg/value type SessionPromptRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionPromptRequest {
    /** Client-minted identity persisted on the exact accepted user message. */
    readonly requestId: SessionRequestId;
    readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';
    /** At least one non-whitespace text part or attachment. */
    readonly content: readonly PromptContentPart[];
    readonly clientTimeZone?: string;
}
```
// arg/value type SessionPromptValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionPromptValue {
    readonly accepted: true;
}
```

### `session/cancel`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/cancel`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/cancel': (request: SessionCancelRequest) => Promise<RemoteResult<SessionCancelValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionCancelValue` (result.mode `strict`)
// arg/value type SessionCancelRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionCancelRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type SessionCancelValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionCancelValue {
    readonly accepted: true;
}
```

### `session/attachment`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/attachment`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/attachment': (request: SessionAttachmentRequest) => Promise<RemoteResult<SessionAttachmentValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionAttachmentValue` (result.mode `strict`)
// arg/value type SessionAttachmentRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionAttachmentRequest {
    readonly sessionId: SessionId;
    readonly attachmentId: AttachmentIdType;
}
```
// arg/value type SessionAttachmentValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionAttachmentValue {
    readonly attachment: ImageAttachmentRef;
    readonly data: string;
}
```

### `session/updateQueue`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/updateQueue`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/updateQueue': (request: SessionUpdateQueueRequest) => Promise<RemoteResult<SessionUpdateQueueValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionUpdateQueueValue` (result.mode `strict`)
// arg/value type SessionUpdateQueueRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionUpdateQueueRequest {
    readonly sessionId: SessionId;
    readonly itemId: MessageId;
    readonly action: QueueAction;
}
```
// arg/value type SessionUpdateQueueValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionUpdateQueueValue {
    readonly accepted: true;
}
```

### `session/page`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/page`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/page': (request: SessionPageRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionPage>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionPage` (result.mode `strict`)
// arg/value type SessionPageRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionPageRequest {
    readonly address: SessionAddress;
    /** Inclusive log cut obtained from the corresponding follow opening frame. */
    readonly throughSeq: number;
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
    /** Stop at a Turn start after both minima, unless maxMessages or history exhaustion wins. */
    readonly turnWindow?: {
        /** Minimum append-origin user/assistant messages; must not exceed maxMessages. */
        readonly minMessages: number;
        /** Minimum Turn starts crossed, including the partial Turn at beforeSeq. */
        readonly minTurns: number;
    };
}
```
// arg/value type SessionPage  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionPage {
    readonly records: readonly SessionHistoryRecord[];
    readonly hasMore: boolean;
}
```

### `session/projections`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/projections`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/projections': (request: SessionProjectionsRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionProjectionsValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionProjectionsValue` (result.mode `strict`)
// arg/value type SessionProjectionsRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionProjectionsRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type SessionProjectionsValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export type SessionProjectionsValue = SessionProjectionBaseline | null;
```

### `session/modelCatalog`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/modelCatalog`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/modelCatalog': () => Promise<RemoteResult<ModelCatalog>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#ModelCatalog` (result.mode `strict`)
// arg/value type ModelCatalog  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface ModelCatalog {
    readonly default: ModelSelection;
    /** Provider routes with at least one currently available catalog model. */
    readonly routableProviders: readonly string[];
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}
```

### `session/selectModel`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/selectModel`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/selectModel': (request: SessionSelectModelRequest) => Promise<RemoteResult<SessionSelectModelValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionSelectModelValue` (result.mode `strict`)
// arg/value type SessionSelectModelRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionSelectModelRequest extends ModelSelection {
    readonly sessionId: SessionId;
}
```
// arg/value type SessionSelectModelValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionSelectModelValue {
    readonly selected: ModelSelection;
}
```

### `session/openWorkspacePath`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/openWorkspacePath`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/openWorkspacePath': (request: SessionOpenWorkspacePathRequest, signal?: AbortSignal) => Promise<RemoteResult<SessionOpenWorkspacePathValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionOpenWorkspacePathValue` (result.mode `strict`)
// arg/value type SessionOpenWorkspacePathRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionOpenWorkspacePathRequest {
    /** File-manager navigation when requested; omission uses the default application. */
    readonly action?: 'reveal';
    /** Registered application identifier; ignored for reveal. Omission preserves the operating system default. */
    readonly application?: string;
    /** Path after best-effort Session workspace resolution, in Host filesystem syntax. */
    readonly path: string;
}
```
// arg/value type SessionOpenWorkspacePathValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionOpenWorkspacePathValue {
    readonly opened: true;
}
```

### `session/canOpenWorkspacePath`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/canOpenWorkspacePath`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/canOpenWorkspacePath': () => Promise<RemoteResult<boolean>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller#session/canOpenWorkspacePath:result` (result.mode `strict`)

### `session/workspacePathApplications`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/workspacePathApplications`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/workspacePathApplications': (request: { readonly path: string; }, signal?: AbortSignal) => Promise<RemoteResult<readonly SessionWorkspacePathApplication[]>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller#session/workspacePathApplications:result` (result.mode `strict`)
// type `readonly` — no named declaration found (inline/generated); see client signature above

### `session/initializeDefaultModel`
descriptor: `@deepseek-ai/dsh-api-session-controller#session/initializeDefaultModel`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'session/initializeDefaultModel': () => Promise<RemoteResult<void>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller#session/initializeDefaultModel:result` (result.mode `strict`)

### `skills/list`
descriptor: `@deepseek-ai/dsh-api-session-controller#skills/list`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'skills/list': (request: SkillListRequest, signal?: AbortSignal) => Promise<RemoteResult<SkillListValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SkillListValue` (result.mode `strict`)
// arg/value type SkillListRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SkillListRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type SkillListValue  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SkillListValue {
    readonly skills: readonly SkillEntry[];
}
```

### `agentPresets/list`
descriptor: `@deepseek-ai/dsh-agent-preset-registry#agentPresets/list`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'agentPresets/list': () => Promise<RemoteResult<AgentPresetRoster>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-agent-preset-registry/types#AgentPresetRoster` (result.mode `strict`)
// arg/value type AgentPresetRoster  —  file: dsh-agent-preset-registry/lib/types/types.d.ts
```ts
export interface AgentPresetRoster {
    /** Every current declaration, including activation failures. */
    readonly presets: readonly AgentPresetRow[];
}
```

### `agentPresets/read`
descriptor: `@deepseek-ai/dsh-agent-preset-registry#agentPresets/read`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'agentPresets/read': (agentPreset: string) => Promise<RemoteResult<AgentPresetDocument>>
```
wire args: `{"agentPreset": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-agent-preset-registry/types#AgentPresetDocument` (result.mode `strict`)
// arg/value type AgentPresetDocument  —  file: dsh-agent-preset-registry/lib/types/types.d.ts
```ts
export interface AgentPresetDocument {
    /** The preset the composition belongs to. */
    readonly agentPreset: string;
    /** The declared child plugin list as entry-list YAML, `!!js` expressions included. */
    readonly content: string;
    /** Display name the preset published. */
    readonly name?: string;
    /** One sentence on what this preset is for. */
    readonly description?: string;
}
```

### `agentPresets/select`
descriptor: `@deepseek-ai/dsh-agent-preset-registry#agentPresets/select`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'agentPresets/select': (agentId: SessionId, agentPreset: string) => Promise<RemoteResult<string>>
```
wire args: `{"agentId": …, "agentPreset": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-agent-preset-registry#agentPresets/select:result` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```

### `workspace/create`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/create`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/create': (request: WorkspaceCreateRequest) => Promise<RemoteResult<WorkspaceCreateValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceCreateValue` (result.mode `strict`)
// arg/value type WorkspaceCreateRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceCreateRequest {
    readonly path: string;
}
```
// arg/value type WorkspaceCreateValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceCreateValue {
    readonly workspace: WorkspaceView;
    readonly created: boolean;
}
```

### `workspace/rename`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/rename`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/rename': (request: WorkspaceRenameRequest) => Promise<RemoteResult<WorkspaceValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceValue` (result.mode `strict`)
// arg/value type WorkspaceRenameRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceRenameRequest {
    readonly workspaceId: WorkspaceId;
    readonly title: string;
}
```
// arg/value type WorkspaceValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceValue {
    readonly workspace: WorkspaceView;
}
```

### `workspace/delete`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/delete`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/delete': (request: WorkspaceDeleteRequest) => Promise<RemoteResult<WorkspaceDeleteValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceDeleteValue` (result.mode `strict`)
// arg/value type WorkspaceDeleteRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceDeleteRequest {
    readonly workspaceId: WorkspaceId;
}
```
// arg/value type WorkspaceDeleteValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceDeleteValue {
    readonly deleted: true;
}
```

### `workspace/insertBefore`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/insertBefore`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/insertBefore': (request: WorkspaceInsertBeforeRequest) => Promise<RemoteResult<WorkspaceOrderValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceOrderValue` (result.mode `strict`)
// arg/value type WorkspaceInsertBeforeRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceInsertBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly beforeWorkspaceId?: WorkspaceId;
}
```
// arg/value type WorkspaceOrderValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceOrderValue {
    readonly workspaceIds: readonly WorkspaceId[];
}
```

### `workspace/insertSessionBefore`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/insertSessionBefore`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/insertSessionBefore': (request: WorkspaceInsertSessionBeforeRequest) => Promise<RemoteResult<WorkspaceValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceValue` (result.mode `strict`)
// arg/value type WorkspaceInsertSessionBeforeRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceInsertSessionBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly sessionId: SessionId;
    readonly beforeSessionId?: SessionId;
}
```
// arg/value type WorkspaceValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceValue {
    readonly workspace: WorkspaceView;
}
```

### `workspace/archiveSession`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/archiveSession`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/archiveSession': (request: WorkspaceArchiveSessionRequest) => Promise<RemoteResult<WorkspaceArchiveValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceArchiveValue` (result.mode `strict`)
// arg/value type WorkspaceArchiveSessionRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceArchiveSessionRequest {
    readonly sessionId: SessionId;
    /**
     * Stop the Session's running work — its turn, subagent descendants, owned
     * background jobs, and active schedules — instead of refusing the archive
     * as `workspace/session-active`. The stops are requested before the
     * archive write and are not awaited; the response arrives once the archive
     * set is durable.
     */
    readonly stopActivity?: boolean;
}
```
// arg/value type WorkspaceArchiveValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceArchiveValue {
    readonly archivedSessionIds: readonly SessionId[];
}
```

### `workspace/unarchiveSession`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/unarchiveSession`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/unarchiveSession': (request: WorkspaceUnarchiveSessionRequest) => Promise<RemoteResult<WorkspaceArchiveValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceArchiveValue` (result.mode `strict`)
// arg/value type WorkspaceUnarchiveSessionRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceUnarchiveSessionRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type WorkspaceArchiveValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceArchiveValue {
    readonly archivedSessionIds: readonly SessionId[];
}
```

### `workspace/pinSession`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/pinSession`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/pinSession': (request: WorkspacePinSessionRequest) => Promise<RemoteResult<WorkspacePinValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspacePinValue` (result.mode `strict`)
// arg/value type WorkspacePinSessionRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspacePinSessionRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type WorkspacePinValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspacePinValue {
    readonly pinnedSessionIds: readonly SessionId[];
}
```

### `workspace/unpinSession`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/unpinSession`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'workspace/unpinSession': (request: WorkspaceUnpinSessionRequest) => Promise<RemoteResult<WorkspacePinValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspacePinValue` (result.mode `strict`)
// arg/value type WorkspaceUnpinSessionRequest  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceUnpinSessionRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type WorkspacePinValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspacePinValue {
    readonly pinnedSessionIds: readonly SessionId[];
}
```

### `workspace/initializeDefault`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/initializeDefault`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'workspace/initializeDefault': (signal?: AbortSignal) => Promise<RemoteResult<WorkspaceValue | undefined>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller#workspace/initializeDefault:result` (result.mode `strict`)
// arg/value type WorkspaceValue  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export interface WorkspaceValue {
    readonly workspace: WorkspaceView;
}
```

### `directoryPicker/list`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#directoryPicker/list`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'directoryPicker/list': (path: string | undefined, signal?: AbortSignal) => Promise<RemoteResult<DirectoryListing>>
```
wire args: `{"path": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-host-directory-picker/types#DirectoryListing` (result.mode `strict`)
// arg/value type DirectoryListing  —  file: dsh-host-directory-picker/lib/types/types.d.ts
```ts
export interface DirectoryListing {
    /** Absolute path of the listed directory. */
    path: string;
    /** The host account's home directory (breadcrumb "Home" rooting). */
    home: string;
    /**
     * Ancestor chain from the filesystem root to the listed directory
     * inclusive; every crumb is a jump target (crumb `hidden` is always false).
     */
    crumbs: DirectoryEntry[];
    /** Direct child directories, name-sorted; symlinks to directories included. */
    entries: DirectoryEntry[];
    /**
     * True when the backend cut `entries` at its complete-result bound: the
     * level has more child directories than reported, and the missing rows are
     * the name-sorted tail (hidden rows count toward the bound).
     */
    truncated: boolean;
}
```

### `directoryPicker/createDirectory`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#directoryPicker/createDirectory`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'directoryPicker/createDirectory': (path: string, name: string) => Promise<RemoteResult<string>>
```
wire args: `{"path": …, "name": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller#directoryPicker/createDirectory:result` (result.mode `strict`)

### `directoryPicker/pick`
descriptor: `@deepseek-ai/dsh-api-workspace-controller#directoryPicker/pick`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'directoryPicker/pick': (signal?: AbortSignal) => Promise<RemoteResult<string | null>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller#directoryPicker/pick:result` (result.mode `strict`)

### `goals/get`
descriptor: `@deepseek-ai/dsh-goal#goals/get`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/get': (agentId: SessionId) => Promise<RemoteResult<GoalView | undefined>>
```
wire args: `{"agentId": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal#goals/get:result` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalView  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}
```

### `goals/create`
descriptor: `@deepseek-ai/dsh-goal#goals/create`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/create': (agentId: SessionId, request: CreateGoalRequest) => Promise<RemoteResult<CreateGoalResult>>
```
wire args: `{"agentId": …, "request": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#CreateGoalResult` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type CreateGoalRequest  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface CreateGoalRequest {
    readonly objective: string;
    readonly maxGoalRounds?: number;
}
```
// arg/value type CreateGoalResult  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface CreateGoalResult {
    readonly ref: GoalRef;
}
```

### `goals/edit`
descriptor: `@deepseek-ai/dsh-goal#goals/edit`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/edit': (agentId: SessionId, ref: GoalRef, request: EditGoalRequest) => Promise<RemoteResult<GoalView>>
```
wire args: `{"agentId": …, "ref": …, "request": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#GoalView` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalRef  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
```
// arg/value type EditGoalRequest  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface EditGoalRequest {
    readonly objective?: string;
    readonly maxGoalRounds?: number;
}
```
// arg/value type GoalView  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}
```

### `goals/pause`
descriptor: `@deepseek-ai/dsh-goal#goals/pause`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/pause': (agentId: SessionId, ref: GoalRef) => Promise<RemoteResult<GoalView>>
```
wire args: `{"agentId": …, "ref": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#GoalView` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalRef  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
```
// arg/value type GoalView  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}
```

### `goals/resume`
descriptor: `@deepseek-ai/dsh-goal#goals/resume`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/resume': (agentId: SessionId, ref: GoalRef) => Promise<RemoteResult<GoalView>>
```
wire args: `{"agentId": …, "ref": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#GoalView` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalRef  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
```
// arg/value type GoalView  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}
```

### `goals/complete`
descriptor: `@deepseek-ai/dsh-goal#goals/complete`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/complete': (agentId: SessionId, ref: GoalRef) => Promise<RemoteResult<GoalView>>
```
wire args: `{"agentId": …, "ref": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#GoalView` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalRef  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
```
// arg/value type GoalView  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}
```

### `goals/clear`
descriptor: `@deepseek-ai/dsh-goal#goals/clear`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'goals/clear': (agentId: SessionId, ref: GoalRef) => Promise<RemoteResult<GoalRef>>
```
wire args: `{"agentId": …, "ref": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-goal/client#GoalRef` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type GoalRef  —  file: dsh-goal/lib/types/types.d.ts
```ts
export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}
```

### `settings/describe`
descriptor: `@deepseek-ai/dsh-api-settings-controller#settings/describe`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'settings/describe': () => Promise<RemoteResult<SettingsDescribeValue>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-settings/types#SettingsDescribeValue` (result.mode `strict`)
// arg/value type SettingsDescribeValue  —  file: dsh-settings/lib/types/types.d.ts
```ts
export interface SettingsDescribeValue {
    /** Whether the profile accepts writes; `false` disables every write control. */
    writable: boolean;
    /** Whether the configuration editor owns a local document, without exposing its Host path. */
    hasDocument: boolean;
    /** One view per profile plugin entry. */
    namespaces: SettingsNamespaceView[];
}
```

### `settings/update`
descriptor: `@deepseek-ai/dsh-api-settings-controller#settings/update`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'settings/update': (ns: string, patch: Record<string, JsonValue>, expectedRevision: number | undefined) => Promise<RemoteResult<SettingsNamespaceView>>
```
wire args: `{"ns": …, "patch": …, "expectedRevision": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-settings/types#SettingsNamespaceView` (result.mode `strict`)
// type `Record` — no named declaration found (inline/generated); see client signature above
// arg/value type SettingsNamespaceView  —  file: dsh-settings/lib/types/types.d.ts
```ts
export interface SettingsNamespaceView {
    /** Generate a page if no custom page is registered for this instance. */
    autoGenerate: boolean;
    /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
    ns: string;
    /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
    schema: JsonValue;
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: JsonValue;
    /** Redacted composition base layer, with defaults resolved. */
    base?: JsonValue;
    /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
    user?: JsonValue;
    /** When the owner applies changes. */
    applies: 'live';
    /** Every schema-declared secret slot with its configured state. */
    secrets: SettingsSecretView[];
    /**
     * Monotonic revision of the raw entry configuration this view was read at. Send it
     * back as `expectedRevision` on a write so a stale editor is refused rather
     * than silently overwriting a concurrent change.
     */
    revision: number;
}
```

### `settings/replace`
descriptor: `@deepseek-ai/dsh-api-settings-controller#settings/replace`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'settings/replace': (ns: string, section: Record<string, JsonValue>, expectedRevision: number | undefined) => Promise<RemoteResult<SettingsNamespaceView>>
```
wire args: `{"ns": …, "section": …, "expectedRevision": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-settings/types#SettingsNamespaceView` (result.mode `strict`)
// type `Record` — no named declaration found (inline/generated); see client signature above
// arg/value type SettingsNamespaceView  —  file: dsh-settings/lib/types/types.d.ts
```ts
export interface SettingsNamespaceView {
    /** Generate a page if no custom page is registered for this instance. */
    autoGenerate: boolean;
    /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
    ns: string;
    /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
    schema: JsonValue;
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: JsonValue;
    /** Redacted composition base layer, with defaults resolved. */
    base?: JsonValue;
    /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
    user?: JsonValue;
    /** When the owner applies changes. */
    applies: 'live';
    /** Every schema-declared secret slot with its configured state. */
    secrets: SettingsSecretView[];
    /**
     * Monotonic revision of the raw entry configuration this view was read at. Send it
     * back as `expectedRevision` on a write so a stale editor is refused rather
     * than silently overwriting a concurrent change.
     */
    revision: number;
}
```

### `settings/mutate`
descriptor: `@deepseek-ai/dsh-api-settings-controller#settings/mutate`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'settings/mutate': (ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined) => Promise<RemoteResult<SettingsNamespaceView>>
```
wire args: `{"ns": …, "ops": …, "expectedRevision": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-settings/types#SettingsNamespaceView` (result.mode `strict`)
// arg/value type SettingsPathOpView  —  file: dsh-settings/lib/types/types.d.ts
```ts
export type SettingsPathOpView = {
    op: 'set';
    path: string[];
    value: JsonValue;
} | {
    op: 'unset';
    path: string[];
};
```
// arg/value type SettingsNamespaceView  —  file: dsh-settings/lib/types/types.d.ts
```ts
export interface SettingsNamespaceView {
    /** Generate a page if no custom page is registered for this instance. */
    autoGenerate: boolean;
    /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
    ns: string;
    /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
    schema: JsonValue;
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: JsonValue;
    /** Redacted composition base layer, with defaults resolved. */
    base?: JsonValue;
    /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
    user?: JsonValue;
    /** When the owner applies changes. */
    applies: 'live';
    /** Every schema-declared secret slot with its configured state. */
    secrets: SettingsSecretView[];
    /**
     * Monotonic revision of the raw entry configuration this view was read at. Send it
     * back as `expectedRevision` on a write so a stale editor is refused rather
     * than silently overwriting a concurrent change.
     */
    revision: number;
}
```

### `settings/openSettingsDocument`
descriptor: `@deepseek-ai/dsh-api-settings-controller#settings/openSettingsDocument`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'settings/openSettingsDocument': (signal?: AbortSignal) => Promise<RemoteResult<SettingsDocumentOpenValue>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-settings-controller/types#SettingsDocumentOpenValue` (result.mode `strict`)
// arg/value type SettingsDocumentOpenValue  —  file: dsh-api-settings-controller/lib/types/types.d.ts
```ts
export interface SettingsDocumentOpenValue {
    readonly opened: true;
}
```

### `credentials/describe`
descriptor: `@deepseek-ai/dsh-api-settings-controller#credentials/describe`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'credentials/describe': (refs: string[]) => Promise<RemoteResult<Record<string, CredentialInfo>>>
```
wire args: `{"refs": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-settings-controller#credentials/describe:result` (result.mode `strict`)
// type `Record` — no named declaration found (inline/generated); see client signature above

### `credentials/set`
descriptor: `@deepseek-ai/dsh-api-settings-controller#credentials/set`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'credentials/set': (ref: string, value: string) => Promise<RemoteResult<void>>
```
wire args: `{"ref": …, "value": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-settings-controller#credentials/set:result` (result.mode `strict`)

### `credentials/unset`
descriptor: `@deepseek-ai/dsh-api-settings-controller#credentials/unset`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'credentials/unset': (ref: string) => Promise<RemoteResult<void>>
```
wire args: `{"ref": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-settings-controller#credentials/unset:result` (result.mode `strict`)

### `llm/listProviders`
descriptor: `@deepseek-ai/dsh-llm#llm/listProviders`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'llm/listProviders': () => Promise<RemoteResult<LlmProviderInfo[]>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-llm#llm/listProviders:result` (result.mode `strict`)
// arg/value type LlmProviderInfo  —  file: dsh-llm/lib/types/types.d.ts
```ts
export interface LlmProviderInfo {
    /** Provider route key used by {@link GenerateOptions.provider}. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}
```

### `llm/listConfigurableProviders`
descriptor: `@deepseek-ai/dsh-llm#llm/listConfigurableProviders`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'llm/listConfigurableProviders': () => Promise<RemoteResult<LlmConfigurableProvider[]>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-llm#llm/listConfigurableProviders:result` (result.mode `strict`)
// arg/value type LlmConfigurableProvider  —  file: dsh-llm/lib/types/types.d.ts
```ts
export interface LlmConfigurableProvider {
    /** Provider route key this entry activates when configured. */
    provider: string;
    /** Human-readable provider name for configuration surfaces. */
    displayName: string;
    /** User-settings namespace whose section configures this provider. */
    settingsNs: string;
    /**
     * Path from that namespace's section root to this provider's profile
     * object; empty when the whole section is the profile.
     */
    settingsPath: readonly string[];
    /**
     * Whether the owning adapter knows this route only because configuration
     * declared it — a gateway or self-hosted server it ships nothing about.
     * Absent means the adapter draws no such distinction; false means it does
     * and this route is one of its own. Only the adapter can answer: a stored
     * profile is how a user-added route AND a corrected shipped one both look
     * from outside.
     */
    declared?: boolean;
    /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
    error?: string;
}
```

### `llm/discoverModels`
descriptor: `@deepseek-ai/dsh-llm#llm/discoverModels`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'llm/discoverModels': (settingsNs: string, request: LlmModelDiscoveryRequest, signal?: AbortSignal) => Promise<RemoteResult<LlmDiscoveredModel[]>>
```
wire args: `{"settingsNs": …, "request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-llm#llm/discoverModels:result` (result.mode `strict`)
// arg/value type LlmModelDiscoveryRequest  —  file: dsh-llm/lib/types/types.d.ts
```ts
export interface LlmModelDiscoveryRequest {
    /**
     * Route the draft is editing, when it edits an existing one. A route whose
     * adapter already knows its models answers from that knowledge instead of
     * asking the endpoint — the adapter's own registry is the better answer, and
     * it costs no network call.
     */
    provider?: string;
    /**
     * Endpoint to interrogate. Optional because a route the adapter already
     * describes needs none; a route it does not must supply one.
     */
    baseURL?: string;
    /** Wire protocol the endpoint speaks, when the draft names one. */
    api?: string;
    /** Credential for this interrogation alone; the harness never stores it. */
    apiKey?: string;
}
```
// arg/value type LlmDiscoveredModel  —  file: dsh-llm/lib/types/types.d.ts
```ts
export interface LlmDiscoveredModel {
    /** Model id the endpoint accepts. */
    id: string;
    /** Human-readable name when the endpoint supplies one. */
    name?: string;
    /** Maximum combined request and response context, when disclosed. */
    contextWindow?: number;
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number;
    /** Accepted input types when disclosed by the catalog or endpoint; absent means unknown. */
    inputModalities?: readonly ModelModality[];
}
```

### `pluginInventory/list`
descriptor: `@deepseek-ai/dsh-host-plugin-inventory#pluginInventory/list`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'pluginInventory/list': () => Promise<RemoteResult<PluginInventorySnapshot>>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-host-plugin-inventory/types#PluginInventorySnapshot` (result.mode `strict`)
// arg/value type PluginInventorySnapshot  —  file: dsh-host-plugin-inventory/lib/types/types.d.ts
```ts
export interface PluginInventorySnapshot {
    /** Whether this Host exposes persistent current-profile management. */
    readonly managementAvailable?: boolean;
    readonly entries: readonly PluginInventoryEntry[];
    /**
     * Per-preset compositions, present only when an agent-preset roster is
     * composed in this deployment.
     */
    readonly agentPresets?: readonly AgentPresetPluginGroup[];
}
```

### `messageFeedback/list`
descriptor: `@deepseek-ai/dsh-message-feedback#messageFeedback/list`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'messageFeedback/list': (request: MessageFeedbackListRequest) => Promise<RemoteResult<MessageFeedbackListResult>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-message-feedback/types#MessageFeedbackListResult` (result.mode `strict`)
// arg/value type MessageFeedbackListRequest  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export interface MessageFeedbackListRequest {
    /** Session whose feedback events should be read. */
    readonly sessionId: SessionId;
}
```
// arg/value type MessageFeedbackListResult  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export type MessageFeedbackListResult = MessageFeedbackSuccess<MessageFeedbackListValue> | MessageFeedbackRejected<MessageFeedbackSessionNotFound>;
```

### `messageFeedback/put`
descriptor: `@deepseek-ai/dsh-message-feedback#messageFeedback/put`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'messageFeedback/put': (request: MessageFeedbackPutRequest) => Promise<RemoteResult<MessageFeedbackPutResult>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-message-feedback/types#MessageFeedbackPutResult` (result.mode `strict`)
// arg/value type MessageFeedbackPutRequest  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export interface MessageFeedbackPutRequest {
    /** Persisted Session that owns the target message. */
    readonly sessionId: SessionId;
    /** Target assistant-message identity. */
    readonly messageId: MessageId;
    /** Desired overall judgment. */
    readonly rating: MessageFeedbackRating;
    /** Optional non-blank explanation. */
    readonly note?: string;
    /** Optional category; absent keeps the item uncategorized. */
    readonly category?: FeedbackCategory;
    /** Observed item version, or `null` to require that no item exists. */
    readonly ifVersion: MessageFeedbackVersion | null;
}
```
// arg/value type MessageFeedbackPutResult  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export type MessageFeedbackPutResult = MessageFeedbackSuccess<MessageFeedbackItem> | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackTargetNotFound | MessageFeedbackVersionConflict | MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>;
```

### `messageFeedback/delete`
descriptor: `@deepseek-ai/dsh-message-feedback#messageFeedback/delete`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'messageFeedback/delete': (request: MessageFeedbackDeleteRequest) => Promise<RemoteResult<MessageFeedbackDeleteResult>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-message-feedback/types#MessageFeedbackDeleteResult` (result.mode `strict`)
// arg/value type MessageFeedbackDeleteRequest  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export interface MessageFeedbackDeleteRequest {
    /** Session that owns the feedback. */
    readonly sessionId: SessionId;
    /** Message whose feedback should be absent after this operation. */
    readonly messageId: MessageId;
    /** Observed item version; ignored when the item is already absent. */
    readonly ifVersion: MessageFeedbackVersion;
}
```
// arg/value type MessageFeedbackDeleteResult  —  file: dsh-message-feedback/lib/types/types.d.ts
```ts
export type MessageFeedbackDeleteResult = MessageFeedbackSuccess<MessageFeedbackDeleteValue> | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>;
```

### `job/kill`
descriptor: `@deepseek-ai/dsh-api-job-controller#job/kill`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'job/kill': (request: JobKillRequest) => Promise<RemoteResult<JobKillValue>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-job-controller/types#JobKillValue` (result.mode `strict`)
// arg/value type JobKillRequest  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export interface JobKillRequest {
    /** Session whose job list carries the job; the fenced lookup reads as it. */
    readonly sessionId: SessionId;
    readonly jobId: JobId;
}
```
// arg/value type JobKillValue  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export interface JobKillValue {
    readonly outcome: 'requested' | 'already-finished';
}
```

### `subagents/prompt`
descriptor: `@deepseek-ai/dsh-subagent#subagents/prompt`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'subagents/prompt': (request: SubagentPromptRequest, signal?: AbortSignal) => Promise<RemoteResult<SubagentPromptReceipt>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-subagent/client#SubagentPromptReceipt` (result.mode `strict`)
// arg/value type SubagentPromptRequest  —  file: dsh-subagent/lib/types/control-types.d.ts
```ts
export interface SubagentPromptRequest {
    /** Identity persisted on the accepted message, minted before the call. */
    readonly requestId: SubagentPromptRequestId;
    readonly parentSessionId: SessionId;
    readonly childSessionId: SessionId;
    /** Required discriminator retained from the browser control address. */
    readonly mode: 'continuable';
    /** Whether this message queues a later turn or targets the nearest step. */
    readonly delivery: 'queue' | 'steer';
    /**
     * Browser prompt parts delivered as the child's user message. The Host
     * admits and persists image parts before delivery, so the wire never
     * carries a durable attachment reference the caller could fabricate.
     */
    readonly content: readonly PromptContentPart[];
    /** Optional browser zone sampled for this exact human prompt. */
    readonly clientTimeZone?: string;
}
```
// arg/value type SubagentPromptReceipt  —  file: dsh-subagent/lib/types/control-types.d.ts
```ts
export interface SubagentPromptReceipt {
    readonly messageId: MessageId;
}
```

### `subagents/interruptByParent`
descriptor: `@deepseek-ai/dsh-subagent#subagents/interruptByParent`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'subagents/interruptByParent': (childSessionId: SessionId, parentSessionId: SessionId, mode: 'continuable') => Promise<RemoteResult<SubagentInterruptReceipt>>
```
wire args: `{"childSessionId": …, "parentSessionId": …, "mode": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-subagent/client#SubagentInterruptReceipt` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type SubagentInterruptReceipt  —  file: dsh-subagent/lib/types/control-types.d.ts
```ts
export interface SubagentInterruptReceipt {
    readonly accepted: true;
}
```

### `userQuestions/answer`
descriptor: `@deepseek-ai/dsh-user-questions#userQuestions/answer`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `null`
client-face signature:
```ts
'userQuestions/answer': (agentId: SessionId, callId: ToolCallId, answer: AskUserQuestionAnswer) => Promise<RemoteResult<boolean>>
```
wire args: `{"agentId": …, "callId": …, "answer": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-user-questions#userQuestions/answer:result` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type ToolCallId  —  file: dsh-client-ui-chat/lib/types/client/contract/store.d.ts
```ts
export type ToolCallId = string;
```
// arg/value type AskUserQuestionAnswer  —  file: dsh-user-questions/lib/types/types.d.ts
```ts
export interface AskUserQuestionAnswer {
    /** Structured answers keyed by question id. */
    answers: AskUserQuestionAnswerItem[];
}
```

### `fileReferences/list`
descriptor: `@deepseek-ai/dsh-api-session-controller#fileReferences/list`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'fileReferences/list': (agentId: SessionId, query: string, signal?: AbortSignal) => Promise<RemoteResult<FileReferenceCandidate[]>>
```
wire args: `{"agentId": …, "query": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-api-session-controller#fileReferences/list:result` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type FileReferenceCandidate  —  file: dsh-file-reference/lib/types/types.d.ts
```ts
export interface FileReferenceCandidate {
    /** User-facing path accepted by normal prompts and filesystem tools. */
    path: string;
    /** Directories keep completion open; files finish the mention. */
    kind: 'file' | 'directory';
}
```

### `sessionFeedback/record`
descriptor: `@deepseek-ai/dsh-command-feedback#sessionFeedback/record`  •  scope: `null`  •  cancellation: `null`
client-face signature:
```ts
'sessionFeedback/record': (request: SessionFeedbackRecordRequest) => Promise<RemoteResult<SessionFeedbackRecordResult>>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-command-feedback/types#SessionFeedbackRecordResult` (result.mode `strict`)
// arg/value type SessionFeedbackRecordRequest  —  file: dsh-command-feedback/lib/types/types.d.ts
```ts
export interface SessionFeedbackRecordRequest {
    /** Live Session the remark describes. */
    readonly sessionId: SessionId;
    /** Free-text remark; blank text is recorded as absent. */
    readonly text?: string;
    /** Category the human filed the remark under. */
    readonly category?: FeedbackCategory;
}
```
// arg/value type SessionFeedbackRecordResult  —  file: dsh-command-feedback/lib/types/types.d.ts
```ts
export type SessionFeedbackRecordResult = {
    readonly ok: true;
    readonly value: SessionFeedbackRecordValue;
} | {
    readonly ok: false;
    readonly error: SessionFeedbackSessionNotFound;
};
```

### `session/control` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-session-controller#session/control`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/control': (signal?: AbortSignal) => RemoteStreamHandle<SessionControlFrame, never>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionControlFrame` (result.mode `strict`)
// arg/value type SessionControlFrame  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export type SessionControlFrame = {
    readonly type: 'baseline';
    readonly value: SessionControlBaseline;
} | ({
    readonly type: 'projection';
} & SessionProjectionUpdate);
```

### `session/follow` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-session-controller#session/follow`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'session/follow': (request: SessionFollowRequest, signal?: AbortSignal) => RemoteStreamHandle<SessionFollowFrame, never>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-session-controller/types#SessionFollowFrame` (result.mode `strict`)
// arg/value type SessionFollowRequest  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
    readonly address: SessionAddress;
    /** Include process-local assistant presentation frames for the Web client. */
    readonly assistantStream?: true;
}
```
// arg/value type SessionFollowFrame  —  file: dsh-api-session-controller/lib/types/types.d.ts
```ts
export type SessionFollowFrame = {
    readonly type: 'snapshot';
    readonly header: SessionWireHeader;
    readonly cursor: number;
    readonly records: readonly SessionHistoryRecord[];
    readonly hasMore: boolean;
    readonly projections: SessionProjectionBaseline;
    readonly assistantStream?: SessionAssistantStreamBaseline;
} | SessionEventEntry | {
    readonly type: 'assistant-stream';
    readonly frame: SessionAssistantStreamFrame;
};
```

### `workspace/follow` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-workspace-controller#workspace/follow`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'workspace/follow': (signal?: AbortSignal) => RemoteStreamHandle<WorkspaceFollowFrame, never>
```
wire args: `{}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-workspace-controller/types#WorkspaceFollowFrame` (result.mode `strict`)
// arg/value type WorkspaceFollowFrame  —  file: dsh-api-workspace-controller/lib/types/types.d.ts
```ts
export type WorkspaceFollowFrame = {
    readonly type: 'baseline';
    readonly value: WorkspaceBaseline;
} | WorkspaceFollowIncrement;
```

### `job/list` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-job-controller#job/list`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'job/list': (request: JobListRequest, signal?: AbortSignal) => RemoteStreamHandle<JobListFrame, never>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-job-controller/types#JobListFrame` (result.mode `strict`)
// arg/value type JobListRequest  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export interface JobListRequest {
    readonly sessionId: SessionId;
}
```
// arg/value type JobListFrame  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export interface JobListFrame {
    readonly type: 'rows';
    readonly jobs: readonly JobView[];
}
```

### `job/follow` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-job-controller#job/follow`  •  scope: `null`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'job/follow': (request: JobFollowRequest, signal?: AbortSignal) => RemoteStreamHandle<JobFollowFrame, never>
```
wire args: `{"request": …}`  (every listed field required; extra/unknown fields rejected)
result: `@deepseek-ai/dsh-api-job-controller/types#JobFollowFrame` (result.mode `strict`)
// arg/value type JobFollowRequest  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export interface JobFollowRequest {
    /**
     * Owning session for the fenced read. Omitted for an unowned job, which any
     * caller may observe.
     */
    readonly sessionId?: SessionId;
    readonly jobId: JobId;
    /**
     * Absolute byte offset to resume from (a prior frame's `next`). Omitted, the
     * stream starts at the oldest retained byte.
     */
    readonly from?: number;
}
```
// arg/value type JobFollowFrame  —  file: dsh-api-job-controller/lib/types/types.d.ts
```ts
export type JobFollowFrame = {
    readonly type: 'opened';
    readonly job: JobView;
    /** Offset the first `output` frame continues from. */
    readonly from: number;
} | {
    readonly type: 'output';
    readonly chunks: readonly JobChunk[];
    /** Offset to resume from after this frame. */
    readonly next: number;
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true;
} | {
    readonly type: 'status';
    readonly job: JobView;
};
```

### `userQuestions/attachWait` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-user-questions#userQuestions/attachWait`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'userQuestions/attachWait': (agentId: SessionId, callId: ToolCallId, signal?: AbortSignal) => RemoteStreamHandle<{ remainingMs: number; }, never>
```
wire args: `{"agentId": …, "callId": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-user-questions#userQuestions/attachWait:result` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type ToolCallId  —  file: dsh-client-ui-chat/lib/types/client/contract/store.d.ts
```ts
export type ToolCallId = string;
```

### `terminal/follow` — **stream (WebSocket only)**
descriptor: `@deepseek-ai/dsh-api-terminal-controller#terminal/follow`  •  scope: `{"context":"agent","wire":"agentId"}`  •  cancellation: `{"parameter":"signal"}`
client-face signature:
```ts
'terminal/follow': (agentId: SessionId, id: WebTerminalId, attachmentId: TerminalAttachmentId, signal?: AbortSignal) => RemoteStreamHandle<TerminalFrame, never>
```
wire args: `{"agentId": …, "id": …, "attachmentId": …}`  (every listed field required; extra/unknown fields rejected)  • lookup fields: `agentId`=`agent`
result: `@deepseek-ai/dsh-api-terminal-controller/types#TerminalFrame` (result.mode `strict`)
// arg/value type SessionId  —  file: dsh-session/lib/types/types.d.ts
```ts
export type SessionId = Branded<'SessionId'>;
```
// arg/value type WebTerminalId  —  file: dsh-api-terminal-controller/lib/types/types.d.ts
```ts
export type WebTerminalId = Branded<'WebTerminalId'>;
```
// arg/value type TerminalAttachmentId  —  file: dsh-api-terminal-controller/lib/types/types.d.ts
```ts
export type TerminalAttachmentId = Branded<'TerminalAttachmentId'>;
```
// arg/value type TerminalFrame  —  file: dsh-api-terminal-controller/lib/types/types.d.ts
```ts
export type TerminalFrame = {
    readonly type: 'snapshot';
    readonly sequence: number;
    readonly screen: string;
    readonly info: WebTerminalInfo;
} | {
    readonly type: 'output';
    readonly sequence: number;
    readonly data: string;
} | {
    readonly type: 'state';
    readonly info: WebTerminalInfo;
};
```

## 3. Lookup parameters (question 2)

Descriptor form (e.g. `commands/list`): `{"name":"agent","wire":"agentId","source":"lookup","lookup":"agent","codec":{"typeSymbol":"@deepseek-ai/dsh-session/types#SessionId"}}`. The wire field is **`agentId`** and the value is a **Session id string** (`session-<uuid>`): the Host resolves the session to its live Agent. All lookup endpoints in the brief's list that carry this parameter: `commands/list`, `goals/get|create|edit|pause|resume|complete|clear`, `fileReferences/list`, `userQuestions/answer|attachWait`, `agentPresets/select`, `terminal/follow`, `terminal/create|close|rename|resize|retain|write` (scoped `agent`).

Raw observations (`/tmp/probe/probe2.out`, session `session-47f2c473-508f-40d3-8aae-f84c55e12735`):

```
>>> REQ {"type":"client-request","rpcId":"pzj9aomss","method":"commands/list","payload":{"args":{"agentId":"session-47f2c473-508f-40d3-8aae-f84c55e12735"}}}
<<< RES {"type":"server-response","rpcId":"pzj9aomss","result":{"ok":true,"value":[{"definitionId":"@deepseek-ai/dsh-command-compact","name":"compact","description":"Compact older conversation history"}, … ]}}

>>> REQ {"type":"client-request","rpcId":"pjac3tbmv","method":"commands/list","payload":{"args":{"agentId":"session-00000000-0000-0000-0000-000000000000"}}}
<<< RES {"ok":false,"error":{"code":"session/not-found","message":"session \"session-00000000-0000-0000-0000-000000000000\" not found","details":{"sessionId":"session-00000000-0000-0000-0000-000000000000"}}}

>>> REQ {"type":"client-request","rpcId":"plba3qdek","method":"commands/list","payload":{"args":{}}}
<<< RES {"ok":false,"error":{"code":"gateway/arguments-invalid","message":"typert gateway: commands/list: args fields do not match the descriptor: missing \"agentId\"","details":{"endpoint":"commands/list"}}}

>>> REQ {"type":"client-request","rpcId":"p7hlj432g","method":"goals/get","payload":{"args":{"agentId":"session-47f2c473-508f-40d3-8aae-f84c55e12735"}}}
<<< RES {"ok":true}
>>> REQ {"type":"client-request","rpcId":"pw3n9anb8","method":"goals/get","payload":{"args":{"agentId":"bogus"}}}
<<< RES {"ok":false,"error":{"code":"session/not-found","message":"session \"bogus\" not found","details":{"sessionId":"bogus"}}}

>>> REQ {"type":"client-request","rpcId":"pxtzw39dj","method":"fileReferences/list","payload":{"args":{"agentId":"session-47f2c473-508f-40d3-8aae-f84c55e12735","query":"a"}}}
<<< RES {"ok":true,"value":[{"path":"package.json","kind":"file"},{"path":"package-lock.json","kind":"file"}]}
```

`skills/list` is **not** a lookup call — it takes `{"request":{"sessionId":"…"}}` (verified same-session 200, `{"skills":[]}`; bogus id → same `session/not-found`).
Wrong lookup values always surface as `session/not-found` with `details.sessionId`; a *missing* `agentId` field surfaces as `gateway/arguments-invalid`. Not exercised: subagent session ids as `agentId` (an `agentPresets/select` and `terminal/follow` happy path); the codec type is the same `SessionId`, and `SessionFollowRequest.address` shows the explicit subagent alternative (`{kind:'subagent',parentSessionId,childSessionId,mode}`), which a client would use instead.


## 4. WebSocket logical streams (question 3)

### 4.1 Upgrade admission

Cookie is mandatory; Origin is optional but if present must be same-origin; a foreign Host is refused. Raw results (`/tmp/probe/probe3.out` lines 1–3, `/tmp/probe/ws-probe.out` lines 5–6):

```
WS cross-origin cookie: ["UPGRADE_REJECTED status=403 body=\"forbidden\""]
WS foreign Host cookie: ["UPGRADE_REJECTED status=403 body=\"forbidden\""]
WS origin-same cookie: ["OPEN"]
>>> WS NO COOKIE: ["UPGRADE_REJECTED status=401 headers={\"connection\":\"close\",\"content-type\":\"text/plain; charset=utf-8\",\"content-length\":\"12\"} body=\"unauthorized\""]
>>> WS COOKIE-ONLY: ["OPEN"]
```

The same fence is applied to HTTP: `origin-cross` → `403 forbidden`; `sec-fetch-site: cross-site` → `403 forbidden`; forged `Host: evil.example` → `403 forbidden`; a completely absent Host header is impossible over HTTP/1.1 (Node answers `400`).

### 4.2 Literal frame transcript

Captured by `/tmp/probe/probe2.mjs` against a session created via `session/create {"request":{}}` → `session-47f2c473-508f-40d3-8aae-f84c55e12735`, then `session/prompt` with `{"request":{"requestId":"client-req-1","sessionId":"…","mode":"queue","content":[{"type":"text","text":"hello world"}]}}` (which fails at the model with `MISSING_CREDENTIAL` but still drives every stream). Long JSON values are clipped at ~700 chars (marked `…`); untruncated lines are in `/tmp/probe/probe2.out` (file:line at right).

```
WS OPEN (minted cookie)                                                        # probe2.out:60
CLIENT> {"type":"open","streamId":"ev2","endpoint":"$events","payload":{"args":{}}}            # 61
HOST< {"type":"item","streamId":"ev2","value":{"type":"ready","clientId":"6a30d486-1cd4-4d64-8b29-83615a6ab9ab","host":{"home":"/home/node"}}}   # 62
CLIENT> {"type":"open","streamId":"ctl2","endpoint":"session/control","payload":{"args":{}}}   # 63
HOST< {"type":"item","streamId":"ctl2","value":{"type":"baseline","value":{"projections":{"session-f06b2f7c-…":{…},"session-47f2c473-…":{"asOfSeq":2,"values":{"title":null,"goal":null,"tokenUsage":{"uncachedInputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"contextPressure":{},"contextBreakdown":{"systemTokens":0,"toolsTokens":0,"messageTokens":0},"inbox":{"next-turn":[],"next-step":[]},"sessionStats":{…},"turnOutline":[],"agentPreset":"standard","userQuestions":{"active":[],"settled":[]},"subagentCatalog":[],"subagentTiming":{"settledMs":0},"subagent":null,"permissions":{"currentValue":"workspace-write"},"todos":null,"plan":{…},"modelSelection":{…},"sessionListMetadata":{…},"imageLimits":{…}}}}}}}   # 64 (clipped)
CLIENT> {"type":"open","streamId":"fol2","endpoint":"session/follow","payload":{"args":{"request":{"address":{"kind":"session","sessionId":"session-47f2c473-508f-40d3-8aae-f84c55e12735"},"assistantStream":true}}}}   # 65
HOST< {"type":"item","streamId":"fol2","value":{"type":"snapshot","header":{"version":4,"id":"session-47f2c473-…","createdAt":1791735017640,"cwd":"/tmp/dshref-02","isSeeded":false,"agentPreset":"standard"},"cursor":2,"records":[{"type":"event","event":{"type":"permission/preset","seq":0,"time":…,"data":{"preset":"workspace-write"}}},{"type":"event","event":{"type":"sandbox/mode",…}},{"type":"event","event":{"type":"approval/policy",…}}],"hasMore":false,"projections":{"asOfSeq":2,"values":{…}},"assistantStream":{…}}   # 66 (clipped)
CLIENT> {"type":"open","streamId":"jobs2","endpoint":"job/list","payload":{"args":{"request":{}}}}                     # 67
HOST< {"type":"error","streamId":"jobs2","error":{"code":"gateway/input-invalid","message":"typert gateway: job/list: wire field \"request\" failed boundary validation","details":{"endpoint":"job/list","field":"request"}}}   # 68
>>> HTTP session/prompt prompt status=200   ← {"ok":true,"value":{"accepted":true}}          # 70–72
```

```
HOST< {"type":"item","streamId":"fol2","value":{"type":"event","event":{"type":"agent/inbox/spliced","seq":3,"time":…,"data":{"target":"next-turn","start":0,"inserted":[{"content":[{"type":"text","text":"hello world"}],"source":{"kind":"user","rpcId":"client-req-1"},"role":"user","id":"e1215155-…"}]}}}}   # 73
HOST< {"type":"item","streamId":"ev2","value":{"type":"emit","event":"api-session/activity","args":["session-47f2c473-…",1791735020747]}}      # 84
HOST< {"type":"item","streamId":"fol2","value":{"type":"assistant-stream","frame":{"type":"start","attemptId":"session-47f2c473-…:1","revision":1,"turn":1,"step":1,"startedAfterSeq":11}}}   # 95
HOST< {"type":"item","streamId":"fol2","value":{"type":"assistant-stream","frame":{"type":"chunk","attemptId":"session-47f2c473-…:1","revision":2,"index":0,"time":…,"chunk":{"type":"finish","reason":{"kind":"error","failure":{"message":"llm-deepseek: no API key for provider route \"deepseek-official\"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment","code":"MISSING_CREDENTIAL"}}}}}}   # 106
HOST< {"type":"item","streamId":"ev2","value":{"type":"emit","event":"api-session/error","args":["session-47f2c473-…","llm-deepseek: no API key for provider route \"deepseek-official\"; …"]}}   # 108
HOST< {"type":"item","streamId":"fol2","value":{"type":"assistant-stream","frame":{"type":"end","attemptId":"session-47f2c473-…:1","revision":3,"index":1,"outcome":{"kind":"committed","eventType":"assistant/attempt","seq":14}}}}   # 112
HOST< {"type":"item","streamId":"fol2","value":{"type":"event","event":{"type":"turn/end","seq":16,"time":…,"data":{"turn":1,"reason":{"kind":"error","error":{"message":"llm-deepseek: no API key …","code":"MISSING_CREDENTIAL"}}}}}}   # 114
```

Other streams, same protocol (`/tmp/probe/probe3.out` lines 13, 15, 17):

```
CLIENT> {"type":"open","streamId":"jobs3","endpoint":"job/list","payload":{"args":{"request":{"sessionId":"session-1234e3d4-306e-439c-aeca-9d7d33e4ab85"}}}}
HOST< {"type":"item","streamId":"jobs3","value":{"type":"rows","jobs":[]}}
CLIENT> {"type":"open","streamId":"ws1","endpoint":"workspace/follow","payload":{"args":{}}}
HOST< {"type":"item","streamId":"ws1","value":{"type":"baseline","value":{"items":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}}
CLIENT> {"type":"open","streamId":"uq1","endpoint":"userQuestions/attachWait","payload":{"args":{"agentId":"session-1234e3d4-…","callId":"bogus-call"}}}
HOST< {"type":"end","streamId":"uq1"}
```

### 4.3 Frame semantics

* `$events`: first frame is always `{"type":"ready","clientId":"<uuid>","host":{"home":"<OS home>"}}`; every later frame is `{"type":"emit","event":"<name>","args":[…]}` (or waterfall/cancel, §5).
* `session/control`: exactly one `{"type":"baseline","value":{"projections":{<sessionId>:{asOfSeq,values}}}}` per generation, then `{"type":"projection","sessionId","key","value","seq"}` deltas (observed keys: `title`, `plan`, `modelSelection`, `contextPressure`, `contextBreakdown`, `sessionStats`, `turnOutline`, `inbox`, `sessionListMetadata`, `subagentTiming`).
* `session/follow`: exactly one `{"type":"snapshot","header","cursor","records","hasMore","projections","assistantStream"?}` (records are `{"type":"event","event":{type,seq,time,data,ignorable?,sourceEventSeqs?,surfaceOp?}}`), then live `{"type":"event",…}` frames and — only when `assistantStream:true` was requested — `{"type":"assistant-stream","frame":{type:'start'|'chunk'|'end',…}}` frames.
* `job/list`: `{"type":"rows","jobs":[…]}` — whole-set replacement per lifecycle change.
* `workspace/follow`: `{"type":"baseline","value":{"items":[],"archivedSessionIds":[],"pinnedSessionIds":[]}}` (no workspaces were registered in this DSH home).
* `userQuestions/attachWait`: immediately `end` when the addressed question is not pending.



## 5. `$events` forwarded Host events and waterfall answers (question 4)

Open message is the ordinary stream open with empty args: `{"type":"open","streamId":"ev1","endpoint":"$events","payload":{"args":{}}}`.
Host frames observed (`/tmp/probe/probe3.out` lines 5–7, clipped; `session/create` was issued right after the open):

```
HOST< {"type":"item","streamId":"ev3","value":{"type":"ready","clientId":"417a8392-962f-412f-a2e7-f1d7a806891c","host":{"home":"/home/node"}}}
HOST< {"type":"item","streamId":"ev3","value":{"type":"emit","event":"api-session/added","args":[{"sessionId":"session-1234e3d4-306e-439c-aeca-9d7d33e4ab85","updatedAt":1791735098311,"agentAvailable":true,"running":false,"blank":true,"cwd":"/tmp/dshref-02","projections":{"kind":"sequenced","asOfSeq":2,"values":{…}}}]}
HOST< {"type":"item","streamId":"ev3","value":{"type":"emit","event":"api-session/added","args":[{"sessionId":"session-1234e3d4-306e-439c-aeca-9d7d33e4ab85", …same summary… }]}]}
```

* One `session/create` produced **two identical `api-session/added` emits** (session registered, then Agent created — the event doc says “A Session became visible or its Agent was created or disposed”). Clients must upsert idempotently.
* Other emits observed live: `api-session/status` `[sessionId,true|false]`, `api-session/activity` `[sessionId,updatedAt]`, `api-session/error` `[sessionId,message]` (raw lines 84, 108, 111 in `/tmp/probe/probe2.out`).
* Full forwarded allowlist (source `dsh-api-remotes/lib/index.js`, 27 events, all `emit` except the two marked): `agent-preset/selected`, **`approval/request` (waterfall)**, `api-session/activity`, `api-session/added`, `api-session/error`, `api-session/removed`, `api-session/status`, `commands/change`, `deepseek-account/session-expired`, `deepseek-account/model-sign-in-required`, `credentials/record-updated`, `credentials/reference-updated`, `goal/activation-changed`, `cordis/request-run`, `cordis/request-run-resolved`, `cordis/dynamic-package`, `cordis/dynamic-retract`, `cordis/inspect-query`, `cordis/inspect-query-resolved`, `llm/adapters-updated`, `permission-presets/catalog-changed`, `plugin-manager/changed`, `plugin-manager/install-log`, `plugin-manager/install-state`, `settings/document-updated`, `schedule/changed`, **`user-questions/request` (waterfall)**.

### 5.1 Waterfall frames — shape **[source-derived, not triggered live]**

I could **not** trigger a real waterfall: the only two waterfall events (`approval/request`, `user-questions/request`) are emitted from inside a model turn (tool approval / `ask_user_question`). This host has no model credentials, so every prompt fails with `MISSING_CREDENTIAL` before any tool call — no waterfall ever appeared (`grep -c waterfall /tmp/probe/probe2.out` → 0). Shape from `dsh-api-gateway/lib/types/stream-protocol.d.ts` plus `dsh-api-gateway/lib/index.js` (§lines 853–898):

```ts
// Host -> client, on the $events stream
{ type: 'waterfall', event: string, eventId: RemoteEventId, agentId: RemoteEventAgentId, request: Record<string, unknown> }
// note: request never contains `agent` or `signal`; agentId is an opaque agent id (not a session id)
{ type: 'cancel', eventId: RemoteEventId }        // Host withdrew a pending waterfall
// ready: { type:'ready', clientId: RemoteEventClientId, host:{ home:string } }
```

Semantics **[source-derived]**: the Host delivers the same waterfall to *every* live `$events` client; all deliveries must answer (or be cancelled) before the Host continues the chain; the first client answering `kind:'result'`/`kind:'rejected'` settles it, `kind:'next'` only removes that client's delivery. On settle/cancel the Host sends `{type:'cancel',eventId}` to all clients that held it.

### 5.2 The exact HTTP call that answers one

Client pump code (`dsh-api-gateway/lib/client.js:867`): `await this.connection.rpc.call('/api', '$events/result', { args: result }, signal)` where

```ts
result = { clientId, eventId, outcome }
outcome = { kind:'next' } | { kind:'result', value?: unknown } | { kind:'rejected', error:{ name, message, code?, details? } }
```

HTTP form (verified live — request/response below from `/tmp/probe/probe3.out` lines 21–31):

```
POST /api/$events/result
{"type":"client-request","rpcId":"p17o10vi5","method":"$events/result","payload":{"args":{"clientId":"not-a-real-client","eventId":"x","outcome":{"kind":"next"}}}}
{"ok":false,"error":{"code":"gateway/internal","message":"typert gateway: Remote event result identifies no active event stream","details":{}}}

POST /api/$events/result
{"type":"client-request","rpcId":"pvjwn2uxu","method":"$events/result","payload":{"args":{"clientId":"417a8392-962f-412f-a2e7-f1d7a806891c","eventId":"not-a-real-event","outcome":{"kind":"next"}}}}
{"ok":true}

POST /api/$events/result
{"type":"client-request","rpcId":"pq6b3nw4d","method":"$events/result","payload":{"args":{"clientId":"417a8392-…","eventId":"not-a-real-event","outcome":{"kind":"result","value":{"answered":true}}}}}
{"ok":true}
```

`clientId` must be the id from the live `$events` **ready** frame (else `gateway/internal`); an unknown `eventId` is silently accepted (`{"ok":true}`) because the result is only applied to a pending delivery.


## 6. Auth and trust for a non-browser client (question 5)

### 6.1 Cookie name and value

**[source-derived]** `dsh-client-connection/lib/index.js`:
`cookieName(authority) = "dsh-auth-" + base64url(sha256(authority))` where `authority` is the normalized `Host` header (`new URL('http://'+host).host`). Verified:

```
$ node -e "…createHash('sha256').update('127.0.0.1:3199')…"
dsh-auth-4KcFyUpuPFWyats9RsEmjakiryMY5kbrh1G5WpNRe10
$ curl -sv -c cookies -o /dev/null "http://127.0.0.1:3199/?token=t_MyJn…"
< HTTP/1.1 303 See Other
< location: ./
< set-cookie: dsh-auth-4KcFyUpuPFWyats9RsEmjakiryMY5kbrh1G5WpNRe10=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzE5OSIsImlzc3VlZEF0IjoxNzkxNzM0OTE5NTE0LCJleHBpcmVzQXQiOjE3OTQzMjY5MTk1MTR9.EVET-eh3-oYI4lf4r9W-muh_B-OCX1H8qnGgdMg-Wzs; Max-Age=2592000; Path=/; Expires=Tue, 10 Nov 2026 16:08:39 GMT; HttpOnly; SameSite=Strict
```

Value format: `v1.<base64url(JSON payload)>.<base64url(HMAC-SHA256(secret, base64url(JSON payload)))>` with payload `{"version":1,"authority":"127.0.0.1:3199","issuedAt":<ms>,"expiresAt":<ms>}`. The cookie is **bound to the exact authority string** — presenting the same cookie with `Host: localhost:3199` answered `401 unauthorized` (verified), because both the cookie *name* and the signed `authority` field must match the request's Host.

### 6.2 Where the secret lives, and minting a cookie without the launch token

The HMAC secret is persisted (mode 600) in `$DSH_HOME/.credentials.yaml`:

```yaml
version: 1
records:
  client-connection/browser-session:
    kind: grant
    payload:
      version: 1
      secret: oJ5GU316DUMXfLRHaltIAy46O5lw3w6B7u2Agvx-nb0   # base64url, 32 bytes
```

Verified: a client that reads this file, computes the cookie name for the connect authority and signs the payload with HMAC-SHA256 is accepted **without ever exchanging the launch token** (`/tmp/probe/probe2.mjs`, first HTTP call answered 200):

```
MINTED_COOKIE dsh-auth-4KcFyUpuPFWyats9RsEmjakiryMY5kbrh1G5WpNRe10=v1.eyJ2ZXJzaW9uIjoxLCJhdXRob3JpdHkiOiIxMjcuMC4wLjE6MzE5OSIsImlzc3VlZEF0IjoxNzkxNzM1MDE3NTk1LCJleHBpcmVzQXQiOjE3OTQzMjcwMTc1OTV9.S0RPiG4L7E1ECEaRbZwjrFwInWgnJL2skHqlpVw0GQ8
>>> HTTP session/list minted-cookie status=200
```

The **launch token cannot be re-derived**: it is `base64url(randomBytes(32))` generated in process memory per activation and never written to disk (`grep` found no trace in `/tmp/probe-home`). If the client has the token (user pasted the printed URL, or the client spawned the host and captured stdout) it can instead do `GET /?token=<token>` and read `set-cookie` — Node's fetch surfaces `Set-Cookie` even though browsers hide it (`HttpOnly`).

### 6.3 Minimum headers per transport

| Transport | Required | Rejected |
|---|---|---|
| `POST /api/<ep>` | `Host` (loopback/trusted), valid authority-bound cookie, `content-type: application/json` | no cookie → `401 unauthorized`; foreign Host ⇒ `403 forbidden`; `Origin` present but ≠ Host ⇒ `403`; `sec-fetch-site: cross-site` ⇒ `403`; wrong content type ⇒ `415` |
| `GET /?token=…` | `Host`, exactly one `token` query param, method GET, path `/` | else `401` |
| `WS /api/remote.mux` | `Host`, cookie | no cookie → HTTP `401` on upgrade; foreign Host ⇒ `403`; cross Origin ⇒ `403` |

`Origin` is optional for a Node client. Trusted hosts beyond loopback only via the host's `trustedHosts` config (`isTrustedApiRequest`, `dsh-client-connection/lib/index.js:205`).

### 6.4 Practical recipe for `--connect http://127.0.0.1:<port>`

1. Probe `GET /` with no cookie: `401` means auth is required (it is, for `dsh web`).
2. If the user can supply the launch URL: `GET <url>?token=<t>` and keep the `Set-Cookie` value (`303`). Then use `Cookie: <name>=<value>` for `/api` and the WS.
3. If the client runs on the same machine and can read `$DSH_HOME/.credentials.yaml` (DSH_HOME is the host's home dir; default `~/.dsh`), mint the cookie itself: `name = "dsh-auth-"+b64url(sha256(authority))`, `body = b64url(JSON.stringify({version:1,authority,issuedAt:Date.now(),expiresAt:Date.now()+30*86400000}))`, `cookie = "v1."+body+"."+b64url(hmac_sha256(secret, body))`. This worked against a real host.
4. A cookie-less client can do nothing else: the only unauthenticated endpoint is `/` (401 without token/cookie) and static assets under the same auth.


## 7. Stream inventory

All seven streams named in the brief are confirmed `mode:"stream"` in the descriptor dump and must be opened over `/api/remote.mux`; the full stream set in this install is 13:

```
account/watch, account/watchExpiry, job/follow, job/list, session/control, session/follow,
terminal/follow, terminal/retain, workspace/follow, workspaceFiles/changes,
productAnalytics/watchPolicy, speech/follow, userQuestions/attachWait
```

Their exact wire args (from the generated table in §2): `session/control` `{}`; `session/follow` `{"request":{"address":… ,"maxMessages?","turnWindow?","assistantStream?":true}}`; `workspace/follow` `{}`; `job/list` `{"request":{"sessionId"}}`; `job/follow` `{"request":{"jobId","sessionId?","from?"}}`; `userQuestions/attachWait` `{"agentId","callId"}`; `terminal/follow` `{"agentId","id","attachmentId"}`.
Evidence that streams are WS-only: `POST /api/session/control` → `{"ok":false,"error":{"code":"gateway/signature-invalid","message":"typert gateway: session/control: stream Remote methods must be opened through the stream carrier",…}}`; and `open` of `session/list` on the WS mux → `gateway/signature-invalid … unary Remote methods cannot be opened through the stream carrier` (`/tmp/probe/probe4.mjs`, `/tmp/probe/probe5.mjs`).

## 8. Reproduction

Scripts (all under `/tmp/probe/`, run with `node`, host on port 3199):

| script | purpose |
|---|---|
| `ws-probe.mjs` | token exchange, no-cookie HTTP/WS refusals, first `$events` transcript, `session/create`, `session/list`, `session/control` baseline, follow/job/list validation errors |
| `probe2.mjs` | minted cookie, fence tests, lookup probes, WS transcript with prompt + `assistant-stream` frames |
| `probe3.mjs` | WS admission matrix, `job/list` with sessionId, `workspace/follow`, `userQuestions/attachWait`, `$events/result` path checks |
| `probe4.mjs` | args exact-match errors, stream-over-HTTP error, raw Host/authority/content-type tests |
| `probe5.mjs` | extra args, unary-over-WS, `end`/`cancel`, duplicate-streamId close 1008 |
| `shapes.mjs` | regenerates the §2 table (reads `/tmp/apidump/invocations.json` + `/tmp/dshref-02/node_modules/@deepseek-ai/*/lib/**/*.d.ts`) |
| `extract.mjs` | one-off descriptor lookup helper |

Raw outputs: `/tmp/probe/ws-probe.out`, `/tmp/probe/probe2.out`, `/tmp/probe/probe3.out`, `/tmp/probe/probe4.out` (stdout), `/tmp/probe/shapes-body.md`, `/tmp/probe/shapes-appendix.md`.
Host launch (kept identical to the brief):

```
cd /tmp/dshref-02 && DSH_HOME=/tmp/probe-home node node_modules/@deepseek-ai/dsh/lib/bin.js web --port 3199 --no-open
# then: TOKEN=$(sed -n 's/.*token=//p' log); curl -c /tmp/probe-cookies.txt "http://127.0.0.1:3199/?token=$TOKEN"
```

## 9. Not verified / open items

1. **Real waterfall frames** (`approval/request`, `user-questions/request`): not triggered — needs a model turn with credentials. Frame shapes in §5.1 are source-derived; the answering HTTP path (§5.2) was exercised against a live `$events` client but with only synthetic `eventId`s.
2. **`terminal/follow` frames** and `terminal/*` happy paths: not exercised (would need a created terminal; the required args were confirmed only by descriptor).
3. **Subagent addressing** (`SessionAddress {kind:'subagent',…}` in `session/follow`/`session/page`) and lookup `agentId` values that name *child* sessions: not exercised.
4. **Multiple `$events` clients / multiple deliveries per waterfall**: not exercised.
5. `speech/follow`, `workspaceFiles/changes`, `account/watch`, `productAnalytics/watchPolicy`, `terminal/retain` frames: not exercised.
6. WebSocket ping/pong control frames: not observed as data frames (the `ws` client answers pings transparently); only text messages are part of the app protocol.


## Appendix A: referenced type declarations

#### SessionListRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionListRequest {
    readonly cursor?: string;
}

```

#### AbortSignal
(no named interface/type declaration found)

#### SessionListValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionListValue {
    readonly items: readonly SessionSummary[];
}

```

#### SessionSearchRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionSearchRequest {
    readonly query: string;
}

```

#### SessionSearchValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionSearchValue {
    readonly items: readonly SessionSearchItem[];
    readonly hasMore: boolean;
}

```

#### SessionCreateRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionCreateRequest {
    readonly workspaceId?: WorkspaceId;
    readonly cwd?: string;
    readonly sessionId?: SessionId;
    readonly agentPreset?: string;
}

```

#### SessionCreateValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionCreateValue {
    readonly sessionId: SessionId;
    readonly agentPreset?: string;
}

```

#### SessionRenameRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionRenameRequest {
    readonly sessionId: SessionId;
    readonly title: string;
}

```

#### SessionRenameValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionRenameValue {
    readonly title: string;
    readonly seq: number;
}

```

#### SessionForkRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionForkRequest {
    readonly sessionId: SessionId;
    /** Exact inclusive source event seq; omission selects the latest completed-turn prefix. */
    readonly atSeq?: number;
}

```

#### SessionForkValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionForkValue {
    readonly sessionId: SessionId;
}

```

#### SessionPromptRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionPromptRequest {
    /** Client-minted identity persisted on the exact accepted user message. */
    readonly requestId: SessionRequestId;
    readonly sessionId: SessionId;
    readonly mode: 'queue' | 'steer';
    /** At least one non-whitespace text part or attachment. */
    readonly content: readonly PromptContentPart[];
    readonly clientTimeZone?: string;
}

```

#### SessionPromptValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionPromptValue {
    readonly accepted: true;
}

```

#### SessionCancelRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionCancelRequest {
    readonly sessionId: SessionId;
}

```

#### SessionCancelValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionCancelValue {
    readonly accepted: true;
}

```

#### SessionAttachmentRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionAttachmentRequest {
    readonly sessionId: SessionId;
    readonly attachmentId: AttachmentIdType;
}

```

#### SessionAttachmentValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionAttachmentValue {
    readonly attachment: ImageAttachmentRef;
    readonly data: string;
}

```

#### SessionUpdateQueueRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionUpdateQueueRequest {
    readonly sessionId: SessionId;
    readonly itemId: MessageId;
    readonly action: QueueAction;
}

```

#### SessionUpdateQueueValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionUpdateQueueValue {
    readonly accepted: true;
}

```

#### SessionPageRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionPageRequest {
    readonly address: SessionAddress;
    /** Inclusive log cut obtained from the corresponding follow opening frame. */
    readonly throughSeq: number;
    readonly beforeSeq?: number;
    readonly maxMessages?: number;
    /** Stop at a Turn start after both minima, unless maxMessages or history exhaustion wins. */
    readonly turnWindow?: {
        /** Minimum append-origin user/assistant messages; must not exceed maxMessages. */
        readonly minMessages: number;
        /** Minimum Turn starts crossed, including the partial Turn at beforeSeq. */
        readonly minTurns: number;
    };
}

```

#### SessionPage
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionPage {
    readonly records: readonly SessionHistoryRecord[];
    readonly hasMore: boolean;
}

```

#### SessionProjectionsRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionProjectionsRequest {
    readonly sessionId: SessionId;
}

```

#### SessionProjectionsValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export type SessionProjectionsValue = SessionProjectionBaseline | null;

```

#### ModelCatalog
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface ModelCatalog {
    readonly default: ModelSelection;
    /** Provider routes with at least one currently available catalog model. */
    readonly routableProviders: readonly string[];
    readonly groups: readonly ModelProviderGroup[];
    readonly failures: readonly ModelCatalogFailure[];
}

```

#### SessionSelectModelRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionSelectModelRequest extends ModelSelection {
    readonly sessionId: SessionId;
}

```

#### SessionSelectModelValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionSelectModelValue {
    readonly selected: ModelSelection;
}

```

#### SessionOpenWorkspacePathRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionOpenWorkspacePathRequest {
    /** File-manager navigation when requested; omission uses the default application. */
    readonly action?: 'reveal';
    /** Registered application identifier; ignored for reveal. Omission preserves the operating system default. */
    readonly application?: string;
    /** Path after best-effort Session workspace resolution, in Host filesystem syntax. */
    readonly path: string;
}

```

#### SessionOpenWorkspacePathValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionOpenWorkspacePathValue {
    readonly opened: true;
}

```

#### SessionWorkspacePathApplication
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export type SessionWorkspacePathApplication = NativeFileApplication;

```

#### SkillListRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SkillListRequest {
    readonly sessionId: SessionId;
}

```

#### SkillListValue
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SkillListValue {
    readonly skills: readonly SkillEntry[];
}

```

#### AgentPresetRoster
// file: dsh-agent-preset-registry/lib/types/types.d.ts

```ts

export interface AgentPresetRoster {
    /** Every current declaration, including activation failures. */
    readonly presets: readonly AgentPresetRow[];
}

```

#### AgentPresetDocument
// file: dsh-agent-preset-registry/lib/types/types.d.ts

```ts

export interface AgentPresetDocument {
    /** The preset the composition belongs to. */
    readonly agentPreset: string;
    /** The declared child plugin list as entry-list YAML, `!!js` expressions included. */
    readonly content: string;
    /** Display name the preset published. */
    readonly name?: string;
    /** One sentence on what this preset is for. */
    readonly description?: string;
}

```

#### SessionId
// file: dsh-session/lib/types/types.d.ts

```ts

export type SessionId = Branded<'SessionId'>;

```

#### WorkspaceCreateRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceCreateRequest {
    readonly path: string;
}

```

#### WorkspaceCreateValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceCreateValue {
    readonly workspace: WorkspaceView;
    readonly created: boolean;
}

```

#### WorkspaceRenameRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceRenameRequest {
    readonly workspaceId: WorkspaceId;
    readonly title: string;
}

```

#### WorkspaceValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceValue {
    readonly workspace: WorkspaceView;
}

```

#### WorkspaceDeleteRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceDeleteRequest {
    readonly workspaceId: WorkspaceId;
}

```

#### WorkspaceDeleteValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceDeleteValue {
    readonly deleted: true;
}

```

#### WorkspaceInsertBeforeRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceInsertBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly beforeWorkspaceId?: WorkspaceId;
}

```

#### WorkspaceOrderValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceOrderValue {
    readonly workspaceIds: readonly WorkspaceId[];
}

```

#### WorkspaceInsertSessionBeforeRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceInsertSessionBeforeRequest {
    readonly workspaceId: WorkspaceId;
    readonly sessionId: SessionId;
    readonly beforeSessionId?: SessionId;
}

```

#### WorkspaceArchiveSessionRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceArchiveSessionRequest {
    readonly sessionId: SessionId;
    /**
     * Stop the Session's running work — its turn, subagent descendants, owned
     * background jobs, and active schedules — instead of refusing the archive
     * as `workspace/session-active`. The stops are requested before the
     * archive write and are not awaited; the response arrives once the archive
     * set is durable.
     */
    readonly stopActivity?: boolean;
}

```

#### WorkspaceArchiveValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceArchiveValue {
    readonly archivedSessionIds: readonly SessionId[];
}

```

#### WorkspaceUnarchiveSessionRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceUnarchiveSessionRequest {
    readonly sessionId: SessionId;
}

```

#### WorkspacePinSessionRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspacePinSessionRequest {
    readonly sessionId: SessionId;
}

```

#### WorkspacePinValue
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspacePinValue {
    readonly pinnedSessionIds: readonly SessionId[];
}

```

#### WorkspaceUnpinSessionRequest
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export interface WorkspaceUnpinSessionRequest {
    readonly sessionId: SessionId;
}

```

#### DirectoryListing
// file: dsh-host-directory-picker/lib/types/types.d.ts

```ts

export interface DirectoryListing {
    /** Absolute path of the listed directory. */
    path: string;
    /** The host account's home directory (breadcrumb "Home" rooting). */
    home: string;
    /**
     * Ancestor chain from the filesystem root to the listed directory
     * inclusive; every crumb is a jump target (crumb `hidden` is always false).
     */
    crumbs: DirectoryEntry[];
    /** Direct child directories, name-sorted; symlinks to directories included. */
    entries: DirectoryEntry[];
    /**
     * True when the backend cut `entries` at its complete-result bound: the
     * level has more child directories than reported, and the missing rows are
     * the name-sorted tail (hidden rows count toward the bound).
     */
    truncated: boolean;
}

```

#### GoalView
// file: dsh-goal/lib/types/types.d.ts

```ts

export interface GoalView extends GoalSnapshot {
    /** Highest admitted round number for this goal. */
    readonly roundsStarted: number;
    /** Epoch milliseconds of the create mutation. */
    readonly createdAt: number;
    /** Epoch milliseconds of the latest mutation. */
    readonly updatedAt: number;
    /** Process-local continuation eligibility; never persisted. */
    readonly activation: GoalActivation;
}

```

#### CreateGoalRequest
// file: dsh-goal/lib/types/types.d.ts

```ts

export interface CreateGoalRequest {
    readonly objective: string;
    readonly maxGoalRounds?: number;
}

```

#### CreateGoalResult
// file: dsh-goal/lib/types/types.d.ts

```ts

export interface CreateGoalResult {
    readonly ref: GoalRef;
}

```

#### GoalRef
// file: dsh-goal/lib/types/types.d.ts

```ts

export interface GoalRef {
    /** Stable goal identity. */
    readonly id: GoalId;
    /** Positive revision; every durable mutation increments it. */
    readonly revision: number;
}

```

#### EditGoalRequest
// file: dsh-goal/lib/types/types.d.ts

```ts

export interface EditGoalRequest {
    readonly objective?: string;
    readonly maxGoalRounds?: number;
}

```

#### SettingsDescribeValue
// file: dsh-settings/lib/types/types.d.ts

```ts

export interface SettingsDescribeValue {
    /** Whether the profile accepts writes; `false` disables every write control. */
    writable: boolean;
    /** Whether the configuration editor owns a local document, without exposing its Host path. */
    hasDocument: boolean;
    /** One view per profile plugin entry. */
    namespaces: SettingsNamespaceView[];
}

```

#### JsonValue
// file: dsh-util-values/lib/types/index.d.ts

```ts

export type JsonValue = null | boolean | number | string | JsonValue[] | {
    [key: string]: JsonValue;
};

```

#### SettingsNamespaceView
// file: dsh-settings/lib/types/types.d.ts

```ts

export interface SettingsNamespaceView {
    /** Generate a page if no custom page is registered for this instance. */
    autoGenerate: boolean;
    /** Namespace key (`llm-deepseek`, `llm-pi-ai`, …). */
    ns: string;
    /** Serialized schemastery schema envelope (`schema.toJSON()`); rehydrate with `new Schema(json)`. */
    schema: JsonValue;
    /** Redacted resolved value (schema defaults → composition base → user layer). */
    value: JsonValue;
    /** Redacted composition base layer, with defaults resolved. */
    base?: JsonValue;
    /** Redacted raw user section, when one exists; a field's presence here marks it user-overridden. */
    user?: JsonValue;
    /** When the owner applies changes. */
    applies: 'live';
    /** Every schema-declared secret slot with its configured state. */
    secrets: SettingsSecretView[];
    /**
     * Monotonic revision of the raw entry configuration this view was read at. Send it
     * back as `expectedRevision` on a write so a stale editor is refused rather
     * than silently overwriting a concurrent change.
     */
    revision: number;
}

```

#### SettingsPathOpView
// file: dsh-settings/lib/types/types.d.ts

```ts

export type SettingsPathOpView = {
    op: 'set';
    path: string[];
    value: JsonValue;
} | {
    op: 'unset';
    path: string[];
};

```

#### SettingsDocumentOpenValue
// file: dsh-api-settings-controller/lib/types/types.d.ts

```ts

export interface SettingsDocumentOpenValue {
    readonly opened: true;
}

```

#### CredentialInfo
// file: dsh-credentials/lib/types/types.d.ts

```ts

export interface CredentialInfo {
    /** Whether resolving the reference would currently return a value. */
    configured: boolean;
    /** Source layer currently supplying the value; absent while unconfigured. */
    source?: string;
    /** Whether the active provider can write this reference. */
    writable: boolean;
}

```

#### LlmProviderInfo
// file: dsh-llm/lib/types/types.d.ts

```ts

export interface LlmProviderInfo {
    /** Provider route key used by {@link GenerateOptions.provider}. */
    id: string;
    /** Human-readable provider name for selectors and diagnostics. */
    name: string;
}

```

#### LlmConfigurableProvider
// file: dsh-llm/lib/types/types.d.ts

```ts

export interface LlmConfigurableProvider {
    /** Provider route key this entry activates when configured. */
    provider: string;
    /** Human-readable provider name for configuration surfaces. */
    displayName: string;
    /** User-settings namespace whose section configures this provider. */
    settingsNs: string;
    /**
     * Path from that namespace's section root to this provider's profile
     * object; empty when the whole section is the profile.
     */
    settingsPath: readonly string[];
    /**
     * Whether the owning adapter knows this route only because configuration
     * declared it — a gateway or self-hosted server it ships nothing about.
     * Absent means the adapter draws no such distinction; false means it does
     * and this route is one of its own. Only the adapter can answer: a stored
     * profile is how a user-added route AND a corrected shipped one both look
     * from outside.
     */
    declared?: boolean;
    /** Configuration diagnostic for repair; unaffected models may remain serviceable. */
    error?: string;
}

```

#### LlmModelDiscoveryRequest
// file: dsh-llm/lib/types/types.d.ts

```ts

export interface LlmModelDiscoveryRequest {
    /**
     * Route the draft is editing, when it edits an existing one. A route whose
     * adapter already knows its models answers from that knowledge instead of
     * asking the endpoint — the adapter's own registry is the better answer, and
     * it costs no network call.
     */
    provider?: string;
    /**
     * Endpoint to interrogate. Optional because a route the adapter already
     * describes needs none; a route it does not must supply one.
     */
    baseURL?: string;
    /** Wire protocol the endpoint speaks, when the draft names one. */
    api?: string;
    /** Credential for this interrogation alone; the harness never stores it. */
    apiKey?: string;
}

```

#### LlmDiscoveredModel
// file: dsh-llm/lib/types/types.d.ts

```ts

export interface LlmDiscoveredModel {
    /** Model id the endpoint accepts. */
    id: string;
    /** Human-readable name when the endpoint supplies one. */
    name?: string;
    /** Maximum combined request and response context, when disclosed. */
    contextWindow?: number;
    /** Maximum output tokens, when disclosed. */
    maxTokens?: number;
    /** Accepted input types when disclosed by the catalog or endpoint; absent means unknown. */
    inputModalities?: readonly ModelModality[];
}

```

#### PluginInventorySnapshot
// file: dsh-host-plugin-inventory/lib/types/types.d.ts

```ts

export interface PluginInventorySnapshot {
    /** Whether this Host exposes persistent current-profile management. */
    readonly managementAvailable?: boolean;
    readonly entries: readonly PluginInventoryEntry[];
    /**
     * Per-preset compositions, present only when an agent-preset roster is
     * composed in this deployment.
     */
    readonly agentPresets?: readonly AgentPresetPluginGroup[];
}

```

#### MessageFeedbackListRequest
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export interface MessageFeedbackListRequest {
    /** Session whose feedback events should be read. */
    readonly sessionId: SessionId;
}

```

#### MessageFeedbackListResult
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export type MessageFeedbackListResult = MessageFeedbackSuccess<MessageFeedbackListValue> | MessageFeedbackRejected<MessageFeedbackSessionNotFound>;

```

#### MessageFeedbackPutRequest
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export interface MessageFeedbackPutRequest {
    /** Persisted Session that owns the target message. */
    readonly sessionId: SessionId;
    /** Target assistant-message identity. */
    readonly messageId: MessageId;
    /** Desired overall judgment. */
    readonly rating: MessageFeedbackRating;
    /** Optional non-blank explanation. */
    readonly note?: string;
    /** Optional category; absent keeps the item uncategorized. */
    readonly category?: FeedbackCategory;
    /** Observed item version, or `null` to require that no item exists. */
    readonly ifVersion: MessageFeedbackVersion | null;
}

```

#### MessageFeedbackPutResult
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export type MessageFeedbackPutResult = MessageFeedbackSuccess<MessageFeedbackItem> | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackTargetNotFound | MessageFeedbackVersionConflict | MessageFeedbackNoteBlank | MessageFeedbackNoteTooLarge>;

```

#### MessageFeedbackDeleteRequest
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export interface MessageFeedbackDeleteRequest {
    /** Session that owns the feedback. */
    readonly sessionId: SessionId;
    /** Message whose feedback should be absent after this operation. */
    readonly messageId: MessageId;
    /** Observed item version; ignored when the item is already absent. */
    readonly ifVersion: MessageFeedbackVersion;
}

```

#### MessageFeedbackDeleteResult
// file: dsh-message-feedback/lib/types/types.d.ts

```ts

export type MessageFeedbackDeleteResult = MessageFeedbackSuccess<MessageFeedbackDeleteValue> | MessageFeedbackRejected<MessageFeedbackSessionNotFound | MessageFeedbackVersionConflict>;

```

#### JobKillRequest
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export interface JobKillRequest {
    /** Session whose job list carries the job; the fenced lookup reads as it. */
    readonly sessionId: SessionId;
    readonly jobId: JobId;
}

```

#### JobKillValue
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export interface JobKillValue {
    readonly outcome: 'requested' | 'already-finished';
}

```

#### SubagentPromptRequest
// file: dsh-subagent/lib/types/control-types.d.ts

```ts

export interface SubagentPromptRequest {
    /** Identity persisted on the accepted message, minted before the call. */
    readonly requestId: SubagentPromptRequestId;
    readonly parentSessionId: SessionId;
    readonly childSessionId: SessionId;
    /** Required discriminator retained from the browser control address. */
    readonly mode: 'continuable';
    /** Whether this message queues a later turn or targets the nearest step. */
    readonly delivery: 'queue' | 'steer';
    /**
     * Browser prompt parts delivered as the child's user message. The Host
     * admits and persists image parts before delivery, so the wire never
     * carries a durable attachment reference the caller could fabricate.
     */
    readonly content: readonly PromptContentPart[];
    /** Optional browser zone sampled for this exact human prompt. */
    readonly clientTimeZone?: string;
}

```

#### SubagentPromptReceipt
// file: dsh-subagent/lib/types/control-types.d.ts

```ts

export interface SubagentPromptReceipt {
    readonly messageId: MessageId;
}

```

#### SubagentInterruptReceipt
// file: dsh-subagent/lib/types/control-types.d.ts

```ts

export interface SubagentInterruptReceipt {
    readonly accepted: true;
}

```

#### ToolCallId
// file: dsh-client-ui-chat/lib/types/client/contract/store.d.ts

```ts

export type ToolCallId = string;

```

#### AskUserQuestionAnswer
// file: dsh-user-questions/lib/types/types.d.ts

```ts

export interface AskUserQuestionAnswer {
    /** Structured answers keyed by question id. */
    answers: AskUserQuestionAnswerItem[];
}

```

#### FileReferenceCandidate
// file: dsh-file-reference/lib/types/types.d.ts

```ts

export interface FileReferenceCandidate {
    /** User-facing path accepted by normal prompts and filesystem tools. */
    path: string;
    /** Directories keep completion open; files finish the mention. */
    kind: 'file' | 'directory';
}

```

#### SessionFeedbackRecordRequest
// file: dsh-command-feedback/lib/types/types.d.ts

```ts

export interface SessionFeedbackRecordRequest {
    /** Live Session the remark describes. */
    readonly sessionId: SessionId;
    /** Free-text remark; blank text is recorded as absent. */
    readonly text?: string;
    /** Category the human filed the remark under. */
    readonly category?: FeedbackCategory;
}

```

#### SessionFeedbackRecordResult
// file: dsh-command-feedback/lib/types/types.d.ts

```ts

export type SessionFeedbackRecordResult = {
    readonly ok: true;
    readonly value: SessionFeedbackRecordValue;
} | {
    readonly ok: false;
    readonly error: SessionFeedbackSessionNotFound;
};

```

#### RemoteStreamHandle
// file: dsh-typert-protocol/lib/types/types.d.ts

```ts

export interface RemoteStreamHandle<Out, In> extends AsyncIterable<Out> {
    /**
     * Send one uplink item. Items sent before the stream has opened are queued
     * and sent once the `open` frame is on the wire. A top-level `undefined`
     * travels as an `item` frame without `value`.
     * @param item - item the Host validates against the method's uplink codec.
     * @throws {Error} when the item is not a lossless JSON value, when `end()`
     * was called, or once the stream has terminated.
     */
    send(item: In): void;
    /** Half-close the uplink: the Host's `uplink()` iteration ends. Idempotent; ignored after termination. */
    end(): void;
    /**
     * Cancel the logical stream: send `cancel` unless a terminal frame has
     * arrived, and end the downlink iterator quietly. Breaking out of
     * `for await` early does the same.
     */
    dispose(): void;
}

```

#### SessionControlFrame
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export type SessionControlFrame = {
    readonly type: 'baseline';
    readonly value: SessionControlBaseline;
} | ({
    readonly type: 'projection';
} & SessionProjectionUpdate);

```

#### SessionFollowRequest
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export interface SessionFollowRequest extends Pick<SessionPageRequest, 'maxMessages' | 'turnWindow'> {
    readonly address: SessionAddress;
    /** Include process-local assistant presentation frames for the Web client. */
    readonly assistantStream?: true;
}

```

#### SessionFollowFrame
// file: dsh-api-session-controller/lib/types/types.d.ts

```ts

export type SessionFollowFrame = {
    readonly type: 'snapshot';
    readonly header: SessionWireHeader;
    readonly cursor: number;
    readonly records: readonly SessionHistoryRecord[];
    readonly hasMore: boolean;
    readonly projections: SessionProjectionBaseline;
    readonly assistantStream?: SessionAssistantStreamBaseline;
} | SessionEventEntry | {
    readonly type: 'assistant-stream';
    readonly frame: SessionAssistantStreamFrame;
};

```

#### WorkspaceFollowFrame
// file: dsh-api-workspace-controller/lib/types/types.d.ts

```ts

export type WorkspaceFollowFrame = {
    readonly type: 'baseline';
    readonly value: WorkspaceBaseline;
} | WorkspaceFollowIncrement;

```

#### JobListRequest
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export interface JobListRequest {
    readonly sessionId: SessionId;
}

```

#### JobListFrame
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export interface JobListFrame {
    readonly type: 'rows';
    readonly jobs: readonly JobView[];
}

```

#### JobFollowRequest
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export interface JobFollowRequest {
    /**
     * Owning session for the fenced read. Omitted for an unowned job, which any
     * caller may observe.
     */
    readonly sessionId?: SessionId;
    readonly jobId: JobId;
    /**
     * Absolute byte offset to resume from (a prior frame's `next`). Omitted, the
     * stream starts at the oldest retained byte.
     */
    readonly from?: number;
}

```

#### JobFollowFrame
// file: dsh-api-job-controller/lib/types/types.d.ts

```ts

export type JobFollowFrame = {
    readonly type: 'opened';
    readonly job: JobView;
    /** Offset the first `output` frame continues from. */
    readonly from: number;
} | {
    readonly type: 'output';
    readonly chunks: readonly JobChunk[];
    /** Offset to resume from after this frame. */
    readonly next: number;
    /** Bytes between the requested offset and `chunks` were already evicted. */
    readonly lossy?: true;
} | {
    readonly type: 'status';
    readonly job: JobView;
};

```

#### WebTerminalId
// file: dsh-api-terminal-controller/lib/types/types.d.ts

```ts

export type WebTerminalId = Branded<'WebTerminalId'>;

```

#### TerminalAttachmentId
// file: dsh-api-terminal-controller/lib/types/types.d.ts

```ts

export type TerminalAttachmentId = Branded<'TerminalAttachmentId'>;

```

#### TerminalFrame
// file: dsh-api-terminal-controller/lib/types/types.d.ts

```ts

export type TerminalFrame = {
    readonly type: 'snapshot';
    readonly sequence: number;
    readonly screen: string;
    readonly info: WebTerminalInfo;
} | {
    readonly type: 'output';
    readonly sequence: number;
    readonly data: string;
} | {
    readonly type: 'state';
    readonly info: WebTerminalInfo;
};

```

