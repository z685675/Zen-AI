import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('../WindowService', () => ({
  windowService: {
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { executeJavaScript: execute }
    }),
    showMainWindow: vi.fn()
  }
}))

import { handleNavigateProtocolUrl } from './handle-navigate'

beforeEach(() => execute.mockReset().mockResolvedValue(true))

describe('in-app navigation protocol handler', () => {
  it('accepts allowed route segments and passes the query as a serialized value', async () => {
    const url = new URL("zenai://navigate/settings/provider?name=O'Connor")
    handleNavigateProtocolUrl(url)
    await vi.waitFor(() =>
      expect(execute).toHaveBeenLastCalledWith('window.navigate(' + JSON.stringify(url.pathname + url.search) + ')')
    )
  })

  it.each(['/unknown', '/agents-prefix', '//external.example'])('blocks unlisted routes (%s)', (route) => {
    handleNavigateProtocolUrl(new URL('zenai://navigate' + route))
    expect(execute).not.toHaveBeenCalled()
  })
})
