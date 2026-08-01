# Zen AI 托管 Python 与 OCR 能力方案

> 状态：在线镜像与离线运行时链路完成，进入三平台产物验收
> 更新日期：2026-08-01
> 适用范围：全部 Zen AI 用户、官方智能助手、Claude Code/Codex runtime、内置 Skill

## 1. 决策摘要

Zen AI 将 Python 和 OCR 作为所有用户都可用的基础能力，不按产品版本区分。

- Office 文件的稳定生成继续优先使用内置 Node 工具。
- 数据分析、复杂转换和 Skill Python 脚本使用 Zen AI 托管 CPython。
- 图片与扫描 PDF 的文字识别复用现有系统 OCR 和 Tesseract，不重复安装 Python OCR 引擎。
- Pyodide 保留为轻量浏览器沙箱，不承担本地文件和桌面任务。
- 用户系统 Python 只用于诊断和高级可选接入，默认不调用、不修改、不安装包。

## 2. 产品目标

1. 无论用户是否安装 Python，官方智能助手都获得一致的 Python 能力。
2. 不修改用户的系统 PATH、文件关联、Python 版本和全局包。
3. Claude Code 与 Codex 使用同一套 Python、OCR 和文件生成工具。
4. 常见数据任务首次准备后可直接执行，不在每次任务中临时试错。
5. OCR 默认本地运行，支持中文、英文图片和扫描 PDF。
6. Python 失败时返回单一、可诊断错误，不重复尝试多个命令并产生多张失败卡片。

## 3. 运行时分层

### 3.1 Node 内置工具

负责确定性、产品化能力：

- DOCX、XLSX、PPTX、PDF 创建
- Office/PDF 包结构校验
- 文件授权、路径检查和结果卡片
- 本地 OCR 调度

### 3.2 Zen AI 托管 CPython

使用 `uv` 下载固定的 CPython 3.12，并在 Zen AI 数据目录创建独立虚拟环境。

- Windows：`<userData>/runtimes/python/envs/productivity/Scripts/python.exe`
- macOS/Linux：`<userData>/runtimes/python/envs/productivity/bin/python`
- Python 安装、缓存、环境和包均位于 `<userData>/runtimes/python/`
- 通过绝对路径执行，不注册到 Windows，不写入用户 PATH
- Agent 子进程仅获得 Zen AI 运行时路径，不依赖系统 `python`、`python3` 或 `py`

首批生产力包：

- 数据：`numpy`、`pandas`、`openpyxl`、`xlsxwriter`、`matplotlib`
- 文档：`python-docx`、`python-pptx`、`pypdf`、`pymupdf`
- 图片：`pillow`

机器学习、深度学习和完整科学计算包本阶段不内置。

#### 3.2.1 下载与离线恢复链路

从下一版开始，Zen Python 按以下顺序准备，避免把 GitHub 作为中国境内用户唯一可用的下载源：

1. 从 Zen AI 官方下载站获取已经包含固定生产力包的完整运行时。
2. 官方运行时不可用时，通过阿里云和 USTC 的 `python-build-standalone` 镜像准备 CPython。
3. 国内镜像不可用时，回退到 GitHub 和 PyPI 官方源。
4. 所有在线方式均失败时，用户可在“设置 -> 智能助手环境”导入官方离线包。

官方运行时按能力配置版本命名，不随每个应用补丁版本改变：

- `Zen-AI-Python-Runtime-p1-windows-x64.zip`
- `Zen-AI-Python-Runtime-p1-macos-x64.zip`
- `Zen-AI-Python-Runtime-p1-macos-arm64.zip`

离线包包含平台、架构、Python 版本、依赖清单、文件数量、总大小和运行时树 SHA-256。导入时拒绝路径穿越、符号链接、加密条目和不匹配的平台包，在临时目录完成完整性检查与实际导入测试后才原子切换；失败时保留原有可用环境。

发布流水线在对应平台原生构建并验证三种运行时资产，先上传到 GitHub Release。Release 发布后，现有同步任务会将安装包和运行时包一起同步到 Zen AI 官方下载站。

### 3.3 Pyodide 沙箱

保留现有 Pyodide，用于不需要本地文件系统的轻量计算。它不作为托管 CPython 的回退，也不用于执行 Skill 文件夹中的脚本。

### 3.4 用户系统 Python

可在诊断页面展示，但默认不参与 Agent 路由。后续高级设置可以允许用户主动关联已有环境；Zen AI 不向该环境自动安装任何包。

## 4. OCR 方案

Zen AI 已包含系统 OCR、Tesseract、PaddleOCR 接口和 Intel OV OCR。官方助手新增统一 `ocr_file` 工具：

1. Windows/macOS 默认先使用系统 OCR。
2. 默认只加载简体中文和英文；繁体中文必须明确请求，避免简体内容混入繁体字。
3. 中英混排固定比较系统 OCR 与 Tesseract；其他内容在系统结果存在长文本无换行、异常汉字空格、英文粘连、孤立字符、无效字符或脚本不匹配时回退。
4. 普通候选都偏弱时追加一次高对比度 Tesseract；按内容完整度、引擎置信度、段落质量和目标语言脚本匹配综合择优。
5. 图片预处理会校正 EXIF 方向、展平透明背景、限制像素并适度放大小图；默认只做温和增强，避免损伤细小中文笔画。
6. 输出统一清理异常汉字间空格和控制字符，并保留识别引擎提供的换行、空行、段落顺序和 PDF 页码。
7. TXT/Markdown 只保证可读顺序与段落，不承诺复刻原图的字体、坐标、分栏或表格结构；精确版面恢复仍属于后续能力。
8. 工具返回每页质量分、引擎置信度、候选数和低可信页；质量不足时使用“带警告完成”，不静默宣称完全成功。
9. 图片直接识别；扫描 PDF 先按页渲染为临时 PNG，再逐页 OCR。
10. 默认限制页数和文件大小，避免单次任务占满内存；临时页面在任务结束后清理。

OCR 是所有用户可用的基础能力，但不要求通过 Python 实现。

## 5. Agent 工具与路由

官方助手统一获得以下工具：

- `mcp__assistant__create_file`：创建常见文件
- `mcp__assistant__python_execute`：运行数据处理 Python
- `mcp__assistant__ocr_file`：图片或扫描 PDF OCR
- `mcp__assistant__diagnose`：诊断运行时状态

Claude Code 继续使用进程内 MCP。Codex 通过 Zen AI 本地、鉴权的 Assistant MCP HTTP 端点接入同一 `AssistantServer`，避免两套工具行为分叉。

Skill 不再自行判断系统是否有 Python。执行顺序由产品能力决定：

1. Office 创建优先 `create_file`。
2. Python Skill 脚本使用 Zen AI 托管 `python`。
3. 数据分析使用 `python_execute`。
4. OCR 使用 `ocr_file`。
5. 不重复执行 `python`、`python3`、`py` 探测和失败回退。

## 6. 包安装策略

- 首次准备智能助手环境时安装固定生产力包。
- 包由 Zen AI 白名单和版本约束管理，不允许 Agent 直接提交任意 PyPI 包名。
- 后续按需包安装到独立环境并复用 `uv` 缓存。
- 下载失败不修改已有可用环境；环境准备使用临时目录或可重建目录。
- 诊断信息记录 Python 版本、环境路径、包配置版本和缺失包，不记录用户数据。

## 7. 权限与安全边界

- 托管 CPython 是原生进程，具备当前 Windows/macOS 用户权限；“私有”表示依赖隔离，不表示操作系统沙箱。
- 结构化文件和 OCR 工具必须校验 `accessible_paths`。
- `python_execute` 只允许将工作目录设置在授权目录中，使用清理后的环境变量，并设置执行时间与输出大小上限。
- 不向 Python 子进程传递 Provider API Key、Token 等应用凭据。
- 删除、覆盖和批量修改继续遵守智能助手现有确认与备份规则。
- 真正执行任意不可信代码的系统级沙箱属于后续安全阶段；当前工具定位为用户授权任务中的受控执行器。

## 8. 安装与升级

- 应用已有 `uv` 安装能力，托管 Python 复用该组件。
- 首次启动预检依次准备 Bun、UV、托管 Python；Windows 的 Git 仍保留单独确认逻辑。
- Python 环境采用版本目录，升级时可创建新环境并切换，失败后保留旧环境。
- 卸载 Zen AI 时可删除私有运行时，不影响用户系统 Python。

## 9. 本阶段验收标准

- 没有系统 Python 的电脑可以完成 Python 数据任务。
- 安装了系统 Python 的电脑仍默认使用 Zen AI 私有 CPython。
- Agent 不再向用户报告无意义的“先找不到 Python、随后改用 Node”。
- Claude Code 与 Codex 均能调用相同的 Python、OCR 和文件生成工具。
- 图片 OCR 和扫描 PDF OCR 可返回分页面文本及质量诊断；普通文章截图保留可读的换行和段落，不把长篇中英文内容压成一行，简体原文不大面积混入繁体字。
- PPT、Word、Excel 原有生成速度和质量不因 Python 环境初始化而回退。
- 环境检查页面能显示托管 Python 是否就绪，并支持重新准备。

## 10. 后续阶段

- 托管 Python 原生沙箱或低权限进程。
- 经审核的按需包目录与包下载进度。
- 表格结构识别、OCR 版面恢复和图片坐标结果。
- 用户主动关联现有 Python/Conda 环境。
- 机器学习和完整科学计算能力包。

## 11. 本轮实施结果

截至 2026-07-23，本阶段代码已经完成：

- 新增基于 `uv` 的私有 CPython 3.12 生命周期管理、固定生产力包和环境诊断。
- 智能助手启动预检与“助手环境”设置页均可准备或修复 Zen Python 运行时。
- Claude Code 与 Codex 共用 `python_execute`、`ocr_file`、`create_file` 和诊断工具。
- 图片 OCR 支持系统能力优先、中英混排双引擎比较、弱结果高对比度重试及简体中文脚本偏好；扫描 PDF 支持逐页渲染与识别。
- OCR 文本会清理异常汉字间空格和常见英文粘连风险，保留可用换行和段落，并返回逐页质量诊断；TXT/Markdown 不承担精确页面坐标还原。
- PPTX、DOCX、XLSX、PDF 及研究/写作类 Skill 已改用统一运行时约定，不再探测或修改系统 Python。
- Office 文件仍由内置 Node 生成器优先创建，Python 只承担数据处理和质量检查，不应拖慢普通生成路径。

用户验收步骤、完整提示词和预期结果统一维护在
[`agent-runtime-test-template.md`](./agent-runtime-test-template.md) 的“托管 Python 与 OCR”一节，不再另建第二份测试手册。
