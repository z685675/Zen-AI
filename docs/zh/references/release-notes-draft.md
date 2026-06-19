# Zen AI v1.1.54 发布文案草稿

## 发布摘要

Zen AI `v1.1.54` 现已发布。本次版本是 `v1.1.53` 的热修复，重点解决导入备份后自动重启、随后应用无法打开的问题。

## 本次更新

### 修复

- 修复导入备份后，恢复路径迁移在大型历史消息上耗时过高，导致启动阶段卡死、窗口无法打开的问题。
- 修复恢复后没有新的 `.restore` 标记时，启动流程仍重复扫描 `agents.db` 和笔记文件的问题。

### 优化

- 内部路径迁移增加快速候选判断，普通大文本会直接跳过，不再进入路径正则替换。
- 内部路径迁移增加完成标记，迁移成功后后续启动不再重复执行。
- 路径匹配规则进一步收窄，只处理明确属于 Zen AI / Cherry Studio 应用内部 `Data` 目录的路径。

## 重要说明

- 已经安装 `v1.1.53` 并遇到无法启动的用户，安装 `v1.1.54` 后再次启动即可继续完成迁移。
- 本次迁移仍不会改写用户外部文件夹、微信临时文件、下载目录、文档目录等路径。

## 验证情况

本次发版前已完成：

- 使用真实恢复后的 `agents.db` 做只读迁移性能验证：159 条消息内容约 10MB，扫描耗时约 61ms。
- `npx vitest run packages/shared/__tests__/internalDataPathMigration.test.ts --project shared src/main/services/__tests__/BackupManager.test.ts --project main`

## 已知非阻塞项

- 构建日志中仍存在 Vite/Rolldown 依赖兼容 warning，以及第三方依赖 direct eval warning；这些是既有构建提示，不影响本次版本发布。
