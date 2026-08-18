# Zen AI 开发文档索引

> 更新日期：2026-08-11

本目录同时包含 Zen AI 自研功能文档和上游 Cherry Studio 通用文档。以下列表是 Zen AI 当前功能的维护入口；版本专项测试完成后保留为回归基线，不再冒充唯一的当前验收手册。

## 当前开发基线

| 模块 | 文档 | 状态 |
| --- | --- | --- |
| 智能助手、Auto Runtime、Skill 与定时任务 | [智能助手开发路线](./agent-runtime-roadmap.md) | 当前总路线 |
| 长上下文、文件与缓存 | [统一上下文引擎](./unified-context-engine.md) | 已实现，持续回归 |
| PPT、Word、Excel、PDF 与 Markdown | [生成文件全局质量设计](./generated-output-quality.md) | 已实现，持续优化 |
| 托管 Python 与 OCR | [托管 Python 与 OCR](./managed-python-and-ocr-runtime.md) | 已实现，三平台持续回归 |
| 深度研究 | [深度研究开发方案](./deep-research-development-plan.md) | 已实现，持续优化 |
| 实时搜索 | [实时搜索方案](./ai-chat-realtime-search-roadmap.md) | 已实现，持续优化 |

## 专项验收

| 范围 | 文档 | 用途 |
| --- | --- | --- |
| Skill 导入与个人定时助手 | [专项验收手册](./personal-skill-and-scheduler-test.md) | 当前发布回归 |
| 网页访问与登录接管 | [专项验收手册](./agent-runtime-test-template.md) | 浏览器能力回归 |
| 长上下文、缓存与大文件 | [专项验收手册](./unified-context-engine-test-plan.md) | 历史完整基线，可按需复验 |

## 维护约定

- 总体架构和产品边界写入开发基线文档，具体操作步骤写入专项验收文档。
- 已取消或未上线的方案不保留独立路线图、验收手册和测试代码。
- 版本号只写在版本专项验收文档中；长期设计文档使用“已实现、持续优化、暂缓”描述状态。
- 新增文档前先确认现有文档不能承载该内容，避免同一功能出现多份互相冲突的说明。
