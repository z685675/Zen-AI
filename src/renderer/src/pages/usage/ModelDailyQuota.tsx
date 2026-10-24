import {
  fetchModelDailyQuota,
  type ModelDailyQuotaStatus,
  type UsageSource
} from '@renderer/services/UsageStatisticsService'
import { Alert, Table, Typography } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function ModelDailyQuota(props: { source?: UsageSource; revision: number }) {
  const { t } = useTranslation()
  const [state, setState] = useState<{ source: UsageSource; data?: ModelDailyQuotaStatus; error?: boolean }>()
  useEffect(() => {
    if (!props.source?.supported) return
    const source = props.source
    const controller = new AbortController()
    const refresh = () => {
      void fetchModelDailyQuota(source, controller.signal).then(
        (data) => {
          if (!controller.signal.aborted) setState({ source, data })
        },
        () => {
          if (!controller.signal.aborted) setState({ source, error: true })
        }
      )
    }
    refresh()
    const timer = setInterval(refresh, 60_000)
    return () => {
      controller.abort()
      clearInterval(timer)
    }
  }, [props.source, props.revision])
  const current = state?.source === props.source ? state : undefined
  if (current?.error) return <Alert type="warning" showIcon message={t('model_daily_quota.status_error')} />
  if (!current?.data?.models.length) return null
  return (
    <section>
      <Typography.Title level={5}>
        {t('model_daily_quota.title')} · {current.data.date}
      </Typography.Title>
      <Typography.Paragraph type="secondary">{t('model_daily_quota.hint')}</Typography.Paragraph>
      <Table
        size="small"
        rowKey="model"
        pagination={false}
        dataSource={current.data.models}
        columns={[
          { title: t('usage_statistics.model'), dataIndex: 'model' },
          { title: t('model_daily_quota.used'), dataIndex: 'used', render: (value: number) => value.toLocaleString() },
          {
            title: t('model_daily_quota.limit'),
            dataIndex: 'limit',
            render: (value: number) => value.toLocaleString()
          },
          {
            title: t('model_daily_quota.remaining'),
            dataIndex: 'remaining',
            render: (value: number, row) => (row.exhausted ? t('model_daily_quota.used_up') : value.toLocaleString())
          }
        ]}
      />
    </section>
  )
}
