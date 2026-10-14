import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Message } from '@renderer/types/newMessage'
import { formatMessageDuration, getMessageTimingStats } from '@renderer/utils/messageTiming'
import { formatTokenCount, getUsageCacheStats, normalizeUsage } from '@renderer/utils/usage'
import { readOpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import MessageUsageDetails from './MessageUsageDetails'
import { getReportedCacheCoverage } from './usageDiagnostics'

interface MessageTokensProps {
  message: Message
  isLastMessage?: boolean
}

const MessageTokens: React.FC<MessageTokensProps> = ({ message }) => {
  const { t } = useTranslation()
  const usage = normalizeUsage(message.usage)
  const locateMessage = () => {
    void EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, false)
  }

  if (message.role === 'user') {
    return usage ? (
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        {`Tokens: ${usage.total_tokens ?? 0}`}
      </MessageMetadata>
    ) : null
  }

  if (message.role !== 'assistant' || (!usage && !message.providerMetadata?.responseTiming && !message.metrics))
    return null

  const cache = getUsageCacheStats(usage)
  const diagnostics = readOpenCodeTurnDiagnostics(message.providerMetadata?.opencodeDiagnostics)
  const cacheReported =
    !diagnostics ||
    (getReportedCacheCoverage(diagnostics).readsComplete && cache.hitTokens === diagnostics.usage.cacheRead)
  const timing = getMessageTimingStats(message)
  const count = (value?: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? formatTokenCount(value) : '—'

  return (
    <Tooltip title={t('settings.messages.stats_tip')}>
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        <span>
          {t('settings.messages.stats_tokens', {
            input: count(
              diagnostics && diagnostics.inputReports === 0 && !usage?.prompt_tokens ? undefined : usage?.prompt_tokens
            ),
            output: count(
              diagnostics && diagnostics.outputReports === 0 && !usage?.completion_tokens
                ? undefined
                : usage?.completion_tokens
            ),
            cached: count(cacheReported && cache.hasCache ? cache.hitTokens : undefined)
          })}
        </span>
        <TimeStats>
          {t('settings.messages.stats_time', {
            first: formatMessageDuration(timing.firstTokenMs),
            total: formatMessageDuration(timing.elapsedMs)
          })}
        </TimeStats>
        {diagnostics && <MessageUsageDetails key={message.id} message={message} diagnostics={diagnostics} />}
      </MessageMetadata>
    </Tooltip>
  )
}

const MessageMetadata = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px 8px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-3);
  user-select: text;
  cursor: pointer;

  > span {
    white-space: normal;
  }
`

const TimeStats = styled.span`
  border-inline-start: 1px solid var(--color-border);
  padding-inline-start: 8px;
`

export default MessageTokens
