import { AiProvider } from '@renderer/aiCore'
import type { Provider } from '@renderer/types'
import { Button, Spin } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

export default function ImageStudioPage({ provider }: { provider?: Provider }) {
  const { t } = useTranslation()
  const container = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<'opening' | 'ready' | 'error'>('opening')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const element = container.current
    if (!element || !provider) {
      setState('error')
      return
    }
    let cancelled = false
    let opened = false
    let lastVisibility: boolean | undefined
    let overlayFrame: number | undefined
    const syncVisibility = () => {
      if (!opened || cancelled) return
      const overlay = [...document.querySelectorAll('[role="dialog"],.ant-select-dropdown,.ant-dropdown')].some(
        (node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        }
      )
      const visible = !overlay
      if (lastVisibility !== visible) {
        lastVisibility = visible
        void window.api.imageStudio.setVisible(visible)
      }
    }
    // Native views otherwise sit above renderer dialogs and dropdowns. Park
    // the view while local overlays are open, preserving its form and session.
    const overlays = new MutationObserver(() => {
      if (overlayFrame === undefined)
        overlayFrame = requestAnimationFrame(() => {
          overlayFrame = undefined
          syncVisibility()
        })
    })
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    })
    const bounds = () => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
    }
    setState('opening')
    const open = async () => {
      const apiKey = new AiProvider(provider).getApiKey()
      const result = await window.api.imageStudio.open({ apiHost: provider.apiHost, apiKey, bounds: bounds() })
      if (!cancelled) {
        opened = result.ok
        if (opened) await window.api.imageStudio.resize(bounds())
        syncVisibility()
        setState(result.ok ? 'ready' : 'error')
      }
    }
    void open().catch(() => {
      if (!cancelled) setState('error')
    })
    const observer = new ResizeObserver(() => {
      if (opened && !cancelled) void window.api.imageStudio.resize(bounds())
    })
    observer.observe(element)
    return () => {
      cancelled = true
      observer.disconnect()
      overlays.disconnect()
      if (overlayFrame !== undefined) cancelAnimationFrame(overlayFrame)
      void window.api.imageStudio.close()
    }
  }, [provider, attempt])
  return (
    <div
      ref={container}
      style={{
        flex: 1,
        minHeight: 0,
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
      {state === 'opening' && <Spin tip={t('image_studio.opening')} />}
      {state === 'error' && (
        <div style={{ maxWidth: 460, padding: 32, textAlign: 'center' }}>
          <h3>{t('image_studio.title')}</h3>
          <p>{t('image_studio.unavailable')}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t('image_studio.reconnect')}</Button>
        </div>
      )}
    </div>
  )
}
