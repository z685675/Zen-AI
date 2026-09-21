import { loggerService } from '@logger'

import { CdpBrowserController } from '../mcpServers/browser/controller'

const logger = loggerService.withContext('WebPageReaderService')
const DEFAULT_TIMEOUT_MS = 20_000
const USER_HANDOFF_TIMEOUT_MS = 15 * 60 * 1000
const MAX_READ_ATTEMPTS = 3
const MAX_CONTENT_CHARS = 80_000

export type WebPageReadResult = {
  url: string
  title: string
  content: string
}

function validateUrl(value: string): string {
  const trimmed = value.trim()
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new Error('网页地址格式不正确')
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('网页地址只支持 HTTP 或 HTTPS')
  }

  return parsed.toString()
}

function limitContent(content: string): string {
  if (content.length <= MAX_CONTENT_CHARS) return content
  return `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[网页内容过长，已截取前 ${MAX_CONTENT_CHARS} 个字符]`
}

export class WebPageReaderService {
  private readonly controller = new CdpBrowserController({ maxWindows: 1 })
  private readQueue: Promise<unknown> = Promise.resolve()

  public read(url: string): Promise<WebPageReadResult> {
    const task = this.readQueue.then(() => this.readInternal(url))
    this.readQueue = task.catch(() => undefined)
    return task
  }

  private async readInternal(rawUrl: string): Promise<WebPageReadResult> {
    const url = validateUrl(rawUrl)
    let lastActionMessage = ''

    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt += 1) {
      const result = await this.controller.fetch(url, 'markdown', DEFAULT_TIMEOUT_MS, false, false, false)
      const userAction = this.controller.getUserAction(false, result.tabId)

      if (!userAction) {
        const content = typeof result.content === 'string' ? result.content.trim() : JSON.stringify(result.content)
        if (!content) throw new Error('网页没有可读取的正文内容')
        return {
          url,
          title: this.controller.getTabTitle(false, result.tabId) || url,
          content: limitContent(content)
        }
      }

      lastActionMessage = userAction.message
      logger.info('Web page reading requires user handoff', {
        url,
        reason: userAction.reason,
        tabId: result.tabId,
        attempt: attempt + 1
      })

      const handoff = await this.controller.waitForUser(
        userAction.message,
        userAction.reason,
        USER_HANDOFF_TIMEOUT_MS,
        false,
        result.tabId
      )
      if (handoff.status !== 'continued') {
        throw new Error('用户关闭了网页接管操作，暂时无法读取该网页')
      }
    }

    throw new Error(lastActionMessage || '网页仍需要用户完成验证，暂时无法读取')
  }

  public async close(): Promise<void> {
    await this.controller.reset()
  }
}

export const webPageReaderService = new WebPageReaderService()
