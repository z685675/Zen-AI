import { useEffect, useId, useRef } from 'react'
import { useTranslation } from 'react-i18next'

export function PromptEditorModal({
  title,
  value,
  placeholder,
  maxLength = 32000,
  readOnly = false,
  onChange,
  onSubmit,
  onClose
}: {
  title?: string
  value: string
  placeholder?: string
  maxLength?: number
  readOnly?: boolean
  onChange?: (value: string) => void
  onSubmit?: () => void
  onClose: () => void
}) {
  const { t } = useTranslation()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = dialogRef.current
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    if (dialog && typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal()
    }
    const input = textareaRef.current
    if (input) {
      input.focus()
      if (!readOnly) {
        const end = input.value.length
        input.setSelectionRange(end, end)
      }
    }
    return () => {
      if (dialog && typeof dialog.close === 'function' && dialog.open) {
        dialog.close()
      }
      previous?.focus()
    }
  }, [readOnly])

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="modal prompt-editor-modal"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}>
      <header className="prompt-editor-header">
        <strong id={titleId}>{title || t(readOnly ? 'fullPromptTitle' : 'promptEditorTitle')}</strong>
        <button type="button" className="modal-close-btn" aria-label={t('close')} onClick={onClose}>
          ×
        </button>
      </header>
      <div className="prompt-editor-body">
        <textarea
          ref={textareaRef}
          className="prompt-editor-textarea"
          aria-label={title || t('prompt')}
          value={value}
          readOnly={readOnly}
          maxLength={readOnly ? undefined : maxLength}
          placeholder={readOnly ? undefined : placeholder}
          onChange={readOnly ? undefined : (event) => onChange?.(event.target.value)}
          onKeyDown={(event) => {
            if (
              !readOnly &&
              (event.ctrlKey || event.metaKey) &&
              event.key === 'Enter' &&
              !event.nativeEvent.isComposing &&
              !event.repeat
            ) {
              event.preventDefault()
              onClose()
              onSubmit?.()
            }
          }}
        />
      </div>
      <footer className="prompt-editor-footer">
        <small className="muted prompt-editor-meta">
          {t('promptCharCount', { count: value.length })}
          {!readOnly && onSubmit ? ` · ${t('promptEditorShortcut')}` : ''}
        </small>
        <div className="actions">
          {readOnly && (
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard?.writeText(value)
              }}>
              {t('copyPrompt')}
            </button>
          )}
          <button type="button" className="primary" onClick={onClose}>
            {t(readOnly ? 'close' : 'done')}
          </button>
        </div>
      </footer>
    </dialog>
  )
}
