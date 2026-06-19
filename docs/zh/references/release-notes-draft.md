# Zen AI v1.1.53 发布文案草稿

## 发布摘要

Zen AI `v1.1.53` 现已发布。本次版本重点修复跨电脑恢复备份后的内部路径兼容问题，避免旧电脑用户名残留导致官方智能助手、微信接入等功能无法正常使用。

## 本次更新

### 修复

- 修复从 A 电脑导出的备份恢复到 B 电脑后，因旧用户目录不存在或无权限，导致智能助手工作目录创建失败的问题。
- 修复跨电脑恢复后官方智能助手无法使用的问题。
- 修复跨电脑恢复后微信接入复用旧内部路径，导致会话无法正常启动的问题。
- 修复恢复数据中附件、消息块、话题、笔记链接等内部路径仍指向旧电脑的问题。

### 优化

- 备份恢复完成后自动迁移应用内部 `Data` 路径，无需用户手动修改数据库。
- 智能助手启动时增加路径自愈，即使旧数据里仍残留历史内部路径，也会映射到当前电脑的数据目录。
- 路径迁移兼容 Windows、macOS/Linux、JSON 转义路径和 `file://` 链接。

## 重要说明

- 本次迁移只处理 Zen AI / Cherry Studio 应用内部 `Data` 目录路径。
- 用户外部文件夹、微信临时文件、下载目录、文档目录等路径不会被自动改写。
- 已经遇到该问题的用户，可以先清除本机错误恢复的数据，安装新版本后再重新恢复旧备份。

## 验证情况

本次发版前已完成：

- `npx vitest run packages/shared/__tests__/internalDataPathMigration.test.ts --project shared src/main/services/__tests__/BackupManager.test.ts --project main`
- `npm run validate:release`

`validate:release` 已覆盖 OpenAPI 检查、Node/Web release typecheck 和 Electron 生产构建。

## 已知非阻塞项

- 构建日志中仍存在 Vite/Rolldown 依赖兼容 warning，以及第三方依赖 direct eval warning；这些是既有构建提示，不影响本次版本发布。
