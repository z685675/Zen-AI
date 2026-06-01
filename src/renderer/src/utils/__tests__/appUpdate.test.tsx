import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { formatReleaseDate, showAppUpdateAvailableModal, showAppUpdateDownloadedModal } from '../appUpdate'

let mockIsMac = false

vi.mock('@renderer/config/constant', () => ({
  get isMac() {
    return mockIsMac
  }
}))

const t = (key: string, options?: Record<string, unknown>) => {
  switch (key) {
    case 'update.available':
      return `发现新版本 ${options?.version as string}，是否立即下载？`
    case 'update.message':
      return `新版本 ${options?.version as string} 已下载完成，是否立即重启并安装？`
    case 'update.version':
      return '版本'
    case 'update.releaseDate':
      return '发布日期'
    case 'update.noReleaseNotes':
      return '暂无更新日志'
    case 'update.title':
      return '更新提示'
    case 'update.downloadNow':
      return '立即下载'
    case 'update.installNow':
      return '立即安装'
    case 'update.later':
      return '稍后'
    default:
      return key
  }
}

describe('appUpdate', () => {
  beforeEach(() => {
    mockIsMac = false
  })

  it('formats release date as a readable local datetime', () => {
    expect(formatReleaseDate('2026-05-22T17:57:33.000Z')).not.toContain('T')
    expect(formatReleaseDate('2026-05-22T17:57:33.000Z')).not.toContain('Z')
  })

  it('renders release notes as markdown in update modal content', () => {
    let capturedContent: ReactNode | undefined

    ;(window as any).modal = {
      confirm: (options: { content: ReactNode }) => {
        capturedContent = options.content
      }
    }

    showAppUpdateDownloadedModal(t, {
      version: '1.1.14',
      releaseDate: '2026-05-22T17:57:33.000Z',
      releaseNotes: '## 新增\n\n- 第一项\n- 第二项'
    })

    render(<>{capturedContent}</>)

    expect(screen.getByText('新增')).toBeInTheDocument()
    expect(screen.getByText('第一项')).toBeInTheDocument()
    expect(screen.getByText('第二项')).toBeInTheDocument()
  })

  it('uses download action and copy for available updates', async () => {
    const confirm = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).toast = { error: vi.fn() }
    ;(window as any).api = {
      downloadUpdate: vi.fn().mockResolvedValue({ status: 'downloading' }),
      quitAndInstallUpdate: vi.fn().mockResolvedValue({ success: true, status: 'installing' }),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateAvailableModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    expect(confirm).toHaveBeenCalledOnce()

    const options = confirm.mock.calls[0][0]
    expect(options.okText).toBe('立即下载')

    render(<>{options.content}</>)
    expect(screen.getByText('发现新版本 1.1.14，是否立即下载？')).toBeInTheDocument()

    await options.onOk()
    expect(window.api.downloadUpdate).toHaveBeenCalledOnce()
    expect(window.api.quitAndInstallUpdate).not.toHaveBeenCalled()
  })

  it('keeps the available update modal open when download fails', async () => {
    const confirm = vi.fn()
    const toastError = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).toast = { error: toastError }
    ;(window as any).api = {
      downloadUpdate: vi.fn().mockResolvedValue({
        status: 'error',
        message: 'network failed'
      }),
      quitAndInstallUpdate: vi.fn(),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateAvailableModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    const options = confirm.mock.calls[0][0]

    await expect(options.onOk()).rejects.toThrow('network failed')
    expect(toastError).toHaveBeenCalledWith('network failed')
    expect(window.api.quitAndInstallUpdate).not.toHaveBeenCalled()
  })

  it('uses install action for downloaded updates', async () => {
    const confirm = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).api = {
      downloadUpdate: vi.fn(),
      quitAndInstallUpdate: vi.fn().mockResolvedValue({ success: true, status: 'installing' }),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateDownloadedModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    expect(confirm).toHaveBeenCalledOnce()

    const options = confirm.mock.calls[0][0]
    expect(options.okText).toBe('立即安装')

    await options.onOk()
    expect(window.api.quitAndInstallUpdate).toHaveBeenCalledOnce()
    expect(window.api.downloadUpdate).not.toHaveBeenCalled()
    expect(window.api.openDownloadedInstaller).not.toHaveBeenCalled()
  })

  it('opens the local macOS installer for downloaded updates', async () => {
    mockIsMac = true
    const confirm = vi.fn()
    const toastInfo = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).toast = { info: toastInfo, error: vi.fn() }
    ;(window as any).api = {
      downloadUpdate: vi.fn(),
      quitAndInstallUpdate: vi.fn().mockResolvedValue({
        success: true,
        status: 'manual-installer-opened',
        installerPath: '/Users/test/Downloads/Zen AI Updates/Zen-AI-1.1.14-macos-arm64.dmg',
        fallbackToFolder: false
      }),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateDownloadedModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    const options = confirm.mock.calls[0][0]
    expect(options.okText).toBe('打开安装包')

    render(<>{options.content}</>)
    expect(screen.getByText(/自动退出 Zen AI/)).toBeInTheDocument()

    await options.onOk()
    expect(window.api.quitAndInstallUpdate).toHaveBeenCalledOnce()
    expect(window.api.openDownloadedInstaller).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith('正在准备并打开安装包…')
    expect(toastInfo).toHaveBeenCalledWith(
      '已打开安装程序，Zen AI 将自动退出。请在安装窗口中拖入 Applications 完成安装。'
    )
  })

  it('shows a Finder fallback message when macOS installer cannot be opened directly', async () => {
    mockIsMac = true
    const confirm = vi.fn()
    const toastInfo = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).toast = { info: toastInfo, error: vi.fn() }
    ;(window as any).api = {
      downloadUpdate: vi.fn(),
      quitAndInstallUpdate: vi.fn().mockResolvedValue({
        success: true,
        status: 'manual-installer-opened',
        installerPath: '/Users/test/Downloads/Zen AI Updates/Zen-AI-1.1.14-macos-arm64.dmg',
        fallbackToFolder: true
      }),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateDownloadedModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    const options = confirm.mock.calls[0][0]
    await options.onOk()

    expect(window.api.quitAndInstallUpdate).toHaveBeenCalledOnce()
    expect(window.api.openDownloadedInstaller).not.toHaveBeenCalled()
    expect(toastInfo).toHaveBeenCalledWith('正在准备并打开安装包…')
    expect(toastInfo).toHaveBeenCalledWith('没能直接打开安装包，已为你定位到安装包位置，请双击 DMG 完成安装。')
  })

  it('keeps the downloaded update modal open when install fails', async () => {
    const confirm = vi.fn()
    const toastError = vi.fn()

    ;(window as any).modal = { confirm }
    ;(window as any).toast = { error: toastError }
    ;(window as any).api = {
      downloadUpdate: vi.fn(),
      quitAndInstallUpdate: vi.fn().mockResolvedValue({
        success: false,
        status: 'not-downloaded',
        message: 'Update package has not been downloaded yet.'
      }),
      openDownloadedInstaller: vi.fn()
    }

    showAppUpdateDownloadedModal(t, {
      version: '1.1.14',
      releaseNotes: '- test'
    })

    const options = confirm.mock.calls[0][0]

    await expect(options.onOk()).rejects.toThrow('Update package has not been downloaded yet.')
    expect(toastError).toHaveBeenCalledWith('Update package has not been downloaded yet.')
  })
})
