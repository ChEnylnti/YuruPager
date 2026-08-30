# YuruPager 第一阶段交互契约

- 版本：v0.7
- 日期：2026-08-11
- 适用界面：桌面 Web Console、移动 PWA、原生 iOS App

## 1. 产品任务框架

用户需要在离开工作站时识别真正需要自己的代理请求，在多个工作空间和协作者之间确认归属与风险，并可靠提交一个有审计记录的决定。主要输入是桌面键盘/指针和移动触摸，也必须支持屏幕阅读器与 reduced motion。列表浏览是高频、可逆操作；批准、拒绝、回答和高风险确认是低频但有实际副作用的提交。错误批准的代价高于多一次确认，因此网络未确认时不得显示为已经生效。

性能目标：本地输入反馈在 100 ms 内出现；列表选择不等待网络；提交立即进入明确的 `submitting` 状态，但最终决定只来自服务端响应或快照；实时消息丢失后以 REST 快照恢复。

## 2. 参考抽象

只迁移行为规律，不复制 Craft 或 Amicro 的品牌、布局、代码、视觉资产、字体、色彩或装饰表面。

| 参考 | 触发与输入 | 即时/连续响应 | 稳定锚点 | 提交点 | 取消或恢复 | 可迁移规律 |
| --- | --- | --- | --- | --- | --- | --- |
| Craft Interaction Design / Minimap | 选择列表行，键盘上下或点击 | 行立即选中，详情在固定区域替换 | 列表滚动位置、选中行、详情标题槽 | 无，属于可逆导航 | 选择另一行、后退、Esc 关闭移动详情 | 保持全局索引与当前对象身份，数据在锚点周围变化 |
| Craft Hold Enter to Confirm / consequence-aware confirmation | 点击批准/拒绝/回答；高风险请求再次确认 | 按钮 pressed，随后确认面板展示实际后果 | 请求身份条与提交操作区 | 用户在确认面板显式提交，服务端条件更新成功 | 提交前 Esc/取消；失败留在原请求并可重试；冲突采用服务端快照 | 高后果动作延迟到显式提交，不把预览当结果 |
| Amicro anchored replacement / Craft Exclusion Tabs | 状态、图标、Tab 改变 | 内容在固定尺寸槽内交换，共享选择面保持稳定 | 状态槽、图标中心、Tab 标签几何 | 选择 Tab 即提交本地视图状态 | 新输入可在当前状态上立即反向 | 保持容器与命中目标不动，只交换语义状态 |

明确拒绝：径向菜单、磁吸按钮、卡片倾斜/眩光、手势滑动审批、长按作为唯一高风险确认、装饰性 sibling stagger。这些方案在高频工作台中增加新奇成本、误触风险或缺少等价键盘路径。

## 3. 空间与状态模型

### 桌面

```text
固定 64px 顶栏：产品 / 全局待办 / 工作空间 / 连接与账户
├─ 固定 224px 主导航：待办、工作站、会话、用量、成员、审计
├─ 320-400px 对象列表：过滤器、稳定 56px 行、选择锚点
└─ 弹性详情检查器：对象身份条、内容、固定底部操作区
```

选择后列表不消失，详情从列表对象获得空间来源。状态、指派人和处理人使用固定高度槽，实时更新不改变行高。工作空间归属同时保留在顶栏、列表行和请求详情身份条；切换工作空间会清除不属于新范围的选择。

### 移动

```text
固定顶栏：当前工作空间 / 在线状态
待办快照列表 -> 单一请求详情 -> 确认面板
固定底部导航：待办、工作站、用量、更多
```

移动端不压缩桌面三栏。列表到详情是可返回的页面关系；身份条始终位于操作区之前。底部操作区预留固定高度，不因 loading、错误或协作者处理而跳动。

### 请求状态

```text
loading -> pending -> confirming -> submitting
              |            |           ├─ server accepted -> approved|denied|cancelled
              |            |           ├─ conflict -> snapshot final state
              |            |           └─ network error -> pending + retry context
              ├─ expired
              ├─ cancelled
              ├─ interrupted
              └─ collaborator decision -> approved|denied

approved -> queued -> delivered
                  └─ sent_unknown (fail closed; workstation recovery only)
```

最终请求状态不会回到 `pending`。`delivered` 与 `sent_unknown` 是投递维度，不能覆盖批准/拒绝语义。listener 重启将旧 pending 请求变为 `interrupted`，取消其确认面板和可操作状态。

## 4. 核心交互契约

| 状态 | 输入 | 即时反馈 | 连续映射 | 提交点 | 取消或恢复 |
| --- | --- | --- | --- | --- | --- |
| 工作空间切换 | 菜单、键盘、触摸选择 | 触发器立即显示 pressed；内容进入稳定 skeleton | 菜单锚定触发器，不移动顶栏 | 服务端快照成功后更新 scope | Esc/外部点击关闭并返还焦点；失败保留旧 scope |
| 列表选择 | 点击、Enter、方向键 | 选中行和详情标题立即更新 | 同一列表选择锚点移动；详情保持区域边界 | 本地可逆选择即生效 | Back/Esc 或选择另一对象；焦点回到对应行 |
| 普通批准 | 点击/Enter | 打开确认面板，显示工作空间、工作站、项目、工具与后果 | 面板从操作区/触发按钮产生 | 确认按钮发送带 Idempotency-Key 的请求；服务端成功才成为 approved | 提交前取消；网络失败保留请求与重试；冲突显示实际操作者 |
| 高风险批准 | 点击/Enter | 打开模态框，风险摘要与二次确认控件聚焦 | 模态框居中，背景仅表达不可交互层级 | 二次确认通过后显式提交 | Esc、取消、认证失败均保持 pending；关闭后焦点返回批准按钮 |
| 拒绝 | 点击/Enter | 打开拒绝原因字段，拒绝按钮保持不可用直到理由有效 | 原请求身份条稳定 | 显式“提交拒绝”后服务端原子迁移 | Esc/取消不清除服务端状态；提交失败保留文本供重试 |
| 回答问题 | 选择选项/输入文本 | 字段本地显示，尚未标为已回答 | 问题顺序和标题不移动 | 所有必填答案有效后显式“提交回答” | 取消保留本次草稿至页面离开；失败可重试；secret 不持久化草稿 |
| 实时协作冲突 | 他人先提交 | 状态槽、操作区和屏幕阅读器 live region 同步 | 请求身份和详情位置不变 | 服务端 WebSocket/REST 快照为事实源 | 本地提交停止；显示实际操作者和时间，不提供重复按钮 |
| 离线/重连 | 网络丢失/恢复 | 顶栏与操作区立即标记离线，提交禁用 | 当前内容保留，不清空页面 | 重连后 REST 快照完成才恢复操作 | 手动重试；推送丢失也走同一快照恢复 |
| sent_unknown | Connector 回执窗口不确定 | 红色状态槽和工作站恢复说明；所有远程重发禁用 | 保持原请求和决定可审计 | 只能由工作站人工对账流程解决 | 不提供自动重发；恢复动作写入审计 |
| 主动消息 | 在选定会话输入文本和/或选择第 11 节受限图片；点击发送或按 Cmd/Ctrl+Enter | 编辑器进入明确提交状态，文字、图片缩略图和会话身份保持可见 | 会话列表、详情标题、附件顺序和固定编辑器位置不移动 | 服务端完成权限、幂等与 Outbox 事务后成为 `queued`；Connector 成功启动 turn 后成为 `delivered` | Esc 不发送；边界前失败保留草稿并允许显式重试；`sent_unknown` 禁止自动重发 |

## 5. 焦点、输入和中断

- 所有图标按钮都有可访问名称和 hover/focus tooltip；核心动作始终有可见文本。
- 列表使用真实按钮/链接语义；Tab 使用 `tablist`、`tab` 和 `tabpanel`；模态框使用 `dialog`、`aria-modal`，打开聚焦首个安全控件。
- 弹层关闭后焦点回到触发控件；若触发对象已因实时更新消失，焦点回到最近的稳定列表标题。
- Esc 关闭未提交菜单、面板和模态框，不取消已经到达服务端的提交。
- 动画可以被新的选择、关闭或反向输入打断；业务状态不依赖 `animationend` 才提交。
- 触摸目标最小 44 x 44 px；视觉图标可保持紧凑。hover 只加速显示，不承载唯一入口。
- reduced motion 下用短淡入或即时交换保留状态理解，移除位移、scale 和 blur。

## 6. 可测量验收标准

- 普通和高风险批准在确认前不会发出决定 API；双击只使用同一 Idempotency-Key。
- 两个协作者同时提交相反决定时只有一个 HTTP 200；另一方收到 409 和首个实际操作者。
- 网络断开、500、超时或 WebSocket 丢失时不显示伪造的最终状态；恢复后 2 秒内以快照收敛。
- listener 重启后旧请求在所有客户端显示 `interrupted`，其确认面板关闭且不再可提交。
- `sent_unknown` 在重启后保留，自动重发次数为零。
- 桌面 1280 x 720、1440 x 900 与移动 390 x 844、360 x 800 下无横向溢出、遮挡、空白视图或状态更新引起的可见布局跳动。
- 200 字符工作空间名、项目路径、命令和错误状态可换行/截断并能通过详情或 tooltip 获取，不覆盖相邻操作。
- 只用键盘可完成登录、切换工作空间、打开请求、批准/拒绝/回答、取消确认和退出；关闭后焦点返回原触发控件。
- axe 关键流程无 serious/critical 问题；状态变化通过 polite/assertive live region 按后果播报一次。
- reduced motion 媒体查询下所有业务路径可用，关闭/hover-out 无 delay，任何新输入都不被动效锁住。

## 7. 主动消息扩展

### 参考抽象与空间关系

采用 Craft Interaction Design 的 `Vanish Input` 中“输入被消费后仍保持容器和焦点几何”的行为规律，但不迁移其视觉表面。YuruPager 使用常规多行文本框与发送图标，固定在会话详情底部；提交期间不把详情替换成聊天页面，也不显示服务端未确认的消息气泡。会话标题、工作空间、工作站和项目是稳定身份锚点。

拒绝采用完整聊天时间线、乐观消息气泡、按 Enter 直接发送以及后台自动重试 `sent_unknown`。完整时间线会要求服务端保存代理对话，乐观气泡会把排队误表示为 Codex 已接收，单独 Enter 发送不利于编辑多行指令，未知结果重试可能启动重复 turn。

### 状态与隐私模型

```text
editing -> submitting -> queued -> delivered
   |           |           ├─ failed (尚未触及 turn/start，可人工重试)
   |           |           └─ sent_unknown (可能已启动 turn，禁止自动重试)
   |           └─ HTTP/权限/网络错误 -> editing，保留原文
   └─ Esc/切换会话 -> 不提交；当前会话内草稿保留
```

服务端只在可靠 Outbox 等待 Connector 处理时短暂保存明文；收到 Connector ACK 后立即将 Outbox 载荷脱敏。持久的会话命令记录只包含发送者、目标会话、长度、状态和时间，不保存文本或 Codex 回复。Connector Inbox 只在崩溃恢复窗口保存明文，处理完成后立即替换为脱敏标记。

### 可测量验收标准

- 空白消息和超过 8,000 字符的消息不会入队；无 `can_respond` 权限的用户收到 403。
- 慢网络下重复点击或重复 Cmd/Ctrl+Enter 只创建一个命令和一个 Outbox 项。
- Connector 离线时已接受的命令保持 `queued`；重连后用同一消息 ID 投递。
- `thread/resume` 失败标为 `failed`，文字与第 11 节的本地图片草稿保留供用户明确重试；进入 `turn/start` 写入边界后的任何不确定结果标为 `sent_unknown`，重启后自动重发次数为零。
- `turn/start` 成功后状态为 `delivered`，记录实际发送者并更新会话最新 turn；服务端与 Connector 持久层均不再包含消息明文。
- 桌面与移动端编辑器不遮挡会话内容，8,000 字符文本不导致横向溢出；发送按钮触摸目标至少 44 x 44 px，具备可访问名称。
- reduced motion 下状态图标即时或短淡入交换，不使用位移、scale 或 blur；新输入不等待动画完成。

## 8. 临时 Codex 会话时间线

### 参考抽象与交互意图

采用 Craft Interaction Design 的“稳定全局索引与局部焦点”以及“高频操作减少新奇”的行为规律。会话列表、会话身份条、用量与固定输入区保持原位，中间详情区显示工作站即时提供的临时对话时间线。这里迁移的是对象身份连续、稳定锚点和可中断导航，不迁移 Craft 或 VS Code 的品牌、布局、视觉资产或代码。

用户的主要任务是在离开工作站时确认 Codex 当前对话、理解它正在进行哪类工作并发送后续消息，而不是浏览云端聊天档案。时间线展示 `userMessage`、`agentMessage` 文本，以及由 Connector 在工作站侧生成的脱敏活动摘要。活动摘要只表达“读取文件”“搜索项目”“运行命令”“调用工具”“更新文件”“压缩上下文”等动作类别和进行中 / 完成 / 失败状态，不传输模型隐藏推理、原始命令、参数、输出、Diff、完整路径、MCP 返回值、环境变量、图片字节或任意附件。第 11 节允许的受限图片使用独立媒体帧，不得塞入活动标签或工具输出。

| 参考 | 触发与输入 | 连续响应 | 稳定锚点 | 提交点 | 取消或恢复 | 可迁移规律 |
| --- | --- | --- | --- | --- | --- | --- |
| ChatGPT Codex 的过程活动行 | Codex item 开始、完成或失败 | 同一活动行就地交换状态与图标 | turn 内的 item ID、时间线滚动位置 | `item/completed` 只校准该 item 的最终状态 | 新事件可中断状态交换；重连从本机 thread 重建 | 用结构化动作摘要解释进展，不展开原始工具载荷 |
| YuruPager 既有过程消息 | `agentMessage` commentary 增量 | 当前消息原位追加文本 | message ID、固定行头 | `message.complete` 以完整正文校准 | 切换会话立即取消；重连以本地历史替换 | 增量更新对象本身，不为每个片段创建新行 |

拒绝采用服务端聊天表、可靠 Outbox/Inbox 对话帧、浏览器持久缓存、逐 Token 屏幕阅读器播报和聊天气泡堆叠。它们会扩大公网服务器的数据权限、把瞬时查看误解为云端历史，并让高频流式更新产生噪声。主动用户消息仍服从第 7 节的可靠投递规则；Codex 回复只走非持久的在线通道。

### 空间、状态与提交边界

```text
会话列表（稳定选择锚点）
  -> 会话身份条（工作空间 / 工作站 / 项目 / 会话）
  -> 临时时间线（唯一可滚动区域）
  -> 固定输入区（有副作用的显式提交）

unsubscribed -> loading(snapshot + queue resync) -> live
                    |        ├─ live frame during read -> 标记立即二次校准
                    |        ├─ live frame after read -> 即时转发并就地更新快照
                    |        ├─ connector offline -> unavailable
                    |        └─ relay error -> error
                    └─ history.complete(empty) -> empty/live

刷新 / WebSocket 重连 -> loading -> Connector 本地 thread/read 全量替换
切换会话 / 离开详情 -> 立即 unsubscribe 并清空内存正文
```

时间线没有业务提交点：订阅是可逆的临时查看，关闭或切换会话立即取消。输入区的发送仍是有副作用的显式提交，不把本地输入或流式回复当成 Codex 已接受新 turn 的证据。历史重建以 `thread/read(includeTurns: true)` 为事实源；读取期间若同时到达 live 通知，该订阅会标记立即再次 `thread/read`，在 `history.complete` 后以新快照差量校准；历史完成后的通知立即转发并更新 Connector 内存快照。消息完成事件用完整正文重置同一消息，活动完成事件用最终状态替换同一 item，校准可能遗漏的增量。

### 取消、恢复与可访问行为

- 浏览器只在 React 内存保存当前会话正文，不写 PostgreSQL、审计正文、Service Worker cache、IndexedDB、`localStorage` 或 `sessionStorage`。
- 服务端订阅路由和正文帧只存在于进程内存，不进入日志、Outbox、Inbox、ACK、快照或数据库；每次订阅都重新执行成员与工作站查看权限校验。
- Connector 离线时明确显示“工作站离线，无法读取对话”，不回退到陈旧云端副本；重连后重新读取本地 thread。
- 用户接近底部时跟随新内容；用户向上阅读后暂停跟随并显示“回到最新”，新帧不得抢夺滚动位置。
- 活动行与对应 Codex item 共用稳定 ID。开始、完成和失败只更新原行，不产生重复记录；进行中 spinner 只装饰当前状态，状态文字始终可读。
- 流式增量不逐段进入 live region。只在历史可用、回复完成、离线或错误时播报一次；状态变化不移动会话身份条和输入区。
- 新的会话选择、取消订阅和重连可以中断正在进行的视觉过渡；离开详情后焦点回到原会话行，移动端返回保持列表滚动位置。

### 可测量验收标准

- 未授权用户订阅只收到通用拒绝状态，响应、日志和 WebSocket 帧都不泄露本地 `threadId`。
- 历史和实时流仅含用户/助手文本、Connector 生成的脱敏活动摘要，以及第 11 节由用户显式选择或 Codex 官方图片 item 产生的受限图片帧；使用敏感夹具验证隐藏推理、工具参数、原始命令、输出、完整路径、一般文件内容、Diff、环境变量和 MCP 返回值既不进入帧，也不进入服务器数据库。允许的图片字节只经授权 WSS 内存中转，同样不得进入服务器数据库。
- 单帧正文按 Unicode code point 安全切分且不超过 16 KiB；重组后与本地 `thread/read` 文本逐字符一致。
- `thread/read` 延迟期间注入 item start、消息 delta 与 item complete，历史结束后必须立即二次校准且不丢字、不重复 item；进行中的消息在完成前至少产生一次可观察的 DOM 文本更新。
- 刷新、网络重连和 Connector 重连后以新历史替换内存内容，不重复消息；快速切换会话不会把旧会话帧写入新会话。
- 工作站离线时历史不可用；恢复在线后 2 秒内进入 loading 并开始重建，不展示服务端旧副本。
- 桌面和移动长代码行可横向滚动或换行，不撑破详情；时间线更新不移动顶部身份条或底部输入区。
- 键盘、触摸和屏幕阅读器均可选择会话、滚动、回到最新和发送；屏幕阅读器不会按 Token 连续播报。
- reduced motion 下订阅、历史替换和状态交换不使用位移、scale 或 blur，功能与普通模式一致。

## 8.1 移动 Web 会话工作区

### 交互意图与参考抽象

移动端会话的首要任务是在离开工作站时连续阅读 Codex 回复并发送下一步消息，而不是同时扫描会话列表、指标和传输记录。参考 Happy mobile 的独立会话页面、覆盖式会话标题栏、单一消息滚动区、按实测输入栏高度为最新消息预留空间、离开底部后显示“回到最新”，以及 ChatGPT 移动 Web 的紧凑会话顶栏、抽屉式历史入口和底部输入锚点。这里只迁移空间分工、滚动保持、提交边界和恢复行为，不复制两者的品牌、颜色、资产、布局表面或代码。

| 项目 | YuruPager 移动会话契约 |
| --- | --- |
| 产品任务 | 从会话列表进入一个可持续阅读和发送的临时 Codex 会话 |
| 稳定锚点 | 会话返回键、项目标题、连接状态、消息滚动区、输入栏和信息入口 |
| 空间关系 | 列表与聊天详情互斥；聊天详情占满 `100dvh`；顶栏与输入栏固定，时间线独占剩余空间 |
| 提交模型 | 选择会话与打开信息立即生效；发送只有服务端返回 `queued` 后才清空草稿 |
| 取消 | 返回离开详情并取消正文订阅；关闭信息 Sheet 不改变会话；发送中不能被第二次点击重复提交 |
| 恢复 | 返回恢复列表滚动位置和原会话行焦点；草稿按会话保留；重连重新订阅本地 thread |
| 拒绝方案 | 移动端上下分割 master/detail、常驻指标条、常驻传输记录、固定三行输入框、全局 Tab 与聊天同时占底部 |

### 空间、状态与滚动模型

```text
会话列表（唯一页面）
  -> 选择会话
全屏聊天详情（唯一页面，100dvh）
  -> 56px 会话标题栏：返回 / 项目与归属 / 状态 / 信息
  -> minmax(0, 1fr) 时间线：唯一主要滚动区
  -> 自适应输入栏：1 行起步，最大 120px，包含 safe-area inset
  -> 信息 Sheet：身份 / Token / 请求 / 传输记录（按需覆盖）

list -> opening -> conversation
conversation -> info_open -> conversation
conversation -> back -> list + restore scroll/focus

timeline at_latest -> 新帧后跟随最新
timeline reading_history -> 新帧保持当前锚点 + 显示“回到最新”
回到最新 -> at_latest

composer idle -> submitting -> queued -> clear draft
                         |-> rejected/error -> retain draft
                         |-> sent_unknown -> retain draft + require workstation check
```

全局工作空间顶栏与底部 Tab 只属于列表层级。聊天详情打开后两者隐藏，由会话标题栏提供返回和对象身份；因此键盘、Home Indicator 和底部导航不会同时侵占输入区。工作空间、工作站、项目和会话身份仍持续可见：紧凑标题栏显示项目、工作空间和工作站，完整字段在信息 Sheet 中展开。指标、请求和传输记录不是聊天主流程，不允许常驻挤压消息区。

时间线是唯一主要滚动区。用户在距底部 72px 内时跟随增量；用户上滑阅读后，新帧不能抢走位置，只显示固定的“回到最新”。输入框以一行高度开始，随正文增长到 120px 后内部滚动；`visualViewport`/`100dvh` 与 `env(safe-area-inset-bottom)` 共同保证系统键盘打开时输入栏仍可见。空状态、离线、同步失败和权限不足在时间线状态槽中替换，不改变标题栏或输入栏位置。

### 提交、取消、恢复与可访问行为

- 发送是有后果的显式提交。提交中按钮禁用，界面不插入伪造的乐观消息；服务端确认 `queued` 后才清空草稿。错误、权限不足和 `sent_unknown` 均保留正文，`sent_unknown` 不提供自动重发。
- 返回会话列表时立即取消临时正文订阅并清空时间线内存；草稿不含服务端正文，可按会话留在当前 React 生命周期。再次进入时重新从 Connector 本地 `thread/read` 重建。
- 信息 Sheet 由标题栏中的 44 x 44px 按钮打开，关闭按钮、Escape 和背景点击均可关闭；关闭后焦点返回信息按钮。Sheet 打开时焦点被限制在其中，页面正文不可交互。
- 返回按钮、信息按钮、发送按钮和“回到最新”至少 44 x 44 CSS px。会话行整行可触摸和键盘激活；hover 只提供辅助反馈，不是唯一入口。
- 项目、工作区、工作站、路径、命令、状态和错误允许省略、换行或独立滚动，不能造成页面横向溢出。标题省略时完整身份可由可访问名称和信息 Sheet 获取。
- 页面切换和 Sheet 动画可被新输入中断。`prefers-reduced-motion` 下取消位移、scale 和 blur，保留即时状态变化与焦点语义；关闭与 hover-out 不设延迟。

### 可测量验收标准

- 在 320 x 568、390 x 844 和 430 x 932 视口中，首次进入“会话”只显示会话列表；选择后只显示全屏聊天，不显示全局顶栏、底部 Tab、会话列表、指标条或常驻传输记录。
- 在 390 x 844 中，聊天标题栏、至少 240px 高的消息可视区和完整输入控件同时可见；输入栏与消息不重叠，页面 `scrollWidth <= clientWidth`，动态状态变化不改变主网格轨道。
- 输入 1 行到 8,000 字符时编辑器在约 44px 到 120px 内增长；超过最大高度后只滚动编辑器，发送按钮保持 44 x 44px 且不移动出视口。
- 打开软键盘或把 `visualViewport` 高度缩短后，输入栏仍在可视区域底部；最新消息可滚动到输入栏上方，不被遮挡。
- 上滑超过 72px 后新回复不改变用户阅读锚点并出现“回到最新”；点击后到达最新消息并恢复自动跟随。
- 返回后列表恢复原滚动位置，原会话行获得焦点；打开并关闭信息 Sheet 后焦点返回信息按钮。Tab 顺序、屏幕阅读器名称、状态播报和触摸目标通过 Playwright 与 axe 检查。
- 长工作区名、长项目名、长命令、空状态、离线、同步失败、权限不足、慢发送、重复点击和 reduced motion 均有移动截图或自动化断言，页面没有遮挡、溢出、布局跳动或空白。

## 8.2 本机项目与会话发现

### 参考抽象与交互意图

采用 Craft Minimap 的“稳定全局索引与局部焦点”规律，把 Connector 已授权工作站上的项目作为会话索引的第一层，把本机 Codex thread 作为第二层。用户先确认项目归属，再选择一个具体会话读取临时正文或发送下一步消息。这里只迁移稳定锚点、对象身份连续和可中断选择，不复制 Codex、Craft 或其他客户端的侧栏布局、标题内容、品牌或视觉资产。

| 项目 | YuruPager 项目索引契约 |
| --- | --- |
| 产品任务 | 在同一工作站发现多个 Codex 项目，并进入其中已有会话继续工作 |
| 稳定锚点 | 工作空间范围、工作站名、项目标题行、选中会话行和详情身份条 |
| 空间关系 | 项目标题分组会话；详情始终对应一个 thread，不把项目本身伪装成聊天 |
| 提交模型 | 展开项目和选择会话是本地可逆导航；只有固定输入区的发送是业务提交 |
| 取消 | 折叠项目不删除会话；返回列表取消正文订阅；刷新不能改变当前有效选择 |
| 恢复 | Connector 启动全量分页扫描，运行中周期刷新；重连后从本机 thread 清单重建项目索引 |
| 拒绝方案 | 单一启动目录、固定 50 条、持久化对话标题或 `preview`、用首条消息推导标题、为每个项目安装一个 Connector、刷新后自动跳到第一条 |

项目身份由本机 thread 的规范化 `cwd` 派生。持久化会话元数据只包含项目末级名称、脱敏路径提示、thread ID、模型、状态和时间戳，不包含 thread `preview`、会话标题、完整路径、磁盘记录路径或 Git 元数据。同名但路径不同或工作站不同的项目保持独立分组，避免把两个实际目录合并成一个对象。

会话行先以 `Codex 会话 <thread-id 前 8 位>` 作为稳定占位，Connector 发现官方 `thread.name` 后在原行、原文本槽中替换。标题最多 120 个 Unicode code point，控制字符与双向文本格式字符在 Connector 端移除；不从 `preview` 或正文生成标题。标题仅通过现有 WSS 进入服务端进程内存，再按 RLS 与工作站查看权限映射到会话 ID；PostgreSQL、Connector Outbox/Inbox、审计、日志、REST 快照、service worker 缓存和备份均不得包含标题。Connector 离线、服务端重启或实时通道尚未补全时恢复编号占位，不影响选择、滚动位置或详情订阅。

```text
Connector start
  -> thread/list(cwd omitted, archived=false, cursor=null)
  -> while nextCursor: thread/list(cursor=nextCursor)
  -> upsert minimal session metadata
  -> every 30s refresh + thread/started immediate discovery

Web session index
  -> workstation / projectPath group (stable project row)
  -> updatedAt-desc thread rows
  -> select thread -> ephemeral thread/read -> conversation
```

### 状态、恢复与可访问行为

- 首次发现期间沿用快照 skeleton；已存在快照的后台刷新不清空项目列表、不折叠用户当前展开的项目，也不覆盖按会话保留的输入草稿。
- 新 thread 到达时插入所属项目并按更新时间排序；当前选中 thread 仍存在时保持选择、滚动位置和详情，不抢夺焦点。
- 官方会话名异步到达时只替换同一行的标题文本，不改变行高、状态槽、选中态或焦点，也不通过 live region 主动播报后台补全。
- Connector 单次扫描失败时保留服务端最近一次元数据快照，并在下一周期重试；它不把失败解释为“本机没有项目”，也不删除历史元数据。
- 项目标题使用真实按钮语义和 `aria-expanded`；会话使用整行按钮。hover 只提供反馈，展开、折叠和选择均支持键盘、触摸与屏幕阅读器。
- 项目名、脱敏路径和工作站名允许省略或换行，不改变状态槽和会话行的固定最小高度；完整脱敏路径可由 title 与会话信息 Sheet 获取。
- 项目展开/折叠和列表到详情的过渡可以被新输入中断；reduced motion 下取消位移、scale 和 blur，关闭与折叠不设延迟。

### 可测量验收标准

- 本机 thread 数量超过单页限制时遍历全部 `nextCursor`，每个游标只请求一次；重复或循环游标会停止并报告失败，不产生无限扫描。
- 不传 `cwd` 时能发现 `trace-agent`、`Yururi`、`auto`、`YuruPager` 等不同目录；软链接或冗余路径经规范化后不因字符串表现差异重复分组。
- Connector 启动后新建的 thread 在 `thread/started` 到达后立即出现；未收到通知时在 30 秒刷新周期内出现。
- `preview`、thread 磁盘 `path`、Git 信息和绝对 home 路径在 Connector envelope、PostgreSQL、审计与 Web 快照中的出现次数为零。
- 官方标题只出现在实时 WSS 帧和当前进程内存；数据库、SQLite 可靠队列、审计、日志、REST 快照与离线缓存中的出现次数为零。标题通道断开时编号占位仍可操作，重连后在原位补全。
- 同名不同路径、不同工作站、超过 50 条、归档状态、Connector 重连与扫描失败均有自动化测试；当前选中会话在刷新后仍保持选中。
- 320 x 568、390 x 844、1280 x 720 与 1440 x 900 下，长项目名和至少 20 个项目分组可滚动，无横向溢出、遮挡、空白页或列表刷新导致的布局跳动。

## 9. 工作站一条命令配对

### 交互意图与参考抽象

用户需要把另一台自己控制的 macOS 或 Linux 工作站加入某个工作空间，同时确认正在授权的是眼前那台设备。采用 Craft 的 consequence-aware confirmation 与稳定对象身份规律，以及 Amicro anchored replacement 的固定状态槽：配对码、候选设备身份和最终工作站在同一对话框区域内逐步替换，触发按钮、标题、操作区和对话框尺寸约束保持稳定。这里只迁移显式提交、对象连续与可中断状态交换，不迁移参考产品的品牌、布局、视觉资产或审美表面。

拒绝采用永久共享 Connector Token、创建邀请码即自动授权、仅靠设备名称确认、关闭对话框即隐式取消、自动重复消费配对码，以及把长期凭据显示在 Web。永久共享 Token 不能独立撤销；设备登记不是用户授权；设备名不是稳定身份；关闭与取消必须语义分离；重复消费会破坏单次使用边界；长期凭据只应返回给 Connector。

### 空间、状态与提交边界

```text
工作站标题栏（稳定“添加工作站”触发器）
  -> 配对对话框（稳定标题 / 工作空间 / 状态槽 / 操作区）
       -> waiting_for_device：配对码、剩余时间、复制命令
       -> pending_approval：设备名称、平台、公钥指纹、目标工作空间
       -> approving：禁用重复操作，保留全部身份信息
       -> approved：显示工作站已绑定；长期凭据仅交付 Connector

creating -> waiting_for_device -> pending_approval -> approving -> approved
                |                       |               ├─ 冲突 -> 服务端实际状态
                |                       |               └─ 网络错误 -> pending_approval
                ├─ expired              ├─ cancelled
                └─ cancelled            └─ expired
```

创建配对会话只产生十分钟、单次使用的邀请码，不授予工作站权限。Connector 输入邀请码后仅登记候选设备；Web 用户核对工作空间、设备名称、平台和公钥指纹并点击“确认连接”才到达授权提交点。服务端以原子条件更新创建工作站、默认管理授权和一次性设备凭据；客户端只有收到成功响应或恢复快照后才显示已连接。

关闭对话框只关闭视图，不取消服务端配对；再次打开时恢复仍有效的会话。显式“取消配对”才使邀请码失效。过期、取消和被其他协作者处理会立即禁用操作并在 live region 播报；新的输入可以中断状态交换。对话框关闭后焦点返回“添加工作站”，若触发器不可用则返回工作站标题。

### 输入、恢复与验收标准

- 鼠标、键盘、触摸和屏幕阅读器都可创建、复制、确认、取消和关闭配对；hover 不承载唯一入口，图标按钮有 tooltip 和可访问名称。
- 配对码只在创建响应与有效会话视图显示，服务端只保存 SHA-256 哈希；日志、审计和快照不得包含配对码或长期设备凭据。
- Connector 候选登记使用同一邀请码重试时返回同一会话状态；不同设备竞争同一码时只有首台设备能登记。
- 两位管理员同时确认或一人确认一人取消时，只有首个有效原子状态迁移成功；另一方显示实际最终状态，不创建第二个工作站或凭据。
- Web 关闭、刷新、推送丢失、慢网络和服务重启后，通过服务端快照恢复 `waiting_for_device` 或 `pending_approval`；本地倒计时只用于显示，服务端时间决定是否过期。
- 未确认、已取消或已过期的 Connector 不能连接 WSS。已确认设备使用独立凭据；撤销某工作站不影响其他设备，并关闭该设备现有连接。
- 复制命令不得包含长期凭据。配对成功页不得回显长期凭据；Connector 凭据文件权限必须为 `0600`。
- 桌面与移动视口中，长设备名、平台、服务地址、命令和错误文本可换行或滚动，不改变固定操作区高度，不遮挡关闭和提交控件。
- reduced motion 下状态替换即时或短淡入，不使用位移、scale 或 blur；关闭和取消没有延迟。

## 9.1 工作区、成员与工作站授权管理

### 交互意图与参考抽象

管理操作改变多人协作边界，不能被当作普通导航或即时本地切换。采用
Craft 的 consequence-aware confirmation、stable anchors 和 Exclusion Tabs
的行为规律：当前工作区、成员行、工作站身份和操作槽保持稳定，服务端确认
后才替换角色、授权或成员状态。这里只迁移提交边界、对象连续和冲突恢复，
不迁移参考产品的品牌、布局、视觉资产或代码。

明确拒绝：创建邀请即自动加入、点击角色下拉后静默保存长期权限、滑动移除、
仅靠 hover 显示管理操作、撤销工作站后继续保留旧 Connector 凭据，以及把
管理员操作伪装成本地乐观成功。这些方案会扩大误授权窗口、缺少触摸/键盘等价
路径，或让协作者看到与服务端不一致的权限。

### 空间关系与状态模型

```text
工作区菜单（稳定触发器）
  -> 创建工作区 / 加入邀请（表单提交区）

成员视图（工作区身份栏 + 固定表格行）
  -> 邀请角色 / 创建邀请 -> invite_created
  -> 成员角色选择 -> role_submitting -> role_updated | error
  -> 移除 -> remove_confirming -> remove_submitting
                         -> removed | conflict | error

工作站详情（稳定设备身份）
  -> 编辑授权 -> access_editing -> access_submitting -> access_updated | error
  -> 撤销工作站 -> revoke_confirming -> revoke_submitting
                         -> revoked | conflict | error
```

工作区菜单关闭后焦点返回触发器；创建或加入失败保留已填写字段。邀请令牌只
在创建成功响应和当前内存视图中显示，复制是独立的可逆操作，不自动发送给任何
第三方。角色下拉是成员行内明确的提交控件，角色变更以幂等请求发送；提交中
禁用该行重复提交但不改写其他行的几何。

移除成员和撤销工作站属于有后果动作。第一次点击只进入固定操作槽的确认态，
第二次显式点击才发送原子请求；取消、Escape 或外部关闭恢复原行。网络失败保留
确认对象和错误，允许用户用同一目标重试。服务端返回冲突或实时快照显示另一位
操作者时，立即禁用本地操作并显示最终成员/工作站状态，不提供重复提交按钮。

工作站授权编辑使用明确的 checkbox 状态；Owner/Admin 的继承权限显示为禁用
且可解释的状态，普通成员的授权逐项提交。撤销成功后 Connector 连接和凭据
立即失效，所有相关会话/请求在下一次快照中不可见；旧页面不显示仍可操作的
按钮。新输入可中断任何菜单、确认或状态动效，业务结果不依赖 `animationend`。

### 可访问性、取消与验收标准

- 创建工作区、邀请、角色修改、成员移除、授权切换和撤销均有真实按钮、select、
  checkbox 或表单语义；hover 只提供辅助提示，键盘、触摸和屏幕阅读器均可完成。
- 成员角色 select 具有包含成员姓名的可访问名称；成员移除和工作站撤销的确认
  控件在提交前可通过 Escape/取消返回原触发槽，关闭后焦点返回原控件。
- 只有服务端成功响应或恢复快照才显示新角色、已移除、授权已更新或已撤销；
  500、超时、断网和服务重启不产生伪造最终状态。
- 两位管理员同时提交相反角色/移除或授权变化时，只有一个有效原子迁移；另一
  方在 2 秒内以快照收敛，并显示实际最终操作者和审计记录。
- 320 x 568、390 x 844、1280 x 720 和 1440 x 900 下，长工作区名、成员邮箱、
  工作站名和错误文本可换行/截断，不遮挡操作槽、不产生横向溢出或行高跳动。
- reduced motion 下菜单、确认层、状态文字和图标即时或短淡入交换；关闭、hover-out
  和取消没有延迟，连续点击不会等待动效完成。

## 10. 原生 iOS 移动控制台

### 交互意图与参考抽象

原生 App 面向离开工作站后的短时确认、协作与跟进，首要任务是处理待办，其次是查看工作站和会话状态、发送后续消息、核对用量与审计。采用 Craft 的“稳定全局索引与局部焦点”“高后果动作显式提交”和“高频操作减少新奇”，并采用 Amicro anchored replacement 的固定状态槽规律。迁移内容仅限对象身份连续、提交边界和可中断状态交换；不复制任何参考产品或桌面 Web 的品牌、布局、视觉资产和审美表面。

拒绝采用 WebView 包装 PWA、桌面三栏缩放、滑动即批准、长按作为唯一确认、聊天内容本地持久化、卡片堆叠和装饰性转场。原生系统导航、列表、Sheet、Confirmation Dialog、Dynamic Type 与 VoiceOver 是默认交互语言。

| 字段 | iOS 契约 |
| --- | --- |
| 产品任务 | 在手机上识别请求归属和风险，可靠提交决定；查看工作站、会话、用量、成员和审计；向在线 Codex 会话发送消息 |
| 参考 | Craft stable anchors、consequence-aware confirmation、Minimap；Amicro anchored replacement |
| 稳定锚点 | 五个 Tab、当前工作空间标题、列表滚动位置、详情身份区、底部操作区和状态槽 |
| 提交模型 | 选择和浏览立即生效；批准、拒绝、回答和主动消息只有服务端确认后才成为完成状态 |
| 恢复 | 前台与 WebSocket 重连后重新拉取 REST 快照；冲突显示服务端最终操作者；正文流重新向工作站订阅 |
| 拒绝表面 | 桌面三栏、聊天气泡、品牌模仿、手势审批、装饰性 blur/scale/stagger |
| 验收证据 | XCTest 覆盖 URL、状态归并、幂等重试与隐私边界；完整 Xcode 环境运行 UI Test、VoiceOver 和真机检查 |

### 空间、状态与提交边界

```text
TabView：请求 / 工作站 / 会话 / 用量 / 更多（稳定全局索引）
  -> NavigationStack：列表 -> 详情（返回保留列表位置）
  -> Toolbar 工作空间菜单（所有页面持续显示归属）
  -> 详情滚动区（身份、必要上下文、处理信息）
  -> safeAreaInset 底部操作区（固定提交锚点）

launching -> restoring session -> signed_out | loading snapshot -> ready
ready -> live connected | offline/error -> snapshot refresh -> ready

decision idle -> confirmation -> submitting -> server confirmed
                           |         |-> conflict -> final server state
                           |         |-> network error -> retry with same key
                           |-> cancel -> idle

session view -> subscribe -> loading -> live | connector_offline | denied | error
leave/background -> unsubscribe + clear all conversation text
```

- `请求` 默认显示待处理，历史通过分段控件切换；待办徽标保持固定槽位，计数变化不得挤动 Tab。
- 工作空间切换是本地选择提交，立即清除旧范围详情和临时会话正文，再获取目标快照。切换失败保留工作空间身份并显示可重试错误，不混合两个工作空间的数据。
- 批准、拒绝和回答使用原生 Sheet 显示工作空间、工作站、项目、风险、工具与后果。高风险批准需要 Sheet 内第二次显式确认；取消 Sheet 不产生服务端决定。
- 提交中禁用重复操作，但不把请求本地改为已处理。失败后保留同一幂等键用于明确重试；用户取消并重新发起才创建新键。`409` 后刷新并展示实际操作者。
- 主动消息在输入区确认后进入提交中，服务端返回 `queued` 才清空输入。`sent_unknown` 绝不自动重发，并显示必须到工作站核对。
- Codex 正文只在当前前台会话内存存在，切换会话、退出、进入后台或断线时清空；App 不把正文、问题秘密答案、密码、会话 Cookie、终端输出、Diff 或代码写入 UserDefaults、日志和快照缓存。
- HttpOnly 会话由 URLSession Cookie Store 管理；用户开启“保持登录”时只把会话 Cookie 写入 Keychain，关闭时不跨启动保留。UserDefaults 只保存非敏感服务器地址、工作空间选择和保持登录偏好，绝不保存密码。

### 取消、恢复与可访问行为

- Sheet 可通过取消按钮或系统下拉关闭，关闭后 VoiceOver/键盘焦点回到原操作；提交中禁止交互式关闭，避免把仍在进行的请求误解为取消。
- App 进入前台后总是以服务端快照校准待办；推送、WebSocket invalidation 和本地旧状态都不是审批事实来源。
- 每个触摸目标至少 44 x 44 pt；长名称、命令、路径和错误允许多行或横向选择，不遮挡导航与底部操作区。
- 使用系统语义颜色、Dynamic Type、VoiceOver label/value/hint 和逻辑阅读顺序。颜色不是风险或状态的唯一编码。
- 动效只使用 SwiftUI/系统组件的语义导航与 Sheet 呈现；新输入可中断。Reduce Motion 下禁用自定义位移、scale、blur 和 stagger，状态用即时替换或短淡入。

### 可测量验收标准

- 冷启动、会话失效、离线、空数据、权限不足和服务端错误均有可操作状态，任何 Tab 不出现空白页。
- 两位协作者提交相反决定时只有首个有效结果；另一台 iPhone 在实时失效通知或下一次快照后禁用操作并显示最终操作者。
- 慢网络和连续点击只发出一次决定；网络失败后的重试复用原幂等键。批准响应未确认前不显示成功。
- `sent_unknown` 没有自动重试入口；拒绝、取消、过期与中断状态不显示批准操作。
- 会话切换、后台、断线与退出后，内存中的用户/助手正文和秘密答案均被清空；持久存储检查找不到这些内容。
- iPhone SE 尺寸到大屏 iPhone、最大辅助文字尺寸和中英文长内容下无横向溢出、遮挡或操作区跳动。
- 完整 Xcode 环境必须通过单元测试、UI Test、模拟器截图、VoiceOver 顺序、Reduce Motion 和至少一台真机的登录、审批、冲突及会话消息流程。

## 11. 端到端会话图片

### 交互意图与参考抽象

用户需要在当前 Codex 会话中检查 Codex 明确返回的图片，并从 Web、移动 PWA 或 iOS 选择图片作为下一轮输入。图片选择是本地、可逆的草稿编辑；上传和启动新 turn 是有网络与执行后果的显式提交。界面必须立即在输入来源附近反馈选择结果，但在服务端确认排队前不能把图片伪装成已送达 Codex。

本节迁移 Craft Interaction Design 的稳定锚点、可逆预览与“昂贵动作延迟到明确提交”规律，以及 Amicro anchored replacement 的固定槽位状态交换。只迁移行为规律，不复制 Craft、Amicro、ChatGPT 或 Codex 的品牌、聊天布局、视觉资产、图片查看器表面或代码。

| 参考 | 触发与输入 | 即时/连续响应 | 稳定锚点 | 提交点 | 取消或恢复 | 可迁移规律 |
| --- | --- | --- | --- | --- | --- | --- |
| Craft Invisible Details / consequence-aware commit | 文件选择器、粘贴、拖放、PhotosPicker 或 Files 选择图片 | 在输入区原位生成本地缩略图并显示数量、格式或限制错误 | 当前会话身份、输入框、发送按钮和附件顺序 | 用户显式点击发送，授权一次暂存和一次 turn 尝试；实际副作用边界是 Connector 调用 `turn/start` | 发送前移除；上传中取消；边界前失败保留草稿并显式重试 | 轻量预览可提前，昂贵提交必须明确且可辨认 |
| Craft stable anchors / Minimap | Codex 图片帧进入当前时间线 | 同一图片 ID 的占位、进度、完成或失败在原媒体槽更新 | 时间线阅读位置、图片槽、会话标题和“回到最新”锚点 | 无，属于授权后的临时查看 | 失败可重新订阅；离开会话清空客户端图片；重连从 Connector 历史重建 | 数据围绕稳定对象变化，不因异步解码移动用户参考点 |
| Amicro anchored replacement | 上传或加载状态变化；打开大图 | 状态图标在固定槽交换；大图从被激活缩略图进入独立查看层 | 缩略图几何、关闭控件和返回焦点目标 | 打开查看器是可逆导航，不提交业务状态 | Escape、关闭按钮或系统关闭；焦点返回原缩略图 | 固定容器与命中目标，只替换真实语义状态 |

明确拒绝：选择即自动启动 turn、把图片乐观插入为已发送、图片 Base64 进入 REST JSON 或可靠 Outbox、服务端磁盘或对象存储缓存、公开或长期签名 URL、原路径或文件名上云、从 Markdown 或远程 URL 自动抓图、SVG 和任意文件附件、工作站离线排队图片、仅靠拖放或 hover 的入口、滑动删除作为唯一移除方式、缩略图卡片堆叠、装饰性 stagger，以及在 `sent_unknown` 后自动重发。

### 空间关系与稳定锚点

```text
桌面会话详情
  -> 固定会话身份与状态
  -> 唯一时间线滚动区
       -> 文本 / 活动 / 图片媒体槽（按 Codex item 顺序）
  -> 固定输入区
       -> 单行附件托盘（最多 4 张，横向排列）
       -> 添加图片 / 文本输入 / 发送 / 状态槽

移动 Web / iOS 会话
  -> 紧凑会话标题栏
  -> minmax(0, 1fr) 唯一时间线
  -> safe-area 输入区
       -> 单行可横向滚动附件托盘
       -> 添加图片 / 文本输入 / 发送
  -> 全屏图片查看层（覆盖，不改变下层滚动位置）
```

图片附件始终绑定选择时的 `workspace_id + workstation_id + session_id`，切换会话不得把草稿缩略图带入另一会话。附件托盘出现后使用固定的一行高度；增加第二至第四张只在托盘内排列或滚动，不继续挤压时间线。桌面图片与正文列对齐并设置最大宽高；移动端使用可用宽度和受约束高度，`object-fit: contain`，不能遮住标题栏、输入区或 safe area。

每个返回图片在 `image.start` 时创建固定媒体槽；优先使用已经校验的宽高比，缺失尺寸时使用固定回退比例。分块、解码、完成和失败只替换槽内内容，不能改变图片行身份、抢夺焦点或在用户阅读历史时改变滚动锚点。用户仍在距底部 72px 内时新图片可以跟随最新；已经上滑时只显示“回到最新”。

稳定锚点包括会话身份、附件顺序、缩略图与移除按钮、文本草稿、发送按钮、上传状态槽、返回图片 ID、时间线滚动位置和大图查看器的触发缩略图。状态变化不得改变添加、移除、发送和关闭控件的命中尺寸。

### 状态模型与提交边界

```text
draft_empty -> selecting -> draft_ready(1...4)
                    |             ├─ remove -> draft_ready | draft_empty
                    |             ├─ invalid -> reject item + retain valid draft
                    |             └─ picker cancel -> previous draft
                    └─ local read failure -> previous draft + error

draft_ready + explicit send
  -> uploading(n / total)
       ├─ cancel / disconnect / validation failure -> draft_ready + explicit retry
       └─ staged_on_connector
            -> queueing
                 ├─ confirmed pre-turn failure -> draft_ready + explicit retry
                 └─ queued -> clear local draft
                      -> Connector resume / validate attachment
                           -> turn/start boundary
                                ├─ confirmed success -> delivered
                                └─ timeout / crash / ambiguous response -> sent_unknown

image.start -> receiving ordered chunks -> verifying -> ready
                    |                    ├─ duplicate same chunk -> ignore safely
                    |                    └─ gap / mismatch / oversize -> failed
                    └─ disconnect -> unavailable -> resubscribe from Connector history
```

第一阶段仅接受 PNG、JPEG 和 WebP；单次消息最多 4 张，单张最多 5 MiB，总计最多 12 MiB。图片可以不附带文本独立发送。选择和预览只读取客户端本地内容，不触发网络提交；用户点击发送才授权传输。图片上传要求目标 Connector 在线，离线时可以继续编辑本地文字和图片草稿，但发送图片必须禁用并显示“工作站在线后才能发送图片”。

点击发送后的 `uploading` 仍处于 `turn/start` 之前，用户可明确取消；取消必须中止后续分块、清理 Connector 局部文件并保留客户端草稿。进入 `queueing` 后禁用重复提交，不提供无法兑现的“撤销发送”。上传、校验、写盘或确定的 pre-turn 错误保留同一幂等意图，只有用户再次点击才重试。Connector 一旦跨过 `turn/start`，任何超时、崩溃或响应不确定都进入 `sent_unknown`；不得自动上传、排队或调用第二次 `turn/start`。

| 状态 | 输入 | 即时反馈 | 连续映射 | 提交点 | 取消或恢复 |
| --- | --- | --- | --- | --- | --- |
| 选择图片 | 添加图片按钮、文件选择、图片粘贴或桌面拖放；iOS PhotosPicker / Files | 原位生成缩略图、数量和限制状态；不清空文本 | 选择顺序映射为附件顺序，最多 4 个固定槽 | 无，本地草稿 | 取消选择保持原草稿；逐张移除 |
| 移除图片 | 点击或键盘激活移除按钮 | 目标缩略图立即消失，其余保持相对顺序 | 焦点移动到下一移除按钮；没有下一项时回到添加图片 | 无，本地草稿 | 可重新选择；不隐式删除已进入 Codex thread 的历史图片 |
| 发送图片 | 点击发送或显式键盘发送 | 按钮禁用，状态显示第几张和总进度；时间线不插入伪造消息 | `uploading -> staged -> queueing` 在同一状态槽替换 | 用户点击授权一次尝试；`turn/start` 是副作用与模糊结果边界 | 上传中取消；边界前错误显式重试；边界后遵守 `sent_unknown` |
| 查看返回图片 | 点击、Enter、Space 或 VoiceOver 激活图片 | 当前缩略图保持来源身份，打开覆盖式查看层 | 缩放只作用于查看层，不改变时间线尺寸和顺序 | 无，可逆查看 | Escape、关闭按钮或系统关闭，焦点返回缩略图 |
| 返回图片失败 | 分块缺口、摘要不符、超限、解码失败或断线 | 同一媒体槽显示安全错误码和重新加载动作 | 不自动循环重试，不逐块播报 | 无 | 用户重新订阅；重连后从 Connector thread 历史重建 |

### 隐私、取消与恢复

- 图片字节只经已认证用户 WSS、服务端进程内存路由和目标 Connector WSS 临时中转；不得进入 PostgreSQL、可靠 Outbox/Inbox、ACK 载荷、审计、日志、临时文件、对象存储、备份、Service Worker cache、`localStorage`、`sessionStorage`、IndexedDB 或 iOS `UserDefaults`。
- 原图绝对路径、相对路径和文件名不进入云端帧、错误、状态标签或可访问名称。界面使用“你发送的图片 1”“Codex 返回的图片 1”等角色与序号标签，不用文件名生成说明。
- Connector 以不透明名称把已完整校验的附件保存在权限 `0700` 的私有目录，文件权限必须为 `0600`。附件属于工作站本地 Codex thread 历史，可在刷新、WebSocket 或服务端重连后重新分块发送；服务端离线快照不恢复图片。
- 未完成上传的分块在取消或校验失败后立即清理，Connector 重启时清理残片。已经越过 `turn/start` 的附件不能通过 Web 的“移除草稿”删除或触发重发；本地 thread 删除与数据清理遵循 Connector 所有权。
- Web 本地预览和组装结果只使用内存 `Blob` 与 object URL。移除、替换、成功排队、会话切换、`history.start`、离线清空和组件卸载时必须中止读取并 `URL.revokeObjectURL`。
- iOS 图片只使用当前前台会话内存中的 `Data` / `UIImage`；离开会话、切换工作区、断线、进入后台或退出登录时释放，不写相册、QuickLook 临时文件、URLCache 或 `UserDefaults`。
- Connector 离线时返回图片与正文一样不可用；恢复后重新订阅并从本地 thread 重建。服务端重启不应要求重新上传已经进入 thread 的用户图片。

### Web、触摸与 VoiceOver 行为

- Web 添加图片使用熟悉的 Lucide 图片或附件图标，按钮带 tooltip、可访问名称和至少 44 x 44 CSS px 命中区；隐藏文件输入不能成为键盘焦点陷阱。拖放和粘贴只是快捷路径，始终保留可键盘操作的文件选择器。
- Web 缩略图整体可打开查看器，每张有独立的移除图标按钮。文件选择器关闭后焦点回到添加按钮；移除后焦点按附件顺序恢复；查看器关闭后焦点返回原缩略图；发送成功后焦点回到文本输入。
- iOS 使用系统 `PhotosPicker` 与 Files 图片选择，添加、缩略图、移除、文本输入和发送按视觉顺序进入 VoiceOver。每个触摸目标至少 44 x 44 pt；Dynamic Type 放大时状态文字允许换行，不能覆盖缩略图或发送按钮。
- 图片 `alt` 或 VoiceOver label 只描述角色、序号与状态；分块不进入 live region。完成、失败、取消或 `sent_unknown` 只播报一次，进度变化使用节流后的确定值，不能按每个 chunk 连续打断用户。
- 图片查看层提供明确关闭控件、语义标题和单一图片阅读对象。hover 只用于视觉反馈；打开、关闭、移除、重试和发送均支持键盘、触摸与屏幕阅读器。
- 图片加载占位到内容可使用语义匹配的 skeleton reveal，大图查看可使用 modal，状态图标可使用固定槽 icon swap；附件出现、图片 chunk 和流式正文不强行动画。所有过渡可被新输入中断；reduced motion 下取消位移、scale 和 blur，关闭与 hover-out 没有延迟。

### 可测量验收标准

- PNG、JPEG、WebP 都能分别作为单图和图片独立消息到达 Codex，并能从 Codex 历史返回 Web 与 iOS；SVG、伪造 MIME、第五张、单张 `5 MiB + 1 byte` 和总计 `12 MiB + 1 byte` 在 `turn/start` 前被拒绝。
- 精确 4 张、单张 5 MiB 和总计 12 MiB 的边界夹具按规则处理，不因 Base64 膨胀把编码长度误当原始字节限制；合法图片顺序在上传、Codex 输入和历史重建后三处一致。
- 图片可以在文本为空时发送；慢网络连续点击只产生一次上传意图和最多一次 `turn/start`。上传中取消、缺块、重复块、乱序、摘要不符、工作站断线、Connector 重启和服务端重启都有自动化测试。
- 所有能证明发生在 `turn/start` 前的失败只在用户明确操作后重试；故障注入跨过边界后必须得到 `sent_unknown`，重连、刷新和进程重启均不会再次调用 `turn/start`。
- 未授权查看者收不到图片元数据或分块；有 `can_view` 无 `can_respond` 的成员可以查看但不能上传。撤销授权会终止当前分块且不留下云端可恢复副本。
- 使用唯一图片字节、路径和文件名哨兵扫描 PostgreSQL、Outbox/Inbox、审计、日志、Service Worker cache、Web 持久存储和 `UserDefaults`，出现次数为零；Connector 历史附件存在且文件权限实测为 `0600`，云端帧中路径和文件名出现次数为零。
- Web 单元测试确认所有 object URL 在移除、成功、取消、切换与卸载路径被撤销；iOS 内存检查确认会话关闭、后台和退出后不再持有图片 Data。
- 1440 x 900、1280 x 720、430 x 932、390 x 844、360 x 800 和 320 x 568 下，4 张长宽比极端图片、长错误文字、软键盘和最大 Dynamic Type 不产生横向溢出、遮挡、空白页、输入区覆盖或图片解码导致的布局跳动。
- Playwright 覆盖选择、移除、图片独立发送、Codex 返回图、失败重试、大图查看、焦点返回、44px 触摸目标、axe 和 reduced motion，并生成桌面、移动和大图查看截图；iOS UI Test 与模拟器截图覆盖 PhotosPicker 注入夹具、VoiceOver 顺序和 44pt 目标。
- 用户上滑离开底部后，图片开始、分块和解码都不改变当前阅读位置；点击“回到最新”后恢复跟随。屏幕阅读器不会逐块播报，关闭图片查看器后焦点回到触发图片。

## 12. 工作站开发预览

### 交互意图与参考抽象

用户需要从另一台桌面或移动设备检查工作站上仅监听本机端口的 Web 应用。高频动作是打开已经明确授权的预览；低频且有安全后果的动作是开放或停止本机端口。采用 Craft Invisible Details 的后果感知提交、稳定对象身份和高频操作低新奇原则：轻量查看从稳定的预览行直接打开，有暴露后果的端口授权只在工作站本机命令提交。

| 参考 | 触发与输入 | 即时响应 | 稳定锚点 | 提交点 | 取消或恢复 | 可迁移规律 |
| --- | --- | --- | --- | --- | --- | --- |
| Craft consequence-aware commit | 工作站终端输入 `yurupager preview <port>` | 命令立即显示目标 `127.0.0.1:port`、有效期和连接状态 | 终端命令、数字端口和随机路由 ID | 独立预览 WSS 完成认证且 Connector 探测 loopback HTTP 成功 | `Ctrl+C`、到期或 Web 停止；网络恢复只重新宣告路由，不重放请求 | 有安全后果的暴露必须在对象所在设备明确提交 |
| Craft stable anchors / registry selection | 工作站详情选择一个活动预览 | 行内固定状态槽更新；打开动作保持位置 | 工作站身份、预览行、端口、到期时间和操作区 | 打开是可逆导航，不改变路由 | 新标签关闭回到原列表；失败保留行和显式重试 | 数据与状态围绕同一对象更新，避免列表跳动 |
| Craft frequency and novelty | 反复打开当前预览 | 熟悉的外链按钮直接进入独立 origin | 打开按钮和预览 origin | 一次性票据兑换后进入根路径 | 票据失败回主站重新打开；不暴露可复制 bearer URL | 高频检查使用熟悉控件，不增加手势或装饰性流程 |

明确拒绝：从 Web 输入任意主机或端口、自动扫描本机服务、主站同源 iframe、公开可复制链接、选择即长期开放、后台静默续期、把流量写入审计或日志、用 hover 作为唯一入口、滑动停止、关闭延迟、连接中乐观显示可访问，以及断线后自动重放 POST/PUT/PATCH/DELETE。

### 空间、状态与提交边界

```text
工作站详情（稳定设备身份）
  -> 开发预览区段
       -> 空状态 + 本机命令格式
       -> 活动预览行
            localhost:5173 | 可访问 | 剩余时间 | 打开 | 停止

本机：idle -> command submitted -> connecting -> active
                                      |           ├─ Ctrl+C / Web stop -> stopped
                                      |           ├─ deadline -> expired
                                      |           └─ WSS loss -> connector_offline -> reconnecting
                                      └─ probe/auth failure -> failed -> process exits

打开：main session auth -> one-time ticket issued
                         -> preview origin POST redemption
                         -> context cookie + redirect `/`
                         -> HTTP/WS stream -> complete | cancel | failed | outcome_unknown
```

桌面端把开发预览作为工作站详情中的无框区段，不新建顶层导航。每行使用固定三列：身份、状态、操作；端口与标签可截断但数字端口始终可读。移动端改为两行，状态与到期时间在身份下方，打开和停止保持至少 44 x 44 CSS px 命中区，不嵌入会遮挡 YuruPager 导航的远程页面，而是在独立标签打开。

本机命令是开放端口的唯一提交点。Web 端不得发送“探测 5173”或“打开任意端口”命令；工作站详情只展示 Connector 已宣告且当前用户有 `can_preview` 权限的路由。`connecting` 不能显示“打开”；收到服务端和 Connector 双方确认后才进入 `active`。停止是显式命令，点击后立即禁用重复操作并显示“正在停止”，服务端确认前不移除行。

| 状态 | 输入 | 即时反馈 | 提交点 | 取消或恢复 |
| --- | --- | --- | --- | --- |
| 无活动预览 | 阅读命令、复制命令格式 | 固定空状态，不自动探测 | 无 | 在工作站本机运行命令 |
| connecting | Connector 宣告路由 | 固定状态槽显示“正在连接”，打开禁用 | loopback HTTP 探测和服务端登记成功 | 探测失败退出；重新运行命令 |
| active | 点击“打开预览” | 新标签先显示安全启动页，再跳转独立 origin | 一次性票据原子兑换 | 票据过期回主站重新打开；刷新重新发起 GET，不恢复旧流 |
| stopping | 点击“停止” | 同一行禁用操作并交换状态文字 | 服务端确认路由停止 | 网络失败保留行并允许显式重试 |
| offline / expired / failed | 断线、到期或错误 | 行内规范错误和下一步，不显示可用链接 | 无 | 网络恢复重新宣告；到期/失败重新运行本机命令 |

### 安全、可访问性与可测量验收

- 预览页面使用独立 HTTPS origin 和独立 host-only Cookie；主站 Cookie、Authorization、Origin、Referer、Forwarded 与代理认证 header 不得到达本机 fixture。预览页面向主站 `/api/live` 发起的跨 origin WebSocket 必须被拒绝。
- 端口是 `1024...65535` 的十进制整数，目标地址由 Connector 固定为 `127.0.0.1` 或 `::1`；协议没有 host 字段。`CONNECT`、absolute-form URL、CRLF header、超限 body、Service Worker 和非 HTTP 协议在本机写入前拒绝。
- 路由、访问票据、HTTP 请求与 WebSocket stream 都绑定工作空间和工作站。无 `can_preview`、跨工作空间、撤权、已停止、已过期、错误 Connector 身份和重放票据均收不到端口、标签或流量。
- 请求和响应正文、URL、query、header 与 frame 只在内存中转；用唯一哨兵扫描 PostgreSQL、Outbox/Inbox、审计、Nginx 和应用日志，出现次数为零。允许审计的仅是预览开始、打开、停止、到期和聚合字节数。
- HTTP 根资源、根绝对资源、SPA fallback、302、POST body、错误状态和真实 Vite HMR WebSocket 均通过端到端测试。浏览器取消、慢上游、Connector/服务端重启会关闭旧流；已经写入本机的非幂等请求不得自动重放。
- 桌面 1440 x 900、1280 x 720 与移动 430 x 932、390 x 844、360 x 800 下，长工作站名、长预览标签、五位端口、离线错误和多个预览不溢出、不遮挡、不改变操作行高度。
- 预览行按身份、状态、打开、停止的阅读顺序支持键盘、触摸和屏幕阅读器；状态用 `role=status` 或一次性 live region 播报，不逐块播报流量。关闭提示或返回主站后焦点回到触发链接。
- 行状态可以使用固定槽文本或图标交换，帮助表达连接因果；频繁的流量分块、计数和心跳不做动画。全部过渡可被新输入打断，reduced motion 下即时替换或短淡入，停止、关闭和 hover-out 没有 delay。

## 13. PWA 通知订阅与恢复

### 交互意图与参考抽象

通知是把用户带回待办的可靠入口，而不是在锁屏上复制审批详情。采用 Craft consequence-aware commit 的明确授权、stable anchors 的原位状态替换和 Amicro anchored menu 的触发点关系：权限请求只来自用户点击，铃铛始终是同一锚点，菜单内只替换支持、未开启、提交中、已开启、被拒绝和错误状态；不复制任何参考产品的视觉表面。

| 触发 | 即时反馈 | 稳定锚点 | 提交点 | 取消或恢复 |
| --- | --- | --- | --- | --- |
| 打开铃铛菜单 | 展示当前浏览器和服务端能力，不触发系统权限 | 顶栏铃铛、菜单标题、状态行和操作槽 | 无，可逆查看 | Escape、点外部或关闭；焦点返回铃铛 |
| 点击开启通知 | 固定操作槽显示“正在开启”，禁止重复点击 | 铃铛、说明与按钮尺寸不变 | 用户手势调用系统权限；服务端确认 endpoint 后才完成 | 系统取消/拒绝保留明确状态；登记失败撤销新本地订阅并显式重试 |
| 点击关闭通知 | 固定操作槽显示“正在关闭”，仍显示当前开启身份 | 同上 | 服务端删除 endpoint 成功后撤销本地订阅 | 网络失败不乐观关闭；保持开启并允许重试 |
| 收到/点击通知 | 系统以稳定 tag 合并同一请求，打开待办路由 | 待办 Tab、工作空间和请求 ID | 无业务决定 | 恢复前台后拉取快照；已处理则禁用操作并显示操作者 |

### 状态、空间与提交边界

```text
unsupported | server_disabled
supported -> permission_default + unsubscribed
          -> enabling -> permission_granted -> subscribing -> registering
                        | denied                | failure -> unsubscribed + error
                        |                       └─ confirmed -> subscribed
subscribed -> disabling -> server deleted -> local unsubscribe -> unsubscribed
                         └─ network failure -> subscribed + retry

push received -> generic system notification
notification click -> focus existing client | open PWA
                   -> ?view=inbox&request=<opaque id>
                   -> authenticated snapshot refresh
                   -> pending actionable | final read-only | signed-out login
```

桌面端铃铛位于顶栏操作区；移动端保留 44 x 44 CSS px 命中区并隐藏冗余文字。锚定菜单不挤压顶栏或页面内容，宽度受视口约束，长错误允许换行。菜单打开时焦点进入标题后的第一个可操作控件，Tab 不被困住；Escape、点外关闭后焦点回到铃铛。hover 只提供视觉反馈，所有动作同时支持键盘、触摸和屏幕阅读器。

开启和关闭都是有外部后果的显式提交，不做无法兑现的乐观切换。系统权限弹窗不可由 YuruPager 撤销；权限被拒绝后只说明需要到浏览器/系统设置恢复，不循环请求。账号切换后重新读取当前 `PushSubscription` 并向当前账户登记，防止端点继续属于上一个账号。

通知标题固定为“YuruPager 有新的待办”或“YuruPager 待办已更新”，正文固定为“打开应用查看当前状态。”载荷和锁屏不得出现工作空间名、工作站、项目、命令、工具、风险、问题、拒绝原因、对话或最终决定。通知按钮不直接批准、拒绝或回答；任何有后果的提交仍只在详情页确认。

菜单展开只在语义匹配时使用 transitions.dev anchored menu recipe；打开 250ms、关闭 150ms，无关闭 delay，transform origin 固定在铃铛。状态文字在固定槽内交换；不为系统权限弹窗、push 到达或数字心跳添加动画。新点击可以立即关闭，`prefers-reduced-motion` 下取消位移、scale 和 blur。

### 可测量验收标准

- 在支持 Push API 的安全上下文中，系统权限只在用户点击后请求一次；首次登记失败不显示已开启，并撤销本次创建的本地订阅。
- 重复点击开启或关闭最多产生一个进行中的提交；慢网络时按钮尺寸、菜单位置和说明不跳动。
- 未认证、跨账户读取/删除、无工作站响应权限和已撤权用户收不到通知。一个 endpoint 同时最多属于一个账户。
- 重复 `request.created` envelope 只触发一次派发；相同请求通知使用同一 tag。provider `404/410` 清理端点，暂时错误保留并可在后续请求再次派发。
- 用真实命令、项目名、问题、用户邮箱和长文本哨兵扫描 payload、审计与日志，出现次数为零；payload 只含版本、事件、请求 ID、工作空间 ID 和时间。
- 推送丢失、浏览器被终止、服务重启或通知在另一设备已处理后，重新打开应用都通过快照得到同一最终状态，不从通知恢复决定。
- 1440 x 900、390 x 844、360 x 800 和 320 x 568 下菜单不越界、不遮住底部操作区；键盘焦点顺序、Escape 返回、屏幕阅读器名称、44px 触摸目标和 reduced motion 均通过自动化与真实设备检查。

## 14. 多 Agent 审批与会话发现

YuruPager 从“远程 Codex 控制台”升级为多 Agent 监督控制台：Connector 通过
AgentRuntime 扇出编排多个 agent 运行时（Codex 原生 app-server、ACP 代理、
Cursor 原生 stream-json），共享同一条云端连接与既有可靠性语义（至少一次投递、
ACK 重放、`sent_unknown` 门闩）。每个会话由 `agent + sessionId` 唯一归属；
Web/iOS 快照中的 SessionSummary 携带 `agent` 字段并在会话行与详情中展示徽标。

### 14.1 会话发现按能力降级

- Codex 保持全局 `thread/list` 发现；官方 `thread.name` 仍只经授权内存中转。
- ACP 代理在声明 `loadSession` 能力时通过 `session/load` 重建历史；未声明时
  只监督 Connector 自己启动的会话（会话绑定持久化在 Connector SQLite，重连后
  恢复，历史不可回放并如实呈现）。
- Cursor 同为 own-sessions：无历史重放，实时时间线可用。
- 禁止读取 agent 本地磁盘转录文件或内部数据库作为发现手段。列表中会话数量
  少于本机真实会话数属于降级模式的如实呈现，UI 不做虚假补全。

### 14.2 审批归一化与 fail-closed

- 各 agent 的权限请求统一映射为现有 `request.created`（带 `agent` 与
  `sessionId` 字段）与 `DecisionInput` 审批流；Web/iOS 的批准、拒绝、回答
  交互对所有 agent 一致。
- ACP：仅显式 `allow_once` 选项映射为批准；“always allow”类扩大授权的选项
  与未知选项一律按拒绝处理；未知的 server→client 请求直接报错。
- Cursor：`can_use_tool` 控制请求映射为 allow/deny；未知控制子类型返回错误
  并按拒绝收尾。
- 工具遥测沿用既有净化边界：原始命令输出、diff、文件内容与工具输入不出工作
  站，只有有界、去控制字符的 activity 标签进入帧。每个适配器的契约测试包含
  净化断言（原始 IO 不得出现在任何帧或可靠载荷中）。

### 14.3 能力与用量呈现

- 每 agent 的能力（发现方式、审批选项、用量上报、图片）由 initialize 探测
  产生，探测失败时该 agent 禁用或降级，不伪装可用。
- 未上报用量的 agent（如经适配器的 Claude Code 与 ACP 代理）在界面上如实
  显示用量不可用；Cursor 的 result 用量累计为累积快照，provider 为 `cursor`，
  无价格目录条目时估算成本留空。任何 agent 都不得构造用量数据。
