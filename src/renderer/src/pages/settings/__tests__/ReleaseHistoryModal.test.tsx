import type { ReleaseHistorySnapshot } from '@shared/releaseHistory'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import ReleaseHistoryModal from '../ReleaseHistoryModal'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.split('.').at(-1), i18n: { resolvedLanguage: 'en-US' } })
}))
const get = vi.fn()
const refresh = vi.fn()
const openWebsite = vi.fn()
const local: ReleaseHistorySnapshot = {
  currentVersion: '1.1.79',
  refreshedAt: null,
  refreshFailed: false,
  entries: [
    { version: '1.1.80', notes: 'Later published release', releaseDate: '2026-11-01T00:00:00Z' },
    { version: '1.1.79', notes: 'Offline current notes', releaseDate: null }
  ]
}
beforeEach(() => {
  get.mockReset().mockResolvedValue(local)
  refresh.mockReset().mockReturnValue(new Promise(() => {}))
  openWebsite.mockReset()
  ;(window as any).api = { releaseHistory: { get, refresh }, openWebsite }
})
afterEach(() => {
  document.body.innerHTML = ''
})

it('renders local notes before background refresh, marks the current version and browses by version', async () => {
  let finish!: (next: ReleaseHistorySnapshot) => void
  refresh.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve
    })
  )
  render(<ReleaseHistoryModal open onClose={vi.fn()} />)
  expect(await screen.findByText('Offline current notes')).toBeInTheDocument()
  expect(screen.getByText('current')).toBeInTheDocument()
  expect(refresh).toHaveBeenCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: /v1.1.80/ }))
  expect(screen.getByText('Later published release')).toBeInTheDocument()
  await act(async () =>
    finish({ ...local, entries: [{ ...local.entries[0], notes: 'Final edited wording' }, local.entries[1]] })
  )
  expect(screen.getByText('Final edited wording')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /v1.1.80/ })).toHaveAttribute('aria-pressed', 'true')
  expect(openWebsite).not.toHaveBeenCalled()
})

it('keeps local notes readable after a failed refresh and supports retry', async () => {
  refresh.mockResolvedValueOnce({ ...local, refreshFailed: true }).mockResolvedValueOnce(local)
  render(<ReleaseHistoryModal open onClose={vi.fn()} />)
  expect(await screen.findByText('offlineNotice')).toBeInTheDocument()
  expect(screen.getByText('Offline current notes')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'refresh' }))
  await waitFor(() => expect(refresh).toHaveBeenLastCalledWith(true))
  await waitFor(() => expect(screen.queryByText('offlineNotice')).not.toBeInTheDocument())
})

it('ignores results from a previous opening and never opens remote images or HTML', async () => {
  let finish!: (next: ReleaseHistorySnapshot) => void
  refresh
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve
      })
    )
    .mockResolvedValue(local)
  const view = render(<ReleaseHistoryModal open onClose={vi.fn()} />)
  await screen.findByText('Offline current notes')
  view.rerender(<ReleaseHistoryModal open={false} onClose={vi.fn()} />)
  const safe = {
    ...local,
    entries: [
      {
        ...local.entries[1],
        notes: '[Docs](https://example.com) ![Picture](https://example.com/tracker.png) <script>evil()</script>'
      }
    ]
  }
  get.mockResolvedValueOnce(safe)
  refresh.mockResolvedValue(safe)
  view.rerender(<ReleaseHistoryModal open onClose={vi.fn()} />)
  const link = await screen.findByRole('link', { name: 'Docs' })
  await act(async () => finish({ ...local, entries: [{ ...local.entries[0], notes: 'Stale response' }] }))
  expect(screen.queryByText('Stale response')).not.toBeInTheDocument()
  expect(within(screen.getByRole('article', { name: 'details' })).queryByRole('img')).not.toBeInTheDocument()
  expect(document.querySelector('script')).toBeNull()
  fireEvent.click(link)
  expect(openWebsite).toHaveBeenCalledWith('https://example.com')
})
