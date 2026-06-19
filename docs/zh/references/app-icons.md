# 应用图标维护说明

Zen AI 的图标资源集中放在 `build/` 目录，用于 Windows、macOS、安装包、托盘和应用内展示。

## 源图要求

应用图标使用圆角透明 PNG。不要只用单张 1024 图自动缩放到全部尺寸；小尺寸图标需要单独导出，避免 Logo 过细、边缘发虚或显示不清。

需要维护的尺寸如下：

```text
build/icons/16x16.png
build/icons/24x24.png
build/icons/32x32.png
build/icons/48x48.png
build/icons/64x64.png
build/icons/128x128.png
build/icons/256x256.png
build/icons/512x512.png
build/icons/1024x1024.png
```

图标要求：

- PNG 格式。
- 文件尺寸必须和文件名一致。
- 背景圆角外侧应为透明像素。
- 16、24、32 这类小尺寸需要人工检查识别度。

## 输出文件

以下文件由源图同步或生成：

```text
build/icon.png
build/logo.png
build/icon-mac.png
build/icon.ico
build/installer-icon.ico
build/icon.icns
build/tray_icon.png
build/tray_icon_dark.png
build/tray_icon_light.png
```

其中：

- `build/icon.png`、`build/logo.png` 使用 1024 源图。
- `build/icon-mac.png` 是 macOS 专用 1024 源图。
- `build/icon.ico` 用于 Windows 应用图标。
- `build/installer-icon.ico` 用于 Windows 安装包图标。
- `build/icon.icns` 用于 macOS 应用图标。
- 托盘图标目前使用 64 源图同步生成。

## 生成命令

更新 `build/icons/` 下的 PNG 后，运行：

```bash
node scripts/build-installer-icon.js
node scripts/build-mac-icon.js
```

`build-installer-icon.js` 会直接使用已经准备好的 `16/24/32/48/64/128/256` PNG 生成 `.ico`，不会重新缩放。

`build-mac-icon.js` 会直接使用 `32/64/128/256/512/1024` PNG 写入 `.icns`，不会从单张 1024 图重新缩放。

## 发版前检查

发版前至少确认：

- `node --check scripts/build-installer-icon.js`
- `node --check scripts/build-mac-icon.js`
- `node scripts/build-installer-icon.js`
- `node scripts/build-mac-icon.js`
- `build/icon.ico` 包含 16、24、32、48、64、128、256 尺寸。
- `build/icon.icns` 包含 macOS 所需 icns chunk。
