import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { Sortable } from '@renderer/components/dnd'
import AssistantSettingsPopup from '@renderer/pages/settings/AssistantSettings'
import { useSystemAssistantPresets } from '@renderer/pages/store/assistants/presets'
import AssistantPresetPreviewContent from '@renderer/pages/store/assistants/presets/components/AssistantPresetPreviewContent'
import { DEFAULT_ASSISTANT_SETTINGS, getDefaultTopic } from '@renderer/services/AssistantService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { addAssistant, removeQuickAssistantId, setQuickAssistantIds } from '@renderer/store/assistants'
import type { Assistant, AssistantPreset } from '@renderer/types'
import { droppableReorder } from '@renderer/utils'
import type { MenuProps } from 'antd'
import { Dropdown, Modal } from 'antd'
import { ChevronLeft, ChevronRight, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react'
import type { FC } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { v4 as uuid } from 'uuid'

import QuickAssistantLibraryModal from './QuickAssistantLibraryModal'

interface Props {
  assistants: Assistant[]
  activeAssistant: Assistant
  onSelectAssistant: (assistant: Assistant) => void
}

const PAGE_SIZE = 14

const DEFAULT_QUICK_ASSISTANT_KEYWORDS = [
  ['英语练习伙伴'],
  ['学术论文阅读总结'],
  ['投资策略专家'],
  ['会议纪要助手', 'CEO 秘书会议纪要', '会议精要'],
  ['角色扮演']
]

const QuickAssistantDeck: FC<Props> = ({ assistants, activeAssistant, onSelectAssistant }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const systemPresets = useSystemAssistantPresets()
  const quickAssistantIds = useAppSelector((state) => state.assistants.quickAssistantIds ?? [])
  const [page, setPage] = useState(0)
  const [detailOpen, setDetailOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [deletingAssistantId, setDeletingAssistantId] = useState<string | null>(null)
  const hasBootstrappedDefaultsRef = useRef(false)

  const defaultAssistant = useMemo(
    () => assistants.find((assistant) => assistant.id === 'default') || assistants[0],
    [assistants]
  )
  const roleCandidates = useMemo(
    () => assistants.filter((assistant) => assistant.id !== defaultAssistant?.id),
    [assistants, defaultAssistant?.id]
  )

  const resolvedRoleIds = useMemo(() => {
    const existingIds = roleCandidates.map((assistant) => assistant.id)
    return quickAssistantIds.filter((id) => existingIds.includes(id))
  }, [quickAssistantIds, roleCandidates])

  useEffect(() => {
    if (quickAssistantIds.length > 0 || systemPresets.length === 0 || hasBootstrappedDefaultsRef.current) {
      return
    }

    hasBootstrappedDefaultsRef.current = true

    const findPresetByKeywords = (keywords: string[]) =>
      systemPresets.find((preset) =>
        keywords.some((keyword) => preset.name === keyword || preset.name.includes(keyword))
      )

    const bootstrapDefaults = async () => {
      const matchedPresets = DEFAULT_QUICK_ASSISTANT_KEYWORDS.map(findPresetByKeywords).filter(
        (preset): preset is AssistantPreset => Boolean(preset)
      )

      if (matchedPresets.length === 0) {
        return
      }

      const uniquePresets = matchedPresets.filter(
        (preset, index, array) => array.findIndex((item) => item.id === preset.id) === index
      )

      const nextIds: string[] = []

      for (const preset of uniquePresets) {
        const existingAssistant = assistants.find(
          (assistant) =>
            (preset.id && assistant.presetId === preset.id) ||
            (assistant.name === preset.name && assistant.prompt === preset.prompt)
        )

        if (existingAssistant) {
          nextIds.push(existingAssistant.id)
          continue
        }

        const assistantId = uuid()
        const assistant: Assistant = {
          ...preset,
          id: assistantId,
          presetId: preset.id,
          name: preset.name,
          emoji: preset.emoji,
          topics: [getDefaultTopic(assistantId)],
          model: preset.defaultModel,
          type: 'assistant',
          regularPhrases: preset.regularPhrases || [],
          settings: preset.settings || DEFAULT_ASSISTANT_SETTINGS
        }

        dispatch(addAssistant(assistant))
        nextIds.push(assistant.id)
      }

      if (nextIds.length > 0) {
        dispatch(setQuickAssistantIds(nextIds))
      }
    }

    void bootstrapDefaults()
  }, [assistants, dispatch, quickAssistantIds.length, systemPresets])

  const roleMap = useMemo(() => new Map(roleCandidates.map((assistant) => [assistant.id, assistant])), [roleCandidates])
  const visibleRoles = useMemo(
    () =>
      resolvedRoleIds.map((id) => roleMap.get(id)).filter((assistant): assistant is Assistant => Boolean(assistant)),
    [resolvedRoleIds, roleMap]
  )

  const pageCount = Math.max(1, Math.ceil(visibleRoles.length / PAGE_SIZE))
  const currentPage = Math.min(page, pageCount - 1)
  const pageStart = currentPage * PAGE_SIZE
  const pageRoles = visibleRoles.slice(pageStart, pageStart + PAGE_SIZE)
  const currentRoles = useMemo(
    () => (defaultAssistant ? [defaultAssistant, ...pageRoles] : pageRoles),
    [defaultAssistant, pageRoles]
  )

  const assistantSummary = useMemo(() => {
    if (activeAssistant.description?.trim()) return activeAssistant.description.trim()
    if (activeAssistant.prompt?.trim()) return activeAssistant.prompt.trim()
    if (activeAssistant.id === 'default') return '直接输入问题时，会优先使用默认助手进行对话。'
    return '这个角色暂时还没有额外设定。'
  }, [activeAssistant])

  const shouldShowExpand = assistantSummary.length > 70
  const inlineSummary = shouldShowExpand ? `${assistantSummary.slice(0, 70)}...` : assistantSummary

  useEffect(() => {
    if (!deletingAssistantId) {
      return
    }

    const timer = window.setTimeout(() => setDeletingAssistantId(null), 1800)
    return () => window.clearTimeout(timer)
  }, [deletingAssistantId])

  const updateOrderWithinPage = (oldIndex: number, newIndex: number) => {
    if (oldIndex === newIndex) {
      return
    }

    const protectedStartIndex = defaultAssistant ? 1 : 0
    const safeOldIndex = Math.max(oldIndex, protectedStartIndex)
    const safeNewIndex = Math.max(newIndex, protectedStartIndex)

    const movableRoles = [...pageRoles]
    const reorderedRoles = droppableReorder(
      movableRoles,
      safeOldIndex - protectedStartIndex,
      safeNewIndex - protectedStartIndex
    )
    const nextIds = [...resolvedRoleIds]

    reorderedRoles.forEach((assistant, index) => {
      nextIds[pageStart + index] = assistant.id
    })

    dispatch(setQuickAssistantIds(nextIds))
  }

  const buildRoleMenu = (assistant: Assistant): MenuProps['items'] => {
    const items: MenuProps['items'] = [
      {
        key: 'settings',
        label: '编辑角色设定',
        icon: <Settings2 size={14} />,
        onClick: () => {
          void AssistantSettingsPopup.show({ assistant, tab: 'prompt' })
        }
      },
      {
        key: 'model',
        label: '编辑模型与参数',
        icon: <Pencil size={14} />,
        onClick: () => {
          void AssistantSettingsPopup.show({ assistant, tab: 'model' })
        }
      }
    ]

    if (assistant.id !== defaultAssistant?.id) {
      items.push({ type: 'divider' })
      items.push({
        key: 'remove',
        label: '移出常用角色',
        danger: true,
        icon: <Trash2 size={14} />,
        onClick: () => dispatch(removeQuickAssistantId(assistant.id))
      })
    }

    return items
  }

  const isCustomRoleActive = activeAssistant.id !== defaultAssistant?.id

  return (
    <Container>
      <DeckLayout>
        <DeckScroller>
          {currentRoles.length > 0 ? (
            <ChipRow>
              <Sortable<Assistant>
                items={currentRoles}
                itemKey="id"
                isDragDisabled={(assistant) => assistant.id === defaultAssistant?.id}
                layout="grid"
                gap={8}
                onSortEnd={({ oldIndex, newIndex }) => updateOrderWithinPage(oldIndex, newIndex)}
                listStyle={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  justifyContent: 'flex-start',
                  alignItems: 'center',
                  overflow: 'visible',
                  paddingTop: 6,
                  paddingBottom: 6,
                  gap: '8px 8px'
                }}
                itemStyle={{ width: 'fit-content' }}
                useDragOverlay
                showGhost
                renderItem={(assistant: Assistant) => (
                  <Dropdown key={assistant.id} menu={{ items: buildRoleMenu(assistant) }} trigger={['contextMenu']}>
                    <RoleCard
                      type="button"
                      className={assistant.id === activeAssistant.id ? 'active' : undefined}
                      onClick={() => onSelectAssistant(assistant)}>
                      <RoleCardMain>
                        <AssistantAvatar assistant={assistant} size={18} />
                        <RoleName title={assistant.name}>{assistant.name}</RoleName>
                      </RoleCardMain>
                      {assistant.id !== defaultAssistant?.id && (
                        <RoleCardTools className="role-card-tools">
                          <RemoveButton
                            type="button"
                            data-no-dnd
                            onClick={(event) => {
                              event.stopPropagation()
                              if (deletingAssistantId === assistant.id) {
                                dispatch(removeQuickAssistantId(assistant.id))
                                setDeletingAssistantId(null)
                                return
                              }

                              setDeletingAssistantId(assistant.id)
                            }}>
                            {deletingAssistantId === assistant.id ? <Trash2 size={12} /> : <X size={12} />}
                          </RemoveButton>
                        </RoleCardTools>
                      )}
                    </RoleCard>
                  </Dropdown>
                )}
              />
            </ChipRow>
          ) : (
            <EmptyDeck>
              <span>{t('chat.quick_roles.empty')}</span>
            </EmptyDeck>
          )}
        </DeckScroller>

        <FixedActions>
          {visibleRoles.length > PAGE_SIZE && (
            <DeckPager>
              <PageButton type="button" onClick={() => setPage((value) => Math.max(0, value - 1))}>
                <ChevronLeft size={13} />
              </PageButton>
              <PageInfo>
                {currentPage + 1}/{pageCount}
              </PageInfo>
              <PageButton type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
                <ChevronRight size={13} />
              </PageButton>
            </DeckPager>
          )}
          <AddRoleButton
            type="button"
            onClick={() => setLibraryOpen(true)}
            title={t('chat.quick_roles.add_to_favorites')}>
            <Plus size={13} />
            <span>{t('chat.quick_roles.add')}</span>
          </AddRoleButton>
        </FixedActions>
      </DeckLayout>

      {isCustomRoleActive && (
        <SummaryCard>
          <SummaryHeader>
            <SummaryTitle>
              <AssistantAvatar assistant={activeAssistant} size={18} />
              <span>{activeAssistant.name}</span>
            </SummaryTitle>
            {shouldShowExpand && (
              <SummaryExpandButton type="button" onClick={() => setDetailOpen(true)}>
                {t('chat.quick_roles.expand_settings')}
              </SummaryExpandButton>
            )}
          </SummaryHeader>
          <SummaryText>{inlineSummary}</SummaryText>
        </SummaryCard>
      )}

      <Modal
        title={`${activeAssistant.name} 角色设定`}
        open={detailOpen}
        footer={null}
        width={760}
        onCancel={() => setDetailOpen(false)}>
        <AssistantPresetPreviewContent
          preset={{
            description: activeAssistant.description || '',
            prompt: activeAssistant.prompt || assistantSummary
          }}
        />
      </Modal>

      <QuickAssistantLibraryModal open={libraryOpen} onClose={() => setLibraryOpen(false)} />
    </Container>
  )
}

const Container = styled.div`
  width: 100%;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
`

const DeckLayout = styled.div`
  width: 100%;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
`

const FixedActions = styled.div`
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-top: 6px;
`

const ChipRow = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  width: 100%;
`

const DeckPager = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 6px;
`

const AddRoleButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 33px;
  border: 0;
  background: var(--zen-glass-pill);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--zen-shadow-pill);
  color: var(--zen-text-1);
  border-radius: var(--zen-radius-pill);
  padding: 0 13px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  transition:
    background 160ms ease,
    color 150ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;

  &:hover {
    color: var(--zen-text-1);
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    transform: translateY(-0.5px);
  }
`

const DeckScroller = styled.div`
  flex: 1;
  min-width: 0;
  max-height: 112px;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  scrollbar-width: thin;

  &::-webkit-scrollbar {
    width: 6px;
  }

  &::-webkit-scrollbar-thumb {
    border-radius: 999px;
    background: var(--color-scrollbar-thumb);
  }

  &::-webkit-scrollbar-track {
    background: transparent;
  }
`

const RoleCard = styled.button`
  position: relative;
  width: fit-content;
  min-width: 0;
  max-width: 176px;
  height: 33px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: 0;
  background: var(--zen-glass-pill);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--zen-shadow-pill);
  color: var(--zen-text-2);
  border-radius: var(--zen-radius-pill);
  padding: 0 13px 0 9px;
  cursor: grab;
  transition:
    background 160ms ease,
    color 150ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;
  overflow: visible;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    color: var(--zen-text-1);
    transform: translateY(-0.5px);
  }

  &.active {
    background: var(--zen-glass-active);
    box-shadow: var(--zen-shadow-pill-hover);
    color: var(--zen-text-1);
    font-weight: 500;
  }

  &:hover .role-card-tools,
  &:focus-visible .role-card-tools,
  &.active .role-card-tools {
    opacity: 1;
    pointer-events: auto;
  }
`

const RoleCardMain = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
`

const RoleCardTools = styled.div`
  position: absolute;
  right: -6px;
  top: -7px;
  display: flex;
  align-items: center;
  gap: 0;
  color: var(--zen-text-2);
  opacity: 0;
  pointer-events: none;
  transition: opacity 120ms ease;
`

const RoleName = styled.span`
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12.5px;
  font-weight: 400;
  text-align: center;
`

const RemoveButton = styled.button`
  border: 1px solid var(--zen-border);
  background: var(--zen-bg-elevated);
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  border-radius: 50%;

  &:hover {
    background: var(--zen-bg-hover);
    color: var(--zen-text-1);
  }
`

const SummaryCard = styled.div`
  position: relative;
  margin-top: 4px;
  border: 0;
  background: var(--zen-glass-card);
  backdrop-filter: blur(24px) saturate(160%);
  box-shadow: var(--zen-shadow-card);
  border-radius: var(--zen-radius-md);
  padding: 14px 16px;
`

const SummaryHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const SummaryTitle = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--zen-text-1);
`

const SummaryText = styled.div`
  margin-top: 8px;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--zen-text-2);
`

const SummaryExpandButton = styled.button`
  border: none;
  background: transparent;
  color: var(--zen-text-2);
  cursor: pointer;
  font-size: 11.5px;

  &:hover {
    color: var(--zen-text-1);
  }
`

const PageButton = styled.button`
  width: 24px;
  height: 24px;
  border-radius: var(--zen-radius-sm);
  border: 1px solid var(--zen-border);
  background: var(--zen-bg-elevated);
  color: var(--zen-text-2);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background: var(--zen-bg-hover);
    border-color: var(--zen-border-strong);
    color: var(--zen-text-1);
  }
`

const PageInfo = styled.div`
  font-size: 11px;
  font-family: var(--code-font-family);
  font-variant-numeric: tabular-nums;
  color: var(--zen-text-3);
`

const EmptyDeck = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 8px;
  font-size: 12.5px;
  color: var(--zen-text-3);
  text-align: center;
`

export default QuickAssistantDeck
