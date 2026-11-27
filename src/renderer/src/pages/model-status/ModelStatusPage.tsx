import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useAllProviders } from '@renderer/hooks/useProvider'
import { getUsageSources, type ModelPerformanceWindow } from '@renderer/services/UsageStatisticsService'
import { Alert, Button, Empty, Input, Pagination, Segmented, Select, Spin, Tag, Tooltip } from 'antd'
import { RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createModelLatencyFormatter } from './modelLatency'
import { useModelPerformance } from './useModelPerformance'

const daysOptions = [7, 15, 30] as const
const pageSize = 50

function hourlyBarColor(rate: number) {
  if (!Number.isFinite(rate)) return 'bg-(--zen-bg-subtle)'
  if (rate >= 0.9) return 'bg-(--zen-success)'
  if (rate >= 0.7) return 'bg-(--zen-warning)'
  return 'bg-(--zen-danger)'
}

function statusDotClass(color: string) {
  if (color === 'green') return 'bg-(--zen-success) shadow-[0_0_0_3px_var(--zen-success-soft)]'
  if (color === 'orange') return 'bg-(--zen-warning)'
  if (color === 'red') return 'bg-(--zen-danger)'
  return 'bg-(--zen-text-3)'
}

function rateTextClass(rate: number | null) {
  if (rate === null) return 'text-(--zen-text-3)'
  if (rate >= 0.9) return 'text-(--zen-success)'
  if (rate >= 0.7) return 'text-(--zen-warning)'
  return 'text-(--zen-danger)'
}

function LatencyText({ parts }: { parts: Intl.NumberFormatPart[] }) {
  return (
    <span className="font-mono text-(--zen-text-1) text-[13px] tabular-nums">
      {parts.map((part, position) => (
        <span
          key={`${part.type}-${position}`}
          className={part.type === 'unit' ? 'ml-0.5 font-normal text-(--zen-text-3) text-[11px]' : 'font-medium'}>
          {part.value}
        </span>
      ))}
    </span>
  )
}

export default function ModelStatusPage() {
  const { t, i18n } = useTranslation()
  const providers = useAllProviders()
  const sources = useMemo(() => getUsageSources(providers), [providers])
  const [selectedSource, setSelectedSource] = useState<string>()
  const source =
    sources.find((item) => item.id === selectedSource) ?? sources.find((item) => item.supported) ?? sources[0]
  const [days, setDays] = useState<ModelPerformanceWindow>(7)
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const { data, error, loading } = useModelPerformance(source, days, revision)
  const rows = data?.models.filter((row) => row.model.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  const currentPage = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)))
  const visibleRows = rows.slice((currentPage - 1) * pageSize, currentPage * pageSize)
  const isHourly = data?.granularity === 'hour'
  const formatRate = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 2 })
  const formatLatency = useMemo(() => createModelLatencyFormatter(i18n.language), [i18n.language])
  let succeeded = 0
  let failed = 0
  let latencyTotal = 0
  let timed = 0
  for (const row of data?.models ?? []) {
    succeeded += row.succeeded
    failed += row.failed
    if (row.average_latency_ms !== null) {
      const count = isHourly ? row.succeeded + row.failed : row.succeeded
      latencyTotal += row.average_latency_ms * count
      timed += count
    }
  }
  const attempts = succeeded + failed
  const metrics = [
    [t('common.models'), (data?.models.length ?? 0).toLocaleString(i18n.language)],
    [t('model_status.success_rate'), attempts > 0 ? formatRate.format(succeeded / attempts) : '—'],
    [
      data?.granularity === 'day' ? t('model_status.latency') : t('model_status.request_latency'),
      timed
        ? formatLatency(latencyTotal / timed)
            .map(({ value }) => value)
            .join('')
        : '—'
    ],
    [t('model_status.failures'), failed.toLocaleString(i18n.language)]
  ]
  const formatHour = new Intl.DateTimeFormat(i18n.language, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
  const legacyDates = data?.granularity === 'day' ? data.dates : []
  const errorLabel = () => {
    if (error === 'unsupported') return t('model_status.unsupported')
    if (error === 'unauthorized') return t('usage_statistics.errors.unauthorized')
    return t('model_status.load_failed')
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
      <Navbar>
        <NavbarCenter />
      </Navbar>
      <main className="mx-auto w-full max-w-[1220px] flex-1 space-y-5 overflow-auto p-6 sm:p-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label={t('model_status.source')}
              className="min-w-44"
              value={source?.id}
              placeholder={t('model_status.source')}
              options={sources.map((item) => ({ label: item.label, value: item.id }))}
              onChange={(id) => {
                setSelectedSource(id)
                setPage(1)
              }}
            />
            <Input
              aria-label={t('model_status.search')}
              className="w-60"
              prefix={<Search size={14} aria-hidden="true" />}
              value={query}
              placeholder={t('model_status.search')}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(1)
              }}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented<ModelPerformanceWindow>
              aria-label={t('model_status.days', { count: days })}
              value={days}
              options={daysOptions.map((value) => ({ label: t('model_status.days', { count: value }), value }))}
              onChange={(value) => {
                setDays(value)
                setPage(1)
              }}
            />
            <Button
              icon={<RefreshCw size={14} aria-hidden="true" />}
              aria-label={t('common.refresh')}
              loading={loading}
              disabled={!source}
              onClick={() => setRevision((value) => value + 1)}
            />
          </div>
        </div>
        {data && (
          <p className="m-0 text-(--color-text-secondary) text-xs">
            {data.granularity === 'day' ? t('model_status.description') : t('model_status.request_description')}
          </p>
        )}
        {data && (
          <dl className="zen-metric-grid">
            {metrics.map(([label, value]) => (
              <div key={label} className="zen-metric-card">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {!source && <Empty description={t('model_status.no_source')} />}
        {error && <Alert type="warning" showIcon message={errorLabel()} />}
        {loading && !data && (
          <div className="flex justify-center py-10">
            <Spin />
          </div>
        )}
        {data && rows.length === 0 && <Empty description={t('model_status.empty')} />}

        {visibleRows.length > 0 && (
          <div
            className="overflow-hidden rounded-(--zen-radius-md)"
            style={{
              background: 'var(--zen-glass-card)',
              backdropFilter: 'blur(24px) saturate(150%)',
              boxShadow: 'var(--zen-shadow-card)'
            }}>
            {/* Desktop table header */}
            <div
              className={`hidden items-center gap-4 border-(--zen-border) border-b px-5 py-2.5 font-medium text-(--zen-text-3) text-[11.5px] lg:grid ${
                isHourly
                  ? 'lg:grid-cols-[minmax(200px,1.5fr)_84px_92px_92px_92px_82px_minmax(170px,1.2fr)]'
                  : 'lg:grid-cols-[minmax(220px,1.6fr)_84px_96px_96px_86px_minmax(190px,1.3fr)]'
              }`}>
              <span>{t('common.models')}</span>
              <span>{t('model_status.title')}</span>
              <span className="text-right">{t('model_status.success_rate')}</span>
              {isHourly && <span className="text-right">{t('model_status.first_response_latency')}</span>}
              <span className="text-right">
                {isHourly ? t('model_status.request_latency') : t('model_status.latency')}
              </span>
              <span className="text-right">
                {isHourly ? t('model_status.requests', { count: 0 }).replace(/0\s*/, '').trim() || '#' : '#'}
              </span>
              <span>{isHourly ? t('model_status.hourly_history') : t('model_status.history')}</span>
            </div>

            <div className="divide-y divide-(--zen-border)">
              {visibleRows.map((row) => {
                const total = row.succeeded + row.failed
                const rate = total > 0 ? row.succeeded / total : null
                const hourly = 'recent_hours' in row
                let status = t('model_status.no_data')
                let color = 'default'
                if (hourly && rate !== null) {
                  if (rate >= 0.9) {
                    status = t('model_status.normal')
                    color = 'green'
                  } else if (rate >= 0.7) {
                    status = t('model_status.degraded')
                    color = 'orange'
                  } else {
                    status = t('model_status.high_failure_rate')
                    color = 'red'
                  }
                } else if (row.failed > 0) {
                  status = row.succeeded > 0 ? t('model_status.some_failed') : t('model_status.all_failed')
                  color = row.succeeded > 0 ? 'orange' : 'red'
                } else if (total > 0) {
                  status = t('model_status.normal')
                  color = 'green'
                }
                const history = hourly
                  ? row.recent_hours.map((hour) => ({
                      ...hour,
                      date: formatHour.format(hour.timestamp * 1000),
                      key: hour.timestamp
                    }))
                  : row.history.map((day, index) => ({ ...day, date: legacyDates[index], key: index }))
                const totalLabel = hourly
                  ? t('model_status.requests', { count: total })
                  : t('model_status.attempts', { count: total })

                return (
                  <article
                    key={row.model}
                    className={`flex flex-col gap-2.5 px-5 py-3.5 transition-colors hover:bg-(--zen-bg-hover) lg:grid lg:items-center lg:gap-4 ${
                      isHourly
                        ? 'lg:grid-cols-[minmax(200px,1.5fr)_84px_92px_92px_92px_82px_minmax(170px,1.2fr)]'
                        : 'lg:grid-cols-[minmax(220px,1.6fr)_84px_96px_96px_86px_minmax(190px,1.3fr)]'
                    }`}>
                    {/* Model Name */}
                    <div className="flex min-w-0 items-center justify-between gap-2.5">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <span className={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(color)}`} aria-hidden="true" />
                        <Tooltip title={row.model} mouseEnterDelay={0.4}>
                          <h2 className="m-0 truncate font-medium text-(--zen-text-1) text-[13.5px]">{row.model}</h2>
                        </Tooltip>
                      </div>
                      <Tag color={color} className="m-0 shrink-0 lg:hidden">
                        {status}
                      </Tag>
                    </div>

                    {/* Status Badge (desktop) */}
                    <div className="hidden lg:block">
                      <Tag color={color} className="m-0">
                        {status}
                      </Tag>
                    </div>

                    {/* Metrics */}
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs lg:contents">
                      <div className="flex items-center gap-1.5 lg:block lg:text-right">
                        <span className="text-(--zen-text-3) lg:hidden">{t('model_status.success_rate')}</span>
                        <span className={`font-mono font-semibold text-[13.5px] tabular-nums ${rateTextClass(rate)}`}>
                          {rate === null ? '—' : formatRate.format(rate)}
                        </span>
                      </div>

                      {hourly && (
                        <div className="flex items-center gap-1.5 lg:block lg:text-right">
                          <span className="text-(--zen-text-3) lg:hidden">
                            {t('model_status.first_response_latency')}
                          </span>
                          <LatencyText parts={formatLatency(row.average_first_response_ms)} />
                        </div>
                      )}

                      <div className="flex items-center gap-1.5 lg:block lg:text-right">
                        <span className="text-(--zen-text-3) lg:hidden">
                          {hourly ? t('model_status.request_latency') : t('model_status.latency')}
                        </span>
                        <LatencyText parts={formatLatency(row.average_latency_ms)} />
                      </div>

                      <div className="flex items-center gap-1.5 lg:block lg:text-right">
                        <Tooltip title={totalLabel}>
                          <span className="font-mono text-(--zen-text-2) text-[12.5px] tabular-nums">
                            {total.toLocaleString(i18n.language)}
                          </span>
                        </Tooltip>
                      </div>
                    </div>

                    {/* Compact Uptime Sparkbar */}
                    <div className="flex h-3.5 items-stretch gap-0.5">
                      {history.length === 0 && <span className="text-(--zen-text-3) text-xs">—</span>}
                      {history.map((point) => {
                        const pointRate = point.succeeded / (point.succeeded + point.failed)
                        let bar = 'bg-(--zen-bg-subtle)'
                        if (hourly) bar = hourlyBarColor(pointRate)
                        else if (point.failed > 0) bar = point.succeeded ? 'bg-(--zen-warning)' : 'bg-(--zen-danger)'
                        else if (point.succeeded > 0) bar = 'bg-(--zen-success)'
                        const tooltip = hourly
                          ? t('model_status.hour_result', { ...point, rate: formatRate.format(pointRate) })
                          : t('model_status.day_result', point)
                        return (
                          <Tooltip key={point.key} title={tooltip} trigger={['hover', 'focus']}>
                            <span
                              tabIndex={0}
                              aria-label={tooltip}
                              className={`rounded-[3px] ${hourly ? 'min-w-[4px] flex-1' : 'flex-1'} ${bar}`}
                            />
                          </Tooltip>
                        )
                      })}
                    </div>
                  </article>
                )
              })}
            </div>
          </div>
        )}

        {rows.length > pageSize && (
          <Pagination
            align="end"
            current={currentPage}
            pageSize={pageSize}
            total={rows.length}
            onChange={setPage}
            showSizeChanger={false}
          />
        )}
      </main>
    </div>
  )
}
