import { JSDOM } from 'jsdom'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/utils/locales', () => ({ t: (key: string) => key }))

import { detectUserAction, USER_ACTION_DETECTION_SCRIPT } from '../userAction'

const baseSignals = {
  url: 'https://example.com/',
  title: 'Example',
  text: '',
  hasPasswordField: false,
  hasLoginControl: false,
  hasCaptchaField: false,
  hasVerificationControl: false,
  hasAuthorizationControl: false
}

describe('browser user-action detection', () => {
  const inspect = (html: string) => {
    const dom = new JSDOM(html, { url: 'https://example.com/', runScripts: 'outside-only' })
    dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 100, height: 30 }) as DOMRect
    // jsdom has no layout-backed innerText; these fixtures contain visible text only.
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
      get(this: HTMLElement) {
        return this.textContent
      }
    })
    try {
      return dom.window.eval(USER_ACTION_DETECTION_SCRIPT)
    } finally {
      dom.window.close()
    }
  }

  it('does not interrupt research pages merely mentioning verification, authorization or CAPTCHA', () => {
    const signals = inspect(
      '<h1>Verification of fatigue results</h1><p>CAPTCHA and authorization research.</p><button>Download paper</button>'
    )
    expect(signals.hasVerificationControl).toBe(false)
    expect(signals.hasCaptchaField).toBe(false)
    expect(detectUserAction(signals)).toBeUndefined()
  })

  it('detects a visible Cloudflare frame without accessing its cross-origin document', () => {
    const signals = inspect(
      '<h1>Are you a robot?</h1><iframe src="https://challenges.cloudflare.com/turnstile/widget"></iframe>'
    )
    expect(signals.hasBrowserChallenge).toBe(true)
    expect(detectUserAction(signals)).toMatchObject({ reason: 'captcha' })
  })

  it('detects a login page', () => {
    expect(
      detectUserAction({
        ...baseSignals,
        url: 'https://example.com/login',
        hasPasswordField: true,
        hasLoginControl: true
      })
    ).toMatchObject({ reason: 'login_required' })
  })

  it('detects CAPTCHA only when the page exposes a CAPTCHA signal', () => {
    expect(
      detectUserAction({
        ...baseSignals,
        text: 'Please complete CAPTCHA',
        hasCaptchaField: true
      })
    ).toMatchObject({ reason: 'captcha' })
  })

  it('detects two-factor verification before generic login', () => {
    expect(
      detectUserAction({
        ...baseSignals,
        url: 'https://example.com/login',
        text: 'Enter your two-factor security code',
        hasPasswordField: true,
        hasLoginControl: true,
        hasVerificationControl: true
      })
    ).toMatchObject({ reason: 'two_factor' })
  })

  it('does not interrupt an ordinary public page', () => {
    expect(
      detectUserAction({
        ...baseSignals,
        title: 'Research paper'
      })
    ).toBeUndefined()
  })

  it('recognizes a Cloudflare challenge even when its checkbox is inside a cross-origin frame', () => {
    expect(
      detectUserAction({
        ...baseSignals,
        title: 'Just a moment...',
        text: 'Are you a robot? Please confirm you are a human.',
        hasBrowserChallenge: true
      })
    ).toMatchObject({ reason: 'captcha' })
  })

  it('does not interrupt a normal form solely because it embeds Turnstile', () => {
    expect(detectUserAction({ ...baseSignals, title: 'Contact us', hasBrowserChallenge: true })).toBeUndefined()
    expect(detectUserAction({ ...baseSignals, text: 'An article about Cloudflare verification.' })).toBeUndefined()
  })
})
