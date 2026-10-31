import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
  closeAppUpdateModal,
  formatReleaseDate,
  showAppUpdateAvailableModal,
  showAppUpdateDownloadedModal,
  showAppUpdateDownloadingModal
} from '../appUpdate'

let mockIsMac = false
vi.mock('@renderer/config/constant', () => ({
  get isMac() {
    return mockIsMac
  }
}))
const t = (key: string, options?: Record<string, unknown>) =>
  ({
    'update.available': `发现新版本 ${options?.version ?? ''}`,
    'update.message': `版本 ${options?.version ?? ''} 已下载`,
    'update.downloadNow': '立即下载',
    'update.installNow': '立即安装',
    'update.downloadProgress': '下载中',
    'update.preparingInstall': '准备安装中',
    'update.openInstaller': '打开安装包',
    'update.macInstallNotice': '将 Zen AI 拖入 Applications',
    'update.installerOpened': '安装程序已打开',
    'update.installerFolder': '请双击 DMG',
    'update.downloadFailed': '下载失败',
    'update.installFailed': '安装失败'
  })[key] ?? key
const info = { version: '1.1.79', releaseNotes: '## 新增\n\n- 第一项\n- 第二项' }
let options: any
let downloaded: (value: any) => void
let progress: (value: any) => void
let failed: (value: any) => void
const removers = [vi.fn(), vi.fn(), vi.fn()]
const update = vi.fn((next) => {
  options = { ...options, ...next }
})
const destroy = vi.fn()
const confirm = vi.fn((next) => {
  options = next
  return { update, destroy }
})
const downloadUpdate = vi.fn()
const installUpdate = vi.fn()
const getUpdateState = vi.fn()
function clickOK() {
  act(() => {
    options.onOk(vi.fn())
  })
}
function renderContent() {
  return render(options.content)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockIsMac = false
  getUpdateState.mockResolvedValue({ status: 'idle', updateInfo: null })
  downloadUpdate.mockResolvedValue({ status: 'downloading', updateInfo: info })
  installUpdate.mockResolvedValue({ success: true, status: 'installing' })
  ;(window as any).modal = { confirm }
  ;(window as any).toast = { info: vi.fn(), error: vi.fn() }
  ;(window as any).api = {
    downloadUpdate,
    quitAndInstallUpdate: installUpdate,
    getUpdateState,
    update: {
      onDownloadProgress: vi.fn((callback) => {
        progress = callback
        return removers[0]
      }),
      onDownloaded: vi.fn((callback) => {
        downloaded = callback
        return removers[1]
      }),
      onError: vi.fn((callback) => {
        failed = callback
        return removers[2]
      })
    }
  }
})
afterEach(() => closeAppUpdateModal())

it('formats the date and renders the markdown release notes', () => {
  expect(formatReleaseDate('2026-05-22T17:57:33.000Z')).not.toContain('T')
  showAppUpdateAvailableModal(t, info)
  renderContent()
  expect(screen.getByText('新增')).toBeInTheDocument()
  expect(screen.getByText('第一项')).toBeInTheDocument()
  expect(options.className).toBe('zen-app-update-modal')
  expect(options.bodyStyle.overflow).toBe('hidden')
})

it('shows immediate feedback and live progress, then offers installation in the same dialog', async () => {
  let finish!: (value: any) => void
  downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  showAppUpdateAvailableModal(t, info)
  clickOK()
  clickOK()
  expect(downloadUpdate).toHaveBeenCalledOnce()
  expect(options.okButtonProps).toMatchObject({ loading: true, disabled: true })
  act(() =>
    progress({ percent: 42, transferred: 42 * 1024 * 1024, total: 100 * 1024 * 1024, bytesPerSecond: 2 * 1024 * 1024 })
  )
  const view = renderContent()
  expect(screen.getByText('42%')).toBeInTheDocument()
  expect(screen.getByText(/42.0 MB.*100.0 MB.*2.0 MB\/s/)).toBeInTheDocument()
  act(() => downloaded(info))
  finish({ status: 'downloaded', updateInfo: info })
  await waitFor(() => expect(options.okText).toBe('立即安装'))
  view.rerender(options.content)
  expect(screen.getByText('版本 1.1.79 已下载')).toBeInTheDocument()
  showAppUpdateDownloadedModal(t, info)
  expect(confirm).toHaveBeenCalledOnce()
  expect(destroy).not.toHaveBeenCalled()
  clickOK()
  await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce())
  await waitFor(() => expect(destroy).toHaveBeenCalledOnce())
})

it('transitions a cached download result to Install even when no downloaded event is sent', async () => {
  downloadUpdate.mockResolvedValueOnce({ status: 'downloaded', updateInfo: info })
  showAppUpdateAvailableModal(t, info)
  clickOK()
  await waitFor(() => expect(options.okText).toBe('立即安装'))
  expect(confirm).toHaveBeenCalledOnce()
})

it('keeps progress visible when the server has not supplied a total file size', () => {
  showAppUpdateAvailableModal(t, info)
  clickOK()
  act(() => progress({ percent: 0, transferred: 1048576, total: 0, bytesPerSecond: 0 }))
  renderContent()
  expect(screen.getByText('1.0 MB')).toBeInTheDocument()
  expect(screen.getByRole('status')).toHaveTextContent('下载中')
})

it('shows download errors in place and lets the user retry', async () => {
  downloadUpdate.mockRejectedValueOnce(new Error('connection lost'))
  showAppUpdateAvailableModal(t, info)
  clickOK()
  await waitFor(() => expect(options.okText).toBe('立即下载'))
  const view = renderContent()
  expect(screen.getByRole('alert')).toHaveTextContent('connection lost')
  clickOK()
  view.rerender(options.content)
  expect(downloadUpdate).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  act(() => failed({ message: 'server timeout' }))
  view.rerender(options.content)
  expect(screen.getByRole('alert')).toHaveTextContent('server timeout')
})

it('keeps installation retryable after a rejected IPC or launcher failure', async () => {
  installUpdate.mockRejectedValueOnce(new Error('IPC interrupted'))
  showAppUpdateDownloadedModal(t, info)
  clickOK()
  clickOK()
  await waitFor(() => expect(options.okText).toBe('立即安装'))
  expect(installUpdate).toHaveBeenCalledOnce()
  const view = renderContent()
  expect(screen.getByRole('alert')).toHaveTextContent('IPC interrupted')
  installUpdate.mockResolvedValueOnce({
    success: false,
    status: 'error',
    message: 'installer blocked',
    stage: 'start-installer'
  })
  clickOK()
  await waitFor(() => expect(options.okText).toBe('立即安装'))
  view.rerender(options.content)
  expect(screen.getByRole('alert')).toHaveTextContent('installer blocked')
  expect(options.cancelButtonProps.disabled).toBe(false)
  expect(destroy).not.toHaveBeenCalled()
})

it('keeps the installation prompt open when the user chooses to keep a running task', async () => {
  installUpdate.mockResolvedValueOnce({ success: false, status: 'cancelled' })
  showAppUpdateDownloadedModal(t, info)
  clickOK()
  await waitFor(() => expect(options.okText).toBe('立即安装'))
  expect(destroy).not.toHaveBeenCalled()
})

it('does not allow a late initial snapshot to undo a completed download', async () => {
  let snapshot!: (value: any) => void
  getUpdateState.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        snapshot = resolve
      })
  )
  showAppUpdateAvailableModal(t, info)
  act(() => downloaded(info))
  snapshot({ status: 'downloading', updateInfo: info, progress: { percent: 5 } })
  await act(async () => {
    await Promise.resolve()
  })
  expect(options.okText).toBe('立即安装')
})

it('removes listeners when dismissed and ignores the in-flight download result', async () => {
  let finish!: (value: any) => void
  downloadUpdate.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  showAppUpdateAvailableModal(t, info)
  clickOK()
  act(() => {
    options.onCancel()
  })
  for (const remove of removers) expect(remove).toHaveBeenCalledOnce()
  const calls = update.mock.calls.length
  finish({ status: 'downloaded', updateInfo: info })
  await act(async () => {
    await Promise.resolve()
  })
  expect(update).toHaveBeenCalledTimes(calls)
})

it('offers the macOS DMG and Finder fallback without starting a second download', async () => {
  mockIsMac = true
  installUpdate.mockResolvedValueOnce({ success: true, status: 'manual-installer-opened', fallbackToFolder: true })
  showAppUpdateDownloadedModal(t, info)
  renderContent()
  expect(screen.getByText(/Applications/)).toBeInTheDocument()
  expect(options.okText).toBe('打开安装包')
  clickOK()
  await waitFor(() => expect(window.toast.info).toHaveBeenCalledWith('请双击 DMG'))
  expect(downloadUpdate).not.toHaveBeenCalled()
})

it('opens an existing background download with progress without starting another download', async () => {
  getUpdateState.mockResolvedValueOnce({
    status: 'downloading',
    updateInfo: info,
    progress: { percent: 65, transferred: 65, total: 100, bytesPerSecond: 1 }
  })
  showAppUpdateDownloadingModal(t, info)
  await waitFor(() => expect(options.okText).toBe('下载中'))
  await act(async () => {
    await Promise.resolve()
  })
  renderContent()
  expect(screen.getByText('65%')).toBeInTheDocument()
  expect(downloadUpdate).not.toHaveBeenCalled()
})
