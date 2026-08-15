# `@zhangweiii/dsh-tui`

English | [中文](README.zh.md)

An out-of-tree interactive terminal bundle for DeepSeek Harness. This directory is a self-contained npm package: it does not join or patch the DeepSeek Harness source workspace. Its [`cordis.patch.yml`](cordis.patch.yml) layers terminal Host services and the agent-preset roster over `dsh-base`, without mounting an HTTP server or browser runtime. At startup the renderer connects to a Web Host already listening at `http://127.0.0.1:3080`; when that address is unavailable it falls back to an `InProcessApiClient` over its own `ctx.apiProxy`.

## Usage

```sh
dsh plugin --profile tui add .
dsh --profile tui
dsh --profile tui "explain this repository"
dsh --profile tui --continue
dsh --profile tui --resume <session-id>
dsh --profile tui --cwd <path>
dsh --profile tui --connect http://127.0.0.1:8080
dsh --profile tui --standalone
```

Run the install command from this package directory. The installed `dsh` command initializes the `tui` profile with `dsh-base` and records this package's declared `dsh.bundle`; neither the CLI nor its built-in profile templates contain TUI-specific code. After a future registry release, `@zhangweiii/dsh-tui` may replace `.`. This repository has not published an npm release yet.

The package requires an installed `dsh 0.1.0-rc.6` or compatible host and does not ship a second copy of the DSH core modules.

The profile creates a persisted session by default and attaches it to the workspace for its working directory, creating or reusing that workspace record so Web lists the session in the same group. When the default Web Host is reachable, both clients use that Host's workspace registry and event streams; Web therefore receives the grouping mutation and every later session event live. `--connect` selects a non-default Web origin, while `--standalone` skips discovery and forces the isolated in-process Host. An explicit connection failure stops startup; implicit discovery failure falls back locally. A remote new session defaults to the TUI process's current directory rather than the Web process's directory.

Plain HTTP is limited to `localhost`, `*.localhost`, `127.0.0.0/8`, and `[::1]`; every other Host must use HTTPS and must be trusted by the user. An unexpectedly closed remote WebSocket reconnects automatically. When the new subscription reports a later durable sequence, the TUI refetches history to recover records committed while disconnected.

Resuming or continuing a stored root session with a recorded directory performs the same idempotent attachment, so an older cwd-only session joins that directory's workspace; a session without a recorded directory remains ungrouped. `--continue` selects the most recently updated root session and creates one when none exists; `--resume` selects an exact persisted id. `--resume` and `--continue` are mutually exclusive, as are `--connect` and `--standalone`. The application requires an interactive TTY.

The composer uses `@earendil-works/pi-tui`'s `Editor`: Enter queues a message, Alt+Enter steers the active turn, Shift+Enter inserts a newline, Escape clears the draft or cancels the active turn, Backspace/terminal DEL edits before the cursor, Up/Down traverses input history, and Ctrl+C exits. Built-in autocomplete proactively displays matches for a single slash token; Up/Down selects and Tab completes. Sessions, models, presets, subagents, setting namespaces, providers/models, and directory browsing use `SelectList` with Up/Down and Enter. Approval prompts accept `y` once or `n` to reject. Structured questions use a separate editor, preserving the ordinary composer draft, and accept option numbers, comma-separated multi-select numbers, or free text; Escape cancels the complete request.

`TuiAltScreen`, `VStack`, and `ScrollView` provide the fixed-height layout. pi-tui owns alternate-screen setup, synchronized differential updates, mouse and trackpad scrolling, the scrollbar, text selection, and terminal restoration; this package contains no terminal repaint or scroll-offset algorithm. The mouse wheel and PageUp/PageDown scroll the transcript, Ctrl+Shift+F searches it, Ctrl+Shift+Up/Down jumps between user prompts, and Ctrl+Shift+Home/End moves to its boundaries. Streaming follows the end only while the reader remains there, preserving a manually selected history position until the reader returns to the bottom.

## Terminal management commands

Commands owned by the TUI open a terminal-native panel. Other slash commands remain ordinary Harness commands or skill invocations.

| Command | Action |
|---|---|
| `/help`, `/status`, `/close` | Show command help, runtime and projection status, or close the current panel. |
| `/sessions [query]`, `/new [cwd]`, `/resume [id-or-prefix]` | Select, search, or create persisted sessions; `/sessions` and `/resume` without an id open a picker. |
| `/rename <title>`, `/fork [event-seq]`, `/older` | Rename, fork, or page backward through durable history. |
| `/archive [session-id] --yes`, `/export [path] [--descendants]` | Archive a session or export its logs and referenced media. |
| `/models`, `/model [provider/model] [effort]` | Select a model, or switch directly with an explicit route. |
| `/providers`, `/provider-models [provider]`, `/discover-models <settings-ns> …` | Select a provider/model or discover endpoint models. |
| `/presets`, `/preset [id]`, `/preset-read <id>` | Select a blank session's preset or inspect preset content. |
| `/preset-copy <source> <new-id> [name]`, `/preset-open <id>`, `/preset-remove <id> --yes` | Author and remove user presets through the shared preset service. |
| `/queue`, `/queue-edit <item-id> <text>`, `/queue-steer <item-id>` | Inspect and mutate pending inbox items by stable id. |
| `/queue-remove <item-id> --yes` | Remove one pending inbox occurrence. |
| `/workspaces`, `/workspace-new <path>`, `/workspace-rename <id> <title>` | Inspect, create, or rename workspace records. |
| `/workspace-move <id> [before-id\|end]`, `/workspace-session-move <id> <session-id> [before-id\|end]` | Reorder workspaces or their session entries. |
| `/workspace-delete <id> --yes` | Unregister a workspace without deleting its directory or session logs. |
| `/settings`, `/settings-show <ns> [--schema]`, `/settings-open` | Select a setting namespace, inspect its effective value and optional schema, or open the configuration file. |
| `/settings-set <ns> <json-pointer> <json>` | Update a setting through its revision guard. |
| `/settings-unset <ns> <json-pointer> --yes`, `/settings-reset <ns> --yes` | Remove a field or reset one namespace, including its stored secrets. |
| `/credentials <REF> …`, `/credential-set <REF> <VALUE_ENV_VAR>` | Inspect credentials or write one from an environment variable without putting its value in input history. |
| `/credential-unset <REF> --yes` | Remove a stored credential. |
| `/goal-show`, `/goal-edit <objective>`, `/goal-pause`, `/goal-resume`, `/goal-complete`, `/goal-clear --yes` | Inspect and mutate the projected goal through its revision guard. |
| `/skills`, `/subagents`, `/subagent [id-or-prefix]`, `/back` | Inspect skills, select and navigate child transcripts, continue a continuable child, and return. |
| `/feedback <message-id\|last> <positive\|negative> [note]`, `/feedback-clear <message-id\|last> --yes` | Create, replace, or remove assistant-message feedback. |
| `/image <path> [caption]`, `/image-steer <path> [caption]` | Admit a raster image through the Host and queue or steer it. |
| `/save-image <attachment-id> [path]` | Save a transcript image with create-only file semantics. |
| `/directories [path]`, `/mkdir <parent> <name>`, `/open <path>` | Browse, create, or ask the operating system to open paths. |
| `/plugins`, `/host` | Inspect the live Host plugin inventory and Host capabilities. |
| `/cordis`, `/cordis-run <plugin-id> [package-id]` | Inspect dynamic packages or run/update a Host-only package. |
| `/cordis-stop <plugin-id> --yes`, `/cordis-remove <plugin-id> --yes` | Stop a dynamic package or remove its complete definition. |

Paths containing whitespace can be quoted. Destructive commands require a trailing `--yes`. Export and image-save commands use create-only writes and refuse to overwrite an existing file. `/credential-set` reads the secret from the named environment variable, so the value never enters the terminal's command history or transcript.

Shared `/goal <objective>`, `/plan`, `/permission`, and `/compact` commands follow the Harness command or skill path like any other unknown slash command. Their durable lifecycle returns to the same transcript.

Conversation state comes from durable history plus the mux and Host streams. The terminal folds assistant text and reasoning, injected model context, command, compaction, and model-retry lifecycles, Host-provided tool presentation, successful mutation locations as deduplicated produced-file rows, durable workflow runs and their member status, stable assistant message ids, pending queue items, background jobs, todos, goal and other projection values, running state, and live errors. Settled assistant and reasoning text uses pi-tui `Markdown` for headings, emphasis, lists, quotes, code blocks, links, and tables; raw HTML is displayed as text and terminals with OSC 8 support expose clickable links, while the streaming tail remains compact plain text. There is no persistent header; a two-line footer below the composer retains the session title, agent preset, model, cwd, running state, cumulative tokens, session turns, and context occupancy, adding permissions and plan mode when width allows. The compact activity dock above the composer appears only for unfinished todos or active goal, queue, job, and workflow summaries. `/status` exposes the complete projection breakdown and image limits. `ScrollView` constrains the transcript by rendered lines, so long content cannot overwrite the fixed activity dock, editor, or footer. Produced paths can be passed directly to `/open`; unfinished tools and workflows become interrupted when their owning turn closes. The history/live boundary is sequence-deduplicated, surface replacements do not render compaction checkpoints twice, and answerable approval and question frames echo their original RPC identity.

## Model Experience

### Terminal prompt submission

#### What the model sees

This package adds no system prompt or tool schema. Text submitted in the terminal reaches `ApiProxy` as ordinary user content; the composed base bundle and selected agent preset own the system prompt, tools, and other model-visible context. Unknown slash commands follow the ordinary session prompt path. Terminal-native commands call the same Host business operations as Web; when an owning Host service deliberately queues user context, such as a goal or dynamic-Cordis lifecycle change, the model sees that service-owned context on its next step.

#### Token effect

Read-only terminal panels add zero model tokens. An ordinary prompt adds only the user content and the request envelope already owned by the active session composition. A Host mutation adds only any model-visible context already specified by that shared Host contract; the TUI adds no wrapper text of its own.

#### KV Cache effect

The terminal does not rewrite the request prefix. Ordinary prompts and Host-authored context append at the durable session boundary, while model or preset changes can affect reuse only through the Host-owned route and composition they select.

## Known Limitations and Deferred Work

- **Trajectory is intentionally absent** — this is the one Web feature outside the TUI parity target.
- **Browser Client halves are not emulated** — Host-only dynamic Cordis packages can run in the terminal. A model-driven package that requires a browser Client half is rejected immediately with an actionable result instead of leaving the turn suspended.
- **Browser appearance controls are not emulated** — DOM component slots, drag-and-drop, browser routing, and Web theme or locale controls are platform presentation rather than Host domain behavior. The TUI uses keyboard commands, filesystem paths, terminal colors, and the process locale instead.
- **Concurrent display requires the shared Web Host** — default discovery covers the shipped Web port. Pass `--connect` when Web listens elsewhere. `--standalone` retains the isolated Host path and must not run concurrently with Web against the same Harness home because process-local domain events and JSON storage do not coordinate across Host processes.
- **Some Host-local management commands remain standalone-only** — message feedback, session export, live plugin inventory, and dynamic Cordis control intentionally sit outside `IApiClient`; their TUI commands report that the capability is unavailable when the terminal is connected to a Web Host. Chat, grouping, history, models, projections, queue, approvals, questions, workspaces, settings, images, skills, goals, and subagents use the remote Host contract.
- **One selected session per terminal** — other sessions continue on the Host, but this process renders one transcript at a time and keeps only the current answerable interaction in its panel.
- **`ctx.appExit` is launcher-owned** — mounting the bundle outside `dsh` requires the host to provide the bounded exit request.
