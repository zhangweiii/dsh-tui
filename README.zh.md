# `@zhangweiii/dsh-tui`

[![npm](https://img.shields.io/npm/v/@zhangweiii/dsh-tui)](https://www.npmjs.com/package/@zhangweiii/dsh-tui) [![CI](https://github.com/zhangweiii/dsh-tui/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangweiii/dsh-tui/actions/workflows/ci.yml)

[English](README.md) | 中文

DeepSeek Harness 的树外交互终端组合包。该目录是一个可单独构建和安装的 npm 包，不加入、也不修改 DeepSeek Harness 源码 workspace。它的 [`cordis.patch.yml`](cordis.patch.yml) 在 `dsh-base` 之上叠加终端 Host 服务和 agent preset roster，但不挂载 HTTP server 或浏览器 runtime。renderer 启动时会连接已经监听 `http://127.0.0.1:3080` 的 Web Host；该地址不可用时，则回退到自身 `ctx.apiProxy` 上的 `InProcessApiClient`。

## 使用方式

```sh
dsh plugin --profile tui add @zhangweiii/dsh-tui
dsh --profile tui
dsh --profile tui "explain this repository"
dsh --profile tui --continue
dsh --profile tui --resume <session-id>
dsh --profile tui --cwd <path>
dsh --profile tui --connect http://127.0.0.1:8080
dsh --profile tui --standalone
```

安装命令会直接从 npm registry 拉取本包（本地检出也可以用 `add .` 安装）。已安装的 `dsh` 命令会用 `dsh-base` 初始化 `tui` profile，并记录本包声明的 `dsh.bundle`；CLI 和内置 profile 模板都不包含 TUI 专用代码。

本包要求宿主已经安装 `dsh 0.1.1-rc.2` 或兼容版本；发布包不会携带第二份 DSH 核心模块。

该 profile 默认创建一个持久化会话，并将它挂入工作目录对应的 workspace；系统会创建或复用该 workspace 记录，因此 Web 会把这条会话列在同一分组中。默认 Web Host 可达时，两个客户端使用该 Host 的 workspace 注册表与事件流；因此 Web 会实时收到分组变更以及后续每一条会话事件。`--connect` 可选择非默认 Web origin，`--standalone` 则跳过探测并强制使用隔离的同进程 Host。显式连接失败会终止启动；隐式探测失败会回退到本地。远程新会话默认使用 TUI 进程的当前目录，而不是 Web 进程的目录。

HTTP 连接只允许 `localhost`、`*.localhost`、`127.0.0.0/8` 和 `[::1]`；其他 Host 必须使用 HTTPS，且必须由用户信任。远程 WebSocket 意外断开时会自动重连；重新订阅发现持久化 sequence 前进后，TUI 会重新读取 history，补齐断线期间的记录。

恢复带目录记录的根会话时会执行相同的幂等挂载，因此既有 cwd-only 会话也会进入该目录的 workspace；没有目录记录的会话仍保持未分组。`--continue` 选择最近更新的根会话；没有可用会话时会新建。`--resume` 选择一个确切的持久化 id。`--resume` 与 `--continue` 互斥，`--connect` 与 `--standalone` 也互斥。应用要求交互式 TTY。

主输入区由 `@earendil-works/pi-tui` 的 `Editor` 提供完整终端编辑能力：Enter 将消息加入队列，Alt+Enter 对活跃 turn 插话，Shift+Enter 换行，Escape 清空草稿或取消活跃 turn，Backspace/终端 DEL 删除光标前的字符，Up/Down（或 Ctrl+N/Ctrl+P）浏览输入历史、移动光标，Ctrl+C 退出。输入单个 slash token 时，内置 autocomplete 会主动显示匹配命令；Up/Down（或 Ctrl+N/Ctrl+P）选择，Tab 完成。`@file` mention 使用同一个弹出列表：连接 Web Host 时，行首或空白之后的 `@` 令牌会查询宿主的文件引用索引（以会话 cwd 为边界）并渲染路径候选——选择文件即结束 mention，选择目录则保持补全打开，便于继续输入下一段路径。宿主服务不可用时——standalone 模式、断连或未挂载该服务的 Host——`@` 会静默回退到 pi-tui 的本地路径补全，不弹出错误、不打断输入。所有终端选择场景——会话、模型、preset、subagent、setting namespace、provider/model、思考级别、权限模式、目录浏览与 provider 配置——都统一使用同一个可搜索选择器：输入即按名称、route 与描述做模糊过滤，Up/Down（或 Ctrl+N/Ctrl+P）移动高亮，Enter 确认选中项，长模型或会话列表无需手动滚动。approval 提示中按 `y` 仅允许本次、按 `n` 拒绝。结构化问题使用独立编辑器，因此不会丢失原消息草稿；带选项的单选问题会渲染成可用 ↑/↓（或 Ctrl+N/Ctrl+P）移动高亮、Enter 确认的菜单（选项只列出一份，无重复的编号列表），直接输入任意字符（或选中末尾的 `✎ 其他 / 自定义…` 项）会打开自由文本输入框，Esc 返回选项菜单。多选与无选项问题仍通过选项编号、逗号分隔的多选编号或自由文本作答。任何问题下 Escape 都会取消整个 question request。答完最后一题后会进入一份「问题 → 你的答案」的确认汇总：↑/↓（或 Ctrl+N/Ctrl+P）浏览，在某一行按 Enter 可重新修改该题，选中最后的 `确认提交全部回答` 按 Enter 才真正发送整批回答。

应用使用 `TuiAltScreen`、`VStack` 和 `ScrollView` 构造固定高度布局。备用屏幕、同步差分刷新、鼠标与触控板滚动、滚动条、选区复制和终端模式恢复全部由 pi-tui 管理；本包不实现终端重绘或滚动偏移算法。鼠标滚轮和 PageUp/PageDown 滚动 transcript，Ctrl+Shift+F 搜索，Ctrl+Shift+Up/Down 在用户消息之间跳转，Ctrl+Shift+Home/End 到达开头或末尾。用户离开底部阅读历史时，新流式内容不会强制把视口拉回末尾；回到底部后自动恢复跟随。应用的视觉语言与 pi coding agent 的暗色主题（VS Code Dark+）保持一致：用户消息渲染为整行背景气泡，思考/reasoning 为灰色斜体，标题为柔和的琥珀色，链接与列表符号使用 teal 强调色；围栏代码块（```lang … ```）保留灰色围栏并做逐 token 语法高亮。流式生成的回答在生成过程中就呈现同样的形态，而不是一段无色的原始代码。注入的上下文行（skill 目录、插件上下文、工作区指令、会话召回等）、工具输出、压缩摘要和重试说明都默认折叠成一行标题，像 Web 的 disclosure row 一样，避免长启动上下文和冗长工具输出塞满 transcript；运行中的行保持展开，以便实时输出可见。Ctrl+Shift+E 展开最近折叠的行，反复按会依次展开更早的折叠行，全部展开后下一次按键会把它们重新全部折叠。Ctrl+T 展开或折回输入框上方的 todo/任务 活动栏

终端集成使用业内通用的 OSC 控制序列族而不是私有协议：窗口/标签页标题通过 pi-tui 的 OSC 0 实现；turn 运行期间标题会显示类似 pi 的 Braille 转圈动画。turn 完成、启动失败、出现 approval/question 请求等重要节点默认使用 OSC 777 通知；iTerm2 使用 OSC 9，Kitty 使用其 OSC 99 协议，tmux 下会使用 passthrough 转发。桌面通知的 OSC 没有跨终端统一标准；序列使用 BEL 作为终止符，因此仍保留通常的终端响铃 fallback。不支持该序列的终端会忽略它。显式 `/title <title>` 只覆盖当前 TUI 进程的终端标题；没有显式覆盖时，`/rename` 仍然重命名持久化 session，并同步自动终端标题。

## 终端管理命令

TUI 自己持有的命令会打开终端原生面板。其他 slash command 仍作为普通 Harness command 或 skill 调用处理。

| 命令 | 行为 |
|---|---|
| `/help`、`/status`、`/close` | 显示命令参考、运行与 projection 状态，或关闭当前面板。 |
| `/sessions [query]`、`/new [cwd]`、`/resume [id-or-prefix]` | 选择、搜索或创建持久化会话；`/sessions` 以及省略 id 的 `/resume` 会打开选择器，行内展示工作目录、组合所用的 agent preset，以及 subagent lineage 的只读 `子代理` 标记。 |
| `/rename <title>`、`/title <title>`、`/fork [event-seq]`、`/older` | 重命名 session、设置终端窗口/标签页标题、分叉，或向前分页读取持久化 history。`/title` 只作用于当前 TUI 进程，不会持久化。 |
| `/archive [session-id] --yes`、`/export [path] [--descendants]` | 归档 session，或导出日志及其引用的 media。 |
| `/models`、`/model [provider/model] [effort]` | 从可模糊搜索的选择器中选择模型；显式 route 则直接切换。 |
| `/providers`、`/provider-models [provider]`、`/discover-models <settings-ns> …` | 选择 provider/model，或从 endpoint 发现 model。 |
| `/provider-add [new-provider-id] [--name <显示名>] [--base-url <url>] [--api <协议>] [--key-env <环境变量>] [--model <id>…] [--discover]` | 采用类似 pi `/login` 的渐进式流程：provider 列表和其他选择器一样支持输入过滤；选择已有 provider 后切换到独立的单行 API Key 输入并立即保存；添加自定义 route 时依次询问 ID、endpoint、Host schema 协议、可选 Key 与模型，最后显示紧凑确认。自定义 route 只写入 `llm-pi-ai/providers.<id>`；配置地址来自 Host 的 `settingsNs/settingsPath`，密钥只经 `credentials.set` 单向写入。 |
| `/permission [preset]` | 上下选择或直接切换权限模式（来自 `permissions` projection 的 preset 表）。 |
| `/presets`、`/preset [id]`、`/preset-read <id>` | 选择空白 session 的 preset，或查看 preset 内容。 |
| `/preset-copy <source> <new-id> [name]`、`/preset-open <id>`、`/preset-remove <id> --yes` | 通过共享 preset service 创作或删除用户 preset。 |
| `/queue`、`/queue-edit <item-id> <text>`、`/queue-steer <item-id>` | 按稳定 id 查看和修改待处理 inbox item。 |
| `/queue-remove <item-id> --yes` | 删除一条待处理 inbox occurrence。 |
| `/jobs`、`/job-kill <id-or-prefix> --yes` | 查看后台任务，或停止一条（本地 standalone 模式可用）。 |
| `/workspaces`、`/workspace-new <path>`、`/workspace-rename <id> <title>` | 查看、创建或重命名 workspace 记录。 |
| `/workspace-move <id> [before-id\|end]`、`/workspace-session-move <id> <session-id> [before-id\|end]` | 重排 workspace 或其中的 session entry。 |
| `/workspace-delete <id> --yes` | 取消注册 workspace，但不删除其目录或 session log。 |
| `/settings`、`/settings-show <ns> [--schema]`、`/settings-open` | 选择 setting namespace、查看有效值与可选 schema，或打开配置文件。 |
| `/settings-set <ns> <json-pointer> <json>` | 通过 revision guard 更新 setting。 |
| `/settings-unset <ns> <json-pointer> --yes`、`/settings-reset <ns> --yes` | 删除字段，或重置一个 namespace，包括其中保存的 secret。 |
| `/credentials <REF> …`、`/credential-set <REF> <VALUE_ENV_VAR>` | 查看 credential，或从环境变量写入；值不会进入输入历史。 |
| `/credential-unset <REF> --yes` | 删除已保存的 credential。 |
| `/goal <objective>`、`/goal-show`、`/goal-edit <objective>`、`/goal-pause`、`/goal-resume`、`/goal-complete`、`/goal-clear --yes` | 创建 goal，并通过 revision guard 查看和修改 projected goal。 |
| `/skills`、`/subagents`、`/subagent [id-or-prefix]`、`/back` | 查看 skill、选择并进入 child transcript、续聊 continuable child，以及返回。 |
| `/feedback <message-id\|last> <positive\|negative> [note]`、`/feedback-clear <message-id\|last> --yes` | 创建、替换或删除 assistant message feedback。 |
| `/image <path> [caption]`、`/image-steer <path> [caption]` | 经 Host 接纳 raster image，并将其排队或插入当前 turn。 |
| `/save-image <attachment-id> [path]` | 以仅创建、不覆盖的文件语义保存 transcript 图片。 |
| `/directories [path]`、`/mkdir <parent> <name>`、`/open <path>` | 浏览、创建目录，或请操作系统打开路径。 |
| `/plugins`、`/host` | 查看 live Host plugin inventory 与 Host 能力。 |
| `/cordis`、`/cordis-run <plugin-id> [package-id]` | 查看 dynamic package，或运行/更新 host-only package。 |
| `/cordis-stop <plugin-id> --yes`、`/cordis-remove <plugin-id> --yes` | 停止 dynamic package，或删除其完整定义。 |

包含空白的路径可以加引号。破坏性命令要求末尾带 `--yes`。导出与图片保存采用仅创建写入，目标文件已存在时拒绝覆盖。`/credential-set` 从指定环境变量读取 secret，因此值不会进入终端命令历史或 transcript。图片提交前会对照 Host 的 `imageLimits` projection 预检——允许的图片类型、单张与单条消息的字节上限——在读取字节之前拒绝；`/status` 会列出完整预算（包括由宿主强制执行的像素与长边上限）。goal 要带图时可以直接串联命令：`/goal <objective>` 先创建 goal，紧接着 `/image <path>` 以用户消息提交参考图片；Web composer 中支持图片的 `/goal` 仍由 Host 命令路径承担。会话选择器的行直接来自 Host 计算好的 `session.list` summary：隐藏 blank 会话，每行展示记录的 cwd、组合所用的 agent preset，以及 subagent lineage 的只读 `子代理` 标记；客户端不会自行加载 Host 的 `sessionListMetadata` projection——行内派生的 `blank` 正是该 projection 要提供的信息，第二条 projection 加载路径不会带来额外信息。

共享命令 `/plan` 和 `/compact` 与其他未知 slash command 一样，原样交给 Harness 命令或 skill 路径；它们的持久化生命周期会回到同一个 transcript。`/permission` 由 TUI 本地拦截，打开一个可上下选择的权限模式列表（来自 `permissions` projection），选中后把 `/permission <preset>` 交回 Harness 完成切换。

对话状态来自持久化 history、mux stream 和 Host stream。终端会折叠 assistant 文本与 reasoning、注入的模型上下文、命令与压缩和模型重试生命周期、Host 提供的工具 presentation、作为去重产物行显示的成功 mutation location、持久化 workflow run 及其 member 状态、稳定的 assistant message id、待处理 queue item、后台 job、todo、goal 与其他 projection value、运行状态和实时错误。已完成的 assistant 与 reasoning 文本由 pi-tui `Markdown` 展示标题、强调、列表、引用、代码块、链接和表格；原始 HTML 显示为文本，支持 OSC 8 的终端会把链接显示为可点击链接，流式尾部则保留为紧凑纯文本。界面不再常驻页头；输入区下方的 footer 展示运行状态、agent preset、模型、cwd、会话轮次与步骤、累计 token、cache 命中率、上下文占用与权限模式，计划模式仅在开启或切换中时出现；宽度足够时折叠为单行，不足时按均匀宽度拆成两行。输入区上方的紧凑活动栏只在存在未完成 todo 或活跃 goal、queue、job、workflow 时出现。有未完成 todo 时它默认折叠为一行：同一行显示进度计数（已办/总数）、当前正在执行的 todo 与后台任务摘要，按 Ctrl+T 展开成按类别分节的完整清单——「待办」(已完成的标 ✓ 并置灰、正在执行的标 ◆ 高亮、未开始的标 ·) 与「任务（后台）」(运行中 ●、待停 ◌、失败 ✗；已结束的 job 不再占据活动栏) 各占一节，再按一次收回。`/status` 展示完整 projection 构成与图片限制。`ScrollView` 按渲染行约束 transcript，任何长文本都不能覆盖固定的活动栏、编辑器或 footer。产物路径可以直接交给 `/open`；未结束的工具或 workflow 会在其所属 turn 关闭时标记为中断。history/live 边界按 sequence 去重，surface replacement 不会重复渲染压缩 checkpoint；可回答的 approval 与 question frame 会回填原始 RPC identity。

## 模型体验

### 终端提示词提交

#### 模型看到的内容

本包不添加 system prompt 或 tool schema。终端提交的文本会作为普通用户内容到达 `ApiProxy`；system prompt、tool 及其他模型可见上下文由组合后的 base bundle 和当前选中的 agent preset 持有。未知斜杠命令走普通 session prompt 路径。终端原生命令调用与 Web 相同的 Host 业务 operation；当归属该功能的 Host service 刻意排入用户上下文时，例如 goal 或 dynamic Cordis 生命周期变更，模型会在下一步看到这段 service-owned context。

#### Token 影响

只读终端面板不增加模型 token。普通 prompt 只增加用户内容，以及当前 session composition 已持有的 request envelope。Host mutation 只增加共享 Host 合约已经规定的模型可见上下文；TUI 自己不添加包装文本。

#### KV Cache 影响

终端不会重写请求前缀。普通 prompt 与 Host 撰写的上下文在持久化 session 边界追加；模型或 preset 切换只会通过其选择的 Host 侧 route 与 composition 影响缓存复用。

## 已知限制与暂缓事项

- **刻意不提供 trajectory**：这是 TUI 对齐目标中唯一排除的 Web 功能。
- **不模拟浏览器 Client half**：终端可以运行 host-only dynamic Cordis package。模型要求运行带浏览器 Client half 的 package 时，TUI 会立即返回可操作的拒绝结果，而不会让 turn 悬挂。
- **不模拟浏览器外观控制**：DOM component slot、拖放、browser routing，以及 Web theme 或 locale control 属于平台 presentation，而不是 Host domain 行为。TUI 对应使用键盘命令、文件系统路径、终端颜色和进程 locale。
- **并发展示必须使用共享 Web Host**：默认探测覆盖随附 Web 端口；Web 监听其他端口时需传入 `--connect`。`--standalone` 保留隔离 Host 路径，但不能与 Web 针对同一个 Harness home 并发运行，因为进程本地 domain 事件与 JSON 存储不会跨 Host 进程协调。
- **部分 Host 本地管理命令仍只支持 standalone 模式**：message feedback、session export、live plugin inventory、dynamic Cordis control 与后台任务停止（/job-kill）刻意位于 `IApiClient` 之外；终端连接 Web Host 时，对应 TUI 命令会报告该能力不可用。聊天、分组、history、model、projection、queue、approval、question、workspace、settings、image、skill、goal 与 subagent 使用远程 Host 约定。
- **每个终端只选择一个 session**：其他 session 仍可在 Host 上继续运行，但当前进程一次只渲染一个 transcript，并且面板只保留当前可回答 interaction。
- **`ctx.appExit` 由启动器持有**：在 `dsh` 外部挂载本组合包时，宿主必须提供有界退出请求。

## 发布流程

发布由 [Release workflow](.github/workflows/release.yml) 执行：推送版本 tag 会先跑测试矩阵、带 provenance 发布到 npm，再创建对应的 GitHub Release。流程可安全重跑：npm 中已存在的版本会跳过，已有的 GitHub Release 也不会重复创建。dist-tag 由版本号决定——预发布版本进入 `beta`，稳定版本进入 `latest`：

```sh
npm version prerelease --preid beta  # 0.2.0 -> 0.2.1-beta.0 -> npm dist-tag "beta"
npm version minor                    # 0.2.0 -> 0.3.0        -> npm dist-tag "latest"
git push --follow-tags               # 推送的 v* tag 触发发布
```

该 workflow 通过 npm [trusted publishing](https://docs.npmjs.com/trusted-publishers)（GitHub OIDC）认证，无需配置任何 token secret。在 npmjs.com 的包设置中选择 GitHub Actions，并分别填写：组织或用户 `zhangweiii`、仓库 `dsh-tui`、workflow 文件名 `release.yml`、environment 留空、允许操作选择 `npm publish`。本地发布可运行 `npm run release`，同样执行「先测试、再按规则选择 dist-tag 发布」的流程。
