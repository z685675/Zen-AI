import type { ImageCanvasTask } from '@shared/config/imageCanvas'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DownloadProgress } from '../../../../../packages/image-workbench/src/DownloadProgress'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(cleanup)

const task = (): ImageCanvasTask => ({
  id: 'test',
  providerId: 'zen',
  modelId: 'gpt-image',
  prompt: 'image',
  createdAt: '',
  assets: [],
  status: 'running',
  phase: 'downloading',
  diagnostics: {
    protocol: 'openai',
    capabilityRevision: '',
    capabilitySource: 'server',
    attempts: 1,
    phaseDurationsMs: {},
    downloads: [
      {
        assetId: 'a'.repeat(64),
        index: 1,
        count: 1,
        receivedBytes: 1024,
        totalBytes: 4096,
        bytesPerSecond: 512,
        attempt: 1,
        resumedBytes: 0,
        state: 'downloading',
        history: []
      }
    ]
  }
})

describe('image download status outside diagnostics', () => {
  it('shows determinate progress, bytes and speed without expanding details', () => {
    render(<DownloadProgress task={task()} />)
    expect(screen.getByRole('progressbar', { name: 'downloadProgressLabel' })).toHaveAttribute('value', '1024')
    expect(screen.getByRole('progressbar')).toHaveAttribute('max', '4096')
    expect(screen.getByText('1.0 KB / 4.0 KB')).toBeVisible()
    expect(screen.getByText('0.5 KB/s')).toBeVisible()
  })
  it('shows activity without a misleading percentage when the size is unknown', () => {
    const value = task()
    value.diagnostics!.downloads![0].totalBytes = undefined
    render(<DownloadProgress task={value} />)
    expect(screen.getByRole('progressbar')).not.toHaveAttribute('value')
    expect(screen.getByText(/downloadUnknownSize/)).toBeVisible()
  })
  it('keeps the recovery guidance and saved progress visible after interruption', () => {
    const value = task()
    value.status = 'uncertain'
    value.phase = undefined
    value.error = 'studio_download_failed'
    value.diagnostics!.downloads![0].state = 'paused'
    render(<DownloadProgress task={value} />)
    expect(screen.getByText('downloadResumeHint')).toBeVisible()
    expect(screen.getByRole('progressbar')).toHaveAttribute('value', '1024')
  })
  it('shows reconnection state and hides progress after local saving finishes', () => {
    const value = task()
    value.diagnostics!.downloads![0].state = 'reconnecting'
    const { rerender } = render(<DownloadProgress task={value} />)
    expect(screen.getByText('downloadStates.reconnecting')).toBeVisible()
    rerender(<DownloadProgress task={{ ...value, phase: undefined, status: 'completed' }} />)
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument()
  })
})
