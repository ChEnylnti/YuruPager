# Codex Connector 技术 Spike 报告

- 文档版本：v0.7
- 状态：正式 MVP 开发前技术门槛通过；standalone CLI Remote Control 契约和本地只读状态探测通过，原生 Codex Desktop 真机配对端到端验证待执行
- 执行日期：2026-08-16
- 关联决策：[技术选型与架构决策](./technology-decisions.md)

## 1. 目标

验证 ADR-001、ADR-006 和 ADR-007 中风险最高的假设：

- Connector 能否通过 Codex `app-server` 完成双向 JSON-RPC 握手。
- 是否能捕获真实命令审批，并将批准或拒绝返回 Codex。
- 是否能接收并回答结构化 `request_user_input`。
- 是否能接收完成、错误和 Token 用量事件。
- 重复决定、Connector 崩溃和事件重放是否会破坏本地幂等状态。
- 适配器能否只输出 YuruPager 需要的最小字段。
- 第二个本地 Connector 客户端能否加入正在等待审批的 thread，并接收同一请求和后续事件。
- 真实交互式 Codex TUI 能否通过 `--remote` 使用 Connector 管理的本地 app-server。
- 多个客户端提交相反或迟到决定时，哪个响应生效，是否会重复执行。
- listener 重启后 pending 审批、真实 TUI 和 Token 状态如何恢复。
- 文件、permissions、取消和超时是否能保持 fail-closed。
- 两个 Codex CLI 版本是否满足同一最小协议契约。
- Connector 在响应写入后、业务回执落盘前崩溃时能否阻止批准重发。
- Token `total` 在多个 turn、手动 compact 和 app-server 重启后是否连续。
- 官方 `remote-control` 是否具备配对、设备列举/撤销与连接状态的最小协议，并能在不启用远程控制的情况下读取本地状态。

本阶段不建设云端服务、PWA、用户认证或真实 WebSocket 中继。

## 2. 测试环境

| 项目 | 版本 |
|---|---|
| 操作系统 | macOS 26.3.1 arm64 |
| Codex CLI | `0.147.0-alpha.1.2`（2026-08-05 复验） |
| Remote Control 兼容性 CLI | `0.147.0`（2026-08-16 本机复验） |
| Codex Desktop 内嵌 CLI | `0.148.0-alpha.9`（2026-08-16 静态路径复核） |
| 契约基线 CLI | `0.145.0` |
| Node.js | `26.4.0` |
| npm | `11.17.0` |
| TypeScript | `5.9.x` |

协议依据来自以下本机命令生成的实验性 Schema：

```bash
codex app-server generate-json-schema --experimental --out <temporary-directory>
```

官方 Codex 手册抓取在测试期间返回 HTTP 403；OpenAI Docs MCP 已在本机配置，但当前任务未暴露可调用工具。因此本报告只把本机实际握手、生成 Schema 和端到端运行结果作为证据，不推断官方兼容承诺。

## 3. 实现范围

### 3.1 JSON-RPC 客户端

- 启动本地 `codex app-server --stdio`。
- 完成 `initialize` 和 `initialized` 握手。
- 支持客户端请求、服务端请求、通知、超时和子进程退出。
- 子进程异常退出时拒绝所有尚未完成的请求。
- 支持连接本机 `ws://127.0.0.1:<ephemeral-port>` listener；每个 JSON-RPC 消息占一个文本帧。
- 不向公网暴露 Codex app-server。

### 3.2 Codex Adapter

已适配以下服务端请求：

- `item/commandExecution/requestApproval`
- `item/fileChange/requestApproval`
- `item/permissions/requestApproval`
- `item/tool/requestUserInput`

已适配以下通知：

- `thread/tokenUsage/updated`
- `serverRequest/resolved`
- `turn/completed`
- `error`

Adapter 通过 thread、turn、item、approval 和 method 生成稳定请求 ID，不使用可能在重连后变化的 JSON-RPC ID。

### 3.3 隐私最小化

- 命令审批只选择 command、cwd、reason 和允许的决定类型。
- 文件审批不上传 Diff 或文件内容。
- 权限申请只提取网络开关和最多 50 个文件系统范围。
- 错误通知只保留结构化错误代码和是否重试，不透传原始错误正文。
- Token 记录只包含数值和 thread/turn 标识。

### 3.4 幂等与恢复

- 内存门闩验证同一请求只有一个最终决定。
- SQLite Ledger 使用 WAL、`synchronous=FULL` 和 `BEGIN IMMEDIATE`。
- `request_id` 为主键，`idempotency_key` 为唯一键。
- 相同 Key 和相同决定返回原结果；竞争决定返回冲突。
- 已提交决定在未正常关闭的子进程退出后仍可恢复。

### 3.5 Token 累计

- 以 `thread/tokenUsage/updated.total` 作为累计快照，而不是逐事件求和。
- 使用 event ID 和单调序号去重并拒绝乱序旧快照。
- 计数回退时标记为 `incomplete`，不产生负增量。
- `turn/completed` 后可将对应快照校准为 `final`。

### 3.6 共享会话路由

- 一个 app-server 使用随机 loopback WebSocket 端口，两个客户端分别模拟 TUI 和 Connector。
- TUI 创建持久化 thread、启动回合，并在命令审批回调中保持暂停。
- Connector 在审批 pending 时调用 `thread/resume` 加入同一 thread。
- 两个客户端都收到同一个审批请求；Connector 随后也收到 Token 和回合完成通知。
- 两端统一返回拒绝，临时测试命令执行 0 次；测试结束后删除 thread 和临时目录。
- `thread/start` 后、首个回合物化前立即 resume 会返回 `no rollout found`；Connector 应在 rollout 可恢复后加入，或直接托管 thread 生命周期。

### 3.7 真实 TUI 接入

- Connector 启动 loopback WebSocket listener，真实 `codex --remote <url>` TUI 通过 macOS 伪终端连接。
- TUI 在独立临时目录中发起真实命令审批；Connector 通过精确 `cwd` 查询并恢复 thread。
- Connector 返回拒绝后，TUI 自动解除原生审批等待并完成回合。
- bundled ChatGPT.app CLI 创建的 remote TUI thread 在本机标记为 `source: vscode`，发现逻辑不能硬编码为 `sourceKinds: ["cli"]`。
- 测试结束后终止伪终端，删除持久化测试 thread 和临时目录；清理进程具有 TERM/SIGKILL 有限退让。

### 3.8 冲突与迟到决定

- 发起客户端先收到审批但保持 pending，Connector 恢复 thread 后先返回决定。
- 收到 `serverRequest/resolved` 后，再释放发起客户端的相反决定，确保它是迟到响应。
- “先拒绝、后批准”执行 0 次；“先批准、后拒绝”执行恰好 1 次。
- 两个连接观察到同一个稳定请求 ID，每个场景只收到一个 resolved 通知。
- 当前版本表现为首个响应获胜，迟到响应被忽略，不会覆盖决定或重复执行。
- `serverRequest/resolved` 只提供 thread 和连接级 RPC request ID，不提供获胜决定或操作者。

### 3.9 listener 与真实 TUI 重启恢复

- 在审批 pending 时终止 app-server，再启动同地址的新 listener。
- `thread/resume` 成功，但原 turn 被标记为 `interrupted`，pending 审批不重放。
- 真实 `codex resume --remote <url> <threadId>` 可以重新打开该 thread。
- 原命令执行 0 次；产品必须取消旧请求并要求用户发起新 turn，不能展示为仍在等待审批。
- 仅恢复一个尚未产生 Token 事件的中断回合时，不会重放 Token 快照。

### 3.10 审批边界

- 真实 `item/fileChange/requestApproval` 拒绝后目标文件不存在。
- 启用 `request_permissions_tool` 后，`:read-only` profile 会产生包含精确写路径的 permissions 请求；返回空权限后命令执行 0 次。
- pending 命令审批期间发送 `turn/interrupt`，turn 以 `interrupted` 完成，命令执行 0 次。
- app-server 不承担 YuruPager 的五分钟业务超时；Connector 定时器到期后显式返回拒绝。本次用 1 秒加速验证，命令执行 0 次。

### 3.11 跨版本契约

- `spike:protocol-contract` 使用临时 `npx` 检查固定基线 `0.145.0` 和当前 `0.147.0-alpha.1.2`；`0.146.0-alpha.9.2` 保留为此前已验证版本。
- 两个版本都包含 thread/turn 生命周期、四类交互请求、完成/错误/Token/resolved 通知及必需字段。
- 契约通过只代表生成 Schema 满足 YuruPager 最小能力，不代表实验协议获得稳定性承诺。

### 3.12 崩溃模糊窗口

- Connector 子进程先持久化 `approve` 和 `sent_unknown`，把 JSON-RPC 响应提交到 WebSocket 后以退出码 86 崩溃，未写 delivery receipt。
- app-server 接收批准并执行临时命令恰好 1 次；恢复后的 Connector 不会再次收到审批。
- SQLite delivery journal 跨崩溃保留 `sent_unknown`，第二次 dispatch 被 `AmbiguousDeliveryError` 阻止。
- `thread/read` 的恢复历史不包含 command execution item，只有 turn completed 不能证明副作用是否发生。
- 测试标记可证明本次执行 1 次，但生产系统没有该 oracle，因此状态必须保持 ambiguous/sent_unknown 并要求人工确认。

### 3.13 Token 生命周期

- 四个真实 turn 的 `total.totalTokens` 依次为 15,542、31,100、57,765 和 73,489，仅作为本次样本。
- 手动 compact 产生独立用量，并把累计总量推进到 42,060；后续 turn 继续累计。
- app-server 重启并 `thread/resume` 后重放 1 个累计快照，下一 turn 从原总量继续增加，没有计数回退。
- `last` 表示最近一次上游操作，`total` 表示 thread 生命周期累计；聚合必须替换累计快照而不是求和。

### 3.14 writer 释放边界

- 在 `0.148.0-alpha.9` 上用两个独立 stdio app-server 恢复同一个既有 idle thread，第二个实例稳定收到 `already has an active writer`。
- 持有者调用 `thread/unsubscribe` 返回 `unsubscribed`，但第二个实例仍然无法接管，证明该方法只取消事件订阅，不释放 writer。
- 停止持有者 app-server 进程后，第二个实例立即 `thread/resume` 成功；writer 的可靠释放边界是进程退出。
- Connector 因此把常驻 app-server 限定为只读发现/流同步，并为每条手机主动消息创建独立子进程；最终完成、失败或中断后关闭该子进程，不影响其他并发 thread。

### 3.15 官方 Remote Control 兼容性

- 当前 standalone CLI 将 `remote-control` 标记为 experimental，并提供 `start`、`stop`、`pair` 三个命令。
- 通过 `app-server generate-json-schema --experimental` 检查到 `remoteControl/enable`、`disable`、`status/read`、`pairing/start`、`pairing/status`、`client/list` 和 `client/revoke`，以及 `remoteControl/status/changed` 通知。
- 配对结果包含短期 `pairingCode`、`environmentId` 和 `expiresAt`；客户端记录包含设备类型、显示名称、平台和最后在线时间；连接状态为 `disabled`、`connecting`、`connected` 或 `errored`。
- `npm run spike:remote-control-status` 启动独立的本地 app-server，仅调用 `remoteControl/status/read`，本次返回 `disabled`。该探针不调用 enable、pair 或 start，不创建配对码，不启动 turn，也不输出 `installationId` 或 server name。
- 静态检查 Codex Desktop 的本地应用包显示，它在自身 app-server 重启后调用 `remoteControl/enable`，并在 Settings -> Connections 中提供 “Control this Mac from your phone or other device”、设备列举和撤销入口。这是第一方 Desktop 路径，不等同于 `codex remote-control start` 启动的 managed daemon。
- 因此本节的 CLI 契约仅证明设备与状态控制面的形状；它不证明第三方应用可以复用官方中继，也不证明已打开的 Codex Desktop 会镜像外部 client 的所有事件。

## 4. 验证结果

| 验证项 | 结果 | 证据 |
|---|---|---|
| app-server 握手 | 通过 | `initialize`、`initialized`、`model/list` 成功 |
| 命令审批拒绝 | 通过 | 捕获 1 个 command approval，隔离命令执行 0 次 |
| 命令审批批准 | 通过 | 捕获 1 个 command approval，隔离命令执行恰好 1 次 |
| 重复幂等提交 | 通过 | 相同请求和 Key 返回 `replayed=true`，未产生第二次命令执行 |
| 结构化提问 | 通过 | 捕获 1 个 `request_user_input` 并返回 `Staging` |
| 回合完成事件 | 通过 | 审批和提问回合均收到 `turn/completed` |
| Token 用量事件 | 通过 | 收到输入、缓存输入、输出、推理输出和总 Token |
| JSON-RPC 子进程崩溃 | 通过 | 未完成请求立即失败，不永久等待 |
| 决定跨重启恢复 | 通过 | SQLite 已提交决定在异常退出后仍存在 |
| Token 重复和乱序 | 通过 | 重复事件去重，旧序号忽略，计数回退标记不完整 |
| 敏感字段最小化 | 通过 | 测试中的 Diff、环境变量和原始错误正文未进入 Domain Event |
| loopback WebSocket 传输 | 通过 | 双客户端完成握手、请求、回调和通知 |
| pending thread 恢复 | 通过 | Connector 在 TUI 等待审批时 `thread/resume` 成功 |
| 共享审批路由 | 通过 | TUI 和 Connector 均收到同一审批，测试命令执行 0 次 |
| 恢复后的事件流 | 通过 | Connector 收到 Token 更新和 `turn/completed` |
| 真实 TUI `--remote` | 通过 | TUI 进入原生审批等待，Connector 拒绝后回合完成 |
| 真实 TUI 清理 | 通过 | thread、临时目录和测试 listener 均被删除 |
| 先拒绝后迟到批准 | 通过 | 命令执行 0 次，迟到批准未覆盖拒绝 |
| 先批准后迟到拒绝 | 通过 | 命令执行恰好 1 次，迟到拒绝未重复或回滚执行 |
| resolved 最小化 | 通过 | Adapter 不伪造决定，也不透传未知响应字段 |
| listener 重启 | 通过 | 原 turn 变为 `interrupted`，审批不重放，命令执行 0 次 |
| TUI 重启恢复 | 通过 | `codex resume --remote` 可打开中断 thread |
| 文件变更拒绝 | 通过 | 收到真实 fileChange approval，目标文件不存在 |
| permissions 拒绝 | 通过 | 收到精确写路径，空权限响应阻止执行 |
| 取消与超时 | 通过 | interrupt 和 Connector 超时均未执行命令 |
| 跨版本契约 | 通过 | `0.145.0`、`0.146.0-alpha.9.2` 与 `0.147.0-alpha.1.2` 满足最小契约 |
| 响应后崩溃 | 通过 | `sent_unknown` 持久化且自动重发被阻止 |
| 多 turn/compact/restart Token | 通过 | 累计值单调，resume 重放快照，无计数重置 |
| writer 释放 | 通过 | `thread/unsubscribe` 不释放；持有者进程退出后另一实例立即接管 |
| Standalone CLI Remote Control 契约 | 通过 | `0.147.0` 含配对、设备撤销、状态读写和状态通知的最小 Schema 契约 |
| Standalone CLI Remote Control 本地状态 | 通过 | 独立 app-server 的只读 `status/read` 返回 `disabled`，未启用或配对设备 |
| Codex Desktop 第一方路径 | 静态确认 | Desktop 自身调用 `remoteControl/enable` 并提供 Connections UI；尚未真机配对 |

当前根目录自动化测试共 76 项，全部通过；其中 Remote Control 契约夹具覆盖 5 项失败关闭与隐私最小化场景。

真实批准回合的一次样本：

```json
{
  "approvalCount": 1,
  "executionCount": 1,
  "idempotentReplayObserved": true,
  "tokenQuality": "final"
}
```

真实提问回合的一次样本：

```json
{
  "questionCount": 1,
  "suppliedAnswer": "Staging",
  "tokenQuality": "final"
}
```

Token 数值会随模型、上下文和运行时间变化，因此不作为固定测试快照。

共享会话一次样本：

```json
{
  "resumeSucceeded": true,
  "requestRecipients": ["tui", "connector"],
  "connectorSawApproval": true,
  "connectorNotifications": {
    "thread/tokenUsage/updated": 2,
    "turn/completed": 1
  },
  "executionCount": 0
}
```

真实 TUI 一次样本：

```json
{
  "passed": true,
  "realTuiConnected": true,
  "approvalRequestIds": ["codex_<stable-hash>"],
  "connectorNotifications": {
    "thread/tokenUsage/updated": 2,
    "turn/completed": 1
  },
  "executionCount": 0
}
```

冲突决定一次样本：

```json
{
  "passed": true,
  "arbitration": "first-response-wins",
  "scenarios": [
    {
      "firstDecision": "deny",
      "lateDecision": "approve",
      "executionCount": 0,
      "connectorResolvedNotifications": 1,
      "totalTokens": 33711,
      "tokenQuality": "final"
    },
    {
      "firstDecision": "approve",
      "lateDecision": "deny",
      "executionCount": 1,
      "connectorResolvedNotifications": 1,
      "totalTokens": 33689,
      "tokenQuality": "final"
    }
  ]
}
```

Token 数值是本次环境样本，不代表计费账单或稳定基线。

## 5. 结论

### 5.1 已确认

- `app-server` 可以作为 YuruPager Connector 的主要双向协议候选。
- 命令审批能够真实暂停并等待 Connector 返回决定。
- 批准、拒绝、问题回答、完成事件和 Token 用量可以形成一个闭环。
- Adapter 可以把实验性 Codex 协议隔离在本地，并输出稳定、最小化的领域事件。
- 用户决定可以在服务端或 Connector 边界做到单一生效和持久化恢复。
- Token 累计快照方案可行，不能把每个 `total` 事件直接相加。
- 共享 app-server listener 上，Connector 可以在审批 pending 时恢复 thread，并收到审批、Token 和完成事件。
- app-server 会把 pending 审批投递给多个已加入客户端，因此重复投递是必须处理的正常路径，而不是异常边界。
- 当前 CLI 的交互式 TUI 支持 `--remote`，可连接 Connector 管理的 listener；远程拒绝能解除 TUI 原生审批等待。
- 当前 app-server 版本对冲突响应采用首响应获胜，迟到相反决定不会覆盖结果或产生第二次执行。
- listener 重启不会恢复 pending 审批；它把原 turn 变为 `interrupted`，但真实 TUI 可以通过 `resume --remote` 打开 thread。
- 文件、permissions、取消和 Connector 超时均可保持默认拒绝，未产生测试副作用。
- `0.145.0` 与当前 CLI 满足相同的 MVP 最小 Schema 契约。
- 响应后崩溃会留下无法由恢复历史消除的 `sent_unknown`；持久化 journal 能阻止自动重发批准。
- Token `total` 跨普通 turn、手动 compact 和 app-server 重启连续增长，resume 会重放累计快照。
- thread writer 与 app-server 进程绑定，不能依赖 `thread/unsubscribe`；主动消息必须使用独立短生命周期子进程。
- 官方 `remote-control` 具备专用设备配对、客户端撤销和连接状态协议；Codex Desktop 的第一方路径是双端协同的直接参考实现，但 standalone CLI daemon 不能被当作 Desktop 会话的附着接口。

### 5.2 尚未确认

- bundled ChatGPT.app 中的 Codex CLI 无法启动 managed daemon；它要求 standalone Codex 安装。本阶段未在没有用户授权的情况下安装全局 CLI。
- 安装器、wrapper、LaunchAgent 和面向用户的断线提示尚未实现；原生自动恢复 pending 审批已确认不可依赖。
- 模型 reroute 时 Token 的分段归属仍未真实验证。
- 跨未来 CLI 版本的兼容仍需在 CI 中持续运行，两个版本通过不是永久兼容承诺。
- 错误通知已通过夹具测试，但尚未在真实模型失败中验证所有错误类型。
- PWA 推送可靠性、真实设备 WebAuthn 和完整云端断网恢复属于 MVP 实现阶段验证项。
- 真实手机与 Codex Desktop 同时连接时，手机发消息是否在已打开的原生 Desktop 会话即时显示、Desktop 发送后手机是否即时显示、审批如何仲裁，以及断线和撤销后的恢复行为，尚未在本机完成端到端验证。验收必须从 Desktop 的 Settings -> Connections -> Control this Mac 启动，不能使用 standalone CLI daemon 代替。

### 5.3 Exactly-once 边界

本阶段不能证明端到端 Exactly-once，也不应对外承诺：

```text
已证明：一个 request_id 只接受一个最终决定
已证明：相同决定跨进程重启可以识别为重放
已证明：正常批准链路中的测试命令执行恰好一次
已证明：同一 pending 审批会投递给多个已加入的 app-server 客户端
已证明：当前版本只采用首个响应，迟到的相反决定不会改变副作用次数
已证明：响应写入后崩溃可持久化为 sent_unknown，并阻止自动重发批准
已观察：该故障注入样本中命令执行一次
未证明：恢复端可仅凭 app-server 历史判断命令是否已经执行
```

多客户端投递必须先归一化为同一个稳定 `request_id`，并由服务端或本地共享 Ledger 选出唯一最终决定。不能把 app-server 的首响应行为当成 YuruPager 的审计来源，因为 resolved 通知不包含获胜决定和操作者。如果 resolved 先于 Connector 自己的决定出现，Connector 必须取消待发送决定，标记 `resolved_externally` 和 `decision_unknown`，再对账 item/turn，禁止重试。高风险请求一旦进入无法证明结果的模糊窗口，必须拒绝自动重试，并要求人工回到工作站确认。

## 6. Go/No-Go 判断

结论为 **Go**：可以开始受约束的 MVP 正式开发。此前四项技术门槛已经完成，不再以继续 Spike 作为启动条件。

Go 附带以下硬约束：

1. listener 重启后把旧 pending 请求取消或标为 unknown，禁止伪装为仍可审批。
2. 高风险批准进入 `sent_unknown` 后禁止自动重发，必须告警并要求工作站人工确认。
3. Connector 启动时执行能力探测；不满足最小契约的 CLI 明确降级或拒绝启动审批功能。
4. Token 使用累计快照替换和去重；ChatGPT 订阅会话不得展示伪造的按量账单成本。
5. 不把 experimental `remote-control` 的未公开中继协议暴露为 YuruPager API；真实配对验证通过并得到兼容性确认前，只能作为可选适配器候选。不得用 standalone CLI daemon 伪装或替代当前 Codex Desktop 的会话控制。

## 7. 复现命令

```bash
npm install
npm test
npm run spike:handshake
npm run spike:approval
YURUPAGER_SPIKE_DECISION=approve npm run spike:approval
npm run spike:question
npm run spike:shared-session
npm run spike:remote-tui
npm run spike:decision-race
npm run spike:listener-restart
npm run spike:approval-boundaries
npm run spike:protocol-contract
npm run spike:remote-control-contract
npm run spike:remote-control-status
npm run spike:crash-window
npm run spike:token-lifecycle
npm run spike:writer-release -- --thread <idle-thread-id>
```

除 handshake、protocol-contract、remote-control-contract、remote-control-status 和 writer-release 外，其余命令可能启动真实 Codex 回合并消耗已登录账户的 Token。Remote Control 两项探针只读取 standalone CLI help、生成 Schema 或调用独立本地 app-server 的只读 `status/read`，不启用远程控制或创建配对码，也不检查 Desktop 自身的远控进程。writer-release 只应传入明确处于 idle/notLoaded 的既有测试 thread；它不创建 turn 或修改对话内容。remote-TUI 和 listener-restart 必须从 macOS 交互式终端运行。涉及命令的脚本只操作独立临时目录，并删除它们创建的持久化测试 thread。

## 8. 下一阶段建议

下一阶段进入正式 MVP 纵向切片，建议按以下顺序：

1. 固化版本化 Domain Event、审批状态机和 SQLite Outbox/Inbox。
2. 实现最小 WSS 中继、PostgreSQL RLS、工作空间与工作站授权。
3. 实现设备配对和 PWA pending/approve/deny 闭环。
4. 在真实 iOS/Android 设备上验证推送、WebAuthn、断网和重复点击。
5. 将跨版本契约与故障注入纳入 CI 和发布门禁。

## 9. 版本记录

### v0.7（2026-08-16）

- 新增官方 `remote-control` Schema 契约和本地只读状态探针。
- 在本机 `codex-cli 0.147.0` 验证 standalone CLI 的配对、设备撤销、连接状态与状态通知的最小协议。
- 静态确认 Codex Desktop 使用其自身 app-server 的第一方远控路径，而非 standalone CLI managed daemon。
- 明确真实手机/原生 Desktop 双端会话验证仍需用户显式配对，不将第一方实验性中继直接作为 YuruPager 公共 API。

### v0.6（2026-08-15）

- 在 `0.148.0-alpha.9` 复验协议契约并扩展版本门禁。
- 确认 `thread/unsubscribe` 不释放 active writer，可靠边界是持有者 app-server 进程退出。
- 将手机主动消息改为独立短生命周期 app-server，避免失败回合长期占用桌面会话。

### v0.5（2026-08-04）

- 完成 listener/TUI 重启、审批边界、跨版本契约、崩溃窗口和 Token 生命周期 Spike。
- 确认 pending 审批不跨 listener 重启恢复，崩溃模糊状态无法仅凭 thread 历史消除。
- 将 Go/No-Go 更新为 Go，并记录正式 MVP 开发的强制安全约束。

### v0.4（2026-08-03）

- 验证冲突审批采用首响应获胜，迟到相反决定不改变执行结果。
- 保存两个真实场景的最终 Token 样本和稳定请求 ID 证据。
- 增加 resolved 最小领域事件，并明确外部先处理时的未知决定对账状态。

### v0.3（2026-08-03）

- 验证真实交互式 TUI 可通过 `codex --remote` 连接本地 listener。
- 验证 Connector 能发现、恢复并处理真实 TUI 的审批及后续事件。
- 记录 bundled CLI 的 thread source 分类和伪终端测试约束。

### v0.2（2026-08-03）

- 增加 loopback WebSocket 传输和自动化测试。
- 验证 pending thread 的双客户端 resume、审批重复投递和后续事件流。
- 记录 managed daemon 对 standalone 安装的限制，并收窄下一阶段开放问题。

### v0.1（2026-08-03）

- 完成 stdio、审批、提问、Token、幂等与恢复的第一阶段 Spike。
