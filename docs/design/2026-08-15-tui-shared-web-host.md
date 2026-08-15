# Agent Note: TUI shared Web Host

Status: implemented

English | [中文](2026-08-15-tui-shared-web-host.zh.md)

## Problem

TUI and Web can read the same persisted session logs and workspace files while running separate Host processes, but persistence does not make their live state shared. Workspace registries and ApiProxy event streams are process-local, and the JSON backend has no cross-process write lock. A TUI mutation can therefore leave a running Web client with an ungrouped session and a transcript that stops at its last locally observed event.

## Decision

The independently installed `@zhangweiii/dsh-tui` bundle prefers one existing Web Host for concurrent display. Startup probes `http://127.0.0.1:3080`; `--connect <url>` selects another origin, and `--standalone` skips the probe. Plain HTTP is accepted only for loopback names and addresses; every non-loopback Host requires HTTPS. An unavailable implicit target falls back to the existing in-process client. An unavailable explicit target fails startup instead of silently opening a second active Host.

`RemoteApiClient` implements `IApiClient` with HTTP POST for unary calls and the Web carrier's two WebSocket downlinks for mux and Host events. The Web browser and terminal therefore mutate one workspace registry and subscribe to one ApiProxy instance. Session creation still calls `workspace.create` followed by `session.create({ workspaceId })`, but a remote session without `--cwd` uses the TUI invocation's current directory rather than the Web server process's directory.

Both WebSocket downlinks reconnect with bounded exponential backoff. A reopened mux emits `session/subscribed`; when its `lastSeq` is ahead of the selected transcript, the controller refetches history pages back to the previously observed sequence before applying buffered live frames.

The TUI profile still mounts its local Host plane so the same independently installed bundle can fall back without a launcher or profile-template change. Once remote selection succeeds, the renderer sends every session and workspace operation to the remote client and supplies none of the local-only extensions to its controller. The unused local Host cannot be mixed into the selected remote session.

## Alternatives considered

### Coordinate separate Hosts through persisted files

Rejected. File polling cannot reproduce transient approvals, questions, running state, partial model output, queue changes, or ordered event delivery. Adding cross-process locking would protect storage writes but still would not turn process-local event emitters and workspace registries into one live authority.

### Require a Web Host for every TUI launch

Rejected. It would remove the port-free standalone behavior and make Web bind or build failures block terminal-only work. Default discovery plus explicit `--standalone` preserves both operation modes.

### Add a built-in combined Web-and-TUI profile

Rejected. A shipped profile template or launcher branch would make the TUI part of the core DSH composition. Remote selection stays inside the independently installed plugin and reuses the existing Web transport.

## Consequences

- Web receives TUI-created workspace membership and later session events immediately when both clients use the shared Host.
- A custom Web port requires `--connect`; the default probe is intentionally limited to the shipped loopback origin.
- Standalone TUI remains isolated and must not run concurrently with Web against the same Harness home.
- Host-local downloads, message feedback, plugin inventory, and dynamic Cordis control remain unavailable through the remote `IApiClient`; the TUI reports those commands as unavailable instead of invoking its local Host.
- Remote privileged configuration calls retain the Web carrier's trust policy. A loopback connection can use them; a non-loopback deployment remains subject to the Host's configured authority restrictions.
