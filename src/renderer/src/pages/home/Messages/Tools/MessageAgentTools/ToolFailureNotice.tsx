import { readAssistantToolFailure } from '@shared/agents/toolFailure'
import { TriangleAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'

const translationKeys = {
  cancelled: ['assistantToolFailure.cancelled.summary', 'assistantToolFailure.cancelled.next'],
  permission: ['assistantToolFailure.permission.summary', 'assistantToolFailure.permission.next'],
  missing_file: ['assistantToolFailure.missing_file.summary', 'assistantToolFailure.missing_file.next'],
  file_busy: ['assistantToolFailure.file_busy.summary', 'assistantToolFailure.file_busy.next'],
  dependency: ['assistantToolFailure.dependency.summary', 'assistantToolFailure.dependency.next'],
  runtime: ['assistantToolFailure.runtime.summary', 'assistantToolFailure.runtime.next'],
  validation: ['assistantToolFailure.validation.summary', 'assistantToolFailure.validation.next'],
  invalid_input: ['assistantToolFailure.invalid_input.summary', 'assistantToolFailure.invalid_input.next'],
  rate_limit: ['assistantToolFailure.rate_limit.summary', 'assistantToolFailure.rate_limit.next'],
  timeout: ['assistantToolFailure.timeout.summary', 'assistantToolFailure.timeout.next'],
  network: ['assistantToolFailure.network.summary', 'assistantToolFailure.network.next'],
  unknown: ['assistantToolFailure.unknown.summary', 'assistantToolFailure.unknown.next']
} as const

export function ToolFailureNotice({ response }: { response: unknown }) {
  const { t } = useTranslation()
  const failure = readAssistantToolFailure(response)
  if (!failure) return null
  const [summaryKey, nextKey] = translationKeys[failure.code]
  return (
    <div role="status" className="max-w-full rounded border border-[var(--color-border)] px-3 py-2 text-xs">
      <div className="flex items-start gap-2">
        <TriangleAlert size={14} className="mt-0.5 shrink-0 text-[var(--color-text-2)]" />
        <div>
          <div>{t(summaryKey)}</div>
          <div className="mt-1 text-[var(--color-text-2)]">{t(nextKey)}</div>
        </div>
      </div>
      <details className="mt-1">
        <summary className="cursor-pointer text-[var(--color-text-2)]">{t('assistantToolFailure.details')}</summary>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words">{failure.details}</pre>
      </details>
    </div>
  )
}
