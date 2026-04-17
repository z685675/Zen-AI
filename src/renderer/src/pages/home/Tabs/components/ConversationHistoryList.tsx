import AddButton from '@renderer/components/AddButton'
import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { CopyIcon, DeleteIcon, EditIcon } from '@renderer/components/Icons'
import ObsidianExportPopup from '@renderer/components/Popups/ObsidianExportPopup'
import PromptPopup from '@renderer/components/Popups/PromptPopup'
import SaveToKnowledgePopup from '@renderer/components/Popups/SaveToKnowledgePopup'
import Scrollbar from '@renderer/components/Scrollbar'
import { isMac } from '@renderer/config/constant'
import { db } from '@renderer/databases'
import { useAssistants } from '@renderer/hooks/useAssistant'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { modelGenerating } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { finishTopicRenaming, startTopicRenaming, TopicManager } from '@renderer/hooks/useTopic'
import { fetchMessagesSummary } from '@renderer/services/ApiService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addTopic as addTopicAction,
  removeTopic as removeTopicAction,
  selectAllTopics,
  updateTopic as updateTopicAction,
  updateTopics as updateTopicsAction
} from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setGenerating } from '@renderer/store/runtime'
import type { Assistant, Topic } from '@renderer/types'
import { classNames, removeSpecialCharactersForFileName } from '@renderer/utils'
import { copyTopicAsMarkdown, copyTopicAsPlainText } from '@renderer/utils/copy'
import {
  exportMarkdownToJoplin,
  exportMarkdownToSiyuan,
  exportMarkdownToYuque,
  exportTopicAsMarkdown,
  exportTopicToNotes,
  exportTopicToNotion,
  topicToMarkdown
} from '@renderer/utils/export'
import type { MenuProps } from 'antd'
import { Dropdown, Tooltip } from 'antd'
import type { ItemType, MenuItemType } from 'antd/es/menu/interface'
import dayjs from 'dayjs'
import {
  BrushCleaning,
  FolderOpen,
  HelpCircle,
  MenuIcon,
  NotebookPen,
  PackagePlus,
  PinIcon,
  PinOffIcon,
  Save,
  Sparkles,
  UploadIcon,
  XIcon
} from 'lucide-react'
import type { FC } from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface Props {
  activeTopic: Topic
  setActiveTopic: (topic: Topic) => void
  onCreateConversation: () => void
}

const ConversationHistoryList: FC<Props> = ({ activeTopic, setActiveTopic, onCreateConversation }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const topics = useAppSelector(selectAllTopics)
  const exportMenuOptions = useAppSelector((state) => state.settings.exportMenuOptions)
  const { assistants } = useAssistants()
  const { notesPath } = useNotesSettings()
  const { pinTopicsToTop, setTopicPosition } = useSettings()
  const [deletingTopicId, setDeletingTopicId] = useState<string | null>(null)
  const deleteTimerRef = useRef<NodeJS.Timeout | null>(null)
  const [nonEmptyTopicIds, setNonEmptyTopicIds] = useState<string[]>([])

  const assistantMap = useMemo(() => new Map(assistants.map((assistant) => [assistant.id, assistant])), [assistants])

  const visibleTopics = useMemo(
    () => topics.filter((topic) => nonEmptyTopicIds.includes(topic.id)),
    [nonEmptyTopicIds, topics]
  )

  const sortedTopics = useMemo(
    () =>
      [...visibleTopics].sort((a, b) => {
        if (a.pinned && !b.pinned) return -1
        if (!a.pinned && b.pinned) return 1
        return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime()
      }),
    [visibleTopics]
  )

  const getAssistantByTopic = useCallback(
    (topic: Topic) => assistantMap.get(topic.assistantId),
    [assistantMap]
  )

  useEffect(() => {
    let cancelled = false

    const loadVisibility = async () => {
      const dbTopics = await TopicManager.getAllTopics()
      if (cancelled) {
        return
      }

      const dbTopicMap = new Map(dbTopics.map((topic) => [topic.id, topic]))
      const nextNonEmptyTopicIds = topics
        .filter((topic) => (dbTopicMap.get(topic.id)?.messages?.length || 0) > 0)
        .map((topic) => topic.id)

      setNonEmptyTopicIds(nextNonEmptyTopicIds)
    }

    void loadVisibility()

    return () => {
      cancelled = true
    }
  }, [topics])

  const patchTopic = useCallback(
    (topic: Topic) => {
      dispatch(updateTopicAction({ assistantId: topic.assistantId, topic }))
      if (topic.id === activeTopic?.id) {
        setActiveTopic(topic)
      }
    },
    [activeTopic?.id, dispatch, setActiveTopic]
  )

  const removeTopicFromAssistant = useCallback(
    async (topic: Topic) => {
      const assistant = getAssistantByTopic(topic)
      if (!assistant) {
        return
      }

      const replacementTopic = sortedTopics.find((item) => item.id !== topic.id) || null

      if (topic.id === activeTopic?.id && replacementTopic) {
        setActiveTopic(replacementTopic)
      }

      if (topic.id === activeTopic?.id && !replacementTopic) {
        onCreateConversation()
      }

      dispatch(removeTopicAction({ assistantId: assistant.id, topic }))
      setDeletingTopicId(null)

      await modelGenerating()
      await TopicManager.removeTopic(topic.id)
    },
    [activeTopic?.id, dispatch, getAssistantByTopic, onCreateConversation, setActiveTopic, sortedTopics]
  )

  const handleDeleteClick = useCallback((topicId: string, event: React.MouseEvent) => {
    event.stopPropagation()

    if (deleteTimerRef.current) {
      clearTimeout(deleteTimerRef.current)
    }

    setDeletingTopicId(topicId)
    deleteTimerRef.current = setTimeout(() => setDeletingTopicId(null), 2000)
  }, [])

  const handleConfirmDelete = useCallback(
    async (topic: Topic, event: React.MouseEvent) => {
      event.stopPropagation()
      await removeTopicFromAssistant(topic)
    },
    [removeTopicFromAssistant]
  )

  const onClearMessages = useCallback((topic: Topic) => {
    dispatch(setGenerating(false))
    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
  }, [dispatch])

  const onPinTopic = useCallback(
    (topic: Topic) => {
      const assistant = getAssistantByTopic(topic)
      if (!assistant) {
        return
      }

      if (pinTopicsToTop) {
        let reorderedTopics = assistant.topics

        if (topic.pinned) {
          const pinnedTopics = assistant.topics.filter((item) => item.pinned)
          const unpinnedTopics = assistant.topics.filter((item) => !item.pinned)
          reorderedTopics = [...pinnedTopics.filter((item) => item.id !== topic.id), topic, ...unpinnedTopics]
        } else {
          const pinnedTopics = assistant.topics.filter((item) => item.pinned)
          const unpinnedTopics = assistant.topics.filter((item) => !item.pinned)
          reorderedTopics = [topic, ...pinnedTopics, ...unpinnedTopics.filter((item) => item.id !== topic.id)]
        }

        dispatch(updateTopicsAction({ assistantId: assistant.id, topics: reorderedTopics }))
      }

      patchTopic({ ...topic, pinned: !topic.pinned })
    },
    [dispatch, getAssistantByTopic, patchTopic, pinTopicsToTop]
  )

  const onMoveTopic = useCallback(
    async (topic: Topic, toAssistant: Assistant) => {
      const fromAssistant = getAssistantByTopic(topic)
      if (!fromAssistant) {
        return
      }

      const nextActiveTopic = sortedTopics.find((item) => item.id !== topic.id) || null
      if (topic.id === activeTopic?.id && nextActiveTopic) {
        setActiveTopic(nextActiveTopic)
      }

      if (topic.id === activeTopic?.id && !nextActiveTopic) {
        onCreateConversation()
      }

      await modelGenerating()
      dispatch(addTopicAction({ assistantId: toAssistant.id, topic: { ...topic, assistantId: toAssistant.id } }))
      dispatch(removeTopicAction({ assistantId: fromAssistant.id, topic }))

      await db
        .topics
        .where('id')
        .equals(topic.id)
        .modify((dbTopic) => {
          if (dbTopic.messages) {
            dbTopic.messages = dbTopic.messages.map((message) => ({
              ...message,
              assistantId: toAssistant.id
            }))
          }
        })
    },
    [activeTopic?.id, dispatch, getAssistantByTopic, onCreateConversation, setActiveTopic, sortedTopics]
  )

  const buildMenuItems = useCallback(
    (topic: Topic): MenuProps['items'] => {
      const assistant = getAssistantByTopic(topic)
      if (!assistant) {
        return []
      }

      const menus: MenuProps['items'] = [
        {
          label: t('chat.topics.auto_rename'),
          key: 'auto-rename',
          icon: <Sparkles size={14} />,
          async onClick() {
            const messages = await TopicManager.getTopicMessages(topic.id)
            if (messages.length >= 2) {
              startTopicRenaming(topic.id)
              try {
                const { text: summaryText, error } = await fetchMessagesSummary({ messages })
                if (summaryText) {
                  patchTopic({ ...topic, name: summaryText, isNameManuallyEdited: false })
                } else if (error) {
                  window.toast?.error(`${t('message.error.fetchTopicName')}: ${error}`)
                }
              } finally {
                finishTopicRenaming(topic.id)
              }
            }
          }
        },
        {
          label: t('chat.topics.edit.title'),
          key: 'rename',
          icon: <EditIcon size={14} />,
          async onClick() {
            const name = await PromptPopup.show({
              title: t('chat.topics.edit.title'),
              message: '',
              defaultValue: topic.name || '',
              extraNode: (
                <div style={{ color: 'var(--color-text-3)', marginTop: 8 }}>{t('chat.topics.edit.title_tip')}</div>
              )
            })

            if (name && topic.name !== name) {
              patchTopic({ ...topic, name, isNameManuallyEdited: true })
            }
          }
        },
        {
          label: t('chat.topics.prompt.label'),
          key: 'topic-prompt',
          icon: <PackagePlus size={14} />,
          extra: (
            <Tooltip title={t('chat.topics.prompt.tips')}>
              <HelpCircle size={14} />
            </Tooltip>
          ),
          async onClick() {
            const prompt = await PromptPopup.show({
              title: t('chat.topics.prompt.edit.title'),
              message: '',
              defaultValue: topic.prompt || '',
              inputProps: {
                rows: 8,
                allowClear: true
              }
            })

            if (prompt !== null) {
              patchTopic({ ...topic, prompt: prompt.trim() })
            }
          }
        },
        {
          label: topic.pinned ? t('chat.topics.unpin') : t('chat.topics.pin'),
          key: 'pin',
          icon: topic.pinned ? <PinOffIcon size={14} /> : <PinIcon size={14} />,
          onClick() {
            onPinTopic(topic)
          }
        },
        {
          label: t('notes.save'),
          key: 'notes',
          icon: <NotebookPen size={14} />,
          onClick: async () => {
            void exportTopicToNotes(topic, notesPath)
          }
        },
        {
          label: t('chat.topics.clear.title'),
          key: 'clear-messages',
          icon: <BrushCleaning size={14} />,
          onClick: () => onClearMessages(topic)
        },
        {
          label: t('settings.topic.position.label'),
          key: 'topic-position',
          icon: <MenuIcon size={14} />,
          children: [
            {
              label: t('settings.topic.position.left'),
              key: 'left',
              onClick: () => setTopicPosition('left')
            },
            {
              label: t('settings.topic.position.right'),
              key: 'right',
              onClick: () => setTopicPosition('right')
            }
          ]
        },
        {
          label: t('chat.topics.copy.title'),
          key: 'copy',
          icon: <CopyIcon size={14} />,
          children: [
            {
              label: t('chat.topics.copy.image'),
              key: 'img',
              onClick: () => EventEmitter.emit(EVENT_NAMES.COPY_TOPIC_IMAGE, topic)
            },
            {
              label: t('chat.topics.copy.md'),
              key: 'md',
              onClick: () => copyTopicAsMarkdown(topic)
            },
            {
              label: t('chat.topics.copy.plain_text'),
              key: 'plain_text',
              onClick: () => copyTopicAsPlainText(topic)
            }
          ]
        },
        {
          label: t('chat.save.label'),
          key: 'save',
          icon: <Save size={14} />,
          children: [
            {
              label: t('chat.save.topic.knowledge.title'),
              key: 'knowledge',
              onClick: async () => {
                try {
                  const result = await SaveToKnowledgePopup.showForTopic(topic)
                  if (result?.success) {
                    window.toast.success(t('chat.save.topic.knowledge.success', { count: result.savedCount }))
                  }
                } catch {
                  window.toast.error(t('chat.save.topic.knowledge.error.save_failed'))
                }
              }
            }
          ]
        },
        {
          label: t('chat.topics.export.title'),
          key: 'export',
          icon: <UploadIcon size={14} />,
          children: [
            exportMenuOptions.image && {
              label: t('chat.topics.export.image'),
              key: 'image',
              onClick: () => EventEmitter.emit(EVENT_NAMES.EXPORT_TOPIC_IMAGE, topic)
            },
            exportMenuOptions.markdown && {
              label: t('chat.topics.export.md.label'),
              key: 'markdown',
              onClick: () => exportTopicAsMarkdown(topic)
            },
            exportMenuOptions.markdown_reason && {
              label: t('chat.topics.export.md.reason'),
              key: 'markdown_reason',
              onClick: () => exportTopicAsMarkdown(topic, true)
            },
            exportMenuOptions.docx && {
              label: t('chat.topics.export.word'),
              key: 'word',
              onClick: async () => {
                const markdown = await topicToMarkdown(topic)
                void window.api.export.toWord(markdown, removeSpecialCharactersForFileName(topic.name))
              }
            },
            exportMenuOptions.notion && {
              label: t('chat.topics.export.notion'),
              key: 'notion',
              onClick: async () => {
                void exportTopicToNotion(topic)
              }
            },
            exportMenuOptions.yuque && {
              label: t('chat.topics.export.yuque'),
              key: 'yuque',
              onClick: async () => {
                const markdown = await topicToMarkdown(topic)
                void exportMarkdownToYuque(topic.name, markdown)
              }
            },
            exportMenuOptions.obsidian && {
              label: t('chat.topics.export.obsidian'),
              key: 'obsidian',
              onClick: async () => {
                await ObsidianExportPopup.show({ title: topic.name, topic, processingMethod: '3' })
              }
            },
            exportMenuOptions.joplin && {
              label: t('chat.topics.export.joplin'),
              key: 'joplin',
              onClick: async () => {
                const topicMessages = await TopicManager.getTopicMessages(topic.id)
                void exportMarkdownToJoplin(topic.name, topicMessages)
              }
            },
            exportMenuOptions.siyuan && {
              label: t('chat.topics.export.siyuan'),
              key: 'siyuan',
              onClick: async () => {
                const markdown = await topicToMarkdown(topic)
                void exportMarkdownToSiyuan(topic.name, markdown)
              }
            }
          ].filter(Boolean) as ItemType<MenuItemType>[]
        }
      ]

      if (assistants.length > 1) {
        menus.push({
          label: t('chat.topics.move_to'),
          key: 'move',
          icon: <FolderOpen size={14} />,
          popupClassName: 'move-to-submenu',
          children: assistants
            .filter((item) => item.id !== assistant.id)
            .map((item) => ({
              label: item.name,
              key: item.id,
              icon: <AssistantAvatar assistant={item} size={18} />,
              onClick: () => void onMoveTopic(topic, item)
            }))
        })
      }

      if (!topic.pinned) {
        menus.push({ type: 'divider' })
        menus.push({
          label: t('common.delete'),
          danger: true,
          key: 'delete',
          icon: <DeleteIcon size={14} className="lucide-custom" />,
          onClick: () => void removeTopicFromAssistant(topic)
        })
      }

      return menus
    },
    [
      assistants,
      exportMenuOptions.docx,
      exportMenuOptions.image,
      exportMenuOptions.joplin,
      exportMenuOptions.markdown,
      exportMenuOptions.markdown_reason,
      exportMenuOptions.notion,
      exportMenuOptions.obsidian,
      exportMenuOptions.siyuan,
      exportMenuOptions.yuque,
      getAssistantByTopic,
      notesPath,
      onClearMessages,
      onMoveTopic,
      onPinTopic,
      patchTopic,
      removeTopicFromAssistant,
      setTopicPosition,
      t
    ]
  )

  return (
    <Container>
      <Header>
        <AddButton onClick={onCreateConversation}>新建对话</AddButton>
      </Header>
      <List>
        {sortedTopics.map((topic) => {
          const assistant = getAssistantByTopic(topic)
          const isActive = topic.id === activeTopic?.id

          return (
            <Dropdown key={topic.id} menu={{ items: buildMenuItems(topic) }} trigger={['contextMenu']}>
              <ConversationItem
                className={classNames({ active: isActive })}
                onClick={() => {
                  dispatch(newMessagesActions.setTopicFulfilled({ topicId: topic.id, fulfilled: false }))
                  setActiveTopic(topic)
                }}>
                <ConversationHeader>
                  <ConversationTitle title={topic.name}>{topic.name}</ConversationTitle>
                  {!topic.pinned ? (
                    <Tooltip
                      placement="bottom"
                      mouseEnterDelay={0.7}
                      title={
                        <div style={{ fontSize: '12px', opacity: 0.8, fontStyle: 'italic' }}>
                          {t('chat.topics.delete.shortcut', { key: isMac ? '⌘' : 'Ctrl' })}
                        </div>
                      }>
                      <DeleteButton
                        className="menu"
                        onClick={(event) => {
                          if (event.ctrlKey || event.metaKey) {
                            void handleConfirmDelete(topic, event)
                          } else if (deletingTopicId === topic.id) {
                            void handleConfirmDelete(topic, event)
                          } else {
                            handleDeleteClick(topic.id, event)
                          }
                        }}>
                        {deletingTopicId === topic.id ? (
                          <DeleteIcon size={13} color="var(--color-error)" style={{ pointerEvents: 'none' }} />
                        ) : (
                          <XIcon size={13} color="var(--color-text-3)" style={{ pointerEvents: 'none' }} />
                        )}
                      </DeleteButton>
                    </Tooltip>
                  ) : (
                    <PinnedMark className="menu">
                      <PinIcon size={13} color="var(--color-text-3)" />
                    </PinnedMark>
                  )}
                </ConversationHeader>
                <ConversationMeta>
                  <span>{assistant?.name || '默认助手'}</span>
                  <span>{dayjs(topic.updatedAt || topic.createdAt).format('YYYY/MM/DD HH:mm')}</span>
                </ConversationMeta>
              </ConversationItem>
            </Dropdown>
          )
        })}
        {sortedTopics.length === 0 && <EmptyState>还没有历史对话</EmptyState>}
      </List>
    </Container>
  )
}

const Container = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
`

const Header = styled.div`
  padding: 12px 10px 8px;
`

const List = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  padding: 0 10px 12px;
`

const ConversationItem = styled.div`
  width: 100%;
  border: none;
  background: transparent;
  border-radius: 14px;
  padding: 10px 12px;
  cursor: pointer;
  text-align: left;
  transition: background-color 0.18s ease;

  .menu {
    opacity: 0;
  }

  &:hover,
  &.active {
    background: var(--color-list-item);

    .menu {
      opacity: 1;
    }
  }
`

const ConversationHeader = styled.div`
  display: flex;
  align-items: flex-start;
  gap: 8px;
`

const ConversationTitle = styled.div`
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #3f4a59;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`

const ConversationMeta = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-3);

  span:first-child {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  span:last-child {
    flex-shrink: 0;
  }
`

const DeleteButton = styled.div`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 999px;

  &:hover {
    background: var(--color-background-mute);
  }
`

const PinnedMark = styled.div`
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
`

const EmptyState = styled.div`
  padding: 24px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--color-text-3);
`

export default ConversationHistoryList
