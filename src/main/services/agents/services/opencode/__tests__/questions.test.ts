import { describe, expect, it, vi } from 'vitest'

import { answerOpenCodeQuestion, type OpenCodeQuestion } from '../questions'

const question: OpenCodeQuestion = {
  id: 'question-one',
  sessionID: 'child',
  tool: { callID: 'ask' },
  questions: [
    {
      question: 'Choose a format',
      header: 'Format',
      options: [{ label: 'Word, PDF' }, { label: 'PPT' }],
      multiple: true
    }
  ]
}
function fixture(updatedInput?: Record<string, unknown>) {
  const request = vi.fn().mockResolvedValue(undefined)
  const ask = vi
    .fn()
    .mockResolvedValue(updatedInput ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: 'cancelled' })
  const controller = new AbortController()
  return {
    request,
    ask,
    controller,
    run: (value = question) =>
      answerOpenCodeQuestion({
        question: value,
        client: { request },
        toolCallId: 'zen:child:child:ask',
        signal: controller.signal,
        ask
      })
  }
}

describe('native clarification reply bridge', () => {
  it('preserves multi-select values containing commas and accepts a free text answer', async () => {
    const f = fixture({ nativeAnswers: [['Word, PDF', 'Custom format']] })
    await f.run()
    expect(f.ask).toHaveBeenCalledWith(
      'question',
      expect.objectContaining({ questions: [expect.objectContaining({ multiSelect: true, allowCustom: true })] }),
      expect.objectContaining({ toolCallId: 'zen:child:child:ask' })
    )
    expect(f.request).toHaveBeenCalledWith(
      '/question/question-one/reply',
      'POST',
      { answers: [['Word, PDF', 'Custom format']] },
      expect.any(AbortSignal)
    )
  })
  it('reports a dismissed question as unanswered without using the native processor stop', async () => {
    const f = fixture()
    await f.run()
    expect(f.controller.signal.aborted).toBe(false)
    expect(f.request).toHaveBeenCalledWith(
      '/question/question-one/reply',
      'POST',
      { answers: [[]] },
      expect.any(AbortSignal)
    )
  })
  it.each([{}, { nativeAnswers: [] }, { nativeAnswers: [['A', 'B']] }])(
    'rejects missing or malformed single-choice answers: %j',
    async (input) => {
      const f = fixture(input)
      await f.run({ ...question, questions: [{ ...question.questions[0], multiple: false }] })
      expect(f.request.mock.calls[0][0]).toBe('/question/question-one/reject')
    }
  )
  it('enforces a question that disables custom answers', async () => {
    const f = fixture({ nativeAnswers: [['Unlisted answer']] })
    await f.run({ ...question, questions: [{ ...question.questions[0], custom: false }] })
    expect(f.request.mock.calls[0][0]).toBe('/question/question-one/reject')
  })
  it('does not submit a stale answer after task cancellation', async () => {
    const f = fixture({ nativeAnswers: [['PPT']] })
    f.ask.mockImplementation(async () => {
      f.controller.abort('cancel')
      return { behavior: 'allow', updatedInput: { nativeAnswers: [['PPT']] } }
    })
    await f.run()
    expect(f.request).not.toHaveBeenCalled()
  })
})
