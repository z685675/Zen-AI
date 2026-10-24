import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { useAllProviders } from '@renderer/hooks/useProvider'
import {
  getCacheHitRate,
  getUsageSources,
  type UsageMetrics,
  type UsageScene
} from '@renderer/services/UsageStatisticsService'
import { Alert, Button, DatePicker, Empty, Input, Segmented, Select, Spin, Table, Tooltip } from 'antd'
import dayjs from 'dayjs'
import { BarChart3, RefreshCw, Search } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import ModelDailyQuota from './ModelDailyQuota'
import UsageTrend from './UsageTrend'
import { getUsageRange, groupUsageDays, type UsageInterval, type UsagePeriod } from './usageUtils'
import { useUsageStatistics } from './useUsageStatistics'

const periods: UsagePeriod[] = ['today', 'week', 'month', 'last7', 'last30', 'custom']
const periodKeys = {
  today: 'usage_statistics.periods.today',
  week: 'usage_statistics.periods.week',
  month: 'usage_statistics.periods.month',
  last7: 'usage_statistics.periods.last7',
  last30: 'usage_statistics.periods.last30',
  custom: 'usage_statistics.periods.custom'
} as const
const sceneKeys = {
  all: 'usage_statistics.scenes.all',
  chat: 'usage_statistics.scenes.chat',
  assistant: 'usage_statistics.scenes.assistant'
} as const
const intervalKeys = {
  day: 'usage_statistics.intervals.day',
  week: 'usage_statistics.intervals.week',
  month: 'usage_statistics.intervals.month'
} as const
const errorKeys = {
  unsupported: 'usage_statistics.errors.unsupported',
  unauthorized: 'usage_statistics.errors.unauthorized',
  range_too_large: 'usage_statistics.errors.range_too_large',
  timeout: 'usage_statistics.errors.timeout',
  unavailable: 'usage_statistics.errors.unavailable',
  invalid_response: 'usage_statistics.errors.invalid_response'
} as const

export default function UsagePage() {
  const { t, i18n } = useTranslation()
  const providers = useAllProviders()
  const sources = useMemo(() => getUsageSources(providers), [providers])
  const [selectedSource, setSelectedSource] = useState('')
  const source =
    sources.find((item) => item.id === selectedSource) ?? sources.find((item) => item.supported) ?? sources[0]
  const [period, setPeriod] = useState<UsagePeriod>('month')
  const [range, setRange] = useState<[dayjs.Dayjs, dayjs.Dayjs]>(() => getUsageRange('month'))
  const [scene, setScene] = useState<UsageScene>('all')
  const [interval, setInterval] = useState<UsageInterval>('day')
  const [search, setSearch] = useState('')
  const [revision, setRevision] = useState(0)
  const start = range[0].startOf('day').unix()
  const end = range[1].endOf('day').unix()
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  const { stats, error, loading, updatedAt } = useUsageStatistics(source, { start, end, timezone, scene }, revision)

  const format = (value: number) => value.toLocaleString(i18n.language)
  const cacheDisplay = (metrics: UsageMetrics) => {
    if (metrics.cache_tokens === null) return <Tooltip title={t('usage_statistics.cache_unknown')}>—</Tooltip>
    const partial = metrics.cache_known_requests < metrics.request_count
    return (
      <Tooltip title={partial ? t('usage_statistics.cache_partial') : t('usage_statistics.cache_hint')}>
        {partial ? '≥ ' : ''}
        {format(metrics.cache_tokens)}
      </Tooltip>
    )
  }
  const rateDisplay = (metrics: UsageMetrics) => {
    const rate = getCacheHitRate(metrics)
    return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`
  }
  const days = useMemo(() => groupUsageDays(stats?.days ?? [], range[0], range[1], interval), [stats, range, interval])
  const models = stats?.models.filter((model) => model.model.toLowerCase().includes(search.trim().toLowerCase())) ?? []
  const columns = [
    {
      title: t('usage_statistics.model'),
      dataIndex: 'model',
      key: 'model',
      ellipsis: true,
      render: (name: string) => name || t('usage_statistics.unknown_model')
    },
    {
      title: t('usage_statistics.input'),
      key: 'input',
      align: 'right' as const,
      width: 150,
      sorter: (a: UsageMetrics, b: UsageMetrics) => a.input_tokens - b.input_tokens,
      render: (_: unknown, row: UsageMetrics) => format(row.input_tokens)
    },
    {
      title: t('usage_statistics.output'),
      key: 'output',
      align: 'right' as const,
      width: 140,
      sorter: (a: UsageMetrics, b: UsageMetrics) => a.output_tokens - b.output_tokens,
      render: (_: unknown, row: UsageMetrics) => format(row.output_tokens)
    },
    {
      title: t('usage_statistics.cache'),
      key: 'cache',
      align: 'right' as const,
      width: 150,
      sorter: (a: UsageMetrics, b: UsageMetrics) => (a.cache_tokens ?? -1) - (b.cache_tokens ?? -1),
      render: (_: unknown, row: UsageMetrics) => cacheDisplay(row)
    },
    {
      title: t('usage_statistics.cache_rate'),
      key: 'rate',
      align: 'right' as const,
      width: 120,
      render: (_: unknown, row: UsageMetrics) => rateDisplay(row)
    }
  ]

  return (
    <Page>
      <Navbar>
        <NavbarCenter>{t('usage_statistics.title')}</NavbarCenter>
      </Navbar>
      <Content>
        <Header>
          <div>
            <Heading>
              <BarChart3 size={26} />
              {t('usage_statistics.title')}
            </Heading>
            <Subtitle>{t('usage_statistics.subtitle')}</Subtitle>
          </div>
          <Button
            icon={<RefreshCw size={14} />}
            loading={loading}
            disabled={!source}
            onClick={() => {
              if (period !== 'custom') setRange(getUsageRange(period))
              setRevision((value) => value + 1)
            }}>
            {t('usage_statistics.refresh')}
          </Button>
        </Header>
        <Panel>
          <Filters>
            <Select
              aria-label={t('usage_statistics.provider')}
              value={source?.id}
              placeholder={t('usage_statistics.provider')}
              options={sources.map((item) => ({ value: item.id, label: item.label }))}
              onChange={setSelectedSource}
              style={{ minWidth: 190, maxWidth: 300 }}
            />
            <Segmented
              aria-label={t('usage_statistics.scene')}
              value={scene}
              onChange={setScene}
              options={(['all', 'chat', 'assistant'] as const).map((value) => ({
                value,
                label: t(sceneKeys[value])
              }))}
            />
          </Filters>
          <Filters>
            <Segmented
              aria-label={t('usage_statistics.period')}
              value={period}
              options={periods.map((value) => ({ value, label: t(periodKeys[value]) }))}
              onChange={(value) => {
                setPeriod(value)
                if (value !== 'custom') setRange(getUsageRange(value))
              }}
            />
            <DatePicker.RangePicker
              aria-label={t('usage_statistics.custom_range')}
              value={range}
              allowClear={false}
              disabledDate={(date) => date.isAfter(dayjs(), 'day')}
              maxDate={dayjs()}
              format="YYYY-MM-DD"
              onChange={(dates) => {
                if (!dates?.[0] || !dates[1]) return
                if (dates[1].diff(dates[0], 'day') > 365) {
                  window.toast.warning(t('usage_statistics.range_limit'))
                  return
                }
                setPeriod('custom')
                setRange([dates[0], dates[1]])
              }}
            />
          </Filters>
        </Panel>
        {!source ? (
          <EmptyBlock>
            <Empty description={t('usage_statistics.no_provider')} />
          </EmptyBlock>
        ) : null}
        <ModelDailyQuota source={source} revision={revision} />
        {loading ? (
          <EmptyBlock role="status">
            <Spin size="large" />
            <Subtitle>{t('usage_statistics.loading')}</Subtitle>
          </EmptyBlock>
        ) : null}
        {error && !loading ? (
          <Alert
            type="warning"
            showIcon
            message={t(errorKeys[error])}
            action={
              <Button size="small" onClick={() => setRevision((value) => value + 1)}>
                {t('usage_statistics.retry')}
              </Button>
            }
          />
        ) : null}
        {stats && !loading ? (
          <>
            <Cards>
              <Metric>
                <MetricLabel>{t('usage_statistics.input')}</MetricLabel>
                <MetricValue>{format(stats.summary.input_tokens)}</MetricValue>
                <MetricHint>Token</MetricHint>
              </Metric>
              <Metric>
                <MetricLabel>{t('usage_statistics.output')}</MetricLabel>
                <MetricValue>{format(stats.summary.output_tokens)}</MetricValue>
                <MetricHint>Token</MetricHint>
              </Metric>
              <Metric>
                <MetricLabel>{t('usage_statistics.cache')}</MetricLabel>
                <MetricValue>{cacheDisplay(stats.summary)}</MetricValue>
                <MetricHint>{t('usage_statistics.cache_subset')}</MetricHint>
              </Metric>
              <Metric>
                <MetricLabel>{t('usage_statistics.cache_rate')}</MetricLabel>
                <Tooltip title={t('usage_statistics.rate_hint')}>
                  <MetricValue>{rateDisplay(stats.summary)}</MetricValue>
                </Tooltip>
                <MetricHint>{t('usage_statistics.cache_read')}</MetricHint>
              </Metric>
            </Cards>
            {stats.summary.request_count === 0 ? (
              <EmptyBlock>
                <Empty description={t('usage_statistics.empty')} />
              </EmptyBlock>
            ) : (
              <>
                <Panel>
                  <SectionHeader>
                    <h3>{t('usage_statistics.trend')}</h3>
                    <Segmented
                      value={interval}
                      onChange={setInterval}
                      options={(['day', 'week', 'month'] as const).map((value) => ({
                        value,
                        label: t(intervalKeys[value])
                      }))}
                    />
                  </SectionHeader>
                  <UsageTrend days={days} />
                </Panel>
                <Panel>
                  <SectionHeader>
                    <h3>{t('usage_statistics.model_details')}</h3>
                    <Input
                      prefix={<Search size={14} />}
                      aria-label={t('usage_statistics.search')}
                      placeholder={t('usage_statistics.search')}
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      allowClear
                      style={{ width: 220 }}
                    />
                  </SectionHeader>
                  <Table
                    size="middle"
                    rowKey="model"
                    dataSource={models}
                    columns={columns}
                    scroll={{ x: 760 }}
                    pagination={{ pageSize: 10, showSizeChanger: false, hideOnSinglePage: true }}
                  />
                </Panel>
              </>
            )}
            <Updated>{updatedAt ? t('usage_statistics.updated', { time: updatedAt }) : null}</Updated>
          </>
        ) : null}
      </Content>
    </Page>
  )
}

const Page = styled.div`display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--color-background);`
const Content = styled.div`flex: 1; overflow: auto; padding: 28px 32px 40px; width: 100%; max-width: 1280px; margin: 0 auto; box-sizing: border-box; @media (max-width: 850px) { padding: 20px 16px; }`
const Header = styled.div`display: flex; justify-content: space-between; gap: 16px; align-items: center; margin-bottom: 24px;`
const Heading = styled.h1`font-size: 24px; font-weight: 600; display: flex; align-items: center; gap: 10px; margin: 0; svg { color: var(--color-primary); }`
const Subtitle = styled.p`color: var(--color-text-2); margin: 8px 0 0; font-size: 13px;`
const Panel = styled.section`border: 1px solid var(--color-border); border-radius: 16px; padding: 20px; margin-bottom: 20px; background: var(--color-background-soft); min-width: 0;`
const Filters = styled.div`display: flex; flex-wrap: wrap; gap: 12px; align-items: center; & + & { margin-top: 14px; }`
const Cards = styled.div`display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; margin: 24px 0; @media (max-width: 1000px) { grid-template-columns: repeat(2, minmax(0, 1fr)); }`
const Metric = styled.div`border: 1px solid var(--color-border); border-radius: 16px; padding: 20px; background: var(--color-background-soft); min-width: 0;`
const MetricLabel = styled.div`font-size: 13px; color: var(--color-text-2); margin-bottom: 12px;`
const MetricValue = styled.div`font-size: clamp(20px, 2.1vw, 30px); font-weight: 600; font-variant-numeric: tabular-nums; letter-spacing: -0.5px; overflow-wrap: anywhere;`
const MetricHint = styled.div`font-size: 11px; color: var(--color-text-3); margin-top: 8px;`
const SectionHeader = styled.div`display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin-bottom: 16px; h3 { margin: 0; font-size: 15px; font-weight: 600; }`
const EmptyBlock = styled.div`padding: 64px 20px; text-align: center;`
const Updated = styled.div`text-align: right; font-size: 12px; color: var(--color-text-3);`
