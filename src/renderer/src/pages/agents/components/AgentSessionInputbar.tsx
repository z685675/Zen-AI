import { loggerService } from '@logger'
import { getAnthropicReasoningParams } from '@renderer/aiCore/utils/reasoning'
import { isAssistantModelAllowed } from '@renderer/config/agentModelPolicy'
import { isGenerateImageModel, isVisionModel } from '@renderer/config/models'
import { useSession } from '@renderer/hooks/agents/useSession'
import { useInputText } from '@renderer/hooks/useInputText'
import { selectNewTopicLoading } from '@renderer/hooks/useMessageOperations'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTextareaResize } from '@renderer/hooks/useTextareaResize'
import { InputbarCore } from '@renderer/pages/home/Inputbar/components/InputbarCore'
import ScrollToBottomButton from '@renderer/pages/home/Inputbar/components/ScrollToBottomButton'
import {
  InputbarToolsProvider,
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '@renderer/pages/home/Inputbar/context/InputbarToolsProvider'
import InputbarTools from '@renderer/pages/home/Inputbar/InputbarTools'
import { getInputbarConfig } from '@renderer/pages/home/Inputbar/registry'
import type { ToolContext, ToolOrderConfig } from '@renderer/pages/home/Inputbar/types'
import { TopicType } from '@renderer/pages/home/Inputbar/types'
import { CacheService } from '@renderer/services/CacheService'
import { EVENT_NAMES, EventEmitter } from '@renderer/services/EventService'
import FileManager from '@renderer/services/FileManager'
import { pauseTrace } from '@renderer/services/SpanManagerService'
import { estimateUserPromptUsage } from '@renderer/services/TokenService'
import { useAppDispatch, useAppSelector } from '@renderer/store'
import { newMessagesActions, selectMessagesForTopic } from '@renderer/store/newMessage'
import { sendMessage as dispatchSendMessage } from '@renderer/store/thunk/messageThunk'
import type { Assistant, FileMetadata, Message, ThinkingOption } from '@renderer/types'
import { FILE_TYPE } from '@renderer/types'
import type { MessageBlock } from '@renderer/types/newMessage'
import { MessageBlockStatus } from '@renderer/types/newMessage'
import { abortCompletion } from '@renderer/utils/abortController'
import {
  classifyDeepResearchFollowUp,
  DEEP_RESEARCH_REASONING_EFFORT,
  findResumableDeepResearchTask,
  getAgentSessionDeepResearchCacheKey,
  shouldStartDeepResearchImmediately
} from '@renderer/utils/agentDeepResearch'
import { buildAgentSessionTopicId } from '@renderer/utils/agentSession'
import { getAgentSessionDraft, saveAgentSessionDraft } from '@renderer/utils/agentSessionDraft'
import { getSendMessageShortcutLabel } from '@renderer/utils/input'
import {
  createFileBlock,
  createImageBlock,
  createMainTextBlock,
  createMessage
} from '@renderer/utils/messageUtils/create'
import {
  AGENT_DEFAULT_REASONING_EFFORT,
  type AgentReasoningEffort,
  getAgentSessionReasoningEffortCacheKey,
  normalizeAgentReasoningEffort,
  toAgentEffort
} from '@renderer/utils/reasoningEffort'
import { isAssistantExecutionAllowed } from '@shared/agents/assistantAvailability'
import { documentExts, imageExts, textExts } from '@shared/config/constant'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'
import { v4 as uuid } from 'uuid'

import AutomationSessionBanner from './AutomationSessionBanner'
import LegacyAssistantInputbar from './LegacyAssistantInputbar'

const logger = loggerService.withContext('AgentSessionInputbar')

const DRAFT_CACHE_TTL = 24 * 60 * 60 * 1000 // 24 hours

type Props = {
  agentId: string
  sessionId: string
  variant?: 'default' | 'hero'
}

const AgentSessionInputbar = ({ agentId, sessionId, variant = 'default' }: Props) => {
  if (!isAssistantExecutionAllowed(agentId)) return <LegacyAssistantInputbar />
  return <ActiveAgentSessionInputbar agentId={agentId} sessionId={sessionId} variant={variant} />
}

const ActiveAgentSessionInputbar = ({ agentId, sessionId, variant = 'default' }: Props) => {
  const { session, updateSession } = useSession(agentId, sessionId)
  const providers = useAppSelector((state) => state.llm.providers)
  // FIXME: 不应该使用ref将action传到context提供给tool，权宜之计
  const actionsRef = useRef({
    resizeTextArea: () => {},
    // oxlint-disable-next-line no-unused-vars
    onTextChange: (_updater: React.SetStateAction<string> | ((prev: string) => string)) => {},
    toggleExpanded: () => {}
  })

  // Create assistant stub with session data
  const assistantStub = useMemo<Assistant | null>(() => {
    if (!session) return null

    // Extract model info
    const separatorIndex = session.model?.indexOf(':') ?? -1
    const providerId = separatorIndex > 0 ? session.model.slice(0, separatorIndex) : undefined
    const actualModelId = separatorIndex > 0 ? session.model.slice(separatorIndex + 1) : undefined
    const provider = providers.find((candidate) => candidate.enabled && candidate.id === providerId)
    const actualModel = provider?.models.find((candidate) => candidate.id === actualModelId)

    return {
      id: session.agent_id ?? agentId,
      name: session.name ?? 'Agent Session',
      prompt: session.instructions ?? '',
      topics: [],
      type: 'agent-session',
      model: actualModel,
      defaultModel: actualModel,
      tags: [],
      enableWebSearch: false
    } satisfies Assistant
  }, [session, agentId, providers])

  // Prepare session data for tools
  const sessionData = useMemo(() => {
    if (!session) return undefined
    return {
      agentId,
      sessionId,
      tools: session.tools,
      accessiblePaths: session.accessible_paths ?? []
    }
  }, [session, agentId, sessionId])

  const initialState = useMemo(
    () => ({
      mentionedModels: [],
      selectedKnowledgeBases: [],
      files: [] as FileMetadata[],
      isExpanded: false
    }),
    []
  )

  if (!session || !assistantStub) {
    return null // Wait for session to load
  }

  const reasoningEffortCacheKey = getAgentSessionReasoningEffortCacheKey(agentId, sessionId)
  const initialReasoningEffort = normalizeAgentReasoningEffort(
    CacheService.get<ThinkingOption>(reasoningEffortCacheKey) ?? session.configuration?.reasoning_effort
  )
  const initialDeepResearchEnabled =
    CacheService.get<boolean>(getAgentSessionDeepResearchCacheKey(agentId, sessionId)) === true
  const handleReasoningEffortChange = (option: ThinkingOption) => {
    const reasoningEffort = normalizeAgentReasoningEffort(option)
    CacheService.set(reasoningEffortCacheKey, reasoningEffort, DRAFT_CACHE_TTL)
    void updateSession(
      {
        id: sessionId,
        configuration: {
          ...session.configuration,
          permission_mode: session.configuration?.permission_mode ?? 'default',
          max_turns: session.configuration?.max_turns ?? 100,
          env_vars: session.configuration?.env_vars ?? {},
          reasoning_effort: reasoningEffort
        }
      },
      { showSuccessToast: false }
    )
  }

  return (
    <InputbarToolsProvider
      key={`${agentId}:${sessionId}`}
      initialState={initialState}
      actions={{
        resizeTextArea: () => actionsRef.current.resizeTextArea(),
        onTextChange: (updater) => actionsRef.current.onTextChange(updater),
        // Agent Session specific actions
        addNewTopic: () => {},
        clearTopic: () => {},
        onNewContext: () => {},
        toggleExpanded: () => actionsRef.current.toggleExpanded()
      }}>
      <AutomationSessionBanner sessionId={sessionId} />
      <AgentSessionInputbarInner
        assistant={assistantStub}
        agentId={agentId}
        sessionId={sessionId}
        sessionData={sessionData}
        initialReasoningEffort={initialReasoningEffort}
        initialDeepResearchEnabled={initialDeepResearchEnabled}
        onReasoningEffortChange={handleReasoningEffortChange}
        actionsRef={actionsRef}
        variant={variant}
      />
    </InputbarToolsProvider>
  )
}

interface InnerProps {
  assistant: Assistant
  agentId: string
  sessionId: string
  sessionData?: ToolContext['session']
  initialReasoningEffort: AgentReasoningEffort
  initialDeepResearchEnabled: boolean
  onReasoningEffortChange: (option: ThinkingOption) => void
  variant: 'default' | 'hero'
  actionsRef: React.MutableRefObject<{
    resizeTextArea: () => void
    onTextChange: (updater: React.SetStateAction<string> | ((prev: string) => string)) => void
    toggleExpanded: (nextState?: boolean) => void
  }>
}

const AgentSessionInputbarInner: FC<InnerProps> = ({
  assistant,
  agentId,
  sessionId,
  sessionData,
  initialReasoningEffort,
  initialDeepResearchEnabled,
  onReasoningEffortChange,
  variant,
  actionsRef
}) => {
  const scope = TopicType.Session
  const config = getInputbarConfig(scope)
  const isHero = variant === 'hero'

  // Use shared hooks for text and textarea management with draft persistence
  const {
    text,
    setText,
    isEmpty: inputEmpty
  } = useInputText({
    initialValue: getAgentSessionDraft(agentId, sessionId),
    onChange: (value) => saveAgentSessionDraft(agentId, sessionId, value)
  })
  const {
    textareaRef,
    resize: resizeTextArea,
    focus: focusTextarea,
    setExpanded,
    isExpanded: textareaIsExpanded,
    customHeight,
    setCustomHeight
  } = useTextareaResize({ maxHeight: 500, minHeight: 30 })
  const { sendMessageShortcut, apiServer } = useSettings()

  const { t } = useTranslation()

  const [reasoningEffort, setReasoningEffort] = useState<AgentReasoningEffort>(
    initialReasoningEffort ?? AGENT_DEFAULT_REASONING_EFFORT
  )
  const [deepResearchEnabled, setDeepResearchEnabled] = useState(initialDeepResearchEnabled)
  const deepResearchCacheKey = getAgentSessionDeepResearchCacheKey(agentId, sessionId)
  const handleReasoningEffortChange = useCallback(
    (option: ThinkingOption) => {
      const normalizedOption = normalizeAgentReasoningEffort(option)
      setReasoningEffort(normalizedOption)
      onReasoningEffortChange(normalizedOption)
    },
    [onReasoningEffortChange]
  )
  const handleDeepResearchChange = useCallback(
    (enabled: boolean) => {
      setDeepResearchEnabled(enabled)
      if (enabled) {
        CacheService.set(deepResearchCacheKey, true, DRAFT_CACHE_TTL)
      } else {
        CacheService.remove(deepResearchCacheKey)
      }
    },
    [deepResearchCacheKey]
  )

  const { files } = useInputbarToolsState()
  const { setIsExpanded, setFiles } = useInputbarToolsDispatch()
  const { setCouldAddImageFile } = useInputbarToolsInternalDispatch()

  const dispatch = useAppDispatch()
  const sessionTopicId = buildAgentSessionTopicId(sessionId)
  const topicMessages = useAppSelector((state) => selectMessagesForTopic(state, sessionTopicId))
  const loading = useAppSelector((state) => selectNewTopicLoading(state, sessionTopicId))
  const modelPolicy = useAppSelector((state) => state.llm.modelPolicy?.policy)
  const enableDeveloperMode = useAppSelector((state) => state.settings.enableDeveloperMode)

  // Calculate vision and image generation support
  const isVisionAssistant = useMemo(() => (assistant.model ? isVisionModel(assistant.model) : false), [assistant.model])
  const isGenerateImageAssistant = useMemo(
    () => (assistant.model ? isGenerateImageModel(assistant.model) : false),
    [assistant.model]
  )

  // Agent sessions don't support model mentions yet, so we only check the assistant's model
  const canAddImageFile = useMemo(() => {
    return isVisionAssistant || isGenerateImageAssistant
  }, [isVisionAssistant, isGenerateImageAssistant])

  const canAddTextFile = useMemo(() => {
    return isVisionAssistant || (!isVisionAssistant && !isGenerateImageAssistant)
  }, [isVisionAssistant, isGenerateImageAssistant])

  // Update the couldAddImageFile state when the model changes
  useEffect(() => {
    setCouldAddImageFile(canAddImageFile)
  }, [canAddImageFile, setCouldAddImageFile])

  const syncExpandedState = useCallback(
    (expanded: boolean) => {
      setExpanded(expanded)
      setIsExpanded(expanded)
    },
    [setExpanded, setIsExpanded]
  )
  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !textareaIsExpanded
      syncExpandedState(target)
      focusTextarea()
    },
    [focusTextarea, syncExpandedState, textareaIsExpanded]
  )

  // Update actionsRef for InputbarTools
  useEffect(() => {
    actionsRef.current = {
      resizeTextArea,
      onTextChange: setText,
      toggleExpanded: handleToggleExpanded
    }
  }, [resizeTextArea, setText, actionsRef, handleToggleExpanded])

  const sendDisabled = (inputEmpty && files.length === 0) || !apiServer.enabled

  const streamingAskIds = useMemo(() => {
    if (!topicMessages) {
      return []
    }

    const askIdSet = new Set<string>()
    for (const message of topicMessages) {
      if (!message) continue
      if (message.status === 'processing' || message.status === 'pending') {
        if (message.askId) {
          askIdSet.add(message.askId)
        } else if (message.id) {
          askIdSet.add(message.id)
        }
      }
    }

    return Array.from(askIdSet)
  }, [topicMessages])

  const canAbort = loading && streamingAskIds.length > 0

  const abortAgentSession = useCallback(async () => {
    if (!streamingAskIds.length) {
      logger.debug('No active agent session streams to abort', { sessionTopicId })
      return
    }

    logger.info('Aborting agent session message generation', {
      sessionTopicId,
      askIds: streamingAskIds
    })

    for (const askId of streamingAskIds) {
      window.keyv.set(`agent-session-interrupted-${askId}`, Date.now())
      abortCompletion(askId)
    }

    window.toast.info(t('new_assistant.stopped'))
    void pauseTrace(sessionTopicId)
    dispatch(newMessagesActions.setTopicLoading({ topicId: sessionTopicId, loading: false }))
  }, [dispatch, sessionTopicId, streamingAskIds, t])

  const sendMessage = useCallback(async () => {
    if (sendDisabled) {
      return
    }

    // The session repair runs asynchronously after the current Provider model
    // list is loaded. Keep a final guard here so a stale or empty model can
    // never be submitted while that repair is still in progress.
    if (
      !assistant.model ||
      !isAssistantModelAllowed(
        {
          id: `${assistant.model.provider}:${assistant.model.id}`,
          provider_model_id: assistant.model.id,
          name: assistant.model.name
        },
        enableDeveloperMode,
        modelPolicy
      )
    ) {
      window.toast.warning(
        t('agent.modelPolicy.noFallback', '当前会话没有可用模型，请先配置模型或等待系统完成模型切换。')
      )
      return
    }

    logger.info('Starting to send message')

    try {
      const userMessageId = uuid()

      // Agent sessions still use the Agent workspace as the source of truth, but
      // attachments must be persisted as message blocks first. This lets the
      // request layer copy them into the workspace and extract Office/PDF text.
      const uploadedFiles = files.length > 0 ? await FileManager.uploadFiles(files) : []
      let messageText = text
      if (uploadedFiles.length > 0) {
        const filePaths = uploadedFiles.map((file) => file.path).join('\n')
        messageText = text ? `${text}\n\nAttached files:\n${filePaths}` : `Attached files:\n${filePaths}`
      }

      const mainBlock = createMainTextBlock(userMessageId, messageText, {
        status: MessageBlockStatus.SUCCESS
      })
      const attachmentBlocks: MessageBlock[] = uploadedFiles.map((file) =>
        file.type === FILE_TYPE.IMAGE
          ? createImageBlock(userMessageId, {
              file,
              status: MessageBlockStatus.SUCCESS
            })
          : createFileBlock(userMessageId, file, {
              status: MessageBlockStatus.SUCCESS
            })
      )
      const userMessageBlocks: MessageBlock[] = [mainBlock, ...attachmentBlocks]

      // Calculate token usage for the user message
      const usage = await estimateUserPromptUsage({ content: text })
      const now = new Date().toISOString()
      const resumableDeepResearchTask = findResumableDeepResearchTask(topicMessages)
      const deepResearchAction = deepResearchEnabled
        ? shouldStartDeepResearchImmediately(text)
          ? 'start'
          : 'plan'
        : resumableDeepResearchTask
          ? classifyDeepResearchFollowUp(text)
          : undefined
      const deepResearchTask = deepResearchAction
        ? {
            taskId: deepResearchEnabled ? userMessageId : resumableDeepResearchTask!.taskId,
            version: 1 as const,
            requestedAt: deepResearchEnabled ? now : resumableDeepResearchTask!.requestedAt,
            action: deepResearchAction,
            status: deepResearchAction === 'start' ? ('researching' as const) : ('planning' as const),
            reasoningEffort: DEEP_RESEARCH_REASONING_EFFORT,
            updatedAt: now
          }
        : undefined

      const userMessage: Message = createMessage('user', sessionTopicId, agentId, {
        id: userMessageId,
        blocks: userMessageBlocks.map((block) => block?.id),
        model: assistant.model,
        modelId: assistant.model?.id,
        ...(deepResearchTask
          ? {
              providerMetadata: {
                deepResearch: deepResearchTask
              }
            }
          : {}),
        usage
      })

      const requestReasoningEffort = deepResearchTask ? DEEP_RESEARCH_REASONING_EFFORT : reasoningEffort
      const thinkingParams = assistant.model
        ? {
            ...getAnthropicReasoningParams(
              { ...assistant, settings: { ...assistant.settings, reasoning_effort: requestReasoningEffort } },
              assistant.model
            ),
            effort: toAgentEffort(requestReasoningEffort)
          }
        : {}

      void dispatch(
        dispatchSendMessage(userMessage, userMessageBlocks, assistant, sessionTopicId, {
          agentId,
          sessionId,
          deepResearch: deepResearchEnabled,
          ...(deepResearchTask
            ? {
                deepResearchTask: {
                  task_id: deepResearchTask.taskId,
                  action: deepResearchTask.action
                }
              }
            : {}),
          ...thinkingParams
        })
      )

      // Emit event to trigger scroll to bottom in AgentSessionMessages
      void EventEmitter.emit(EVENT_NAMES.SEND_MESSAGE, { topicId: sessionTopicId })

      // Clear text and files after successful send (draft is cleared automatically via onChange)
      setText('')
      setFiles([])
      setDeepResearchEnabled(false)
      CacheService.remove(deepResearchCacheKey)
      // Restore focus to textarea after sending to maintain IME state (fcitx5 issue)
      focusTextarea()
    } catch (error) {
      logger.warn('Failed to send message:', error as Error)
    }
  }, [
    sendDisabled,
    agentId,
    dispatch,
    assistant,
    enableDeveloperMode,
    modelPolicy,
    sessionId,
    sessionTopicId,
    setText,
    setFiles,
    text,
    files,
    focusTextarea,
    reasoningEffort,
    deepResearchEnabled,
    deepResearchCacheKey,
    topicMessages,
    t
  ])

  useEffect(() => {
    if (!document.querySelector('.topview-fullscreen-container')) {
      focusTextarea()
    }
  }, [focusTextarea])

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

  const toolsSession = useMemo(() => {
    if (!sessionData) return undefined
    return {
      ...sessionData,
      reasoningEffort,
      onReasoningEffortChange: handleReasoningEffortChange,
      deepResearchEnabled,
      onDeepResearchChange: handleDeepResearchChange
    }
  }, [deepResearchEnabled, handleDeepResearchChange, handleReasoningEffortChange, sessionData, reasoningEffort])
  const sessionToolOrderOverride = useMemo<ToolOrderConfig>(
    () => ({
      visible: ['permission_mode', 'thinking', 'deep_research', 'session_more'],
      hidden: ['create_session', 'attachment', 'resource_panel', 'toggle_expand']
    }),
    []
  )

  const leftToolbar = useMemo(
    () => (
      <ToolbarGroup>
        {config.showTools && (
          <InputbarTools
            scope={scope}
            assistant={assistant}
            model={assistant.model}
            session={toolsSession}
            toolOrderOverride={sessionToolOrderOverride}
          />
        )}
      </ToolbarGroup>
    ),
    [config.showTools, scope, assistant, sessionToolOrderOverride, toolsSession]
  )
  const placeholderText = useMemo(() => {
    if (isHero) {
      return t('agent.input.hero_placeholder', '比如：帮我搜索资料、总结重点，再整理成结果给我')
    }
    return t('agent.input.placeholder', {
      key: getSendMessageShortcutLabel(sendMessageShortcut)
    })
  }, [isHero, sendMessageShortcut, t])

  return (
    <InputbarCore
      scope={TopicType.Session}
      text={text}
      onTextChange={setText}
      textareaRef={textareaRef}
      height={customHeight}
      onHeightChange={setCustomHeight}
      resizeTextArea={resizeTextArea}
      focusTextarea={focusTextarea}
      placeholder={placeholderText}
      supportedExts={supportedExts}
      onPause={abortAgentSession}
      isLoading={canAbort}
      handleSendMessage={sendMessage}
      leftToolbar={leftToolbar}
      pinnedContent={
        isHero ? undefined : (
          <>
            <ScrollToBottomButton conversationKey={sessionId} />
          </>
        )
      }
      forceEnableQuickPanelTriggers
      enableRootMenuTrigger={false}
      layoutMaxWidth={isHero ? '1040px' : '960px'}
      minimal={isHero}
    />
  )
}

const ToolbarGroup = styled.div`
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 6px;
`

export default AgentSessionInputbar
