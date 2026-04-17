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
    const filtered = quickAssistantIds.filter((id) => existingIds.includes(id))

    if (filtered.length > 0) {
      return filtered
    }

    return roleCandidates.slice(0, 8).map((assistant) => assistant.id)
  }, [quickAssistantIds, roleCandidates])

  useEffect(() => {
    if (quickAssistantIds.length > 0 || systemPresets.length === 0 || hasBootstrappedDefaultsRef.current) {
      return
    }

    hasBootstrappedDefaultsRef.current = true

    const findPresetByKeywords = (keywords: string[]) =>
      systemPresets.find((preset) => keywords.some((keyword) => preset.name === keyword || preset.name.includes(keyword)))

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
    () => resolvedRoleIds.map((id) => roleMap.get(id)).filter((assistant): assistant is Assistant => Boolean(assistant)),
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

  return (
    <Container>
      <DeckHeader>
        <SectionTitle>常用角色</SectionTitle>
        <DeckActions>
          {visibleRoles.length > PAGE_SIZE && (
            <>
              <PageButton type="button" onClick={() => setPage((value) => Math.max(0, value - 1))}>
                <ChevronLeft size={14} />
              </PageButton>
              <PageInfo>
                {currentPage + 1}/{pageCount}
              </PageInfo>
              <PageButton type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}>
                <ChevronRight size={14} />
              </PageButton>
            </>
          )}
          <AddRoleButton type="button" onClick={() => setLibraryOpen(true)}>
            <Plus size={14} />
            <span>添加角色</span>
          </AddRoleButton>
        </DeckActions>
      </DeckHeader>

      <DeckScroller>
        {currentRoles.length > 0 ? (
          <Sortable
            items={currentRoles}
            itemKey="id"
            isDragDisabled={(assistant) => assistant.id === defaultAssistant?.id}
            layout="grid"
            gap={10}
            onSortEnd={({ oldIndex, newIndex }) => updateOrderWithinPage(oldIndex, newIndex)}
            listStyle={{
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'flex-start',
              alignContent: 'flex-start',
              width: '100%',
              overflow: 'visible',
              paddingTop: 12,
              paddingRight: 12,
              gap: '8px 10px'
            }}
            itemStyle={{ width: 'fit-content' }}
            useDragOverlay
            showGhost
            renderItem={(assistant) => (
              <Dropdown key={assistant.id} menu={{ items: buildRoleMenu(assistant) }} trigger={['contextMenu']}>
                <RoleCard
                  type="button"
                  className={assistant.id === activeAssistant.id ? 'active' : undefined}
                  onClick={() => onSelectAssistant(assistant)}>
                  <RoleCardMain>
                    <AssistantAvatar assistant={assistant} size={22} />
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
        ) : (
          <EmptyDeck>还没有添加角色卡片，先从右上角的角色库里选一个吧。</EmptyDeck>
        )}
      </DeckScroller>

      <SummaryCard>
        <SummaryHeader>
          <SummaryTitle>
            <AssistantAvatar assistant={activeAssistant} size={20} />
            <span>{activeAssistant.name}</span>
          </SummaryTitle>
          {shouldShowExpand && (
            <SummaryExpandButton type="button" onClick={() => setDetailOpen(true)}>
              展开设定
            </SummaryExpandButton>
          )}
        </SummaryHeader>
        <SummaryText>{inlineSummary}</SummaryText>
      </SummaryCard>

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
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
`

const DeckHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
`

const SectionTitle = styled.div`
  font-size: 11px;
  font-weight: 500;
  color: #8f959e;
  letter-spacing: 0.04em;
`

const DeckActions = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const AddRoleButton = styled.button`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  border: none;
  background: #f2f3f5;
  color: #6b7280;
  border-radius: 999px;
  padding: 0 13px;
  cursor: pointer;
  font-size: 11px;
  font-weight: 400;

  &:hover {
    color: #1f2329;
    background: #eaedf1;
  }
`

const DeckScroller = styled.div`
  min-height: 150px;
  max-height: 150px;
  overflow: hidden;
`

const RoleCard = styled.button`
  position: relative;
  width: fit-content;
  min-width: 0;
  max-width: 174px;
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  border: none;
  background: #f2f3f5;
  color: #3c4652;
  border-radius: 999px;
  padding: 0 14px;
  cursor: grab;
  transition: all 0.18s ease;
  overflow: visible;

  &:hover,
  &.active {
    background: #e8edf4;
    color: #1f2329;
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
  right: -8px;
  top: -9px;
  display: flex;
  align-items: center;
  gap: 0;
  color: #9ca3af;
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.18s ease;
`

const RoleName = styled.span`
  max-width: 112px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 400;
  text-align: center;
`

const RemoveButton = styled.button`
  border: none;
  background: #ffffff;
  color: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border-radius: 999px;
  box-shadow: 0 2px 10px rgba(15, 23, 42, 0.12);

  &:hover {
    background: #f8fafc;
  }
`

const SummaryCard = styled.div`
  position: relative;
  border: 1px solid rgba(45, 202, 123, 0.15);
  background: rgba(57, 181, 74, 0.045);
  border-radius: 22px;
  padding: 12px 14px 12px 18px;
  box-shadow: 0 6px 14px rgba(15, 23, 42, 0.015);

  &::before {
    content: '';
    position: absolute;
    left: 0;
    top: 12px;
    bottom: 12px;
    width: 3px;
    border-radius: 999px;
    background: rgba(57, 181, 74, 0.55);
  }
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
  font-size: 11px;
  font-weight: 500;
  color: #1f2329;
`

const SummaryText = styled.div`
  margin-top: 8px;
  font-size: 11px;
  line-height: 1.65;
  color: #5f6975;
`

const SummaryExpandButton = styled.button`
  border: none;
  background: transparent;
  color: #5f6975;
  cursor: pointer;
  font-size: 11px;

  &:hover {
    color: #1f2329;
  }
`

const PageButton = styled.button`
  width: 26px;
  height: 26px;
  border-radius: 999px;
  border: none;
  background: #f2f3f5;
  color: #6b7280;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &:hover {
    background: #eaedf1;
    color: #1f2329;
  }
`

const PageInfo = styled.div`
  font-size: 11px;
  color: var(--color-text-3);
`

const EmptyDeck = styled.div`
  border: 1px dashed var(--color-border);
  border-radius: 18px;
  padding: 18px 16px;
  font-size: 13px;
  color: var(--color-text-3);
  text-align: center;
`

export default QuickAssistantDeck
