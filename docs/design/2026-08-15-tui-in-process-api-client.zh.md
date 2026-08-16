# Agent Note: TUI 同进程 API 客户端

Status: implemented

[English](2026-08-15-tui-in-process-api-client.md) | 中文

## 问题

DeepSeek Harness 需要一个交互式终端 surface，并复用 Web 产品的 domain 行为；trajectory 除外。终端必须让持久化 session、model routing、agent preset、workspace、流式工具 presentation、approval、question、skill、subagent 与 settings 和 Web 使用同一套业务合约。

浏览器 runtime 不是可移植的终端 runtime：它的状态与插件依赖浏览器渲染、浏览器 transport 和浏览器生命周期。[headless direct-core 入口](2026-08-09-headless-direct-core-entry-point.md)也持有另一种合约：它只运行一个全新 Agent 区间后退出，而交互式客户端需要恢复持久化 session，并回答 server 持有的 interaction。

## 决策

`@zhangweiii/dsh-tui` 是在 `dsh-base` 之上独立安装的 profile bundle。通用 `dsh plugin --profile <name> add <package>` 机制记录该包的 `dsh.bundle` 声明；CLI 和随附 profile 模板既不枚举也不依赖 TUI。它的组合挂载与 Web profile 相同的持久化 Host plane 和 per-session agent-preset roster，同时省略 HTTP server 和全部 browser-only row。产品范围明确不包含 trajectory。本决策在旧的树内 TUI 实现被移除后重新引入终端产品，但不会恢复其源码、SDK 脚手架或内置启动路径。

standalone renderer 构造 `new InProcessApiClient(ctx.apiProxy)`。这个轻量适配器直接调用 `ApiProxy` 的 typed operation 和异步事件迭代器，不绑定网络端口，也不引入第二份业务状态。Web 并发展示选择[共享 Web Host carrier](2026-08-15-tui-shared-web-host.md)；独立组合包与本地后备路径保持不变。

终端业务层只持有 controller projection：transcript row、assistant partial block、产物文件行、workflow run、命令、压缩与重试、projection 摘要、终端面板和当前可回答 interaction。`@earendil-works/pi-tui@0.84.2` 持有短暂的 editor、autocomplete、picker cursor 与 scroll state。根布局由 `TuiAltScreen` 和 `VStack` 固定为 `ScrollView` transcript、按需出现的 todo/activity、composer 与两行 footer；transcript 宽度不依赖侧栏。已完成的 assistant 与 reasoning row 使用 pi-tui `Markdown`，原始 HTML 保持为无行为文本，支持 OSC 8 的终端可以激活链接。备用屏幕、同步差分刷新、鼠标和触控板滚动、滚动条、选区复制、follow-end 和 terminal restore 都由 pi-tui 负责，本包不维护 ANSI repaint、布局测量或滚动偏移算法。`Editor` 负责 Unicode 编辑、删除、粘贴、撤销、历史与 slash autocomplete，`SelectList` 负责 session、model、preset、subagent、settings、provider/model 与 directory picker。产物文件从成功 mutation call 的 location 推导，workflow row 折叠 tool-workflow 持久事件族，其他 row 直接折叠共享持久事件；这些视图都不会形成第二份 domain state source。session 创建与 mutation、history、model、workspace、approval、question、goal、skill、subagent、settings 和 Host state 仍属于 ApiProxy operation。持久化 history 先于缓冲的 mux frame 应用，event sequence 是去重 key。subagent history 读取失败时不会提交新的导航目标。

有六项同进程能力刻意位于 `IApiClient` 之外：ApiProxy download surface、message feedback、plugin inventory、dynamic Cordis Host runner、宿主侧后台任务停止（/job-kill），以及权限 preset 切换。standalone TUI 直接接收其现有 Cordis service，而不重建业务逻辑。host-only dynamic package 使用 runner 的 direct user-run lifecycle。由于本 profile 没有浏览器 runtime，Client-half activation request 会被立即拒绝并 steer 回归属它的模型，而不是保持悬挂。renderer 选择远程 Host 时，这些直接扩展保持不可用；终端绝不会把远程 session state 与未使用的本地 Host service 混在一起。

终端原生管理命令只保留一组有文档的 slash command。未知 slash command 原样传给 `session.prompt`，从而保留共享的 Harness command 与 skill 路径。

新会话会解析显式目录或 Host 默认目录，通过 `workspace.create` 创建或复用对应 workspace，再使用该 workspace id 调用 `session.create`。恢复带目录记录的普通持久化会话时，TUI 会解析同一个 workspace，并使用 workspace id 与既有 session id 调用幂等创建 operation；该调用会挂载 cwd-only 历史，但不会改变 session identity。没有目录记录的会话仍保持未分组。

## 备选方案

### 复用浏览器 client runtime 与 React component

不采用。浏览器 plugin graph 带有 DOM、CSS、routing、transport 和浏览器生命周期假设。适配这些 component 会引入第二层平台模拟，而稳定的复用边界已经存在于 ApiProxy。

### 直接驱动 Agent 与 Session service

不采用。direct driver 会复制已经集中在 ApiProxy 后方的 resume、queue、model、approval、question、workspace、projection 与 subagent 规则，也会形成可能与 Web 漂移的客户端行为。

### 强制要求 Web HTTP carrier

不采用将其作为唯一 carrier。强制要求 listener 会移除 standalone 操作，并让无关的 Web bind failure 阻断终端使用。同进程 fetch carrier 保留为本地后备路径，并发操作则由[共享 Web Host 决策](2026-08-15-tui-shared-web-host.md)持有。

### 随附内置 `dsh tui` 别名和 profile 模板

不采用。启动器别名与安装目录持有的模板会让终端包进入 DSH release composition。现有 profile 插件机制已经提供安装、组合包发现与启动能力，无需在 CLI 或 profile loader 中增加 TUI 专用分支。

## 影响

- Web 与 TUI 的 domain 变更共享同一个 typed gateway 和 Host 实现；终端 presentation 可以针对键盘与受限宽度独立优化。
- 安装或移除 TUI 只改变所选用户 profile 的依赖和组合包列表。DSH 启动器源码没有 TUI 专用 runtime 路径。
- TUI 的 startup、resume、history/live stitching、prompt、cancel、approval 与 question 路径在 standalone 和共享 Host 模式下都会穿过真实 carrier 合约。
- Agent tool 与 prompt 仍由 preset 持有。TUI 不添加 model prefix；普通 prompt 与 service-owned context 通过和 Web 相同的持久化 Host 路径追加。
- 浏览器 UI component 不会自动进入终端。每个终端 mutation flow 都是现有 API 上明确的键盘或 command-panel affordance；browser Client half 和 DOM presentation control 则留在终端平台之外。
- 每个 TUI 进程只渲染一个选中的 transcript。其他 Host session 仍保持活跃，并可通过共享 session catalog 选择。
- TUI 创建的会话以及 TUI 恢复的带目录记录会话复用 Web 的 workspace 分组，同时不向常驻 footer 添加 workspace identity，也不引入第二套分组规则。
- standalone TUI 保留进程本地 Host，不能与 Web 针对相同持久化根目录并发运行。并发展示使用[共享 Web Host carrier](2026-08-15-tui-shared-web-host.md)，因此两个客户端接收同一个 workspace 注册表与事件流真源。
- TUI 挂载期间，终端 scrollback 保持在其视口之外；进程清理调用 `stop({ preserveScreen: true })`，由 pi-tui 恢复调用方的主屏幕、鼠标和键盘模式。
