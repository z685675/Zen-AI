import { formatFileSize } from '@renderer/utils/file'
import { Button, Tag, Tooltip } from 'antd'
import { FileText, FolderOpen, ShieldCheck } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import { ClickableFilePath } from './ClickableFilePath'

type AssistantCreateFileResult = {
  status: 'created'
  path: string
  format?: string
  size?: number
  verified?: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const parseResultObject = (value: unknown): AssistantCreateFileResult | undefined => {
  if (!isRecord(value)) return undefined
  if (value.status !== 'created' || typeof value.path !== 'string' || !value.path.trim()) return undefined

  return {
    status: 'created',
    path: value.path,
    format: typeof value.format === 'string' ? value.format : undefined,
    size: typeof value.size === 'number' && Number.isFinite(value.size) ? value.size : undefined,
    verified: typeof value.verified === 'boolean' ? value.verified : undefined
  }
}

const parseResultJson = (value: string): AssistantCreateFileResult | undefined => {
  try {
    return parseResultObject(JSON.parse(value))
  } catch {
    return undefined
  }
}

export const parseAssistantCreateFileResult = (response: unknown): AssistantCreateFileResult | undefined => {
  const directResult = parseResultObject(response)
  if (directResult) return directResult

  if (typeof response === 'string') {
    return parseResultJson(response)
  }

  if (!isRecord(response)) return undefined

  const structuredResult = parseResultObject(response.structuredContent)
  if (structuredResult) return structuredResult

  const content = response.content
  if (!Array.isArray(content)) return undefined

  for (const item of content) {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') continue

    const parsedResult = parseResultJson(item.text)
    if (parsedResult) return parsedResult
  }

  return undefined
}

const getFileName = (filePath: string) => {
  const normalized = filePath.replace(/\\/g, '/')
  return normalized.split('/').filter(Boolean).pop() ?? filePath
}

export function AssistantCreateFileTool({ response }: { response: unknown }) {
  const { t } = useTranslation()
  const result = useMemo(() => parseAssistantCreateFileResult(response), [response])

  if (!result) return null

  const fileName = getFileName(result.path)
  const fileMeta = [result.format?.toUpperCase(), result.size !== undefined ? formatFileSize(result.size) : undefined]
    .filter(Boolean)
    .join(' · ')

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

const Card = styled.div`
  display: flex;
  gap: 12px;
  min-width: min(520px, 100%);
  max-width: 680px;
  padding: 12px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: linear-gradient(135deg, var(--color-background), var(--color-background-soft));
`

const IconWrap = styled.div`
  width: 42px;
  height: 42px;
  flex: 0 0 auto;
  display: grid;
  place-items: center;
  border-radius: 12px;
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
