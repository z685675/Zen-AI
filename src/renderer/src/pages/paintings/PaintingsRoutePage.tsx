import { loggerService } from '@logger'
import { Navbar, NavbarCenter } from '@renderer/components/app/Navbar'
import { isImageGenerationEndpointModel } from '@renderer/config/models'
import { usePaintingProviders } from '@renderer/hooks/useProvider'
import { useAppDispatch } from '@renderer/store'
import { setDefaultPaintingProvider } from '@renderer/store/settings'
import { updateTab } from '@renderer/store/tabs'
import { Select } from 'antd'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import ImageCanvasPage from './ImageCanvasPage'
import NewApiPage from './NewApiPage'

const logger = loggerService.withContext('PaintingsRoutePage')

const LegacyPaintingsRoutePage: FC = () => {
  const params = useParams()
  const provider = params['*']
  const dispatch = useAppDispatch()
  const providers = usePaintingProviders()
  const [ovmsStatus, setOvmsStatus] = useState<'not-installed' | 'not-running' | 'running'>('not-running')

  useEffect(() => {
    const checkStatus = async () => {
      const status = await window.api.ovms.getStatus()
      setOvmsStatus(status)
    }
    void checkStatus()
  }, [])

  const validOptions = useMemo(
    () =>
      providers
        .filter((provider) => provider.enabled)
        .filter((provider) => provider.models.some((model) => isImageGenerationEndpointModel(model, provider)))
        .map((provider) => provider.id)
        .filter((option) => option !== 'ovms' || ovmsStatus === 'running'),
    [providers, ovmsStatus]
  )
  const firstAvailableProvider = validOptions[0]

  useEffect(() => {
    logger.debug(`defaultPaintingProvider: ${provider}`)
    if (provider && validOptions.includes(provider)) {
      dispatch(setDefaultPaintingProvider(provider))
      dispatch(updateTab({ id: 'paintings', updates: { path: `/paintings/${provider}` } }))
    }
  }, [provider, dispatch, validOptions])

  if (!firstAvailableProvider) {
    return <NewApiPage Options={[]} showNavbar={false} />
  }

  return (
    <Routes>
      <Route index element={<Navigate to={`/paintings/${firstAvailableProvider}`} replace />} />
      <Route
        path="*"
        element={
          validOptions.includes(provider || '') ? (
            <NewApiPage Options={validOptions} showNavbar={false} />
          ) : (
            <Navigate to={`/paintings/${firstAvailableProvider}`} replace />
          )
        }
      />
      {validOptions.map((providerId) => (
        <Route key={providerId} path={providerId} element={<NewApiPage Options={validOptions} showNavbar={false} />} />
      ))}
    </Routes>
  )
}

const PaintingsRoutePage: FC = () => {
  const { t } = useTranslation()
  const [mode, setMode] = useState<'workbench' | 'local'>('workbench')
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <Navbar>
        <NavbarCenter>{t('paintings.title')}</NavbarCenter>
      </Navbar>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          flexShrink: 0,
          borderBottom: '1px solid var(--color-border)'
        }}>
        <Select
          size="small"
          aria-label={t('image_studio.workbench')}
          value={mode}
          onChange={setMode}
          onOpenChange={setMenuOpen}
          style={{ minWidth: 140 }}
          options={(
            [
              ['workbench', 'image_studio.workbench'],
              ['local', 'image_studio.local']
            ] as const
          ).map(([value, key]) => ({ value, label: t(key) }))}
        />
      </div>
      {/* Keep the workbench mounted: switching modes must not race native close/open
          or lose a draft while its generation is still running. */}
      <ImageCanvasPage active={mode === 'workbench'} menuOpen={menuOpen} />
      {mode === 'local' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
          <LegacyPaintingsRoutePage />
        </div>
      )}
    </div>
  )
}

export default PaintingsRoutePage
