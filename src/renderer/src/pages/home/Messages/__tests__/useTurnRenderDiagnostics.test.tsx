import { getDiagnosticEvidence, recordDiagnostic } from '@renderer/services/DiagnosticEvidenceService'
import { AssistantMessageStatus, type Message } from '@renderer/types/newMessage'
import type { DiagnosticEvidence } from '@shared/diagnostics'
import { buildTurnPerformance } from '@shared/turnPerformance'
import { LIVE_RENDER_MEASUREMENT } from '@shared/turnRenderTiming'
import { act, render } from '@testing-library/react'
import { StrictMode, useRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useTurnRenderDiagnostics } from '../useTurnRenderDiagnostics'

vi.mock('@renderer/services/DiagnosticEvidenceService', () => ({
  getDiagnosticEvidence: vi.fn(),
  recordDiagnostic: vi.fn()
}))

const at = (ms: number) => new Date(Date.UTC(2026, 9, 27) + ms).toISOString()
let evidence: DiagnosticEvidence
let visibility: DocumentVisibilityState

function message(status = AssistantMessageStatus.PROCESSING, id = 'reply'): Message {
  return {
    id,
    role: 'assistant',
    status,
    ...(status === 'success' || status === 'error' || status === 'paused'
      ? { providerMetadata: { responseTiming: { startedAt: at(0), finishedAt: at(10000), elapsedMs: 10000 } } }
      : {})
  } as Message
}

function Reply({ value, hidden = false }: { value: Message; hidden?: boolean }) {
  const root = useRef<HTMLDivElement>(null)
  useTurnRenderDiagnostics(value, root)
  return <div ref={root} hidden={hidden} />
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(at(1000))
  visibility = 'visible'
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  evidence = {
    operationId: 'reply',
    metadata: { runtimeOperationId: 'op-1' },
    startedAt: at(0),
    updatedAt: at(0),
    events: [],
    droppedEvents: 0
  }
  vi.mocked(getDiagnosticEvidence).mockImplementation(() => evidence)
  vi.mocked(recordDiagnostic).mockImplementation((_id, stage, event, details) => {
    evidence.events.push({ at: new Date().toISOString(), stage, event, details })
  })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('live turn render measurement', () => {
  it.each([AssistantMessageStatus.SUCCESS, AssistantMessageStatus.ERROR, AssistantMessageStatus.PAUSED])(
    'records a visible live terminal transition to %s once',
    (status) => {
      const { rerender } = render(<Reply value={message()} />)
      vi.setSystemTime(at(10200))
      rerender(<Reply value={message(status)} />)
      expect(recordDiagnostic).toHaveBeenCalledOnce()
      expect(evidence.events[0].details).toMatchObject({
        measurement: LIVE_RENDER_MEASUREMENT,
        observedActiveAt: at(1000),
        responseFinishedAt: at(10000)
      })
      expect(
        buildTurnPerformance({ events: evidence.events, startedAt: at(0), finishedAt: at(10000) }).renderCommitDelayMs
      ).toBe(200)
      vi.setSystemTime(at(184848))
      rerender(<Reply value={message(status)} />)
      expect(recordDiagnostic).toHaveBeenCalledOnce()
    }
  )

  it('does not backfill an already finished message opened much later, including StrictMode mounts', () => {
    vi.setSystemTime(at(184848))
    render(
      <StrictMode>
        <Reply value={message(AssistantMessageStatus.SUCCESS)} />
      </StrictMode>
    )
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('does not measure a live reply unmounted for navigation and reopened after completion', () => {
    const first = render(<Reply value={message()} />)
    first.unmount()
    vi.setSystemTime(at(184848))
    render(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('does not reuse the previous message observation when the same component switches conversations', () => {
    const { rerender } = render(<Reply value={message()} />)
    vi.setSystemTime(at(184848))
    rerender(<Reply value={message(AssistantMessageStatus.SUCCESS, 'another-reply')} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('invalidates background observations even if the window is visible again when React commits', () => {
    const { rerender } = render(<Reply value={message()} />)
    act(() => {
      visibility = 'hidden'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    vi.setSystemTime(at(184848))
    act(() => {
      visibility = 'visible'
      document.dispatchEvent(new Event('visibilitychange'))
    })
    rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('does not measure hidden message containers or active components restored after the response ended', () => {
    const { rerender, unmount } = render(<Reply value={message()} />)
    vi.setSystemTime(at(10200))
    rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} hidden />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
    unmount()
    vi.setSystemTime(at(184848))
    const restored = render(<Reply value={message()} />)
    restored.rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('does not match an observation to a different request operation on the same message', () => {
    const { rerender } = render(<Reply value={message()} />)
    evidence.metadata.runtimeOperationId = 'op-2'
    vi.setSystemTime(at(10200))
    rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('invalidates a mounted conversation hidden by an ancestor and shown again after completion', async () => {
    const { container, rerender } = render(<Reply value={message()} />)
    await act(async () => {
      container.style.display = 'none'
      await Promise.resolve()
    })
    vi.setSystemTime(at(184848))
    await act(async () => {
      container.style.display = ''
      await Promise.resolve()
    })
    rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })

  it('does not manufacture timing when the response finish or request evidence is missing', () => {
    const { rerender, unmount } = render(<Reply value={message()} />)
    rerender(<Reply value={{ ...message(), status: AssistantMessageStatus.SUCCESS }} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
    unmount()
    vi.mocked(getDiagnosticEvidence).mockReturnValue(undefined)
    const noEvidence = render(<Reply value={message()} />)
    vi.setSystemTime(at(10200))
    noEvidence.rerender(<Reply value={message(AssistantMessageStatus.SUCCESS)} />)
    expect(recordDiagnostic).not.toHaveBeenCalled()
  })
})
