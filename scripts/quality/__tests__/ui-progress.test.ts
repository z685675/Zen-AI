import { describe, expect, it } from 'vitest'

import { inferUIWaitPhase } from '../ui-progress'

describe('quality UI waiting phase', () => {
  it('distinguishes model wait, native tool work, and explicit permission wait', () => {
    expect(inferUIWaitPhase([], [])).toBe('model')
    const tools = [{ toolCallId: 'session:write', status: 'pending' }]
    expect(inferUIWaitPhase(tools, [])).toBe('tool')
    expect(inferUIWaitPhase(tools, [{ toolCallId: 'session:write', status: 'pending' }])).toBe('permission')
    expect(inferUIWaitPhase(tools, [{ toolCallId: 'session:write', status: 'submitting-deny' }])).toBe('permission')
    expect(inferUIWaitPhase(tools, [{ toolCallId: 'session:write', status: 'invoking' }])).toBe('tool')
    expect(inferUIWaitPhase([{ ...tools[0], status: 'done' }], [])).toBe('model')
  })

  it('does not label a completed tool or another session as waiting for permission', () => {
    expect(inferUIWaitPhase([], [{ toolCallId: 'old:write', status: 'pending' }])).toBe('model')
    expect(
      inferUIWaitPhase(
        [{ toolCallId: 'new:write', status: 'pending' }],
        [{ toolCallId: 'old:write', status: 'pending' }]
      )
    ).toBe('tool')
    expect(inferUIWaitPhase([{ status: 'done' }], [{ status: 'pending' }])).toBe('model')
    expect(inferUIWaitPhase([{ toolCallId: 'same:write', status: 'error' }], [])).toBe('model')
  })
})
