import SendMessageButton from '@renderer/pages/home/Inputbar/SendMessageButton'
import { useTranslation } from 'react-i18next'

/** No active input hooks, drafts, attachments or keyboard-submit handlers. */
export default function LegacyAssistantInputbar() {
  const { t } = useTranslation()
  const notice = t('assistant_transition.legacy_read_only')
  return (
    <div className="mx-auto w-full max-w-[calc(var(--zen-composer-width,880px)+64px)] shrink-0 px-8 pt-2 pb-4">
      <div
        className="rounded-[var(--zen-radius-xl)] px-5 pt-4 pb-3"
        style={{
          background: 'var(--zen-glass-card)',
          backdropFilter: 'blur(28px) saturate(160%)',
          boxShadow: 'var(--zen-shadow-card)'
        }}
        aria-label={notice}>
        <textarea
          disabled
          value=""
          placeholder={notice}
          aria-label={notice}
          rows={2}
          className="w-full resize-none border-0 bg-transparent px-1 text-(--zen-text-3) text-sm outline-none disabled:cursor-not-allowed disabled:opacity-100"
        />
        <div className="flex justify-end">
          <SendMessageButton disabled sendMessage={() => {}} />
        </div>
      </div>
    </div>
  )
}
