import { isIP } from 'node:net'

import { assertPublicDnsAnswers } from '../assistantPublicNetwork'
import { parsePublicWebUrl, PUBLIC_WEB_PROTOCOLS, webHostname } from '../publicWebNetwork'

const NETWORK_PROTOCOLS = [...PUBLIC_WEB_PROTOCOLS, 'ws:', 'wss:']
const securedSessions = new WeakSet<Electron.Session>()

export function allowBrowserNavigation(value: string, isMainFrame = true): boolean {
  try {
    if (!isMainFrame) {
      const url = new URL(value)
      // Inline frames do not open a local file or network connection.
      if (['about:blank', 'about:srcdoc'].includes(url.href) || ['data:', 'blob:'].includes(url.protocol)) return true
    }
    parsePublicWebUrl(value)
    return true
  } catch {
    return false
  }
}

export function protectBrowserSession(browserSession: Electron.Session): void {
  if (securedSessions.has(browserSession)) return
  const inFlight = new Map<string, Promise<void>>()

  const verify = async (host: string) => {
    const controller = new AbortController()
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => {
          const { endpoints } = await browserSession.resolveHost(host)
          controller.signal.throwIfAborted()
          await assertPublicDnsAnswers(
            host,
            endpoints.map(({ address }) => address),
            controller.signal
          )
        })(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            const error = new Error('Browser DNS check timed out')
            controller.abort(error)
            reject(error)
          }, 8_000)
        })
      ])
    } finally {
      clearTimeout(timeout)
    }
  }

  browserSession.webRequest.onBeforeRequest((details, callback) => {
    const allow = async () => {
      const url = new URL(details.url)
      if (details.resourceType !== 'mainFrame' && ['data:', 'blob:'].includes(url.protocol)) return
      const hostname = webHostname(parsePublicWebUrl(details.url, NETWORK_PROTOCOLS))
      if (isIP(hostname)) return

      let validation = inFlight.get(hostname)
      if (!validation) {
        validation = verify(hostname).finally(() => inFlight.delete(hostname))
        inFlight.set(hostname, validation)
      }
      await validation
    }

    void allow().then(
      () => callback({ cancel: false }),
      () => callback({ cancel: true })
    )
  })
  securedSessions.add(browserSession)
}
