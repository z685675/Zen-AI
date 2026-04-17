# Zen AI

Zen AI 是基于 Cherry Studio 开源代码二次开发的独立品牌桌面 AI 工作台，遵循 AGPL-3.0 开源协议发布。

## 当前发布策略

- 平台范围：仅 Windows 和 macOS
- macOS 安装包：分别提供 Intel `x64` 和 Apple Silicon `arm64`
- 更新方式：不提供应用内自动更新，也不提供手动检查更新
- 分发方式：GitHub 对应源码版本 + 外部渠道分发完整安装包

## 下载与升级

- 源码发布页：<https://github.com/z685675/Zen-AI/releases>
- 安装包采用完整包分发，覆盖安装或重装前请先关闭应用
- 每一个对外发布的安装包都必须能在 GitHub 上找到对应 tag 和源码快照

## 品牌与兼容性

- Zen AI 使用独立的应用标识、协议名和本地数据目录
- 可以与原版 Cherry Studio 在同一台设备上共存安装
- 不会自动迁移或复用原版 Cherry Studio 的用户数据

## 开源说明

- 本项目基于 Cherry Studio 修改而来，并继续遵守原项目要求的开源义务
- Zen AI 使用 AGPL-3.0 发布
- 如果你继续分发修改后的二进制版本，也必须同时提供对应源码

## 开发

```bash
pnpm install
pnpm dev
```

构建命令：

- Windows：`pnpm build:win`、`pnpm build:win:x64`、`pnpm build:win:arm64`
- macOS：`pnpm build:mac`、`pnpm build:mac:x64`、`pnpm build:mac:arm64`

## 相关链接

- 仓库：<https://github.com/z685675/Zen-AI>
- 文档：<https://github.com/z685675/Zen-AI#readme>
- 反馈：<https://github.com/z685675/Zen-AI/issues/new/choose>
- 联系邮箱：<mailto:yewanzz@qq.com>
