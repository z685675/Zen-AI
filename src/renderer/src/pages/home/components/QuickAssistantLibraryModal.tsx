import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useAssistantPresets } from '@renderer/hooks/useAssistantPresets'
import { useSystemAssistantPresets } from '@renderer/pages/store/assistants/presets'
import { groupTranslations } from '@renderer/pages/store/assistants/presets/assistantPresetGroupTranslations'
import AddAssistantPresetPopup from '@renderer/pages/store/assistants/presets/components/AddAssistantPresetPopup'
import AssistantPresetPreviewContent from '@renderer/pages/store/assistants/presets/components/AssistantPresetPreviewContent'
import ImportAssistantPresetPopup from '@renderer/pages/store/assistants/presets/components/ImportAssistantPresetPopup'
import ManageAssistantPresetsPopup from '@renderer/pages/store/assistants/presets/components/ManageAssistantPresetsPopup'
import { createAssistantFromAgent } from '@renderer/services/AssistantService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addQuickAssistantId, removeQuickAssistantId } from '@renderer/store/assistants'
import type { Assistant, AssistantPreset } from '@renderer/types'
import { Button, Input, Modal, Tag } from 'antd'
import { Import, Plus, Search, Settings2 } from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  open: boolean
  onClose: () => void
}

const ADDED_GROUP_KEY = '__added__'

type PresetGroup = {
  key: string
  label: string
  presets: AssistantPreset[]
}

const QuickAssistantLibraryModal: FC<Props> = ({ open, onClose }) => {
  const dispatch = useAppDispatch()
  const { i18n, t } = useTranslation()
  const { assistants } = useAssistants()
  const { presets: userPresets } = useAssistantPresets()
  const systemPresets = useSystemAssistantPresets()
  const quickAssistantIds = useAppSelector((state) => state.assistants.quickAssistantIds ?? [])
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState('')
  const [previewPreset, setPreviewPreset] = useState<AssistantPreset | null>(null)

  const localizedGroupName = useCallback(
    (group: string) => {
      const currentLanguage = i18n.language as keyof (typeof groupTranslations)[string]
      return groupTranslations[group]?.[currentLanguage] || group
    },
    [i18n.language]
  )

  const matchesAssistant = useCallback((assistant: Assistant, preset: AssistantPreset) => {
    if (preset.id && assistant.presetId === preset.id) {
      return true
    }

    return assistant.name === preset.name && assistant.prompt === preset.prompt
  }, [])

  const isPresetInQuickDeck = useCallback(
    (preset: AssistantPreset) =>
      assistants.some((assistant) => quickAssistantIds.includes(assistant.id) && matchesAssistant(assistant, preset)),
    [assistants, matchesAssistant, quickAssistantIds]
  )

  const toPresetFromAssistant = useCallback((assistant: Assistant): AssistantPreset => {
    return {
      ...assistant,
      group: ['已添加角色'],
      topics: []
    }
  }, [])

  const presetGroups = useMemo<PresetGroup[]>(() => {
    const groups = new Map<string, AssistantPreset[]>()
    const allLibraryPresets = [...userPresets, ...systemPresets]
    const addedPresets = quickAssistantIds
      .map((assistantId) => assistants.find((assistant) => assistant.id === assistantId))
      .filter((assistant): assistant is Assistant => Boolean(assistant))
      .map(
        (assistant) =>
          allLibraryPresets.find((preset) => matchesAssistant(assistant, preset)) || toPresetFromAssistant(assistant)
      )

    if (addedPresets.length > 0) {
      groups.set(ADDED_GROUP_KEY, addedPresets)
    }

    if (userPresets.length > 0) {
      groups.set('我的角色', userPresets)
    }

    systemPresets.forEach((preset) => {
      const categories = preset.group?.length ? preset.group : ['其他']
      categories.forEach((category) => {
        const current = groups.get(category) ?? []
        const exists = current.some((item) => item.id === preset.id)
        groups.set(category, exists ? current : [...current, preset])
      })
    })

    return Array.from(groups.entries()).map(([key, presets]) => ({
      key,
      label: key === ADDED_GROUP_KEY ? '已添加角色' : localizedGroupName(key),
      presets
    }))
  }, [
    assistants,
    localizedGroupName,
    matchesAssistant,
    quickAssistantIds,
    systemPresets,
    toPresetFromAssistant,
    userPresets
  ])

  const filteredGroups = useMemo(() => {
    const keyword = search.trim().toLowerCase()

    if (!keyword) {
      return presetGroups
    }

    return presetGroups
      .map((group) => ({
        ...group,
        presets: group.presets.filter(
          (preset) =>
            preset.name.toLowerCase().includes(keyword) ||
            preset.description?.toLowerCase().includes(keyword) ||
            preset.prompt?.toLowerCase().includes(keyword)
        )
      }))
      .filter((group) => group.presets.length > 0)
  }, [presetGroups, search])

  const visibleCount = useMemo(
    () => filteredGroups.reduce((sum, group) => sum + group.presets.length, 0),
    [filteredGroups]
  )

  const currentGroup = useMemo(
    () => filteredGroups.find((group) => group.key === activeCategory) || filteredGroups[0],
    [activeCategory, filteredGroups]
  )

  useEffect(() => {
    if (filteredGroups.length === 0) {
      setActiveCategory('')
      return
    }

    const exists = filteredGroups.some((group) => group.key === activeCategory)
    if (!exists) {
      setActiveCategory(filteredGroups[0].key)
    }
  }, [activeCategory, filteredGroups])

  const resolveAssistantFromPreset = async (preset: AssistantPreset): Promise<Assistant> => {
    const existingAssistant = assistants.find((assistant) => matchesAssistant(assistant, preset))

    if (existingAssistant) {
      return existingAssistant
    }

    return await createAssistantFromAgent(preset)
  }

  const handleTogglePreset = async (preset: AssistantPreset) => {
    const assistant = await resolveAssistantFromPreset(preset)
    const existsInQuickDeck = isPresetInQuickDeck(preset)
    const addedAssistant = assistants.find(
      (item) => quickAssistantIds.includes(item.id) && matchesAssistant(item, preset)
    )

    if (existsInQuickDeck) {
      dispatch(removeQuickAssistantId(addedAssistant?.id || assistant.id))
      return
    }

    dispatch(addQuickAssistantId(assistant.id))
  }

  const handleImportAssistants = async () => {
    const importedPresets = await ImportAssistantPresetPopup.show()

    if (importedPresets?.length) {
      setSearch(importedPresets.length === 1 ? importedPresets[0].name : '')
      setActiveCategory('我的角色')
    }
  }

  const handleManageAssistants = () => {
    ManageAssistantPresetsPopup.show()
  }

  const handleCreateAssistant = async () => {
    const createdPreset = await AddAssistantPresetPopup.show()

    if (createdPreset) {
      setSearch(createdPreset.name)
      setActiveCategory('我的角色')
    }
  }

  const getPreviewDescription = (preset: AssistantPreset) => {
    return preset.description || '这个角色暂时没有单独描述。'
  }

  const getPreviewPrompt = (preset: AssistantPreset) => {
    return preset.prompt || '这个角色暂时没有额外提示词。'
  }

  return (
    <>
      <Modal
        title={null}
        open={open}
        onCancel={onClose}
        footer={null}
        width={960}
        centered
        styles={{
          content: {
            padding: 0,
            overflow: 'hidden',
            borderRadius: 'var(--zen-radius-xl)',
            background: 'var(--zen-glass-rail)',
            backdropFilter: 'blur(36px) saturate(165%)',
            boxShadow: 'var(--zen-shadow-composer)'
          },
          body: { padding: 0, overflow: 'hidden' }
        }}>
        <ModalShell>
          <ModalHeader>
            <HeaderLeft>
              <ModalTitle>角色库</ModalTitle>
              <ModalSubtitle>从现有助手库里挑一些常用角色，放到首页下面快速切换。</ModalSubtitle>
            </HeaderLeft>
            <HeaderMeta>{visibleCount} 个角色</HeaderMeta>
          </ModalHeader>

          <Toolbar>
            <SearchInput
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              prefix={<Search size={14} />}
              placeholder="搜索角色名称、描述或提示词"
            />
            <ToolbarActions>
              <Button shape="round" icon={<Import size={14} />} onClick={() => void handleImportAssistants()}>
                {t('assistants.presets.import.title')}
              </Button>
              <Button shape="round" icon={<Settings2 size={14} />} onClick={handleManageAssistants}>
                {t('assistants.presets.manage.title')}
              </Button>
              <Button
                type="primary"
                shape="round"
                icon={<Plus size={14} />}
                onClick={() => void handleCreateAssistant()}>
                {t('assistants.presets.add.title')}
              </Button>
            </ToolbarActions>
          </Toolbar>

          <LibraryBody>
            <CategoryRail>
              {filteredGroups.map((group) => (
                <CategoryItem
                  key={group.key}
                  type="button"
                  className={group.key === currentGroup?.key ? 'active' : undefined}
                  onClick={() => setActiveCategory(group.key)}>
                  <CategoryLabel>{group.label}</CategoryLabel>
                  <CountPill>{group.presets.length}</CountPill>
                </CategoryItem>
              ))}
            </CategoryRail>

            <CategoryContent>
              {currentGroup && (
                <>
                  <GroupHeader>
                    <span>{currentGroup.label}</span>
                    <CountPill>{currentGroup.presets.length}</CountPill>
                  </GroupHeader>

                  <GroupGrid>
                    {currentGroup.presets.map((preset) => {
                      const existsInQuickDeck = isPresetInQuickDeck(preset)

                      return (
                        <PresetCard key={`${currentGroup.key}-${preset.id}-${preset.name}`}>
                          <PresetTop>
                            <PresetTitle>
                              <AssistantAvatar
                                assistant={{ ...preset, id: preset.id || preset.name, topics: [], type: 'assistant' }}
                                size={24}
                              />
                              <PresetTitleText>
                                <span>{preset.name}</span>
                                {userPresets.some((item) => item.id === preset.id) && (
                                  <Tag bordered={false} color="gold">
                                    {t('chat.quick_roles.mine')}
                                  </Tag>
                                )}
                              </PresetTitleText>
                            </PresetTitle>
                            <PresetActionButton
                              type="button"
                              $added={existsInQuickDeck}
                              onClick={() => void handleTogglePreset(preset)}>
                              {existsInQuickDeck ? '取消添加' : '添加'}
                            </PresetActionButton>
                          </PresetTop>

                          <PresetDescription title={preset.description || preset.prompt || ''}>
                            {getPreviewDescription(preset)}
                          </PresetDescription>

                          <PresetPrompt type="button" onClick={() => setPreviewPreset(preset)}>
                            <PromptLabel>角色设定预览</PromptLabel>
                            <PromptText title={preset.prompt || ''}>{getPreviewPrompt(preset)}</PromptText>
                          </PresetPrompt>
                        </PresetCard>
                      )
                    })}
                  </GroupGrid>
                </>
              )}

              {filteredGroups.length === 0 && <EmptyState>没有找到匹配的角色</EmptyState>}
            </CategoryContent>
          </LibraryBody>
        </ModalShell>
      </Modal>

      <Modal
        open={Boolean(previewPreset)}
        onCancel={() => setPreviewPreset(null)}
        footer={null}
        width={720}
        title={previewPreset?.name || '角色预览'}>
        {previewPreset && <AssistantPresetPreviewContent preset={previewPreset} />}
      </Modal>
    </>
  )
}

const ModalShell = styled.div`
  display: flex;
  flex-direction: column;
  height: 74vh;
  max-height: 74vh;
  overflow: hidden;
  background: var(--zen-window-canvas);
  color: var(--zen-text-1);
`

const ModalHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 20px 56px 14px 24px;
  border-bottom: 0.5px solid var(--zen-border);
`

const HeaderLeft = styled.div`
  display: flex;
  flex-direction: column;
  gap: 4px;
`

const ModalTitle = styled.div`
  font-size: 20px;
  font-weight: 600;
  letter-spacing: -0.02em;
  color: var(--zen-text-1);
`

const ModalSubtitle = styled.div`
  max-width: 540px;
  font-size: 13px;
  line-height: 1.55;
  color: var(--zen-text-2);
`

const HeaderMeta = styled.div`
  flex: none;
  padding: 4px 12px;
  border-radius: var(--zen-radius-pill);
  background: var(--zen-glass-pill);
  box-shadow: var(--zen-shadow-pill);
  font-size: 12px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
  color: var(--zen-text-2);
`

const Toolbar = styled.div`
  padding: 12px 24px;
  border-bottom: 0.5px solid var(--zen-border);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
`

const SearchInput = styled(Input)`
  &&& {
    flex: 1 1 280px;
    min-width: 220px;
    height: 36px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--zen-radius-pill);
    background: var(--zen-glass-pill);
    box-shadow: var(--zen-shadow-pill);
    color: var(--zen-text-1);

    &:hover,
    &.ant-input-affix-wrapper-focused {
      background: var(--zen-glass-pill-hover);
      box-shadow: var(--zen-shadow-pill-hover);
    }

    .ant-input-prefix {
      color: var(--zen-text-3);
      margin-inline-end: 8px;
    }

    input {
      background: transparent;
      color: var(--zen-text-1);
      font-size: 13px;
    }
  }
`

const ToolbarActions = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;

  .ant-btn {
    white-space: nowrap;
    height: 34px;
    font-size: 12.5px;
  }
`

const LibraryBody = styled.div`
  display: grid;
  grid-template-columns: 186px 1fr;
  min-height: 0;
  flex: 1;
  overflow: hidden;
`

const CategoryRail = styled.div`
  border-right: 0.5px solid var(--zen-border);
  padding: 14px 10px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: var(--zen-bg-subtle);
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    width: 0;
    height: 0;
  }
`

const CategoryItem = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  height: 36px;
  padding: 0 11px;
  border-radius: var(--zen-radius-sm);
  color: var(--zen-text-2);
  background: transparent;
  border: 0;
  font-size: 13px;
  font-weight: 400;
  cursor: pointer;
  text-align: left;
  transition:
    background 150ms ease,
    color 150ms ease,
    box-shadow 160ms ease;

  &:hover {
    color: var(--zen-text-1);
    background: var(--zen-bg-hover);
  }

  &.active {
    color: var(--zen-text-1);
    font-weight: 500;
    background: var(--zen-glass-active);
    box-shadow: var(--zen-shadow-active);
  }
`

const CategoryLabel = styled.span`
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const CountPill = styled.span`
  flex: none;
  min-width: 22px;
  padding: 1px 7px;
  border-radius: var(--zen-radius-pill);
  background: var(--zen-bg-hover);
  color: var(--zen-text-3);
  font-family: var(--code-font-family);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.45;
  text-align: center;
`

const CategoryContent = styled.div`
  padding: 16px 20px 20px;
  min-height: 0;
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
`

const GroupHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--zen-text-1);
  margin-bottom: 14px;
`

const GroupGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding-bottom: 10px;
`

const PresetCard = styled.div`
  border: 0;
  border-radius: var(--zen-radius-md);
  background: var(--zen-glass-card);
  backdrop-filter: blur(22px) saturate(160%);
  padding: 14px 15px;
  box-shadow: var(--zen-shadow-card);
  transition:
    background 160ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }
`

const PresetTop = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
`

const PresetTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 9px;
  min-width: 0;
`

const PresetTitleText = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;

  span {
    font-size: 14px;
    font-weight: 600;
    color: var(--zen-text-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const PresetActionButton = styled.button<{ $added?: boolean }>`
  flex: none;
  height: 29px;
  padding: 0 13px;
  border: 0;
  border-radius: var(--zen-radius-pill);
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background 150ms ease,
    color 150ms ease,
    box-shadow 160ms ease,
    transform 130ms ease;

  ${({ $added }) =>
    $added
      ? `
    background: var(--zen-bg-subtle);
    color: var(--zen-text-2);
    &:hover {
      background: var(--zen-bg-hover);
      color: var(--zen-text-1);
    }
  `
      : `
    background: var(--color-primary);
    color: var(--color-primary-foreground);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.12);
    &:hover {
      opacity: 0.9;
      transform: translateY(-0.5px);
    }
  `}
`

const PresetDescription = styled.div`
  margin-top: 10px;
  min-height: 40px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--zen-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`

const PresetPrompt = styled.button`
  width: 100%;
  border: 0;
  margin-top: 12px;
  border-radius: var(--zen-radius-sm);
  background: var(--zen-bg-subtle);
  padding: 10px 12px;
  text-align: left;
  cursor: pointer;
  transition: background 150ms ease;

  &:hover {
    background: var(--zen-bg-hover);
  }
`

const PromptLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: var(--zen-text-3);
  margin-bottom: 5px;
`

const PromptText = styled.div`
  font-size: 12px;
  line-height: 1.65;
  color: var(--zen-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`

const EmptyState = styled.div`
  padding: 48px 0 32px;
  text-align: center;
  font-size: 13px;
  color: var(--zen-text-3);
`

export default QuickAssistantLibraryModal
