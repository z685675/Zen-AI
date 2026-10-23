import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import type { FileMetadata } from '@types'

import type { FileMessageBlock } from '../../../../../renderer/src/types/newMessage'

/** Paths are already verified, owned copies; persist references, not another base64 copy. */
export function headlessAttachmentBlocks(
  files: FileMetadata[],
  messageId: string,
  createdAt: string
): FileMessageBlock[] {
  return files.map(
    (file, index) =>
      ({
        id: `${messageId}:attachment:${index}`,
        messageId,
        type: 'file',
        status: 'success',
        createdAt,
        file,
        metadata: { automationAttachment: { owned_copy: true } }
      }) as FileMessageBlock
  )
}

export const AUTOMATION_FILE_LIMIT = 20 * 1024 * 1024
export const AUTOMATION_BATCH_LIMIT = 40 * 1024 * 1024
export const AUTOMATION_FILE_COUNT = 6
const extensions = new Set([
  '.txt',
  '.md',
  '.csv',
  '.tsv',
  '.json',
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.doc',
  '.xls',
  '.ppt',
  '.png',
  '.jpg',
  '.jpeg',
  '.webp'
])

export async function verifiedAutomationFile(file: string, workspace: string) {
  const root = await fs.realpath(workspace)
  const canonical = await fs.realpath(file)
  const relative = path.relative(root, canonical)
  if (
    !relative ||
    relative.startsWith('..') ||
    path.isAbsolute(relative) ||
    relative.split(path.sep).some((part) => part.startsWith('.'))
  )
    throw new Error('automation_file_outside_workspace')
  const stat = await fs.stat(canonical)
  if (
    !stat.isFile() ||
    !stat.size ||
    stat.size > AUTOMATION_FILE_LIMIT ||
    !extensions.has(path.extname(canonical).toLowerCase())
  )
    throw new Error('automation_file_unsupported_or_large')
  const data = await fs.readFile(canonical)
  if (data.length !== stat.size) throw new Error('automation_file_changed')
  return { path: canonical, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }
}

/** A downloaded filename never selects a local path. Files get independent, non-overwriting names. */
export async function saveAutomationInput(workspace: string, filename: string, data: Buffer) {
  const extension = path.extname(filename.replaceAll('\\', '/')).toLowerCase()
  if (!extensions.has(extension) || !data.length || data.length > AUTOMATION_FILE_LIMIT)
    throw new Error('automation_file_unsupported_or_large')
  const signature = data.subarray(0, 8)
  if (['.docx', '.xlsx', '.pptx'].includes(extension) && signature.subarray(0, 2).toString() !== 'PK')
    throw new Error('automation_file_format_mismatch')
  if (extension === '.pdf' && data.subarray(0, 1024).indexOf('%PDF-') < 0)
    throw new Error('automation_file_format_mismatch')
  if (extension === '.png' && signature.toString('hex') !== '89504e470d0a1a0a')
    throw new Error('automation_file_format_mismatch')
  if (['.jpg', '.jpeg'].includes(extension) && signature.subarray(0, 3).toString('hex') !== 'ffd8ff')
    throw new Error('automation_file_format_mismatch')
  if (['.doc', '.xls', '.ppt'].includes(extension) && signature.toString('hex') !== 'd0cf11e0a1b11ae1')
    throw new Error('automation_file_format_mismatch')
  if (
    extension === '.webp' &&
    (data.subarray(0, 4).toString() !== 'RIFF' || data.subarray(8, 12).toString() !== 'WEBP')
  )
    throw new Error('automation_file_format_mismatch')
  const inputDir = path.join(workspace, 'inputs')
  await fs.mkdir(inputDir, { recursive: true })
  const realRoot = await fs.realpath(workspace)
  const realInput = await fs.realpath(inputDir)
  if (path.relative(realRoot, realInput) !== 'inputs') throw new Error('automation_input_directory_changed')
  const target = path.join(inputDir, `${randomUUID()}${extension}`)
  await fs.writeFile(target, data, { flag: 'wx', mode: 0o600 })
  await verifiedAutomationFile(target, workspace)
  return target
}

/** Only completed controlled output-tool records, never arbitrary model prose/paths. */
export function automationOutputPaths(blocks: Array<{ type?: string; metadata?: any }>): string[] {
  const results = new Set<string>()
  const visit = (value: any, depth = 0, inheritedStatus = '') => {
    if (!value || depth > 7) return
    if (typeof value === 'string') {
      try {
        visit(JSON.parse(value), depth + 1, inheritedStatus)
      } catch {
        /* Not structured output. */
      }
      return
    }
    if (Array.isArray(value)) {
      value.slice(0, 100).forEach((part) => visit(part, depth + 1, inheritedStatus))
      return
    }
    if (
      typeof value !== 'object' ||
      value.isError ||
      value.success === false ||
      ['error', 'failed'].includes(value.status)
    )
      return
    const file = value.path || value.file_path
    const status = value.status || inheritedStatus
    if (typeof file === 'string' && ['created', 'ready'].includes(status) && value.kind !== 'directory')
      results.add(file)
    for (const field of ['content', 'text', 'files', 'outputs', 'structuredContent', 'result', 'output', 'data'])
      visit(value[field], depth + 1, status)
  }
  for (const block of blocks) {
    const tool = block.metadata?.rawMcpToolResponse
    if (
      block.type === 'tool' &&
      tool?.status === 'done' &&
      /(?:^|__)(?:create_file|present_files)$/.test(tool.tool?.name || '')
    )
      visit(tool.response)
  }
  return [...results].slice(0, 64)
}

export function safeAutomationReply(text: string): string {
  return text
    .replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|private|opt)\/)[^\s<>"`]+/g, '[local file]')
    .replace(/(?:Bearer\s+|\bsk-)[A-Za-z0-9_.-]{12,}/gi, '[redacted]')
}
