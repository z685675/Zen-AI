import { describe, expect, it } from 'vitest'

import { detectUserAction } from '../userAction'

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
})
