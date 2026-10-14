import type { Message } from '@renderer/types/newMessage'
import { formatMessageDuration, getMessageTimingStats } from '@renderer/utils/messageTiming'
import { formatTokenCount } from '@renderer/utils/usage'
import type { OpenCodeTurnDiagnostics } from '@shared/agents/opencodeDiagnostics'
import { Button, Descriptions, Modal } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { getReportedCacheCoverage } from './usageDiagnostics'

export default function MessageUsageDetails({
  message,
  diagnostics: data
}: {
  message: Message
  diagnostics: OpenCodeTurnDiagnostics
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const coverage = getReportedCacheCoverage(data)
  const timing = getMessageTimingStats(message)
  const count = (value?: number) => (value === undefined ? t('assistantUsage.unknown') : formatTokenCount(value))
  const time = (value?: number | null) => (value == null ? t('assistantUsage.unknown') : formatMessageDuration(value))
  const labels = {
    model: t('assistantUsage.model'),
    provider: t('assistantUsage.provider'),
    outcome: t('assistantUsage.outcome'),
    coverage: t('assistantUsage.coverage'),
    input: t('assistantUsage.input'),
    output: t('assistantUsage.output'),
    cache_read: t('assistantUsage.cache_read'),
    cache_write: t('assistantUsage.cache_write'),
    reasoning: t('assistantUsage.reasoning'),
    rate: t('assistantUsage.rate'),
    requests: t('assistantUsage.requests'),
    retries: t('assistantUsage.retries'),
    tools: t('assistantUsage.tools'),
    unfinished_tools: t('assistantUsage.unfinished_tools'),
    first: t('assistantUsage.first'),
    total: t('assistantUsage.total'),
    preparation: t('assistantUsage.preparation'),
    headers: t('assistantUsage.headers'),
    transport: t('assistantUsage.transport'),
    tool_time: t('assistantUsage.tool_time')
  }
  const outcomes = {
    completed: t('assistantUsage.completed'),
    failed: t('assistantUsage.failed'),
    cancelled: t('assistantUsage.cancelled')
  }
  const row = (key: keyof typeof labels, value: string | number) => ({ key, label: labels[key], children: value })
  return (
    <>
      <Button
        type="text"
        size="small"
        className="h-auto! px-1! py-0! text-(--color-text-3)! text-[10px]!"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}>
        {t('assistantUsage.entry')}
      </Button>
      <Modal
        title={t('assistantUsage.title')}
        open={open}
        onCancel={() => setOpen(false)}
        footer={null}
        width={620}
        destroyOnHidden
        modalRender={(node) => <div onClick={(event) => event.stopPropagation()}>{node}</div>}>
        <p className="text-(--color-text-2) text-xs">{t('assistantUsage.scope')}</p>
        <Descriptions
          column={1}
          size="small"
          items={[
            row('model', data.modelId),
            row('provider', data.providerId),
            row('outcome', outcomes[data.performance.outcome]),
            row(
              'coverage',
              t('assistantUsage.coverage_value', {
                reported: data.reportedRequests,
                total: data.performance.upstreamRequests
              })
            ),
            row('input', count(data.usage.input)),
            row('output', count(data.usage.output)),
            row('cache_read', count(data.usage.cacheRead)),
            row('cache_write', count(data.usage.cacheWrite)),
            row('reasoning', count(data.usage.reasoning)),
            row(
              'rate',
              coverage.rate === undefined ? t('assistantUsage.unknown') : `${(coverage.rate * 100).toFixed(1)}%`
            ),
            row('requests', data.performance.upstreamRequests),
            row('retries', data.performance.retryEvents),
            row('tools', data.performance.toolCalls),
            row('unfinished_tools', data.performance.unfinishedTools),
            row('first', time(timing.firstTokenMs)),
            row('total', time(timing.elapsedMs)),
            row('preparation', time(data.performance.preparationMs)),
            row('headers', time(data.performance.upstreamHeaderWaitMs)),
            row('transport', time(data.performance.upstreamRequestMs)),
            row('tool_time', time(data.performance.completedToolObservedMs))
          ]}
        />
        {coverage.partial && <p className="text-(--color-text-2) text-xs">{t('assistantUsage.partial')}</p>}
        {coverage.inconsistent && <p className="text-(--color-text-2) text-xs">{t('assistantUsage.inconsistent')}</p>}
        <p className="text-(--color-text-2) text-xs">{t('assistantUsage.rate_notice')}</p>
        <p className="text-(--color-text-2) text-xs">{t('assistantUsage.timing_notice')}</p>
        <p className="text-(--color-text-2) text-xs">{t('assistantUsage.billing_notice')}</p>
      </Modal>
    </>
  )
}
