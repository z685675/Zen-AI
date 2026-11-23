import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk'

import type { OpenCodeClient } from './client'

type Question = {
  question: string
  header: string
  options: Array<{ label: string; description?: string }>
  multiple?: boolean
  custom?: boolean
}
export type OpenCodeQuestion = { id: string; sessionID: string; questions: Question[]; tool?: { callID?: string } }

/** Reuse the existing durable permission form, while replying to the native question. */
export async function answerOpenCodeQuestion(input: {
  question: OpenCodeQuestion
  client: Pick<OpenCodeClient, 'request'>
  toolCallId: string
  signal: AbortSignal
  ask: (
    name: string,
    value: Record<string, unknown>,
    options: { signal: AbortSignal; toolCallId: string }
  ) => Promise<PermissionResult>
}) {
  const { question, client, signal } = input
  const route = `/question/${encodeURIComponent(question.id)}`
  const valid =
    Array.isArray(question.questions) &&
    question.questions.length > 0 &&
    question.questions.length <= 16 &&
    question.questions.every(
      (q) =>
        q &&
        typeof q.question === 'string' &&
        q.question.length <= 4000 &&
        typeof q.header === 'string' &&
        q.header.length <= 80 &&
        Array.isArray(q.options) &&
        q.options.length <= 32 &&
        q.options.every(
          (o) =>
            o &&
            typeof o.label === 'string' &&
            o.label.length <= 512 &&
            (o.description === undefined || (typeof o.description === 'string' && o.description.length <= 2000))
        )
    )
  if (!valid) {
    await client.request(`${route}/reject`, 'POST', {}, signal)
    return
  }
  const questions = question.questions.map((q) => ({
    ...q,
    multiSelect: q.multiple === true,
    allowCustom: q.custom !== false
  }))
  const result = await input.ask('question', { questions }, { signal, toolCallId: input.toolCallId })
  if (signal.aborted) return
  if (result.behavior === 'deny') {
    // Native reject is a processor stop. A skipped clarification instead has
    // empty answers, which the native tool explicitly reports as Unanswered.
    await client.request(`${route}/reply`, 'POST', { answers: questions.map(() => []) }, signal)
    return
  }
  const answers = result.behavior === 'allow' ? result.updatedInput?.nativeAnswers : undefined
  const complete =
    Array.isArray(answers) &&
    answers.length === questions.length &&
    answers.every(
      (list, index) =>
        Array.isArray(list) &&
        list.length > 0 &&
        list.length <= 33 &&
        (questions[index].multiSelect || list.length === 1) &&
        list.every(
          (value) =>
            typeof value === 'string' &&
            value.trim().length > 0 &&
            value.length <= 4000 &&
            (questions[index].allowCustom || questions[index].options.some((option) => option.label === value))
        )
    )
  if (complete) await client.request(`${route}/reply`, 'POST', { answers }, signal)
  else await client.request(`${route}/reject`, 'POST', {}, signal)
}
