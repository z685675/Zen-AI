import { getErrorMessage } from '.'

export function getFriendlyPaintingErrorMessage(error: unknown): string {
  const rawMessage = getErrorMessage(error).trim()
  const message = rawMessage.toLowerCase()

  if (!rawMessage) {
    return '图片生成失败，请稍后重试，或切换模型/服务商再试。'
  }

  if (message.includes('context_too_large') || message.includes('context window') || message.includes('too large')) {
    return '这次提交的内容太多了。请缩短提示词、减少参考图片，或换一个更简单的描述后再生成。'
  }

  if (message.includes('abort') || message.includes('cancel')) {
    return '图片生成已取消。'
  }

  if (
    message.includes('401') ||
    message.includes('403') ||
    message.includes('unauthorized') ||
    message.includes('forbidden')
  ) {
    return '图片生成服务暂时不可用。请检查当前服务商的 API Key、余额或模型权限。'
  }

  if (
    message.includes('429') ||
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('insufficient')
  ) {
    return '图片生成服务当前额度不足或请求太频繁。请稍后重试，或切换其他服务商/模型。'
  }

  if (message.includes('timeout') || message.includes('timed out')) {
    return '图片生成等待超时。请稍后重试，或换一个更稳定的服务商。'
  }

  if (message.includes('network') || message.includes('fetch failed') || message.includes('connection')) {
    return '图片生成服务连接失败。请检查网络，或稍后再试。'
  }

  if (rawMessage.startsWith('API Error:')) {
    return '图片生成服务返回失败。请稍后重试，或切换模型/服务商。'
  }

  return rawMessage
}
