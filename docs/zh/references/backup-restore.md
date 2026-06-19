# 备份恢复与内部路径迁移

Zen AI 的备份中可能包含应用内部数据路径，例如：

- `Data/Agents`
- `Data/Files`
- `Data/Notes`
- 智能助手会话、消息元数据、任务日志中的内部文件链接

当用户把 A 电脑的备份恢复到 B 电脑时，两个系统用户名或用户数据目录可能不同。旧路径如果直接沿用，会导致智能助手尝试在不存在或无权限的旧用户目录下创建工作目录，进而出现官方智能助手、微信接入等功能无法使用的问题。

## 迁移策略

恢复流程完成 `.restore` 目录替换后，主进程会立即迁移已恢复数据中的应用内部路径：

- `agents.db` 中的智能助手、会话、消息、定时任务和任务日志文本字段
- `Data/Notes` 下 Markdown 文件中的内部链接
- 智能助手运行时读取到的 `accessible_paths`

迁移完成后会在 `Data` 目录写入 `.internal-path-migration-v1` 标记。没有新的恢复任务时，启动流程不会重复扫描数据库和笔记文件，避免大体量历史会话拖慢启动。

渲染进程启动后还会执行本地数据库和持久化状态迁移：

- IndexedDB `files`
- IndexedDB `message_blocks`
- IndexedDB `topics`
- Redux persist 中的内部笔记路径

## 迁移边界

迁移只处理应用内部 `Data` 目录路径。以下路径不会被改写：

- 用户自己选择的外部文件夹
- 微信、浏览器、下载目录等第三方或系统目录
- 不属于 Zen AI / Cherry Studio 应用数据目录的路径

这样可以修复跨电脑恢复后的内部路径失效问题，同时避免误改用户真实文件位置。

## 覆盖格式

路径迁移覆盖以下常见格式：

- Windows 反斜杠路径：`C:\Users\old\AppData\Roaming\zen-ai\Data\...`
- Windows 斜杠路径：`C:/Users/old/AppData/Roaming/zen-ai/Data/...`
- JSON 转义路径：`C:\\Users\\old\\AppData\\Roaming\\zen-ai\\Data\\...`
- `file://` 链接
- macOS/Linux 风格路径

迁移实现会先判断文本中是否同时包含 `Data` 和已知应用数据目录名，再执行路径替换。这样可以快速跳过大型普通消息内容，避免在数 MB 级会话文本上进行不必要的正则扫描。

## 验证建议

发版前至少运行：

```bash
npx vitest run packages/shared/__tests__/internalDataPathMigration.test.ts --project shared src/main/services/__tests__/BackupManager.test.ts --project main
npm run validate:release
```
