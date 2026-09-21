import type { BrowserUserActionReason } from './types'

export interface BrowserPageSignals {
  url: string
  title: string
  text: string
  hasPasswordField: boolean
  hasLoginControl: boolean
  hasCaptchaField: boolean
  hasVerificationControl: boolean
  hasAuthorizationControl: boolean
}

export interface DetectedUserAction {
  reason: BrowserUserActionReason
  message: string
}

export const USER_ACTION_DETECTION_SCRIPT = `(() => {
  const visible = (element) => {
    if (!element || !element.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const elements = Array.from(document.querySelectorAll('input, button, [role="button"]'));
  const visibleInputs = elements.filter(visible);
  const inputText = visibleInputs.map((element) => [
    element.getAttribute('type') || '',
    element.getAttribute('name') || '',
    element.getAttribute('id') || '',
    element.getAttribute('placeholder') || '',
    element.textContent || '',
    element.getAttribute('aria-label') || ''
  ].join(' ')).join(' ');
  const bodyText = (document.body?.innerText || '').slice(0, 8000);
  const allText = (inputText + ' ' + bodyText).toLowerCase();
  return {
    url: location.href,
    title: document.title || '',
    text: bodyText,
    hasPasswordField: visibleInputs.some((element) => element.tagName === 'INPUT' && (element.getAttribute('type') || '').toLowerCase() === 'password'),
    hasLoginControl: /(log in|login|sign in|signin|登录|登陆|统一认证|用户登录)/i.test(allText),
    hasCaptchaField: /(captcha|recaptcha|hcaptcha|验证码|人机验证|滑块验证)/i.test(allText),
    hasVerificationControl: /(verify|verification|two.factor|2fa|security code|短信验证码|二次验证|双因素|安全验证)/i.test(allText),
    hasAuthorizationControl: /(authorize|consent|授权|同意访问|允许访问)/i.test(allText)
  };
})()`

const AUTH_URL_PATTERN = /\/(?:login|signin|sign-in|sso|oauth\/authorize|passport|account\/login)(?:[/?#]|$)/i
const CAPTCHA_PATTERN = /(captcha|recaptcha|hcaptcha|人机验证|滑块验证|验证码)/i
const TWO_FACTOR_PATTERN = /(two[- ]factor|2fa|二次验证|双因素|短信验证码|动态验证码)/i
const VERIFICATION_PATTERN = /(verify|verification|security check|安全验证|身份验证|验证身份)/i
const AUTHORIZATION_PATTERN = /(authorize|授权|consent|同意访问|account access)/i

export function detectUserAction(signals: BrowserPageSignals): DetectedUserAction | undefined {
  const searchableText = `${signals.url} ${signals.title} ${signals.text}`

  if (
    TWO_FACTOR_PATTERN.test(searchableText) &&
    (signals.hasVerificationControl || AUTH_URL_PATTERN.test(signals.url))
  ) {
    return { reason: 'two_factor', message: '请在浏览器中完成二次验证或输入验证码，完成后点击“完成后继续”。' }
  }

  if (CAPTCHA_PATTERN.test(searchableText) && (signals.hasCaptchaField || AUTH_URL_PATTERN.test(signals.url))) {
    return { reason: 'captcha', message: '请在浏览器中完成验证码或人机验证，完成后点击“完成后继续”。' }
  }

  if (
    AUTHORIZATION_PATTERN.test(searchableText) &&
    (signals.hasAuthorizationControl || AUTH_URL_PATTERN.test(signals.url))
  ) {
    return { reason: 'authorization', message: '请在浏览器中确认授权或账号访问权限，完成后点击“完成后继续”。' }
  }

  if (VERIFICATION_PATTERN.test(searchableText) && signals.hasVerificationControl) {
    return { reason: 'verification', message: '请在浏览器中完成身份验证，完成后点击“完成后继续”。' }
  }

  if (signals.hasLoginControl && (signals.hasPasswordField || AUTH_URL_PATTERN.test(signals.url))) {
    return { reason: 'login_required', message: '请在浏览器中完成登录，登录成功后点击“完成后继续”。' }
  }

  return undefined
}
