import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useAllProviders } from '@renderer/hooks/useProvider'
import { getUsageSources, type ModelPerformanceWindow } from '@renderer/services/UsageStatisticsService'
import { Alert, Button, Empty, Input, Pagination, Segmented, Select, Spin, Tag, Tooltip } from 'antd'
import { Activity, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { createModelLatencyFormatter } from './modelLatency'
import { useModelPerformance } from './useModelPerformance'

const daysOptions = [7, 15, 30] as const
const pageSize = 24

function hourlyBarColor(rate: number) {
  if (rate >= 1) return 'bg-emerald-500'
  if (rate >= 0.9) return 'bg-emerald-400'
  if (rate >= 0.7) return 'bg-amber-500'
  return 'bg-red-500'
}

function LatencyValue({ parts }: { parts: Intl.NumberFormatPart[] }) {
  return (
    <dd className="m-0 font-semibold text-xl tabular-nums leading-8">
      {parts.map((part, position) => (
        <span
          key={`${part.type}-${position}`}
          className={part.type === 'unit' ? 'font-medium text-(--color-text-secondary) text-xs' : undefined}>
          {part.value}
        </span>
      ))}
    </dd>
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
  const formatRate = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 2 })
  const formatLatency = useMemo(() => createModelLatencyFormatter(i18n.language), [i18n.language])
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
        <NavbarCenter>{t('model_status.title')}</NavbarCenter>
      </Navbar>
      <main className="flex-1 space-y-4 overflow-auto p-4 sm:p-6">
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
              className="w-52"
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
          <p className="text-(--color-text-secondary) text-xs">
            {data.granularity === 'day' ? t('model_status.description') : t('model_status.request_description')}
          </p>
        )}
        {!source && <Empty description={t('model_status.no_source')} />}
        {error && <Alert type="warning" showIcon message={errorLabel()} />}
        {loading && !data && (
          <div className="flex justify-center py-10">
            <Spin />
          </div>
        )}
        {data && rows.length === 0 && <Empty description={t('model_status.empty')} />}
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.slice((currentPage - 1) * pageSize, currentPage * pageSize).map((row) => {
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
            return (
              <article
                key={row.model}
                className="space-y-4 rounded-xl border border-(--color-border) bg-(--color-background-soft) p-4">
                <div className="flex items-start justify-between gap-2">
                  <h2 className="m-0 flex min-w-0 items-start gap-2 break-all font-semibold text-sm">
                    <Activity aria-hidden="true" className="mt-0.5 shrink-0 text-(--color-primary)" size={15} />
                    {row.model}
                  </h2>
                  <Tag color={color} className="m-0 shrink-0">
                    {status}
                  </Tag>
                </div>
                <dl className={`grid gap-2 ${hourly ? 'grid-cols-3' : 'grid-cols-2'}`}>
                  <div>
                    <dt className="text-(--color-text-secondary) text-xs">{t('model_status.success_rate')}</dt>
                    <dd className="m-0 font-semibold text-2xl tabular-nums leading-8">
                      {rate === null ? '—' : formatRate.format(rate)}
                    </dd>
                  </div>
                  {hourly && (
                    <div>
                      <dt className="text-(--color-text-secondary) text-xs">
                        {t('model_status.first_response_latency')}
                      </dt>
                      <LatencyValue parts={formatLatency(row.average_first_response_ms)} />
                    </div>
                  )}
                  <div>
                    <dt className="text-(--color-text-secondary) text-xs">
                      {hourly ? t('model_status.request_latency') : t('model_status.latency')}
                    </dt>
                    <LatencyValue parts={formatLatency(row.average_latency_ms)} />
                  </div>
                </dl>
                <div className="space-y-2 border-(--color-border) border-t pt-3">
                  <div className="flex justify-between gap-2 text-(--color-text-secondary) text-xs">
                    <span>{hourly ? t('model_status.hourly_history') : t('model_status.history')}</span>
                    <span>
                      {hourly
                        ? t('model_status.requests', { count: total })
                        : t('model_status.attempts', { count: total })}
                    </span>
                  </div>
                  <div className="flex h-4 gap-0.5">
                    {history.length === 0 && <span className="text-(--color-text-secondary) text-xs">—</span>}
                    {history.map((point) => {
                      const pointRate = point.succeeded / (point.succeeded + point.failed)
                      let bar = 'bg-(--color-background-mute)'
                      if (hourly) bar = hourlyBarColor(pointRate)
                      else if (point.failed > 0) bar = point.succeeded ? 'bg-amber-500' : 'bg-rose-500'
                      else if (point.succeeded > 0) bar = 'bg-emerald-500'
                      const tooltip = hourly
                        ? t('model_status.hour_result', { ...point, rate: formatRate.format(pointRate) })
                        : t('model_status.day_result', point)
                      return (
                        <Tooltip key={point.key} title={tooltip} trigger={['hover', 'focus']}>
                          <span
                            tabIndex={0}
                            aria-label={tooltip}
                            className={`rounded-sm ${hourly ? 'w-1.5 shrink-0' : 'flex-1'} ${bar}`}
                          />
                        </Tooltip>
                      )
                    })}
                  </div>
                </div>
              </article>
            )
          })}
        </div>
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
