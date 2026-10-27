import { useTopicMessages } from '@renderer/hooks/useMessageOperations'
import { useAppSelector } from '@renderer/store'
import type { Message } from '@renderer/types/newMessage'
import { FileText, FolderOpen } from 'lucide-react'
import { memo, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { shallowEqual } from 'react-redux'
import styled from 'styled-components'

import { artifactTurnMessages, collectSessionArtifacts, localArtifactKey } from './artifactShortcuts'
import { useArtifactAvailability } from './useArtifactAvailability'

function MessageArtifacts({ message }: { message: Message }) {
  const { t } = useTranslation()
  const messages = useTopicMessages(message.topicId)
  const turnMessages = useMemo(() => artifactTurnMessages(messages, message), [messages, message])
  const blocks = useAppSelector(
    (state) => turnMessages.flatMap((item) => item.blocks.map((id) => state.messageBlocks.entities[id])),
    shallowEqual
  )
  const artifacts = useMemo(
    () =>
      collectSessionArtifacts(
        turnMessages,
        Object.fromEntries(blocks.filter((block) => !!block).map((block) => [block.id, block]))
      )
        .filter((artifact) => artifact.messageId === message.id)
        .reverse(),
    [turnMessages, blocks, message.id]
  )
  const { status, open } = useArtifactAvailability(artifacts, message.role === 'assistant')
  // Missing legacy/intermediate entries remain in the session history, not as
  // clickable final-delivery cards. The session panel explains their status.
  const visible = artifacts.filter((artifact) => ['available', 'unavailable'].includes(status(artifact.path)))
  if (message.role !== 'assistant' || !visible.length) return null
  return (
    <Shortcuts aria-label={t('new_assistant.deliverables')}>
      {visible.map((artifact) => (
        <Shortcut key={localArtifactKey(artifact.path)}>
          <OpenButton
            type="button"
            title={artifact.path}
            disabled={status(artifact.path) !== 'available'}
            onClick={() => void open(artifact.path)}>
            {artifact.kind === 'directory' ? <FolderOpen size={16} /> : <FileText size={16} />}
            <Name>{artifact.path.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? artifact.path}</Name>
            {status(artifact.path) === 'unavailable' && <span>{t('assistantDeliverables.unavailable')}</span>}
          </OpenButton>
          {artifact.kind !== 'directory' && (
            <FolderButton
              type="button"
              disabled={status(artifact.path) !== 'available'}
              title={t('message.tools.assistantCreateFile.open_folder')}
              aria-label={t('message.tools.assistantCreateFile.open_folder')}
              onClick={() => void open(artifact.path, true)}>
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
  &:disabled { cursor: default; opacity: 0.6; }
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
