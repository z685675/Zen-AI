import { type ActiveSidebarModel, useSidebarShell } from '@renderer/context/SidebarSlotProvider'
import { useAllProviders } from '@renderer/hooks/useProvider'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useModelPerformance } from '@renderer/pages/model-status/useModelPerformance'
import { getUsageRange } from '@renderer/pages/usage/usageUtils'
import { useUsageStatistics } from '@renderer/pages/usage/useUsageStatistics'
import { getUsageSources } from '@renderer/services/UsageStatisticsService'
import store from '@renderer/store'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import { Tooltip } from 'antd'
import { BarChart3 } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { NavLink } from 'react-router-dom'
import styled from 'styled-components'

interface Props {
  activeModel?: ActiveSidebarModel
}

function normalizeModelKey(value?: string) {
  if (!value) return ''
  const trimmed = value.trim()
  const colonIndex = trimmed.indexOf(':')
  return (colonIndex > 0 ? trimmed.slice(colonIndex + 1) : trimmed).toLowerCase()
}

export default function ModelStatusPills({ activeModel: propModel }: Props) {
  const { t, i18n } = useTranslation()
  const shell = useSidebarShell()
  const activeModel = propModel ?? shell?.activeModel
  const providers = useAllProviders()
  const sources = useMemo(() => getUsageSources(providers), [providers])
  const source = useMemo(() => {
    if (activeModel?.provider) {
      const matched = sources.find((item) => item.supported && item.id === activeModel.provider)
      if (matched) return matched
    }
    return sources.find((item) => item.supported)
  }, [activeModel?.provider, sources])

  const { data } = useModelPerformance(source, 7, 0)
  const [start, end] = getUsageRange('today')
  const { stats } = useUsageStatistics(
    source,
    {
      start: start.startOf('day').unix(),
      end: end.endOf('day').unix(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      scene: 'all'
    },
    0
  )

  const matchedModelRow = useMemo(() => {
    const models = data?.models
    if (!models?.length || !activeModel?.id) return undefined
    const targetExact = normalizeModelKey(activeModel.id)
    const exactMatch = models.find((row) => normalizeModelKey(row.model) === targetExact)
    if (exactMatch) return exactMatch
    const targetBase = getLowerBaseModelName(targetExact)
    return models.find((row) => getLowerBaseModelName(normalizeModelKey(row.model)) === targetBase)
  }, [activeModel?.id, data?.models])

  const counts = matchedModelRow
    ? { succeeded: matchedModelRow.succeeded, failed: matchedModelRow.failed }
    : !activeModel?.id
      ? data?.models.reduce(
          (total, row) => ({
            succeeded: total.succeeded + row.succeeded,
            failed: total.failed + row.failed
          }),
          { succeeded: 0, failed: 0 }
        )
      : undefined

  const total = counts ? counts.succeeded + counts.failed : 0
  const rate = counts && total > 0 ? counts.succeeded / total : undefined
  const tone = rate === undefined ? 'unknown' : rate >= 0.9 ? 'normal' : rate >= 0.7 ? 'degraded' : 'failed'
  const health = {
    unknown: t('model_status.no_data'),
    normal: t('model_status.normal'),
    degraded: t('model_status.degraded'),
    failed: t('model_status.high_failure_rate')
  }[tone]
  const statusLabel = {
    unknown: t('model_status.no_data'),
    normal: t('app_shell.model_healthy', '模型正常'),
    degraded: t('app_shell.model_degraded', '模型降级'),
    failed: t('app_shell.model_failed', '模型异常')
  }[tone]
  const formattedRate =
    rate === undefined
      ? '—'
      : new Intl.NumberFormat(i18n.language, {
          style: 'percent',
          maximumFractionDigits: 1
        }).format(rate)

  const modelTooltipLabel = activeModel?.name || activeModel?.id || source?.label
  const usageLabel = t('app_shell.my_usage', '我的用量')
  const usageCountText = stats ? t('app_shell.today_count', { count: stats.summary.request_count }) : '—'

  const guardNavigation = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (store.getState().runtime.generating) {
      event.preventDefault()
      void modelGenerating().catch(() => {})
    }
  }

  return (
    <>
      <Tooltip title={[t('model_status.title'), modelTooltipLabel, health, formattedRate].filter(Boolean).join(' · ')}>
        <GlassPillLink to="/model-status" onClick={guardNavigation}>
          <StatusDot data-tone={tone} aria-hidden="true" />
          <PillLabel>{statusLabel}</PillLabel>
          <StatusBadge className="tabular-nums" data-tone={tone}>
            {formattedRate}
          </StatusBadge>
        </GlassPillLink>
      </Tooltip>
      <Tooltip
        title={[usageLabel, stats ? t('app_shell.today_requests', { count: stats.summary.request_count }) : undefined]
          .filter(Boolean)
          .join(' · ')}>
        <GlassPillLink to="/usage" onClick={guardNavigation}>
          <UsageIcon aria-hidden="true">
            <BarChart3 size={13} />
          </UsageIcon>
          <PillLabel>{usageLabel}</PillLabel>
          <UsageValue className="tabular-nums">{usageCountText}</UsageValue>
        </GlassPillLink>
      </Tooltip>
    </>
  )
}

const GlassPillLink = styled(NavLink)`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 35px;
  padding: 0 12px;
  border: 0;
  border-radius: var(--zen-radius-pill);
  background: var(--zen-glass-pill);
  backdrop-filter: blur(28px) saturate(165%);
  -webkit-backdrop-filter: blur(28px) saturate(165%);
  box-shadow: var(--zen-shadow-pill);
  color: var(--zen-text-1);
  text-decoration: none;
  white-space: nowrap;
  flex-shrink: 0;
  -webkit-app-region: no-drag;
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 150ms cubic-bezier(0.22, 1, 0.36, 1);

  &:hover {
    color: var(--zen-text-1);
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }

  &:active {
    transform: scale(0.985);
  }
`

const StatusDot = styled.span`
  width: 6.5px;
  height: 6.5px;
  flex: none;
  border-radius: 50%;
  background: var(--zen-text-3);

  &[data-tone='normal'] {
    background: var(--zen-success);
    box-shadow: 0 0 0 3px var(--zen-success-soft);
  }

  &[data-tone='degraded'] {
    background: var(--zen-warning);
  }

  &[data-tone='failed'] {
    background: var(--zen-danger);
  }
`

const PillLabel = styled.span`
  font-size: 12.5px;
  font-weight: 500;
  color: var(--zen-text-1);
  line-height: 1;
`

const StatusBadge = styled.b`
  flex: none;
  padding: 2px 7px;
  border-radius: var(--zen-radius-pill);
  font-family: var(--code-font-family);
  font-size: 10.5px;
  font-weight: 600;
  line-height: 1.3;
  background: var(--zen-bg-subtle);
  color: var(--zen-text-2);

  &[data-tone='normal'] {
    background: var(--zen-success-soft);
    color: var(--zen-success);
  }

  &[data-tone='degraded'] {
    background: rgba(217, 119, 6, 0.12);
    color: var(--zen-warning);
  }

  &[data-tone='failed'] {
    background: rgba(225, 29, 72, 0.12);
    color: var(--zen-danger);
  }
`

const UsageIcon = styled.span`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--zen-text-3);
  flex: none;
`

const UsageValue = styled.span`
  font-family: var(--code-font-family);
  font-size: 11px;
  font-weight: 500;
  color: var(--zen-text-3);
  line-height: 1;
`
