# Zen AI v1.1.57 发布文案草稿

## 发布摘要

Zen AI `v1.1.57` 现已准备发布。本次版本统一更新 Windows、macOS、安装包和托盘图标为圆角版本，让不同平台上的视觉风格更一致。

## 本次更新

### 优化

- macOS 应用图标改用圆角透明 PNG 源图生成，避免 Dock 和 Finder 中显示为过于方正的黑色底图。
- Windows 应用图标和安装包图标改为圆角版本，并覆盖 16、24、32、48、64、128、256 多尺寸。
- 托盘图标同步更新为圆角版本，和应用主图标保持一致。

### 维护

- 新增应用图标维护文档，说明各平台图标源文件、输出文件和生成命令。
- 简化图标生成脚本：直接使用人工导出的多尺寸 PNG，不再依赖自动缩放或图像处理库。

## 验证情况

本次发布前建议完成：

- `node --check scripts/build-installer-icon.js`
- `node --check scripts/build-mac-icon.js`
- `node scripts/build-installer-icon.js`
- `node scripts/build-mac-icon.js`
