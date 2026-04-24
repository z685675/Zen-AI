import AddButton from '@renderer/components/AddButton'
import AssistantAvatar from '@renderer/components/Avatar/AssistantAvatar'
import { Sortable } from '@renderer/components/dnd'
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
import RecycleBinService, {
  type RecycleBinConversationFolderItem,
  type RecycleBinTopicItem
} from '@renderer/services/RecycleBinService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import {
  addTopic as addTopicAction,
  createConversationFolder,
  moveTopicToConversationFolder,
  removeTopic as removeTopicAction,
  renameConversationFolder,
  reorderConversationFolders,
  selectAllTopics,
  selectConversationFolders,
  toggleConversationFolderCollapsed,
  updateTopic as updateTopicAction,
  updateTopics as updateTopicsAction
} from '@renderer/store/assistants'
import { newMessagesActions } from '@renderer/store/newMessage'
import { setGenerating } from '@renderer/store/runtime'
import type { Assistant, ConversationFolder, Topic } from '@renderer/types'
import { classNames, removeSpecialCharactersForFileName, uuid } from '@renderer/utils'
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
import { Dropdown, Modal, Tooltip } from 'antd'
import type { ItemType, MenuItemType } from 'antd/es/menu/interface'
import dayjs from 'dayjs'
import {
  BrushCleaning,
  Check,
  ChevronDown,
  ChevronRight,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  HelpCircle,
  MenuIcon,
  NotebookPen,
  PackagePlus,
  PinIcon,
  PinOffIcon,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
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

interface FolderWithTopics {
  folder: ConversationFolder
  topics: Topic[]
}

const ConversationHistoryList: FC<Props> = ({ activeTopic, setActiveTopic, onCreateConversation }) => {
  const { t } = useTranslation()
  const dispatch = useAppDispatch()
  const topics = useAppSelector(selectAllTopics)
  const conversationFolders = useAppSelector(selectConversationFolders)
  const collapsedConversationFolders = useAppSelector((state) => state.assistants.collapsedConversationFolders || {})
  const exportMenuOptions = useAppSelector((state) => state.settings.exportMenuOptions)
  const { assistants } = useAssistants()
  const { notesPath } = useNotesSettings()
  const { pinTopicsToTop, setTopicPosition } = useSettings()
  const [deletingTopicId, setDeletingTopicId] = useState<string | null>(null)
  const deleteTimerRef = useRef<NodeJS.Timeout | null>(null)
  const [nonEmptyTopicIds, setNonEmptyTopicIds] = useState<string[]>([])
  const [recentDeletedTopics, setRecentDeletedTopics] = useState<RecycleBinTopicItem[]>([])
  const [recentDeletedFolders, setRecentDeletedFolders] = useState<RecycleBinConversationFolderItem[]>([])
  const [isRecycleBinOpen, setIsRecycleBinOpen] = useState(false)
  const [expandedDeletedFolderIds, setExpandedDeletedFolderIds] = useState<Set<string>>(new Set())
  const [isRecycleBinManageMode, setIsRecycleBinManageMode] = useState(false)
  const [selectedRecycleBinItemKeys, setSelectedRecycleBinItemKeys] = useState<Set<string>>(new Set())

  const assistantMap = useMemo(() => new Map(assistants.map((assistant) => [assistant.id, assistant])), [assistants])

  const loadRecentDeletedTopics = useCallback(async () => {
    const [topicItems, folderItems] = await Promise.all([
      RecycleBinService.listTopics(),
      RecycleBinService.listConversationFolders()
    ])
    setRecentDeletedTopics(topicItems)
    setRecentDeletedFolders(folderItems)
  }, [])

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

  const topicFolderMap = useMemo(() => {
    const map = new Map<string, ConversationFolder>()
    conversationFolders.forEach((folder) => {
      folder.topicIds.forEach((topicId) => map.set(topicId, folder))
    })
    return map
  }, [conversationFolders])

  const groupedFolders = useMemo<FolderWithTopics[]>(() => {
    return conversationFolders
      .map((folder) => ({
        folder,
        topics: sortedTopics.filter((topic) => folder.topicIds.includes(topic.id))
      }))
  }, [conversationFolders, sortedTopics])

  const rootTopics = useMemo(
    () => sortedTopics.filter((topic) => !topicFolderMap.has(topic.id)),
    [sortedTopics, topicFolderMap]
  )

  const deletedFolderTopicsMap = useMemo(() => {
    const map = new Map<string, RecycleBinTopicItem[]>()
    recentDeletedFolders.forEach((folder) => {
      map.set(
        folder.folder.id,
        recentDeletedTopics.filter((topic) => topic.folderId === folder.folder.id)
      )
    })
    return map
  }, [recentDeletedFolders, recentDeletedTopics])

  const deletedRootTopics = useMemo(
    () =>
      recentDeletedTopics.filter(
        (topic) => !topic.folderId || !recentDeletedFolders.some((folder) => folder.folder.id === topic.folderId)
      ),
    [recentDeletedFolders, recentDeletedTopics]
  )

  const visibleRecycleBinItemKeys = useMemo(() => {
    const keys: string[] = []

    recentDeletedFolders.forEach((item) => {
      keys.push(`folder:${item.entryId}`)

      if (expandedDeletedFolderIds.has(item.folder.id)) {
        ;(deletedFolderTopicsMap.get(item.folder.id) || []).forEach((topicItem) => {
          keys.push(`topic:${topicItem.entryId}`)
        })
      }
    })

    deletedRootTopics.forEach((item) => {
      keys.push(`topic:${item.entryId}`)
    })

    return keys
  }, [deletedFolderTopicsMap, deletedRootTopics, expandedDeletedFolderIds, recentDeletedFolders])

  const isAllRecycleBinItemsSelected = useMemo(
    () =>
      visibleRecycleBinItemKeys.length > 0 &&
      visibleRecycleBinItemKeys.every((itemKey) => selectedRecycleBinItemKeys.has(itemKey)),
    [selectedRecycleBinItemKeys, visibleRecycleBinItemKeys]
  )

  const getAssistantByTopic = useCallback(
    (topic: Topic) => assistantMap.get(topic.assistantId),
    [assistantMap]
  )

  useEffect(() => {
    void loadRecentDeletedTopics()
  }, [loadRecentDeletedTopics])

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

      await modelGenerating()
      await RecycleBinService.moveTopicToRecycleBin(topic)
      dispatch(removeTopicAction({ assistantId: assistant.id, topic }))
      setDeletingTopicId(null)
      await loadRecentDeletedTopics()
    },
    [activeTopic?.id, dispatch, getAssistantByTopic, loadRecentDeletedTopics, onCreateConversation, setActiveTopic, sortedTopics]
  )

  const handleRestoreDeletedTopic = useCallback(
    async (entryId: string) => {
      await RecycleBinService.restoreTopic(entryId)
      await loadRecentDeletedTopics()
    },
    [loadRecentDeletedTopics]
  )

  const handleDeleteRecentTopicPermanently = useCallback(
    async (entryId: string) => {
      window.modal.confirm({
        title: '彻底删除',
        content: '此对话将从最近删除中彻底移除，且无法恢复。',
        centered: true,
        okButtonProps: { danger: true },
        onOk: async () => {
          await RecycleBinService.permanentlyDeleteTopic(entryId)
          await loadRecentDeletedTopics()
        }
      })
    },
    [loadRecentDeletedTopics]
  )

  const handleRestoreDeletedFolder = useCallback(
    async (entryId: string) => {
      await RecycleBinService.restoreConversationFolder(entryId)
      await loadRecentDeletedTopics()
    },
    [loadRecentDeletedTopics]
  )

  const handleDeleteRecentFolderPermanently = useCallback(
    async (entryId: string) => {
      window.modal.confirm({
        title: '彻底删除',
        content: '此文件夹及其中的对话会从最近删除中彻底移除，且无法恢复。',
        centered: true,
        okButtonProps: { danger: true },
        onOk: async () => {
          await RecycleBinService.permanentlyDeleteConversationFolder(entryId)
          await loadRecentDeletedTopics()
        }
      })
    },
    [loadRecentDeletedTopics]
  )

  const handleToggleDeletedFolderExpanded = useCallback((folderId: string) => {
    setExpandedDeletedFolderIds((prev) => {
      const next = new Set(prev)
      if (next.has(folderId)) {
        next.delete(folderId)
      } else {
        next.add(folderId)
      }
      return next
    })
  }, [])

  const handleToggleRecycleBinItemSelection = useCallback((itemKey: string) => {
    setSelectedRecycleBinItemKeys((prev) => {
      const next = new Set(prev)
      if (next.has(itemKey)) {
        next.delete(itemKey)
      } else {
        next.add(itemKey)
      }
      return next
    })
  }, [])

  const handleToggleSelectAllRecycleBinItems = useCallback(() => {
    setSelectedRecycleBinItemKeys(isAllRecycleBinItemsSelected ? new Set() : new Set(visibleRecycleBinItemKeys))
  }, [isAllRecycleBinItemsSelected, visibleRecycleBinItemKeys])

  const handleBatchDeleteRecycleBinItems = useCallback(() => {
    if (selectedRecycleBinItemKeys.size === 0) {
      return
    }

    const selectedFolderEntries = recentDeletedFolders.filter((item) =>
      selectedRecycleBinItemKeys.has(`folder:${item.entryId}`)
    )
    const selectedFolderIds = new Set(selectedFolderEntries.map((item) => item.folder.id))
    const selectedTopicEntries = recentDeletedTopics.filter(
      (item) =>
        selectedRecycleBinItemKeys.has(`topic:${item.entryId}`) && (!item.folderId || !selectedFolderIds.has(item.folderId))
    )

    window.modal.confirm({
      title: '批量彻底删除',
      content: `将彻底删除 ${selectedFolderEntries.length + selectedTopicEntries.length} 项，且无法恢复。`,
      centered: true,
      okButtonProps: { danger: true },
      onOk: async () => {
        for (const item of selectedFolderEntries) {
          await RecycleBinService.permanentlyDeleteConversationFolder(item.entryId)
        }

        for (const item of selectedTopicEntries) {
          await RecycleBinService.permanentlyDeleteTopic(item.entryId)
        }

        setSelectedRecycleBinItemKeys(new Set())
        setIsRecycleBinManageMode(false)
        await loadRecentDeletedTopics()
      }
    })
  }, [loadRecentDeletedTopics, recentDeletedFolders, recentDeletedTopics, selectedRecycleBinItemKeys])

  const handleCreateFolder = useCallback(async () => {
    const name = await PromptPopup.show({
      title: '新建文件夹',
      message: '',
      defaultValue: '',
      inputPlaceholder: '输入文件夹名称'
    })

    if (!name?.trim()) {
      return
    }

    dispatch(
      createConversationFolder({
        id: uuid(),
        name: name.trim()
      })
    )
  }, [dispatch])

  const handleCreateFolderForTopic = useCallback(
    async (topicId: string) => {
      const name = await PromptPopup.show({
        title: '新建文件夹',
        message: '',
        defaultValue: '',
        inputPlaceholder: '输入文件夹名称'
      })

      if (!name?.trim()) {
        return
      }

      const folderId = uuid()
      dispatch(
        createConversationFolder({
          id: folderId,
          name: name.trim()
        })
      )
      dispatch(moveTopicToConversationFolder({ topicId, folderId }))
    },
    [dispatch]
  )

  const handleRenameFolder = useCallback(
    async (folder: ConversationFolder) => {
      const name = await PromptPopup.show({
        title: '重命名文件夹',
        message: '',
        defaultValue: folder.name,
        inputPlaceholder: '输入文件夹名称'
      })

      if (!name?.trim() || name.trim() === folder.name) {
        return
      }

      dispatch(
        renameConversationFolder({
          id: folder.id,
          name: name.trim()
        })
      )
    },
    [dispatch]
  )

  const handleDeleteFolder = useCallback(
    async (folder: ConversationFolder) => {
      window.modal.confirm({
        title: '删除文件夹',
        content: `删除文件夹“${folder.name}”后，文件夹和其中的对话会一起进入最近删除。`,
        centered: true,
        okButtonProps: { danger: true },
        onOk: async () => {
          await RecycleBinService.moveConversationFolderToRecycleBin(folder)
          await loadRecentDeletedTopics()
        }
      })
    },
    [loadRecentDeletedTopics]
  )

  const handleMoveTopicIntoFolder = useCallback(
    (topicId: string, folderId?: string) => {
      dispatch(moveTopicToConversationFolder({ topicId, folderId }))
    },
    [dispatch]
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
      const currentFolder = topicFolderMap.get(topic.id)

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
          label: currentFolder ? '移动到其他文件夹' : '归档到文件夹',
          key: 'conversation-folder',
          icon: <FolderClosed size={14} />,
          children: [
            {
              label: '新建文件夹并移入',
              key: 'folder-create',
              onClick: () => void handleCreateFolderForTopic(topic.id)
            },
            ...(conversationFolders.length > 0 ? [{ type: 'divider' as const }] : []),
            ...conversationFolders
              .filter((folder) => folder.id !== currentFolder?.id)
              .map((folder) => ({
                label: folder.name,
                key: `folder-${folder.id}`,
                onClick: () => handleMoveTopicIntoFolder(topic.id, folder.id)
              })),
            ...(currentFolder
              ? [
                  {
                    label: '移出文件夹',
                    key: 'folder-remove',
                    onClick: () => handleMoveTopicIntoFolder(topic.id)
                  }
                ]
              : [])
          ]
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
      conversationFolders,
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
      handleCreateFolderForTopic,
      handleMoveTopicIntoFolder,
      notesPath,
      onClearMessages,
      onMoveTopic,
      onPinTopic,
      patchTopic,
      topicFolderMap,
      removeTopicFromAssistant,
      setTopicPosition,
      t
    ]
  )

  const buildFolderMenuItems = useCallback(
    (folder: ConversationFolder): MenuProps['items'] => [
      {
        label: '重命名文件夹',
        key: 'rename-folder',
        icon: <EditIcon size={14} />,
        onClick: () => void handleRenameFolder(folder)
      },
      {
        label: collapsedConversationFolders[folder.id] ? '展开文件夹' : '折叠文件夹',
        key: 'toggle-folder',
        icon: collapsedConversationFolders[folder.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />,
        onClick: () => dispatch(toggleConversationFolderCollapsed({ id: folder.id }))
      },
      { type: 'divider' },
      {
        label: '删除文件夹',
        key: 'delete-folder',
        danger: true,
        icon: <DeleteIcon size={14} className="lucide-custom" />,
        onClick: () => handleDeleteFolder(folder)
      }
    ],
    [collapsedConversationFolders, dispatch, handleDeleteFolder, handleRenameFolder]
  )

  const renderTopicItem = useCallback(
    (topic: Topic, nested: boolean = false) => {
      const assistant = getAssistantByTopic(topic)
      const isActive = topic.id === activeTopic?.id

      return (
        <Dropdown key={topic.id} menu={{ items: buildMenuItems(topic) }} trigger={['contextMenu']}>
          <ConversationItem
            className={classNames({ active: isActive, nested })}
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
                      {t('chat.topics.delete.shortcut', { key: isMac ? 'Cmd' : 'Ctrl' })}
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
              <span>{assistant?.name || '榛樿鍔╂墜'}</span>
              <span>{dayjs(topic.updatedAt || topic.createdAt).format('YYYY/MM/DD HH:mm')}</span>
            </ConversationMeta>
          </ConversationItem>
        </Dropdown>
      )
    },
    [
      activeTopic?.id,
      buildMenuItems,
      deletingTopicId,
      dispatch,
      getAssistantByTopic,
      handleConfirmDelete,
      handleDeleteClick,
      setActiveTopic,
      t
    ]
  )

  const renderFolderSection = useCallback(
    ({ folder, topics }: FolderWithTopics, dragging: boolean = false) => (
      <FolderSection key={folder.id} className={classNames({ dragging })}>
        <Dropdown menu={{ items: buildFolderMenuItems(folder) }} trigger={['contextMenu']}>
          <FolderRow
            className={classNames({ active: topics.some((topic) => topic.id === activeTopic?.id) })}
            onClick={() => dispatch(toggleConversationFolderCollapsed({ id: folder.id }))}>
            <FolderHeader>
              <FolderTitleWrap>
                {collapsedConversationFolders[folder.id] ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                {collapsedConversationFolders[folder.id] ? <FolderClosed size={14} /> : <FolderOpen size={14} />}
                <FolderTitle title={folder.name}>{folder.name}</FolderTitle>
              </FolderTitleWrap>
              <FolderCount>{topics.length}</FolderCount>
            </FolderHeader>
          </FolderRow>
        </Dropdown>
        {!collapsedConversationFolders[folder.id] && topics.map((topic) => renderTopicItem(topic, true))}
      </FolderSection>
    ),
    [activeTopic?.id, buildFolderMenuItems, collapsedConversationFolders, dispatch, renderTopicItem]
  )

  return (
    <Container>
      <Header>
        <HeaderRow>
          <AddButton onClick={onCreateConversation}>新建对话</AddButton>
          <Tooltip title="新建文件夹" mouseEnterDelay={0.5}>
            <HeaderIconButton onClick={() => void handleCreateFolder()}>
              <FolderPlus size={14} />
            </HeaderIconButton>
          </Tooltip>
        </HeaderRow>
      </Header>
      <List>
        {groupedFolders.length > 0 && (
          <Sortable
            items={groupedFolders}
            itemKey={(item) => item.folder.id}
            layout="list"
            gap="8px"
            listStyle={{ width: '100%', alignItems: 'stretch' }}
            itemStyle={{ width: '100%' }}
            restrictions={{ scrollableAncestor: true }}
            onSortEnd={({ oldIndex, newIndex }) => {
              dispatch(reorderConversationFolders({ oldIndex, newIndex }))
            }}
            renderItem={(item, { dragging }) => renderFolderSection(item, dragging)}
          />
        )}
        {rootTopics.map((topic) => renderTopicItem(topic))}
        {sortedTopics.length === 0 && groupedFolders.length === 0 && <EmptyState>还没有历史对话</EmptyState>}
      </List>
      {(recentDeletedTopics.length > 0 || recentDeletedFolders.length > 0) && (
        <Footer>
          <RecycleBinEntryButton type="button" onClick={() => setIsRecycleBinOpen(true)}>
            最近删除 ({recentDeletedTopics.length + recentDeletedFolders.length})
          </RecycleBinEntryButton>
        </Footer>
      )}
      <Modal
        title="最近删除"
        open={isRecycleBinOpen}
        onCancel={() => {
          setIsRecycleBinOpen(false)
          setIsRecycleBinManageMode(false)
          setSelectedRecycleBinItemKeys(new Set())
        }}
        footer={null}
        width={560}
        transitionName="animation-move-down"
        centered>
        <RecycleBinToolbar>
          <RecycleBinToolbarButton
            type="button"
            onClick={() => {
              setIsRecycleBinManageMode((prev) => !prev)
              setSelectedRecycleBinItemKeys(new Set())
            }}>
            {isRecycleBinManageMode ? '取消管理' : '批量删除'}
          </RecycleBinToolbarButton>
          {isRecycleBinManageMode && (
            <>
              <RecycleBinToolbarButton type="button" onClick={handleToggleSelectAllRecycleBinItems}>
                {isAllRecycleBinItemsSelected ? '取消全选' : '全选可见项'}
              </RecycleBinToolbarButton>
              <RecycleBinToolbarButton
                type="button"
                danger
                disabled={selectedRecycleBinItemKeys.size === 0}
                onClick={handleBatchDeleteRecycleBinItems}>
                彻底删除所选 ({selectedRecycleBinItemKeys.size})
              </RecycleBinToolbarButton>
            </>
          )}
        </RecycleBinToolbar>
        <RecycleBinModalList>
          {recentDeletedFolders.map((item) => (
            <RecentDeletedFolderGroup key={`tree-${item.entryId}`}>
              <RecentDeletedItem
                role="button"
                tabIndex={0}
                onClick={() => handleToggleDeletedFolderExpanded(item.folder.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    handleToggleDeletedFolderExpanded(item.folder.id)
                  }
                }}>
                {isRecycleBinManageMode && (
                  <RecentDeletedSelector
                    type="button"
                    aria-label="选择文件夹"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleToggleRecycleBinItemSelection(`folder:${item.entryId}`)
                    }}>
                    {selectedRecycleBinItemKeys.has(`folder:${item.entryId}`) && <Check size={12} />}
                  </RecentDeletedSelector>
                )}
                <RecentDeletedMeta>
                  <RecentDeletedFolderTitleWrap>
                    {expandedDeletedFolderIds.has(item.folder.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    <FolderClosed size={14} />
                    <RecentDeletedName title={item.folder.name}>{item.folder.name}</RecentDeletedName>
                  </RecentDeletedFolderTitleWrap>
                  <RecentDeletedTime>
                    <span>{`${deletedFolderTopicsMap.get(item.folder.id)?.length || 0} 个对话`}</span>
                    <span>{dayjs(item.deletedAt).format('YYYY/MM/DD HH:mm')}</span>
                  </RecentDeletedTime>
                </RecentDeletedMeta>
                <RecentDeletedActions>
                  {!isRecycleBinManageMode && (
                    <>
                      <RecentDeletedActionButton
                        type="button"
                        title="恢复"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleRestoreDeletedFolder(item.entryId)
                        }}>
                        <RotateCcw size={12} />
                      </RecentDeletedActionButton>
                      <RecentDeletedActionButton
                        type="button"
                        danger
                        title="彻底删除"
                        onClick={(event) => {
                          event.stopPropagation()
                          void handleDeleteRecentFolderPermanently(item.entryId)
                        }}>
                        <Trash2 size={12} />
                      </RecentDeletedActionButton>
                    </>
                  )}
                </RecentDeletedActions>
              </RecentDeletedItem>
              {expandedDeletedFolderIds.has(item.folder.id) && (
                <RecentDeletedChildren>
                  {(deletedFolderTopicsMap.get(item.folder.id) || []).map((topicItem) => (
                    <RecentDeletedItem key={topicItem.entryId}>
                      {isRecycleBinManageMode && (
                        <RecentDeletedSelector
                          type="button"
                          aria-label="选择对话"
                          onClick={() => handleToggleRecycleBinItemSelection(`topic:${topicItem.entryId}`)}>
                          {selectedRecycleBinItemKeys.has(`topic:${topicItem.entryId}`) && <Check size={12} />}
                        </RecentDeletedSelector>
                      )}
                      <RecentDeletedMeta>
                        <RecentDeletedName title={topicItem.topic.name}>{topicItem.topic.name}</RecentDeletedName>
                        <RecentDeletedTime>
                          <span>{assistantMap.get(topicItem.topic.assistantId)?.name || '默认助手'}</span>
                          <span>{dayjs(topicItem.deletedAt).format('MM/DD HH:mm')}</span>
                        </RecentDeletedTime>
                      </RecentDeletedMeta>
                      <RecentDeletedActions>
                        {!isRecycleBinManageMode && (
                          <>
                            <RecentDeletedActionButton
                              type="button"
                              title="恢复"
                              onClick={() => void handleRestoreDeletedTopic(topicItem.entryId)}>
                              <RotateCcw size={12} />
                            </RecentDeletedActionButton>
                            <RecentDeletedActionButton
                              type="button"
                              danger
                              title="彻底删除"
                              onClick={() => void handleDeleteRecentTopicPermanently(topicItem.entryId)}>
                              <Trash2 size={12} />
                            </RecentDeletedActionButton>
                          </>
                        )}
                      </RecentDeletedActions>
                    </RecentDeletedItem>
                  ))}
                </RecentDeletedChildren>
              )}
            </RecentDeletedFolderGroup>
          ))}
          {deletedRootTopics.map((item) => (
            <RecentDeletedItem key={item.entryId}>
              {isRecycleBinManageMode && (
                <RecentDeletedSelector
                  type="button"
                  aria-label="选择对话"
                  onClick={() => handleToggleRecycleBinItemSelection(`topic:${item.entryId}`)}>
                  {selectedRecycleBinItemKeys.has(`topic:${item.entryId}`) && <Check size={12} />}
                </RecentDeletedSelector>
              )}
              <RecentDeletedMeta>
                <RecentDeletedName title={item.topic.name}>{item.topic.name}</RecentDeletedName>
                <RecentDeletedTime>
                  <span>{assistantMap.get(item.topic.assistantId)?.name || '默认助手'}</span>
                  <span>{dayjs(item.deletedAt).format('MM/DD HH:mm')}</span>
                </RecentDeletedTime>
              </RecentDeletedMeta>
              <RecentDeletedActions>
                {!isRecycleBinManageMode && (
                  <>
                    <RecentDeletedActionButton
                      type="button"
                      title="恢复"
                      onClick={() => void handleRestoreDeletedTopic(item.entryId)}>
                      <RotateCcw size={12} />
                    </RecentDeletedActionButton>
                    <RecentDeletedActionButton
                      type="button"
                      danger
                      title="彻底删除"
                      onClick={() => void handleDeleteRecentTopicPermanently(item.entryId)}>
                      <Trash2 size={12} />
                    </RecentDeletedActionButton>
                  </>
                )}
              </RecentDeletedActions>
            </RecentDeletedItem>
          ))}
        </RecycleBinModalList>
      </Modal>
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

const HeaderRow = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
`

const HeaderIconButton = styled.div`
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  min-width: 32px;
  min-height: 32px;
  border-radius: var(--list-item-border-radius);
  cursor: pointer;
  color: var(--color-text-2);
  transition: all 0.2s;

  &:hover {
    background-color: var(--color-background-mute);
    color: var(--color-text-1);
  }
`

const List = styled(Scrollbar)`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  padding: 0 10px 12px;
`

const FolderSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;

  &.dragging {
    z-index: 2;
  }
`

const FolderRow = styled.div`
  width: 100%;
  border-radius: 14px;
  padding: 8px 10px;
  cursor: grab;
  background: var(--color-background-soft);
  transition: background-color 0.18s ease;

  &:hover,
  &.active {
    background: var(--color-list-item);
  }

  &:active {
    cursor: grabbing;
  }
`

const FolderHeader = styled.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
`

const FolderTitleWrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const FolderTitle = styled.div`
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: #3f4a59;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const FolderCount = styled.div`
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-3);
`

const Footer = styled.div`
  padding: 0 10px 12px;
  border-top: 0.5px solid var(--color-border);
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

  &.nested {
    margin-left: 14px;
    width: calc(100% - 14px);
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

const RecycleBinEntryButton = styled.button`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8px 10px;
  border: none;
  border-radius: 12px;
  background: var(--color-background-soft);
  color: var(--color-text-2);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;

  &:hover {
    background: var(--color-background-mute);
    color: var(--color-text);
  }
`

const RecycleBinModalList = styled.div`
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 60vh;
  overflow-y: auto;
`

const RecycleBinToolbar = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
`

const RecycleBinToolbarButton = styled.button<{ danger?: boolean; disabled?: boolean }>`
  border: none;
  border-radius: 999px;
  padding: 6px 12px;
  background: ${({ danger }) => (danger ? 'rgba(220, 38, 38, 0.12)' : 'var(--color-background-soft)')};
  color: ${({ danger }) => (danger ? '#dc2626' : 'var(--color-text-2)')};
  font-size: 12px;
  font-weight: 500;
  cursor: ${({ disabled }) => (disabled ? 'not-allowed' : 'pointer')};
  opacity: ${({ disabled }) => (disabled ? 0.45 : 1)};

  &:hover {
    background: ${({ danger }) => (danger ? 'rgba(220, 38, 38, 0.16)' : 'var(--color-background-mute)')};
    color: ${({ danger }) => (danger ? '#b91c1c' : 'var(--color-text)')};
  }
`

const RecentDeletedFolderGroup = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
`

const RecentDeletedItem = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 14px;
  background: var(--color-background-soft);
`

const RecentDeletedSelector = styled.button`
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border: 1px solid rgba(15, 23, 42, 0.15);
  border-radius: 6px;
  background: #ffffff;
  color: #16a34a;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
`

const RecentDeletedFolderTitleWrap = styled.div`
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
`

const RecentDeletedMeta = styled.div`
  flex: 1;
  min-width: 0;
`

const RecentDeletedName = styled.div`
  font-size: 13px;
  font-weight: 500;
  color: #3f4a59;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
`

const RecentDeletedTime = styled.div`
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

const RecentDeletedChildren = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-left: 18px;
`

const RecentDeletedActions = styled.div`
  display: inline-flex;
  align-items: center;
  gap: 4px;
`

const RecentDeletedActionButton = styled.button<{ danger?: boolean }>`
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text-2)')};
  cursor: pointer;

  &:hover {
    background: var(--color-background-mute);
    color: ${(props) => (props.danger ? 'var(--color-error)' : 'var(--color-text)')};
  }
`

export default ConversationHistoryList

