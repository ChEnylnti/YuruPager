# YuruPager 技术选型与架构决策

- 文档版本：v1.8
- 状态：关键 Spike 完成，进入 MVP 实施
- 更新日期：2026-08-30
- 关联需求：[产品需求文档](./product-requirements.md)

## 1. 文档目的

本文记录 YuruPager MVP 的关键技术决策。每项决策均为当前实现基线，不代表永久不可变；依赖实验性接口的决策必须通过技术 Spike 后，才能转为正式采纳。

决策遵循以下原则：

- 高风险操作失败时默认拒绝，不静默放行。
- YuruPager 不自动读取或持久化源代码、Diff、环境变量、API Key 和完整终端输出；ADR-019 中由用户显式选择或 Codex 明确返回的图片只允许经过授权 WSS 做内存中转。
- 网络传输按“至少一次”设计，业务副作用通过幂等、状态机和对账控制。
- 工作空间是数据与授权边界，工作站是运行 Codex 的设备。
- 优先减少 MVP 的组件数量，但不牺牲审批正确性和租户隔离。
- 外部和实验性协议必须封装在适配层后使用。

## 2. 决策摘要

| ADR | 决策 | MVP 状态 |
|---|---|---|
| ADR-001 | 以 Codex `app-server` 为主要接入面，hooks 仅作补充，JSONL 仅作受限回退 | MVP 采纳，带能力探测和版本门禁 |
| ADR-002 | 连接器使用 TypeScript 和 Node.js | 暂定采纳，必须做长稳测试 |
| ADR-003 | PWA 继续覆盖跨平台；iOS 原生部分由 ADR-017 补充 | 部分替代 |
| ADR-004 | Connector 使用持久化 WSS、Outbox/Inbox、ACK 和游标重放 | 暂定采纳 |
| ADR-005 | PostgreSQL 共享库共享 Schema，`workspace_id` 加 RLS 双重隔离 | 暂定采纳 |
| ADR-006 | 服务端保证单一有效决定，不宣称跨 Codex 边界的端到端 Exactly-once | MVP 采纳，模糊窗口必须 fail-closed |
| ADR-007 | 保存有序的累计用量快照，最终校准后按版本化价格估算成本 | MVP 采纳，生命周期 Spike 通过 |
| ADR-008 | OIDC + PKCE 用户认证，独立设备密钥，RBAC 与工作站授权结合 | 暂定采纳 |
| ADR-009 | npm workspaces monorepo，保留根目录 Connector 包 | MVP 采纳 |
| ADR-010 | Fastify 模块化单体提供 REST、WebSocket 与静态 Web | MVP 采纳 |
| ADR-011 | SQL-first `pg` 数据访问，迁移显式维护复合外键和 RLS | MVP 采纳 |
| ADR-012 | OIDC BFF 为生产边界，本地身份提供器只用于 Alpha 开发 | MVP 采纳 |
| ADR-013 | Docker Compose 本地部署，单服务镜像 + 托管 PostgreSQL 为发布基线 | MVP 采纳 |
| ADR-014 | 主动消息采用临时明文 Outbox、`threadId` 级队列与 Connector 端 turn 门闩 | Alpha 采纳 |
| ADR-015 | Codex 对话仅在工作站持久化，公网服务只做授权后的内存中转 | Alpha 采纳 |
| ADR-016 | 十分钟单次配对码 + Web 明确确认 + 每工作站独立凭据 | Alpha 采纳 |
| ADR-017 | iOS 使用原生 SwiftUI，共用 REST/WSS 协议且不持久化 Codex 正文 | Alpha 采纳 |
| ADR-018 | 工作站全局发现 Codex 项目；官方 `thread.name` 仅经授权内存中转 | Alpha 采纳 |
| ADR-019 | 会话图片使用授权 WSS 临时分块中转，并由 Connector 私有持久化 | Alpha 采纳 |
| ADR-020 | 开发预览使用独立 HTTPS origin、独立易失 WSS 与本机显式端口授权 | Alpha 采纳 |
| ADR-021 | PWA Web Push 使用 VAPID、账户级端点与最小路由通知，快照仍是事实来源 | Alpha 采纳 |
| ADR-022 | ESLint（flat config）+ typescript-eslint 作为工程质量门禁 linter | MVP 采纳，warn 级起步 |
| ADR-023 | 数据库 Schema 采用有序幂等版本化迁移，自研编号 SQL runner + 旧库补登记 | MVP 采纳 |
| ADR-024 | Connector 采用多 Agent 运行时（AgentRuntime 接口 + 扇出编排，共享云端连接） | Phase 1 采纳 |
| ADR-025 | 会话发现按 agent 能力降级，禁止读取 agent 本地转录文件 | Phase 2 采纳 |
| ADR-026 | Connector 协议 v2 增量演进：agent 字段 + sessionId 别名，不做破坏性改名 | Phase 1 采纳 |
| ADR-027 | 审批归一化到 RequestContext/DecisionInput，未知选项 fail-closed；version-gate 泛化为 per-agent 能力探测 | Phase 2 采纳 |
| ADR-028 | Claude Code 经 claude-agent-acp 适配器接入（ACP 路径），原生 stream-json 适配器为条件性后备 | 草案（真实 CLI 验证清单通过后转采纳） |
| ADR-029 | Cursor 经原生 stream-json 适配器接入（事件协议非 JSON-RPC） | Phase 3 采纳 |
| ADR-030 | ZCode 经原生 `zcode app-server`（ZCode Protocol stdio JSON-RPC）接入，监督模式强制 build/edit，版本门 0.16.x | 草案（spike 回填后定稿） |
| ADR-031 | DeepSeek Harness（dsh）经插件桥/api-gateway 接入，pre-step 审批门 + session/event 增量 | 搁置（适配器未落地；如需补齐单独立项） |
| ADR-032 | 规划工作流编排归属：Connector 唯一执行器，Server 持久化定义+Run 状态机并经 outbox/inbox 下发，交接文本与 agent 产出不入库 | 草案 |
| ADR-033 | 节点完成条件范式：agent_confirm / criteria_check / manual_gate 三选一，恒定 turn_budget+timeout 护栏，未确认绝不交接 | 草案 |
| ADR-034 | 会话选项扩展：AgentRuntime 按会话指定 model/reasoningEffort，能力目录进 AgentCapabilities，各 runtime 写原生映射表 | 草案 |
| ADR-035 | Web 画布采用 React Flow（@xyflow/react），移动端 v1 只做运行监控 | 草案 |
| ADR-036 | 工作流权限与审计：定义 CRUD=member+，运行/取消需 can_orchestrate 授权，manual_gate 复用审批与高危确认通道，全量审计 | 草案 |

## 3. Codex 能力证据基线

本决策最初基于 2026-08-03 在 `codex-cli 0.146.0-alpha.9.2` 上生成并检查的实验性 `app-server` JSON Schema；2026-08-05 在 `0.147.0-alpha.1.2` 上复验，2026-08-15 又在 `0.148.0-alpha.9` 上复验最小协议契约和 writer 生命周期。当前可观察到以下协议能力：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`
- `turn/completed`
- `error`
- `thread/tokenUsage/updated`

Token 用量事件包含 `last`、`total`、`inputTokens`、`cachedInputTokens`、`cacheWriteInputTokens`、`outputTokens`、`reasoningOutputTokens` 和 `totalTokens`。

上述内容是当前本机版本的可验证能力，不构成 OpenAI 对协议稳定性的承诺。`app-server`、协议代码生成及部分用户输入能力仍被标记为实验性，因此必须进行版本探测、契约测试和降级处理。

Connector Spike 已真实验证握手、三类审批、结构化提问、完成事件、Token 用量、共享会话、真实 TUI、首响应仲裁、listener 重启、取消/超时、响应后崩溃、多 turn/compact Token 生命周期和 writer 释放。`0.145.0`、`0.146.0-alpha.9.2`、`0.147.0-alpha.1.2` 与当前 `0.148.0-alpha.9` 都满足最小 Schema 契约。`thread/unsubscribe` 只取消订阅，不释放 active writer；只有持有 writer 的 app-server 进程退出后，另一个实例才能接管 thread。因此主动消息必须使用独立的短生命周期 app-server。listener 重启会把 pending turn 变为 `interrupted` 而不重放审批；响应写入后崩溃会留下无法由 thread 历史消除的 `sent_unknown`。因此 ADR-001、ADR-006 和 ADR-007 转为 MVP 采纳，但必须执行能力探测、禁止模糊批准重发并保留人工恢复入口，详见 [Codex Connector 技术 Spike 报告](./codex-connector-spike.md)。

2026-08-16 在本机 standalone `codex-cli 0.147.0` 上新增验证了实验性 `remote-control` 契约：CLI 提供短期配对、设备列举/撤销和连接状态 API；独立 app-server 的只读 `remoteControl/status/read` 返回 `disabled`，未产生配对或远程控制副作用。静态检查同时确认 Codex Desktop 在自身 app-server 上调用 `remoteControl/enable` 并提供 Connections UI；它与 standalone CLI managed daemon 是不同路径。该结果证明官方有适合双端协同的控制面，但不代表第三方可依赖其第一方中继、附着已有 Desktop thread 或已验证原生 Desktop 的实时镜像。详情见 [Codex Connector 技术 Spike 报告](./codex-connector-spike.md)。

---

## ADR-001：Codex 使用 app-server 还是 hooks/JSONL

- 状态：MVP 采纳
- 决策日期：2026-08-03

### 背景与约束

YuruPager 需要双向且可阻塞的 Codex 集成：接收命令和文件审批、向用户提问、返回决定、监听完成和失败，并采集 Token 用量。只接收完成通知不足以满足远程审批。

连接器必须兼容 Codex CLI 的升级，不应将 Codex 内部事件结构直接暴露给服务端或手机客户端。任何接入方式都不能要求上传代码库或完整对话。

### 候选方案

1. Codex `app-server`：通过本地 stdio、Unix listener 或 loopback WebSocket 使用双向协议。
2. Codex hooks：在特定生命周期触发外部命令。
3. `codex exec --json`：包装 Codex 进程并解析 JSONL 事件。
4. 混合方式：`app-server` 承担交互，hooks 提供补充通知或诊断，JSONL 作为受限回退。
5. 官方 `remote-control`：由 Codex 第一方控制平面执行设备配对和远程客户端会话控制。

### 选择结果

选择混合方式，但以 `app-server` 为唯一主要交互入口：

- Connector 的常驻 stdio `app-server` 只执行 `thread/list`、`thread/read` 和流同步等只读工作；每条手机主动消息创建独立 stdio `app-server`，在最终完成、失败或中断后关闭该子进程并释放 writer。需要多个协作客户端共同处理同一 active turn 时，使用仅绑定 loopback 的 WebSocket listener，不把端口暴露到公网。
- Connector 内建立 `CodexAdapter`，将 Codex 方法和字段转换为版本化的 YuruPager Domain Event。
- hooks 只用于 `app-server` 未覆盖的补充生命周期信号和安装诊断，不承担审批决定。
- JSONL 只作为完成、失败和用量观察的兼容回退，不承诺支持阻塞审批或问题回答。
- 启动时进行协议版本和能力探测；缺失关键能力时明确进入降级状态，不伪装为完整可用。
- 将官方 `remote-control` 视为可选优先适配器候选：Codex Desktop 的第一方路径只能由用户在 Settings -> Connections 中显式启用和完成配对；在真实手机/原生 Desktop 端到端验证、兼容性边界和外部使用授权明确前，YuruPager 不代理其第一方中继、不调用 enable/pair，也不把它暴露为公共 API。standalone CLI managed daemon 不得被当作当前 Desktop thread 的替代或附着方式。

### 选择理由

- `app-server` 当前同时提供审批请求和响应，符合双向阻塞需求。
- 协议包含 thread、turn 和 item 标识，便于构建稳定的请求关联关系。
- 已存在 Token 用量、完成和错误通知，可减少从终端文本推断状态的脆弱逻辑。
- hooks 更适合生命周期扩展，单独使用难以覆盖交互式审批的完整往返。
- JSONL 适合非交互式执行和观测，但进程包装会改变用户原有的 Codex 使用方式。
- 适配层允许未来增加 Claude Code 等代理，而不改变服务端领域协议。
- 若官方 Remote Control 满足单用户同会话的基础操作，YuruPager 可将差异化集中在多工作空间、多人协作、策略、审计和 Token 成本归属，而非重复构建第一方移动控制器。

### 已知风险

- `app-server` 和代码生成仍为实验性能力，方法名、字段和握手流程可能变化。
- `requestUserInput` 等能力可能受功能开关或 Codex 版本影响。
- 共享会话依赖实验性的 WebSocket、`thread/resume` 和多客户端回调语义，升级后可能变化。
- stdio app-server 的 thread writer 与进程生命周期绑定；`thread/unsubscribe` 返回成功也不会释放 writer。若把主动消息放在常驻发现进程中，桌面 Codex 会持续显示“已在另一个应用中打开”。
- listener 重启会中断 active turn，pending 审批不会重放；产品必须显式呈现中断并引导重新发起 turn。
- 多个已加入客户端会收到同一 pending 审批；若缺少共享决定门闩，可能产生冲突响应。
- Codex 当前还暴露实验性 `remote-control` 命令，未来可能与 YuruPager 的基础能力重叠。
- `remote-control` 的控制平面、账户授权和中继协议没有对第三方的稳定兼容承诺；Desktop 第一方路径与 standalone CLI daemon 的差异也说明，把任一 Schema 存在视为可集成 API 会造成严重产品与安全风险。
- 真实双端事件镜像、现有 Desktop thread 附着、多移动设备仲裁和远程审批在用户显式配对前均尚未验证。
- JSONL 降级模式无法满足全部 MVP 验收标准。
- 直接代理远程 `app-server` 会扩大攻击面，因此禁止将它作为云端公开接口。

### 验证方式

- 生成并保存所支持 Codex 版本的 TypeScript 或 JSON Schema 契约快照。
- 分别触发命令执行、文件修改、权限申请和用户问题，验证暂停与响应行为。
- 在审批 pending 时让第二个客户端恢复 thread，验证稳定请求 ID、重复投递和后续事件订阅。
- 验证 `accept`、`decline`、`cancel`、超时和 Codex 主动取消。
- 验证完成、失败和 Token 用量事件能关联到正确 thread 和 turn。
- 在 Connector、Codex 和网络分别重启的情况下验证请求恢复行为。
- 已验证 listener 重启后 `resume --remote` 可打开 thread，但原审批不恢复且命令未执行。
- 已验证两个独立 stdio app-server 对同一 thread 产生 writer 竞争；停止持有者进程后，另一个实例可立即接管。`thread/unsubscribe` 不能替代进程退出。
- 已在 `0.145.0`、`0.146.0-alpha.9.2`、`0.147.0-alpha.1.2` 和 `0.148.0-alpha.9` 运行最小协议契约。
- 至少选择两个 Codex CLI 版本运行同一套契约测试和端到端测试。
- 运行 `npm run spike:remote-control-contract` 与 `npm run spike:remote-control-status`，验证 standalone CLI 的最小 Schema、CLI 命令和只读状态方法；探针不得调用 enable、start 或 pair。
- 在独立工作站、独立测试 thread 和用户显式配对的手机上，从 Codex Desktop 的 Settings -> Connections 启动第一方远控，验证双端消息可见性、审批、断线恢复、设备撤销和多设备仲裁，再决定是否实现正式适配器。

### 重新评估条件

- OpenAI 发布稳定且有兼容性承诺的审批 Hook 或远程控制 API。
- `app-server` 移除、禁止第三方使用，或连续两个目标版本无法兼容。
- Codex 官方远程控制覆盖 YuruPager 的多工作空间、协作、审计和策略能力。
- JSONL 或其他稳定协议开始支持完整双向审批、提问和 Token 用量。
- 其他代理成为主要接入目标，需要调整 Adapter 边界。

---

## ADR-002：连接器使用 TypeScript 还是 Rust

- 状态：部分替代（原生 iOS 见 ADR-017；PWA 与 Android 结论保留）
- 决策日期：2026-08-03

### 背景与约束

Connector 是长期运行在用户工作站上的本地守护进程，需要连接 Codex、维护 WSS、持久化未确认消息、访问系统密钥存储，并完成自动更新和故障恢复。

MVP 首期支持 macOS，安装入口为 `npx yurupager setup`。团队需要快速迭代实验性 Codex 协议，同时尽量复用服务端和客户端的类型定义。

### 候选方案

1. TypeScript + Node.js：开发快、协议类型可复用、与 npm 安装流程一致。
2. Rust：单文件分发、资源占用和静态安全更好，但开发与跨平台系统集成成本更高。
3. 混合架构：TypeScript 主进程配合 Rust 原生模块或 sidecar。

### 选择结果

2026-08-09 更新：PWA 仍是跨平台与 Android 基线；用户要求的原生 iOS Alpha 由 ADR-017 落地。以下内容保留为最初选择依据，原生 iOS 不再属于“后置且未实施”。

MVP Connector 使用 TypeScript 和当前受支持的 Node.js LTS：

- 通过 npm 分发，以 `npx yurupager setup` 完成安装和配置。
- 使用生成的 Codex TypeScript 类型，但只在 `CodexAdapter` 包内可见。
- 使用 macOS LaunchAgent 管理后台进程，并抽象 `ServiceManager` 以支持后续平台。
- 使用本地 SQLite 保存 Outbox、Inbox、连接游标和最小恢复状态。
- 使用操作系统 Keychain/Keystore 适配层保存私钥和刷新凭证。
- 不在 MVP 引入 Rust sidecar；只有明确的性能或系统能力证据出现时才增加原生组件。

### 选择理由

- 与 `npx` 安装体验、Codex TypeScript 代码生成和全栈共享协议最匹配。
- 实验性 Codex 协议会快速变化，TypeScript 的迭代成本更低。
- Connector 的主要负载是本地 IPC、网络 I/O 和少量持久化，不是计算密集型任务。
- 单语言 Monorepo 能减少 MVP 的构建、发布和招聘复杂度。
- 通过严格的模块边界，可以在后续用 Rust 替换进程而不改变云端协议。

### 已知风险

- Node.js 守护进程的内存占用和冷启动大于 Rust。
- npm 依赖扩大供应链攻击面。
- 用户本机 Node.js 版本不一致可能影响运行。
- macOS Keychain、LaunchAgent、代码签名和自动更新仍需要平台适配。
- 打包为独立可执行文件时，原生依赖和动态加载可能带来兼容问题。

### 验证方式

- 在全新 macOS 用户环境中完成三分钟内安装、配对、卸载和重新配对。
- 进行至少 72 小时守护进程长稳测试，记录内存、CPU、句柄和重连次数。
- 强制结束 Connector、Codex 和网络，验证 SQLite 恢复与消息去重。
- 验证 Keychain 中私钥不可通过普通日志、诊断包或进程参数泄露。
- 构建锁文件审计、依赖许可证检查和发布包 SBOM。
- 验证 npm 包签名、升级失败回滚和旧版本兼容策略。

### 重新评估条件

- 空闲内存或 CPU 长期超过 MVP 设定预算。
- Node.js 运行时成为安装成功率的主要障碍。
- Windows Service、Linux systemd 或硬件密钥支持需要大量原生能力。
- 安全审计要求单文件签名二进制或显著缩小依赖面。
- Connector 的崩溃率或升级失败率无法通过 TypeScript 实现降低。

---

## ADR-003：PWA 还是原生移动端

- 状态：MVP 暂定采纳
- 决策日期：2026-08-03

### 背景与约束

手机端的核心任务是接收推送、查看请求上下文、批准或拒绝、回答问题、进行高风险二次认证，并管理多个工作空间和工作站。

MVP 需要尽快同时覆盖 iOS 和 Android，但推送到达率、后台行为和安全认证是产品可信度的核心，不允许长期用低可靠方案掩盖问题。

### 候选方案

1. 响应式 PWA：一套 Web 代码覆盖手机和桌面，交付最快。
2. 跨平台原生客户端：React Native/Expo 或 Flutter，共享大部分业务代码并接入原生推送和生物识别。
3. 完全原生客户端：Swift/iOS 与 Kotlin/Android 分别实现，平台能力最好但成本最高。

### 选择结果

MVP 使用安装型 PWA：

- PWA 同时承担手机审批端和基础 Web 管理端。
- 使用 Web Push；推送只作为唤醒和导航提示，打开后必须从服务端同步当前状态。
- 使用 WebAuthn/Passkey 完成高风险请求的二次认证。
- iOS 明确要求将 PWA 添加到主屏幕后启用推送，并在配对流程中验证通知权限。
- 技术 Spike 可先使用普通响应式 Web 页面，但公开 MVP 必须通过真实 iOS 和 Android 推送验收。
- 原始计划不并行开发原生客户端；该限制中的 iOS 部分已由 ADR-017 替代，Android 仍按 PWA 可靠性结果再评估。

### 选择理由

- 一套客户端即可验证审批、工作空间、工作站协作、历史和 Token 用量等主要产品假设。
- 可复用 Web 管理界面、认证和领域类型，降低首期成本。
- WebAuthn 可以满足大部分高风险二次确认需求。
- 服务端才是审批事实来源，PWA 恢复前台后可以可靠同步，不依赖推送本身承载状态。
- 在技术和产品需求尚未验证前，维护两套原生客户端成本过高。

### 已知风险

- iOS Web Push 依赖安装到主屏幕，首次设置路径更长。
- 不同浏览器对后台推送、通知更新和生物识别的体验不一致。
- PWA 无法保证系统级通知撤回和跨设备通知同步表现完全一致。
- 企业 MDM、设备合规和更强本地凭证保护可能最终要求原生客户端。
- App Store 分发和系统级信任感暂时缺失。

### 验证方式

- 在当前支持的 iOS Safari、Android Chrome 和桌面浏览器上测试安装、登录、配对和推送授权。
- 在前台、后台、锁屏、低电量和网络切换情况下测量通知送达率和延迟。
- 验证推送丢失后，打开 PWA 能恢复全部待处理请求。
- 验证请求已由其他设备处理时，PWA 不允许再次提交有效决定。
- 验证 WebAuthn 注册、二次确认、凭证丢失和账户恢复流程。
- 以 MVP 验收流量进行至少一周真实设备内测，不只使用浏览器模拟器。

### 重新评估条件

- PWA 无法满足大多数通知五秒内到达的验收目标。
- iOS 安装或通知授权显著拉低三分钟配对成功率。
- 高风险审批需要更强的 Secure Enclave、设备证明或 MDM 能力。
- 用户明确要求 App Store/Google Play 分发。
- PWA 后台行为导致审批遗漏或错误状态超过可接受阈值。

---

## ADR-004：WebSocket 确认、重放和断线恢复机制

- 状态：MVP 暂定采纳
- 决策日期：2026-08-03

### 背景与约束

Connector 与服务端需要低延迟双向通信。移动网络、工作站休眠、服务发布和进程崩溃都会造成断线。推送也可能丢失，因此任何关键决定都不能仅存在于内存或通知载荷中。

WebSocket 自身只提供单连接内有序传输，不提供跨断线的持久化、业务确认或 Exactly-once。

### 候选方案

1. 裸 WebSocket：消息发送成功即认为完成，不持久化。
2. WebSocket + 内存重试：断线后尝试重发当前进程中的消息。
3. 持久化 WebSocket 协议：双方使用 Outbox/Inbox、ACK、序号和恢复游标。
4. HTTP/SSE：Connector 上传走 HTTP，服务端下行走 SSE。
5. 消息代理：直接引入 Kafka、NATS 或云消息服务。

### 选择结果

选择持久化 WebSocket 协议：

- Connector 主动建立到服务端的 WSS，服务端不主动连接用户工作站。
- Connector 与 Codex 的本地通信使用 stdio；共享客户端场景使用仅绑定 loopback 的 WebSocket，不对公网开放。
- 每条消息包含 `message_id`、`stream_id`、`connection_epoch`、单调递增 `sequence`、时间戳、幂等键和协议版本。
- Connector 使用 SQLite Outbox；服务端使用 PostgreSQL Outbox/Inbox。
- 接收方只有在消息和相关领域状态提交成功后才发送传输 ACK。
- 发送方收到 ACK 后才能清理 Outbox；超时或重连后可以安全重发。
- 重连握手交换最后确认游标，按序重放未确认消息，并通过 `message_id` 唯一约束去重。
- 传输采用至少一次语义，不宣称消息只到达一次。
- 心跳初始值为 15 秒，连续 45 秒无响应视为离线；重连采用 1 至 30 秒指数退避和随机抖动。
- 推送通知只包含最小路由信息，不包含可直接执行的审批决定。
- 手机提交决定使用 HTTPS API 和 `Idempotency-Key`；前台状态同步可使用 WebSocket，断线后以 HTTPS 快照为准。

ACK 分为两个层次：

1. 传输 ACK：接收方已经持久化消息。
2. 业务回执：决定已经由 Connector 交给 Codex，并完成可验证的状态对账。

### 选择理由

- 满足事件少于一秒到达和决定快速返回的实时性要求。
- Outbox/Inbox 让进程或服务重启后仍可恢复。
- 传输 ACK 与业务回执分离，避免把“服务端收到”误认为“Codex 已执行”。
- PostgreSQL 和 SQLite 已在其他决策中使用，无需为 MVP 增加消息代理。
- 手机通过 HTTPS 提交决定更易实现认证、幂等、限流和审计。

### 已知风险

- 自定义恢复协议需要严格的兼容性和故障测试。
- 服务端多实例下，连接路由和设备在线状态需要协调。
- 序号缺口、时钟偏差和客户端数据库损坏会使恢复复杂化。
- PostgreSQL Outbox 在规模扩大后可能成为吞吐瓶颈。
- 工作站长期离线时需要限制本地队列大小和敏感数据保留时间。

### 验证方式

- 在消息发送前、发送后、数据库提交前、提交后和 ACK 前分别注入进程崩溃。
- 随机重复、延迟、乱序和丢弃消息，验证最终状态一致且无重复副作用。
- 模拟工作站休眠、网络切换、服务端滚动发布和数据库短时不可用。
- 验证重连后尚未过期的请求恢复，已过期请求不会重新激活。
- 测量事件上行、推送、决定下行和业务回执的 P50、P95、P99 延迟。
- 验证单设备队列上限、背压、磁盘写满和损坏恢复策略。

### 重新评估条件

- 单区 PostgreSQL Outbox 无法满足连接数或延迟目标。
- 需要跨地域多活部署或严格的消息顺序保证。
- 在线 Connector 达到需要专用连接网关或消息代理的规模。
- 运维成本表明托管实时服务比自建协议更可靠。
- Codex 提供可直接复用且满足多租户要求的稳定远程通信协议。

---

## ADR-005：PostgreSQL 多租户隔离方式

- 状态：MVP 暂定采纳
- 决策日期：2026-08-03

### 背景与约束

一个用户可以加入多个个人、公司和团队工作空间。公司管理员不得访问用户个人空间，成员也不得通过修改资源 ID 访问未授权工作站或请求。

MVP 需要支持跨工作空间聚合视图，同时控制基础设施和迁移复杂度。仅依靠应用代码中的 `WHERE workspace_id = ...` 容易产生越权遗漏。

### 候选方案

1. 共享数据库、共享 Schema，以 `workspace_id` 区分租户。
2. 共享数据库、每工作空间独立 Schema。
3. 每工作空间独立数据库。
4. 混合模式：默认共享，大型或受监管客户使用独立数据库。

### 选择结果

MVP 使用共享 PostgreSQL 数据库和共享 Schema，并实施应用授权与 PostgreSQL Row-Level Security 双重隔离：

- 所有归属于工作空间的数据表都包含非空 `workspace_id`。
- 跨表关系使用包含 `workspace_id` 的复合外键，阻止跨租户错误关联。
- 唯一约束按业务需要包含 `workspace_id`，全局 ID 使用不可枚举的 UUIDv7。
- API 请求在数据库事务中使用 `SET LOCAL` 设置当前 `user_id`、`device_id` 和请求上下文。
- RLS 通过 `workspace_memberships` 和 `workstation_access` 校验成员关系与资源权限。
- 连接池中的租户上下文必须是事务级，事务结束自动清除，禁止使用会话级租户变量。
- 普通 API 数据库角色不得拥有 `BYPASSRLS` 或表 Owner 权限。
- 后台任务使用独立的受限角色，并显式声明工作空间范围；跨工作空间运维任务必须审计。
- 全局视图通过用户有效 Membership 聚合，不通过关闭 RLS 实现。
- 审计记录保留事件发生时的工作空间，不随设备或成员迁移。

### 选择理由

- 单数据库便于事务、迁移、备份和跨工作空间用户视图。
- RLS 为应用层遗漏提供第二道隔离防线。
- 复合外键能在数据库层阻止请求、设备和会话串到其他工作空间。
- MVP 不需要维护大量 Schema 或数据库连接池。
- 后续可按工作空间迁移到专用数据库，领域模型无需改变。

### 已知风险

- RLS 策略复杂，错误的数据库角色可能绕过隔离。
- Membership 查询、后台任务和连接池上下文容易形成隐蔽漏洞。
- 大型工作空间可能造成 noisy neighbor。
- 共享数据库不能直接满足部分客户的数据驻留或独占密钥要求。
- 跨工作空间统计必须同时保证性能和授权正确性。

### 验证方式

- 为每个租户表编写正向和反向授权测试，重点覆盖 IDOR。
- 自动检查所有租户表都包含 `workspace_id`、RLS 和必要复合外键。
- 使用两个以上工作空间运行属性测试，随机替换资源 ID，确保访问失败。
- 验证连接池复用、事务回滚和异常退出后不会残留租户上下文。
- 验证成员移除、工作站撤权和角色变更在现有连接中立即生效。
- 对备份恢复、数据删除和单工作空间导出进行演练。
- 在代码审查和 CI 中禁止普通服务角色使用 `BYPASSRLS`。

### 重新评估条件

- 企业客户要求独立数据库、区域驻留、自带密钥或 BYOC。
- 单个工作空间的存储或查询负载显著影响其他租户。
- 合规要求工作空间级物理隔离。
- RLS 对关键查询造成无法接受的复杂度或性能问题。
- 需要采用默认共享、重点客户独享的混合隔离模式。

---

## ADR-006：审批状态机和 Exactly-once 执行边界

- 状态：MVP 采纳
- 决策日期：2026-08-03

### 背景与约束

同一个审批可能同时出现在多台手机上，也可能被多个已加入同一 app-server thread 的本地客户端接收，还可能因超时、断线和重试被重复提交。服务重启不能导致已经批准的操作再次执行。

数据库和 Codex 不共享事务，因此无法诚实地承诺从手机点击到 Codex 工具副作用的端到端 Exactly-once。系统必须明确哪些边界能够保证单次生效，以及出现未知结果时如何失败。

### 候选方案

1. 将收到的每次决定都直接转发给 Connector。
2. 仅依赖 API 幂等键去重。
3. 服务端原子状态机 + 幂等决定 + 持久化投递 + Connector 对账。
4. 使用分布式事务协调服务端、Connector 和 Codex。

### 选择结果

选择服务端原子状态机、至少一次投递和 Connector 对账，不宣称跨 Codex 边界的端到端 Exactly-once。

审批状态拆成三个正交维度：

```text
request_status:
  pending -> approved | denied | expired | cancelled

delivery_status:
  not_queued -> queued -> sent -> acknowledged
                            \-> failed | ambiguous

execution_status:
  unknown | not_started | started | completed | failed
```

具体规则：

- `approved`、`denied`、`expired` 和 `cancelled` 是互斥的最终请求决定。
- `delivered` 不再覆盖决定类型，而表示 `delivery_status = acknowledged`；这是对 PRD 第 8 节状态定义的技术细化。
- 服务端使用单条条件更新完成决策，例如仅在 `status = pending` 且未过期时写入最终决定。
- 数据库对每个 `request_id` 只允许一条最终决定记录。
- 手机必须提交 `Idempotency-Key`；相同 Key 和相同载荷返回原结果，相同 Key 与不同载荷返回冲突。
- Connector 持久化 `decision_id`，在向 Codex 响应前检查是否已处理。
- app-server 多客户端回调必须先映射到稳定 `request_id` 并共享同一个决定门闩；首个有效决定获胜，其他连接的迟到响应不得再次提交。
- 当前测试版本的 app-server 自身也采用首响应获胜，但该实验性行为只作为第二道保护，不作为 YuruPager 的唯一一致性保证。
- Connector 收到与自己已发送 RPC ID 匹配的 `serverRequest/resolved` 后，才把该决定标记为 Codex 已确认。
- 如果 resolved 在 Connector 发送前到达，或 RPC ID 不属于本连接，立即取消待发送决定并标记 `resolved_externally`、`decision_unknown`；完成 item/turn 对账前不得推断批准或拒绝。
- 决策投递可以重试，但高风险批准在“已调用 Codex、尚未记录回执”的崩溃窗口中不得盲目再次调用。
- 出现该窗口时标记为 `ambiguous`，先查询 Codex thread、turn 和 item 状态；无法确认时失败关闭并要求人工回到工作站处理。
- 只有 `approved` 可以授权目标操作；拒绝、过期、取消或未知状态都不得执行高风险操作。
- 所有状态变化写入追加式 Audit Event，包含操作者、策略版本、时间和前后状态。

### 选择理由

- 数据库条件更新可以保证并发手机中只有一个决定获胜。
- 共享会话 Spike 已证实审批会投递到多个本地客户端，因此单一决定门闩是协议要求，不只是手机端防重复优化。
- 冲突决定 Spike 证实首个响应决定实际副作用，迟到的相反响应不会覆盖结果或重复执行。
- Idempotency-Key 解决客户端重试，但不被误当成完整的 Exactly-once 方案。
- 将请求决定、投递状态和执行状态分开，保留了“批准了什么”和“是否送达”的语义。
- 对不确定状态失败关闭，符合高风险操作的安全目标。
- 分布式事务无法覆盖本地 Codex 的实际工具副作用，复杂度高且仍不能消除所有歧义。

### 已知风险

- Codex 协议可能不提供完整的持久化请求查询或副作用去重能力。
- 首响应仲裁仍是实验性实现行为，跨版本可能变化，不能依赖其替代 YuruPager 门闩。
- `serverRequest/resolved` 不包含获胜决定或操作者；本地 TUI 抢先响应时，Connector 无法仅凭该通知生成完整审批审计。
- Connector 在响应 Codex 的瞬间崩溃会产生不可完全消除的模糊窗口。
- 故障注入确认恢复历史会丢失 command execution item；仅凭 turn completed 不能消除模糊状态。
- `execution_status` 对不同工具只能做到尽力而为，不能替代真实系统审计。
- 过期决定是否需要向 Codex 显式发送拒绝，依赖 Adapter 能力。
- PRD 当前把 `delivered` 列为请求状态，后续需要同步为独立投递状态。

### 验证方式

- 从多台客户端并发提交批准和拒绝，确认只有一个条件更新成功。
- 在两个 app-server 客户端之间分别测试先批准和先拒绝，并确认迟到相反响应不改变副作用。
- 对相同和不同 Idempotency-Key 进行重复、乱序和冲突测试。
- 在数据库提交、Outbox 发布、Connector 落盘、Codex 响应和回执之间逐点杀进程。
- 对破坏性测试命令使用隔离沙箱和一次性资源，确认不发生重复副作用。
- 验证过期、取消和撤销权限与审批并发时的确定结果。
- 验证 `ambiguous` 状态不会自动放行，并能产生告警和人工恢复入口。
- 已验证 `sent_unknown` 跨进程保留、第二次批准 dispatch 被阻止，且恢复端不重放已处理审批。
- 使用状态机属性测试证明不存在从最终状态返回 `pending` 的路径。

### 重新评估条件

- Codex 提供稳定的请求查询、结果查询和原生幂等执行键。
- 产品要求跨服务、跨区域的更强一致性保证。
- 实测发现 `ambiguous` 状态频率不可接受。
- 支持新的代理后，其审批回调和工具执行模型与 Codex 明显不同。
- 高风险工具能够接入外部事务或原生去重机制。

---

## ADR-007：Token 用量累计、校准和成本计算

- 状态：MVP 采纳
- 决策日期：2026-08-03

### 背景与约束

YuruPager 需要按工作空间、工作站、项目、会话、模型和发起人记录 Token 用量。Connector 重连或事件重放不得重复累计，数据缺失也不得显示为零。

当前 Codex `thread/tokenUsage/updated` 提供 `last` 和 `total` 两组用量，以及输入、缓存输入、缓存写入、输出、推理输出和总 Token。事件是累计快照还是结算依据必须通过 Spike 确认。ChatGPT 订阅用量也不等同于按 Token 计费账单。

### 候选方案

1. 收到每个事件后直接把 `totalTokens` 相加。
2. 只保留会话结束时的最终总数。
3. 保存有序累计快照，并维护可重建的规范化汇总。
4. 完全依赖模型提供商的账单或用量 API。

### 选择结果

选择“有序累计快照 + 最终校准 + 版本化价格目录”：

- Connector 将每个用量事件关联到 workspace、workstation、thread、turn、model、provider 和 source sequence。
- 服务端保存不含内容的最小用量快照，并以事件 ID 或 `(device_id, connection_epoch, sequence)` 唯一去重。
- 对同一 thread/turn，`total` 视为累计快照，新快照替换旧汇总；禁止把多个 `total` 直接求和。
- `last` 只在确认其对应单次上游完成时作为增量证据，不作为无条件累计来源。
- 会话进行中标记为 `provisional`，在 `turn/completed` 后等待最终用量事件并标记为 `final`；缺少最终事件时标记 `incomplete`。
- 保存 input、cached input、cache write、output、reasoning output 和 total 的独立整数列。
- 模型切换或 reroute 时按模型分段；无法可靠拆分时不把全部成本归到最后一个模型，而标记成本不可用或估算。
- 价格目录记录 provider、model、service tier、币种、各 Token 类别单价、生效区间、来源和版本。
- 成本使用定点十进制或整数微货币单位计算，禁止浮点数。
- 推理 Token 是否已包含在输出计价中由 provider pricing adapter 决定，禁止重复计费。
- ChatGPT 订阅会话默认只展示 Token 用量，不展示伪造的按量账单成本。
- 估算成本始终展示价格版本和“估算”标记，不替代提供商账单。

### 选择理由

- 累计快照可抵抗重复、重放和中间事件丢失。
- 保存最小原始快照后，可以修复聚合逻辑而不需要重新读取用户内容。
- 最终校准兼顾实时展示和结算准确性。
- 版本化价格避免模型调价后历史成本被重新解释。
- 区分 Token 用量和实际账单，避免误导 ChatGPT 订阅用户。

### 已知风险

- 模型 reroute 时按模型分段的准确性仍需验证。
- `thread/resume` 会重放累计快照，若事件 ID 和连接序号设计错误仍可能重复累计。
- 不同提供商的缓存和推理 Token 定义不一致。
- 模型价格变化、批处理折扣和企业合同价难以自动覆盖。
- 会话发起人无法识别时，用量只能归属到工作站或未知主体。

### 验证方式

- 使用固定任务对比 Codex 界面、Schema 事件和 YuruPager 汇总结果。
- 注入重复、乱序、缺失和重连事件，确认累计值不增加两次。
- 验证 turn 完成前后的 provisional、final 和 incomplete 转换。
- 验证上下文压缩、会话恢复、模型 reroute 和多个 turn。
- 已验证多个 turn、手动 compact 和 app-server 重启后 `total` 单调增长，resume 会重放快照且不重置累计值。
- 为价格计算器建立已知输入输出的 Golden Tests，覆盖缓存和推理 Token。
- 验证历史价格版本在新价格发布后保持不变。
- 验证导出文件不包含提示词、代码、Diff 或终端输出。

### 重新评估条件

- Codex 发布稳定且语义明确的用量或账单 API。
- 当前用量事件无法可靠关联 thread、turn 或模型。
- 产品开始支持多个模型提供商，需要独立的用量 Ledger 服务。
- 企业客户要求导入合同价、预算强控或财务级对账。
- 用量数据规模需要从 PostgreSQL 迁移到专用分析存储。

---

## ADR-008：认证、设备密钥及工作空间授权模型

- 状态：MVP 暂定采纳
- 决策日期：2026-08-03

### 背景与约束

YuruPager 同时包含用户、手机安装实例、工作站 Connector 和工作空间。个人、公司和团队数据必须隔离，设备可被撤销，高风险决定需要确认实际操作者。

设备不能长期持有用户密码或 Codex/OpenAI 凭证。配对二维码必须短期、单次使用并绑定目标设备。推送令牌只能用于路由，不能作为身份凭证。

### 候选方案

1. 自建邮箱密码认证，并让所有设备共享用户访问令牌。
2. 托管 OIDC 用户认证，服务端自建工作空间授权，设备使用独立非对称密钥。
3. 完全依赖第三方组织和授权模型。
4. Passkey-only 用户认证和设备认证。

### 选择结果

选择“OIDC 用户认证 + 独立设备身份 + 服务端授权”：

#### 用户与手机认证

- 使用支持 OAuth 2.0/OIDC 的托管身份提供商，具体厂商在部署区域和商业条件确认后选择。
- PWA 通过 Backend for Frontend 使用 Authorization Code + PKCE，不自建密码存储；原生 iOS 同样复用 BFF 会话边界。
- 身份提供商 Refresh Token 经加密后仅保存在服务端；浏览器只持有 `Secure`、`HttpOnly`、`SameSite` 会话 Cookie，禁止把长期令牌写入 `localStorage`。
- PWA 会话短期有效、可撤销并实施 CSRF 防护；原生 iOS 使用 URLSession Cookie Store 和 Keychain 恢复会话，未来 Android 原生客户端使用 Keystore 保存轮换凭证。
- 每个 PWA 安装实例在支持时生成 WebCrypto 非导出签名密钥并注册公钥；浏览器存储被清除后必须重新注册该安装实例。
- 用户决定除 OIDC 身份外还绑定手机安装实例身份。
- 高风险审批使用 WebAuthn/Passkey 二次认证，并记录认证时间和凭证 ID。

#### 工作站配对与设备密钥

- Connector 首次启动时生成 Ed25519 密钥对，私钥只保存在本机 Keychain/Keystore。
- Connector 向服务端创建配对会话并上传公钥、设备信息和随机数。
- 二维码只包含服务地址和高熵、短期、单次配对凭证；服务端只保存凭证哈希。
- 已登录用户扫描后选择目标工作空间，核对设备名称和指纹并确认绑定。
- 服务端原子消费配对凭证，绑定公钥、工作站和工作空间。
- Connector 通过签名挑战换取绑定 device、workspace 和 audience 的短期访问令牌。
- 每个上行关键事件由设备密钥签名，签名覆盖事件 ID、工作空间、设备、时间戳、随机数和载荷摘要。
- 撤销设备后立即关闭活动连接，拒绝新令牌，并要求重新配对才能恢复。

#### 工作空间授权

- 使用基础 RBAC：Owner、Admin、Member。
- 使用 `workstation_access` 进行资源级授权，至少包含 `session:view`、`request:respond`、`request:approve_high_risk`、`usage:view` 和 `workstation:manage`。
- 每次 API、WebSocket 订阅、推送派发和决定提交都实时检查 Membership、工作站授权和策略版本。
- 工作空间策略可以收紧角色权限；设备或用户设置不能绕过上层强制策略。
- 决定签名绑定 `request_id`、decision、timestamp、nonce 和 Idempotency-Key，防止篡改与重放。
- 服务端只把经过授权校验的最小上下文发送到手机客户端。

### 选择理由

- OIDC 避免 YuruPager 自建密码认证和账户恢复的高风险实现。
- 用户身份、手机设备和工作站设备相互独立，便于精确撤销和审计。
- 非对称设备密钥避免在多台设备之间共享长期 Secret。
- RBAC 解决常见角色需求，工作站授权解决多人共享设备时的细粒度边界。
- 服务端保留授权事实来源，可以立即处理成员移除和策略变更。

### 已知风险

- 托管身份提供商可能造成供应商锁定、区域合规或成本问题。
- PWA 对安全存储和硬件密钥的控制弱于原生应用，浏览器数据清理也会使安装实例密钥丢失。
- 设备时钟偏差会影响签名时间窗和重放防护。
- 工作站迁移、账户恢复和丢失所有 Passkey 的流程较复杂。
- Ed25519 私钥在所有目标平台上未必都能使用硬件保护。
- 短期访问令牌在撤销到连接关闭之间仍存在很短的暴露窗口。

### 验证方式

- 验证配对凭证过期、重复扫描、并发消费和绑定错误工作空间时全部失败。
- 验证请求签名篡改、过期时间戳、重复 nonce 和错误 audience 被拒绝。
- 验证成员移除、角色降级、工作站撤权和设备撤销能终止现有访问。
- 对每个权限执行正向、反向和跨工作空间测试。
- 验证手机丢失、工作站重装、私钥损坏和账户恢复流程。
- 进行 OIDC 登录 CSRF、PKCE、Refresh Token 重放和会话固定测试。
- 验证高风险请求在 WebAuthn 失败、取消或超时后保持未批准状态。
- 对配对、签名、授权和撤销流程进行独立威胁建模和渗透测试。

### 重新评估条件

- 企业客户要求 SAML、SCIM、域名验证或自带身份提供商。
- 目标市场的数据驻留要求排除当前托管身份服务。
- 原生客户端上线，可以使用 Secure Enclave/Keystore Attestation。
- 需要两人审批、临时授权或按项目动态审批人。
- 设备证明、零信任网络或硬件密钥成为企业准入要求。
- 需要端到端加密，使服务端不能读取审批上下文。

## ADR-009 至 ADR-013：第一阶段工程基线

- 状态：MVP 采纳
- 决策日期：2026-08-04

### Monorepo 结构

采用 npm workspaces。根目录继续承载已经验证的 TypeScript Connector 与 21 项测试，避免在实施阶段搬迁 Spike 边界；`apps/server`、`apps/web` 和 `packages/shared` 分别承载服务端、Web/PWA 与跨端协议。构建产物保持独立，根脚本统一执行 lint、typecheck、单元、集成和端到端测试。

### 服务端框架

采用 Fastify 模块化单体，同时提供版本化 REST、用户实时 WebSocket、Connector WebSocket 和生产静态 Web。审批原子迁移、授权、审计和 Outbox 保持在同一 PostgreSQL 事务中；第一阶段不拆分消息代理或微服务。Fastify 的插件边界用于隔离认证、数据库、REST 与两个 WebSocket 协议，但不制造跨服务一致性问题。

### 数据访问层

采用 SQL-first `pg` repository，不引入会隐藏 session-local RLS 上下文或复合外键的 ORM。迁移显式定义共享 Schema、每张租户表的 `workspace_id`、`(workspace_id, id)` 唯一键、复合外键和 RLS policy。每个用户事务先设置 `app.user_id` 与 `app.workspace_id`；服务角色只用于登录、设备握手和受控后台任务。

### 认证方案

生产边界保持 ADR-008 的 OIDC Authorization Code + PKCE BFF：浏览器只接收 `Secure`、`HttpOnly`、`SameSite` 会话 Cookie。为了让离线可运行的 Alpha 可验证登录流程，服务端提供显式标记的本地开发身份提供器，使用 scrypt 密码哈希和相同的服务端会话表；它仅在 `AUTH_MODE=local` 时启用，不能与生产 OIDC 同时启用。Connector 继续使用独立设备凭据，不复用用户会话。

### 部署方式

本地开发使用 Docker Compose 启动 PostgreSQL，Node 进程分别热运行 Server 和 Vite Web；生产基线是同一 Fastify 服务镜像托管构建后的 Web/PWA，连接托管 PostgreSQL，并在边缘终止 TLS/WSS。迁移是显式发布步骤。第一阶段不引入 Kubernetes、Kafka、Redis 或多区域写入。

### 选择理由与边界

- 单一 TypeScript 工具链复用现有 Connector 类型和测试。
- 模块化单体将审批状态、Outbox 和审计保留在一个数据库事务中。
- SQL-first 使 RLS、复合外键和条件更新能够被直接测试，不依赖 ORM 推断。
- 本地身份提供器让 Alpha 可运行，但不把开发密码方案伪装成生产 OIDC。
- Compose 提供真实 PostgreSQL 与可复现启动方式，同时保持组件数最小。

### 重新评估条件

- 连接规模要求独立 WebSocket gateway 或消息代理。
- RLS session 上下文或复杂查询使当前 repository 边界不可维护。
- 首发身份提供商、区域和企业联合登录需求确定。
- 需要多区域写入、独立用量仓库或独立审计保留服务。

## ADR-014：主动消息采用临时明文 Outbox、`threadId` 级队列与 Connector 端 turn 门闩

- 状态：Alpha 采纳
- 决策日期：2026-08-06

Web 可以在已授权会话上提交最多 8,000 字符的单次文本输入；ADR-019 另行限定可与文本组合或独立发送的图片。服务端在同一 PostgreSQL 事务中校验 `can_respond`、幂等键和目标会话，创建只含元数据的 `session_commands` 记录，并把明文文本及不透明附件引用放入发往指定工作站的可靠 Outbox。Connector 只有在命令已跨过本机处理边界后才返回传输 ACK：结果为 `delivered`、`sent_unknown` 或可确定的 `failed` 时，服务端才能脱敏 Outbox 载荷；命令仅停留在 Connector 内存队列时不得 ACK 或标记为已处理。审计、快照和长期表不保存消息文本、图片字节或 Codex 回复。

Connector 为每个 `threadId` 维护独立 FIFO 队列。同一 thread 的首条待处理命令才创建独立 app-server 子进程；同一 thread 的后续命令必须保持在队列中，不能并发创建 writer、调用 `thread/resume` 或调用 `turn/start`。命令 handler 的 Promise 也随队列等待，因此可靠 Inbox 不会把“已进入内存队列”误认为“已经交给 Codex”。不同 thread 可各自推进，但每个 thread 始终只有一个由 YuruPager 创建的临时 writer。

队首命令先执行可安全重试的 `thread/resume`；成功后在本地 SQLite 门闩中原子迁移为 `sent_unknown`，再调用 `turn/start`。收到合法 turn ID 后才迁移为 `delivered`。`delivered` 表示该命令已经到达 `turn/start` 边界，可以 ACK；但其子进程继续持有 writer。只有收到该 turn 匹配的最终事件（完成、不可重试失败或中断）、关闭子进程且 `stop()` 完成后，Connector 才允许下一条同 thread 命令离开队列。终态通知可能早于 `turn/start` 响应到达；Connector 必须先记住终态 turn ID，并在响应带回 turn ID 后再完成释放，不能因该竞态提前启动后续命令。

`thread/resume`、附件校验等能够证明尚未调用 `turn/start` 的确定失败标为 `failed`，关闭子进程后才推进下一条队列命令。写入后的超时、崩溃或 RPC 不确定性保持 `sent_unknown`：该 `threadId` 队列进入持久阻塞，后续命令既不得启动也不得仅因排队而 ACK。即使 ambiguous 子进程因 24 小时未观察到终态而被关闭，阻塞也不能自动解除。Connector 重启时必须扫描本地 SQLite 中的 `sent_unknown` 记录并恢复相应 `threadId` 的阻塞；同一幂等命令的重放只上报既有未知状态，不再次调用 `turn/start`。恢复需要人工在工作站核对并走明确的后续恢复流程，重连和普通重试都不是解锁机制。

### 选择理由与边界

- 主动消息是有副作用的 turn 启动，不是可乐观显示的聊天消息。
- 临时明文是离线 Outbox 和崩溃恢复所必需的最小范围；处理完成立即脱敏，维持“不保存完整代理对话”的产品边界。
- PostgreSQL 幂等键阻止 Web 重复提交，本地 SQLite 门闩阻止 Connector 与 Codex 交界处的重复 turn。
- `threadId` 级串行将“一个 writer 对一个 active turn”的 Codex 进程语义转为明确的本地调度边界；先完成 writer 释放再启动下一条，避免两个短生命周期子进程争抢同一 thread。
- 传输 ACK 表示命令已跨过可恢复的本机处理边界，而不是仅被接收，也不等同于 Codex 已完成任务；`delivered` 与 `sent_unknown` 的业务状态仍必须由服务端快照与审计呈现。
- `sent_unknown` 的持久阻塞优先于吞吐量：它牺牲同一 thread 的自动继续能力，以避免在无法证明前一次 `turn/start` 是否生效时重复执行。
- 普通主动消息仍不上传代码、Diff、终端内容或任意附件；由用户显式选择的受限图片遵守 ADR-019，经授权 WSS 临时中转，可靠 Outbox 只保存不透明附件引用而不保存图片字节。
- 会话正在运行时 Codex 可能拒绝新 turn；进入 `turn/start` 边界后保守归类为 `sent_unknown`，不根据错误文案猜测是否执行。

### 重新评估条件

- app-server 提供带官方幂等键的 turn 创建协议。
- Codex 提供可验证的 turn 完成状态或官方恢复令牌，足以在不猜测副作用的前提下安全解除 `sent_unknown` 阻塞。
- 产品完成经审计的人工恢复交互，并能证明其不会把历史未知 turn 与新的主动命令并发执行。
- 产品需要任意文件附件、Connector 离线时的完整聊天历史或端到端加密消息。
- 多 Connector 工作站需要动态设备路由，而不是当前 Alpha 的单工作站凭据。

## ADR-015：Codex 对话仅在工作站持久化，公网服务只做授权后的内存中转

- 状态：Alpha 采纳
- 决策日期：2026-08-06

浏览器查看会话时，通过用户 WebSocket 发起临时订阅。服务端在 PostgreSQL RLS 与工作站授权下把 YuruPager `session_id` 解析为目标工作站和本地 Codex `thread_id`，随后只在进程内存维护浏览器、会话与 Connector 的路由。Connector 使用本地 `thread/read(includeTurns: true)` 重建历史，并转发订阅期间的用户消息、助手消息增量、完成校准和工作站侧生成的脱敏活动摘要。服务端不得把这些帧写入 PostgreSQL、可靠 Outbox/Inbox、审计正文、日志或备份。

对话传输与 ADR-004 的可靠业务传输明确分离：对话帧不使用 ACK、重放游标或持久队列，断线后也不从服务器恢复。浏览器刷新、WebSocket 重连或 Connector 重连时重新订阅并读取工作站本地快照；Connector 离线时历史不可用。订阅的 `thread/read` 尚未完成时若同时到达 live 通知，Connector 为该订阅标记立即二次同步，发送 `history.complete` 后再以新 `thread/read` 快照差量校准；历史完成后的通知立即转发并更新内存快照。此外，为了看到其他 Codex app-server 进程中的会话更新，Connector 在有订阅时每 500 ms 读取一次本地线程快照，只转发快照差量。Codex 的消息完成事件携带完整文本时，以完整文本重置同一消息，作为增量丢失后的在线校准。

临时通道允许 `userMessage`、`agentMessage` 文本、结构固定的活动摘要和 ADR-019 定义的受限图片帧。Connector 可把 command execution、file change、MCP / dynamic tool、Web search、image view / generation、协作代理、等待、review mode 与 context compaction 映射为动作类别、经过清洗的工具显示名、文件数量和状态；不得转发隐藏 reasoning、计划正文、原始命令、工作目录、参数、输出、Diff、文件路径、MCP 结果或错误正文。正文按 Unicode code point 切分为不超过 16 KiB 的片段，活动标签最长 120 个 Unicode code point；服务端逐字段校验 WebSocket 帧且不记录原始载荷。图片内容不复用活动摘要，必须走 ADR-019 的独立有序分块协议。

### 选择理由与边界

- 工作站继续拥有 Codex thread 的唯一持久副本，公网中转服务器不会因此获得完整会话数据库的数据权限。
- 在线内存中转提供接近 VS Code 远程扩展的查看体验，同时保持“工作站离线则历史不可用”的诚实边界。
- 授权在每次订阅时执行，成员移除或工作站撤权后可立即取消订阅；内部 `thread_id` 不暴露给未授权浏览器。
- 流式正文不是审批、决定或 turn 启动的事实来源，不承担业务可靠性。主动消息仍使用 ADR-014 的幂等和 `sent_unknown` 门闩。
- 第一阶段不提供端到端加密，因此已授权的服务进程可在转发瞬间读取文本与 ADR-019 的受限图片；目标是零持久化而不是声称服务器绝对不可见。

### 重新评估条件

- 产品需要 Connector 离线时仍可查看历史或跨设备搜索对话。
- 企业部署要求服务端对正文也不可见，需要端到端加密和浏览器设备密钥。
- app-server 提供稳定的官方远程会话协议、访问令牌和细粒度内容过滤。
- 多实例 WebSocket 服务需要跨进程路由；只能采用不落盘的短生命周期消息通道，或重新进行隐私评审。

## ADR-016：短期单次配对与独立工作站凭据

- 状态：Alpha 采纳
- 决策日期：2026-08-08

工作空间 Owner、Admin 或具有 `workstation:manage` 权限的成员可以创建十分钟有效的单次配对会话。服务端生成高熵配对码，只在创建响应中返回明文，数据库仅保存 SHA-256 哈希。Connector 使用配对码登记本机生成的公钥、设备名称、平台和 Connector 版本；登记不会自动授权。用户必须在 Web 中核对公钥指纹和设备信息并显式确认，服务端再以条件更新原子消费配对会话、创建工作站和默认管理授权。

确认时服务端生成每台工作站独立的高熵设备凭据，数据库只保存凭据哈希，明文只允许已登记的 Connector 通过配对结果轮询取得一次。Connector 将凭据与工作空间、工作站和服务地址写入权限 `0600` 的本地配置，并用该凭据进行 WSS Bearer 认证。WSS 每次握手动态解析设备身份、检查撤销状态并路由到对应工作空间和工作站；撤销不影响其他设备。现有 `CONNECTOR_TOKEN` 固定身份只保留为显式 Alpha 迁移兼容路径，不用于新配对。

为了让未发布 npm 包时仍能实际安装，服务端托管与当前服务版本匹配的 Connector 安装包和校验信息；Web 生成的命令从当前可信 origin 下载后执行 `setup --server <origin> --pair <code>`。安装器不包含用户会话、配对码或长期凭据。macOS 使用 LaunchAgent，Linux 使用用户级 systemd；无法安装后台服务时保留已配对配置并给出可重复执行的明确启动命令。

第一阶段以高熵设备凭据作为 WSS 身份，Connector 同时生成 Ed25519 公钥用于人眼指纹核对和未来签名挑战升级。当前不声称硬件密钥保护或逐事件签名；当设备签名挑战实现后，版本化迁移现有凭据而不是共享 Secret。配对权限与工作站访问权限继续分离，服务端不得把长期凭据、配对码、公钥私钥或 Codex 内容写入审计正文和日志。

验证必须覆盖配对码过期、哈希存储、不同设备竞争登记、两位管理员竞争确认、确认与取消竞争、跨工作空间隔离、结果只领取一次、未确认设备拒绝 WSS、凭据撤销和 Connector 配置 `0600`。静态兼容 Token 删除前，公网部署至少完成一台现有 Connector 到独立凭据的迁移。

## ADR-017：原生 iOS 客户端使用 SwiftUI 并复用现有服务边界

- 状态：Alpha 采纳
- 决策日期：2026-08-09

### 背景与选择

在 PWA 之外增加原生 iOS 客户端，用于更稳定的平台导航、辅助功能、前后台恢复，以及后续接入 APNs、Keychain、Secure Enclave 和设备合规能力。客户端使用 SwiftUI、URLSession 和系统 WebSocket，不用 WebView 包装现有页面，也不引入第二套服务协议。

iOS App 直接复用 `POST /api/auth/login`、`GET /api/auth/me`、`GET /api/snapshot`、决定与主动消息 REST API，以及 `/api/live` 用户 WebSocket。共享 TypeScript Schema 在 Swift 中建立 Codable 镜像，并通过固定 JSON 夹具和契约测试防止漂移。最低版本采用 iOS 17；工程不依赖 CocoaPods、第三方网络库或自定义动画框架。

### 状态、隐私与凭据边界

- URLSession 共享 Cookie Store 负责 HttpOnly BFF 会话；跨启动保存的会话 Cookie只能进入 Keychain，密码不得持久化。
- UserDefaults 只保存服务器 URL 和最近工作空间 ID。REST 快照、请求上下文、问题答案和完整 Codex 正文不进入 UserDefaults。
- App 进入前台或实时失效通知到达时重新获取服务端快照。推送仅作唤醒提示，不携带可执行决定，也不替代快照。
- 当前会话正文只在前台内存中存在，离开详情、切换会话、断线、进入后台或退出登录立即清空。服务端继续遵守 ADR-015 的内存中转边界。
- 决定和主动消息使用稳定 `Idempotency-Key`。客户端等待服务端确认，不做有副作用的乐观更新；`sent_unknown` 不自动重试。
- APNs 设备注册、后台通知撤回、Passkey/Secure Enclave 二次认证和 App Store 分发需要 Apple entitlement、签名身份与服务端凭据，作为后续独立部署决策，不伪装为当前本地工程已完成。

### 工程与验证

仓库新增 `apps/ios` 原生工程，并把无 UI 的 Codable 模型、URL 构造、会话流归并和幂等提交状态提取为本地 Swift Package，使没有完整 Xcode 的环境仍可运行核心测试。完整 Xcode 环境必须额外执行 iOS target 构建、XCTest/UI Test、模拟器截图、VoiceOver、Dynamic Type、Reduce Motion 和真机网络恢复验证。

重新评估条件：需要 Android 共享业务实现、Schema 变化频率使手工 Codable 镜像不可维护、APNs/设备证明成为发布门槛，或官方 Codex 远程控制协议替代当前中转边界。

## ADR-018：工作站全局分页发现 Codex 项目，会话仍由本机持久化

- 状态：Alpha 采纳
- 决策日期：2026-08-09

Connector 启动时调用不带 `cwd` 的全局 `thread/list`，沿 `nextCursor` 分页读取工作站上当前 Codex 身份可见的全部 thread，并每 30 秒刷新；`thread/started` 触发一次增量刷新。每轮成功扫描还发送带随机清单 ID 的 `session.inventory`，服务端将本轮未出现的旧记录标记为 `stale`（保留记录但默认隐藏），避免历史线程无限累积到实时索引。游标重复或协议字段无效时停止本轮扫描并保持上次有效状态，避免无限循环和错误扩散。`YURUPAGER_PROJECT_PATH` 与 `YURUPAGER_PROJECT_NAME` 仅作为旧版 app-server 缺少路径时的回退，不再作为发现边界。

每个 thread 的绝对 `cwd` 在 Connector 端经 `realpath` 规范化。项目显示名取规范路径的 basename；项目身份使用规范路径的 SHA-256 `projectKey`。服务端只持久化该不透明项目键、显示名和路径提示，以及 thread ID、模型、状态和 Codex 原始时间戳。列表 `preview`、rollout 路径、Git 元数据、环境变量、源代码、Diff、终端输出和完整对话在 Connector 端丢弃。完整对话继续遵守 ADR-015，只在用户打开会话时从工作站本机读取并经内存中转。

Codex 0.147 的 `thread/list` 同时提供官方生成的 `name` 与完整首条用户消息 `preview`。两者采用不同隐私等级：Connector 只读取并清洗 `name`，最多保留 120 个 Unicode code point，经既有 WSS 发送最多 200 条的临时快照；不得读取、推导或发送 `preview`。服务端只在 Connector 在线期间于进程内存缓存标题，并使用 RLS 与 `app_can_view_workstation` 将 thread ID 映射为获授权用户可见的 session ID。标题不进入 `session.upsert`、PostgreSQL、Connector SQLite Outbox/Inbox、审计、日志、REST 快照、service worker 缓存或备份；客户端只在当前内存中使用，实时连接重建前显示 thread ID 占位。

Web 按 `workspace_id + workstation_id + projectKey` 分组，避免同名目录错误合并；规范路径使同一目录的符号链接入口合并。组内会话按 Codex `updatedAt` 降序排列，项目按最近会话排序。项目标题是可键盘、触摸和屏幕阅读器操作的 disclosure，展开状态不改变会话选择，也不触发有副作用的提交。

Codex `notLoaded` 和 `idle` 表示历史线程未处于当前活动 turn，不表示等待用户批准；Connector 将其映射为 `completed + historical`，客户端显示“历史会话”。只有 `active` 且带等待标志的线程显示为“等待处理”。

### 选择理由与边界

- 用户连接一台工作站后即可看到该机的多个 Codex 工作项目，无需为每个目录重新安装 Connector。
- 项目列表只是本机会话索引，不把公网服务升级为 Codex 数据库或代码仓库。
- 不透明项目键解决同名目录和符号链接问题，同时不把原始路径当作跨设备稳定主键。
- 第一阶段不提供远程新建项目、目录浏览、代码同步、Diff 或终端。

### 重新评估条件

- app-server 提供稳定的项目或 workspace 原生标识与增量游标。
- 工作站 thread 数量使 30 秒分页轮询产生可测量的性能问题。
- 产品需要让用户隐藏、固定或按授权策略过滤特定本机项目。
- 服务端不再允许保存路径提示，需要改为只保存工作站生成的脱敏标签。

## ADR-019：会话图片使用授权 WSS 临时分块中转，并由 Connector 私有持久化

- 状态：Alpha 采纳
- 决策日期：2026-08-11
- 替代范围：替代 ADR-014 中“第一阶段不发送图片”的边界；文本命令、幂等门闩和 `sent_unknown` 规则继续有效

### 背景与约束

用户需要在 Web、移动 PWA 和原生 iOS 会话中查看 Codex 明确返回的图片，也需要从 YuruPager 选择图片作为下一轮 Codex 输入。图片可能包含屏幕截图、设计稿或其他敏感内容，因此该能力不能把公网服务升级为文件仓库，也不能让服务端通过原始路径、文件名或 Markdown 链接读取工作站上的任意文件。

第一阶段只接受 PNG、JPEG 和 WebP。单次消息最多 4 张，单张最多 5 MiB，所有图片合计最多 12 MiB；任一限制不满足时整次图片提交在 `turn/start` 前失败关闭。客户端和 Connector 都必须校验数量、声明 MIME、文件签名与累计字节数；不接受 SVG、远程 URL、任意文件附件或仅依赖扩展名的类型判断。

### 选择结果与协议

图片字节只通过已认证的用户 WebSocket、服务端进程内存路由和目标 Connector WSS 临时中转。输入和输出共用带稳定图片 ID 的独立帧族：开始帧声明会话、turn、角色、格式、字节数和可选尺寸；分块帧携带严格递增序号；完成帧携带摘要；失败帧只携带规范错误码。服务端按现有 RLS 与工作站授权解析会话，查看 Codex 图片要求 `can_view`，上传图片要求 `can_respond`，并对每个订阅、上传和分块重新约束工作空间、工作站、会话、总大小与序号。

服务端不得把图片字节写入 PostgreSQL、可靠 Outbox/Inbox、ACK 载荷、审计、应用或代理日志、临时文件、对象存储、备份、Service Worker cache、`localStorage`、`sessionStorage`、IndexedDB 或 iOS `UserDefaults`。图片帧不进入离线快照和推送。原图绝对路径、相对路径和文件名不得离开 Connector 或客户端；云端协议只使用不透明图片 ID、格式、大小、尺寸、序号和摘要。公网服务可在转发瞬间读取明文图片，本阶段承诺的是授权后的零持久化，不声称端到端加密。

用户选择图片时，客户端只在本机内存建立预览。用户显式点击发送后，客户端才经 WSS 有序上传；Connector 校验完整摘要后，以随机不透明名称写入权限 `0700` 的私有目录和权限 `0600` 的附件文件，并返回只绑定当前工作空间、工作站、会话和上传意图的不透明附件引用。该本地持久附件属于 Codex thread 的工作站侧历史，可供后续 `thread/read` 重建用户图片；服务端可靠 Outbox 只允许保存附件引用和数量，不得保存图片字节、原始路径或文件名。图片可以不附带文本独立发送。

Codex 返回官方图片 item 时，Connector 从 app-server 提供的结构化 item 定位本地内容，生成稳定图片 ID，并按原 item 顺序发送开始、分块、完成或失败帧。不得从 assistant Markdown、任意远程 URL、工具输出文本或猜测路径自动读取文件。浏览器与 iOS 只在当前授权会话内存中组装图片；刷新、WebSocket 重连或重新打开会话时，通过 Connector 本地 Codex thread 历史重新发送，而不是从服务端恢复旧副本。`activity.upsert(activity = image)` 继续表示查看或生成动作状态，不得代替图片内容帧。

### 提交、取消和恢复边界

选择、预览、移除和取消文件选择都是本地可逆操作。图片上传要求目标 Connector 在线；离线时可以保留本地草稿，但发送按钮必须禁用并解释原因，不能把图片字节放入云端离线队列。点击发送授权“一次附件暂存 + 一次 turn 尝试”，提交过程分为 `uploading -> staged -> queueing -> queued`；只有服务端确认 `queued` 后客户端才清空文字与图片草稿。

上传取消、断线、大小或摘要校验失败、Connector 写盘失败，以及任何能够证明尚未调用 `turn/start` 的错误，都保留草稿和同一幂等意图，允许用户显式重试；局部文件必须立即清理，Connector 重启时还要清理未完成分块。Connector 在调用 `turn/start` 前继续使用 ADR-014 的本地门闩。跨过该边界后，超时、崩溃或响应不确定一律归类为 `sent_unknown`，不得自动重新上传、重新排队或再次调用 `turn/start`；界面要求用户到工作站核对。

Connector 对已经进入 Codex thread 的附件保留工作站侧私有持久副本，使历史在服务端重启后仍可重建。删除 thread、撤销工作站或执行明确的本地数据清理时，Connector 必须删除对应附件；服务端无权枚举该目录或通过附件 ID 反推出本地路径。

### 选择理由与拒绝方案

- 沿用 ADR-015 的授权内存中转可复用现有会话路由，同时不建立新的云端图片数据库或 CDN。
- Connector 本地私有持久化让图片和 Codex thread 具有同一所有权及离线边界；工作站离线时历史图片诚实地不可用。
- 不透明附件引用把可靠命令状态与图片字节分离，使现有幂等和 `sent_unknown` 门闩继续覆盖实际 `turn/start` 副作用。
- 拒绝 Base64 图片进入 REST JSON、PostgreSQL Outbox、审计或日志；拒绝服务端磁盘缓存、对象存储、公开或长期签名 URL、原路径与文件名上云、自动抓取 Markdown 图片、SVG、任意附件、工作站离线排队图片，以及在 `sent_unknown` 后自动重发。

### 已知风险与验证

- app-server 图片 item 和 `turn/start` 图片输入仍是实验性协议，必须进入能力探测和版本门禁；能力缺失时隐藏或禁用图片入口，而不是退回不安全路径。
- WSS 分块存在 Base64 膨胀、移动网络中断和服务进程内存压力；实现必须限制并发、执行背压、逐块校验序号，并在超过 12 MiB 前终止。
- 公网服务转发时可以看到明文图片；需要服务端也不可见时必须引入设备密钥和端到端加密后重新评审。
- Connector 私有附件会增加本地磁盘占用；需要按 thread 所有权提供可审计的本地清理和容量上限，不得用静默云端备份解决。
- 自动化测试必须覆盖三种允许格式、类型伪装、4 张边界、单张 5 MiB、总计 12 MiB、越界拒绝、重复和乱序分块、摘要不符、上传取消、断网重连、Connector 与服务端重启、图片独立发送、权限不足、历史重建和 `sent_unknown` 不重发。
- 使用带唯一哨兵的图片、路径和文件名扫描 PostgreSQL、Outbox/Inbox、审计、日志、Service Worker cache、Web 持久存储和 `UserDefaults`，出现次数必须为零；Connector 私有文件权限必须实测为 `0600`。

### 重新评估条件

- 需要 Connector 离线时继续查看或发送图片。
- 需要跨工作站共享附件、云端搜索、长期链接或任意文件类型。
- 企业要求服务端无法读取图片明文，或要求集中式恶意内容扫描和保留策略。
- app-server 提供官方远程媒体流、稳定附件 ID、内容寻址或端到端幂等 turn 创建。

## ADR-020：开发预览使用独立 HTTPS origin、独立易失 WSS 与本机显式端口授权

- 状态：Alpha 采纳
- 决策日期：2026-08-11

### 背景与安全边界

用户在运行 Connector 的工作站上开发 Web 应用时，需要从另一台运行 YuruPager Web/PWA 的设备查看仅监听本机端口的页面，并让根路径资源、SPA 路由、模块加载和开发服务器 WebSocket 可以按原有 origin 语义工作。工作站通常没有公网 IP，且不得要求与查看设备位于同一局域网。

开发服务器可能暴露源码映射、`/@fs`、未认证管理接口、调试端点、环境信息或带副作用的本地 API。因此预览不是普通的 `can_view` 会话内容，也不能让 Web 用户输入任意主机或让 Connector 解析任意目标地址。端口只能由工作站用户在本机运行 `yurupager preview <port>` 显式开放；Connector 只连接固定 loopback 地址与该数字端口。协议拒绝主机名、LAN 地址、Unix socket、`CONNECT`、任意 TCP 转发和后台自动端口扫描。

预览页面不得位于 YuruPager 主站同源路径。否则不受信任的本地页面会继承主站 origin，并可能调用 REST、WebSocket 或读取同源存储。公网部署必须提供独立 HTTPS origin；本地 Docker 使用独立 `preview.localhost` origin。主站的浏览器 WebSocket 必须校验 `Origin`，存在的非安全方法 `Origin` 也必须与配置的 Web origin 精确匹配，作为 SameSite Cookie 之外的纵深防御。

### 协议、权限与生命周期

开发预览使用独立的 `/connector/v1/preview/ws`，只接受动态工作站凭据，不接受 Alpha 静态 Connector token 回退。该通道与审批、主动消息、心跳和可靠 Outbox/Inbox 分离，传输 HTTP 请求/响应及 WebSocket 数据的有界分块；所有流都是易失的，不发送可靠 ACK，不重放已经开始的请求，也不写入 Connector SQLite。服务端或 Connector 断线时关闭两端流，由浏览器显式刷新恢复。

工作站授权增加精确的 `can_preview` 能力。owner/admin 或对目标工作站具有 `can_preview` 的成员可以看到并打开预览；仅能查看会话或回复 Codex 不自动获得预览权限。创建路由的事实来自已认证 Connector，本地端口不会由浏览器 API 指定。服务端只持久化工作空间、工作站、路由 ID、显示标签、数字端口、状态、开始/到期/停止时间和聚合字节数；请求 URL、query、header、Cookie、body、响应内容和 WebSocket frame 不进入 PostgreSQL、审计正文、日志、Outbox/Inbox、缓存或备份。

本机命令创建随机路由 ID并声明 15 至 240 分钟的有效期，默认 60 分钟。状态机为 `connecting -> active -> stopped | expired | connector_offline | failed`。`Ctrl+C`、Web 明确停止、到期、工作站撤权或预览 WSS 失联都关闭现有流；同一进程可在短暂网络恢复后用同一路由 ID重新宣告，但已经完成或部分提交的 HTTP 请求绝不自动重放。非幂等请求在写入本机 HTTP socket 后失联时结果未知，界面和代理不得自行重试。

### 独立 origin 与访问票据

主站打开预览时先验证 Web session、工作空间和工作站 `can_preview`，再生成 60 秒有效且只可兑换一次的随机票据。主站以自动提交的 POST form 把票据送到预览 origin，避免票据进入 URL、浏览器 Referrer 和 Nginx access log。预览 gateway 原子消费票据后设置独立的 `Secure`、`HttpOnly`、`SameSite=Strict`、host-only、`Path=/` 上下文 Cookie，并重定向到根路径。该 Cookie 绑定 Web session、用户、工作空间、工作站、路由和到期时间；每个新 HTTP 或 WebSocket 连接重新校验 session、权限和路由状态。

Gateway 不把 YuruPager Cookie、Host、Origin、Referer、Forwarded、代理认证和 hop-by-hop header 转发到本机应用。Connector 为 HTTP 请求固定生成 `Host` 与 loopback `Origin`；WebSocket Upgrade 固定生成 loopback `Host` 但不合成 `Origin`，因为 Vite 7 会拒绝人工 loopback Origin，而浏览器公网 Origin 仍不得到达工作站。本机应用 Cookie 使用按路由命名空间隔离，绝不覆盖预览上下文或主站 Cookie；切换路由时清除预览 origin 的 cache 与 storage。Gateway 拒绝 Service Worker 脚本，防止旧预览在共享 origin 上持久拦截后续路由。响应 `Location` 只允许把精确 loopback origin 改写为预览 origin。

### 选择理由与拒绝方案

- 独立 origin 保持根路径、动态 import、fetch、SPA 和 HMR WebSocket 的正常行为，同时隔离主站 Cookie、API 和存储。
- 独立 WSS 避免大资源或慢浏览器阻塞审批、消息、心跳和 Codex 会话流。
- 本机前台命令让暴露端口成为可见、可停止的显式授权，不把 YuruPager Web 变成本机 SSRF 控制面。
- 拒绝主站同源 `/preview/:id`、HTML/JavaScript 字符串重写、公开 bearer URL、任意公网高端口、自动扫描常见开发端口、Cloudflare Quick Tunnel 等第三方默认数据路径、可靠队列保存请求，以及断线后自动重放。

### 已知限制与重新评估条件

- Alpha 的一个预览 origin 在同一浏览器 profile 中一次只选择一个活动路由；打开另一预览会替换当前上下文。需要并排查看多个路由时，应采用 wildcard 子域名和按路由独立 origin。
- 服务端在转发瞬间可以读取明文 HTTP 和 WebSocket 内容。本阶段承诺授权、隔离和零持久化，不声称端到端加密。
- 默认拒绝摄像头、麦克风、定位、USB、串口等浏览器权限；需要测试这些 API 时必须新增逐项权限和风险确认，不可整体放开。
- 自动化必须覆盖跨工作空间/撤权、伪造 Origin、票据重放、Cookie 泄漏、Service Worker、超限与乱序分块、慢网络、浏览器取消、服务重启、Connector 重连、非幂等请求断线、根路径资源、SPA、重定向和真实 HMR WebSocket。
- 当产品需要多人同时共享同一预览、多个路由并排、端到端加密、长期后台隧道、非 HTTP 协议或生产流量时重新评审。

---

## ADR-021：PWA Web Push 订阅、派发与隐私边界

- 状态：Alpha 采纳
- 决策日期：2026-08-11

### 背景与选择

Service Worker 只有 `push` handler 并不能形成可用通知链路；浏览器还必须在明确的用户手势中取得权限、创建 Push API 订阅、把端点登记给服务端，并由服务端在新请求提交后派发。推送可能延迟、重复或丢失，也不能替代审批状态机。

Alpha 使用标准 Web Push + VAPID。每个浏览器 profile 的订阅属于当前账户，而不是某一工作空间；派发时服务端按请求的 `workspace_id + workstation_id` 重新计算可查看且可响应的成员，绝不把订阅本身当作授权。账号级订阅表是共享 Schema 中唯一不带 `workspace_id` 的业务表，因为同一安装需要接收多个工作空间的唤醒；它以 `user_id` RLS 隔离，服务角色仅在派发和清理失效端点时访问。

通知载荷只包含版本、事件种类、不透明请求 ID、工作空间 ID 和创建时间。标题与正文使用固定通用文案，不包含工作空间名、工作站名、项目、命令、工具、风险、问题、对话、Diff、终端输出或决定。通知点击只导航到待办；页面恢复后必须重新获取 REST 快照并以其状态决定是否允许操作。

### 生命周期与失败策略

- 浏览器支持、服务端 VAPID 配置和用户权限是三个独立状态。服务端未配置时显示不可用；浏览器不支持时不展示虚假开关；权限为 `denied` 时显示浏览器设置恢复说明，不重复弹系统提示。
- 只有用户点击“开启通知”才调用 `Notification.requestPermission()` 和 `PushManager.subscribe()`。订阅成功且服务端确认登记后才显示已开启；服务端失败时立即撤销刚创建的浏览器订阅，避免假成功。
- 关闭通知先尝试删除服务端端点，再撤销本地订阅；网络失败保留已开启状态并允许显式重试，不能只在界面上乐观关闭。
- 同一 endpoint 被另一已登录账户明确登记时原子转移归属，防止共享浏览器把一个端点同时绑定两个账户。退出登录不会全局删除其他设备订阅；锁屏通知始终保持通用文案。
- 新 `request.created` 只有在 Connector Inbox 与领域状态同一事务提交成功且确认为首次插入后才触发一次派发任务。重复 envelope 不产生新任务。Web Push 自身允许至少一次到达；相同请求使用稳定 `tag` 由系统合并。
- Push provider 返回 `404` 或 `410` 时删除失效端点；`429`、`5xx` 和网络错误只记录有界计数与时间，不写入通知内容、密钥或完整 provider 响应。本阶段不建立持久通知 Outbox，丢失由前台快照恢复。

### 安全与验证

订阅 endpoint、`p256dh` 和 `auth` 是敏感设备路由数据，只能进入专用 PostgreSQL 表，不得进入审计 metadata、应用日志、Connector Outbox/Inbox、Service Worker cache 或客户端持久业务快照。VAPID 私钥只通过部署 secret 注入；Web 只获得公钥。

测试必须覆盖：未认证登记、跨账户 RLS、同端点归属转移、重复 Connector envelope 只派发一次、无工作站响应权限不派发、最小载荷扫描、`404/410` 清理、provider 暂时失败保留订阅、拒绝权限、登记失败回滚、本地关闭失败恢复、通知点击后的快照校准，以及 iOS 主屏幕 PWA、Android Chrome 和桌面浏览器真实设备接收。

## ADR-022：工程质量门禁采用 ESLint（flat config）+ typescript-eslint

- 状态：MVP 采纳
- 决策日期：2026-08-30

### 背景与约束

仓库此前的 `lint` 只是各 workspace 的 `tsc --noEmit`，能发现类型错误但无法约束代码质量规则（未使用符号、可疑异步模式等）。实施顺序 §4 step 8 要求把协议契约与故障注入纳入 CI 与发布门禁，前提是存在真正的 linter。约束：Alpha 已交付且代码风格已稳定，接入必须 warn 级起步、修完全部 error，禁止大范围重排或重新格式化代码；monorepo 包含 Node 端与 React 端 TypeScript 以及少量构建脚本。

### 候选方案

- ESLint（flat config）+ typescript-eslint：TypeScript/React 生态标准，支持基于类型的规则（如 `no-floating-promises`），可按目录精细配置作用范围。
- Biome：单工具、速度快，自带 formatter 与 linter，但不支持 TypeScript 类型感知规则；其核心优势在强格式化，与本仓库“不大范围重排”的约束直接冲突。

### 选择结果

- 采用 ESLint + typescript-eslint（flat config），根级 `eslint.config.js` 统一覆盖全部 workspace。
- 初始规则集为 `tseslint.configs.recommended`：`@typescript-eslint/no-unused-vars` 保持 error 并允许 `_` 前缀占位参数；`@typescript-eslint/no-explicit-any` 先降为 warn（当前遗留全部集中在测试文件），债务还清后升回 error。
- 排除范围：`vendor/`（第三方代码）、`src/spike/`（冻结的可复跑验证证据，保持原样）、`apps/ios/`（Swift，不在 ESLint 范围）与全部构建产物。
- 根 `npm run lint` = `eslint .` + 各 workspace 既有 `tsc --noEmit`；CI 的 Node job 执行同一命令。

### 选择理由

- Connector 与服务端中继是重异步代码，typescript-eslint 的类型感知规则是后续拆分 session-relay / preview-relay（纯重构）时的关键安全网；Biome 无此能力。
- flat config 单一根配置即可覆盖 monorepo，避免逐 workspace 重复维护。
- 不启用 formatter，零格式化噪音，满足“禁止大范围重排代码”的约束。

### 已知风险

- warn 级 `no-explicit-any` 留存在测试文件中，需要后续清理。
- 尚未启用类型感知 lint（需要 `parserOptions.project` / projectService，首次开启的告警量与耗时需单独评估），也尚未接入 eslint-plugin-react-hooks。

### 验证方式

- `npx eslint .` 达到 0 error（2026-08-30 基线：13 warnings，全部为测试文件的 `no-explicit-any`）。
- `npm run lint`（ESLint + 各 workspace tsc）全绿，CI Node job 覆盖同一门禁。

### 重新评估条件

- 测试文件 `any` 债务清零后，将 `no-explicit-any` 升回 error。
- 引入类型感知 lint 或 react-hooks 插件时，重新评估 lint 时长与告警预算。
- 若未来引入 Biome 仅作 formatter 与 ESLint 并存，需重新评估规则重叠与执行顺序。

## ADR-023：数据库 Schema 采用有序幂等的版本化迁移（自研编号 SQL runner）

- 状态：MVP 采纳
- 决策日期：2026-08-30

### 背景与约束

Alpha 期间的 schema 是单个 `apps/server/db/001_initial.sql`（709 行），服务启动时整体执行。这无法表达后续增量变更、没有执行历史，也无法判断线上库已经具备哪些变更。约束：线上 Alpha 库已由 001 整体初始化，升级必须平滑；遇到线上 schema 不确定时执行“只加不改不删”兼容策略；ADR-011 保持 SQL-first 数据访问。

### 候选方案

- node-pg-migrate：成熟框架，但迁移以 JS 对象表达，与现有纯 SQL 基线衔接需要重写 001，并引入新依赖。
- 自研编号 SQL runner：迁移是纯 `.sql` 文件，按文件名序号排序执行，`schema_migrations` 表记录历史，advisory lock 串行化并发启动。

### 选择结果

- `apps/server/db/migrations/` 存放 `NNNN_name.sql`；`0001_initial_alpha_schema.sql` 即原 Alpha 基线，内容逐字保留。
- `apps/server/src/migrations.ts`：启动时 `CREATE TABLE IF NOT EXISTS schema_migrations`，按序执行未应用的迁移，每个迁移与其历史记录在同一事务内提交，失败整体回滚且不留记录；`pg_advisory_lock`（集群级）串行化并发启动。
- 旧库识别：`schema_migrations` 为空且 `public.app_users` 已存在时，仅登记 0001 不重新执行（对应前版本化时代整体初始化的库），随后只应用 0002 及之后的增量。
- `migrateAndSeed` 改为 `runMigrations` + `seedAlpha`，对 `app.ts` 与测试的调用签名不变；Dockerfile 已打包 `apps/server/db`，镜像内迁移路径无需调整。
- 迁移测试 `apps/server/test/migrations.test.ts` 覆盖：新库一键初始化与幂等重跑、旧库补登记不重跑、按序应用 / 失败回滚 / 断点续跑。

### 选择理由

- 保持 SQL-first：迁移即 SQL，可直接在 psql 中审查、手工执行与比对。
- 零新依赖，与既有 admin/app/connector 三连接池模型直接兼容。
- 基线整体保留为 0001，旧库无需猜测已应用哪部分 schema，天然满足“只加不改不删”。

### 已知风险

- 迁移不自动生成 down 脚本；回滚依赖前向修复迁移。
- 0001 含 `CREATE ROLE`（集群级对象），依赖其 `IF NOT EXISTS` 守卫；多集群部署需运维保证单一迁移入口。

### 验证方式

- `npm test --workspace @yurupager/server`（含 3 个迁移测试）全绿。
- e2e webServer 启动时对既有本地库执行 `runMigrations`，验证旧库登记路径；CI Node job 覆盖新库初始化路径。

### 重新评估条件

- 出现需要数据回填（非 DDL）的迁移时，评估批处理与限流方案。
- 迁移数量超过约 20 或明确需要 down-migration 时，重新评估 node-pg-migrate 等工具选型。

## ADR-024：多 Agent 运行时（AgentRuntime 接口 + 扇出编排）

- 状态：Phase 1 采纳（2026-08-30 实施复核）
- 决策日期：2026-08-30

### 背景与约束

YuruPager 现为单一 Codex 控制台：`ConnectorRuntime` 直接持有 `CodexAppServerClient`，会话发现、审批、流订阅全部内联。产品要支持 ACP（Agent Client Protocol）及原生 CLI 的多类编码 agent，同时安全不变量（正文/图片不持久化、高危 fail-closed）与已部署 Codex Alpha 的兼容性不可破坏。

### 候选方案

- A：从 `ConnectorRuntime` 现有消费面提取 `AgentRuntime` 接口（initialize/能力探测、listSessions 可为空、spawnOrAttach、subscribe、sendPrompt、respondToApproval、cancel 可选、usageStream 可选）；Codex 为第一个实现（行为保持重构），ACP 运行时为第二个实现，覆盖全部 ACP agent；仅当 ACP 路径有损时才新增原生适配器。
- B：每个 agent 一套独立 runtime 与独立云端连接。连接数、审批仲裁与断线恢复语义都要按连接复制，成本高且与“工作站在服务器看来是一台设备”的模型冲突。

### 选择结果

- 选择 A。Connector 编排层变为 `{agentId → AgentRuntime}` 扇出：共享同一 `ConnectorCloudClient`（同一 WSS、同一 outbox/ACK/replay），按会话归属路由云端回调。
- 每 agent 一份能力档案（发现方式、审批映射、用量上报、图片能力），由 ADR-027 的能力探测产生。
- 现有 SQLite journal/ledger/decision 数据无 agent 维度仍沿用：Phase 1 仅 codex 一个运行时，多 agent 持久化键在 Phase 2 按需加列。

### 选择理由

- ACP 已是事实标准（Gemini CLI 原生、Claude Code/OpenCode/Amp/Crush/Qwen 等原生或经适配器），一个 ACP 运行时即可覆盖绝大多数目标；接口先行可让 Codex 重构与 ACP 接入解耦。
- 共享云端连接保留既有的 at-least-once、`sent_unknown`、ACK 重放语义，不复制可靠性层。

### 已知风险

- 云端回调（decision/command/stream/attachment）现按 threadId 寻址，扇出后需要 threadId→agent 归属表；归属未知时 fail-closed（路由给默认 agent 仅限单运行时阶段）。
- 多运行时共享 `media` 图片存储时 transferId/uploadId 空间需保持全局唯一（现用 UUID，天然满足）。

### 验证方式

- Phase 1：全部既有 Connector 测试（78 项）行为不变；fake-agent 契约测试台（Phase 1 第 5 项）作为后续所有运行时的合并门禁。

### 重新评估条件

- ACP 运行时接入后若发现接口形状与 ACP 生命周期冲突（如 load/resume 语义），允许增补接口方法但不得破坏 Codex 实现。

## ADR-025：会话发现按 agent 能力降级

- 状态：Phase 2 采纳（2026-08-30 实施：ACP own-sessions + session/load 重放 + node:sqlite 会话绑定持久化）
- 决策日期：2026-08-30

### 背景与选择

Codex 提供 `thread/list` 全局发现；ACP 的 `session/list` 仍是 RFD 未普及，`session/load`（重放历史）与 `session/resume`（不重放）已定稿。因此发现策略按能力降级：

1. Codex：`thread/list`（现状保持）。
2. ACP agent 且声明 `loadSession` 能力：Connector 自己启动的会话 id 持久化在 Connector SQLite，重连后 `session/load` 重建历史；服务器端列表只含 Connector 已知会话。
3. ACP agent 无 `loadSession`：仅监督 Connector 自己启动的会话（`session/new` 记录 + `session/resume`），重连后历史不可回放，显示为历史不可用。

禁止读取 agent 本地磁盘转录文件、解析其内部数据库等侵入式发现；这类路径既是隐私边界也是版本脆弱点。

### 已知风险

- 服务器端“工作站会话列表”在降级模式下只反映 Connector 已知会话，用户可能发现列表少于本机真实会话数；UI 需按 agent 展示发现能力说明。

### 验证方式

- fake-agent 契约测试覆盖 loadSession 有/无两种降级路径；Codex 路径由既有测试守护。

## ADR-026：协议 v2 增量演进（agent 字段 + sessionId 别名）

- 状态：Phase 1 采纳（2026-08-30 实施复核）
- 决策日期：2026-08-30

### 背景与选择

会话标识全链路命名 `threadId` 是 Codex 词汇泄漏；协议无 agent 判别字段。一次性破坏性改名会迫使 iOS/Web/服务器同步发版，且破坏已部署 Alpha。

### 选择结果

- `session.upsert`、`session.inventory`、`request.created`、`token.snapshot` 四类 ConnectorPayload 增加 `agent` 字段（缺省按 `codex` 解释）与 `sessionId` 别名（与 `threadId` 同值）；`session.inventory.threadIds` 同步增加并行 `sessionIds`。
- 旧字段保留读、新字段可缺省；服务器在入站规范化层统一回填，下游存储以 `agent + sessionId` 为准。
- 修复 `token.snapshot` 恒 `sequence: 0` 的缺陷：Connector 按线程维护单调递增序列，否则 `UNIQUE(workspace_id, workstation_id, connection_epoch, source_sequence)` 每连接周期只落一条快照、rollup `latest_sequence` 永不前进。

### 已知风险

- 双字段并存期间，消费端必须以“agent 缺省=codex、sessionId 缺省=threadId”的规则解释，且不得同时发送冲突值。

### 验证方式

- 协议测试断言新字段向后兼容；服务端集成测试覆盖缺省回填。

## ADR-027：审批归一化与 per-agent 能力探测

- 状态：Phase 2 采纳（2026-08-30 实施：ACP 权限选项映射 + 未知请求拒绝 + initialize 协议门禁）
- 决策日期：2026-08-30

### 背景与选择

ACP `session/request_permission` 的选项集与 Claude Code 权限请求同 Codex 的 approve/deny/answer 不同构；现版 `version-gate` 是 Codex 专属 semver 门（0.145–0.149）。

### 选择结果

- 各 agent 的审批请求统一映射到现有 `RequestContext`/`DecisionInput`：可以映射为 approve/deny 的选项照映射执行；无法安全映射的选项（例如“本次会话始终允许”）一律按 deny 处理并标注为高危 fail-closed，不静默放行。
- `version-gate` 泛化为 per-agent 能力探测：每个 AgentRuntime 在 initialize 阶段产出能力档案（协议版本、发现方式、审批选项集、用量上报、图片能力），探测失败 → 该 agent 进入禁用/降级状态，不得伪装可用。

### 验证方式

- fake-agent 契约测试包含未知权限选项场景，断言 fail-closed；Codex version-gate 既有测试保持。

## ADR-028：Claude Code 接入路径（claude-agent-acp 适配器 vs 原生 stream-json）

- 状态：草案（真实 CLI 验证清单通过后转采纳）
- 决策日期：2026-08-30

### 背景与约束

Claude Code 同时具备两条可监督路径：社区适配器 `claude-agent-acp`（把 Claude Code 包装成 ACP agent）与原生无头 `claude -p --output-format stream-json`（`--include-partial-messages` 增量、`can_use_tool` 权限控制请求、`--resume` 会话恢复）。ADR-024 规定：仅当 ACP 路径有损时才建原生适配器。

### 候选方案评估

- ACP 适配器路径：零新增运行时代码（复用 `AcpAgentRuntime` 与全部契约测试）。权限粒度：适配器把 `canUseTool` 映射为 `session/request_permission`，权限“建议”（修改后的命令、按工具永久放行）在 YuruPager 侧本就按 ADR-027 fail-closed 拒绝，不构成额外损失；增量保真：适配器转发部分文本增量，粒度可接受。损失点：多一跳进程、适配器版本耦合、用量事件大概率被丢弃。
- 原生 stream-json 路径：协议为非 JSON-RPC 的行式事件流，需要第二套连接层与状态机（Phase 3 的 Cursor 适配器已覆盖同族格式），收益主要是原生用量事件与少一跳，但审批语义（behavior allow/deny + suggestions）同样需要归一化，且字段随 CLI 版本漂移的风险更高。

### 选择结果

- 采用 ACP 适配器路径：`{kind: "acp", command: "claude-agent-acp"}` 预设直接接入。
- 原生 stream-json 适配器列为条件性后备，触发条件（任一即转原生）：真实 CLI 验证清单中审批往返不可用、文本增量丢失、或适配器停止维护。
- 用量：适配器路径下 Claude Code 用量标记为“不可用”，不构造数据；转原生时由 result 事件携带。

### 验证方式

- fake-agent 契约套件（与所有 ACP agent 共用）；真实 CLI 人工清单：`spike:acp-handshake --command claude-agent-acp`、Web 审批往返、增量渲染。

## ADR-029：Cursor 原生 stream-json 适配器

- 状态：Phase 3 采纳（2026-08-30 实施：fake-cursor-agent 契约 6/6 + 用量累计 + 净化测试）
- 决策日期：2026-08-30

### 背景与选择

Cursor CLI 无 ACP 模式，原生无头为 `--output-format stream-json` 的行式事件流（system/assistant/result 事件 + 控制请求），不是 JSON-RPC，无法复用 ACP 连接层。据此新建 `CursorAgentRuntime`：`system.init` 事件作为能力探测（fail-closed），assistant 文本映射 message 帧、tool_use 映射净化 activity（原始 input 不出工作站）、result 事件映射 turn 终态并携带用量（运行时累计为快照语义，provider 固定 `cursor`，无价格目录条目时成本显示为空）、控制请求映射审批且未知子类型 fail-closed。发现为 own-sessions，会话绑定沿用泛化后的会话绑定存储。

### 验证方式

- fake-cursor-agent 契约套件 + 净化/用量测试；真实 CLI 人工清单。

## ADR-030：ZCode 原生 app-server 适配器

- 状态：采纳（2026-08-30 spike 实测 zcode 0.16.5 回填；turn 级事件形状待真实模型 turn 人工复核）
- 决策日期：2026-08-30

### 背景与约束

ZCode 0.16.5 提供 `zcode app-server` 子命令（官方描述 "Run the ZCode Protocol stdio app server"），与 Codex 的 `codex app-server --stdio` 同构，stdio JSON-RPC。无头模式有 `--prompt/-p --print`、`--json`、`--resume <sess_…>`、`-c --continue` 等参数。关键风险：`--prompt` 默认 `--mode yolo`——在 yolo 下权限请求根本不会出现，监督形同虚设。会话持久化在 `~/.zcode/cli/rollout/model-io-sess_*.jsonl` 与 `~/.zcode/cli/db/db.sqlite`，YuruPager 不得读取这些文件作为发现手段（ADR-025）。

### 候选方案

- A：原生 app-server 适配器（本 ADR）：镜像 `src/codex/` 的客户端/domain/适配层结构，接入 AgentRuntime。
- B：经 ACP——ZCode 无 ACP 模式，不成立。

### 选择结果

- 采用 A。协议形状（initialize 能力字段、会话列表/读取/恢复、prompt 与增量事件、权限请求与应答方法、用量事件、取消）由 `spike:zcode-app-server` 实测回填本 ADR。
- 监督模式强制 `--mode build`（默认）或用户显式配置 `edit`；`yolo`/`plan` 不得作为监督模式的启动参数（fail-closed）。
- 版本门沿用 version-gate 模式：0.16.x 白名单；能力协商失败或版本不匹配 → 该 agent 降级 disabled 并在工作站状态如实呈现。
- 会话发现：`session/list` 提供**全局发现**（spike 实测 29 个会话，字段 sessionId `sess_`、mode、status、sessionKind、title），映射到 SessionUpsert；官方 title 仅按 Codex thread.name 同等规则经授权内存中转。

### spike 实测协议形状（zcode 0.16.5，`spike:zcode-app-server` 可复跑）

- 信封与分帧：ndjson 行式；客户端请求 `{id, method, params}`（**无 `jsonrpc` 键**——发送 JSON-RPC 2.0 信封会被 zod 拒绝）；响应 `{id, result|error}`；server→client 请求同为 `{id, method, params}`，用 `{id, result}` 应答；通知 `{method, params}`。
- 错误码沿用 JSON-RPC 风格：-32601 method not found、-32602 invalid params（ZodError 明细在 data）、-32004 session not active、-32031 runtime model unavailable、-32022 client request timeout。
- `session/list {}` → 全局发现。
- `session/resume {sessionId}` → server→client `session/requestRuntimePreferences`（scope: `runtime-materialization`、`user-execution`；result 需要 `nativeSearchEnhancementsEnabled: boolean`），可能追加 `interaction/requestOfficialMcpAuthHeaders`；随后返回 `{messages: [{info: {messageId, agent, model, metadata…}, …}]}` 转录重放。`session/read` 需要激活会话。
- `session/send {sessionId, content}` 驱动 turn（旧会话因模型下线报 -32031，方法面已确认）。
- `session/usage {sessionId}` → 累计用量（totalTokens/inputTokens/outputTokens/reasoningTokens/cacheCreation/ReadTokens/modelRequestCount）。
- `session/subscribe {sessionId, deliveryKind: "desktop-continuous"|"web-remote-replayable"}`；`session/setMode {sessionId, mode: plan|build|edit|yolo|auto}`；`session/stop`。
- 审批：`interaction/requestPermission`（server→client；result 形状未经真实 turn 验证——适配器按 `{decision: "allow"|"deny"}` 应答并在人工清单中复核）；提问：`interaction/requestUserInput`（YuruPager 不支持，拒绝）。
- 通知：`state.updated`、`process/mcpTelemetry`、`process/resourceSample` 等；turn 级增量方法名来自 bundle 字面量（`session/event`/`session/events`）+ 运行观察，未经真实模型 turn 确认——适配器对未知通知一律忽略（fail-closed），会话内容以 `session/messages` 轮询差分呈现。
- 无 model provider 配置（`~/.zcode/cli/config.json`，由 `zcode login` 写入）时 `session/create`/turn 失败：适配器必须把探测/激活失败如实降级 disabled。

### 已知风险

- ZCode Protocol 未承诺稳定性；任何探测失败都必须降级 disabled，不得静默。
- rollout/model-io 转录内容（原始命令、工具 IO、diff、路径）不得进入任何 relay frame、SQLite outbox 或服务端；净化断言进入契约测试。

### 验证方式

- fake-zcode-app-server 契约套件（握手、发现、prompt、增量、审批往返、崩溃重连）+ 净化/用量测试；真实 CLI spike 人工清单。

## ADR-032：编排归属与数据边界

- 状态：草案（Phase 1 落地后定稿）
- 决策日期：2026-08-30

### 背景与约束

规划工作流把多个 agent 接力任务编排起来。编排逻辑放哪里决定信任边界与崩溃语义：Server 持久化但不接触 agent 会话内容；Connector 是唯一与 agent 进程交互的组件。

### 候选方案

- A（采纳）：Server 持久化「定义 + Run 状态机元数据」并经既有 outbox/inbox 下发；Connector 内置编排引擎（src/workflow/）执行，用 SQLite journal 做崩溃恢复（沿用决策投递的 prepare/beginDispatch/ACK 模式）。节点交接文本与 agent 产出按会话内容处理：只走 ephemeral WSS 与工作站内存，永不进 PostgreSQL、审计文本、outbox 载荷或 Service Worker 缓存。
- B：Server 直接编排（经 Connector 转发每条 prompt）——Server 需要感知会话内容与 agent 协议细节，破坏内容边界；Connector 断线时 Server 驱动的 turn 状态难以对账。
- C：Web 端编排——页面关闭即中断，不可接受。

### 选择结果

- 采用 A。Run 引用定义的 JSONB 快照：编辑定义不影响进行中的 Run。
- 可持久化白名单：定义、Run/节点状态机元数据、用量聚合。其余（交接文本、最终答复、校验结论正文）只存在于 Connector 内存与 ephemeral 通道；Run 事件仅携带状态与有界的非内容元数据（节点 id、状态、原因码）。
- 崩溃恢复：Connector 重启后从 journal 恢复 Run 归属，当前执行中的节点标 interrupted 并按节点重试策略重派；策略耗尽 → 节点 failed → Run 失败策略。
- 工作站离线时 Run 阻塞（保持 running 但上报 blocked_offline 原因码），不做服务端代执行。

### 验证方式

- Connector 编排引擎 node:test 全场景（状态机、条件、模板、重试、崩溃恢复、离线阻塞）；服务端迁移与快照测试；安全断言（交接文本不出现在任何持久化载荷）。

## ADR-033：节点完成条件范式

- 状态：草案（Phase 1 落地后定稿）
- 决策日期：2026-08-30

### 背景与选择

节点“完成”必须可验证才允许交接（fail-closed）。范式：主条件三选一，恒定护栏叠加。

- agent_confirm：本节点 agent 完成任务后，编排引擎以固定自检 prompt（模板内置，用户不可改写防注入）在工作站本机对该 agent 发起校验轮；agent 须输出 PASS/FAIL+理由。解析失败按 FAIL 处理。
- criteria_check：按用户填写的 criteria 文本发起校验轮，同样要求 PASS/FAIL+理由。
- manual_gate：人工审批门，复用现有 request.created→DecisionInput 审批链路（新增 kind workflow_gate），沿用 first valid decision wins；超时/拒绝 → 节点失败。
- 恒定护栏：turn_budget（校验+重试消耗的最大轮数）与 timeout（节点墙钟上限），任一耗尽 → 校验未确认 → FAIL。

### 选择结果

- 校验轮在 Connector 引擎内通过 AgentRuntime 语义发起（与节点任务同通道）；校验轮文本与结论是会话内容，不入库。
- FAIL → 节点重试策略（maxRetries + 指数退避）→ 重试耗尽 → 节点 failed → Run 失败策略（stop：Run failed；manual_intervention：Run 阻塞在 waiting_approval 等待人工 gate）。
- 未确认绝不交接：交接渲染只在条件 CONFIRMED 后发生。

## ADR-034：会话选项扩展（model / reasoningEffort）

- 状态：草案（Phase 1 落地后定稿）
- 决策日期：2026-08-30

### 背景与选择

节点需要指定执行者（agent kind + model + reasoningEffort）。归一化枚举 "minimal"|"low"|"medium"|"high" 由各 runtime 映射到原生参数；能力探测不到的目录项 UI 显示「默认」且运行时告警，不静默降级。

### 选择结果

- `AgentCapabilities` 增加 `models: Array<{ id, displayName, reasoningEfforts[] }>`，由各 runtime 能力探测填充。
- `AgentRuntime` 增加 `startSession(options: { initialPrompt, cwd, model?, reasoningEffort?, attachments? }): Promise<{ sessionId }>` 与 `handleSessionCommand` 扩展 `options?: { model?, reasoningEffort? }`——引擎只依赖该语义。
- 原生映射表：Codex turn 走 model/model_reasoning_effort（model/list 探测）；ZCode 走 session/setModel 与思考配置（探测缺省为默认并告警）；ACP 家族映射各家 thinking/effort 参数（探测缺省告警）；Cursor stream-json model 字段。
- 节点指定的 model/effort 不在目录内 → 运行时报错拒绝（不降级到默认）。

## ADR-035：Web 画布技术选型

- 状态：草案（Phase 3 落地后定稿）
- 决策日期：2026-08-30

### 候选方案

- React Flow（@xyflow/react）：成熟节点画布，受控布局、连线校验、键盘可达；代价是新增依赖与 bundle 体积（按需导入 ~几十 KB gzip）。
- 自研 SVG 画布：零依赖，但拖拽/连线/缩放/可达性都要自维护，Phase 3 工期不可控。

### 选择结果

- 采用 React Flow。v1 编辑器校验为线性链（数据模型仍按 DAG 设计）；移动 PWA v1 不做画布编辑，只做运行监控与 gate 审批。

## ADR-036：工作流权限与审计

- 状态：草案（Phase 2 落地后定稿）
- 决策日期：2026-08-30

### 选择结果

- 定义 CRUD：workspace 内 member 及以上（编辑需可管理该工作站的授权语义——v1 简化为 member+ 可编辑、owner/admin 可删除）。
- 运行与取消：工作站新增 `can_orchestrate` 授权（owner/admin 在 Edit access 面板授予；迁移只加列，默认 false）。
- manual_gate：新增 request kind `workflow_gate`，复用审批与高危确认通道（含超时与 first-valid-decision-wins 语义；默认拒绝）。
- 审计：create/update/run/cancel/gate 全部记录（审计文本只含元数据：定义 id、Run id、节点 id、操作者、原因码——不含交接文本与 agent 产出）。

## 4. 实施顺序

1. 固化 YuruPager Domain Event、Approval Request、Delivery Journal 和 Token Usage Schema。
2. 实现 ADR-004 的本地 SQLite Outbox/Inbox 和最小 WSS 中继。
3. 实现 ADR-008 的设备配对与最小用户认证。
4. 实现 ADR-005 的 PostgreSQL Schema、RLS 和授权测试。
5. 构建 ADR-003 的 PWA 审批闭环并进行真实设备推送测试。
6. 实现 ADR-019 的受限图片分块、Connector 私有附件和端到端隐私扫描。
7. 实现 ADR-020 的独立预览 origin、本机显式端口授权和易失 HTTP/WebSocket 隧道。
8. 将协议契约、重复投递和崩溃故障注入纳入 CI 与发布门禁。

## 5. 必须优先回答的开放问题

- app-server 缺少稳定版本协商时，最低版本门禁和兼容窗口如何发布给用户。
- 模型 reroute 时 Token 如何按模型可靠分段。
- `sent_unknown` 的工作站人工确认、告警和审计交互如何设计。
- PWA 在目标 iOS 和 Android 版本上的通知延迟、后台存活和 WebAuthn 体验。
- 首发区域、身份提供商、推送基础设施和数据驻留要求。

## 6. 决策维护规则

- ADR 内容发生实质变化时更新文档版本并保留变更记录。
- 被替代的决策不删除，标记为“已替代”并链接新决策。
- Spike 结果必须附带可复现命令、测试版本、失败案例和结论。
- PRD 与 ADR 冲突时不得静默选择其一，应在两个文档中同步修订并记录原因。
- 任何降低默认拒绝、租户隔离或审计完整性的变更必须经过安全评审。

## 7. 版本记录

### v1.8（2026-08-30）

- 新增 ADR-028/029 草案：Claude Code 采用 claude-agent-acp 适配器路径（原生 stream-json 为条件性后备）、Cursor 原生 stream-json 适配器。

### v1.7（2026-08-30）

- 新增 ADR-024～027 草案：多 Agent 运行时、按能力降级的会话发现、协议 v2 增量演进、审批归一化与 per-agent 能力探测。
- Phase 1 落地后 ADR-024/026 转为采纳；token.snapshot 固定 sequence 0 的缺陷已随 v2 修复。
- Phase 2 落地 AcpAgentRuntime 后 ADR-025/027 转为采纳：session/load 历史重建与 own-sessions 降级、权限选项 fail-closed 映射、原始工具 IO 不出工作站的净化测试进入合并门禁。
- Phase 3 新增 ADR-028（Claude Code 走 claude-agent-acp 适配器路径）与 ADR-029（Cursor 原生 stream-json）；预设表让 gemini/claude-code/opencode/amp/crush/qwen-code 通过配置接入；README 增补 Supported agents 矩阵。ADR-028 的原生后备触发条件待真实 CLI 验证清单确认。

- 新增 ADR-024～027 草案：多 Agent 运行时、按能力降级的会话发现、协议 v2 增量演进、审批归一化与 per-agent 能力探测。

### v1.6（2026-08-30）

- 新增 ADR-022：工程质量门禁采用 ESLint（flat config）+ typescript-eslint，warn 级接入并修完全部 error。
- 新增 ADR-023：数据库 Schema 采用有序幂等的版本化迁移，基线登记为 0001，旧库补登记不重跑。
- 根 `npm run lint` 纳入 ESLint，与各 workspace 的 `tsc --noEmit` 并行构成完整门禁。

### v1.5（2026-08-16）

- 扩展 ADR-014：主动消息按 `threadId` 串行，命令仅在 `delivered`、`sent_unknown` 或确定 `failed` 后 ACK；普通完成必须等待匹配终态和临时 writer 完整释放后才启动下一条。
- 明确 `sent_unknown` 阻塞持久化并在 Connector 重启后恢复；超时关闭 ambiguous writer 不得自动放行同一 thread 的后续命令。

### v1.4（2026-08-11）

- 增加 PWA Web Push 的 VAPID、账户级订阅、按工作站权限派发与最小披露载荷决策。
- 明确推送不是审批事实来源，重复或丢失统一由前台 REST 快照校准；失效端点清理且暂时错误不静默退订。

### v1.3（2026-08-11）

- 增加端到端图片 ADR，限定 PNG/JPEG/WebP、4 张、单张 5 MiB 和总计 12 MiB，并把图片字节限制在授权 WSS 内存中转。
- 明确 Connector `0600` 私有持久附件、图片独立发送、在线门禁、`turn/start` 前显式重试与越界后 `sent_unknown` 禁止自动重发。

### v1.2（2026-08-10）

- 为临时会话增加 Connector 侧脱敏过程活动摘要，明确不传输隐藏推理、计划正文或工具原始载荷。
- 为 `thread/read` 加载窗口定义二次快照校准，并对其他 Codex app-server 进程的会话增加订阅期间轮询，修复增量只在最终校准时出现的问题。

### v1.1（2026-08-09）

- 允许 Connector 读取经过清洗和长度限制的官方 `thread.name`，只通过授权 WSS 与当前进程内存补全会话名。
- 明确 `preview`、正文衍生标题及标题持久化仍被禁止，并记录断线编号占位、RLS 映射和客户端快照替换行为。

### v1.0（2026-08-09）

- 增加工作站全局分页发现 Codex 项目决策，明确 `projectKey`、路径规范化、轮询与游标 fail-closed 行为。
- 明确项目索引不会扩大服务端对源代码、工具输出或完整对话的持久化权限。

### v0.9（2026-08-09）

- 增加原生 SwiftUI iOS 客户端决策，明确协议复用、Keychain、前台快照恢复和不持久化 Codex 正文边界。
- 将 APNs、Passkey/Secure Enclave、签名与 App Store 分发保留为需要 Apple 凭据的下一阶段能力。

### v0.8（2026-08-08）

- 增加短期单次配对、Web 明确确认、独立工作站凭据、动态 WSS 身份和服务端托管安装包决策。
- 将固定 Connector Token 限定为迁移兼容路径，并记录后续升级设备签名挑战的边界。

### v0.7（2026-08-06）

- 增加主动消息与临时 Codex 会话时间线决策。
- 明确对话只在工作站持久化，服务端仅做授权后的内存中转，离线时不提供旧副本。

### v0.6（2026-08-04）

- 记录第一阶段 monorepo、Fastify、SQL-first `pg`、认证和部署工程基线。
- 明确本地开发身份提供器服从 OIDC BFF 会话边界，不作为生产认证方案。

### v0.5（2026-08-04）

- 完成 listener/TUI 重启、真实 fileChange/permissions、取消/超时和两版本契约验证。
- 完成响应后崩溃故障注入，确认 `sent_unknown` 必须阻止重发且 thread 历史不能证明命令副作用。
- 验证 Token 累计跨 turn、手动 compact 和 app-server 重启连续，resume 会重放累计快照。
- 将 ADR-001、ADR-006 和 ADR-007 更新为 MVP 采纳，正式进入纵向切片实施。

### v0.4（2026-08-03）

- 验证当前 app-server 对相反决定采用首响应获胜，迟到响应不重复执行。
- 明确该行为只作为第二道保护，YuruPager 仍由稳定请求 ID 和持久化门闩仲裁。
- 增加 `resolved_externally`、`decision_unknown` 对账分支，避免伪造本地 TUI 的获胜决定。

### v0.3（2026-08-03）

- 验证真实交互式 TUI 的 `codex --remote` 接入和远程审批闭环。
- 将 ADR-001 更新为主路径 Spike 通过，同时保留兼容性和故障恢复门槛。
- 记录 bundled CLI 的 remote TUI thread 不应按 `sourceKinds: ["cli"]` 硬编码发现。

### v0.2（2026-08-03）

- 记录共享 WebSocket listener、pending thread resume 和重复审批投递的 Spike 结果。
- 明确普通 TUI 启动接入与多客户端冲突响应仍是开放问题。
- 将本地多客户端决定统一纳入 ADR-006 的稳定请求 ID 和单一门闩边界。

### v0.1（2026-08-03）

- 建立 ADR-001 至 ADR-008 的 MVP 技术决策基线。
- 明确 Codex 实验性协议、消息可靠性、租户隔离和 Exactly-once 边界。
- 明确 Token 用量与估算成本、设备身份和工作空间授权方案。
