import type { ModelRecoveryIntent } from '@shared/config/modelRecovery'
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { ModelRecoveryNotice, SessionModelRecoveryNotice } from '..'

vi.mock('@renderer/store', () => ({ useAppSelector: () => [] }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@renderer/services/modelRecoveryIntents', () => ({ modelRecoveryIntents: {} }))

describe('model recovery notice is informational only', () => {
  it('does not display a normal or manually selected model', () => {
    const { container } = render(<ModelRecoveryNotice intent={{ preferred: 'p:A', actual: 'p:A' }} />)
    expect(container).toBeEmptyDOMElement()
  })
  it('shows fallback and recovery observation without any model request', () => {
    render(<ModelRecoveryNotice intent={{ preferred: 'p:A', actual: 'p:B', recoveredAt: Date.now() }} />)
    expect(screen.getByRole('status')).toHaveTextContent('model_recovery.fallback')
    expect(screen.getByRole('status')).toHaveTextContent('model_recovery.observing')
  })
  it('distinguishes all fallbacks unavailable from a network error', () => {
    render(<ModelRecoveryNotice intent={{ preferred: 'p:A', actual: null }} />)
    expect(screen.getByRole('status')).toHaveTextContent('model_recovery.empty')
  })
  it('ignores an old session response after navigation without reconciling models', async () => {
    let resolveOld!: (value: ModelRecoveryIntent) => void
    const recoveryStatus = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<ModelRecoveryIntent>((resolve) => {
            resolveOld = resolve
          })
      )
      .mockResolvedValueOnce(undefined)
    const reconcileSessions = vi.fn()
    const previous = window.api.modelPolicy
    window.api.modelPolicy = { ...previous, recoveryStatus, reconcileSessions }
    try {
      const { rerender } = render(<SessionModelRecoveryNotice agentId="agent" sessionId="old" model="p:B" />)
      rerender(<SessionModelRecoveryNotice agentId="agent" sessionId="new" model="p:B" />)
      await act(async () => {
        resolveOld({ preferred: 'p:A', actual: 'p:B' })
      })
      expect(screen.queryByRole('status')).toBeNull()
      expect(recoveryStatus).toHaveBeenCalledTimes(2)
      expect(reconcileSessions).not.toHaveBeenCalled()
    } finally {
      window.api.modelPolicy = previous
    }
  })
})
