/**
 * 消息转换模块
 * 将 Cherry Studio 消息格式转换为 AI SDK 消息格式
 */

import type { ReasoningPart } from '@ai-sdk/provider-utils'
import { loggerService } from '@logger'
import { isVisionModel } from '@renderer/config/models'
import { FILE_TYPE, type Message, type Model } from '@renderer/types'
import type {
  FileMessageBlock,
  ImageMessageBlock,
  MainTextMessageBlock,
  ThinkingMessageBlock
} from '@renderer/types/newMessage'
import {
  findFileBlocks,
  findImageBlocks,
  findMainTextBlocks,
  findThinkingBlocks,
  getMainTextContent
} from '@renderer/utils/messageUtils/find'
import { parseDataUrl } from '@shared/utils'
import type {
  AssistantModelMessage,
  FilePart,
  ImagePart,
  ModelMessage,
  SystemModelMessage,
  TextPart,
  UserModelMessage
} from 'ai'
import i18n from 'i18next'

import { convertEmbeddedImagesToParts, convertFileBlockToFilePart, convertFileBlockToTextPart } from './fileProcessor'

const logger = loggerService.withContext('messageConverter')
const MAX_DIRECT_DOCUMENT_VISUAL_PARTS = 12

type DocumentVisualBudget = {
  remaining: number
}

/**
 * 转换消息为 AI SDK 参数格式
 * 基于 OpenAI 格式的通用转换，支持文本、图片和文件
 */
export async function convertMessageToSdkParam(
  message: Message,
  isVisionModel = false,
  model?: Model,
  includeDocumentVisuals = true,
  documentVisualBudget?: DocumentVisualBudget
): Promise<ModelMessage | ModelMessage[]> {
  const content = getMainTextContent(message)
  const fileBlocks = findFileBlocks(message)
  const imageBlocks = findImageBlocks(message)
  const reasoningBlocks = findThinkingBlocks(message)
  const mainTextBlocks = findMainTextBlocks(message)
  if (message.role === 'user' || message.role === 'system') {
    return convertMessageToUserModelMessage(
      content,
      fileBlocks,
      imageBlocks,
      isVisionModel,
      model,
      includeDocumentVisuals,
      documentVisualBudget
    )
  } else {
    return convertMessageToAssistantModelMessage(
      content,
      fileBlocks,
      imageBlocks,
      reasoningBlocks,
      mainTextBlocks,
      model
    )
  }
}

async function convertImageBlockToImagePart(imageBlocks: ImageMessageBlock[]): Promise<Array<ImagePart>> {
  const parts: Array<ImagePart> = []
  for (const imageBlock of imageBlocks) {
    if (imageBlock.file) {
      try {
        const ext = imageBlock.file.ext.startsWith('.') ? imageBlock.file.ext : `.${imageBlock.file.ext}`
        const image = await window.api.file.base64Image(imageBlock.file.id + ext)
        parts.push({
          type: 'image',
          image: image.base64,
          mediaType: image.mime
        })
      } catch (error) {
        logger.error('Failed to load image file, image will be excluded from message:', {
          fileId: imageBlock.file.id,
          fileName: imageBlock.file.origin_name,
          error: error as Error
        })
      }
    } else if (imageBlock.url) {
      const url = imageBlock.url
      const parseResult = parseDataUrl(url)
      if (parseResult?.isBase64) {
        const { mediaType, data } = parseResult
        parts.push({ type: 'image', image: data, ...(mediaType ? { mediaType } : {}) })
      } else if (url.startsWith('data:')) {
        // Malformed data URL or non-base64 data URL
        logger.error('Malformed or non-base64 data URL detected, image will be excluded:', {
          urlPrefix: url.slice(0, 50) + '...'
        })
        continue
      } else {
        // For remote URLs we keep payload minimal to match existing expectations.
        parts.push({ type: 'image', image: url })
      }
    }
  }
  return parts
}

/**
 * 转换为用户模型消息
 */
async function convertMessageToUserModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  isVisionModel = false,
  model?: Model,
  includeDocumentVisuals = true,
  documentVisualBudget?: DocumentVisualBudget
): Promise<UserModelMessage | (UserModelMessage | SystemModelMessage)[]> {
  const parts: Array<TextPart | FilePart | ImagePart> = []
  const fileReferenceInstructions: string[] = []
  if (content) {
    parts.push({ type: 'text', text: content })
  }

  // 处理图片（仅在支持视觉的模型中）
  if (isVisionModel) {
    parts.push(...(await convertImageBlockToImagePart(imageBlocks)))
  }
  // 处理文件
  for (const fileBlock of fileBlocks) {
    const file = fileBlock.file
    let processed = false

    // 优先尝试原生文件支持（PDF、图片等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        // 判断filePart是否为string
        if (typeof filePart.data === 'string' && filePart.data.startsWith('fileid://')) {
          // Keep processing the remaining attachments. Previously the first
          // remote file reference caused an early return and silently dropped
          // every file after it.
          fileReferenceInstructions.push(filePart.data)
        } else {
          parts.push(filePart)
        }
        logger.debug(`File ${file.origin_name} processed as native file format`)
        processed = true
      }
    }

    // A scanned PDF (or an Office file containing only visual content) may
    // have no extractable text. If page/embedded images are available, that
    // is still a valid multimodal attachment and should not show a failure
    // toast to the user.
    const documentVisualParts =
      includeDocumentVisuals && (!processed || file.ext.toLowerCase() !== '.pdf')
        ? await convertEmbeddedImagesToParts(fileBlock, model, {
            maxImages: documentVisualBudget?.remaining,
            query: content
          })
        : []
    if (documentVisualBudget) {
      documentVisualBudget.remaining = Math.max(
        0,
        documentVisualBudget.remaining - documentVisualParts.filter((part) => part.type === 'image').length
      )
    }

    // 如果原生处理失败，回退到文本提取
    if (!processed) {
      const textPart = await convertFileBlockToTextPart(fileBlock)
      if (textPart) {
        parts.push(textPart)
        logger.debug(`File ${file.origin_name} processed as text content`)
      } else if (file.type === FILE_TYPE.IMAGE) {
        // A learned vision-capability failure must not turn an otherwise valid
        // image attachment into a file-processing error. Keep a durable
        // textual marker so the request can continue through OCR/context
        // retrieval or a provider fallback without claiming the file is broken.
        parts.push({
          type: 'text',
          text: `[图片附件：${file.origin_name}；当前模型或渠道不支持视觉输入，图片内容未直接发送]`
        })
      } else if (documentVisualParts.length === 0) {
        logger.warn(`File ${file.origin_name} could not be processed in any format`)
        window.toast.error(i18n.t('message.error.file.process_failed', { name: file.origin_name }))
      } else {
        logger.info(`File ${file.origin_name} processed as visual-only attachment`)
      }
    }

    // Native PDF-capable providers already receive the original PDF. For
    // non-native routes the helper supplies page screenshots, preserving
    // tables and layout without duplicating a native PDF payload.
    parts.push(...documentVisualParts)
  }

  const userMessage: UserModelMessage = {
    role: 'user',
    content: parts
  }

  if (fileReferenceInstructions.length === 0) {
    return userMessage
  }

  return [
    ...fileReferenceInstructions.map<SystemModelMessage>((content) => ({
      role: 'system',
      content
    })),
    userMessage
  ]
}

/**
 * Replaces markdown images with data URI sources (e.g. `![alt](data:image/...;base64,...)`)
 * with a placeholder `![alt](image)` to avoid sending huge base64 payloads to the API.
 *
 * Uses string scanning (indexOf) instead of regex to avoid OOM on multi-MB base64 strings.
 */
export function stripMarkdownBase64Images(text: string): string {
  const marker = '](data:'
  let result = ''
  let searchFrom = 0

  while (searchFrom < text.length) {
    const markerIdx = text.indexOf(marker, searchFrom)
    if (markerIdx === -1) {
      result += text.slice(searchFrom)
      break
    }

    // Find the `![` that starts this markdown image — walk backwards from `](`
    const bangIdx = text.lastIndexOf('![', markerIdx)
    if (bangIdx === -1 || text.indexOf(']', bangIdx + 2) !== markerIdx) {
      // Not a valid markdown image — skip past this marker
      result += text.slice(searchFrom, markerIdx + marker.length)
      searchFrom = markerIdx + marker.length
      continue
    }

    // Find the closing `)` — the URL part starts after `](`
    const urlStart = markerIdx + 2 // position right after `](`
    const closeIdx = text.indexOf(')', urlStart)
    if (closeIdx === -1) {
      result += text.slice(searchFrom)
      break
    }

    // Extract alt text between `![` and `]`
    const altText = text.slice(bangIdx + 2, markerIdx)

    // Append everything before `![` plus the replacement
    result += text.slice(searchFrom, bangIdx) + `![${altText}](image)`
    searchFrom = closeIdx + 1
  }

  return result
}

/**
 * 转换为助手模型消息
 * 注意：当助手消息只包含图片（如图片生成模型的响应）而没有文本时，
 * 需要添加占位文本，因为某些 API（如 Gemini）不接受空的 assistant 消息
 */
async function convertMessageToAssistantModelMessage(
  content: string,
  fileBlocks: FileMessageBlock[],
  imageBlocks: ImageMessageBlock[],
  thinkingBlocks: ThinkingMessageBlock[],
  mainTextBlocks: MainTextMessageBlock[],
  model?: Model
): Promise<AssistantModelMessage> {
  const parts: Array<TextPart | ReasoningPart | FilePart> = []

  // Add reasoning blocks first (required by AWS Bedrock for Claude extended thinking)
  for (const thinkingBlock of thinkingBlocks) {
    parts.push({ type: 'reasoning', text: thinkingBlock.content })
  }

  // Add text content after reasoning blocks, only if non-empty after trimming
  // Also add thoughtSignature from MainTextBlock metadata for Gemini thought signature persistence
  // Strip inline base64 data URIs from markdown images to prevent HTTP 413 errors (#12602)
  // Uses string scanning instead of regex to avoid OOM on large base64 payloads
  const trimmedContent = stripMarkdownBase64Images(content?.trim() ?? '')
  if (trimmedContent) {
    // Find the first MainTextBlock with thoughtSignature
    const thoughtSignature = mainTextBlocks.find((block) => block.metadata?.thoughtSignature)?.metadata
      ?.thoughtSignature

    const textPart: TextPart = { type: 'text', text: trimmedContent }

    // Add providerOptions with thoughtSignature if available (for Gemini)
    if (thoughtSignature) {
      textPart.providerOptions = {
        google: {
          thoughtSignature
        }
      }
    }

    parts.push(textPart)
  }

  for (const fileBlock of fileBlocks) {
    // 优先尝试原生文件支持（PDF等）
    if (model) {
      const filePart = await convertFileBlockToFilePart(fileBlock, model)
      if (filePart) {
        parts.push(filePart)
        continue
      }
    }

    // 回退到文本处理
    const textPart = await convertFileBlockToTextPart(fileBlock)
    if (textPart) {
      parts.push(textPart)
    }
  }

  // 当 parts 为空但有图片时，添加占位文本
  // 这对于图片生成模型的继续对话很重要，因为助手消息可能只包含生成的图片
  if (parts.length === 0 && imageBlocks.length > 0) {
    parts.push({ type: 'text', text: '[Image]' })
  }

  return {
    role: 'assistant',
    content: parts
  }
}

/**
 * Converts an array of messages to SDK-compatible model messages.
 *
 * This function processes messages and transforms them into the format required by the SDK.
 * It handles special cases for vision models and image enhancement models.
 *
 * @param messages - Array of messages to convert.
 * @param model - The model configuration that determines conversion behavior
 *
 * @returns A promise that resolves to an array of SDK-compatible model messages
 *
 * @remarks
 * For image enhancement models:
 * - Collapses the conversation into [system?, user(image)] format
 * - Searches backwards through all messages to find the most recent assistant message with images
 * - Preserves all system messages (including ones generated from file uploads like 'fileid://...')
 * - Extracts the last user message content and merges images from the previous assistant message
 * - Returns only the collapsed messages: system messages (if any) followed by a single user message
 * - If no user message is found, returns only system messages
 * - Typical pattern: [system?, user, assistant(image), user] -> [system?, user(image)]
 *
 * For other models:
 * - Returns all converted messages in order without special image handling
 *
 * The function automatically detects vision model capabilities and adjusts conversion accordingly.
 */
export async function convertMessagesToSdkMessages(messages: Message[], model: Model): Promise<ModelMessage[]> {
  const sdkMessages: ModelMessage[] = []
  const isVision = isVisionModel(model)
  const documentVisualBudget: DocumentVisualBudget = { remaining: MAX_DIRECT_DOCUMENT_VISUAL_PARTS }

  // Convert the newest messages first so a follow-up can still inspect the
  // most recent workbook/PDF when older turns contain many embedded images.
  // The converted messages are emitted in their original order below.
  const convertedByMessageId = new Map<string, ModelMessage[]>()
  for (const message of [...messages].reverse()) {
    // Keep visual evidence attached to every historical user message. The
    // previous implementation only sent embedded document images and PDF
    // page screenshots from the latest user message, so a follow-up such as
    // “what did the chart in the file above mean?” lost the chart entirely.
    // Context compaction still protects the request budget; compacted history
    // is represented by structured text and visual checkpoint evidence.
    const sdkMessage = await convertMessageToSdkParam(message, isVision, model, true, documentVisualBudget)
    convertedByMessageId.set(message.id, Array.isArray(sdkMessage) ? sdkMessage : [sdkMessage])
  }
  for (const message of messages) {
    sdkMessages.push(...(convertedByMessageId.get(message.id) ?? []))
  }
  // Special handling for vison models
  // These models support multi-turn conversations but need images from previous assistant messages
  // to be merged into the current user message for editing/enhancement operations.
  //
  // Key behaviors:
  // 1. Preserve all conversation history for context
  // 2. Find images from the previous assistant message and merge them into the last user message
  // 3. This allows users to switch from LLM conversations and use that context for image generation
  if (isVision) {
    // Find the last user SDK message index
    const lastUserSdkIndex = (() => {
      for (let i = sdkMessages.length - 1; i >= 0; i--) {
        if (sdkMessages[i].role === 'user') return i
      }
      return -1
    })()

    // If no user message found, return messages as-is
    if (lastUserSdkIndex < 0) {
      return sdkMessages
    }

    // Find the nearest preceding assistant message in original messages
    let prevAssistant: Message | null = null
    for (let i = messages.length - 2; i >= 0; i--) {
      if (messages[i].role === 'assistant') {
        prevAssistant = messages[i]
        break
      }
    }

    // Check if there are images from the previous assistant message
    const imageBlocks = prevAssistant ? findImageBlocks(prevAssistant) : []
    const imageParts = await convertImageBlockToImagePart(imageBlocks)

    // If no images to merge, return messages as-is
    if (imageParts.length === 0) {
      return sdkMessages
    }

    // Build the new last user message with merged images
    const lastUserSdk = sdkMessages[lastUserSdkIndex] as UserModelMessage
    let finalUserParts: Array<TextPart | FilePart | ImagePart> = []

    if (typeof lastUserSdk.content === 'string') {
      finalUserParts.push({ type: 'text', text: lastUserSdk.content })
    } else if (Array.isArray(lastUserSdk.content)) {
      finalUserParts = [...lastUserSdk.content]
    }

    // Append images from the previous assistant message
    finalUserParts.push(...imageParts)

    // Replace the last user message with the merged version
    const result = [...sdkMessages]
    result[lastUserSdkIndex] = { role: 'user', content: finalUserParts }

    return result
  }

  return sdkMessages
}

/**
 * Rebuilds a conversation without native file or image parts.
 *
 * This is deliberately separate from the normal conversion path. It is used
 * only after a provider explicitly rejects multimodal input, so PDF/Office
 * files still have a chance to be understood through local structured text
 * extraction instead of replaying the same failing request.
 */
export async function convertMessagesToTextOnlyMessages(messages: Message[]): Promise<ModelMessage[]> {
  return convertMessagesToTextOnlyMessagesWithOptions(messages)
}

export async function convertMessagesToTextOnlyMessagesWithOptions(
  messages: Message[],
  options: {
    resolveImageText?: (imageBlock: ImageMessageBlock, message: Message) => Promise<string | undefined>
  } = {}
): Promise<ModelMessage[]> {
  const converted: ModelMessage[] = []

  for (const message of messages) {
    const sdkMessage = await convertMessageToSdkParam(message, false, undefined, false)
    const sdkMessages = Array.isArray(sdkMessage) ? sdkMessage : [sdkMessage]
    const imageBlocks = findImageBlocks(message)

    if (imageBlocks.length === 0) {
      converted.push(...sdkMessages)
      continue
    }

    const imageNames = imageBlocks.map((block, index) => block.file?.origin_name || `图片 ${index + 1}`).join('、')
    const resolvedImageText = options.resolveImageText
      ? (await Promise.all(imageBlocks.map((block) => options.resolveImageText?.(block, message)))).filter(
          (text): text is string => !!text?.trim()
        )
      : []
    const marker: TextPart = {
      type: 'text',
      text: [
        `[图片附件：${imageNames}；当前请求已回退为文字模式，图片原始内容未发送]`,
        ...(resolvedImageText.length > 0 ? [`OCR 文字参考：\n${resolvedImageText.join('\n\n')}`] : [])
      ].join('\n')
    }
    const lastMessage = sdkMessages.at(-1)
    if (lastMessage && Array.isArray(lastMessage.content)) {
      const updatedMessage = {
        ...lastMessage,
        content: [...lastMessage.content, marker]
      } as ModelMessage
      converted.push(...sdkMessages.slice(0, -1), updatedMessage)
      continue
    } else if (lastMessage) {
      converted.push(...sdkMessages.slice(0, -1), { ...lastMessage, content: [marker] } as ModelMessage)
      continue
    }
    converted.push(...sdkMessages)
  }

  return converted
}
