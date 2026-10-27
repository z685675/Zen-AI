import { useTheme } from '@renderer/context/ThemeProvider'
import { useProviders } from '@renderer/hooks/useProvider'
import { useAppSelector } from '@renderer/store'
import { Button, Spin } from 'antd'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { imageCanvasProviders } from './imageCanvasProviders'

export default function ImageCanvasPage({ active = true, menuOpen = false }: { active?: boolean; menuOpen?: boolean }) {
  const { t, i18n } = useTranslation()
  const { theme } = useTheme()
  const { providers } = useProviders()
  const userFontFamily = useAppSelector((state) => state.settings.userTheme.userFontFamily)
  const catalog = useMemo(() => imageCanvasProviders(providers), [providers])
  const latest = useRef(catalog)
  latest.current = catalog
  const container = useRef<HTMLDivElement>(null)
  const display = useRef({ active, menuOpen })
  display.current = { active, menuOpen }
  const updateView = useRef<() => void>(() => undefined)
  const [state, setState] = useState<'opening' | 'ready' | 'error'>('opening')
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (state === 'ready') void window.api.imageCanvas.sync(catalog)
  }, [catalog, state])
  useEffect(() => {
    updateView.current()
  }, [active, menuOpen])
  useEffect(() => {
    const element = container.current
    if (!element) return
    let cancelled = false
    let opened = false
    let frame: number | undefined
    let lastVisible: boolean | undefined
    const bounds = () => {
      const rect = element.getBoundingClientRect()
      return { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) }
    }
    const visibility = () => {
      if (cancelled || !opened) return
      const visible =
        display.current.active &&
        !display.current.menuOpen &&
        ![
          ...document.querySelectorAll(
            '[role="dialog"],.ant-select-dropdown:not(.ant-select-dropdown-hidden),.ant-dropdown:not(.ant-dropdown-hidden)'
          )
        ].some((node) => {
          const rect = node.getBoundingClientRect()
          return rect.width > 0 && rect.height > 0
        })
      if (visible !== lastVisible) {
        lastVisible = visible
        void window.api.imageCanvas.setVisible(visible)
      }
    }
    const update = () => {
      if (cancelled || !opened) return
      if (display.current.active) void window.api.imageCanvas.resize(bounds())
      visibility()
    }
    updateView.current = update
    const overlays = new MutationObserver(() => {
      if (frame === undefined)
        frame = requestAnimationFrame(() => {
          frame = undefined
          visibility()
        })
    })
    overlays.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden']
    })
    const observer = new ResizeObserver(() => {
      update()
    })
    observer.observe(element)
    setState('opening')
    void window.api.imageCanvas
      .open({
        providers: latest.current,
        bounds: bounds(),
        theme: theme === 'dark' ? 'dark' : 'light',
        language: i18n.language,
        userFontFamily
      })
      .then(async (result) => {
        if (cancelled) return
        opened = result.ok
        if (opened) {
          update()
        }
        setState(opened ? 'ready' : 'error')
      })
      .catch(() => {
        if (!cancelled) setState('error')
      })
    return () => {
      cancelled = true
      updateView.current = () => undefined
      observer.disconnect()
      overlays.disconnect()
      if (frame !== undefined) cancelAnimationFrame(frame)
      void window.api.imageCanvas.close()
    }
  }, [attempt, theme, i18n.language, userFontFamily])
  return (
    <div
      ref={container}
      aria-hidden={!active}
      style={{ flex: 1, minHeight: 0, display: active ? 'grid' : 'none', placeItems: 'center' }}>
      {state === 'opening' && <Spin tip={t('image_studio.opening')} />}
      {state === 'error' && (
        <div style={{ maxWidth: 480, padding: 32, textAlign: 'center' }}>
          <p>{t('image_studio.workbench_unavailable')}</p>
          <Button onClick={() => setAttempt((value) => value + 1)}>{t('image_studio.reconnect')}</Button>
        </div>
      )}
    </div>
  )
}
