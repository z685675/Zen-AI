import FileManager from '@renderer/services/FileManager'
import type { FileMessageBlock, ImageMessageBlock } from '@renderer/types/newMessage'

export function getMessageAttachmentPath(block: FileMessageBlock | ImageMessageBlock): string {
  if (!block.file) return ''
  const metadata = block.metadata?.legacyContinuation as { copied_attachment?: boolean } | undefined
  return metadata?.copied_attachment === true ? block.file.path : FileManager.getFilePath(block.file)
}
