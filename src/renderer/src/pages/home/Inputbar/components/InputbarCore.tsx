import { HolderOutlined } from '@ant-design/icons'
import { loggerService } from '@logger'
import type { QuickPanelTriggerInfo } from '@renderer/components/QuickPanel'
import { QuickPanelReservedSymbol, QuickPanelView, useQuickPanel } from '@renderer/components/QuickPanel'
import TranslateButton from '@renderer/components/TranslateButton'
import { useRuntime } from '@renderer/hooks/useRuntime'
import { useSettings } from '@renderer/hooks/useSettings'
import { useTimer } from '@renderer/hooks/useTimer'
import useTranslate from '@renderer/hooks/useTranslate'
import PasteService from '@renderer/services/PasteService'
import { translateText } from '@renderer/services/TranslateService'
import { useAppDispatch } from '@renderer/store'
import { setSearching } from '@renderer/store/runtime'
import type { FileMetadata } from '@renderer/types'
import { classNames } from '@renderer/utils'
import { formatQuotedText } from '@renderer/utils/formats'
import { getSendMessageShortcutLabel, isSendMessageKeyPressed } from '@renderer/utils/input'
import { IpcChannel } from '@shared/IpcChannel'
import TextArea from 'antd/es/input/TextArea'
import type { TextAreaRef } from 'antd/lib/input/TextArea'
import { Languages } from 'lucide-react'
import type { FC } from 'react'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

import NarrowLayout from '../../Messages/NarrowLayout'
import AttachmentPreview from '../AttachmentPreview'
import {
  useInputbarToolsDispatch,
  useInputbarToolsInternalDispatch,
  useInputbarToolsState
} from '../context/InputbarToolsProvider'
import { useFileDragDrop } from '../hooks/useFileDragDrop'
import { usePasteHandler } from '../hooks/usePasteHandler'
import { getInputbarConfig } from '../registry'
import SendMessageButton from '../SendMessageButton'
import type { InputbarScope } from '../types'

const logger = loggerService.withContext('InputbarCore')

export interface InputbarCoreProps {
  scope: InputbarScope
  placeholder?: string

  text: string
  onTextChange: (text: string) => void
  textareaRef: React.RefObject<TextAreaRef | null>
  resizeTextArea: (force?: boolean) => void
  focusTextarea: () => void

  height: number | undefined
  onHeightChange: (height: number) => void

  supportedExts: string[]
  isLoading: boolean

  onPause?: () => void
  handleSendMessage: () => void
  allowSendWhileLoading?: boolean

  // Toolbar sections
  leftToolbar?: React.ReactNode
  rightToolbar?: React.ReactNode

  // Preview sections (attachments, mentions, etc.)
  topContent?: React.ReactNode
  composerTopBar?: React.ReactNode
  statusContent?: React.ReactNode

  // Pinned content that floats above the inputbar (uses absolute positioning)
  pinnedContent?: React.ReactNode

  // Override the user preference for quick panel triggers
  forceEnableQuickPanelTriggers?: boolean
  // Disable only '/' menus, keeping resource mentions and explicit buttons available.
  enableRootMenuTrigger?: boolean
  minimal?: boolean
  sendDisabled?: boolean
}

/**
 * InputbarCore - 核心输入栏组件
 *
 * 提供基础的文本输入、工具栏、拖拽等功能的 UI 框架
 * 业务逻辑通过 props 注入，保持组件纯粹
 *
 * @example
 * ```tsx
 * <InputbarCore
 *   text={text}
 *   onTextChange={(e) => setText(e.target.value)}
 *   textareaRef={textareaRef}
 *   textareaHeight={customHeight}
 *   onKeyDown={handleKeyDown}
 *   onPaste={handlePaste}
 *   topContent={<AttachmentPreview files={files} />}
 *   leftToolbar={<InputbarTools />}
 *   rightToolbar={<SendMessageButton />}
 *   quickPanel={<QuickPanelView />}
 *   fontSize={14}
 *   enableSpellCheck={true}
 * />
 * ```
 */
export const InputbarCore: FC<InputbarCoreProps> = ({
  scope,
  placeholder,
  text,
  onTextChange,
  textareaRef,
  resizeTextArea,
  focusTextarea,
  height,
  onHeightChange,
  supportedExts,
  isLoading,
  onPause,
  handleSendMessage,
  allowSendWhileLoading = false,
  leftToolbar,
  rightToolbar,
  topContent,
  composerTopBar,
  statusContent,
  pinnedContent,
  forceEnableQuickPanelTriggers,
  enableRootMenuTrigger = true,
  minimal = false,
  sendDisabled = false
}) => {
  const config = useMemo(() => getInputbarConfig(scope), [scope])
  const { files, isExpanded } = useInputbarToolsState()
  const { setFiles, setIsExpanded, toolsRegistry, triggers } = useInputbarToolsDispatch()
  const { setExtensions } = useInputbarToolsInternalDispatch()
  const isEmpty = text.trim().length === 0
  const [inputFocus, setInputFocus] = useState(false)
  const {
    targetLanguage,
    sendMessageShortcut,
    fontSize,
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    autoTranslateWithSpace,
    enableQuickPanelTriggers,
    enableSpellCheck
  } = useSettings()
  const quickPanelTriggersEnabled = forceEnableQuickPanelTriggers ?? enableQuickPanelTriggers

  const { t } = useTranslation()
  const [isTranslating, setIsTranslating] = useState(false)
  const { getLanguageByLangcode } = useTranslate()

  const dispatch = useAppDispatch()
  const [spaceClickCount, setSpaceClickCount] = useState(0)
  const spaceClickTimer = useRef<NodeJS.Timeout | null>(null)
  const { searching } = useRuntime()
  const startDragY = useRef<number>(0)
  const startHeight = useRef<number>(0)
  const { setTimeoutTimer } = useTimer()

  // 全局 QuickPanel Hook (用于控制面板显示状态)
  const quickPanel = useQuickPanel()
  const quickPanelOpen = quickPanel.open

  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])

  const setText = useCallback<React.Dispatch<React.SetStateAction<string>>>(
    (value) => {
      const newText = typeof value === 'function' ? value(textRef.current) : value
      onTextChange(newText)
    },
    [onTextChange]
  )

  const { handlePaste } = usePasteHandler(text, setText, {
    supportedExts,
    setFiles,
    pasteLongTextAsFile,
    pasteLongTextThreshold,
    onResize: resizeTextArea,
    t
  })

  const { handleDragEnter, handleDragLeave, handleDragOver, handleDrop, isDragging } = useFileDragDrop({
    supportedExts,
    setFiles,
    onTextDropped: (droppedText) => setText((prev) => prev + droppedText),
    enabled: config.enableDragDrop,
    t
  })
  // 判断是否有内容：文本不为空或有文件
  const noContent = isEmpty && files.length === 0
  // 发送入口统一禁用条件：空内容、正在生成、全局搜索态
  const isSendDisabled = noContent || (isLoading && !allowSendWhileLoading) || searching || sendDisabled

  useEffect(() => {
    setExtensions(supportedExts)
  }, [setExtensions, supportedExts])

  const handleToggleExpanded = useCallback(
    (nextState?: boolean) => {
      const target = typeof nextState === 'boolean' ? nextState : !isExpanded
      setIsExpanded(target)
      focusTextarea()
    },
    [focusTextarea, setIsExpanded, isExpanded]
  )

  const translate = useCallback(async () => {
    if (isTranslating) {
      return
    }

    try {
      setIsTranslating(true)
      const translatedText = await translateText(text, getLanguageByLangcode(targetLanguage))
      translatedText && setText(translatedText)
      setTimeoutTimer('translate', () => resizeTextArea(), 0)
    } catch (error) {
      logger.warn('Translation failed:', error as Error)
    } finally {
      setIsTranslating(false)
    }
  }, [getLanguageByLangcode, isTranslating, resizeTextArea, setText, setTimeoutTimer, targetLanguage, text])

  const rootTriggerHandlerRef = useRef<((payload?: unknown) => void) | undefined>(undefined)

  useEffect(() => {
    rootTriggerHandlerRef.current = (payload) => {
      const menuItems = triggers.getRootMenu()

      if (text.trim()) {
        menuItems.push({
          label: t('translate.title'),
          description: t('translate.menu.description'),
          icon: <Languages size={16} />,
          action: () => translate()
        })
      }

      if (!menuItems.length) {
        return
      }

      const triggerInfo = (payload ?? {}) as QuickPanelTriggerInfo
      quickPanelOpen({
        title: t('settings.quickPanel.title'),
        list: menuItems,
        symbol: QuickPanelReservedSymbol.Root,
        triggerInfo
      })
    }
  }, [triggers, quickPanelOpen, t, text, translate])

  useEffect(() => {
    if (!config.enableQuickPanel || !enableRootMenuTrigger) {
      return
    }

    const disposeRootTrigger = toolsRegistry.registerTrigger(
      'inputbar-root',
      QuickPanelReservedSymbol.Root,
      (payload) => rootTriggerHandlerRef.current?.(payload)
    )

    return () => {
      disposeRootTrigger()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enableQuickPanel, enableRootMenuTrigger])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Tab' && inputFocus) {
        event.preventDefault()
        const textArea = textareaRef.current?.resizableTextArea?.textArea
        if (!textArea) {
          return
        }
        const cursorPosition = textArea.selectionStart
        const selectionLength = textArea.selectionEnd - textArea.selectionStart
        const text = textArea.value

        let match = text.slice(cursorPosition + selectionLength).match(/\$\{[^}]+\}/)
        let startIndex: number

        if (!match) {
          match = text.match(/\$\{[^}]+\}/)
          startIndex = match?.index ?? -1
        } else {
          startIndex = cursorPosition + selectionLength + match.index!
        }

        if (startIndex !== -1) {
          const endIndex = startIndex + match![0].length
          textArea.setSelectionRange(startIndex, endIndex)
          return
        }
      }
      if (autoTranslateWithSpace && event.key === ' ') {
        setSpaceClickCount((prev) => prev + 1)
        if (spaceClickTimer.current) {
          clearTimeout(spaceClickTimer.current)
        }
        spaceClickTimer.current = setTimeout(() => {
          setSpaceClickCount(0)
        }, 200)

        if (spaceClickCount === 2) {
          logger.info('Triple space detected - trigger translation')
          setSpaceClickCount(0)
          void translate()
          return
        }
      }

      if (isExpanded && event.key === 'Escape') {
        event.stopPropagation()
        handleToggleExpanded()
        return
      }

      const isEnterPressed = event.key === 'Enter' && !event.nativeEvent.isComposing
      if (isEnterPressed) {
        if (isSendMessageKeyPressed(event, sendMessageShortcut) && !isSendDisabled) {
          handleSendMessage()
          event.preventDefault()
          return
        }

        if (event.shiftKey) {
          return
        }
      }

      if (event.key === 'Backspace' && text.length === 0 && files.length > 0) {
        setFiles((prev) => prev.slice(0, -1))
        event.preventDefault()
      }
    },
    [
      inputFocus,
      autoTranslateWithSpace,
      isExpanded,
      text.length,
      files.length,
      textareaRef,
      spaceClickCount,
      translate,
      handleToggleExpanded,
      sendMessageShortcut,
      isSendDisabled,
      handleSendMessage,
      setFiles
    ]
  )

  const handleTextareaChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newText = e.target.value
      setText(newText)

      const isDeletion = newText.length < textRef.current.length

      const textArea = textareaRef.current?.resizableTextArea?.textArea
      const cursorPosition = textArea?.selectionStart ?? newText.length
      const lastSymbol = newText[cursorPosition - 1]
      const previousChar = newText[cursorPosition - 2]
      const isCursorAtTextStart = cursorPosition <= 1
      const hasValidTriggerBoundary = previousChar === ' ' || isCursorAtTextStart

      const openRootPanelAt = (position: number) => {
        triggers.emit(QuickPanelReservedSymbol.Root, {
          type: 'input',
          position,
          originalText: newText
        })
      }

      const openMentionPanelAt = (position: number) => {
        triggers.emit(QuickPanelReservedSymbol.MentionModels, {
          type: 'input',
          position,
          originalText: newText
        })
      }

      if (quickPanelTriggersEnabled && config.enableQuickPanel) {
        const hasRootMenuItems = enableRootMenuTrigger && triggers.getRootMenu().length > 0
        const textBeforeCursor = newText.slice(0, cursorPosition)
        const lastRootIndex = textBeforeCursor.lastIndexOf(QuickPanelReservedSymbol.Root)
        const lastMentionIndex = textBeforeCursor.lastIndexOf(QuickPanelReservedSymbol.MentionModels)
        const lastTriggerIndex = Math.max(lastRootIndex, lastMentionIndex)

        const allowResumeSearch =
          !quickPanel.isVisible &&
          (quickPanel.lastCloseAction === undefined || quickPanel.lastCloseAction === 'outsideclick')

        if (!quickPanel.isVisible && lastTriggerIndex !== -1 && cursorPosition > lastTriggerIndex) {
          const triggerChar = newText[lastTriggerIndex]
          const boundaryChar = newText[lastTriggerIndex - 1] ?? ''
          const hasBoundary = lastTriggerIndex === 0 || /\s/.test(boundaryChar)
          const searchSegment = newText.slice(lastTriggerIndex + 1, cursorPosition)
          const hasSearchContent = searchSegment.trim().length > 0

          if (hasBoundary && (!hasSearchContent || isDeletion || allowResumeSearch)) {
            if (triggerChar === QuickPanelReservedSymbol.Root && hasRootMenuItems) {
              openRootPanelAt(lastTriggerIndex)
            } else if (triggerChar === QuickPanelReservedSymbol.MentionModels) {
              openMentionPanelAt(lastTriggerIndex)
            }
          }
        }

        if (lastSymbol === QuickPanelReservedSymbol.Root && hasValidTriggerBoundary && hasRootMenuItems) {
          if (quickPanel.isVisible && quickPanel.symbol !== QuickPanelReservedSymbol.Root) {
            quickPanel.close('switch-symbol')
          }
          if (!quickPanel.isVisible || quickPanel.symbol !== QuickPanelReservedSymbol.Root) {
            openRootPanelAt(cursorPosition - 1)
          }
        }

        if (lastSymbol === QuickPanelReservedSymbol.MentionModels && hasValidTriggerBoundary) {
          if (quickPanel.isVisible && quickPanel.symbol !== QuickPanelReservedSymbol.MentionModels) {
            quickPanel.close('switch-symbol')
          }
          if (!quickPanel.isVisible || quickPanel.symbol !== QuickPanelReservedSymbol.MentionModels) {
            openMentionPanelAt(cursorPosition - 1)
          }
        }
      }

      if (quickPanel.isVisible && quickPanel.triggerInfo?.type === 'input') {
        const activeSymbol = quickPanel.symbol as QuickPanelReservedSymbol
        const triggerPosition = quickPanel.triggerInfo.position ?? -1
        const isTrackedSymbol =
          activeSymbol === QuickPanelReservedSymbol.Root || activeSymbol === QuickPanelReservedSymbol.MentionModels

        if (isTrackedSymbol && triggerPosition >= 0) {
          // Check if cursor is before the trigger position (user deleted the symbol)
          if (cursorPosition <= triggerPosition) {
            quickPanel.close('delete-symbol')
          } else {
            // Check if the trigger symbol still exists at the expected position
            const triggerChar = newText[triggerPosition]
            if (triggerChar !== activeSymbol) {
              quickPanel.close('delete-symbol')
            }
          }
        }
      }
    },
    [
      setText,
      textareaRef,
      quickPanelTriggersEnabled,
      config.enableQuickPanel,
      enableRootMenuTrigger,
      quickPanel,
      triggers
    ]
  )

  const onTranslated = useCallback(
    (translatedText: string) => {
      setText(translatedText)
      setTimeoutTimer('onTranslated', () => resizeTextArea(), 0)
    },
    [resizeTextArea, setText, setTimeoutTimer]
  )

  const appendTxtContentToInput = useCallback(
    async (file: FileMetadata, event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault()
      event.stopPropagation()

      try {
        const targetPath = file.path
        const content = await window.api.file.readExternal(targetPath, true)
        try {
          await navigator.clipboard.writeText(content)
        } catch (clipboardError) {
          logger.warn('Failed to copy txt attachment content to clipboard:', clipboardError as Error)
        }

        setText((prev) => {
          if (!prev) {
            return content
          }

          const needsSeparator = !prev.endsWith('\n')
          return needsSeparator ? `${prev}\n${content}` : prev + content
        })

        setFiles((prev) => prev.filter((currentFile) => currentFile.id !== file.id))

        setTimeoutTimer(
          'appendTxtAttachment',
          () => {
            const textArea = textareaRef.current?.resizableTextArea?.textArea
            if (textArea) {
              const end = textArea.value.length
              focusTextarea()
              textArea.setSelectionRange(end, end)
            }

            resizeTextArea(true)
          },
          0
        )
      } catch (error) {
        logger.warn('Failed to append txt attachment content:', error as Error)
        window.toast.error(t('chat.input.file_error'))
      }
    },
    [focusTextarea, resizeTextArea, setFiles, setText, setTimeoutTimer, t, textareaRef]
  )

  const handleFocus = useCallback(() => {
    setInputFocus(true)
    dispatch(setSearching(false))
    // Don't close panel in multiple selection mode, or if triggered by input
    if (quickPanel.isVisible && quickPanel.triggerInfo?.type !== 'input' && !quickPanel.multiple) {
      quickPanel.close()
    }
    PasteService.setLastFocusedComponent('inputbar')
  }, [dispatch, quickPanel])

  const handleDragStart = useCallback(
    (event: React.MouseEvent) => {
      if (!config.enableDragDrop) {
        return
      }

      startDragY.current = event.clientY
      startHeight.current = textareaRef.current?.resizableTextArea?.textArea?.offsetHeight || 0

      const handleMouseMove = (e: MouseEvent) => {
        const deltaY = startDragY.current - e.clientY
        const newHeight = Math.max(40, Math.min(500, startHeight.current + deltaY))
        onHeightChange(newHeight)
      }

      const handleMouseUp = () => {
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [config.enableDragDrop, onHeightChange, textareaRef]
  )

  const onQuote = useCallback(
    (quoted: string) => {
      const formatted = formatQuotedText(quoted)
      setText((prevText) => {
        const next = prevText ? `${prevText}\n${formatted}\n` : `${formatted}\n`
        setTimeoutTimer('onQuote', () => resizeTextArea(), 0)
        return next
      })
      focusTextarea()
    },
    [focusTextarea, resizeTextArea, setText, setTimeoutTimer]
  )

  useEffect(() => {
    const quoteListener = window.electron?.ipcRenderer.on(IpcChannel.App_QuoteToMain, (_, selectedText: string) =>
      onQuote(selectedText)
    )
    return () => {
      quoteListener?.()
    }
  }, [onQuote])

  useEffect(() => {
    const timerId = requestAnimationFrame(() => resizeTextArea())
    return () => cancelAnimationFrame(timerId)
  }, [resizeTextArea])

  useEffect(() => {
    const onFocus = () => {
      if (document.activeElement?.closest('.ant-modal')) {
        return
      }

      const lastFocusedComponent = PasteService.getLastFocusedComponent()
      if (!lastFocusedComponent || lastFocusedComponent === 'inputbar') {
        focusTextarea()
      }
    }

    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [focusTextarea])

  useEffect(() => {
    PasteService.init()

    PasteService.registerHandler('inputbar', handlePaste)

    return () => {
      PasteService.unregisterHandler('inputbar')
    }
  }, [handlePaste])

  useEffect(() => {
    return () => {
      if (spaceClickTimer.current) {
        clearTimeout(spaceClickTimer.current)
      }
    }
  }, [])

  const quickPanelElement = config.enableQuickPanel ? <QuickPanelView setInputText={setText} /> : null
  const shortcut = getSendMessageShortcutLabel(sendMessageShortcut).replace(' + ', '+').replace('Enter', '↵')
  const showStop = isLoading && Boolean(onPause)

  return (
    <NarrowLayout reading contentMaxWidth="calc(var(--zen-composer-width) + 64px)" className="shrink-0">
      {statusContent}
      <Container
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        className={classNames('inputbar')}>
        {composerTopBar && <ComposerTopBar $centered={minimal}>{composerTopBar}</ComposerTopBar>}
        {pinnedContent}
        {quickPanelElement}
        <InputBarContainer
          id="inputbar"
          className={classNames(
            'inputbar-container',
            isDragging && 'file-dragging',
            isExpanded && 'expanded',
            minimal && 'minimal',
            (text.length > 0 || files.length > 0) && 'has-content'
          )}>
          {!minimal && (
            <DragHandle onMouseDown={handleDragStart}>
              <HolderOutlined style={{ fontSize: 12 }} />
            </DragHandle>
          )}
          {files.length > 0 && (
            <AttachmentPreview files={files} setFiles={setFiles} onAttachmentContextMenu={appendTxtContentToInput} />
          )}
          {topContent}

          <Textarea
            ref={textareaRef}
            value={text}
            onChange={handleTextareaChange}
            onKeyDown={handleKeyDown}
            onPaste={(e) => handlePaste(e.nativeEvent)}
            onFocus={handleFocus}
            onBlur={() => setInputFocus(false)}
            placeholder={isTranslating ? t('chat.input.translating') : placeholder}
            autoFocus
            variant="borderless"
            spellCheck={enableSpellCheck}
            rows={minimal ? 3 : 2}
            autoSize={height ? false : { minRows: minimal ? 3 : 2, maxRows: 10 }}
            style={{
              fontSize:
                fontSize === 12 ? 'var(--zen-reading-size)' : `calc(var(--zen-reading-size) + ${fontSize - 12}px)`,
              height
            }}
            disabled={isTranslating || searching}
            onClick={() => {
              searching && dispatch(setSearching(false))
              quickPanel.close()
            }}
          />

          <BottomBar>
            <LeftSection>{leftToolbar}</LeftSection>
            <RightSection>
              {rightToolbar}
              <TranslateButton
                text={text}
                disabled={isSendDisabled}
                onTranslated={onTranslated}
                isLoading={isTranslating}
              />
              {(!showStop || allowSendWhileLoading) && (
                <>
                  <ShortcutHint aria-hidden="true">{shortcut}</ShortcutHint>
                  <SendMessageButton sendMessage={handleSendMessage} disabled={isSendDisabled} />
                </>
              )}
              {showStop && onPause && <SendMessageButton stop sendMessage={onPause} />}
            </RightSection>
          </BottomBar>
        </InputBarContainer>
      </Container>
    </NarrowLayout>
  )
}

// Styled Components
const DragHandle = styled.div`
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: row-resize;
  color: var(--color-icon);
  opacity: 0;
  transition: opacity 0.2s;
  z-index: 1;

  &:hover {
    opacity: 1;
  }

  .anticon {
    transform: rotate(90deg);
    font-size: 14px;
  }
`

const Container = styled.div`
  display: flex;
  flex-direction: column;
  position: relative;
  z-index: 2;
  margin-top: 0;
  margin-bottom: 16px;
`

const ComposerTopBar = styled.div<{ $centered?: boolean }>`
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: ${({ $centered }) => ($centered ? 'center' : 'flex-start')};
  margin-bottom: ${({ $centered }) => ($centered ? '14px' : '8px')};
`

const InputBarContainer = styled.div`
  position: relative;
  background: var(--zen-glass-composer);
  backdrop-filter: blur(36px) saturate(145%);
  -webkit-backdrop-filter: blur(36px) saturate(145%);
  border: 0;
  border-radius: var(--zen-radius-xl);
  box-shadow: var(--zen-composer-ring);
  transition: box-shadow 220ms cubic-bezier(0.22, 1, 0.36, 1);

  /* GPU-composited opacity backing: thickens frosted glass only when typing, zero re-blur overhead */
  &::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: var(--zen-glass-composer-solid);
    opacity: 0;
    pointer-events: none;
    transition: opacity 180ms ease;
    z-index: 0;
  }

  &.has-content::before {
    opacity: 1;
  }

  > :not(${DragHandle}) {
    position: relative;
    z-index: 1;
  }

  &:focus-within {
    box-shadow: var(--zen-composer-ring-focus);
  }

  &.file-dragging {
    outline: 2px dashed var(--zen-accent);
    outline-offset: 2px;
  }

  &.expanded textarea {
    max-height: 70vh !important;
  }

  &.minimal textarea.ant-input {
    min-height: 88px !important;
    padding: 18px 22px 10px;
  }
`

const Textarea = styled(TextArea)`
  &.ant-input {
    display: block;
    width: 100%;
    min-height: 70px !important;
    max-height: 240px !important;
    padding: 16px 20px 8px;
    color: var(--zen-text-1);
    font-family: var(--font-family);
    line-height: var(--zen-reading-line-height);
    resize: none !important;
    overflow-y: auto !important;
    background: transparent;
    border-radius: var(--zen-radius-xl) var(--zen-radius-xl) 0 0;
    transition: none !important;
  }

  &.ant-input::placeholder {
    color: var(--zen-text-3);
  }
`

const BottomBar = styled.div`
  display: flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 4px 14px 10px 14px;
  gap: 12px;

  .ant-btn-text {
    color: var(--zen-text-2);
  }

  .ant-btn-text:hover {
    color: var(--zen-text-1);
    background: var(--zen-bg-hover);
  }
`

const LeftSection = styled.div`
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;

  &::-webkit-scrollbar {
    display: none;
  }
`

const RightSection = styled.div`
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex-shrink: 0;
`

const ShortcutHint = styled.kbd`
  color: var(--zen-text-3);
  font-family: var(--code-font-family);
  font-size: 11px;
  white-space: nowrap;
`
