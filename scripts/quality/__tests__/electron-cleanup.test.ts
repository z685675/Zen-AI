import type * as childProcess from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { execFile } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type * as fileSystem from 'node:fs/promises'
import { lstat, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { _electron, type ElectronApplication, type Page } from '@playwright/test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { APP_QUIT_CLEANUP_TIMEOUT_MS } from '../../../packages/shared/config/constant'
import { closeIsolated, launchIsolated, stopIsolatedTask } from '../electron'

const closeTimeoutMs = APP_QUIT_CLEANUP_TIMEOUT_MS + 5000
const mockInstance = path.join(os.tmpdir(), 'quality-electron-mock-instance')

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof fileSystem>()
  return {
    ...original,
    lstat: vi.fn(original.lstat),
    readFile: vi.fn(original.readFile),
    realpath: vi.fn(original.realpath)
  }
})

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  execFile: vi.fn((_file, _args, _options, callback) => callback(null))
}))
vi.mock('@playwright/test', () => ({ _electron: { launch: vi.fn() } }))

function isolatedPage(options: { pause?: boolean; pending?: string; collapsed?: boolean } = {}) {
  const state = {
    messages: {
      entities: {} as Record<string, { role: string; status: string }>,
      loadingByTopic: { topic: Boolean(options.pause) }
    },
    toolPermissions: { requests: {} as Record<string, { toolCallId: string; status: string }> }
  }
  if (options.pending)
    state.toolPermissions.requests[options.pending] = { toolCallId: options.pending, status: 'pending' }
  let pauseVisible = Boolean(options.pause)
  let collapsed = Boolean(options.collapsed)
  const pause = {
    count: vi.fn(async () => Number(pauseVisible)),
    click: vi.fn(async () => {
      pauseVisible = false
      state.messages.loadingByTopic.topic = false
      for (const message of Object.values(state.messages.entities)) message.status = 'paused'
    }),
    filter: vi.fn()
  }
  pause.filter.mockReturnValue(pause)
  const cancel = vi.fn(async () => {
    if (options.pending) delete state.toolPermissions.requests[options.pending]
  })
  const expand = vi.fn(async () => {
    collapsed = false
  })
  const card = {
    count: vi.fn(async () => Number(!collapsed && Boolean(state.toolPermissions.requests[options.pending ?? '']))),
    waitFor: vi.fn(async () => {
      if (collapsed) throw new Error('permission card is not visible')
    }),
    getByRole: vi.fn((role: string, match: { name: RegExp }) => {
      // The mock deliberately refuses a selector which could approve/Run a tool.
      if (
        role !== 'button' ||
        !match.name.test('Cancel') ||
        !match.name.test('取 消') ||
        match.name.test('Run') ||
        match.name.test('运行')
      )
        throw new Error('unsafe permission button')
      return { click: cancel }
    }),
    filter: vi.fn()
  }
  card.filter.mockReturnValue(card)
  const group = {
    getAttribute: vi.fn(async () => String(!collapsed)),
    locator: vi.fn((selector: string) => {
      if (selector !== '.ant-collapse-expand-icon') throw new Error('unexpected collapse control')
      return { click: expand }
    })
  }
  const header = {
    count: vi.fn(async () => Number(Boolean(state.toolPermissions.requests[options.pending ?? '']))),
    locator: vi.fn((selector: string) => {
      if (selector !== 'xpath=ancestor::*[@aria-expanded][1]') throw new Error('unexpected permission group')
      return group
    }),
    filter: vi.fn()
  }
  header.filter.mockReturnValue(header)
  const page = {
    isClosed: vi.fn(() => false),
    url: vi.fn(() => `${pathToFileURL(path.join(process.cwd(), 'out/renderer/index.html')).href}#/new-assistant`),
    evaluate: vi.fn(async (callback: () => unknown) => {
      vi.stubGlobal('window', { store: { getState: () => state } })
      return callback()
    }),
    locator: vi.fn((selector: string) => {
      if (selector === '#inputbar button:has(svg.lucide-circle-pause)') return pause
      const escaped = options.pending?.replace(
        /[^a-zA-Z0-9_-]/gu,
        (value) => `\\${value.codePointAt(0)!.toString(16)} `
      )
      if (selector === `[data-tool-permission-card][data-tool-call-id="${escaped}"]`) return card
      if (selector === `[data-tool-permission-header][data-tool-call-id="${escaped}"]`) return header
      throw new Error(`unexpected UI selector: ${selector}`)
    })
  }
  return { page, state, pause, card, cancel, expand }
}

function isolatedProcess(
  exitCode: number | null = null,
  signalCode: NodeJS.Signals | null = null,
  task = isolatedPage()
) {
  const child = Object.assign(new EventEmitter(), {
    pid: 424242 as number | undefined,
    exitCode,
    signalCode,
    kill: vi.fn(() => true)
  })
  const exit = (code: number | null, signal: NodeJS.Signals | null = null) => {
    child.exitCode = code
    child.signalCode = signal
    child.emit('exit', code, signal)
  }
  const close = vi.fn(async () => {
    exit(0)
  })
  const proof = {
    name: 'ZenAIQuality',
    instance: mockInstance,
    project: process.cwd(),
    userData: path.join(mockInstance, 'userData')
  }
  const windows = vi.fn(() => [task.page as unknown as Page])
  const application = {
    process: () => child as unknown as ChildProcess,
    close,
    evaluate: vi.fn(async () => proof),
    windows
  } as unknown as ElectronApplication
  return { child, exit, close, application, proof, windows, ...task }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(realpath).mockImplementation(async (target) => path.resolve(String(target)))
  vi.mocked(readFile).mockResolvedValue('zen-quality-isolated-v1')
  vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => false } as never)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

function expectNoKill(child: ReturnType<typeof isolatedProcess>['child']) {
  expect(execFile).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  expect(child.listenerCount('exit')).toBe(0)
  expect(vi.getTimerCount()).toBe(0)
}

describe('isolated Electron exit confirmation', () => {
  it('pauses generation through the inputbar before closing', async () => {
    const { application, child, close, pause, state } = isolatedProcess(null, null, isolatedPage({ pause: true }))
    state.messages.entities.assistant = { role: 'assistant', status: 'processing' }
    close.mockImplementation(async () => {
      expect(pause.click).toHaveBeenCalledOnce()
      child.exitCode = 0
    })
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(pause.click).toHaveBeenCalledExactlyOnceWith({ timeout: 2000 })
    expectNoKill(child)
  })

  it('denies pending permission using only its exact Cancel button before closing', async () => {
    const { application, child, close, card, cancel, pause } = isolatedProcess(
      null,
      null,
      isolatedPage({ pending: 'call:"unsafe]' })
    )
    close.mockImplementation(async () => {
      expect(cancel).toHaveBeenCalledOnce()
      child.exitCode = 0
    })
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(card.getByRole).toHaveBeenCalledExactlyOnceWith('button', { name: /^(取\s*消|Cancel)$/i })
    expect(pause.click).not.toHaveBeenCalled()
    expectNoKill(child)
  })

  it('pauses first and expands a collapsed permission card only to deny it', async () => {
    const { application, child, pause, cancel, expand } = isolatedProcess(
      null,
      null,
      isolatedPage({ pause: true, pending: 'tool-1', collapsed: true })
    )
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(pause.click).toHaveBeenCalledOnce()
    expect(expand).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(pause.click.mock.invocationCallOrder[0]).toBeLessThan(cancel.mock.invocationCallOrder[0])
    expectNoKill(child)
  })

  it('does not click a permission which disappeared after pausing', async () => {
    const { application, child, card, cancel, state } = isolatedProcess(null, null, isolatedPage({ pending: 'tool-1' }))
    card.count.mockImplementationOnce(async () => {
      delete state.toolPermissions.requests['tool-1']
      return 0
    })
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(cancel).not.toHaveBeenCalled()
    expectNoKill(child)
  })

  it('checks every owned product page rather than stopping after the first idle one', async () => {
    const { application, child, windows } = isolatedProcess()
    const second = isolatedPage({ pause: true })
    windows.mockReturnValue([isolatedPage().page as unknown as Page, second.page as unknown as Page])
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(second.pause.click).toHaveBeenCalledOnce()
    expectNoKill(child)
  })

  it('refuses to close or kill an application without isolation evidence', async () => {
    const { application, child, proof, page, close } = isolatedProcess()
    proof.name = 'Real user application'
    await expect(closeIsolated(application)).rejects.toThrow('缺少隔离实例证据')
    expect(page.locator).not.toHaveBeenCalled()
    expect(close).not.toHaveBeenCalled()
    expectNoKill(child)
  })

  it.each(['marker', 'symlink', 'userData'] as const)(
    'rejects mismatched isolation %s before any UI action',
    async (kind) => {
      const { application, child, proof, page, close } = isolatedProcess()
      if (kind === 'marker') vi.mocked(readFile).mockResolvedValue('not-a-quality-instance')
      if (kind === 'symlink')
        vi.mocked(lstat).mockResolvedValue({ isFile: () => true, isSymbolicLink: () => true } as never)
      if (kind === 'userData') proof.userData = path.join(os.tmpdir(), 'real-user-data')
      await expect(closeIsolated(application)).rejects.toThrow('隔离标记或userData不匹配')
      expect(page.locator).not.toHaveBeenCalled()
      expect(close).not.toHaveBeenCalled()
      expectNoKill(child)
    }
  )

  it('does not interact with an unrelated renderer URL and preserves stop failure', async () => {
    const { application, child, page, close } = isolatedProcess()
    page.url.mockReturnValue('https://example.invalid/')
    await expect(closeIsolated(application)).rejects.toThrow(/exit=0.*stop=failed/)
    expect(page.locator).not.toHaveBeenCalled()
    expect(close).toHaveBeenCalledOnce()
    expectNoKill(child)
  })

  it('preserves a failed pause even if normal application close exits zero', async () => {
    const { application, child, close, pause } = isolatedProcess(null, null, isolatedPage({ pause: true }))
    pause.click.mockRejectedValue(new Error('pause click failed'))
    await expect(closeIsolated(application)).rejects.toThrow(/stop=failed.*pause click failed/)
    expect(close).toHaveBeenCalledOnce()
    expectNoKill(child)
  })

  it('does not guess between multiple pause controls', async () => {
    const { application, child, pause } = isolatedProcess(null, null, isolatedPage({ pause: true }))
    pause.count.mockResolvedValue(2)
    await expect(closeIsolated(application)).rejects.toThrow('暂停按钮不唯一')
    expect(pause.click).not.toHaveBeenCalled()
    expectNoKill(child)
  })

  it('fails closed when task state is unavailable instead of assuming it is idle', async () => {
    const { application, child, state } = isolatedProcess()
    state.toolPermissions.requests = undefined as never
    await expect(closeIsolated(application)).rejects.toThrow('任务状态尚未就绪')
    expectNoKill(child)
  })

  it('keeps a stop timeout as failure even when application close later exits zero', async () => {
    const { application, child, close, state } = isolatedProcess()
    state.messages.entities.assistant = { role: 'assistant', status: 'pending' }
    await Promise.all([
      expect(closeIsolated(application)).rejects.toThrow(/exit=0.*stop=failed.*隔离任务停止未确认/),
      vi.advanceTimersByTimeAsync(10000)
    ])
    expect(close).toHaveBeenCalledOnce()
    expectNoKill(child)
  })

  it('exports a stop-only helper which never closes the application', async () => {
    const { application, child, close, cancel } = isolatedProcess(null, null, isolatedPage({ pending: 'tool-1' }))
    await expect(stopIsolatedTask(application)).resolves.toBeUndefined()
    expect(cancel).toHaveBeenCalledOnce()
    expect(close).not.toHaveBeenCalled()
    expectNoKill(child)
  })

  it('accepts a normal close with a confirmed zero exit', async () => {
    const { application, child, close } = isolatedProcess()
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledOnce()
    expectNoKill(child)
  })

  it('waits for the process to exit after close resolves', async () => {
    const { application, child, close, exit } = isolatedProcess()
    close.mockImplementation(async () => {
      setTimeout(() => exit(0), 100)
    })
    await Promise.all([expect(closeIsolated(application)).resolves.toBeUndefined(), vi.advanceTimersByTimeAsync(100)])
    expectNoKill(child)
  })

  it('accepts close rejection when the process has already exited zero', async () => {
    const { application, child, close } = isolatedProcess(0)
    close.mockRejectedValue(new Error('Target page, context or browser has been closed'))
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expectNoKill(child)
  })

  it('also verifies exit zero when close throws synchronously', async () => {
    const { application, child, close } = isolatedProcess(0)
    close.mockImplementation(() => {
      throw new Error('Playwright close failed')
    })
    await expect(closeIsolated(application)).resolves.toBeUndefined()
    expectNoKill(child)
  })

  it('still waits for exit confirmation after close rejects', async () => {
    const { application, child, close, exit } = isolatedProcess()
    close.mockImplementation(async () => {
      setTimeout(() => exit(0), 100)
      throw new Error('Playwright connection closed before exit notification')
    })
    await Promise.all([expect(closeIsolated(application)).resolves.toBeUndefined(), vi.advanceTimersByTimeAsync(100)])
    expectNoKill(child)
  })

  it('accepts a timed-out close only when zero exit is confirmed', async () => {
    const { application, child, close } = isolatedProcess(0)
    close.mockImplementation(() => new Promise(() => {}))
    await Promise.all([
      expect(closeIsolated(application)).resolves.toBeUndefined(),
      vi.advanceTimersByTimeAsync(closeTimeoutMs)
    ])
    expectNoKill(child)
  })

  it.each(['resolved', 'rejected', 'pending'] as const)(
    'allows the full product cleanup window even when Playwright close is %s',
    async (state) => {
      const { application, child, close, exit } = isolatedProcess()
      close.mockImplementation(() => {
        setTimeout(() => exit(0), 15000)
        if (state === 'rejected') return Promise.reject(new Error('Playwright disconnected during cleanup'))
        if (state === 'pending') return new Promise(() => {})
        return Promise.resolve()
      })
      await Promise.all([
        expect(closeIsolated(application)).resolves.toBeUndefined(),
        vi.advanceTimersByTimeAsync(state === 'pending' ? closeTimeoutMs : 15000)
      ])
      expectNoKill(child)
    }
  )

  it.each(['resolved', 'rejected', 'pending'] as const)(
    'fails closed if the process is still running after close is %s',
    async (state) => {
      const { application, child, close } = isolatedProcess()
      if (state === 'resolved') close.mockResolvedValue(undefined)
      else if (state === 'rejected') close.mockRejectedValue(new Error('Playwright close failed'))
      else close.mockImplementation(() => new Promise(() => {}))
      await Promise.all([
        expect(closeIsolated(application)).rejects.toThrow(/exit=null, signal=null/),
        vi.advanceTimersByTimeAsync(closeTimeoutMs + 2000)
      ])
      if (process.platform === 'win32') {
        expect(execFile).toHaveBeenCalledExactlyOnceWith(
          'taskkill.exe',
          ['/PID', String(child.pid), '/T', '/F'],
          { windowsHide: true, timeout: 8000 },
          expect.any(Function)
        )
        expect(child.kill).not.toHaveBeenCalled()
      } else {
        expect(execFile).not.toHaveBeenCalled()
        expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL')
      }
      expect(child.listenerCount('exit')).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    }
  )

  it.each([false, true])('rejects a nonzero exit even when close resolves: %s', async (resolved) => {
    const { application, child, close } = isolatedProcess(7)
    if (resolved) close.mockResolvedValue(undefined)
    else close.mockRejectedValue(new Error('Playwright close failed'))
    await expect(closeIsolated(application)).rejects.toThrow('exit=7')
    expectNoKill(child)
  })

  it('does not treat a forced cleanup as a confirmed graceful exit', async () => {
    const { application, child, close, exit } = isolatedProcess()
    close.mockResolvedValue(undefined)
    if (process.platform === 'win32')
      vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
        exit(0)
        callback?.(null, '', '')
        return child as unknown as ChildProcess
      })
    else
      child.kill.mockImplementationOnce(() => {
        exit(0)
        return true
      })
    await Promise.all([
      expect(closeIsolated(application)).rejects.toThrow('需复核'),
      vi.advanceTimersByTimeAsync(closeTimeoutMs)
    ])
    expect(child.exitCode).toBe(0)
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('records pre-kill state without attributing taskkill exit 1 to a product crash', async () => {
    const { application, child, close, exit } = isolatedProcess()
    close.mockResolvedValue(undefined)
    if (process.platform === 'win32')
      vi.mocked(execFile).mockImplementationOnce((_file, _args, _options, callback) => {
        exit(1)
        callback?.(null, '', '')
        return child as unknown as ChildProcess
      })
    else
      child.kill.mockImplementationOnce(() => {
        exit(1)
        return true
      })
    const result = closeIsolated(application).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(closeTimeoutMs)
    const error = await result
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).toContain('exit=null, signal=null, stop=ok, forced=true')
    expect(String(error)).toContain('preKillExit=null, preKillSignal=null')
    expect(String(error)).toContain('postKillExit=1, postKillSignal=null（不代表产品自身崩溃）')
    expect(child.listenerCount('exit')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('strictly reports a native access violation after successful task stop, without a forced kill', async () => {
    const { application, child, close, exit } = isolatedProcess(null, null, isolatedPage({ pause: true }))
    close.mockImplementation(async () => {
      exit(3221225477)
    })
    await expect(closeIsolated(application)).rejects.toThrow('exit=3221225477, signal=null, stop=ok, forced=false')
    expectNoKill(child)
  })

  it('fails closed without a PID instead of trying a broader process kill', async () => {
    const { application, child, close } = isolatedProcess()
    child.pid = undefined
    close.mockRejectedValue(new Error('Playwright close failed'))
    await Promise.all([
      expect(closeIsolated(application)).rejects.toThrow('exit=null'),
      vi.advanceTimersByTimeAsync(closeTimeoutMs)
    ])
    expectNoKill(child)
  })

  it('rejects a signal exit without killing an already exited PID', async () => {
    const { application, child, close } = isolatedProcess(null, 'SIGTERM')
    close.mockRejectedValue(new Error('Playwright connection closed'))
    await expect(closeIsolated(application)).rejects.toThrow('signal=SIGTERM')
    expectNoKill(child)
  })

  it('preserves cancellation when abort already closed the process with exit zero', async () => {
    vi.useRealTimers()
    const directory = await mkdtemp(path.join(os.tmpdir(), 'quality-electron-cancel-'))
    const controller = new AbortController()
    const { application, child, close, exit } = isolatedProcess()
    close.mockImplementation(async () => {
      exit(0)
      throw new Error('Playwright connection closed')
    })
    vi.mocked(_electron.launch).mockResolvedValue(
      Object.assign(application, {
        firstWindow: vi.fn(async () => {
          controller.abort()
          throw new Error('已取消')
        })
      })
    )
    try {
      const result = await launchIsolated(directory, directory, controller.signal).catch((error) => error)
      expect(result).toBeInstanceOf(Error)
      expect(result.message).toBe('已取消')
      expect(controller.signal.aborted).toBe(true)
      expect(close).toHaveBeenCalledTimes(2)
      expect(execFile).not.toHaveBeenCalled()
      expect(child.kill).not.toHaveBeenCalled()
      expect(child.listenerCount('exit')).toBe(0)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
