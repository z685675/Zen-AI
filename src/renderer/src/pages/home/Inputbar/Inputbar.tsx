import { loggerService } from '@logger'
import { isAssistantModelIdentifierBlocked } from '@renderer/config/agentModelPolicy'
import { chatModelFilter, isMandatoryWebSearchModel, isVisionModel, isVisionModels } from '@renderer/config/models'
import { useAssistant, useDefaultModel } from '@renderer/hooks/useAssistant'
import { useInputText } from '@renderer/hooks/useInputText'
import { useMessageOperations, useTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useShortcut } from '@renderer/hooks/useShortcuts'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { useTimer } from '@renderer/hooks/useTimer'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { checkRateLimit, getUserMessage } from '@renderer/services/MessagesService'
import { spanManagerService } from '@renderer/services/SpanManagerService'
import { estimateTextTokens as estimateTxtTokens, estimateUserPromptUsage } from '@renderer/services/TokenService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { selectMessagesForTopic } from '@renderer/store/newMessage'
import { sendMessage as _sendMessage } from '@renderer/store/thunk/messageThunk'
import {
  type Assistant,
  type FileMetadata,
  type KnowledgeBase,
  type Model,
  type Topic,
  TopicType
} from '@renderer/types'
import type { MessageInputBaseParams } from '@renderer/types/newMessage'
import { delay } from '@renderer/utils'
import { getChatTopicDraftCacheKey } from '@renderer/utils/conversationDraft'
import { getTopicConversationAssistant } from '@renderer/utils/conversationModel'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import { getLowerBaseModelName } from '@renderer/utils/naming'
import { aggregateUsageCacheStats } from '@renderer/utils/usage'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import type { ModelPolicy } from '@shared/config/modelPolicy'
import { debounce } from 'lodash'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import ContextStatusIndicator from './components/ContextStatusIndicator'
import { InputbarCore } from './components/InputbarCore'
import ScrollToBottomButton from './components/ScrollToBottomButton'
import InputbarTools from './InputbarTools'
import KnowledgeBaseInput from './KnowledgeBaseInput'
import MentionModelsInput from './MentionModelsInput'
import { getInputbarConfig } from './registry'
import TokenCount from './TokenCount'

const logger = loggerService.withContext('Inputbar')

const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours
const HERO_PLACEHOLDER = 'Zen AI可以帮你写作、总结、翻译内容，也可以处理附件与文件。'

const getMentionedModelsCacheKey = (conversationId: string) => `inputbar-mentioned-models-${conversationId}`

const resolvePolicyFallbackModel = (models: Model[], policy: ModelPolicy): Model | undefined => {
  const candidates = [
    ...policy.assistant.fallbackModels,
    policy.defaults.chat,
    policy.defaults.assistant,
    policy.defaults.assistantNewSession
  ]

  return candidates
    .map((candidate) => {
      const normalizedCandidate = getLowerBaseModelName(candidate.trim())
      return models.find(
        (availableModel) =>
          getLowerBaseModelName(availableModel.id.trim()) === normalizedCandidate &&
          !isAssistantModelIdentifierBlocked(availableModel.id, policy)
      )
    })
    .find((candidate): candidate is Model => Boolean(candidate))
}

const getValidatedCachedModels = (conversationId: string): Model[] => {
  const cached = CacheService.get<Model[]>(getMentionedModelsCacheKey(conversationId))
  if (!Array.isArray(cached)) return []
  return cached.filter((model) => model?.id && model?.name)
}

interface Props {
  assistant: Assistant
  topic: Topic
  onTopicChange: (topic: Topic) => void
  onCreateConversation: () => Promise<void>
}

export type ProviderActionHandlers = {
  resizeTextArea: () => void
  addNewTopic: () => void
  clearTopic: () => void
  onNewContext: () => void
  onTextChange: (updater: string | ((prev: string) => string)) => void
  toggleExpanded: (nextState?: boolean) => void
}

interface InputbarInnerProps extends Props {
  actionsRef: React.RefObject<ProviderActionHandlers>
  variant: 'default' | 'hero'
}

interface InputbarProps extends Props {
  variant?: 'default' | 'hero'
  actionsRef?: React.RefObject<ProviderActionHandlers>
}

const Inputbar: FC<InputbarProps> = ({
  assistant: initialAssistant,
  topic,
  onTopicChange,
  onCreateConversation,
  variant = 'default',
  actionsRef: externalActionsRef
}) => {
  const internalActionsRef = useRef<ProviderActionHandlers>({
    resizeTextArea: () => {},
    addNewTopic: () => {},
    clearTopic: () => {},
    onNewContext: () => {},
    onTextChange: () => {},
    toggleExpanded: () => {}
  })
  const actionsRef = externalActionsRef ?? internalActionsRef

  const [initialMentionedModels] = useState(() => getValidatedCachedModels(topic.id))

  const initialState = useMemo(
    () => ({
      files: [] as FileMetadata[],
      mentionedModels: initialMentionedModels,
      selectedKnowledgeBases: initialAssistant.knowledge_bases ?? [],
      isExpanded: false,
      couldAddImageFile: false,
      extensions: [] as string[]
    }),
    [initialMentionedModels, initialAssistant.knowledge_bases]
  )

  return (
    <InputbarToolsProvider
      key={topic.id}
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        addNewTopic: () => actionsRef.current.addNewTopic(),
        clearTopic: () => actionsRef.current.clearTopic(),
        onNewContext: () => actionsRef.current.onNewContext(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        toggleExpanded: (next) => actionsRef.current.toggleExpanded(next)
      }}>
      <InputbarInner
        assistant={initialAssistant}
        topic={topic}
        onTopicChange={onTopicChange}
        onCreateConversation={onCreateConversation}
        actionsRef={actionsRef}
        variant={variant}
      />
    </InputbarToolsProvider>
  )
}

const InputbarInner: FC<InputbarInnerProps> = ({
  assistant: initialAssistant,
  topic,
  onTopicChange,
  onCreateConversation,
  actionsRef,
  variant
}) => {
  const scope = topic.type ?? TopicType.Chat
  const isHero = variant === 'hero'
  const config = getInputbarConfig(scope)

  const { files, mentionedModels, selectedKnowledgeBases } = useInputbarToolsState()
  const { setFiles, setMentionedModels, setSelectedKnowledgeBases } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const { text, setText } = useInputText({
    initialValue: CacheService.get<string>(getChatTopicDraftCacheKey(topic.id)) ?? '',
    onChange: (value) => CacheService.set(getChatTopicDraftCacheKey(topic.id), value, DRAFT_CACHE_TTL)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({
    maxHeight: 500,
    minHeight: 30
  })

  const { assistant: storedAssistant, updateAssistant, updateTopic } = useAssistant(initialAssistant.id)
  const { defaultModel } = useDefaultModel()
  const assistant = useMemo(
    () => getTopicConversationAssistant(topic, storedAssistant, defaultModel),
    [defaultModel, storedAssistant, topic]
  )
  const updateConversationTopic = useCallback(
    (nextTopic: Topic) => {
      updateTopic(nextTopic)
      onTopicChange(nextTopic)
    },
    [onTopicChange, updateTopic]
  )
  const model = assistant.model as Model
  const { sendMessageShortcut, showInputEstimatedTokens, enableQuickPanelTriggers } = useSettings()
  const [estimateTokenCount, setEstimateTokenCount] = useState(0)
  const [contextCount, setContextCount] = useState({ current: 0, max: 0 })

  const { t } = useTranslation()
  const { pauseMessages } = useMessageOperations(topic)
  const loading = useTopicLoading(topic)
  const topicMessages = useAppSelector((state) => selectMessagesForTopic(state, topic.id))
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy?.policy)
  const availableModels = useAppSelector((state) =>
    state.llm.providers.filter((provider) => provider.enabled).flatMap((provider) => provider.models ?? [])
  )
  const currentModelAvailable = Boolean(
    model &&
      availableModels.some(
        (candidate) => candidate.id === model.id && candidate.provider === model.provider && chatModelFilter(candidate)
      )
  )
  const mentionedModelsAvailable =
    mentionedModels.length > 0 &&
    mentionedModels.every((mentioned) =>
      availableModels.some(
        (candidate) =>
          candidate.id === mentioned.id && candidate.provider === mentioned.provider && chatModelFilter(candidate)
      )
    )
  const modelSelectionUnavailable = mentionedModels.length > 0 ? !mentionedModelsAvailable : !currentModelAvailable
  const dispatch = useAppDispatch()
  const isVisionAssistant = useMemo(() => isVisionModel(model), [model])
  const { setTimeoutTimer } = useTimer()
  const isMultiSelectMode = useAppSelector((state) => state.runtime.chat.isMultiSelectMode)
  const cacheStats = useMemo(
    () => aggregateUsageCacheStats(topicMessages.map((message) => message.usage)),
    [topicMessages]
  )

  const isVisionSupported = useMemo(
    () =>
      (mentionedModels.length > 0 && isVisionModels(mentionedModels)) ||
      (mentionedModels.length === 0 && isVisionAssistant),
    [mentionedModels, isVisionAssistant]
  )

  const canAddImageFile = useMemo(() => {
    return isVisionSupported
  }, [isVisionSupported])

  const canAddTextFile = useMemo(() => {
    return true
  }, [])

  const supportedExts = useMemo(() => {
    if (canAddImageFile && canAddTextFile) {
      return [...imageExts, ...documentExts, ...textExts]
    }

    if (canAddImageFile) {
      return [...imageExts]
    }

    if (canAddTextFile) {
      return [...documentExts, ...textExts]
    }

    return []
  }, [canAddImageFile, canAddTextFile])

  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const mentionedModelsRef = useRef(mentionedModels)
  mentionedModelsRef.current = mentionedModels

  useEffect(() => {
    const cachedModels = getValidatedCachedModels(topic.id)
    setMentionedModels((currentModels) => {
      const isSameSelection =
        currentModels.length === cachedModels.length &&
        currentModels.every((model, index) => model.id === cachedModels[index]?.id)
      return isSameSelection ? currentModels : cachedModels
    })
    return () => {
      CacheService.set(getMentionedModelsCacheKey(topic.id), mentionedModelsRef.current, DRAFT_CACHE_TTL)
    }
  }, [setMentionedModels, topic.id])

  const placeholderText = isHero
    ? HERO_PLACEHOLDER
    : enableQuickPanelTriggers
      ? t('chat.input.placeholder', { key: getSendMessageShortcutLabel(sendMessageShortcut) })
      : t('chat.input.placeholder_without_triggers', {
          key: getSendMessageShortcutLabel(sendMessageShortcut),
          defaultValue: t('chat.input.placeholder', {
            key: getSendMessageShortcutLabel(sendMessageShortcut)
          })
        })

  const sendMessage = useCallback(async () => {
    if (checkRateLimit(assistant)) {
      return
    }

    if (modelSelectionUnavailable) {
      window.toast.warning(t('model_setup.no_matching_model'))
      return
    }

    const blockedMentionedModel =
      modelPolicy && mentionedModels.find((item) => isAssistantModelIdentifierBlocked(item.id, modelPolicy))
    if (blockedMentionedModel) {
      window.toast.warning(`Model ${blockedMentionedModel.name || blockedMentionedModel.id} is no longer available`)
      return
    }

    let effectiveAssistant = assistant
    let effectiveTopic = topic
    let effectiveModel = model
    if (modelPolicy && model && isAssistantModelIdentifierBlocked(model.id, modelPolicy)) {
      const fallbackModel = resolvePolicyFallbackModel(availableModels, modelPolicy)
      if (!fallbackModel) {
        window.toast.error('The current model is no longer available and no fallback model is configured')
        return
      }

      effectiveModel = fallbackModel
      effectiveAssistant = { ...assistant, model: fallbackModel }
      effectiveTopic = { ...topic, model: fallbackModel }
      updateConversationTopic(effectiveTopic)
      window.toast.info(`The unavailable model was replaced with ${fallbackModel.name || fallbackModel.id}`)
    }

    const requestModels = mentionedModels.length > 0 ? mentionedModels : [effectiveModel]
    if (!requestModels.every(chatModelFilter)) {
      window.toast.warning('图片模型只能在“图片生成”入口中使用，请切换为对话模型后再发送。')
      return
    }

    logger.info('Starting to send message')

    const parent = spanManagerService.startTrace(
      { topicId: topic.id, name: 'sendMessage', inputs: text },
      requestModels
    )
    void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: topic.id, traceId: parent?.spanContext().traceId })

    try {
      const uploadedFiles = await FileManager.uploadFiles(files)

      const baseUserMessage: MessageInputBaseParams = {
        assistant: effectiveAssistant,
        topic: effectiveTopic,
        content: text
      }
      if (uploadedFiles) {
        baseUserMessage.files = uploadedFiles
      }
      if (mentionedModels.length) {
        baseUserMessage.mentions = mentionedModels
      }

      baseUserMessage.usage = await estimateUserPromptUsage(baseUserMessage)

      const { message, blocks } = getUserMessage(baseUserMessage)
      message.traceId = parent?.spanContext().traceId

      void dispatch(_sendMessage(message, blocks, effectiveAssistant, topic.id))
      if (effectiveTopic.enableWebSearch) {
        updateConversationTopic({ ...effectiveTopic, enableWebSearch: false })
      }

      setText('')
      setFiles([])
      setMentionedModels([])
      CacheService.remove(getMentionedModelsCacheKey(topic.id))
      setTimeoutTimer('sendMessage_1', () => setText(''), 500)
      setTimeoutTimer('sendMessage_2', () => resizeTextArea(), 0)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
      parent?.recordException(error as Error)
    }
  }, [
    assistant,
    topic,
    text,
    mentionedModels,
    files,
    dispatch,
    setText,
    setFiles,
    setMentionedModels,
    setTimeoutTimer,
    resizeTextArea,
    focusTextarea,
    t,
    model,
    modelPolicy,
    availableModels,
    modelSelectionUnavailable,
    updateConversationTopic
  ])

  const tokenCountProps = useMemo(() => {
    if (
      !currentModelAvailable ||
      !config.showTokenCount ||
      estimateTokenCount === undefined ||
      !showInputEstimatedTokens
    ) {
      return undefined
    }

    return {
      estimateTokenCount,
      inputTokenCount: estimateTokenCount,
      contextCount,
      cacheStats,
      model
    }
  }, [
    cacheStats,
    config.showTokenCount,
    contextCount,
    currentModelAvailable,
    estimateTokenCount,
    model,
    showInputEstimatedTokens
  ])

  const onPause = useCallback(async () => {
    await pauseMessages()
  }, [pauseMessages])

  const clearTopic = useCallback(async () => {
    if (loading) {
      await onPause()
      await delay(1)
    }

    void EventEmitter.emit(EVENT_NAMES.CLEAR_MESSAGES, topic)
    focusTextarea()
  }, [focusTextarea, loading, onPause, topic])

  const onNewContext = useCallback(() => {
    if (loading) {
      void onPause()
      return
    }
    void EventEmitter.emit(EVENT_NAMES.NEW_CONTEXT)
  }, [loading, onPause])

  const addNewTopic = useCallback(async () => {
    await onCreateConversation()
  }, [onCreateConversation])

  const handleRemoveModel = useCallback(
    (modelToRemove: Model) => {
      setMentionedModels(mentionedModels.filter((current) => current.id !== modelToRemove.id))
    },
    [mentionedModels, setMentionedModels]
  )

  const handleRemoveKnowledgeBase = useCallback(
    (knowledgeBase: KnowledgeBase) => {
      const nextKnowledgeBases = assistant.knowledge_bases?.filter((kb) => kb.id !== knowledgeBase.id)
      updateAssistant({ knowledge_bases: nextKnowledgeBases })
      setSelectedKnowledgeBases(nextKnowledgeBases ?? [])
    },
    [assistant, setSelectedKnowledgeBases, updateAssistant]
  )

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      setExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setExpanded, textareaIsExpanded]
  )

  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      addNewTopic,
      clearTopic,
      onNewContext,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, addNewTopic, clearTopic, onNewContext, setText, handleToggleExpanded, actionsRef])

  useShortcut(
    'new_topic',
    (event) => {
      if (event.repeat) {
        return
      }

      void addNewTopic()
      focusTextarea()
    },
    { preventDefault: true, enableOnFormTags: true }
  )

  useShortcut('clear_topic', clearTopic, {
    preventDefault: true,
    enableOnFormTags: true
  })

  useEffect(() => {
    const _setEstimateTokenCount = debounce(setEstimateTokenCount, 100, { leading: false, trailing: true })
    const unsubscribes = [
      EventEmitter.on(EVENT_NAMES.ESTIMATED_TOKEN_COUNT, ({ tokensCount, contextCount }) => {
        _setEstimateTokenCount(tokensCount)
        setContextCount({ current: contextCount.current, max: contextCount.max })
      }),
      ...[EventEmitter.on(EVENT_NAMES.ADD_NEW_TOPIC, addNewTopic)]
    ]

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe())
    }
  }, [addNewTopic])

  useEffect(() => {
    const debouncedEstimate = debounce((value: string) => {
      if (showInputEstimatedTokens) {
        const count = estimateTxtTokens(value) || 0
        setEstimateTokenCount(count)
      }
    }, 500)

    debouncedEstimate(text)
    return () => debouncedEstimate.cancel()
  }, [showInputEstimatedTokens, text])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [topic.id, topic.enableWebSearch, assistant.mcpServers, assistant.knowledge_bases, mentionedModels, focusTextarea])

  // TODO: Just use assistant.knowledge_bases as selectedKnowledgeBases. context state is overdesigned.
  useEffect(() => {
    setSelectedKnowledgeBases(assistant.knowledge_bases ?? [])
  }, [assistant.knowledge_bases, setSelectedKnowledgeBases])

  useEffect(() => {
    if (topic.enableWebSearch && isMandatoryWebSearchModel(model)) {
      updateConversationTopic({ ...topic, enableWebSearch: false })
    }

    // Image generation is handled only from the dedicated image-generation page.
    if (assistant.enableGenerateImage) {
      updateAssistant({ enableGenerateImage: false })
    }
  }, [assistant.enableGenerateImage, model, topic, updateAssistant, updateConversationTopic])

  if (isMultiSelectMode) {
    return null
  }

  // topContent: 所有顶部预览内容
  const topContent = isHero ? null : (
    <>
      {selectedKnowledgeBases.length > 0 && (
        <KnowledgeBaseInput
          selectedKnowledgeBases={selectedKnowledgeBases}
          onRemoveKnowledgeBase={handleRemoveKnowledgeBase}
        />
      )}

      {mentionedModels.length > 0 && (
        <MentionModelsInput selectedModels={mentionedModels} onRemoveModel={handleRemoveModel} />
      )}
    </>
  )

  // leftToolbar: 左侧工具栏
  const leftToolbar =
    config.showTools && currentModelAvailable ? (
      <InputbarTools
        scope={scope}
        assistant={assistant}
        model={model}
        topic={topic}
        onTopicChange={updateConversationTopic}
        toolOrderOverride={
          isHero
            ? {
                visible: [
                  'attachment',
                  'thinking',
                  'web_search',
                  'url_context',
                  'knowledge_base',
                  'mcp_tools',
                  'generate_image'
                ],
                hidden: ['new_topic', 'quick_phrases', 'clear_topic', 'toggle_expand', 'new_context']
              }
            : {
                visible: [],
                hidden: ['new_topic']
              }
        }
      />
    ) : null

  // rightToolbar: 右侧工具栏
  const rightToolbar = isHero ? null : (
    <>
      {tokenCountProps && (
        <TokenCount
          estimateTokenCount={tokenCountProps.estimateTokenCount}
          inputTokenCount={tokenCountProps.inputTokenCount}
          contextCount={tokenCountProps.contextCount}
          cacheStats={tokenCountProps.cacheStats}
          model={tokenCountProps.model}
          onClick={onNewContext}
        />
      )}
    </>
  )

  return (
    <InputbarCore
      scope={scope}
      placeholder={placeholderText}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      isLoading={loading}
      supportedExts={supportedExts}
      onPause={onPause}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      rightToolbar={rightToolbar}
      topContent={topContent}
      pinnedContent={
        isHero ? undefined : (
          <>
            <ScrollToBottomButton conversationKey={topic.id} />
            <ContextStatusIndicator conversationId={topic.id} />
          </>
        )
      }
      forceEnableQuickPanelTriggers={!isHero}
      minimal={isHero}
      sendDisabled={modelSelectionUnavailable}
    />
  )
}

export default Inputbar
