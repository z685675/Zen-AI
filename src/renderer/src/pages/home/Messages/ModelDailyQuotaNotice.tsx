import type { Message } from '@renderer/types/newMessage'
import { readModelDailyQuotaResults } from '@shared/utils/modelDailyQuotaTurn'
import { Info } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

const beijingDate = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())

export default function ModelDailyQuotaNotice({ message, processing }: { message: Message; processing: boolean }) {
  const { t } = useTranslation()
  const [today, setToday] = useState(beijingDate)
  const results = readModelDailyQuotaResults(message.providerMetadata?.modelDailyQuota?.results).filter(
    (result) => result.current_date === today
  )
  useEffect(() => {
    if (results.length === 0) return
    const delay = 86_400_000 - ((Date.now() + 8 * 3_600_000) % 86_400_000) + 50
    const timer = setTimeout(() => setToday(beijingDate()), delay)
    return () => clearTimeout(timer)
  }, [today, results.length])
  if (processing || results.length === 0) return null
  return (
    <div
      role="status"
      className="mx-2 my-2 flex items-start gap-2 rounded-md bg-[var(--color-background-soft)] px-3 py-2 text-[var(--color-text-2)] text-xs">
      <Info size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
      <span>
        {t('model_daily_quota.turn_exceeded', {
          model: [...new Set(results.map((result) => result.model))].join(', ')
        })}
      </span>
    </div>
  )
}
