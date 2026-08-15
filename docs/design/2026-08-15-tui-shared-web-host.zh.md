# Agent Note: TUI 共享 Web Host

Status: implemented

[English](2026-08-15-tui-shared-web-host.md) | 中文

## 问题

TUI 与 Web 运行于独立 Host 进程时可以读取相同的持久化 session 日志与 workspace 文件，但持久化并不会共享实时状态。workspace 注册表与 ApiProxy 事件流都属于进程本地状态，JSON 后端也没有跨进程写锁。因此，TUI mutation 可能让正在运行的 Web 客户端把 session 留在未分组区域，并让 transcript 停在它最后一次从本地观察到的事件处。

## 决策

独立安装的 `@zhangweiii/dsh-tui` 组合包在并发展示时优先使用一个既有 Web Host。启动时会探测 `http://127.0.0.1:3080`；`--connect <url>` 可选择另一个 origin，`--standalone` 则跳过探测。HTTP 只允许 loopback 名称和地址，其他 Host 必须使用 HTTPS。隐式目标不可用时会回退到既有同进程客户端；显式目标不可用时会终止启动，而不是静默打开第二个活跃 Host。

`RemoteApiClient` 使用 HTTP POST 承载 unary call，并使用 Web carrier 的两条 WebSocket downlink 承载 mux 与 Host 事件，从而实现 `IApiClient`。Web 浏览器与终端因此修改同一个 workspace 注册表，并订阅同一个 ApiProxy 实例。session 创建仍会先调用 `workspace.create`，再调用 `session.create({ workspaceId })`；但没有 `--cwd` 的远程 session 会使用 TUI 调用进程的当前目录，而不是 Web server 进程的目录。

两条 WebSocket downlink 都使用有界指数退避自动重连。mux 重开后会收到 `session/subscribed`；其 `lastSeq` 领先当前 transcript 时，controller 会向前分页重新读取 history，直到覆盖此前已观察的 sequence，再应用缓存的实时 frame。

TUI profile 仍会挂载本地 Host plane，因此同一个独立安装的组合包无需修改 launcher 或 profile template 就能执行后备路径。远程选择成功后，renderer 会把每一项 session 与 workspace operation 发送给远程客户端，并且不向 controller 提供任何本地专用扩展。未使用的本地 Host 无法混入选中的远程 session。

## 备选方案

### 通过持久化文件协调独立 Host

不采用。文件轮询无法重现临时 approval、question、running state、model partial output、queue change 或有序事件传递。增加跨进程锁只能保护存储写入，仍不能让进程本地 event emitter 与 workspace 注册表形成一个实时权威来源。

### 每次启动 TUI 都强制要求 Web Host

不采用。这样会移除无需端口的 standalone 行为，并让 Web bind 或 build failure 阻断只使用终端的工作。默认探测与显式 `--standalone` 会同时保留两种操作模式。

### 添加内置的 Web 与 TUI 组合 profile

不采用。随附 profile template 或 launcher 分支会让 TUI 进入 DSH 核心组合。远程选择保留在独立安装的插件内部，并复用既有 Web transport。

## 影响

- 两个客户端使用共享 Host 时，Web 会立即收到 TUI 创建的 workspace 归属和后续 session 事件。
- 自定义 Web 端口需要传入 `--connect`；默认探测刻意只覆盖随附 loopback origin。
- standalone TUI 保持隔离，不能与 Web 针对相同 Harness home 并发运行。
- Host 本地 download、message feedback、plugin inventory 与 dynamic Cordis control 仍无法通过远程 `IApiClient` 使用；TUI 会报告对应命令不可用，而不会调用自身的本地 Host。
- 远程特权配置调用继续遵循 Web carrier 的 trust policy。loopback 连接可以使用这些调用；非 loopback 部署仍受 Host 已配置 authority 限制。
