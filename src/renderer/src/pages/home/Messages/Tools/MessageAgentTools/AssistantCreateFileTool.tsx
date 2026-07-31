import { formatFileSize } from '@renderer/utils/file'
import { Button, Tag, Tooltip } from 'antd'
import { FileText, FolderOpen, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { ClickableFilePath } from './ClickableFilePath'

export type AssistantFileResult = {
  status: 'created' | 'ready'
  path: string
  format?: string
  size?: number
  verified?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const normalizeStatus = (value: unknown, fallback: AssistantFileResult['status'] = 'ready') => {
  return value === 'created' || value === 'ready' ? value : fallback
}

const inferFormat = (filePath: string) => {
  const fileName = filePath.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? ''
  const extension = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() : undefined
  return extension || undefined
}

const collectJsonCandidates = (value: string) => {
  const candidates = new Set<string>()
  const trimmed = value.trim()
  if (trimmed) candidates.add(trimmed)

  for (const match of trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    if (match[1]?.trim()) candidates.add(match[1].trim())
  }

  for (const [open, close] of [
    ['{', '}'],
    ['[', ']']
  ] as const) {
    const start = trimmed.indexOf(open)
    const end = trimmed.lastIndexOf(close)
    if (start >= 0 && end > start) candidates.add(trimmed.slice(start, end + 1))
  }

  return [...candidates]
}

const parseDirectFile = (
  value: Record<string, unknown>,
  fallbackStatus: AssistantFileResult['status']
): AssistantFileResult | undefined => {
  const rawPath = value.path ?? value.file_path ?? value.filePath
  if (typeof rawPath !== 'string' || !rawPath.trim()) return undefined

  return {
    status: normalizeStatus(value.status, fallbackStatus),
    path: rawPath.trim(),
    format: typeof value.format === 'string' && value.format.trim() ? value.format.trim() : inferFormat(rawPath),
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined,
    verified: typeof value.verified === 'boolean' ? value.verified : undefined
  }
}

const collectAssistantFileResults = (
  value: unknown,
  results: AssistantFileResult[],
  fallbackStatus: AssistantFileResult['status'],
  depth: number,
  seen: Set<object>
) => {
  if (depth > 6 || value === null || value === undefined) return

  if (typeof value === 'string') {
    for (const candidate of collectJsonCandidates(value)) {
      try {
        collectAssistantFileResults(JSON.parse(candidate), results, fallbackStatus, depth + 1, seen)
      } catch {
        // Runtime wrappers may include status text around a JSON payload.
      }
    }
    return
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectAssistantFileResults(item, results, fallbackStatus, depth + 1, seen)
    }
    return
  }

  if (!isRecord(value) || seen.has(value)) return
  seen.add(value)

  const status = normalizeStatus(value.status, fallbackStatus)
  const directFile = parseDirectFile(value, status)
  if (directFile) results.push(directFile)

  for (const key of [
    'files',
    'outputs',
    'structuredContent',
    'structured_content',
    'result',
    'output',
    'data',
    'value'
  ]) {
    collectAssistantFileResults(value[key], results, status, depth + 1, seen)
  }

  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        collectAssistantFileResults(item.text, results, status, depth + 1, seen)
      }
    }
  }
}

export const parseAssistantFileResults = (response: unknown): AssistantFileResult[] => {
  const results: AssistantFileResult[] = []
  collectAssistantFileResults(response, results, 'ready', 0, new Set())

  const seenPaths = new Set<string>()
  return results.filter((result) => {
    const normalizedPath = result.path.replace(/\//g, '\\').toLowerCase()
    if (seenPaths.has(normalizedPath)) return false
    seenPaths.add(normalizedPath)
    return true
  })
}

export const parseAssistantCreateFileResult = (response: unknown): AssistantFileResult | undefined => {
  return parseAssistantFileResults(response)[0]
}

export const isAssistantFileOutputToolName = (toolName: string | undefined) => {
  if (!toolName) return false
  const normalized = toolName.trim().toLowerCase()
  return (
    normalized === 'create_file' ||
    normalized === 'present_files' ||
    normalized === 'assistant.create_file' ||
    normalized === 'assistant.present_files' ||
    normalized.endsWith('__assistant__create_file') ||
    normalized.endsWith('__assistant__present_files')
  )
}

const getFileName = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() ?? filePath
}

export function AssistantCreateFileTool({ response }: { response: unknown }) {
  const results = useMemo(() => parseAssistantFileResults(response), [response])

  if (results.length === 0) return null

  return (
    <FileCards>
      {results.map((result) => (
        <AssistantFileCard key={result.path} result={result} />
      ))}
    </FileCards>
  )
}

function AssistantFileCard({ result }: { result: AssistantFileResult }) {
  const { t } = useTranslation()
  const fileName = getFileName(result.path)
  const fileMeta = [result.format?.toUpperCase(), result.size !== undefined ? formatFileSize(result.size) : undefined]
    .filter(Boolean)
    .join(' | ')

  const handleOpenFile = () => {
    window.api.file.openPath(result.path).catch(() => {
      window.toast.error(t('chat.input.tools.open_file_error', { path: result.path }))
    })
  }

  const handleShowInFolder = () => {
    window.api.file.showInFolder(result.path).catch(() => {
      window.toast.error(t('chat.input.tools.file_not_found', { path: result.path }))
    })
  }

  return (
    <Card>
      <IconWrap>
        <FileText size={22} />
      </IconWrap>
      <Content>
        <HeaderRow>
          <Title>{t('message.tools.assistantCreateFile.title')}</Title>
          {result.verified && (
            <Tooltip title={t('message.tools.assistantCreateFile.verified')}>
              <Tag color="success" icon={<ShieldCheck size={12} />}>
                {t('message.tools.assistantCreateFile.verified')}
              </Tag>
            </Tooltip>
          )}
        </HeaderRow>
        <FileName>
          <ClickableFilePath path={result.path} displayName={fileName} />
        </FileName>
        {fileMeta && <Meta>{fileMeta}</Meta>}
        <PathLine title={result.path}>{result.path}</PathLine>
        <Actions>
          <Button type="primary" size="small" onClick={handleOpenFile}>
            {t('message.tools.assistantCreateFile.open_file')}
          </Button>
          <Button size="small" icon={<FolderOpen size={14} />} onClick={handleShowInFolder}>
            {t('message.tools.assistantCreateFile.open_folder')}
          </Button>
        </Actions>
      </Content>
    </Card>
  )
}

const FileCards = styled.div`
  display: grid;
  gap: 8px;
  width: min(680px, 100%);
`

const Card = styled.div`
  display: flex;
  gap: 12px;
  width: 100%;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: linear-gradient(135deg, var(--color-background), var(--color-background-soft));
`

const IconWrap = styled.div`
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 8px;
  color: var(--color-primary);
  background: color-mix(in srgb, var(--color-primary) 12%, transparent);
`

const Content = styled.div`
  min-width: 0;
  flex: 1;
`

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const Title = styled.div`
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
`

const FileName = styled.div`
  margin-top: 6px;
  font-size: 14px;
  font-weight: 500;
`

const Meta = styled.div`
  margin-top: 4px;
  color: var(--color-text-2);
  font-size: 12px;
`

const PathLine = styled.div`
  margin-top: 6px;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-3);
  font-size: 12px;
`

const Actions = styled.div`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
`
