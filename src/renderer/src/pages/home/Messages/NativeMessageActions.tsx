import { Tooltip } from 'antd'
import { RefreshCw, Split, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

export default function NativeMessageActions({
  busy,
  onRetry,
  onFork,
  onDelete
}: {
  busy: boolean
  onRetry: () => void | Promise<void>
  onFork: () => void | Promise<void>
  onDelete: () => void | Promise<void>
}) {
  const { t } = useTranslation()
  const actions = [
    { key: 'retry', label: t('common.regenerate'), icon: <RefreshCw size={15} />, run: onRetry },
    { key: 'fork', label: t('chat.message.new.branch.tooltip'), icon: <Split size={15} />, run: onFork },
    { key: 'delete', label: t('common.delete'), icon: <Trash2 size={15} />, run: onDelete }
  ]
  return (
    <>
      {actions.map((action) => (
        <Tooltip key={action.key} title={action.label} mouseEnterDelay={0.8}>
          <ActionButton
            type="button"
            aria-label={action.label}
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              void action.run()
            }}>
            {action.icon}
          </ActionButton>
        </Tooltip>
      ))}
    </>
  )
}

const ActionButton = styled.button`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-icon);
  cursor: pointer;
  &:hover:not(:disabled) { background: var(--color-background-mute); color: var(--color-text-1); }
  &:disabled { opacity: 0.4; cursor: not-allowed; }
`
