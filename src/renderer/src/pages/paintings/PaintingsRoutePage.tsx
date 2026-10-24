import { loggerService } from '@logger'
import { isImageGenerationEndpointModel } from '@renderer/config/models'
import { usePaintingProviders } from '@renderer/hooks/useProvider'
import { useAppDispatch } from '@renderer/store'
import { setDefaultPaintingProvider } from '@renderer/store/settings'
import { updateTab } from '@renderer/store/tabs'
import { isZenManagedApiHost } from '@shared/config/zenProvider'
import { Button, Select } from 'antd'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import ImageCanvasPage from './ImageCanvasPage'
import ImageStudioPage from './ImageStudioPage'
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
    return <NewApiPage Options={[]} />
  }

  return (
    <Routes>
      <Route index element={<Navigate to={`/paintings/${firstAvailableProvider}`} replace />} />
      <Route
        path="*"
        element={
          validOptions.includes(provider || '') ? (
            <NewApiPage Options={validOptions} />
          ) : (
            <Navigate to={`/paintings/${firstAvailableProvider}`} replace />
          )
        }
      />
      {validOptions.map((providerId) => (
        <Route key={providerId} path={providerId} element={<NewApiPage Options={validOptions} />} />
      ))}
    </Routes>
  )
}

const PaintingsRoutePage: FC = () => {
  const { t } = useTranslation()
  const providers = usePaintingProviders().filter((item) => item.enabled && isZenManagedApiHost(item.apiHost))
  const [mode, setMode] = useState<'workbench' | 'canvas' | 'web' | 'local'>('workbench')
  const [providerID, setProviderID] = useState('')
  const [keyIndex, setKeyIndex] = useState(0)
  const selected = providers.find((item) => item.id === providerID) || providers[0]
  const keys = useMemo(
    () =>
      selected?.apiKey
        .split(/(?<!\\),|\r?\n/)
        .map((key) => key.trim().replace(/\\,/g, ','))
        .filter(Boolean) || [],
    [selected?.apiKey]
  )
  // A stable, explicit key keeps history from changing when provider key
  // rotation would otherwise pick a different identity on every reconnect.
  const scopedProvider = useMemo(
    () => (selected ? { ...selected, apiKey: keys[keyIndex] || keys[0] || '' } : undefined),
    [selected, keys, keyIndex]
  )
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '10px 16px',
          borderBottom: '1px solid var(--color-border)'
        }}>
        <Select
          size="small"
          aria-label={t('image_studio.workbench')}
          value={mode}
          onChange={setMode}
          options={(
            [
              ['workbench', 'image_studio.workbench'],
              ['canvas', 'image_studio.canvas'],
              ['web', 'image_studio.server'],
              ['local', 'image_studio.local']
            ] as const
          ).map(([value, key]) => ({ value, label: t(key) }))}
        />
        {mode === 'web' && providers.length > 1 && (
          <Select
            size="small"
            value={selected?.id}
            options={providers.map((item) => ({ value: item.id, label: item.name }))}
            onChange={setProviderID}
          />
        )}
        {mode === 'web' && keys.length > 1 && (
          <Select
            size="small"
            aria-label={t('image_studio.key_label')}
            value={keys[keyIndex] ? keyIndex : 0}
            options={keys.map((_, index) => ({ value: index, label: t('image_studio.key', { index: index + 1 }) }))}
            onChange={setKeyIndex}
          />
        )}
        <Button size="small" style={{ marginLeft: 'auto' }} onClick={() => window.navigate('/settings/provider')}>
          {t('model_setup.open_settings')}
        </Button>
      </div>
      {mode === 'workbench' || mode === 'canvas' ? (
        <ImageCanvasPage key={mode} surface={mode === 'workbench' ? 'workbench' : 'canvas'} />
      ) : mode === 'web' ? (
        <ImageStudioPage provider={scopedProvider} />
      ) : (
        <div style={{ flex: 1, minHeight: 0 }}>
          <LegacyPaintingsRoutePage />
        </div>
      )}
    </div>
  )
}

export default PaintingsRoutePage
