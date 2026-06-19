# Zen AI v1.1.56 发布文案草稿

## 发布摘要

Zen AI `v1.1.56` 现已准备发布。本次版本继续完善跨电脑恢复备份后的微信接入语义：旧设备的微信会话保留为离线历史，新电脑扫码时会创建新的微信接入。同时优化公告入口，方便常驻公告二次更新后让用户清楚看到变更内容。

## 本次更新

### 修复

- 修复跨电脑导入备份后，微信接入复用旧电脑 channel，导致历史会话和当前在线连接混在一起的问题。
- 恢复备份时会清理导入数据中的微信登录 token，并将恢复来的微信 channel 标记为离线，避免 B 电脑误用 A 电脑的登录态。

### 优化

- 公告入口页调整为更宽的内容区域，并支持单条公告折叠/展开，较长公告默认只显示摘要区域。
- 公告支持单条 `updatedAt` 更新时间。常驻公告内容二次编辑后不会重新弹窗，但公告入口会显示“最近更新”时间，并为本地读过旧版的用户提供“查看变更”按钮。
- “查看变更”支持新增内容红字、删除内容中划线展示；按钮的红色提醒与公告已读状态分开记录，用户真正点击查看变更后才会恢复普通样式。
- 开发环境支持通过 `VITE_RENDERER_ANNOUNCEMENT_FEED_URL` 指定公告 feed，便于本地验证公告展示效果。
- 点击“微信扫码接入”时，如果没有当前可用的在线微信通道，会新建一个微信 channel 并弹出新的二维码。
- 会话列表会显示恢复来的旧微信会话为离线状态，历史对话仍可查看，但不再代表当前电脑在线接入。
- 微信通道设置页保留“重新扫码”操作，可在会话过期或手动维护某个通道时刷新二维码。

## 重要说明

- 微信手机端同一时间只能绑定一台电脑的登录会话。跨电脑恢复备份后，旧微信通道和旧会话会保留，但默认作为离线历史处理。
- 新扫码成功的微信 channel 才代表当前电脑正式在线使用。
- 普通升级或没有 `.restore` 标记的启动不会清理微信登录 token，也不会将当前电脑已有的微信通道标记为离线。

## 验证情况

本次发布前建议完成：

- `pnpm exec vitest run src/main/services/__tests__/BackupManager.test.ts --project main`
- `pnpm exec vitest run src/main/services/agents/services/channels/__tests__/ChannelManager.test.ts --project main`
- `pnpm run i18n:check`
- `pnpm run typecheck:node`
- `pnpm run typecheck:web`
- `pnpm run typecheck:node:release`
- `pnpm run typecheck:web:release`
