import { useTurnDiagnosticExport } from '@renderer/hooks/useTurnDiagnosticExport'
import store from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import type { Message } from '@renderer/types/newMessage'
import { Button } from 'antd'
import { Download } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Read-only action while normal message-edit/retry controls remain hidden. */
export default function ActiveTurnDiagnostics({ message, source }: { message: Message; source: 'chat' | 'agent' }) {
  const { t } = useTranslation()
  const { exportTurn, exporting } = useTurnDiagnosticExport()
  return (
    <Button
      type="text"
      size="small"
      icon={<Download size={12} />}
      style={{ color: 'var(--color-text-3)', fontSize: 11, height: 22, padding: '0 4px', gap: 4 }}
      loading={exporting}
      onClick={(event) => {
        event.stopPropagation()
        const state = store.getState()
        exportTurn({
          source,
          message,
          relatedUserMessage: selectMessagesForTopic(state, message.topicId).find((item) => item.id === message.askId),
          blockEntities: state.messageBlocks.entities
        })
      }}>
      {t('turnDiagnostics.export')}
    </Button>
  )
}
