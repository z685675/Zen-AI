# Zen AI v1.1.55 发布文案草稿

## 发布摘要

Zen AI `v1.1.55` 现已发布。本次版本继续完善跨电脑恢复备份场景，重点修复恢复后微信接入不会弹出扫码二维码的问题。

## 本次更新

### 修复

- 修复跨电脑导入备份后，微信接入沿用旧电脑登录凭证，导致点击“微信扫码接入”只打开设置页、不弹出二维码的问题。
- 恢复备份时会清理导入数据中的微信登录 token，避免 B 电脑误用 A 电脑的登录态。

### 优化

- 微信通道设置页新增“重新扫码”操作，可在会话过期、手机微信切换绑定电脑、或跨电脑恢复备份后手动触发新的二维码。
- 从智能助手页点击“微信扫码接入”进入设置页时，会自动触发微信重新扫码流程，不再停留在普通配置状态。

## 重要说明

- 微信手机端同一时间只能绑定一台电脑的登录会话。跨电脑恢复备份后，微信通道配置会保留，但需要在新电脑重新扫码登录。
- 本次迁移仍不改写用户外部文件夹、微信临时文件、下载目录、文档目录等路径，只清理应用内部 `Data/Channels` 下的微信登录 token。
- 普通升级或没有 `.restore` 标记的启动不会清理微信登录 token。

## 验证情况

本次发布前已完成：

- `pnpm exec vitest run src/main/services/__tests__/BackupManager.test.ts --project main`
- `pnpm exec vitest run src/main/services/agents/services/channels/__tests__/ChannelManager.test.ts --project main`
- `pnpm run i18n:check`
- `pnpm run typecheck:node`
- `pnpm run typecheck:web`
