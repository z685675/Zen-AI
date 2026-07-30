import type { Message, MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockType } from '@renderer/types/newMessage'

import { removeSpecialCharactersForTopicName, truncateText } from './naming'

const DEFAULT_AGENT_SESSION_NAMES = new Set([
  'unnamed',
  'untitled',
  'untitled conversation',
  '\u672a\u547d\u540d',
  '\u672a\u547d\u540d\u5bf9\u8bdd',
  '\u672a\u547d\u540d\u5c0d\u8a71'
])

const normalizePlaceholder = (value: string | null | undefined) => value?.trim().toLocaleLowerCase() ?? ''

export const isUnnamedAgentSessionName = (name: string | null | undefined, localizedPlaceholder?: string): boolean => {
  const normalizedName = normalizePlaceholder(name)
  if (!normalizedName) {
    return true
  }

  return (
    DEFAULT_AGENT_SESSION_NAMES.has(normalizedName) ||
    (!!localizedPlaceholder && normalizedName === normalizePlaceholder(localizedPlaceholder))
  )
}

export const normalizeAgentSessionTitle = (value: string, maxLength = 50): string => {
  const cleaned = removeSpecialCharactersForTopicName(value)
    .replace(/\s+/g, ' ')
    .replace(/^[`*_~]+|[`*_~]+$/g, '')
    .trim()

  return truncateText(cleaned, { minLength: 12, maxLength })
}

const getMessageBlocks = (message: Message, blocksById: Map<string, MessageBlock>) =>
  message.blocks.map((blockId) => blocksById.get(blockId)).filter((block): block is MessageBlock => !!block)

const getTextCandidate = (message: Message, blocksById: Map<string, MessageBlock>): string | null => {
  const text = getMessageBlocks(message, blocksById)
    .filter((block) => block.type === MessageBlockType.MAIN_TEXT)
    .map((block) => block.content)
    .join('\n')
    .trim()

  if (!text) {
    return null
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const firstMeaningfulLine = lines.find((line) => !/^\/[\w-]+$/.test(line)) ?? lines[0]

  if (!firstMeaningfulLine) {
    return null
  }

  const withoutPromptDecoration = firstMeaningfulLine
    .replace(/^```[\w-]*\s*/, '')
    .replace(/^\/[\w-]+\s+/, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+[.)]\s+/, '')
    .replace(/[*_`~]/g, '')
    .trim()

  return normalizeAgentSessionTitle(withoutPromptDecoration) || null
}

const getFileCandidate = (message: Message, blocksById: Map<string, MessageBlock>): string | null => {
  for (const block of getMessageBlocks(message, blocksById)) {
    if (block.type === MessageBlockType.FILE || block.type === MessageBlockType.IMAGE) {
      const fileName = block.file?.origin_name || block.file?.name
      if (fileName) {
        return normalizeAgentSessionTitle(fileName)
      }
    }

    if (block.type === MessageBlockType.VIDEO && block.filePath) {
      const fileName = block.filePath.split(/[\\/]/).pop()
      if (fileName) {
        return normalizeAgentSessionTitle(fileName)
      }
    }
  }

  return null
}

export const deriveAgentSessionFallbackTitle = ({
  messages,
  blocks,
  genericTitle
}: {
  messages: Message[]
  blocks: MessageBlock[]
  genericTitle?: string
}): string | null => {
  if (messages.length === 0) {
    return null
  }

  const blocksById = new Map(blocks.map((block) => [block.id, block]))
  const userMessages = messages.filter((message) => message.role === 'user')

  for (const message of userMessages) {
    const title = getTextCandidate(message, blocksById)
    if (title) {
      return title
    }
  }

  for (const message of userMessages) {
    const title = getFileCandidate(message, blocksById)
    if (title) {
      return title
    }
  }

  for (const message of messages) {
    const title = getTextCandidate(message, blocksById)
    if (title) {
      return title
    }
  }

  return genericTitle ? normalizeAgentSessionTitle(genericTitle) : null
}
