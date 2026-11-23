import type { QuickPhrase } from '@renderer/types'
import type { TFunction } from 'i18next'

const command = /^\/([\p{L}\p{N}][\p{L}\p{N}_-]{0,39})(?=\s|$)/u

export function assistantTaskCommands(t: TFunction, phrases: Pick<QuickPhrase, 'title' | 'content'>[] = []) {
  const builtins = [
    { id: 'review', label: t('assistantTaskCommands.review'), template: t('assistantTaskCommands.reviewPrompt') },
    { id: 'organize', label: t('assistantTaskCommands.organize'), template: t('assistantTaskCommands.organizePrompt') },
    { id: 'check', label: t('assistantTaskCommands.check'), template: t('assistantTaskCommands.checkPrompt') }
  ]
  const results = new Map<string, { id: string; label: string; template: string }>(
    builtins.map((entry) => [entry.id, entry])
  )
  for (const phrase of phrases) {
    const title = phrase.title.trim()
    const match = command.exec(title)
    if (!match || match[0] !== title || !phrase.content.trim()) continue
    const id = match[1]
    if (!results.has(id)) results.set(id, { id, label: title, template: phrase.content })
  }
  return results
}

export function selectAssistantTaskCommand(text: string, selected: string) {
  const current = command.exec(text)
  return `${selected} ${current ? text.slice(current[0].length).trimStart() : text}`
}

export async function expandAssistantTaskCommand(text: string, t: TFunction) {
  const match = command.exec(text)
  if (!match) return text
  const id = match[1]
  let entry = assistantTaskCommands(t).get(id)
  if (!entry) {
    const { default: service } = await import('@renderer/services/QuickPhraseService')
    entry = assistantTaskCommands(t, await service.getAll().catch(() => [])).get(id)
  }
  if (!entry) return text
  const args = text.slice(match[0].length).trim()
  return entry.template.includes('$ARGUMENTS')
    ? entry.template.replaceAll('$ARGUMENTS', () => args)
    : [entry.template, args].filter(Boolean).join('\n\n')
}
