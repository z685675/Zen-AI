import type { DropResult } from '@hello-pangea/dnd'
import { loggerService } from '@logger'
import {
  DraggableVirtualList,
  type DraggableVirtualListRef,
  useDraggableReorder
} from '@renderer/components/DraggableList'
import { DeleteIcon, EditIcon } from '@renderer/components/Icons'
import { ProviderAvatar } from '@renderer/components/ProviderAvatar'
import { useAllProviders, useProviders, useSystemProviders, useUserProviders } from '@renderer/hooks/useProvider'
import { useTimer } from '@renderer/hooks/useTimer'
import { fetchModels } from '@renderer/services/ApiService'
import ImageStorage from '@renderer/services/ImageStorage'
import { mergeSyncedProviderModels } from '@renderer/services/ProviderModelSyncUtils'
import { reconcileRemoteModelPolicyDefaults } from '@renderer/services/RemoteModelPolicyService'
import type { Provider, ProviderType } from '@renderer/types'
import { getFancyProviderName, matchKeywordsInModel, matchKeywordsInProvider, uuid } from '@renderer/utils'
import { isAnthropicSupportedProvider, isNewApiProvider } from '@renderer/utils/provider'
import type { MenuProps } from 'antd'
import { Button, Dropdown, Input, Tag } from 'antd'
import { Check, FileUp, Filter, GripVertical, PlusIcon, Search, UserPen } from 'lucide-react'
import type { FC } from 'react'
import { startTransition, useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import styled from 'styled-components'
import useSWRImmutable from 'swr/immutable'

import AddProviderPopup from './AddProviderPopup'
import ModelNotesPopup from './ModelNotesPopup'
import ProviderSetting from './ProviderSetting'
import UrlSchemaInfoPopup from './UrlSchemaInfoPopup'

const logger = loggerService.withContext('ProviderList')

const BUTTON_WRAPPER_HEIGHT = 50
const FOOTER_BUTTON_WRAPPER_HEIGHT = 96

const getIsOvmsSupported = async (): Promise<boolean> => {
  try {
    const result = await window.api.ovms.isSupported()
    return result
  } catch (e) {
    logger.warn('Fetching isOvmsSupported failed. Fallback to false.', e as Error)
    return false
  }
}

interface ProviderListProps {
  /** Whether in onboarding mode for new users */
  isOnboarding?: boolean
}

type ProviderImportPayload = {
  id: string
  apiKey: string
  baseUrl: string
  type?: ProviderType
  name?: string
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isProviderImportPayload(value: unknown): value is ProviderImportPayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }

  const payload = value as Record<string, unknown>
  return isNonEmptyString(payload.id) && isNonEmptyString(payload.apiKey) && isNonEmptyString(payload.baseUrl)
}

function normalizeImportedProvider(updatedProvider: Provider): Provider {
  if (!isNewApiProvider(updatedProvider)) {
    return updatedProvider
  }

  return {
    ...updatedProvider,
    anthropicApiHost: updatedProvider.apiHost
  }
}

const ProviderList: FC<ProviderListProps> = ({ isOnboarding = false }) => {
  const [searchParams, setSearchParams] = useSearchParams()
  const providers = useUserProviders()
  const allProviders = useAllProviders()
  const systemProviders = useSystemProviders()
  const { updateProviders, addProvider, removeProvider, updateProvider } = useProviders()
  const { setTimeoutTimer } = useTimer()
  const [selectedProvider, _setSelectedProvider] = useState<Provider | undefined>(providers[0])
  const { t } = useTranslation()
  const [searchText, setSearchText] = useState<string>('')
  const [dragging, setDragging] = useState(false)
  const [agentFilterEnabled, setAgentFilterEnabled] = useState(false)
  const [providerLogos, setProviderLogos] = useState<Record<string, string>>({})
  const listRef = useRef<DraggableVirtualListRef>(null)

  const { data: isOvmsSupported } = useSWRImmutable('ovms/isSupported', getIsOvmsSupported)

  const setSelectedProvider = useCallback((provider: Provider | undefined) => {
    startTransition(() => _setSelectedProvider(provider))
  }, [])

  useEffect(() => {
    if (providers.length === 0) {
      if (selectedProvider) {
        setSelectedProvider(undefined)
      }
      return
    }

    if (!selectedProvider || !providers.some((provider) => provider.id === selectedProvider.id)) {
      setSelectedProvider(providers[0])
    }
  }, [providers, selectedProvider, setSelectedProvider])

  useEffect(() => {
    const loadAllLogos = async () => {
      const logos: Record<string, string> = {}
      for (const provider of providers) {
        if (provider.id) {
          try {
            const logoData = await ImageStorage.get(`provider-${provider.id}`)
            if (logoData) {
              logos[provider.id] = logoData
            }
          } catch (error) {
            logger.error(`Failed to load logo for provider ${provider.id}`, error as Error)
          }
        }
      }
      setProviderLogos(logos)
    }

    void loadAllLogos()
  }, [providers])

  useEffect(() => {
    let shouldUpdate = false
    const hasFilterParam = searchParams.get('filter') === 'agent'

    if (hasFilterParam) {
      setAgentFilterEnabled(true)
      searchParams.delete('filter')
      searchParams.delete('id')
      shouldUpdate = true
    } else if (searchParams.get('id')) {
      const providerId = searchParams.get('id')
      const provider = providers.find((p) => p.id === providerId)

      if (provider) {
        setSelectedProvider(provider)
        const index = providers.findIndex((p) => p.id === providerId)
        if (index >= 0) {
          setTimeoutTimer(
            'scroll-to-selected-provider',
            () => listRef.current?.scrollToIndex(index, { align: 'center' }),
            100
          )
        }
      } else {
        setSelectedProvider(providers[0])
      }

      searchParams.delete('id')
      shouldUpdate = true
    }

    if (shouldUpdate) {
      setSearchParams(searchParams)
    }
  }, [providers, searchParams, setSearchParams, setSelectedProvider, setTimeoutTimer])

  const syncImportedProvider = useCallback(
    async (data: ProviderImportPayload, options?: { disableOtherProviders?: boolean }) => {
      const { id } = data
      const { updatedProvider, displayName } = await UrlSchemaInfoPopup.show({
        ...data,
        disableOtherProviders: options?.disableOtherProviders
      })
      window.navigate(`/settings/provider?id=${id}`)

      if (!updatedProvider) {
        return
      }

      let finalProvider = normalizeImportedProvider(updatedProvider)
      const models = await fetchModels(updatedProvider)
      if (models.length > 0) {
        finalProvider = mergeSyncedProviderModels({ ...finalProvider, models: [] }, models)
      }

      const disableOtherProviders = options?.disableOtherProviders === true
      const nextProviders: Provider[] = allProviders.map((provider) => ({
        ...provider,
        enabled: disableOtherProviders ? provider.id === finalProvider.id : provider.enabled
      }))

      const existingIndex = nextProviders.findIndex((provider) => provider.id === finalProvider.id)
      if (existingIndex === -1) {
        nextProviders.unshift({
          ...finalProvider,
          enabled: true
        })
      } else {
        nextProviders[existingIndex] = {
          ...nextProviders[existingIndex],
          ...finalProvider,
          enabled: true
        }
      }

      updateProviders(nextProviders)
      reconcileRemoteModelPolicyDefaults()
      try {
        await window.api.agentLifecycle.bootstrapBuiltins()
      } catch (error) {
        logger.warn('Failed to initialize the built-in assistant after Provider import', error as Error)
      }

      setSelectedProvider({
        ...finalProvider,
        enabled: true
      })
      window.navigate(`/settings/provider?id=${encodeURIComponent(finalProvider.id)}`)
      window.toast.success(t('settings.models.provider_key_added', { provider: displayName }))

      if (models.length > 0) {
        window.toast.success(
          t('settings.models.provider_models_synced', {
            provider: displayName,
            count: models.length
          })
        )
      } else {
        window.toast.warning(
          t('settings.models.provider_models_sync_empty', {
            provider: displayName
          })
        )
      }

      if (disableOtherProviders) {
        window.toast.success(
          t('settings.models.provider_import_disabled_others', {
            defaultValue: '已自动禁用其他 Provider，仅保留当前导入的 Provider 为启用状态。'
          })
        )
      }
    },
    [allProviders, setSelectedProvider, t, updateProviders]
  )

  useEffect(() => {
    const addProviderData = searchParams.get('addProviderData')
    if (!addProviderData) {
      return
    }

    try {
      const { id, apiKey: newApiKey, baseUrl, type, name } = JSON.parse(addProviderData)
      if (!id || !newApiKey || !baseUrl) {
        window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
        window.navigate('/settings/provider')
        return
      }

      void syncImportedProvider({ id, apiKey: newApiKey, baseUrl, type, name })
    } catch (error) {
      window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
      window.navigate('/settings/provider')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, t])

  const onAddProvider = async () => {
    const { name: providerName, type, logo } = await AddProviderPopup.show()

    if (!providerName.trim()) {
      return
    }

    const provider = {
      id: uuid(),
      name: providerName.trim(),
      type,
      apiKey: '',
      apiHost: '',
      models: [],
      enabled: true,
      isSystem: false
    } as Provider

    let updatedLogos = { ...providerLogos }
    if (logo) {
      try {
        await ImageStorage.set(`provider-${provider.id}`, logo)
        updatedLogos = {
          ...updatedLogos,
          [provider.id]: logo
        }
        setProviderLogos(updatedLogos)
      } catch (error) {
        logger.error('Failed to save logo', error as Error)
        window.toast.error(t('message.error.save_provider_logo'))
      }
    }

    addProvider(provider)
    setSelectedProvider(provider)
  }

  const onImportProvider = useCallback(async () => {
    try {
      const selected = await window.api.file.select({
        title: t('settings.models.provider_import_file_title', {
          defaultValue: '选择 Provider 导入文件'
        }),
        filters: [
          {
            name: t('settings.models.provider_import_file_filter', {
              defaultValue: 'JSON 文件'
            }),
            extensions: ['json']
          }
        ],
        properties: ['openFile']
      })

      if (!selected || selected.length === 0) {
        return
      }

      const [file] = selected
      const content = await window.api.fs.readText(file.path)
      const parsed = JSON.parse(content) as unknown

      if (!isProviderImportPayload(parsed)) {
        window.toast.error(t('settings.models.provider_key_add_failed_by_invalid_data'))
        return
      }

      await syncImportedProvider(parsed, { disableOtherProviders: true })
    } catch (error) {
      logger.error('Failed to import provider from file', error as Error)
      window.toast.error(
        t('settings.models.provider_import_failed', {
          defaultValue: '导入 Provider 失败，请检查 JSON 文件格式。'
        })
      )
    }
  }, [syncImportedProvider, t])

  useEffect(() => {
    if (searchParams.get('action') !== 'import') return

    const nextSearchParams = new URLSearchParams(searchParams)
    nextSearchParams.delete('action')
    setSearchParams(nextSearchParams, { replace: true })
    void onImportProvider()
  }, [onImportProvider, searchParams, setSearchParams])

  const getDropdownMenus = (provider: Provider): MenuProps['items'] => {
    const noteMenu = {
      label: t('settings.provider.notes.title'),
      key: 'notes',
      icon: <UserPen size={14} />,
      onClick: () => ModelNotesPopup.show({ provider })
    }

    const editMenu = {
      label: t('common.edit'),
      key: 'edit',
      icon: <EditIcon size={14} />,
      async onClick() {
        const { name, type, logoFile, logo } = await AddProviderPopup.show(provider)

        if (name) {
          updateProvider({ ...provider, name, type })
          if (provider.id) {
            if (logo) {
              try {
                await ImageStorage.set(`provider-${provider.id}`, logo)
                setProviderLogos((prev) => ({
                  ...prev,
                  [provider.id]: logo
                }))
              } catch (error) {
                logger.error('Failed to save logo', error as Error)
                window.toast.error(t('message.error.update_provider_logo'))
              }
            } else if (logo === undefined && logoFile === undefined) {
              try {
                await ImageStorage.set(`provider-${provider.id}`, '')
                setProviderLogos((prev) => {
                  const newLogos = { ...prev }
                  delete newLogos[provider.id]
                  return newLogos
                })
              } catch (error) {
                logger.error('Failed to reset logo', error as Error)
              }
            }
          }
        }
      }
    }

    const deleteMenu = {
      label: t('common.delete'),
      key: 'delete',
      icon: <DeleteIcon size={14} className="lucide-custom" />,
      danger: true,
      async onClick() {
        window.modal.confirm({
          title: t('settings.provider.delete.title'),
          content: t('settings.provider.delete.content'),
          okButtonProps: { danger: true },
          okText: t('common.delete'),
          centered: true,
          onOk: async () => {
            if (provider.id) {
              try {
                await ImageStorage.remove(`provider-${provider.id}`)
                setProviderLogos((prev) => {
                  const newLogos = { ...prev }
                  delete newLogos[provider.id]
                  return newLogos
                })
              } catch (error) {
                logger.error('Failed to delete logo', error as Error)
              }
            }

            const nextProviders = providers.filter((p) => p.id !== provider.id)
            setSelectedProvider(nextProviders[0])
            removeProvider(provider)
          }
        })
      }
    }

    return [editMenu, noteMenu, deleteMenu]
  }

  const filteredProviders = providers.filter((provider) => {
    if (provider.id === 'ovms' && !isOvmsSupported) {
      return false
    }

    if (agentFilterEnabled && !isAnthropicSupportedProvider(provider)) {
      return false
    }

    const keywords = searchText.toLowerCase().split(/\s+/).filter(Boolean)
    const isProviderMatch = matchKeywordsInProvider(keywords, provider)
    const isModelMatch = provider.models.some((model) => matchKeywordsInModel(keywords, model))
    return isProviderMatch || isModelMatch
  })

  const handleProviderOrderChange = useCallback(
    (updatedProviders: Provider[]) => {
      updateProviders([...updatedProviders, ...systemProviders])
    },
    [systemProviders, updateProviders]
  )

  const { onDragEnd: handleReorder, itemKey } = useDraggableReorder<Provider>({
    originalList: providers,
    filteredList: filteredProviders,
    onUpdate: handleProviderOrderChange,
    itemKey: 'id'
  })

  const handleDragStart = useCallback(() => {
    setDragging(true)
  }, [])

  const handleDragEnd = useCallback(
    (result: DropResult) => {
      setDragging(false)
      handleReorder(result)
    },
    [handleReorder]
  )

  const estimateItemSize = useCallback(() => 40, [])

  return (
    <Container className="selectable">
      <ProviderListContainer>
        {providers.length > 0 && (
          <>
            <AddButtonWrapper>
              <Input
                type="text"
                placeholder={t('settings.provider.search')}
                value={searchText}
                style={{ borderRadius: 'var(--list-item-border-radius)', height: 35 }}
                prefix={<Search size={14} />}
                suffix={
                  <Dropdown
                    menu={{
                      items: [
                        {
                          label: t('settings.provider.filter.all'),
                          key: 'all',
                          icon: agentFilterEnabled ? <CheckPlaceholder /> : <Check size={14} />,
                          onClick: () => setAgentFilterEnabled(false)
                        },
                        {
                          label: t('settings.provider.filter.agent'),
                          key: 'agent',
                          icon: agentFilterEnabled ? <Check size={14} /> : <CheckPlaceholder />,
                          onClick: () => setAgentFilterEnabled(true)
                        }
                      ]
                    }}
                    trigger={['click']}>
                    <FilterButton>
                      <Filter
                        size={14}
                        className={agentFilterEnabled ? 'text-[var(--color-primary)]' : 'text-[var(--color-text-3)]'}
                      />
                    </FilterButton>
                  </Dropdown>
                }
                onChange={(e) => setSearchText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation()
                    setSearchText('')
                  }
                }}
                allowClear
                disabled={dragging}
              />
            </AddButtonWrapper>
            <DraggableVirtualList<Provider>
              ref={listRef}
              list={filteredProviders}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              estimateSize={estimateItemSize}
              itemKey={itemKey}
              overscan={3}
              style={{
                height: `calc(100% - ${BUTTON_WRAPPER_HEIGHT + FOOTER_BUTTON_WRAPPER_HEIGHT}px)`
              }}
              scrollerStyle={{
                padding: 8,
                paddingRight: 5
              }}
              itemContainerStyle={{ paddingBottom: 5 }}>
              {(provider: Provider) => (
                <Dropdown menu={{ items: getDropdownMenus(provider) }} trigger={['contextMenu']}>
                  <ProviderListItem
                    key={provider.id}
                    className={provider.id === selectedProvider?.id ? 'active' : ''}
                    onClick={() => setSelectedProvider(provider)}>
                    <DragHandle>
                      <GripVertical size={12} />
                    </DragHandle>
                    <ProviderAvatar
                      style={{
                        width: 24,
                        height: 24
                      }}
                      provider={provider}
                      customLogos={providerLogos}
                    />
                    <ProviderItemName className="text-nowrap">{getFancyProviderName(provider)}</ProviderItemName>
                    {provider.enabled && (
                      <Tag color="green" style={{ marginLeft: 'auto', marginRight: 0, borderRadius: 16 }}>
                        ON
                      </Tag>
                    )}
                  </ProviderListItem>
                </Dropdown>
              )}
            </DraggableVirtualList>
          </>
        )}
        <FooterActionWrapper>
          <FooterButtonGroup>
            <Button
              style={{ width: '100%', borderRadius: 'var(--list-item-border-radius)' }}
              icon={<FileUp size={16} />}
              onClick={() => void onImportProvider()}
              disabled={dragging}>
              {t('settings.models.provider_import_button', { defaultValue: '导入' })}
            </Button>
            <Button
              style={{ width: '100%', borderRadius: 'var(--list-item-border-radius)' }}
              icon={<PlusIcon size={16} />}
              onClick={onAddProvider}
              disabled={dragging}>
              {t('button.add')}
            </Button>
          </FooterButtonGroup>
        </FooterActionWrapper>
      </ProviderListContainer>
      {selectedProvider ? (
        <ProviderSetting providerId={selectedProvider.id} key={selectedProvider.id} isOnboarding={isOnboarding} />
      ) : (
        <EmptyState>
          <EmptyStateTitle>
            {t('settings.provider.empty.title', { defaultValue: '请点击左侧的添加按钮' })}
          </EmptyStateTitle>
          <EmptyStateDescription>
            {t('settings.provider.empty.description', {
              defaultValue: '配置一个模型服务'
            })}
          </EmptyStateDescription>
        </EmptyState>
      )}
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  display: flex;
  flex-direction: row;
  justify-content: space-between;
`

const ProviderListContainer = styled.div`
  display: flex;
  flex-direction: column;
  min-width: calc(var(--settings-width) + 10px);
  padding-bottom: 5px;
  border-right: 0.5px solid var(--color-border);
`

const ProviderListItem = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  padding: 5px 10px;
  width: 100%;
  border-radius: var(--list-item-border-radius);
  font-size: 14px;
  transition: all 0.2s ease-in-out;
  border: 0.5px solid transparent;
  user-select: none;
  cursor: pointer;

  &:hover {
    background: var(--color-background-soft);
  }

  &.active {
    background: var(--color-background-soft);
    border: 0.5px solid var(--color-border);
    font-weight: bold !important;
  }
`

const DragHandle = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -8px;
  width: 12px;
  color: var(--color-text-3);
  opacity: 0;
  transition: opacity 0.2s ease-in-out;
  cursor: grab;

  ${ProviderListItem}:hover & {
    opacity: 1;
  }

  &:active {
    cursor: grabbing;
  }
`

const ProviderItemName = styled.div`
  margin-left: 10px;
  font-weight: 500;
`

const AddButtonWrapper = styled.div`
  height: ${BUTTON_WRAPPER_HEIGHT}px;
  flex-direction: row;
  justify-content: center;
  align-items: center;
  padding: 10px 8px;
`

const FooterActionWrapper = styled.div`
  min-height: ${FOOTER_BUTTON_WRAPPER_HEIGHT}px;
  padding: 10px 8px;
`

const FooterButtonGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 100%;
`

const FilterButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
`

const CheckPlaceholder = styled.span`
  display: inline-block;
  width: 14px;
  height: 14px;
`

const EmptyState = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px;
  color: var(--color-text-2);
  text-align: center;
`

const EmptyStateTitle = styled.div`
  font-size: 16px;
  font-weight: 500;
  color: var(--color-text);
`

const EmptyStateDescription = styled.div`
  margin-top: 10px;
  max-width: 360px;
  font-size: 16px;
  font-weight: 500;
  line-height: 1.6;
  color: var(--color-text);
`

export default ProviderList
