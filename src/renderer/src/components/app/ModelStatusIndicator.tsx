import { createModelLatencyFormatter } from '@renderer/pages/model-status/modelLatency'
import { Tooltip } from 'antd'
import { useTranslation } from 'react-i18next'

export function ModelStatusIndicator({ available, elapsedMs }: { available: boolean; elapsedMs?: number }) {
  const { t, i18n } = useTranslation()
  const latency =
    elapsedMs === undefined
      ? undefined
      : createModelLatencyFormatter(i18n.language)(elapsedMs)
          .map(({ value }) => value)
          .join('')
  const summary = available ? t('model_status.normal') : t('model_status.no_data')
  return (
    <Tooltip title={[t('model_status.title'), summary, latency].filter(Boolean).join(' · ')}>
      <span className="inline-flex shrink-0 items-center gap-1 text-(--zen-text-2) text-[10px] tabular-nums">
        <span className="zen-status-dot" data-tone={available ? 'normal' : 'unknown'} aria-hidden="true" />
        {latency && <span className="font-mono">{latency}</span>}
      </span>
    </Tooltip>
  )
}
