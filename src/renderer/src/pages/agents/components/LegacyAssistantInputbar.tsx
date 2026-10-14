import SendMessageButton from '@renderer/pages/home/Inputbar/SendMessageButton'
import { useTranslation } from 'react-i18next'

/** No active input hooks, drafts, attachments or keyboard-submit handlers. */
export default function LegacyAssistantInputbar() {
  const { t } = useTranslation()
  const notice = t('assistant_transition.legacy_read_only')
  return (
    <div className="mx-auto w-full max-w-[960px] shrink-0 px-4.5 pb-3">
      <div
        className="rounded-xl border border-(--color-border) bg-(--color-background-soft) px-3 pt-3 pb-2"
        aria-label={notice}>
        <textarea
          disabled
          value=""
          placeholder={notice}
          aria-label={notice}
          rows={2}
          className="w-full resize-none border-0 bg-transparent text-(--color-text-3) text-sm outline-none disabled:cursor-not-allowed disabled:opacity-100"
        />
        <div className="flex justify-end">
          <SendMessageButton disabled sendMessage={() => {}} />
        </div>
      </div>
    </div>
  )
}
