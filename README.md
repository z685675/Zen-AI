# Zen AI

Zen AI 是基于 Cherry Studio [<sup>1</sup>](https://github.com/CherryHQ/cherry-studio) 开源代码构建的独立桌面 AI 工作空间项目，并按照 AGPL-3.0 [<sup>2</sup>](https://www.gnu.org/licenses/agpl-3.0.html) 协议发布。

## 项目状态

- **当前公开基线版本：** `v1.1.0`
- **支持平台：** 仅支持 Windows 和 macOS
- **macOS 安装包：**
  - `x64`：适用于 Intel 芯片 Mac
  - `arm64`：适用于 Apple Silicon 芯片 Mac
- **更新策略：** 不提供应用内自动更新，也不提供手动检查更新
- **分发方式：** GitHub 提供源码发布，完整安装包通过单独渠道分发
- **主要修改：**
  - 整体修改了主页面UI设计和工具按钮底色设计，添加了几个常用助手。
  - 修改了对话记录展示方式，不再和对话助手共用层级。更改切换对话助手和切换模型按钮位置。
  - 调整了一些初始默认设置，导航栏显示位置默认为左，调整了左侧导航菜单大小以及常用工具顺序。
<img width="1326" height="905" alt="image" src="https://github.com/user-attachments/assets/f490a807-6dd6-49e8-b7f7-a0f849dce039" />
<img width="1326" height="905" alt="image" src="https://github.com/user-attachments/assets/0bff1cc1-a7e9-4e02-a00b-c28fa40073c2" />


## 下载与升级

- **源码发布地址：** GitHub Releases [<sup>3</sup>](https://github.com/z685675/Zen-AI/releases)
- 安装包以完整包形式分发。升级、替换或重新安装前，请先关闭应用。
- 每一个已发布安装包都应对应一个 GitHub 标签版本与源码快照。

## 品牌与兼容性

- Zen AI 使用独立的应用标识、协议 Scheme 和本地数据目录。
- 设计目标是可与原版 Cherry Studio 在同一台设备上共存安装。
- 不会自动迁移或复用 Cherry Studio 的用户数据。

## 开源说明

- 本项目基于 Cherry Studio，并继续履行其对应发行版本所要求的开源义务。
- Zen AI 采用 AGPL-3.0 [<sup>2</sup>](https://www.gnu.org/licenses/agpl-3.0.html) 协议发布。
- 如果你分发修改后的二进制版本，必须同时提供对应的完整源代码。
- Zen AI 内置了未经修改的 HarmonyOS Sans 字体家族。重新分发时，请保留随附的字体许可证说明。

## 开发

### 安装依赖并启动开发环境

```bash
pnpm install
pnpm dev

Build commands:

- Windows: `pnpm build:win`, `pnpm build:win:x64`, `pnpm build:win:arm64`
- macOS: `pnpm build:mac`, `pnpm build:mac:x64`, `pnpm build:mac:arm64`
```
## 相关链接

- 仓库地址: <https://github.com/z685675/Zen-AI>
- 项目文档: <https://github.com/z685675/Zen-AI#readme>
- 问题反馈: <https://github.com/z685675/Zen-AI/issues/new/choose>
- 联系邮箱: <mailto:yewanzz@qq.com>
