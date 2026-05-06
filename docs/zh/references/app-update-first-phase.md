# Zen AI 第一阶段更新发布说明

本文档对应当前客户端已经实现的轻量更新方案：

- 应用启动后自动检查更新
- 设置页支持手动检查更新
- 发现新版本后弹出提示
- 点击按钮后跳转到下载页

当前阶段不包含：

- 应用内下载
- 自动安装
- 强制更新

## 1. 你需要准备什么

你只需要准备 3 个东西：

1. 一个固定公网根地址
2. 一个 `latest.json`
3. 一个下载页 `downloads.html`

推荐目录结构：

```text
https://your-domain.com/zen-ai/
├─ latest.json
├─ downloads.html
├─ Zen-AI-1.0.1-win-x64.exe
├─ Zen-AI-1.0.1-win-arm64.exe
├─ Zen-AI-1.0.1-macos-arm64.dmg
└─ Zen-AI-1.0.1-macos-x64.dmg
```

## 2. 客户端需要改哪里

客户端更新元数据地址常量在：

`packages/shared/config/constant.ts`

把下面这个值改成你的真实地址：

```ts
export const APP_UPDATE_METADATA_URL = 'https://your-domain.com/zen-ai/latest.json'
```

改完后重新打包即可。

## 3. `latest.json` 格式

示例：

```json
{
  "version": "1.0.1",
  "releaseDate": "2026-05-02",
  "releaseNotes": "修复对话页切换模型偶发崩溃，提升会话稳定性。",
  "downloadPage": "https://your-domain.com/zen-ai/downloads.html",
  "mandatory": false
}
```

字段说明：

- `version`：必须，标准 semver
- `releaseDate`：可选，给用户展示
- `releaseNotes`：可选，弹窗展示
- `downloadPage`：必须，点击更新后打开
- `mandatory`：保留字段，当前阶段不启用强制更新

## 4. 下载页要求

下载页不需要复杂。

只要满足下面几点就够：

- 页面可以长期访问
- 不要频繁改 URL
- 能清楚区分平台和架构
- 链接直接指向安装包文件

建议至少提供：

- Windows x64
- Windows arm64（如果你发）
- macOS Apple Silicon（如果你发）
- macOS Intel（如果你发）

## 5. 每次发版流程

推荐固定顺序：

1. 先上传新安装包
2. 再更新 `downloads.html`
3. 最后更新 `latest.json`

这样可以避免客户端先看到新版本，但下载页还没准备好。

## 6. 回滚建议

如果新版本有问题：

1. 先把 `latest.json` 里的 `version` 改回旧版本
2. 或者把 `downloadPage` 指回旧版下载页
3. 保留上一版安装包，方便用户手动回退

## 7. 本地自测建议

发版前至少测这几项：

- 本地版本低于远端版本时，会弹出更新提示
- 点击“前往下载”能正确打开下载页
- 本地与远端版本一致时，手动检查提示“已是最新版本”
- `latest.json` 地址不可访问时，应用不会崩溃
- `latest.json` 内容格式错误时，应用不会崩溃

## 8. 适合你的部署方式

如果你用飞牛 NAS 外链，建议：

- 单独建一个固定目录，例如 `/zen-ai/`
- 不要把版本号放到根目录名里
- 安装包文件名带版本号
- `latest.json` 和 `downloads.html` 始终保持固定文件名

这样客户端地址永远不用改。
