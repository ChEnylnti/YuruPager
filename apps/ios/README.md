# YuruPager iOS

原生 SwiftUI 客户端复用 YuruPager 的 REST、用户 WebSocket、工作空间权限和审批状态机。最低系统版本为 iOS 17。

## 本地运行

1. 安装完整 Xcode 16 或更新版本，并在 Xcode Settings 中安装 iOS Simulator Runtime。
2. 打开 `YuruPager.xcodeproj`。
3. 在 Signing & Capabilities 中选择自己的 Team；真机运行时保持 Bundle Identifier 唯一。
4. 选择 iPhone Simulator 或已启用开发者模式的 iPhone，运行 `YuruPager` Scheme。
5. 登录页默认连接 `https://117.50.192.44/yurupager/`。展开“服务器”可改为其他 HTTPS 部署；Simulator 访问本机 Docker 可使用 `http://127.0.0.1:4300/`。

应用不保存密码、请求快照和完整 Codex 对话。登录页的“保持登录”默认开启：BFF 会话 Cookie 由 URLSession 管理，并以 Keychain 作为跨启动恢复存储；关闭后只维持当前运行会话。服务器地址、最近工作空间和保持登录偏好是仅有的 UserDefaults 项。会话正文只在当前前台详情内存中存在。

## 验证

无 UI 的协议核心可在只有 Swift 工具链的机器运行，便于在没有 Simulator 的环境中先验证协议、状态归并与隐私边界：

```bash
cd apps/ios
swift run yurupager-core-checks
```

完整 Xcode 环境运行：

```bash
xcodebuild -project YuruPager.xcodeproj \
  -scheme YuruPager \
  -destination 'platform=iOS Simulator,name=iPhone 16 Pro' \
  test
```

UI Test 会保存紧凑视口登录页附件。审批并发冲突、真实 Connector 会话和 `sent_unknown` 仍应在共享服务端集成测试与真机流程中共同验证。

2026-08-13 的最终 Alpha 基线已在本机完整 Xcode 26.6 与 iPhone 17 Pro（iOS 26.5）Simulator 上重跑通过：核心检查 `65/65`、XCTest `20/20`、UI Test `1/1`。结果包位于仓库 `artifacts/YuruPager-iOS-20260813.xcresult`，UI Test 附件位于 `artifacts/ios-test-attachments/`。

## 当前发布边界

本工程支持前台 REST 快照、实时失效同步、审批/拒绝/回答、工作站与会话查看、主动消息、会话图片选择与返回图查看、Token 用量、成员授权和审计查询。图片草稿、分块和完整图片只驻留当前前台会话内存，不写入 `UserDefaults`、URLCache 或临时文件。APNs 后台推送需要 Apple Developer Team、Push entitlement、服务端设备注册 API 和 APNs 凭据，不包含在当前无签名凭据的本地构建中。
