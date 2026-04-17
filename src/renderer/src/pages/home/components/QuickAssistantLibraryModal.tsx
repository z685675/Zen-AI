import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useAssistantPresets } from '@renderer/hooks/useAssistantPresets'
import { useSystemAssistantPresets } from '@renderer/pages/store/assistants/presets'
import { groupTranslations } from '@renderer/pages/store/assistants/presets/assistantPresetGroupTranslations'
import AssistantPresetPreviewContent from '@renderer/pages/store/assistants/presets/components/AssistantPresetPreviewContent'
import { createAssistantFromAgent } from '@renderer/services/AssistantService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addQuickAssistantId, removeQuickAssistantId } from '@renderer/store/assistants'
import type { Assistant, AssistantPreset } from '@renderer/types'
import { Button, Input, Modal, Tag } from 'antd'
import { Search } from 'lucide-react'
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
  const { i18n } = useTranslation()
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
  }, [assistants, localizedGroupName, matchesAssistant, quickAssistantIds, systemPresets, toPresetFromAssistant, userPresets])

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
        styles={{ body: { padding: 0 } }}>
        <ModalShell>
          <ModalHeader>
            <HeaderLeft>
              <ModalTitle>角色库</ModalTitle>
              <ModalSubtitle>从现有助手库里挑一些常用角色，放到首页下面快速切换。</ModalSubtitle>
            </HeaderLeft>
            <HeaderMeta>{visibleCount} 个角色</HeaderMeta>
          </ModalHeader>

          <Toolbar>
            <Input
              allowClear
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              prefix={<Search size={14} color="var(--color-icon)" />}
              placeholder="搜索角色名称、描述或提示词"
            />
          </Toolbar>

          <LibraryBody>
            <CategoryRail>
              {filteredGroups.map((group) => (
                <CategoryItem
                  key={group.key}
                  className={group.key === currentGroup?.key ? 'active' : undefined}
                  onClick={() => setActiveCategory(group.key)}>
                  <span>{group.label}</span>
                  <Tag bordered={false}>{group.presets.length}</Tag>
                </CategoryItem>
              ))}
            </CategoryRail>

            <CategoryContent>
              {currentGroup && (
                <>
                  <GroupHeader>
                    <span>{currentGroup.label}</span>
                    <Tag bordered={false}>{currentGroup.presets.length}</Tag>
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
                                {userPresets.some((item) => item.id === preset.id) && <Tag color="gold">我的</Tag>}
                              </PresetTitleText>
                            </PresetTitle>
                            <Button
                              type={existsInQuickDeck ? 'default' : 'primary'}
                              onClick={() => void handleTogglePreset(preset)}>
                              {existsInQuickDeck ? '取消添加' : '添加'}
                            </Button>
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
  min-height: 72vh;
  background:
    radial-gradient(circle at top left, rgba(0, 185, 107, 0.08), transparent 30%),
    linear-gradient(180deg, var(--color-background), var(--color-background-soft));
`

const ModalHeader = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 24px 72px 14px 24px;
  border-bottom: 1px solid var(--color-border);
`

const HeaderLeft = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
`

const ModalTitle = styled.div`
  font-size: 22px;
  font-weight: 700;
  color: var(--color-text);
`

const ModalSubtitle = styled.div`
  max-width: 540px;
  font-size: 13px;
  line-height: 1.7;
  color: var(--color-text-2);
`

const HeaderMeta = styled.div`
  position: relative;
  top: 6px;
  right: 4px;
  font-size: 15px;
  font-weight: 600;
  color: #374151;
  padding-top: 6px;
`

const Toolbar = styled.div`
  padding: 16px 24px;
  border-bottom: 1px solid var(--color-border);
`

const LibraryBody = styled.div`
  display: grid;
  grid-template-columns: 180px 1fr;
  min-height: 0;
  flex: 1;
`

const CategoryRail = styled.div`
  border-right: 1px solid var(--color-border);
  padding: 16px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: rgba(255, 255, 255, 0.35);
`

const CategoryItem = styled.button`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  width: 100%;
  padding: 10px 12px;
  border-radius: 12px;
  color: var(--color-text-2);
  background: var(--color-background);
  border: 1px solid var(--color-border);
  font-size: 13px;
  cursor: pointer;
  text-align: left;

  &.active {
    color: var(--color-text);
    border-color: var(--color-primary);
    background: var(--color-background-soft);
  }
`

const CategoryContent = styled.div`
  padding: 16px 18px 18px;
  max-height: 56vh;
  overflow: auto;
`

const GroupHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text);
  margin-bottom: 14px;
`

const GroupGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding-bottom: 10px;
`

const PresetCard = styled.div`
  border: 1px solid var(--color-border);
  border-radius: 18px;
  background: var(--color-background);
  padding: 15px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.03);
`

const PresetTop = styled.div`
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
`

const PresetTitle = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
`

const PresetTitleText = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;

  span {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
`

const PresetDescription = styled.div`
  margin-top: 12px;
  min-height: 44px;
  font-size: 12px;
  line-height: 1.75;
  color: var(--color-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
`

const PresetPrompt = styled.button`
  width: 100%;
  border: none;
  margin-top: 14px;
  border-radius: 14px;
  background: var(--color-background-soft);
  padding: 12px;
  text-align: left;
  cursor: pointer;
`

const PromptLabel = styled.div`
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-3);
  margin-bottom: 8px;
`

const PromptText = styled.div`
  font-size: 12px;
  line-height: 1.7;
  color: var(--color-text-2);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
`

const EmptyState = styled.div`
  padding: 48px 0 32px;
  text-align: center;
  font-size: 13px;
  color: var(--color-text-3);
`

export default QuickAssistantLibraryModal
