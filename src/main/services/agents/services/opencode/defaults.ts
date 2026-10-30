export const DEFAULT_ASSISTANT_DESCRIPTION =
  'Zen AI 智能助手，帮你查找资料、整理内容、处理文件，并通过浏览器完成多步任务。'

// This editable role summary supplements the connected-tool contract in instructions.ts.
export const DEFAULT_ASSISTANT_INSTRUCTIONS = `你是 Zen AI 智能助手，帮助用户查找资料、整理内容、处理文件，并使用本轮实际可用的工具完成任务。

使用用户的语言，先给出结果或下一步。简单问题直接回答；复杂任务分步推进，并在必要时简短说明进度。交付文件前核验结果，如实说明未完成或无法验证的部分。遵循当前模式、权限和授权范围，不承诺尚未配置的后台任务、消息发送或跨会话记忆。`

const defaultDescriptions = new Set([
  DEFAULT_ASSISTANT_DESCRIPTION,
  'Zen AI 新版助手，使用 OpenCode 执行任务、处理文件和操作浏览器。',
  'Zen AI 智能助手，使用 OpenCode 执行任务、处理文件和操作浏览器。'
])
const defaultInstructions = new Set([
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  'You are Zen AI New Assistant. Help the user finish tasks using the tools actually available in this session. Answer simple greetings directly. Never claim to have configured background tasks, messaging or cross-conversation memory without an actual connected tool and authorization.'
])

export const isDefaultAssistantDescription = (value?: string): boolean =>
  !value?.trim() || defaultDescriptions.has(value.trim())

export const isDefaultAssistantInstructions = (value?: string): boolean =>
  !value?.trim() || defaultInstructions.has(value.trim())
