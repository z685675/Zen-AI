import { ArrowUp, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  disabled?: boolean
  sendMessage: () => void
  stop?: boolean
}

export default function SendMessageButton({ disabled = false, sendMessage, stop = false }: Props) {
  const { t } = useTranslation()
  const label = stop ? t('chat.input.pause') : t('chat.input.send')
  return (
    <Button type="button" disabled={disabled} onClick={sendMessage} aria-label={label} title={label}>
      {stop ? <Square size={12} fill="currentColor" /> : <ArrowUp size={16} strokeWidth={2.3} />}
    </Button>
  )
}

const Button = styled.button`
  display: grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  color: var(--color-primary-foreground);
  background: var(--color-primary);
  cursor: pointer;

  &:disabled {
    color: var(--zen-text-3);
    background: var(--zen-bg-subtle);
    cursor: not-allowed;
  }

  &:focus-visible {
    outline: 2px solid var(--zen-accent);
    outline-offset: 2px;
  }

  svg {
    color: inherit;
  }
`
