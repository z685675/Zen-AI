import './style.css'
import '../../../src/renderer/src/assets/fonts/harmonyos/harmonyos.css'
import '../../../src/renderer/src/assets/fonts/country-flag-fonts/flag.css'

import type { ImageCanvasAppearance } from '@shared/config/imageCanvas'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useTranslation } from 'react-i18next'

import i18next from './i18n'
import { VideoWorkbench } from './VideoWorkbench'
import Workbench from './Workbench'

const appearance = new URLSearchParams(location.hash.slice(1))
document.body.setAttribute('os', appearance.get('os') || '')
function applyAppearance({ theme, themePreset, userFontFamily, language }: ImageCanvasAppearance) {
  document.body.setAttribute('theme-mode', theme === 'dark' ? 'dark' : 'light')
  document.body.dataset.themePreset = themePreset === 'zen-paper' ? 'zen-paper' : 'codex'
  const style = document.documentElement.style
  if (userFontFamily) style.setProperty('--user-font-family', JSON.stringify(userFontFamily))
  else style.removeProperty('--user-font-family')
  if (language && language !== i18next.language) void i18next.changeLanguage(language)
}

applyAppearance({
  theme: appearance.get('theme') === 'dark' ? 'dark' : 'light',
  themePreset: appearance.get('themePreset') === 'zen-paper' ? 'zen-paper' : 'codex',
  userFontFamily: appearance.get('userFontFamily') || appearance.get('fontFamily') || undefined
})
window.imageCanvas?.onAppearance?.(applyAppearance)

function MediaWorkspace() {
  const { t } = useTranslation()
  const [videoActive, setVideoActive] = useState(false)
  const [firstFrame, setFirstFrame] = useState('')
  return (
    <div className="media-workspace">
      <nav className="media-tabbar" aria-label={t('video.navigation')}>
        <button type="button" aria-pressed={!videoActive} onClick={() => setVideoActive(false)}>
          {t('title')}
        </button>
        <button type="button" aria-pressed={videoActive} onClick={() => setVideoActive(true)}>
          {t('video.title')}
        </button>
      </nav>
      <div className="media-panel" hidden={videoActive}>
        <Workbench
          onUseVideo={(data) => {
            setFirstFrame(data)
            setVideoActive(true)
          }}
        />
      </div>
      <div className="media-panel" hidden={!videoActive}>
        <VideoWorkbench active={videoActive} firstFrame={firstFrame} onFirstFrame={setFirstFrame} />
      </div>
    </div>
  )
}
createRoot(document.getElementById('root')!).render(<MediaWorkspace />)
