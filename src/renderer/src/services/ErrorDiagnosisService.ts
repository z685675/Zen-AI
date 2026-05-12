import { CHERRYAI_PROVIDER } from '@renderer/config/providers'
import { loggerService } from '@renderer/services/LoggerService'
import store from '@renderer/store'
import type { Model } from '@renderer/types'
import type { SerializedError } from '@renderer/types/error'

import { fetchGenerate, fetchModels } from './ApiService'

const logger = loggerService.withContext('ErrorDiagnosisService')

export interface DiagnosisStep {
  text: string
}

export interface DiagnosisResult {
  summary: string
  category: string
  explanation: string
  steps: DiagnosisStep[]
}

export interface DiagnosisContext {
  errorSource?: string
  providerName?: string
  modelId?: string
}

async function getCherryAiFreeModel(): Promise<Model | undefined> {
  try {
    const models = await fetchModels(CHERRYAI_PROVIDER)
    return models.length > 0 ? models[0] : undefined
  } catch {
    logger.warn('Failed to fetch CherryAI free models')
    return undefined
  }
}

async function buildModelsToTry(context?: DiagnosisContext): Promise<Model[]> {
  const defaultModel = store.getState().llm.defaultModel
  const models: Model[] = []

  // CherryAI free model as primary diagnosis model
  const cherryModel = await getCherryAiFreeModel()
  if (cherryModel) {
    models.push(cherryModel)
  }

  // User's default model as fallback (skip if same as failing model)
  if (defaultModel && defaultModel.id !== context?.modelId && !models.some((m) => m.id === defaultModel.id)) {
    models.push(defaultModel)
  }

  return models
}

function buildContextHint(errorInfo: Record<string, unknown>, context?: DiagnosisContext): string {
  const msg = String(errorInfo.message || '').toLowerCase()
  const status = Number(errorInfo.status) || 0
  const source = context?.errorSource || String(errorInfo.source || '')

  if (
    status === 401 ||
    status === 403 ||
    msg.includes('api_key') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden')
  ) {
    return `## 背景提示\n当前账号在使用所选模型时被拒绝。请使用中性的产品表达，例如：账号状态、可用额度、模型权限、服务地址。\n`
  }

  if (status === 429 || msg.includes('quota') || msg.includes('rate_limit') || msg.includes('insufficient')) {
    return `## 背景提示\n本次请求可能因为额度、账号限制或请求频率较高而被拒绝。请使用中性的产品表达，例如：账号状态、可用额度、请求频率。\n`
  }

  if (status === 404 || msg.includes('model_not_found') || msg.includes('model not found')) {
    const model = errorInfo.modelId || context?.modelId || 'unknown'
    return `## 背景提示\n模型 "${model}" 暂时无法使用。可能原因包括模型名称不可用、模型已关闭，或当前账号没有该模型权限。\n`
  }

  if (
    msg.includes('econnrefused') ||
    msg.includes('timeout') ||
    msg.includes('fetch failed') ||
    msg.includes('proxy') ||
    msg.includes('certificate')
  ) {
    return `## 背景提示\n当前设备未能稳定连接模型服务。常见原因包括网络不稳定、代理、VPN、DNS、防火墙或证书异常。\n`
  }

  if (msg.includes('mcp')) {
    return `## 背景提示\n本地工具服务出现异常。常见原因包括服务未启动、配置不正确或连接超时。\n`
  }

  if (msg.includes('embedding') || msg.includes('knowledge base')) {
    return `## 背景提示\n知识库或文档检索环节出现异常。常见原因包括文档解析、向量化或模型权限问题。\n`
  }

  return `## 背景提示\nZen AI 是一款 AI 对话应用。本次错误发生在 ${source || 'chat'} 环节。请使用中性的产品表达，避免暴露内部服务结构。\n`
}

function parseResponse(raw: string): DiagnosisResult {
  // Strip markdown code blocks if AI wraps response in ```json ... ```
  let cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '')

  // Try to extract JSON object if model returned extra text around it
  if (!cleaned.trimStart().startsWith('{')) {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
    if (jsonMatch) {
      cleaned = jsonMatch[0]
    }
  }

  const parsed = JSON.parse(cleaned) as DiagnosisResult

  if (!parsed.summary || !Array.isArray(parsed.steps)) {
    throw new Error('Invalid diagnosis response format')
  }

  return {
    summary: parsed.summary,
    category: parsed.category || 'unknown',
    explanation: parsed.explanation || parsed.summary,
    steps: parsed.steps.map((s) => ({ text: typeof s === 'string' ? s : s.text }))
  }
}

export async function diagnoseError(
  error: SerializedError,
  language: string,
  context?: DiagnosisContext
): Promise<DiagnosisResult> {
  const errorInfo: Record<string, unknown> = {
    name: error.name,
    message: error.message
  }

  const status = (error as Record<string, unknown>).statusCode ?? (error as Record<string, unknown>).status
  if (status) errorInfo.status = status

  if (context?.errorSource) errorInfo.source = context.errorSource
  if (context?.modelId) errorInfo.modelId = context.modelId

  const cause = (error as Record<string, unknown>).cause
  if (cause && typeof cause === 'string') {
    errorInfo.responseBody = cause.slice(0, 800)
  }

  const url = (error as Record<string, unknown>).url
  if (url && typeof url === 'string') {
    // Include API endpoint (strip query params for privacy)
    try {
      const parsed = new URL(url)
      errorInfo.endpoint = `${parsed.origin}${parsed.pathname}`
    } catch {
      // ignore invalid URLs
    }
  }

  // Build context hint based on error source
  const contextHint = buildContextHint(errorInfo, context)

  const prompt = `你是 Zen AI 的错误诊断助手。你的任务是根据错误信息，生成一份给普通用户和管理员都能看懂的诊断结果。
请使用 ${language} 输出。

${contextHint}
## 输出格式
只返回合法 JSON，不要返回 Markdown，不要返回代码块，不要添加 JSON 以外的解释文字：
{"summary":"one-line","category":"auth|quota|model|network|proxy|content|server|context_length|payload|stream|parse|mcp|knowledge|ocr|deprecated|unknown","explanation":"2-3 sentences why this happened","steps":[{"text":"step 1"},{"text":"step 2"}]}

## 写作规则
- 如果输出语言是中文，请使用自然、克制、用户能理解的中文产品表达。
- 不要暴露内部架构、商业结构或服务转发关系。
- 不要使用这些词：relay、upstream、channel、provider、proxy service、panel、Docker、container、trace id、上游、渠道、中转、面板、容器。
- 优先使用这些词：当前应用、当前设备、模型服务、服务地址、诊断编号、账号状态、可用额度、模型权限、网络、代理、VPN、响应超时、连接中断。
- 不要说“肯定是某原因”，要使用“可能、通常、常见原因”等概率表达。
- steps 给出 2 到 4 个具体操作建议，只在有帮助时提到模型名称。
- 不要输出网址、链接、重启建议，也不要让普通用户去抓日志。
- category 字段必须从给定枚举中选择，保持英文枚举值不翻译。

## 示例
输入：{"name":"APICallError","message":"unauthorized","status":401,"modelId":"gpt-4"}
输出：{"summary":"账号权限异常，当前账号暂时无法使用该模型","category":"auth","explanation":"模型服务拒绝了本次请求，常见原因是账号状态、可用额度或模型权限不满足要求。请联系管理员核对相关配置。","steps":[{"text":"确认当前账号状态是否正常"},{"text":"确认可用额度和模型权限是否覆盖所选模型"}]}`

  const content = JSON.stringify(errorInfo)

  const modelsToTry = await buildModelsToTry(context)
  let lastError: Error | null = null

  for (const model of modelsToTry) {
    try {
      const response = await fetchGenerate({ prompt, content, model })
      if (!response) {
        logger.warn(`Empty response from model ${model.id}, trying next`)
        lastError = new Error(`Empty response from model: ${model.id}`)
        continue
      }
      return parseResponse(response)
    } catch (err) {
      logger.warn(`Diagnosis failed with model ${model.id}`, err as Error)
      lastError = err as Error
      continue
    }
  }

  logger.error('All diagnosis models failed', lastError)
  throw lastError || new Error('All diagnosis models failed')
}

/**
 * Lightweight AI classification for errors that don't match any rule.
 * Returns a one-line summary in the user's language, or empty string on failure.
 */
export async function classifyErrorByAI(error: SerializedError, language: string): Promise<string> {
  const prompt = `你是 Zen AI 的错误诊断助手。请用 ${language} 将这个错误总结成一句普通用户能理解的话，最多 30 个词。只返回摘要文本，不要返回 JSON、Markdown、引号或额外解释。请使用中性的产品表达，不要出现这些词：relay、upstream、channel、provider、panel、Docker、container、trace id、上游、渠道、中转、面板、容器。`
  const content = `Error: ${error.name}: ${error.message}`

  const modelsToTry = await buildModelsToTry()

  for (const model of modelsToTry) {
    try {
      const response = await fetchGenerate({ prompt, content, model })
      if (response?.trim()) {
        return response.trim()
      }
    } catch {
      continue
    }
  }

  return ''
}
