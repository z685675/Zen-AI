const DEFAULT_PREVIEW_LENGTH = 180
const MAX_PREVIEW_SOURCE_LENGTH = 2000

export const formatMessageAnchorPreview = (content: string, maxLength: number = DEFAULT_PREVIEW_LENGTH): string => {
  const plainText = content
    .slice(0, MAX_PREVIEW_SOURCE_LENGTH)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_~`]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()

  if (plainText.length <= maxLength) return plainText
  if (maxLength <= 3) return '.'.repeat(Math.max(0, maxLength))
  return `${plainText.slice(0, maxLength - 3).trimEnd()}...`
}
