# Agent Note: TUI in-process API client

Status: implemented

English | [中文](2026-08-15-tui-in-process-api-client.zh.md)

## Problem

DeepSeek Harness needs an interactive terminal surface with the Web product's domain behavior, except trajectory. The terminal must keep persisted sessions, model routing, agent presets, workspaces, streaming tool presentation, approvals, questions, skills, subagents, and settings on the same business contracts as Web.

The browser runtime is not a portable terminal runtime: its state and plugins assume browser rendering, browser transport, and browser lifecycle. The [headless direct-core entry point](2026-08-09-headless-direct-core-entry-point.md) also has a different contract: it owns one fresh Agent interval and exits, while an interactive client resumes durable sessions and answers server-owned interactions.

## Decision

`@zhangweiii/dsh-tui` is an independently installed profile bundle over `dsh-base`. The generic `dsh plugin --profile <name> add <package>` mechanism records the package's `dsh.bundle` declaration; the CLI and shipped profile templates neither enumerate nor depend on TUI. Its composition mounts the same persistent Host plane and per-session agent-preset roster as the Web profile, while omitting the HTTP server and every browser-only row. Trajectory is absent by product scope. This decision reintroduces a terminal product after the former in-tree TUI implementation was removed, but does not restore that source, its SDK scaffolding, or a built-in launcher path.

The standalone renderer constructs `new InProcessApiClient(ctx.apiProxy)`. This small adapter directly invokes the `ApiProxy` typed operations and asynchronous event iterators without binding a network port or introducing a second business-state owner. Concurrent Web display selects the [shared Web Host carrier](2026-08-15-tui-shared-web-host.md); the independent bundle and local fallback remain unchanged.

The terminal business layer owns only controller projections: transcript rows, partial assistant blocks, produced-file rows, workflow runs, command, compaction, and retry rows, projection summaries, terminal panels, and the current answerable interaction. `@earendil-works/pi-tui@0.84.2` owns ephemeral editor, autocomplete, picker-cursor, and scroll state. `TuiAltScreen` and `VStack` fix the root layout into the `ScrollView` transcript, on-demand todo/activity, composer, and two-line footer regions, so transcript width does not depend on a side rail. Settled assistant and reasoning rows use pi-tui `Markdown`; raw HTML remains inert text and terminals with OSC 8 support can activate links. pi-tui owns alternate-screen setup, synchronized differential rendering, mouse and trackpad scrolling, the scrollbar, selection, follow-end behavior, and terminal restoration; this package maintains no ANSI repaint, layout-measurement, or scroll-offset algorithm. `Editor` supplies Unicode editing, deletion, paste, undo, history, and slash autocomplete, while `SelectList` supplies session, model, preset, subagent, settings, provider/model, and directory pickers. Produced files derive from successful mutation-call locations, workflow rows fold the durable tool-workflow event family, and other rows fold shared durable events directly; none creates a second domain state source. Session creation and mutation, history, models, workspaces, approvals, questions, goals, skills, subagents, settings, and Host state remain ApiProxy operations. Durable history loads before buffered mux frames are applied, and event sequence is the deduplication key. A failed subagent history read does not commit the navigation target.

Four process-local capabilities intentionally sit outside `IApiClient`: the ApiProxy download surface, message feedback, plugin inventory, and the dynamic Cordis Host runner. Standalone TUI receives their existing Cordis services directly rather than recreating their business logic. Host-only dynamic packages use the runner's direct user-run lifecycle. Because this profile has no browser runtime, a Client-half activation request is rejected immediately and steered back to the owning model instead of remaining suspended. These direct extensions stay unavailable when the renderer selects a remote Host; the terminal never mixes remote session state with services from its unused local Host.

Terminal-native management commands reserve a small documented slash-command set. An unknown slash command passes unchanged to `session.prompt`, preserving the shared Harness command and skill path.

New sessions resolve the explicit directory or Host default, create or reuse its workspace through `workspace.create`, and call `session.create` with that workspace id. Resuming or continuing an ordinary stored session with a recorded directory resolves the same workspace and calls the idempotent create operation with both the workspace and existing session ids, which attaches cwd-only history without changing session identity. Sessions without a recorded directory remain ungrouped.

## Alternatives considered

### Reuse the browser client runtime and React components

Rejected. The browser plugin graph carries DOM, CSS, routing, transport, and browser lifecycle assumptions. Adapting those components introduces a second platform emulation layer while the stable reuse boundary already exists at ApiProxy.

### Drive Agent and Session services directly

Rejected. A direct driver duplicates resume, queue, model, approval, question, workspace, projection, and subagent rules already centralized behind ApiProxy. It also creates a client whose behavior can drift from Web.

### Require the Web HTTP carrier

Rejected as the only carrier. Requiring a listener would remove standalone operation and make an unrelated Web bind failure block terminal use. The in-process fetch carrier remains the local fallback, while the [shared Web Host decision](2026-08-15-tui-shared-web-host.md) owns concurrent operation.

### Ship a built-in `dsh tui` alias and profile template

Rejected. A launcher alias and installation-owned template make the terminal package part of the DSH release composition. The existing profile plugin mechanism supplies installation, bundle discovery, and launch without adding TUI-specific branches to the CLI or profile loader.

## Consequences

- Web and TUI domain changes share one typed gateway and one Host implementation; terminal presentation remains independently optimized for keyboard and constrained-width use.
- Installing or removing TUI changes only the selected user's profile dependencies and bundle list. The DSH launcher source has no TUI-specific runtime path.
- TUI startup, resume, history/live stitching, prompt, cancel, approval, and question paths cross the real carrier contract in both standalone and shared-Host modes.
- Agent tools and prompts remain preset-owned. The TUI adds no model prefix; ordinary prompts and service-owned context append through the same durable Host paths as Web.
- Browser UI components do not arrive automatically. Each terminal mutation flow is an explicit keyboard or command-panel affordance over the existing API, while browser Client halves and DOM presentation controls remain outside the terminal platform.
- The TUI renders one selected transcript per process. Other Host sessions remain active and selectable through the shared session catalog.
- TUI-created and TUI-resumed sessions with recorded directories share Web's workspace grouping without adding workspace identity to the persistent footer or a second grouping rule.
- Standalone TUI retains a process-local Host and must not run concurrently with Web against the same durable roots. Concurrent display uses the [shared Web Host carrier](2026-08-15-tui-shared-web-host.md), so both clients receive one workspace registry and one event-stream source.
- Terminal scrollback remains outside the TUI viewport while it is mounted; cleanup calls `stop({ preserveScreen: true })`, letting pi-tui restore the caller's main screen, mouse, and keyboard modes.
