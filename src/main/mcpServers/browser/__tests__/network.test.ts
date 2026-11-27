import { describe, expect, it, vi } from 'vitest'

import { allowBrowserNavigation, protectBrowserSession } from '../network'

function prepare() {
  const register = vi.fn()
  const resolveHost = vi.fn()
  const session = { webRequest: { onBeforeRequest: register }, resolveHost } as unknown as Electron.Session
  protectBrowserSession(session)
  const request = (url: string, resourceType = 'mainFrame') =>
    new Promise((resolve) => register.mock.calls[0][0]({ url, resourceType }, resolve))
  return { register, request, resolveHost, session }
}

describe('Browser MCP network boundary', () => {
  it('installs a single session guard and checks Chromium DNS for each network destination', async () => {
    const { register, request, resolveHost, session } = prepare()
    protectBrowserSession(session)
    expect(register).toHaveBeenCalledOnce()
    resolveHost.mockResolvedValueOnce({ endpoints: [{ address: '93.184.216.34', family: 'ipv4' }] })
    await expect(request('https://public.example/')).resolves.toEqual({ cancel: false })
    resolveHost.mockResolvedValueOnce({ endpoints: [{ address: '10.0.0.2', family: 'ipv4' }] })
    await expect(request('https://private.example/', 'xhr')).resolves.toEqual({ cancel: true })
    expect(resolveHost).toHaveBeenCalledTimes(2)
  })

  it('allows public redirects and inline frames while rejecting local and non-web navigation', async () => {
    const { request, resolveHost } = prepare()
    expect(allowBrowserNavigation('https://public.example/')).toBe(true)
    expect(allowBrowserNavigation('about:srcdoc', false)).toBe(true)
    expect(allowBrowserNavigation('file:///example.txt', false)).toBe(false)
    await expect(request('file:///example.txt')).resolves.toEqual({ cancel: true })
    await expect(request('http://localhost/')).resolves.toEqual({ cancel: true })
    expect(resolveHost).not.toHaveBeenCalled()
  })
})
