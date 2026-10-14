import { useAppSelector } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { FileText, FolderOpen } from 'lucide-react'
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { shallowEqual } from 'react-redux'
import styled from 'styled-components'

import { collectMessageArtifacts, localArtifactKey } from './artifactShortcuts'

function MessageArtifacts({ message }: { message: Message }) {
  const { t } = useTranslation()
  const blocks = useAppSelector((state) => message.blocks.map((id) => state.messageBlocks.entities[id]), shallowEqual)
  const artifacts = useMemo(() => collectMessageArtifacts(blocks), [blocks])
  if (message.role !== 'assistant' || !artifacts.length) return null

  const open = (path: string, reveal: boolean) => {
    const operation = reveal ? window.api.file.showInFolder(path) : window.api.file.openPath(path)
    void operation.catch(() => window.toast.error(t('chat.input.tools.open_file_error', { path })))
  }
  return (
    <Shortcuts aria-label={t('new_assistant.deliverables')}>
      {artifacts.map((artifact) => (
        <Shortcut key={localArtifactKey(artifact.path)}>
          <OpenButton type="button" title={artifact.path} onClick={() => open(artifact.path, false)}>
            {artifact.kind === 'directory' ? <FolderOpen size={16} /> : <FileText size={16} />}
            <Name>{artifact.path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? artifact.path}</Name>
          </OpenButton>
          {artifact.kind !== 'directory' && (
            <FolderButton
              type="button"
              title={t('message.tools.assistantCreateFile.open_folder')}
              aria-label={t('message.tools.assistantCreateFile.open_folder')}
              onClick={() => open(artifact.path, true)}>
              <FolderOpen size={15} />
            </FolderButton>
          )}
        </Shortcut>
      ))}
    </Shortcuts>
  )
}

const Shortcuts = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 8px 0 4px 46px;
`
const Shortcut = styled.div`
  display: flex;
  max-width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: var(--color-background-soft);
  overflow: hidden;
`
const OpenButton = styled.button`
  display: flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
  padding: 8px 10px;
  background: transparent;
  border: none;
  color: var(--color-text-1);
  cursor: pointer;
  font-size: 12px;
  &:hover { background: var(--color-background-mute); }
`
const Name = styled.span`
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
`
const FolderButton = styled(OpenButton)`
  flex-shrink: 0;
  border-left: 1px solid var(--color-border);
  color: var(--color-text-2);
`
export default memo(MessageArtifacts)
