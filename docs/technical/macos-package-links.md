# macOS 打包符号链接检查

## 背景

1.1.72 的 macOS Release 在 `codesign --verify --deep --strict` 阶段出现 `invalid destination for symbolic link in bundle`，Windows 打包成功。现有截图只确认 bundle 内存在不符合签名要求的链接，没有给出具体链接文件名；不能据此判断是某一个 SDK 或模型的问题。

依赖收集器会保留部分源目录相对链接；依赖被移动到 `app.asar.unpacked` 后，这些链接可能不再有效。1.1.73 在 `afterPack`、签名前处理应用资源链接并检查整个 bundle，不关闭签名或严格校验。

## 处理边界

- 原生 OpenCode 从平台包复制到专用资源目录运行。安装包不再包含不用的 `opencode-ai` CLI 包装层或 `node_modules/.bin` 入口；开发时仍可使用这些依赖。
- 将 `Contents/Resources` 中的有效链接转为实际文件/目录，保留文件内容和执行权限。
- 只允许复制当前 bundle 或项目 `node_modules`、`resources` 中的依赖。检查嵌套链接，拒绝越界、缺失或循环目标。
- 若 `app.asar.unpacked/node_modules` 中的相对链接因移动而失效，只从构建树查找同一依赖的同一路径，不猜测任意目标或静默删除。
- 保持 Electron 的合法相对 framework 链接；对整个 bundle 的绝对、越界、失效链接报出具体路径和目标。
- 只移除待替换的链接本身，不删除其原始目标；临时目录限制在当前 Resources 内。
- macOS Release 在真实 macOS 文件系统上先运行链接和 OpenCode 资源测试，再打包和签名。

## 本地验证限制

Windows 可验证目录 junction 的修复、源文件保留、安全边界和循环检测。真实 Unix 文件/相对链接测试由 macOS Release 执行；Windows 本地不等同于通过 macOS `codesign` 验收。
