# Zen AI 发版文案草稿

适用于 GitHub Release、网盘发布说明、群公告或频道更新通知。

## 标题

`Zen AI v[版本号]`

## 发布摘要

Zen AI `v[版本号]` 现已发布。

- 源码标签：`v[版本号]`
- 源码仓库：[https://github.com/z685675/Zen-AI](https://github.com/z685675/Zen-AI)
- 安装包：通过你的网盘或其它分发渠道单独提供
- 更新方式：当前为完整安装包覆盖安装，不提供应用内自动更新

## 本次更新

### 新增

- 图片页新增 `gpt-image-2` 系列能力适配，兼容 `gpt-image-2`、`gpt-image-2-pro`、`gpt-image-2-vip`
- 图片页新增更高分辨率预设，覆盖方图、横图、竖图，以及 2K / 3K / 4K 级常用尺寸
- 图片页新增智能 `Auto` 分辨率匹配，可根据提示词中的横版、竖版、方图、2K、3K、4K 等意图自动选择更合适的预设
- 图片参数区新增说明提示，补充分辨率、质量、敏感度、背景等关键选项的含义

### 优化

- 图片分辨率显示从纯数字改为更易理解的标签形式，例如“4K 横图 · 3840 x 2048”
- 图片提供商列表已收敛为“仅显示当前模型服务中已添加的 provider”，隐藏原先无关的默认模型提供商
- `gpt-image-2` 系列下按模型能力动态切换参数项，避免出现不适配的背景与尺寸选项
- 智能 `Auto` 增加了更稳妥的意图判断与冲突回退逻辑，减少横竖版识别错误
- 侧边栏中的“小程序”“代码工具”“助手库”改为默认隐藏，需要时可在设置中重新添加

### 修复

- 修复 macOS 端自动更新点击后无响应的问题，提升更新链路可用性
- 修复对话中 PDF 文件的读取兼容问题，减少附件解析失败场景
- 修复图片页在 provider 不存在或切换场景下的路由与状态兼容问题
- 修复图片页 `NewApiPage` 的 Hook 调用顺序问题，提升页面稳定性
- 修复部分测试辅助文件与基准测试文件的语法损坏问题，恢复完整检查链路
- 清理多语言中的技术占位前缀，避免发布后出现 `[to be translated]` 这类半成品提示

## 重点说明

- 本轮图片增强仅覆盖当前 OpenAI / NewApi 图片页，不扩展到其它图片 provider 页面
- `gpt-image-2` 系列下已隐藏透明背景等官方当前不支持的选项
- 智能 `Auto` 会优先根据提示词意图匹配预设；如果意图不明确或存在明显冲突，会自动回退到官方 `Auto`

## 验证情况

本次发版前已完成以下检查：

- `pnpm typecheck:web`
- `pnpm i18n:check`
- `pnpm test:renderer`
- `pnpm build:check`

图片页相关新增测试已通过：

- `src/renderer/src/pages/paintings/config/__tests__/NewApiConfig.test.ts`
- `src/renderer/src/pages/paintings/utils/__tests__/smartAutoSize.test.ts`

侧边栏默认隐藏相关检查已通过：

- `pnpm typecheck:web`
- `pnpm vitest run src/renderer/src/store/__tests__/sidebarIconsMigration.test.ts`

## 已知非阻塞项

- 当前仓库仍存在少量 lint warning，但无 error，不影响本次发布
- 全量测试中存在若干 obsolete snapshot 提示，但测试本身已通过
- 构建日志里仍有少量 Vite 依赖迁移建议，不影响当前版本使用

## 安装包命名示例

Windows

- `Zen-AI-[版本号]-x64-setup.exe`
- `Zen-AI-[版本号]-x64-portable.exe`（可选）

macOS

- `Zen-AI-[版本号]-arm64.dmg` 或 `.zip`
- `Zen-AI-[版本号]-x64.dmg` 或 `.zip`

## 升级说明

- 安装新版本前，请先关闭 Zen AI
- 现阶段请通过完整安装包手动升级
- 如需回滚，请保留上一版安装包

## 兼容性说明

- Zen AI 是基于 Cherry Studio 的独立品牌构建版本
- Zen AI 可与原版 Cherry Studio 共存
- Zen AI 不会自动迁移 Cherry Studio 的用户数据
