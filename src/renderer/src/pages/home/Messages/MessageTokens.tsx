// import { useRuntime } from '@renderer/hooks/useRuntime'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import type { Message } from '@renderer/types/newMessage'
import { getModelCachePathLabel } from '@renderer/utils/provider'
import { formatTokenCount, getUsageCacheStats, normalizeUsage } from '@renderer/utils/usage'
import { Popover } from 'antd'
import { t } from 'i18next'
import styled from 'styled-components'

interface MessageTokensProps {
  message: Message
  isLastMessage?: boolean
}

const MessageTokens: React.FC<MessageTokensProps> = ({ message }) => {
  // const { generating } = useRuntime()
  const usage = normalizeUsage(message.usage)

  const locateMessage = () => {
    void EventEmitter.emit(EVENT_NAMES.LOCATE_MESSAGE + ':' + message.id, false)
  }

  const getPrice = () => {
    const inputTokens = usage?.prompt_tokens ?? 0
    const outputTokens = usage?.completion_tokens ?? 0
    const model = message.model

    // For OpenRouter, use the cost directly from usage if available
    if (model?.provider === 'openrouter' && usage?.cost !== undefined) {
      return usage.cost
    }

    if (!model || model.pricing?.input_per_million_tokens === 0 || model.pricing?.output_per_million_tokens === 0) {
      return 0
    }

    return (
      (inputTokens * (model.pricing?.input_per_million_tokens ?? 0) +
        outputTokens * (model.pricing?.output_per_million_tokens ?? 0)) /
      1000000
    )
  }

  const getPriceString = () => {
    const price = getPrice()
    if (price === 0) {
      return ''
    }

    const shouldShowCost = message.model?.provider === 'openrouter' || price > 0
    if (!shouldShowCost) {
      return ''
    }

    const currencySymbol = message.model?.pricing?.currencySymbol || '$'
    return ` | ${t('models.price.cost')}: ${currencySymbol}${price.toFixed(6)}`
  }

  if (!usage) {
    return null
  }

  if (message.role === 'user') {
    return (
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        {`Tokens: ${usage.total_tokens ?? 0}`}
      </MessageMetadata>
    )
  }

  if (message.role === 'assistant') {
    const cacheStats = getUsageCacheStats(usage)
    const cachePath = getModelCachePathLabel(message.model)
    const cachePathText = cachePath ? ` | Path: ${cachePath}` : ''
    const cacheText = cacheStats.hasCache
      ? ` | Cache: ${formatTokenCount(cacheStats.hitTokens)} hit${
          cacheStats.cacheWriteTokens > 0 ? ` / ${formatTokenCount(cacheStats.cacheWriteTokens)} write` : ''
        }${cacheStats.hitRate !== undefined ? ` (${Math.round(cacheStats.hitRate * 100)}%)` : ''}`
      : ''

    let metricsText = ''
    let hasMetrics = false

    if (message?.metrics?.completion_tokens && message?.metrics?.time_completion_millsec) {
      hasMetrics = true
      metricsText = t('settings.messages.metrics', {
        time_first_token_millsec: message?.metrics?.time_first_token_millsec,
        token_speed: (message?.metrics?.completion_tokens / (message?.metrics?.time_completion_millsec / 1000)).toFixed(
          0
        )
      })
      if (cachePathText) {
        metricsText += cachePathText
      }
      if (cacheText) {
        metricsText += cacheText
      }
    } else if (cachePathText) {
      hasMetrics = true
      metricsText = cachePathText.replace(/^ \| /, '')
    } else if (cacheText) {
      hasMetrics = true
      metricsText = cacheText.replace(/^ \| /, '')
    }

    const tokensInfo = (
      <span className="tokens">
        Tokens:
        <span>{usage.total_tokens ?? 0}</span>
        <span>{`in ${usage.prompt_tokens ?? 0}`}</span>
        <span>{`out ${usage.completion_tokens ?? 0}`}</span>
        <span>{cachePathText}</span>
        <span>{cacheText}</span>
        <span>{getPriceString()}</span>
      </span>
    )

    return (
      <MessageMetadata className="message-tokens" onClick={locateMessage}>
        {hasMetrics ? (
          <Popover content={metricsText} placement="top" trigger="hover" styles={{ root: { fontSize: 11 } }}>
            {tokensInfo}
          </Popover>
        ) : (
          tokensInfo
        )}
      </MessageMetadata>
    )
  }

  return null
}

const MessageMetadata = styled.div`
  font-size: 10px;
  color: var(--color-text-3);
  user-select: text;
  cursor: pointer;
  text-align: right;

  .tokens span {
    padding: 0 2px;
  }
`

export default MessageTokens
