import { defaultUrlTransform } from 'react-markdown'

import { localFilePath } from './localFileLink'

export function markdownUrlTransform(value: string, key: string, node: { tagName: string }): string {
  if (key === 'href' && node.tagName === 'a' && localFilePath(value)) return value
  if (value.startsWith('data:image/png') || value.startsWith('data:image/jpeg')) return value
  return defaultUrlTransform(value)
}
