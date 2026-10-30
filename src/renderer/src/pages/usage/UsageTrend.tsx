import { Tooltip } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import type { UsageTrendBucket } from './usageUtils'

const tokenSeries = [
  { field: 'input_tokens', label: 'usage_statistics.input', color: '#6374e9' },
  { field: 'output_tokens', label: 'usage_statistics.output', color: '#ed9a50' },
  { field: 'cache_tokens', label: 'usage_statistics.cache', color: '#26ac93' }
] as const
const imageSeries = [
  { field: 'image_request_count', label: 'usage_statistics.image_requests', color: '#6374e9' }
] as const

export default function UsageTrend({
  days,
  mode = 'tokens'
}: {
  days: UsageTrendBucket[]
  mode?: 'tokens' | 'images'
}) {
  const { t, i18n } = useTranslation()
  const series = mode === 'images' ? imageSeries : tokenSeries
  const [activeBucket, setActiveBucket] = useState<UsageTrendBucket | null>(null)
  // New results must not keep a tooltip from the previous date/source selection.
  const activeDay = activeBucket && days.includes(activeBucket) ? activeBucket : null
  const exact = (value: number) => value.toLocaleString(i18n.language)
  const format = (value: number) =>
    new Intl.NumberFormat(i18n.language, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
  const maximum = Math.max(1, ...days.map((day) => Math.max(...series.map((item) => day[item.field] ?? 0))))
  const x = (index: number) => (days.length === 1 ? 465 : 60 + (index * 810) / Math.max(days.length - 1, 1))
  const y = (value: number) => 210 - (value * 170) / maximum
  const yTicks = [...new Set([0, mode === 'images' ? Math.floor(maximum / 2) : maximum / 2, maximum])]
  const ticks = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])].filter(
    (index) => index >= 0 && index < days.length
  )
  return (
    <Chart>
      <Legend>
        {series.map((item) => (
          <span key={item.field}>
            <Dot $color={item.color} />
            {t(item.label)}
          </span>
        ))}
      </Legend>
      <svg
        role="group"
        aria-label={t(mode === 'images' ? 'usage_statistics.image_trend' : 'usage_statistics.trend')}
        viewBox="0 0 900 252">
        {yTicks.map((value) => (
          <g key={value}>
            <line x1="60" x2="870" y1={y(value)} y2={y(value)} stroke="currentColor" opacity="0.08" />
            <text x="50" y={y(value) + 4} textAnchor="end">
              {format(value)}
            </text>
          </g>
        ))}
        {activeDay ? (
          <line
            x1={x(days.indexOf(activeDay))}
            x2={x(days.indexOf(activeDay))}
            y1="24"
            y2="218"
            stroke="currentColor"
            strokeDasharray="4 4"
            opacity="0.2"
            pointerEvents="none"
          />
        ) : null}
        {series.map((item) => {
          let path = ''
          let connected = false
          days.forEach((day, index) => {
            const value = day[item.field] ?? (day.request_count === (day.image_request_count ?? 0) ? 0 : null)
            if (value === null) {
              connected = false
              return
            }
            path += `${connected ? 'L' : 'M'}${x(index)},${y(value)} `
            connected = true
          })
          return (
            <g key={item.field}>
              <path
                d={path}
                fill="none"
                stroke={item.color}
                strokeWidth="2.5"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
              {days.map((day, index) => {
                const value = day[item.field] ?? (day.request_count === (day.image_request_count ?? 0) ? 0 : null)
                if (value === null) return null
                return (
                  <circle
                    key={day.date}
                    cx={x(index)}
                    cy={y(value)}
                    r={activeDay === day ? 5 : days.length > 90 ? 2 : 3.5}
                    fill={item.color}
                  />
                )
              })}
            </g>
          )
        })}
        {ticks.map((index) => (
          <text key={index} x={x(index)} y="240" textAnchor="middle">
            {days[index].date}
          </text>
        ))}
        {days.map((day, index) => {
          const date = day.startDate === day.endDate ? day.startDate : `${day.startDate} — ${day.endDate}`
          const left = index === 0 ? 52 : (x(index - 1) + x(index)) / 2
          const right = index === days.length - 1 ? 878 : (x(index) + x(index + 1)) / 2
          const cache = day.cache_tokens ?? (day.request_count === (day.image_request_count ?? 0) ? 0 : null)
          const partial =
            cache !== null && day.cache_known_requests < day.request_count - (day.image_request_count ?? 0)
          const values = series.map((item) =>
            item.field === 'cache_tokens'
              ? cache === null
                ? '—'
                : `${partial ? '≥ ' : ''}${exact(cache)}`
              : exact(day[item.field] ?? 0)
          )
          return (
            <Tooltip
              key={day.date}
              open={activeDay === day}
              onOpenChange={(open) => setActiveBucket((current) => (open ? day : current === day ? null : current))}
              trigger={['hover', 'focus', 'click']}
              mouseEnterDelay={0}
              mouseLeaveDelay={0}
              destroyOnHidden
              title={
                <TooltipContent>
                  <TooltipHeading>{date}</TooltipHeading>
                  {series.map((item, seriesIndex) => (
                    <TooltipRow key={item.field}>
                      <span>
                        <Dot $color={item.color} />
                        {t(item.label)}
                      </span>
                      <strong>{values[seriesIndex]}</strong>
                    </TooltipRow>
                  ))}
                  {mode === 'tokens' && (cache === null || partial) ? (
                    <TooltipNote>
                      {t(cache === null ? 'usage_statistics.cache_unknown' : 'usage_statistics.cache_partial')}
                    </TooltipNote>
                  ) : null}
                </TooltipContent>
              }>
              <rect
                role="button"
                tabIndex={0}
                aria-label={`${date} · ${series.map((item, seriesIndex) => `${t(item.label)}: ${values[seriesIndex]}`).join(' · ')}`}
                x={left}
                y="24"
                width={right - left}
                height="194"
                fill="transparent"
                pointerEvents="all"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setActiveBucket(null)
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setActiveBucket((current) => (current === day ? null : day))
                  }
                }}
              />
            </Tooltip>
          )
        })}
      </svg>
    </Chart>
  )
}

const Chart = styled.div`
  svg { display: block; width: 100%; height: auto; max-height: 300px; color: var(--color-text); }
  text { fill: var(--color-text-2); font: 12px sans-serif; }
`
const Legend = styled.div`
  display: flex; gap: 20px; justify-content: flex-end; font-size: 12px; color: var(--color-text-2);
  span { display: inline-flex; gap: 6px; align-items: center; }
`
const Dot = styled.i<{ $color: string }>`width: 8px; height: 8px; border-radius: 50%; background: ${(p) => p.$color};`
const TooltipContent = styled.div`min-width: 190px;`
const TooltipHeading = styled.div`font-weight: 600; margin-bottom: 8px;`
const TooltipRow = styled.div`
  display: flex; justify-content: space-between; gap: 18px; margin-top: 4px;
  span { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  strong { font-weight: 500; font-variant-numeric: tabular-nums; }
`
const TooltipNote = styled.div`font-size: 11px; opacity: 0.8; max-width: 240px; margin-top: 8px;`
