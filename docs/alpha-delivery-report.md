# YuruPager 第一阶段交付报告

更新时间：2026-08-13（Asia/Shanghai）

## 会话索引修复（本次更新）

此前部分 Codex 历史线程被错误显示为“等待处理”。原因是 Codex `notLoaded`/`idle` 状态被旧 Connector 映射成了 waiting，且服务端没有对账当前 `thread/list` 清单。现已修复：历史线程显示为“历史会话”，只有活动且带等待标志的线程显示为“等待处理”；Connector 每轮发送 `session.inventory`，服务端将消失线程标记为 `stale` 并从默认快照隐藏，不物理删除。线上旧数据会在新版 Connector 首次清单同步后逐步收敛。

## 交付状态

YuruPager Web Alpha 已部署在 `https://117.50.192.44/yurupager/`。主站、REST、用户 WSS、Connector WSS、PostgreSQL、响应式 Web/PWA 和原生 iOS 客户端均已形成可运行闭环。真实 Connector 当前在线，并从工作站上报 112 个 Codex 会话。

开发预览隧道已经实现并部署。工作站可通过 `yurupager preview <port>` 显式开放本机 loopback Web 开发端口；HTTP、Vite HMR WebSocket、断线重连和服务端重启恢复均已验证。服务器内部预览网关监听 `127.0.0.1:4301`，Nginx 通过已发布的 `8889` 端口按协议把 TLS 流量路由到预览网关，同时保留现有明文 File Browser。公网双视口验证已通过；HTTP 请求保留 loopback `Origin`，WebSocket Upgrade 不合成 Origin，以兼容 Vite 7 的 HMR 校验，同时不把查看设备的公网 Origin 转发到工作站。

当前线上 release：`/srv/yurupager/releases/20260813T071218Z`（`/srv/yurupager/current` 已原子指向此目录）；旧 release `20260812T104556Z` 保留用于回滚。Supervisor 服务名：`yurupager`（RUNNING，当前 PID `596803`）。

## 已实现内容

- Connector：Codex app-server 能力探测和版本门禁、隐私字段最小化、SQLite Outbox/Inbox、ACK、至少一次传输、心跳、重放与断线恢复；`sent_unknown` 不自动重发，listener 重启会取消旧审批并标记 interrupted。
- 服务端：会话认证、REST/WSS、PostgreSQL 共享 Schema、workspace 复合约束和 RLS；用户、工作空间、成员、工作站授权、会话、请求、Token 用量、审计、配对和开发预览模型。
- 管理流程：工作区创建、一次性邀请、成员加入、角色修改、成员移除、工作站逐项授权编辑和工作站撤销；所有有后果操作均有明确提交/取消边界、原子迁移和审计操作者。
- 状态与幂等：审批、拒绝和回答使用原子状态迁移与幂等键；并发相反决定只接受第一个有效结果；批准副作用在 Connector/Codex 边界至多执行一次。
- Web/PWA：桌面工作台、移动审批流、多工作空间、工作站/项目/会话、实时思考与回复、主动消息、图片收发、成员授权、Token 估算和审计；具备 manifest、图标、service worker、离线外壳、前台快照恢复和 VAPID Web Push。通知载荷只携带工作空间与请求的不透明标识，系统通知使用固定最小披露文案。
- iOS：SwiftUI 客户端支持登录保持、工作空间和待办、审批/拒绝/回答、工作站与会话、主动消息、实时失效同步、图片收发、Token 用量、成员授权和审计查询。
- 开发预览：单独 HTTPS origin、短期单次票据、独立 WSS、固定 loopback 目标、`can_preview` 权限、HTTP/WebSocket 有界流转发、过期/停止、断线不重放和零内容持久化。

## 关键工程决策

- npm workspaces monorepo；Connector、共享协议、Fastify 服务端、React/Vite Web 和 SwiftUI iOS 分层维护。
- Fastify 提供 REST/WSS；原生 `pg` 事务保留 SQL、复合外键和 RLS 的可审计性。
- 浏览器使用 HttpOnly BFF Session；Connector 使用配对后独立 Ed25519 设备身份；生产 OIDC 留到下一阶段。
- 单服务 Node 进程配合外部 PostgreSQL 与 Nginx/Supervisor 部署；Docker Compose 保留为本地和可迁移部署方式。
- 对话、图片和开发预览内容只做获授权的内存中转，不进入 PostgreSQL、可靠队列、日志、缓存或备份。
- Token 使用 app-server 累计 `total` 快照替换，按事件 ID/序号去重；最终值校准，无法校准时标记 incomplete；成本由带版本和生效时间的价格表估算。

完整记录见 `docs/technology-decisions.md`，交互状态、空间关系和提交边界见 `docs/interaction-contract.md`。

## 验证结果

| 范围 | 结果 |
| --- | ---: |
| Connector 单元/协议测试 | 69/69 通过 |
| 服务端/RLS/状态机/集成测试 | 39/39 通过 |
| Web 单元与流程测试 | 59/59 通过 |
| Playwright 桌面/移动 E2E | 18/18 通过 |
| iOS Core checks | 65/65 通过 |
| iOS XCTest | 20/20 通过 |
| iOS UI Test | 1/1 通过 |
| lint / typecheck / production build | 通过 |
| `npm audit --omit=dev` | 0 个漏洞 |

预览专项已经验证真实 HTTP、Vite HMR WebSocket、Connector 断线重连、服务端重启、路由到期和未授权访问。Connector 还覆盖了本地 WebSocket 尚未完成握手时取消流的回归，确保异步握手错误不会崩溃进程。最新 release 还验证了 Vite 7 的 loopback Origin 兼容性。最终公网媒体 smoke 通过真实登录、在线 Codex 会话、12,860 字节 PNG 分块上传、服务端 ACK 和显式取消，确认图片取消后不会进入待发送队列。Playwright 最终结果为 18/18，包含 320px 工作区入口、成员角色控件和 axe 检查；桌面和移动公网预览均无横向溢出、502 或未预期浏览器错误。发布后公网登录与快照检查返回 200，快照显示 3 个工作区、1 台在线工作站、112 个会话、2 条用量和 50 条审计记录；未授权预览返回 401。

## 视觉证据

- 桌面待办：`artifacts/screenshots/desktop-alpha-inbox.png`
- 桌面对话：`artifacts/screenshots/desktop-alpha-conversation.png`
- 移动对话：`artifacts/screenshots/mobile-alpha-conversation-reworked.png`
- 移动离线：`artifacts/screenshots/mobile-alpha-offline.png`
- 桌面图片：`artifacts/screenshots/desktop-alpha-session-images.png`
- 移动图片上传：`artifacts/screenshots/mobile-alpha-image-upload.png`
- 桌面开发预览：`artifacts/screenshots/desktop-alpha-preview-active.png`
- 移动开发预览：`artifacts/screenshots/mobile-alpha-preview-active.png`
- 桌面通知设置：`artifacts/screenshots/desktop-alpha-notification-settings.png`
- 移动通知设置：`artifacts/screenshots/mobile-alpha-notification-settings.png`
- 桌面成员管理：`artifacts/screenshots/desktop-alpha-members-management.png`
- 移动工作区菜单：`artifacts/screenshots/mobile-alpha-workspace-menu.png`
- 公网桌面对话：`artifacts/screenshots/public-desktop-current-conversation.png`
- 公网移动对话：`artifacts/screenshots/public-mobile-current-conversation.png`
- iOS XCTest 结果：`artifacts/YuruPager-iOS-final-20260813-iphone17pro.xcresult`（iPhone 17 Pro，iOS 26.5 模拟器重跑，2026-08-13 15:22）

## 已知边界与风险

- 当前预览公网入口为 `https://117.50.192.44:8889/`，已通过公网桌面和移动视口验证。该端口由 Nginx 按 TLS/明文协议复用，不能改成只代理预览的独占端口；预览访问仍必须从主站工作站详情发起一次性票据跳转。SSH/root 或已授权的 Linux 账号即可维护 YuruPager，UCloud 登录仅在所有者需要调整云安全组、公网 IP、重启/快照或账单时才需要。
- 生产 VAPID、订阅登记、失效 endpoint 清理和请求创建派发已经接通；浏览器/操作系统通知权限仍需用户在各设备显式授予，真实厂商 Push 网络的长期送达率需要继续监控。
- iOS 后台 APNs 需要 Apple Developer Team、Push entitlement、设备注册 API 和 APNs 凭据；当前 Alpha 使用前台快照与实时失效同步。
- 公网 Alpha 仍使用本地账号认证。生产上线前需要接入 OIDC、密钥托管、备份、迁移编排、限流/监控和正式域名证书。
- 真机后台恢复、VoiceOver 全流程、弱网蜂窝切换与长期负载仍需在下一阶段持续验证；当前管理 UI 的浏览器键盘/触摸路径已由 Web 测试和 E2E 覆盖，真实辅助技术仍需专项验收。

## 下一阶段建议

1. 完成 APNs 唤醒链路、Web Push 送达监控与真实 iOS/Android 设备长期验收。
2. 接入生产 OIDC、Passkey/生物认证、高风险策略和更细粒度的成员/授权策略。
3. 增加可观测性、告警、备份恢复演练、数据库迁移流水线和滚动发布。
4. 为开发预览增加域名 origin、访问时长/带宽指标、管理员撤权和异常流量保护。
5. 在保持云端零持久化边界的前提下，继续验证多工作站、大会话和图片吞吐。
