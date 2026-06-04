import { loggerService } from '@logger'
import { isImageGenerationEndpointModel } from '@renderer/config/models'
import { usePaintingProviders } from '@renderer/hooks/useProvider'
import { useAppDispatch } from '@renderer/store'
import { setDefaultPaintingProvider } from '@renderer/store/settings'
import { updateTab } from '@renderer/store/tabs'
import type { FC } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { Navigate, Route, Routes, useParams } from 'react-router-dom'

import NewApiPage from './NewApiPage'

const logger = loggerService.withContext('PaintingsRoutePage')

const PaintingsRoutePage: FC = () => {
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
        .filter((provider) => provider.models.some(isImageGenerationEndpointModel))
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

export default PaintingsRoutePage
