import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))

vi.mock('node:fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn()
  },
  existsSync: vi.fn(() => false),
  mkdirSync: vi.fn()
}))

vi.mock('electron', () => {
  const sendCommand = vi.fn(async (command: string, params?: { expression?: string }) => {
    if (command === 'Runtime.evaluate') {
      if (params?.expression === 'document.documentElement.outerHTML') {
        return { result: { value: '<html><body><h1>Test</h1><p>Content</p></body></html>' } }
      }
      if (params?.expression === 'document.body.innerText') {
        return { result: { value: 'Test\nContent' } }
      }
      return { result: { value: 'ok' } }
    }
    return {}
  })

  const debuggerObj = {
    isAttached: vi.fn(() => true),
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand
  }

  const createWebContents = () => ({
    debugger: debuggerObj,
    setUserAgent: vi.fn(),
    getURL: vi.fn(() => 'https://example.com/'),
    getTitle: vi.fn(() => 'Example Title'),
    loadURL: vi.fn(async () => {}),
    once: vi.fn(),
    removeListener: vi.fn(),
    on: vi.fn(),
    isDestroyed: vi.fn(() => false),
    canGoBack: vi.fn(() => false),
    canGoForward: vi.fn(() => false),
    goBack: vi.fn(),
    goForward: vi.fn(),
    reload: vi.fn(),
    executeJavaScript: vi.fn(async () => null),
    setWindowOpenHandler: vi.fn()
  })

  const windows: any[] = []
  const views: any[] = []

  class MockBrowserWindow {
    private destroyed = false
    public webContents = createWebContents()
    public isDestroyed = vi.fn(() => this.destroyed)
    public close = vi.fn(() => {
      this.destroyed = true
    })
    public destroy = vi.fn(() => {
      this.destroyed = true
    })
    public on = vi.fn()
    public setBrowserView = vi.fn()
    public addBrowserView = vi.fn()
    public removeBrowserView = vi.fn()
    public getContentSize = vi.fn(() => [1200, 800])
    public show = vi.fn()
    public focus = vi.fn()

    constructor() {
      windows.push(this)
    }
  }

  class MockBrowserView {
    public webContents = createWebContents()
    public setBounds = vi.fn()
    public setAutoResize = vi.fn()
    public destroy = vi.fn()

    constructor() {
      views.push(this)
    }
  }

  const app = {
    isReady: vi.fn(() => true),
    whenReady: vi.fn(async () => {}),
    on: vi.fn(),
    getPath: vi.fn((key: string) => {
      if (key === 'userData') return '/mock/userData'
      if (key === 'temp') return '/tmp'
      return '/mock/unknown'
    }),
    getAppPath: vi.fn(() => '/mock/app'),
    setPath: vi.fn()
  }

  const nativeTheme = {
    on: vi.fn(),
    removeListener: vi.fn(),
    shouldUseDarkColors: false
  }

  const privateBrowserSession = {
    setProxy: vi.fn(async () => {}),
    clearStorageData: vi.fn(async () => {}),
    clearCache: vi.fn(async () => {})
  }

  return {
    BrowserWindow: MockBrowserWindow as any,
    BrowserView: MockBrowserView as any,
    app,
    nativeTheme,
    shell: { openExternal: vi.fn(async () => {}) },
    dialog: { showMessageBox: vi.fn(async () => ({ response: 0 })) },
    __mockDebugger: debuggerObj,
    __mockSendCommand: sendCommand,
    __mockWindows: windows,
    __mockViews: views,
    session: {
      fromPartition: vi.fn(() => privateBrowserSession)
    },
    __mockPrivateBrowserSession: privateBrowserSession
  }
})

import { beforeEach } from 'vitest'

import { CdpBrowserController } from '../browser'

describe('CdpBrowserController', () => {
  // Reset mock state before each test to prevent state leakage
  beforeEach(() => {
    // Clear mock call history
    vi.clearAllMocks()
  })

  it('prepares an independent system-proxy session before browsing and leaves the native user agent intact', async () => {
    const electron = await import('electron')
    const browserSession = (electron as any).__mockPrivateBrowserSession
    let release!: () => void
    browserSession.setProxy.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    const controller = new CdpBrowserController()
    const opening = controller.open('https://example.com/')
    await vi.waitFor(() => expect(browserSession.setProxy).toHaveBeenCalledWith({ mode: 'system' }))
    expect(electron.session.fromPartition).toHaveBeenCalledWith('persist:default')
    expect((electron as any).__mockViews).not.toBeUndefined()
    const viewCount = (electron as any).__mockViews.length
    release()
    await opening
    const views = (electron as any).__mockViews
    expect(views.length).toBeGreaterThan(viewCount)
    expect(views.at(-1).webContents.setUserAgent).not.toHaveBeenCalled()
    await controller.execute('1+1')
    expect(browserSession.setProxy).toHaveBeenCalledOnce()
    await controller.dispose()
  })

  it('also gives the private browser its own system-proxy session', async () => {
    const electron = await import('electron')
    const controller = new CdpBrowserController()
    await controller.open('https://example.com/', 5000, true)
    expect(electron.session.fromPartition).toHaveBeenCalledWith('private')
    expect((electron as any).__mockPrivateBrowserSession.setProxy).toHaveBeenCalledWith({ mode: 'system' })
    await controller.dispose()
  })

  it('reports system-proxy setup failure and permits a later retry without loading a page on the wrong route', async () => {
    const electron = await import('electron')
    const controller = new CdpBrowserController()
    const browserSession = (electron as any).__mockPrivateBrowserSession
    browserSession.setProxy.mockRejectedValueOnce(new Error('system proxy unavailable'))
    await expect(controller.open('https://example.com/')).rejects.toThrow('system proxy unavailable')
    expect((controller as any).windows.size).toBe(0)
    await expect(controller.open('https://example.com/')).resolves.toMatchObject({ tabId: expect.any(String) })
    await controller.dispose()
  })

  it('does not let a delayed native close event tear down the replacement browser', async () => {
    const controller = new CdpBrowserController()
    await controller.open('https://example.com/')
    const oldWindow = [...(controller as any).windows.values()][0].window
    const closed = oldWindow.on.mock.calls.find(([event]: [string]) => event === 'closed')[1]
    await controller.reset(false)
    const reopened = await controller.open('https://example.com/')
    const newWindow = [...(controller as any).windows.values()][0]
    closed()
    expect((controller as any).windows.get('default')).toBe(newWindow)
    expect(newWindow.tabs.has(reopened.tabId)).toBe(true)
    await expect(controller.execute('1+1', 5000, false, reopened.tabId)).resolves.toBe('ok')
    await controller.dispose()
  })

  it('executes single-line code via Runtime.evaluate', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.execute('1+1')
    expect(result).toBe('ok')
  })

  it('does not instantiate or clear an unused private session on close', async () => {
    const controller = new CdpBrowserController()
    await controller.dispose()
    const electronMock = await import('electron')
    expect(electronMock.session.fromPartition).not.toHaveBeenCalled()
    expect((electronMock as any).__mockPrivateBrowserSession.clearStorageData).not.toHaveBeenCalled()
    expect(electronMock.nativeTheme.removeListener).toHaveBeenCalledWith('updated', expect.any(Function))
    await expect(controller.open('https://example.com/')).rejects.toThrow('Browser controller is closed')
  })

  it('waits for native storage clearing of a used private window before disposal completes', async () => {
    const controller = new CdpBrowserController()
    await controller.open('https://example.com/', 5000, true)
    const electronMock = await import('electron')
    const privateSession = (electronMock as any).__mockPrivateBrowserSession
    let release!: () => void
    privateSession.clearStorageData.mockImplementationOnce(() => new Promise<void>((resolve) => (release = resolve)))
    let complete = false
    const closing = controller.dispose().then(() => (complete = true))
    await vi.waitFor(() => expect(privateSession.clearStorageData).toHaveBeenCalledOnce())
    expect(complete).toBe(false)
    release()
    await closing
    expect(complete).toBe(true)
    await controller.dispose()
    expect(privateSession.clearStorageData).toHaveBeenCalledOnce()
  })

  it('opens a URL in normal mode and returns current page info', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.open('https://foo.bar/', 5000, false)
    expect(result.currentUrl).toBe('https://example.com/')
    expect(result.title).toBe('Example Title')
  })

  it('opens a URL in private mode', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.open('https://foo.bar/', 5000, true)
    expect(result.currentUrl).toBe('https://example.com/')
    expect(result.title).toBe('Example Title')
  })

  it('reuses session for execute and supports multiline', async () => {
    const controller = new CdpBrowserController()
    await controller.open('https://foo.bar/', 5000, false)
    const result = await controller.execute('const a=1; const b=2; a+b;', 5000, false)
    expect(result).toBe('ok')
  })

  it('normal and private modes are isolated', async () => {
    const controller = new CdpBrowserController()
    await controller.open('https://foo.bar/', 5000, false)
    await controller.open('https://foo.bar/', 5000, true)
    const normalResult = await controller.execute('1+1', 5000, false)
    const privateResult = await controller.execute('1+1', 5000, true)
    expect(normalResult).toBe('ok')
    expect(privateResult).toBe('ok')
  })

  it('fetches URL and returns html format with tabId', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.fetch('https://example.com/', 'html')
    expect(result.tabId).toBeDefined()
    expect(result.content).toBe('<html><body><h1>Test</h1><p>Content</p></body></html>')
  })

  it('fetches URL and returns txt format with tabId', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.fetch('https://example.com/', 'txt')
    expect(result.tabId).toBeDefined()
    expect(result.content).toBe('Test\nContent')
  })

  it('fetches URL and returns markdown format (default) with tabId', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.fetch('https://example.com/')
    expect(result.tabId).toBeDefined()
    expect(typeof result.content).toBe('string')
    expect(result.content).toContain('Test')
  })

  it('fetches URL in private mode with tabId', async () => {
    const controller = new CdpBrowserController()
    const result = await controller.fetch('https://example.com/', 'html', 10000, true)
    expect(result.tabId).toBeDefined()
    expect(result.content).toBe('<html><body><h1>Test</h1><p>Content</p></body></html>')
  })

  describe('Multi-tab support', () => {
    it('creates new tab with newTab parameter', async () => {
      const controller = new CdpBrowserController()
      const result1 = await controller.open('https://site1.com/', 5000, false, true)
      const result2 = await controller.open('https://site2.com/', 5000, false, true)

      expect(result1.tabId).toBeDefined()
      expect(result2.tabId).toBeDefined()
      expect(result1.tabId).not.toBe(result2.tabId)
    })

    it('reuses same tab without newTab parameter', async () => {
      const controller = new CdpBrowserController()
      const result1 = await controller.open('https://site1.com/', 5000, false)
      const result2 = await controller.open('https://site2.com/', 5000, false)

      expect(result1.tabId).toBe(result2.tabId)
    })

    it('fetches in new tab with newTab parameter', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)
      const tabs = await controller.listTabs(false)
      const initialTabCount = tabs.length

      await controller.fetch('https://other.com/', 'html', 10000, false, true)
      const tabsAfter = await controller.listTabs(false)

      expect(tabsAfter.length).toBe(initialTabCount + 1)
    })
  })

  describe('Tab management', () => {
    it('lists tabs in a window', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)

      const tabs = await controller.listTabs(false)
      expect(tabs.length).toBeGreaterThan(0)
      expect(tabs[0].tabId).toBeDefined()
    })

    it('lists tabs separately for normal and private modes', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)
      await controller.open('https://example.com/', 5000, true)

      const normalTabs = await controller.listTabs(false)
      const privateTabs = await controller.listTabs(true)

      expect(normalTabs.length).toBe(1)
      expect(privateTabs.length).toBe(1)
      expect(normalTabs[0].tabId).not.toBe(privateTabs[0].tabId)
    })

    it('closes specific tab', async () => {
      const controller = new CdpBrowserController()
      const result1 = await controller.open('https://site1.com/', 5000, false, true)
      await controller.open('https://site2.com/', 5000, false, true)

      const tabsBefore = await controller.listTabs(false)
      expect(tabsBefore.length).toBe(2)

      await controller.closeTab(false, result1.tabId)

      const tabsAfter = await controller.listTabs(false)
      expect(tabsAfter.length).toBe(1)
      expect(tabsAfter.find((t) => t.tabId === result1.tabId)).toBeUndefined()
    })

    it('switches active tab', async () => {
      const controller = new CdpBrowserController()
      const result1 = await controller.open('https://site1.com/', 5000, false, true)
      const result2 = await controller.open('https://site2.com/', 5000, false, true)

      await controller.switchTab(false, result1.tabId)
      await controller.switchTab(false, result2.tabId)
    })

    it('throws error when switching to non-existent tab', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)

      await expect(controller.switchTab(false, 'non-existent-tab')).rejects.toThrow('Tab non-existent-tab not found')
    })

    it('does not fall back to the active tab when an explicit tab ID is invalid', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)

      await expect(controller.execute('1+1', 5000, false, 'missing-tab')).rejects.toThrow('Tab missing-tab not found')
    })
  })

  describe('Reset behavior', () => {
    it('resets specific tab only', async () => {
      const controller = new CdpBrowserController()
      const result1 = await controller.open('https://site1.com/', 5000, false, true)
      await controller.open('https://site2.com/', 5000, false, true)

      await controller.reset(false, result1.tabId)

      const tabs = await controller.listTabs(false)
      expect(tabs.length).toBe(1)
    })

    it('resets specific window only', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)
      await controller.open('https://example.com/', 5000, true)

      await controller.reset(false)

      const normalTabs = await controller.listTabs(false)
      const privateTabs = await controller.listTabs(true)

      expect(normalTabs.length).toBe(0)
      expect(privateTabs.length).toBe(1)
    })

    it('resets all windows', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, false)
      await controller.open('https://example.com/', 5000, true)

      await controller.reset()

      const normalTabs = await controller.listTabs(false)
      const privateTabs = await controller.listTabs(true)

      expect(normalTabs.length).toBe(0)
      expect(privateTabs.length).toBe(0)
    })

    it('clears private storage when the private window is reset', async () => {
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, true)

      await controller.reset(true)

      const electronMock = await import('electron')
      const privateSession = (electronMock as any).__mockPrivateBrowserSession
      expect(privateSession.clearStorageData).toHaveBeenCalled()
      expect(privateSession.clearCache).toHaveBeenCalled()
    })
  })

  describe('showWindow parameter', () => {
    it('passes showWindow parameter through open', async () => {
      const controller = new CdpBrowserController()
      const result = await controller.open('https://example.com/', 5000, false, false, true)
      expect(result.currentUrl).toBe('https://example.com/')
      expect(result.tabId).toBeDefined()
    })

    it('passes showWindow parameter through fetch', async () => {
      const controller = new CdpBrowserController()
      const result = await controller.fetch('https://example.com/', 'html', 10000, false, false, true)
      expect(result.tabId).toBeDefined()
      expect(result.content).toBe('<html><body><h1>Test</h1><p>Content</p></body></html>')
    })

    it('passes showWindow parameter through createTab', async () => {
      const controller = new CdpBrowserController()
      const { tabId, view } = await controller.createTab(false, true)
      expect(tabId).toBeDefined()
      expect(view).toBeDefined()
    })

    it('shows existing window when showWindow=true on subsequent calls', async () => {
      const controller = new CdpBrowserController()
      // First call creates window
      await controller.open('https://example.com/', 5000, false, false, false)
      // Second call with showWindow=true should show existing window
      const result = await controller.open('https://example.com/', 5000, false, false, true)
      expect(result.currentUrl).toBe('https://example.com/')
    })
  })

  describe('User handoff', () => {
    it('keeps an automatic handoff reachable after the user switches to another tab', async () => {
      const controller = new CdpBrowserController()
      const opened = await controller.open('https://example.com/')
      const windowInfo = [...(controller as any).windows.values()][0]
      const originalTab = windowInfo.tabs.get(opened.tabId)
      originalTab.userAction = { reason: 'captcha', message: 'Verify manually', url: 'https://example.com/' }
      ;(controller as any).pauseForUser(originalTab)
      const other = await controller.createTab()
      await controller.switchTab(false, other.tabId)
      ;(controller as any).sendHandoffUpdate(windowInfo)
      expect(windowInfo.tabBarView.webContents.executeJavaScript).toHaveBeenLastCalledWith(
        expect.stringContaining('Verify manually')
      )
      ;(controller as any).handleTabBarAction(windowInfo, { type: 'handoff-continue' })
      expect(originalTab.manualControl).toBe(false)
      await expect(controller.execute('1+1', 5000, false, other.tabId)).resolves.toBe('ok')
      await controller.dispose()
    })

    it('releases an explicit handoff after timeout when no automatic verification prompt remains', async () => {
      const controller = new CdpBrowserController()
      const opened = await controller.open('https://example.com/')
      await expect(controller.waitForUser('Wait', undefined, 20, false, opened.tabId)).rejects.toThrow('Timed out')
      await expect(controller.execute('1+1', 5000, false, opened.tabId)).resolves.toBe('ok')
      await controller.dispose()
    })

    it('detaches page automation while the user verifies, preserves control through redirects, and resumes on Continue', async () => {
      const electron = await import('electron')
      const controller = new CdpBrowserController()
      const { tabId } = await controller.open('https://example.com/')
      const windowInfo = [...(controller as any).windows.values()][0]
      const tab = windowInfo.tabs.get(tabId)
      const wait = controller.waitForUser('Verify manually', 'captcha', 5000, false, tabId)
      await vi.waitFor(() => expect(tab.manualControl).toBe(true))
      expect((electron as any).__mockDebugger.detach).toHaveBeenCalled()
      const probes = tab.view.webContents.executeJavaScript.mock.calls.length
      ;(controller as any).clearUserActionForNavigation(tab, true)
      ;(controller as any).scheduleUserActionDetection(windowInfo, tab)
      await (controller as any).detectUserActionForTab(windowInfo, tab)
      expect(tab.view.webContents.executeJavaScript.mock.calls.length).toBe(probes)
      await expect(controller.execute('1+1', 5000, false, tabId)).rejects.toThrow('under user control')
      await expect(controller.screenshot({}, false, tabId)).rejects.toThrow('under user control')
      await expect(controller.open('https://other.example/')).rejects.toThrow('under user control')
      windowInfo.lastActive = 0
      ;(controller as any).sweepIdle()
      expect(windowInfo.window.isDestroyed()).toBe(false)
      ;(controller as any).handleTabBarAction(windowInfo, { type: 'handoff-continue' })
      await expect(wait).resolves.toMatchObject({ status: 'continued' })
      expect(tab.manualControl).toBe(false)
      ;(electron as any).__mockDebugger.isAttached.mockReturnValueOnce(false)
      await expect(controller.execute('1+1', 5000, false, tabId)).resolves.toBe('ok')
      expect((electron as any).__mockDebugger.attach).toHaveBeenCalled()
      await controller.dispose()
    })

    it('hands a challenge to the user before attempting content extraction', async () => {
      const electron = await import('electron')
      const controller = new CdpBrowserController()
      // The first probe belongs to the page opened below.
      const { tabId } = await controller.open('https://example.com/')
      const tab = [...(controller as any).windows.values()][0].tabs.get(tabId)
      tab.view.webContents.executeJavaScript.mockResolvedValue({
        url: 'https://example.com/',
        title: 'Just a moment...',
        text: 'Verify you are human',
        hasBrowserChallenge: true
      })
      ;(electron as any).__mockSendCommand.mockClear()
      const result = await controller.fetch('https://example.com/', 'markdown', 5000, false, false, false)
      expect(result.tabId).toBe(tabId)
      expect(JSON.parse(result.content as string).userAction.reason).toBe('captcha')
      expect((electron as any).__mockSendCommand).not.toHaveBeenCalled()
      expect(tab.manualControl).toBe(true)
      await controller.dispose()
    })

    it('opens only the current HTTP(S) page externally and reports that verification is not shared', async () => {
      const electron = await import('electron')
      const controller = new CdpBrowserController()
      const { tabId } = await controller.open('https://example.com/')
      const windowInfo = [...(controller as any).windows.values()][0]
      const wait = controller.waitForUser('Verify', 'captcha', 5000, false, tabId)
      await vi.waitFor(() => expect(windowInfo.handoff).toBeDefined())
      await (controller as any).openInSystemBrowser(windowInfo)
      expect(electron.shell.openExternal).toHaveBeenCalledWith('https://example.com/')
      expect(windowInfo.handoff).toBeDefined()
      ;(controller as any).handleTabBarAction(windowInfo, { type: 'handoff-continue' })
      await expect(wait).resolves.toMatchObject({
        status: 'continued',
        externalBrowserOpened: true,
        guidance: expect.stringContaining('not shared')
      })
      windowInfo.tabs.get(tabId).view.webContents.getURL.mockReturnValue('file:///C:/danger.exe')
      await expect((controller as any).openInSystemBrowser(windowInfo)).rejects.toThrow('Only HTTP(S)')
      expect(electron.shell.openExternal).toHaveBeenCalledOnce()
      await controller.dispose()
    })

    it('requires a user choice before moving a private page into the system browser', async () => {
      const electron = await import('electron')
      const controller = new CdpBrowserController()
      await controller.open('https://example.com/', 5000, true)
      const windowInfo = [...(controller as any).windows.values()][0]
      await (controller as any).openInSystemBrowser(windowInfo)
      expect(electron.dialog.showMessageBox).toHaveBeenCalled()
      expect(electron.shell.openExternal).not.toHaveBeenCalled()
      vi.mocked(electron.dialog.showMessageBox).mockResolvedValueOnce({ response: 1, checkboxChecked: false })
      await (controller as any).openInSystemBrowser(windowInfo)
      expect(electron.shell.openExternal).toHaveBeenCalledOnce()
      await controller.dispose()
    })
    it('waits until the user continues from the visible browser', async () => {
      const controller = new CdpBrowserController()
      const waitPromise = controller.waitForUser('Please sign in, then continue.', 'login_required', 1000)

      await vi.waitFor(() => {
        const windows = (controller as any).windows as Map<string, any>
        expect(windows.size).toBe(1)
        expect(Array.from(windows.values())[0].handoff).toBeDefined()
      })

      const windows = (controller as any).windows as Map<string, any>
      const windowInfo = Array.from(windows.values())[0]
      ;(controller as any).handleTabBarAction(windowInfo, { type: 'handoff-continue' })

      await expect(waitPromise).resolves.toMatchObject({ status: 'continued' })
      expect(windowInfo.handoff).toBeUndefined()
    })

    it('continues immediately when the user clicks an automatic handoff before wait_for_user starts', async () => {
      const controller = new CdpBrowserController()
      const opened = await controller.open('https://example.com/', 5000, false)
      const windows = (controller as any).windows as Map<string, any>
      const windowInfo = Array.from(windows.values())[0]
      const tab = windowInfo.tabs.get(opened.tabId)

      tab.userAction = {
        reason: 'login_required',
        message: '请完成登录。',
        url: 'https://example.com/login',
        detectedAt: Date.now()
      }
      tab.userActionFingerprint = 'login_required:https://example.com/login'
      ;(controller as any).handleTabBarAction(windowInfo, { type: 'handoff-continue' })

      await expect(
        controller.waitForUser('请完成登录。', 'login_required', 1000, false, opened.tabId)
      ).resolves.toMatchObject({ status: 'continued' })
      expect(windowInfo.handoff).toBeUndefined()
    })

    it('rejects a handoff for a non-existent tab instead of creating a window-level handoff', async () => {
      const controller = new CdpBrowserController()

      await expect(
        controller.waitForUser('请完成登录。', 'login_required', 1000, false, 'missing-tab')
      ).rejects.toThrow('Tab missing-tab not found')
    })
  })

  describe('Window limits and eviction', () => {
    it('respects maxWindows limit', async () => {
      const controller = new CdpBrowserController({ maxWindows: 1 })
      await controller.open('https://example.com/', 5000, false)
      await controller.open('https://example.com/', 5000, true)

      const normalTabs = await controller.listTabs(false)
      const privateTabs = await controller.listTabs(true)

      expect(privateTabs.length).toBe(1)
      expect(normalTabs.length).toBe(0)
    })

    it('cleans up idle windows on next access', async () => {
      const controller = new CdpBrowserController({ idleTimeoutMs: 50 })
      await controller.open('https://example.com/', 5000, false)

      await new Promise((r) => setTimeout(r, 100))

      await controller.open('https://example.com/', 5000, true)

      const normalTabs = await controller.listTabs(false)
      expect(normalTabs.length).toBe(0)
    })
  })
})
