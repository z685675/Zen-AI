import { ERROR_I18N_KEY_STREAM_PAUSED } from '@renderer/types/error'
import type { ErrorMessageBlock, Message } from '@renderer/types/newMessage'

export function isUserStoppedMessage(message: Message, block?: ErrorMessageBlock): boolean {
  const outcome = message.providerMetadata?.responseTiming?.outcome
  if (outcome) return outcome === 'cancelled'
  // Legacy saved messages have no timing metadata. Only the explicit pause
  // marker qualifies; AbortError-looking network failures must remain errors.
  return block?.error?.i18nKey === ERROR_I18N_KEY_STREAM_PAUSED
}
