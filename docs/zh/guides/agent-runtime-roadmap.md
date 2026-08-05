# 智能助手 Auto Runtime 与内置 Skill 开发文档

> 状态：阶段 A 已通过验收；个人 Skill 导入与个人定时助手已完成首版实现，待专项实机验收
> 更新日期：2026-08-04
> 适用范围：个人电脑上的 Zen AI 官方智能助手
> 唯一验收入口：[智能助手当前版本验收手册](./agent-runtime-test-template.md)

## 1. 当前结论

本阶段不再把 Claude Code、Codex 或 Provider 类型暴露为普通用户必须理解的选项。产品行为统一为：

1. 用户选择可用模型和工作区。
2. Auto 根据接口协议、模型亲和度、运行时可用性和会话历史选择底层 Runtime；必要时自动使用 Zen AI 协议桥接。
3. Claude Code 与 Codex 共用会话、MCP、Skill、文件生成、Python 和 OCR 能力；Codex 额外接入受保护的内置浏览器 MCP，可处理公开网页和用户确认后的登录接管。
4. Office/PDF 文件优先由内置 Node 生成器创建，托管 Python 负责数据处理和质量校验。
5. 本阶段只面向个人本机使用；团队协作不进入当前实现和验收。

此前版本验收中发现的 Office 修复提示、Excel 图表、OCR 和 PPT 风格问题已完成修复。PPT 参考风格现已覆盖参考优先级、图片/图表节奏、明暗比例、构图密度、版式多样性和相似度交付校验；图像密集参考稿不能再以零图片文本稿通过。Codex 浏览器桥接、登录等待、深度研究计时保护、个人 Skill 导入和个人定时助手首版均已完成代码与自动测试，当前只需要按专项手册完成用户实机验收。

## 2. 产品边界

### 2.1 当前已经完成

| 能力 | 当前状态 |
| --- | --- |
| Auto Runtime | 已接入 Claude Code 与 Codex，普通用户不手动切换 |
| Provider 兼容 | Provider 类型、模型品牌、实际接口协议和 Runtime 已解耦；支持 Gemini、Grok 和 OpenAI-compatible 桥接 |
| 默认模型 | 官方助手的新对话优先使用 `gpt-5.6-luna`，已有会话保留自己的模型 |
| 工作区 | 支持多个授权目录，并可把任一目录设为当前工作区 |
| 会话体验 | 草稿按会话隔离、发送即保存、返回任务定位到最新内容 |
| 状态同步 | 处理、完成、失败和取消以最终消息状态收口，迟到事件被忽略 |
| 内置 Skill | 十个生产力 Skill 同时提供给两套 Runtime |
| 文件生成 | Markdown、PPTX、DOCX、XLSX、PDF 统一走可校验的产品工具 |
| Python | 所有用户可使用 Zen AI 私有 CPython 3.12 |
| OCR | 图片与扫描 PDF 默认使用本地 OCR，不要求外部 API |

### 2.2 后续路线，不属于当前验收

- 团队工作区、权限共享和多人任务协作。
- 任意 PyPI 包安装、机器学习能力包和用户 Conda 环境接入。
- OCR 表格重建、版面坐标恢复和高精度文档还原。
- PPT 同页多图片的指定 Shape 替换、SmartArt/动画编辑，以及从截图反推全部可编辑对象的像素级复刻；现阶段已支持原生 PPTX 母版/版式/文本占位符复用、指定页编辑副本、来源页视觉保持型克隆和每页主图片替换。
- 普通用户手动指定 Claude Code 或 Codex。

## 3. 总体架构

```text
用户选择模型与工作区
        |
        v
Auto Runtime Resolver
  |                         |
  v                         v
Claude Code               Codex
  |                         |
  +-- Anthropic 直连        +-- OpenAI Responses 直连
  |
  +-- Zen Protocol Bridge
      +-- Gemini API
      +-- xAI Chat
      +-- OpenAI Chat / Responses
  |
  +------------+------------+
               v
统一 Agent Stream / Session / Task 状态
           |
           +-- Assistant MCP：create_file / python_execute / ocr_file / diagnose
           +-- 内置 Skill：.claude/skills + .agents/skills
           +-- 工作区与 accessible_paths 权限
```

上层会话不直接处理两家 SDK 的原始事件。每个 Runtime 负责把文本、推理、工具调用、文件变更、错误、完成和取消转换为 Zen AI 统一事件。

## 4. Auto Runtime 设计

### 4.1 三个概念必须分离

- **Provider 类型**：普通 AI 对话使用的客户端适配器，例如 OpenAI、Anthropic 或 New API。
- **接口协议能力**：渠道实际支持 OpenAI Chat、OpenAI Responses、Anthropic Messages、Gemini API 或 xAI Chat 中的哪些协议。
- **Agent Runtime**：Claude Code 或 Codex 的任务编排、工具循环和上下文管理。

约束：

- `provider.type=openai` 不等于只能使用 Codex。
- 模型名称包含 Claude、GPT、Gemini 或 Grok 只能作为软偏好，不能替代显式协议事实。
- 协议能力未知时允许真实兼容性尝试；只有明确排除的协议才提前阻止。
- 用户不需要为了智能助手重新导入或修改既有 Provider。
- 不要求为 Gemini 或 Grok 单独集成 CLI；只要模型渠道支持对话和工具调用，就应至少存在一条可用 Agent 路径。

### 4.2 Auto 选择规则

1. 根据显式协议元数据和运行时健康状态生成候选列表。
2. Claude 系列模型软偏好 Claude Code，GPT/o/Codex 系列模型软偏好 Codex，Gemini/Grok 软偏好 Claude Code 的协议桥接路径。
3. 同一模型和会话优先沿用上次成功 Runtime。
4. 跨模型、跨 Provider 或跨 Runtime 时不复用异构 SDK 线程 ID。
5. Codex 本地 rollout 不存在且尚未产生输出时，自动新建线程重试一次。
6. Runtime 启动与模型生成分开计时：45 秒内没有任何初始化事件视为启动失败；已收到初始化事件的复杂工具任务最多等待 180 秒产生首个可见结果，避免把慢首字误判为卡死。

### 4.3 Fallback 边界

Auto 最多尝试一次备用 Runtime，并且只能发生在以下条件全部满足时：

- 还没有用户可见文本。
- 还没有工具调用或文件/MCP 副作用。
- 错误不是鉴权、余额、用户取消或明确配置错误。

Runtime 的启动事件在首个真实输出前暂存。首选失败并切换时丢弃暂存事件，确保一个任务只有一个开始状态、一个回复和一个最终错误结果。

每个 Runtime 尝试使用独立的中止控制器；切换候选前必须先终止旧尝试，不能让两个 Runtime 并行执行同一文件任务。Runtime 在没有正文、工具调用或其他可见结果时直接结束，必须作为失败处理，不能保存空白助手回复。

### 4.4 Runtime 落地

Claude Code：

- 兼容 Claude Agent SDK 旧版 `cli.js` 与新版平台原生 binary。
- 启动前执行依赖预检，错误立即返回，不再等待固定超时。
- 保留现有 Claude Code 会话、MCP 和工具能力。
- Anthropic Messages 渠道继续直连；OpenAI Chat/Responses、Gemini API 和 xAI Chat 渠道由本地桥接层转换消息、图片、工具定义、工具调用/结果、流式结束原因和用量。
- 桥接层支持 Claude Code `ToolSearch` 返回的 `tool_reference`，并对未来未知的工具结果内容执行可读的安全降级，不能因单个未识别内容块中断任务。
- 协议桥接只替换模型传输层，Claude Code 仍负责 Agent 循环、权限、Skill、工作区和会话，因此不是降级为普通聊天。

Codex：

- 使用 `@openai/codex-sdk` 与平台原生 Codex binary。
- 映射 OpenAI/OpenAI-compatible 渠道的 API Key、Base URL、模型和推理强度。
- 支持线程创建、恢复、取消、图片输入、MCP bridge 和工作区权限。
- 原生事件转换为统一 Agent Stream。

普通设置页不展示 Runtime 切换。开发诊断仍可通过受控环境变量强制指定底座，用于 A/B、故障定位和回滚。

## 5. 内置 Skill 体系

### 5.1 单一来源与双目录同步

内置 Skill 的唯一源目录是 `resources/skills`：

- Claude Code 工作区：`.claude/skills/<skill-name>`
- Codex 工作区：`.agents/skills/<skill-name>`

`BuiltinAgentProvisioner` 为源目录计算指纹。首次使用、旧工作区没有清单或任一内置 Skill 更新时，会同时刷新两套目录，避免 Runtime 读取到不同版本。

### 5.2 当前十个内置 Skill

| Skill | 职责 |
| --- | --- |
| `find-skills` | 先审计本地内置能力，再决定是否需要外部搜索 |
| `presentation-planner` | 规划演示结构、页面叙事和视觉意图 |
| `pptx` | 生成、修改、校验和有限修复 PPTX |
| `docx` | 生成正式 Word 文档并校验原生结构 |
| `xlsx` | 创建数据表、公式、图表、格式和经营看板 |
| `pdf` | 创建、读取、提取、OCR 和校验 PDF |
| `markdown` | 创建并校验 README、规范、知识库和结构化 Markdown 文档 |
| `research-report` | 建立证据矩阵，区分事实、推断与待验证项 |
| `content-writer-cn` | 公众号、小红书、短视频和中文营销写作 |
| `meeting-notes` | 提取决策、未决事项、行动项、负责人和日期 |

Skill 不是单纯 Prompt。根据任务需要，每个 Skill 可以包含：

- `SKILL.md` 工作流和质量标准。
- `scripts/` 结构化处理、检查或修复脚本。
- `references/` 版式、文档或业务模式参考。
- `assets/` 模板和可复用资源。
- `agents/openai.yaml` 等 Runtime 元数据。

### 5.3 Skill 运行约定

- Skill 名称是内部编排细节。用户只描述目标，官方助手根据 frontmatter 描述和任务上下文隐式选择一个或多个 Skill。
- 复杂交付物允许自动组合 Skill，例如演示规划加 PPTX、研究报告加 DOCX、中文写作加 DOCX；不得要求普通用户记忆 `$skill-name`。
- Office 文件优先调用 `mcp__assistant__create_file`。
- Skill 脚本只通过 `mcp__assistant__python_execute` 执行，不探测 `python`、`python3`、`py` 或 Conda。
- OCR 统一调用 `mcp__assistant__ocr_file`，不临时安装 OCR 包。
- 正常任务只生成一份最终文件；确定性结构缺陷最多修复一次，不能对相同输入无限重试。
- 完成前必须校验文件，不得把“PowerPoint/Word 可以自行修复”当成交付成功。

## 6. 文件生成质量设计

### 6.1 统一工具

`AssistantServer` 提供统一的 `create_file`，负责：

- 授权路径和输出扩展名检查。
- Markdown、PPTX、DOCX、XLSX、PDF 的确定性生成。
- 写入前统一验证非空内容、UTF-8/Markdown 基础结构、OOXML 必需部件/XML/内容类型/关系，以及 PDF 可解析性和页数。
- `verified` 返回具体检查项、警告和格式统计，不再只代表文件存在且非空。
- Claude Code/Codex 一致的参数和结果格式。

Office 文件的正常生成不依赖 Python 初始化。Python 只在数据分析、Skill 脚本和交付校验中使用，因此不会显著拖慢普通 PPT、Word 或 Excel 生成。

### 6.1.1 共享视觉风格系统

PPTX、DOCX、PDF 共用文档级风格语义，避免不同模型把所有任务都生成成蓝灰商务模板。`create_file` 新增：

- `visual_style`：显式视觉风格，普通自然语言任务可以省略。
- `document_type`：演示、报告、手册、白皮书、课件、画册等语义原型，辅助结构和风格推断。
- `style_mode`：`auto`、`light`、`dark`、`print`。
- `brand_theme`：可选品牌名与主色、辅色、强调色；只有用户提供真实品牌色时才使用。
- `pptx_style_reference`：可选参考 PPTX 或页面截图；PPTX 可指定 1-based `slide_number`，截图只提取近似视觉语言。
- `pptx_template`：可选 PPTX 模板或设计来源；`edit-copy` 修改完整副本中的指定页面，`new-deck` 从来源页面重组并复用原始母版/版式/主题/媒体/关系，`adaptive-design` 在来源结构不适合新内容时提取视觉语言并生成内容适配版式。

普通文档的风格解析优先级为：显式 `visual_style` > 标题、内容和 `document_type` 自动推断 > `corporate` 保守默认。使用 `pptx_style_reference` 时改为参考文件建议布局优先，忽略模型同时传入的主题推断型 `visual_style`，防止新主题把参考稿的编辑/品牌/自然构图覆盖成通用研究模板；显式非 `auto` 模式与用户逐项提供的真实品牌色仍可细化结果。工具结果和校验详情返回最终风格、中文标签、来源、模式、文档类型及参考类型/页码/置信度，便于定位模型是否正确触发。

当前共享 29 种风格：`executive`、`corporate`、`consulting`、`finance`、`government`、`legal`、`academic`、`research`、`technology`、`product`、`data`、`startup`、`sales`、`brand`、`editorial`、`education`、`children`、`training`、`healthcare`、`sustainability`、`culture`、`warm`、`premium`、`creative`、`bold`、`minimal-light`、`minimal-dark`、`monochrome`、`custom-brand`。

共享语义不等于三种格式强行同版：

- PPTX 使用封面构图、页面导轨、信息主次、留白、形状语言、背景/表面/文字色和三组协调色阶表达风格；风格切换必须改变几何结构与阅读顺序，不能只换配色。
- DOCX 始终保持明亮、可编辑、可打印，通过 Word 原生标题层级、字体、段落节奏、引用、代码和表格表达风格。
- PDF 属于固定版交付，可使用更强的页面背景、页边导轨、标题标记、引用面板和表格表头；`print` 保持灰度打印友好。

PPT 页面 `accent` 是显式单页覆盖项，不再由模板或 deck-spec 校验器自动轮换。普通任务省略 `accent`，让整套演示使用同一风格下的协调色阶；只有用户明确要求某页颜色时才设置。

### 6.2 PPTX

已完成：

- 支持多种页面布局、图表、流程、时间线、对比、指标和成熟商务版式。
- 支持文档级自动视觉风格，主题、布局语言、字体、背景、卡片、线条和强调色协同变化，不再固定为商务风。
- PPT 内部将共享风格归并为 14 类布局语言：企业叙事、高管决策、咨询排版、正式报告、技术、产品、数据、强视觉、品牌、编辑、活泼、人文自然、高端和极简。每类均拥有独立封面、页眉骨架、结论区、卡片/洞察/指标/对比/流程/时间线/图表/图片/总结构图。
- 演示的论证结构与视觉风格解耦：助手会根据受众和任务在简报、金字塔、叙事、教学、展示五种内部结构中自动选择，再独立解析视觉语言；用户无需记住结构名，也不会因为换了颜色或风格而改变论证顺序。
- `corporate` 默认路径已从等宽方框网格升级为主次分栏、编号行列、开放式结论和排版型指标；即使模型未显式传 `visual_style`，也不会回退到旧式“标题加几个色块”。
- 版式具有明确内容契约：指标页必须是紧凑数值，长概念自动降级为卡片或洞察；密集流程和时间线自动改用宽行路线图。
- 文本框默认启用边界内缩放，spec 校验同时限制标题、结论带、卡片、步骤和里程碑的内容容量，避免依赖极小字号承载长文。
- 生成或修改后的文件执行严格视觉结构校验：边界内文本必须使用 `normAutofit`，自定义脚本不得用会撑大形状的 `spAutoFit`，可见文本 run 必须显式设置字号。
- 自定义 PPT 生成或修改脚本除包结构校验外还必须渲染检查改动页；优先更新 deck spec 后通过稳定 Node 生成器重新生成。
- 交付校验阻止 `Key insight`、`Translate this number into a decision` 等生成器占位文案进入最终文件。
- 生成完整的主题、母版、版式及其关系，移除容易触发 PowerPoint 修复的无效 notes parts。
- 校验 ZIP 条目、内容类型、关系目标、关系 ID、页面与版式/母版连接、Shape ID、尺寸和母版文本样式。
- 对重复 Shape ID 等确定性 OOXML 问题允许生成一次修复副本并重新校验。
- 对缺失版式、母版或主题等结构性错误直接重新生成，不通过删除部件掩盖问题。
- 严格校验阻止危险外部关系、空页面、Unicode 替换字符和可见 Markdown 作者标记。
- `visual` 属于不会直接显示的内部设计方向字段；用户可见文案必须放入 `subtitle`、`takeaway` 或 `bullets`。真实图片使用统一 `assets` + `image_asset_id` 媒体资产契约，不得把文本提示当作已嵌入图片。
- 支持以授权目录内的 PPTX 或页面截图作为风格参考：PPTX 提取页面比例、主题字体、主辅色、明暗方向、图片页比例/覆盖率、图表节奏、文字密度、原生版式使用和视觉构图多样性，并归纳全幅摄影、摄影章节、图文、图表报告、密集报告和开放报告等页面原型。指定 `slide_number` 时仅由该页强调配色与字体，整套节奏仍汇总最多 30 页，不能由深色封面决定全稿模式。
- 参考 PPTX 主导输出布局语言，模型根据新主题自行猜测的 `visual_style` 不得覆盖参考方向；`visual` 仍只是内部设计意图，不能代替真实图片、图表或布局实现。
- 参考生成在写文件前执行媒体预检：图像密集参考稿必须为新主题准备语义相关的本地图片并通过 `assets` + `image_asset_id` 嵌入，不复用无关来源照片；同一张图片不得占据超过一半的图片页，也不能用不同 ID 重复包装同一文件来凑数量。
- 生成后执行 `pptx-reference-composition` 校验，返回 0-100 相似度等级以及参考/输出的图片页比例、图表页比例、版式多样性和明暗页比例；低于 70 分、图片节奏严重下降、版式多样性塌缩或明暗比例明显错误直接阻断，不再以警告形式交付。
- 截图参考在原始尺寸、角落背景和调色板之外，新增有效内容占比、视觉重心、左右/上下权重、边缘密度、纹理强度、摄影覆盖、构图偏向、留白节奏和表面处理分析；这些信号会直接参与布局语言和形状语言选择，不再只继承配色。截图仍属于近似参考，不会声称恢复字体、图标、精确坐标或母版。
- 截图参考生成后新增 `pptx-reference-design-language` 检查，比较成品与截图的构图偏向、空间节奏、装饰密度、表面处理、对齐、形状和对比策略；相似度偏低会要求检查构图与留白，而不是继续只换颜色。
- 原生模板路径与参考风格路径分离：`pptx_style_reference` 只做近似新建；`pptx_template` 复用来源 PPTX 的母版、版式、主题、媒体、图表和文本占位符，两者不能同时使用。
- 普通用户只需说明“参考哪份 PPTX、制作什么新主题”，该请求即视为完整需求。助手内部推断受众、故事线、页数、输出命名、媒体替换和校验策略，并根据新内容与来源版式的适配程度自动选择 `new-deck` 或 `adaptive-design`；只有明确的指定页修改使用 `edit-copy`。
- `inspect_pptx_template` 在规划前返回全稿配色策略、字体尺度、对齐、形状语言、信息密度、图片处理、构图偏向、空间节奏、装饰密度、表面处理和页面节奏，以及每页原型、列表/网格/分栏结构、条目容量、正文密度区间、图片要求和图表类型。助手先围绕新主题独立写故事线，再决定原生映射或自适应生成；模板只提供视觉语法，不再按来源页顺序或旧内容槽位机械替换。
- 原生 `new-deck` 会阻断高密度模板页被填成少量短句，要求助手内部补足证据、解读和行动，或改用更稀疏页面；`adaptive-design` 继续执行参考相似度、媒体比例、版式多样性和文字密度交付闸门，并明确不是原包复用。
- 原生模板文本采用角色、重复 Shape 群组和几何位置联合识别；通用文本框首项、年份标题、分栏标题/正文、语义图标、图表缓存与固定坐标轴均有专门保护。生成包完成 Notes 清理和 Office 兼容重打包，出现 PowerPoint 修复提示即视为失败。
- `edit-copy` 复制完整来源包后只修改指定页，未修改 slide XML 保持字节不变；`new-deck` 支持同一模板页重复使用、多母版/多版式和按来源页重组。
- 模板文本优先映射标准标题、副标题和正文占位符，也可按 Shape 名称、原文字或两者精确替换；改写保留原 Shape 几何与样式并启用有界缩放。为来源页提供 `image_asset_id` 时替换面积最大的图片关系，保留原图片 Shape 的位置、尺寸与裁切。
- `preserve_content` 可让 `new-deck` 不改写来源页 slide XML，实现 PPTX 来源页的视觉保持型克隆；不能与该页 `shape_replacements` 同时使用。
- 所有模板来源只读，输出始终创建为新文件。同页多图片的指定 Shape 替换、SmartArt/动画编辑和截图转可编辑对象仍不支持；不会通过把截图铺成背景冒充像素级可编辑克隆。

交付标准：PowerPoint 直接打开，不要求修复；页面不重叠、越界或明显错位；视觉上不是标题和项目符号的堆叠。

### 6.3 DOCX

已完成：

- 使用 Markdown 作为内部写作格式时，通过 `markdown-it` 转换为 Word 原生标题、粗体、斜体、链接、列表、引用、代码和表格。
- 共享视觉风格映射为 Word 原生标题样式、字体、强调线、引用底色、代码块和表格样式；深色风格在 Word 中自动转为明亮可编辑页面。
- 普通正文不再被 `normalizeRows()` 误转成单列表格，也不会在文末重复追加整份 Markdown 源稿。
- 校验关系、字段和文档结构，并阻止可见 `#`、`**`、代码围栏、Markdown 表格分隔线和疑似原始源稿表。
- 只有用户明确要求讲解或引用 Markdown 时才能使用 `--allow-markdown-literals`。
- 校验可见正文、原生标题段落、Unicode 替换字符和标题出现次数；长文没有任何原生标题时给出警告。
- Markdown-to-DOCX 路径支持统一媒体资产嵌入；普通外部 URL 或无对应资产的占位符不会被误报为真实图片。

交付标准：Word 直接打开，无修复/更新警告；标题只出现一次；格式是 Word 原生结构。

### 6.4 XLSX

已完成：

- 支持多工作表、公式、冻结窗格、筛选、数字格式、条件格式和图表。
- 数据分析可由托管 Python 完成，最终工作簿仍优先由 Node 生成器创建。
- 校验工作表数量、公式、图表、冻结、筛选、条件格式和包结构。
- 公式校验覆盖直接、间接、跨工作表及范围包含型循环引用，并在交付前给出具体循环路径。
- 图表根据分类数和总数据点自动控制数值标签；超过 8 个分类或 12 个数据点时关闭全量标签，严格校验会阻止密集数字覆盖坐标轴和图形。
- 周期值与累计值等量级差异明显的系列不使用带全量标签的并列柱形图；优先拆图或只呈现最能支持结论的趋势。
- 稳定 Node 生成器支持原生折线图，并按真实数据范围设置带留白的纵轴，使非零收入变化清晰可见。
- 对可确定的 `SUMIF`/`SUMIFS` 进行重算并核对缓存值，防止展示标签误作筛选键后在 Excel 重算时整张趋势图归零。
- 折线坐标轴支持正数、负数、混合值和常量序列；真实全零数据允许交付并提示确认业务含义，公式重算不一致仍然阻断。

交付标准：Excel 直接打开，无修复提示、外部链接和公式错误；趋势图能清晰表达真实变化，重算前后数据一致。

### 6.5 PDF

已完成：

- 支持可搜索的中文多页 PDF、标题、段落、有序/无序列表、引用、代码块和跨页表格。
- 共享视觉风格映射为页面背景/导轨、标题标记、引用与代码面板、表格配色和页脚；支持明亮、深色及灰度打印模式。
- 支持普通 PDF 文本提取与扫描 PDF OCR。
- 相同的显式标题与首个 H1 自动去重，Markdown 作者标记不会直接泄漏到页面。
- 生成后校验页数、文本、CJK 内容、危险动作、标题次数和 Markdown 泄漏。

交付标准：PDF 直接打开，中文可选择和搜索，无空白页、乱码或裁切。

### 6.6 Markdown

已完成：

- 新增 `markdown` 内置 Skill，覆盖 README、规范、知识库和结构化文本交付。
- `create_file` 写入前阻止无可见内容、非法控制字符、Unicode 替换字符、未闭合代码围栏、基础表格错误和危险链接。
- 严格校验器检查唯一 H1、标题层级、重复标题、表格列数和本地链接目标。

交付标准：UTF-8 正常、结构可渲染、代码围栏闭合、表格列数一致、本地资产链接有效。

### 6.7 工作区整洁

- `.claude` 和 `.agents` 是 Runtime 的正常内部目录。
- Skill 脚本从实际安装目录执行，不把 `scripts`、依赖和 `node_modules` 复制到用户工作区根目录。
- 用户交付文件写入指定位置；中间文件应放入任务临时目录并在结束后清理。

完整跨格式设计见 [智能助手生成文件全局质量设计](./generated-output-quality.md)。

## 7. 托管 Python 与 OCR

### 7.1 Zen AI 私有 CPython

- 使用 `uv` 准备固定的 CPython 3.12 和独立生产力环境。
- 环境位于 Zen AI 数据目录，通过绝对路径执行，不写系统 PATH、不修改文件关联。
- 用户电脑是否安装 Python，都默认使用同一套托管环境。
- 首批包包括 `numpy`、`pandas`、`openpyxl`、`xlsxwriter`、`matplotlib`、`python-docx`、`python-pptx`、`pypdf`、`pymupdf` 和 `pillow`。
- Agent 不允许向用户系统 Python 自动安装包。

### 7.2 Agent 工具

- `python_execute`：在授权工作目录执行数据处理代码或 Skill 脚本，限制运行时间和输出大小。
- `ocr_file`：识别授权目录中的图片或扫描 PDF。
- `diagnose`：返回托管环境、版本和缺失依赖，不返回用户凭据。

### 7.3 本地 OCR

1. Windows/macOS 优先使用系统 OCR。
2. 中英混排固定比较系统 OCR 与 Tesseract；其他内容仅在系统结果偏弱时回退，避免无意义增加耗时。
3. 默认语言为简体中文和英文；繁体中文仅在明确请求 `zh-tw` 时加载，避免简体结果混入繁体字。
4. 普通候选都偏弱时追加一次高对比度 Tesseract 识别，并按文本完整度、脚本匹配、置信度和段落质量择优。
5. 图片先校正 EXIF 方向、透明背景和小图分辨率，再使用温和增强；输入与输出像素都有上限。
6. 输出清理异常汉字间空格并保留可用换行、段落和页码；TXT/Markdown 不承诺精确坐标或表格版面还原。
7. 返回逐页质量分、候选数和低可信页。存在低可信页时状态为“带警告完成”，不能向用户宣称精确识别成功。
8. 扫描 PDF 先按页渲染，再按顺序识别并清理临时图片。
9. OCR 属于本地基础能力，不要求配置 API。

托管 CPython 是依赖隔离，不是操作系统沙箱。它仍以当前用户权限访问已授权文件；凭据和无关环境变量不会传入 Python 子进程。

## 8. 工作区与会话体验

### 8.1 工作区

- `accessible_paths` 第一项是当前工作区，设置页可将其他已授权目录设为当前。
- 删除、移动或从其他电脑恢复后失效的路径会在读取 Agent/Session 时自愈。
- 工作区变化不影响 Provider、模型列表或 Agent 模式。
- 至少保留一个授权目录，避免 Agent 进入无工作区状态。

### 8.2 会话

- 用户消息发出时先持久化会话，不等待模型首个输出。
- Agent 模型只定义新对话默认值；每个 Session 独立保存实际模型，Agent 更新和应用启动都不得批量覆盖历史会话。
- 普通 AI 对话同样按 Topic 保存模型快照；新建或复用空 Topic 时使用当前默认模型，已有内容的旧 Topic 在没有快照时继续沿用原 Assistant 模型。用户在首页切换当前 Topic 模型时，同时更新后续新对话的默认模型，但不得反向改写其他已有 Topic。
- 从旧版“修改 Agent 并同步全部会话”的模型语义迁移时，只执行一次新对话默认值校正；`gpt-5.6-luna` 可用时，覆盖默认助手、快速和翻译模型以及官方助手的新会话默认值，历史会话模型保持不变。迁移完成后，用户仍可再次手动修改默认值。
- 新建对话首页提供“本次对话模型”下拉，用户可在发送第一条消息前覆盖默认模型。
- 每次显式新建 AI 对话都从默认助手开始；用户在当前对话中手动切换助手角色只绑定当前 Topic，不得改变下一次新建对话的助手。
- 为避免堆积空会话而复用未发送会话时，先将其模型对齐当前 Agent 的新对话默认值，不能带入旧版遗留的 Claude 模型。
- 运行中的会话锁定模型选择；任务使用启动时读取的 Session 模型快照，其他会话切换模型不影响它。
- 有内容的会话在任务完成后必须自动生成话题名；优先使用快速模型总结，失败时从首条用户指令或附件名本地兜底，加载历史列表时自动补齐旧的“未命名”会话。
- 自动命名只处理空名称和系统占位名称，不覆盖用户手动编辑的话题名；标题生成在后台执行，不延长任务“正在处理”状态。
- 未发送草稿使用 `agentId + sessionId` 作为缓存键，不在不同会话或 Agent 间共享。
- 切换回运行中的任务时，滚动位置跟随最新消息和进度，不默认跳到对话顶部。
- SDK 线程只在 Provider、模型和 Runtime 兼容且上一轮成功时恢复。

### 8.3 状态与错误

- Stream chunk 串行处理，收到完成或错误后忽略所有迟到终止事件。
- 最终助手消息状态是任务状态栏的权威来源。
- 工具中途失败但任务成功恢复时，最终显示成功；任务失败时只显示一个最终错误。
- 完成、失败或取消后不继续显示“正在处理”。
- 相同错误不会因 Runtime、流处理和 UI 多层上报而重复生成多张卡片。

### 8.4 默认提示词

- AI 对话默认助手使用简洁、稳定的通用对话提示词，负责回答方式、上下文使用、文件理解、单次消息搜索语义、来源引用和事实可靠性，不承担智能助手的文件执行协议。新对话搜索默认关闭；用户点亮按钮后仅下一条新消息搜索，发送后自动关闭，历史消息重新生成不消费该状态。
- 默认提示词必须写入默认助手数据并在设置中可见、可编辑；运行时仍保留空值兜底，避免异常数据导致无系统提示词。
- 升级迁移只为提示词为空的默认助手补齐产品默认值，不覆盖用户已经编辑的自定义提示词。
- 智能助手使用更严格的产品托管执行提示词，覆盖 Skill 自动选择、工作区文件操作、生成文件校验、大文件分批处理、实时搜索与来源、失败恢复及高风险操作确认。
- 官方智能助手提示词在应用启动时刷新，并同步到既有 Session；Claude Code 与 Codex Runtime 都必须接收到相同的会话指令，Runtime 只补充各自的工具契约。

## 9. 安全与可靠性约束

- 所有本地文件、Python 和 OCR 操作都校验 `accessible_paths`。
- 删除、覆盖和批量修改既有文件继续遵守确认与备份规则。
- Codex MCP bearer token 和 Provider Key 使用受保护环境变量，用户自定义 env 不能覆盖。
- Python 子进程不获得 Provider API Key、Token 等应用凭据。
- Fallback 在产生副作用后严格禁止，避免重复写文件或重复调用工具。
- 诊断信息记录候选 Runtime、最终 Runtime、协议证据和错误阶段，但不要求普通用户理解底层术语。

## 10. 当前验证状态

自动化已覆盖：

- Auto resolver、协议能力、Grok/Gemini 路由、Anthropic 协议桥接、fallback guard 和跨 Runtime resume。
- Claude/Codex executable 解析、配置映射、事件转换和 MCP bridge。
- Skill 双目录 provision、旧工作区刷新和源指纹更新。
- Skill ZIP 路径安全校验、导入后的启停状态和工作区挂载路径。
- 定时任务的 cron/间隔/一次性计划校验、失败重试语义、任务恢复和运行日志。
- 会话草稿隔离、会话保存、流式终态和错误去重。
- Markdown、PPTX、DOCX、XLSX、PDF 生成与交付校验。
- 托管 Python、图片 OCR、扫描 PDF OCR 和 Tesseract worker 复用。
- Node/Renderer release typecheck、OpenAPI、i18n 和 `git diff --check`。
- Windows x64 unpacked 打包及 Claude/Codex、Skill、字体、托管 Python 安装脚本、系统 OCR 资源检查。

`v1.1.58` 发布收口复核结果：

- 主进程测试、渲染端 2516 条断言、AI Core 380 条断言、共享包 126 条断言和脚本 51 条断言均通过。
- Windows 上的大型 Vitest 进程在全部断言通过后仍可能以 `0xC0000005` 退出；这是测试运行器/原生依赖回收稳定性问题，需在正式发布前让 CI 命令得到稳定的零退出码。
- 严格硬编码扫描首次在 Windows 正常启动后发现历史累计文本与误报，普通 i18n 键一致性检查已通过；正式门禁需改为可维护的基线增量检查，不能直接把历史 177 条候选全部视为本轮回归。
- unpacked 包内 `package.json` 版本为 `1.1.58`，包含 Codex CLI `0.142.5`、Claude Code `2.1.81`、内置 Skill、Noto Sans CJK、系统 OCR 原生模块和托管 Python/UV 安装脚本。

人工验收统一执行 [智能助手当前版本验收手册](./agent-runtime-test-template.md)。旧的 2026-07-19 实机记录已合并进本文件，不再保留第二份测试入口。

## 11. 当前阶段门禁

| 模块 | 代码 | 自动测试 | 人工验收 |
| --- | --- | --- | --- |
| Auto Runtime 与模型兼容 | 完成 | 通过（含 Grok/Gemini 桥接与 Codex 浏览器桥接） | 默认 GPT + Auto 待本轮实机复验 |
| 工作区与会话体验 | 完成 | 通过 | 已完成主流程验收 |
| 状态、取消和错误去重 | 完成 | 通过 | 已完成主流程验收 |
| Skill 发现、导入与双目录同步 | 完成 | 通过 | 待专项实机验收 |
| 个人定时助手 | 完成 | 通过 | 待专项实机验收 |
| Markdown/PPTX/DOCX/XLSX/PDF | 完成 | 通过 | 主流程已验收；PPT 设计语言画像、模板密度门禁和自适应设计待候选包回归 |
| 中文写作、会议纪要、研究报告 | 完成 | 脚本校验通过 | 已完成主流程验收 |
| 托管 Python 与 OCR | 完成 | 通过 | 已完成主流程验收 |

只有统一手册和本专项手册中没有阻断问题，当前阶段才算完成。Office 文件要求修复、任务卡死、会话丢失、状态不收口、重复错误卡片、写入错误工作区、Skill 导入后无法启停或定时任务错误丢失，均为阻断问题。

## 12. 后续开发路线

### 阶段 A：当前能力验收与发布收口

1. 已完成默认 Auto + Codex 主路径的浏览器 MCP、登录接管、深度研究暂停与资源清理，并通过相关自动测试。
2. 已修复此前验收发现的阻断问题，并完成相关生成链路和 PPT 风格回归。
3. 按新版验收手册从空工作区执行普通对话、文件生成、搜索、深度研究和登录接管；不要求用户手动切换底层 Runtime 或在提示词里点名 Skill。
4. 收口 Windows Vitest 零退出码和硬编码文本增量基线，确保发布门禁可以稳定重复执行。
5. 提交或创建可回滚快照，生成并验证签名安装包后发布候选版本；候选包回归通过后转正式版本。

### 阶段 B：个人 Skill 导入（首版已实现）

首版实现范围：

- 从本地文件夹或 ZIP 导入结构化 Skill。
- 导入后可查看名称、说明、脚本、资源和文件内容；第三方 Skill 默认停用，需用户明确开启。
- 校验 `SKILL.md`、路径、脚本入口和依赖声明。
- 支持启用、停用、删除和更新时保留原有启用状态。
- 同一份 Skill 自动同步到 `.claude/skills` 与 `.agents/skills`。
- ZIP 拒绝绝对路径和目录穿越条目；不自动安装系统软件，不自动执行未知脚本。
- 每次 Agent 进入工作区时按当前启用状态同步，不能覆盖工作区中已有的真实 Skill 目录。

### 阶段 C：个人定时助手（首版已实现）

首版实现范围：

- 一次性、周期性和固定时间任务。
- 选择具备 Soul Mode 或 Bypass Permissions 的助手、工作区和任务提示词；任务沿用该助手的模型与 Auto Runtime。
- 支持一次性、周期性和 cron 计划，创建和编辑时校验计划，避免无效任务静默保存。
- 应用启动时恢复活动任务；应用关闭或电脑关机期间不执行，重新打开后按下一次计划继续调度，不伪造已执行结果。
- 支持手动立即执行、暂停、恢复、删除、最近结果、失败原因和运行日志，并可跳转到任务生成的会话。
- 周期任务遇到一次临时错误会继续重试，连续错误达到阈值后自动暂停；一次性任务失败会暂停并保留重试入口。
- 任务优先面向个人本机使用；外部频道订阅保留为已有兼容能力，不作为首版验收前置条件。
- 复用 Auto Runtime、Skill、权限和统一任务终态机制。

### 阶段 D：团队能力

团队工作区、共享凭据、多人权限和跨设备调度暂缓。当前客户端和文件都位于个人电脑，直接扩展团队能力会引入同步、授权和审计复杂度，需另立方案。

## 13. 关键决策记录

- 2026-07-06：保留 Claude Code，引入 Codex，采用双 Runtime 渐进改造。
- 2026-07-06：内置 Skill 同步到 `.claude/skills` 和 `.agents/skills`。
- 2026-07-18：普通用户界面收敛为 Auto-only。
- 2026-07-18：Provider 类型、实际协议和 Runtime 完全解耦。
- 2026-07-18：Fallback 仅允许在无输出、无副作用时执行一次。
- 2026-07-19：官方助手默认模型调整为 `gpt-5.6-luna`。
- 2026-07-19：Python 与 OCR 作为所有用户的基础能力，不区分版本。
- 2026-07-19：Office 优先使用稳定 Node 生成器，Python 负责分析和 Skill 校验。
- 2026-07-20：会话草稿、即时保存、返回滚动位置和任务状态统一修复。
- 2026-07-20：模型所有权调整为“Agent 提供新对话默认值、Session 保存实际模型”，并在新建对话首页增加模型选择。
- 2026-07-20：PPTX OOXML 与 DOCX 原生格式校验升级为交付阻断门槛。
- 2026-07-20：当前阶段通过统一验收后，下一优先级是个人 Skill 导入。
- 2026-07-21：内置 Skill 采用意图驱动的隐式编排，验收提示词除诊断项外不再点名 Skill。
- 2026-07-23：PPT、Word、PDF 统一采用受控本地图片资产契约，禁止把图片提示文字冒充真实媒体。
- 2026-07-23：PDF 默认执行页面截图检查；Office 严格模式可使用 LibreOffice 或本机 Microsoft Office 导出 PDF 验收，并明确区分通过与不可用。
- 2026-07-25：不新增 Gemini/Grok CLI；保留 Claude Code 与 Codex 双 Runtime，并增加本地 Anthropic Messages 协议桥接，使 Gemini、Grok 和仅支持 OpenAI Chat 的模型继续获得 Agent、工具与 Skill 能力。
- 2026-07-25：协议桥正式兼容 Claude Code `ToolSearch` 的 `tool_reference` 结果；未知工具结果采用安全文本降级，避免第三方模型在动态加载 Skill/工具后的下一轮请求被本地 500 中断。
- 2026-07-26：PPT 14 类布局语言深化到流程、时间线、图表和图片页；回归测试逐类校验构图签名、真实图片、Shape ID 与元素边界。
- 2026-07-26：新增原生 PPTX 模板引擎，支持编辑副本、按来源页重组、母版/版式/主题/媒体复用、标准占位符映射、来源页不改写克隆及保持原几何的主图片替换；截图到可编辑对象、多图片指定替换、SmartArt 和动画编辑继续保持明确边界。
- 2026-07-26：原生模板生成采用“最小自然语言请求即完整需求”的默认契约；用户只需提供模板和新主题，页面映射、素材替换、源文件保护、输出命名、交付校验及内部重试由助手自动完成。
- 2026-07-26：参考 PPTX 改为全稿节奏画像；代表封面不再污染整稿明暗模式。参考相似度低于 70、图片/版式/明暗节奏严重退化或重复图片过多时硬性阻断交付。
- 2026-07-27：原生 PPTX 模板新增规划前预检、自适应页面选择、重复槽位语义映射、图表缓存/坐标轴改写和 Office 兼容重打包；最小两句用户请求不再依赖额外工程化提示词。
- 2026-07-28：PPTX 参考/模板画像升级为可执行设计语言，新增逐页信息密度目标、`adaptive-design` 自动分流、版式/构图家族节奏门禁和渲染密度异常检查；来源结构不适合新主题时不再强行套页。
- 2026-07-28：吸收成熟 PPT Agent/Skill 的通用机制，将论证结构与视觉风格解耦；截图参考新增空间、纹理、摄影覆盖和构图重心分析，设计语言直接驱动布局选择，并增加截图参考相似度检查。
- 2026-07-30：修复 Grok 等协议桥模型在复杂 Agent 初始化期间被统一 45 秒首帧保护提前中止的问题；启动超时与首个可见结果超时分离，无输出时可安全终止当前候选并回退一次，所有候选失败时不再生成空白助手消息。
- 2026-07-31：AI 对话默认助手提示词改为可见、可编辑并通过迁移补齐历史空值；官方智能助手执行提示词同步升级，现有 Session 在启动时刷新，Claude Code 与 Codex 共享同一套产品行为约束。
- 2026-08-04：完成个人 Skill 导入首版：本地目录/ZIP 导入、第三方默认停用、双 Runtime 同步、启停、删除、更新状态保留和 ZIP 路径安全校验。
- 2026-08-04：完成个人定时助手首版：一次性/间隔/cron 调度、可恢复任务、手动执行、运行日志、失败重试和自动暂停。

## 14. 主要代码位置

- Runtime：`src/main/services/agents/services/runtime/`
- 协议桥接：`src/main/apiServer/services/anthropicProtocolBridge.ts`
- Claude Code：`src/main/services/agents/services/claudecode/`
- Codex：`src/main/services/agents/services/codex/`
- 会话执行：`src/main/services/agents/services/SessionMessageService.ts`
- Skill provision：`src/main/services/agents/services/builtin/BuiltinAgentProvisioner.ts`
- Assistant MCP：`src/main/mcpServers/assistant.ts`
- 图片资产：`src/main/mcpServers/assistantAssets.ts`
- PPTX 参考风格：`src/main/mcpServers/assistantPptxReference.ts`
- PPTX 原生模板：`src/main/mcpServers/assistantPptxTemplate.ts`
- DOCX 生成：`src/main/mcpServers/assistantDocx.ts`
- XLSX 生成：`src/main/mcpServers/assistantXlsx.ts`
- 交付校验：`src/main/mcpServers/assistantOutputValidation.ts`
- Office 渲染：`src/main/mcpServers/assistantOfficeRender.ts`
- 托管 Python：`src/main/services/python/`
- OCR：`src/main/services/ocr/`
- 内置 Skill：`resources/skills/`
- 会话 UI：`src/renderer/src/pages/agents/`
## 15. 生成文件质量能力补充（2026-07-23）

- `create_file` 已支持 PPTX、DOCX、PDF 的统一本地图片资产输入，路径权限、文件大小、总大小、像素量、重复 ID 和缺失引用均在生成前检查。
- PPT 图片使用内部媒体关系与专属 `image` 版式；Word 使用原生 `ImageRun`；PDF 使用内部图片对象，不依赖用户源文件的外部链接。
- PDF 已默认逐页或抽样渲染为位图，检查空白页和页面边缘内容。
- Office 渲染采用可降级策略：`auto` 优先 LibreOffice，`required` 在 Windows 上还可使用本机 Word/PowerPoint。渲染不可用与渲染通过是两个不同状态。
- 后续重点转向自定义生成器统一接入交付闸门，以及更可靠的视觉重叠和裁切识别。
