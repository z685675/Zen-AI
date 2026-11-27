import ActionIconButton from '@renderer/components/Buttons/ActionIconButton'
import type { CodeEditorHandles } from '@renderer/components/CodeEditor'
import CodeEditor from '@renderer/components/CodeEditor'
import { HSpaceBetweenStack } from '@renderer/components/Layout'
import RichEditor from '@renderer/components/RichEditor'
import type { RichEditorRef } from '@renderer/components/RichEditor/types'
import Selector from '@renderer/components/Selector'
import { useNotesSettings } from '@renderer/hooks/useNotesSettings'
import { useSettings } from '@renderer/hooks/useSettings'
import { useAppDispatch } from '@renderer/store'
import { setEnableSpellCheck } from '@renderer/store/settings'
import type { EditorView } from '@renderer/types'
import { Empty, Tooltip } from 'antd'
import { FilePlus2, FolderPlus, SpellCheck } from 'lucide-react'
import type { FC, RefObject } from 'react'
import { memo, useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import styled from 'styled-components'

interface NotesEditorProps {
  activeNodeId?: string
  currentContent: string
  tokenCount: number
  editorRef: RefObject<RichEditorRef | null>
  codeEditorRef: RefObject<CodeEditorHandles | null>
  onMarkdownChange: (content: string) => void
  onCreateNote?: () => void
  onCreateFolder?: () => void
}

const NotesEditor: FC<NotesEditorProps> = memo(
  ({
    activeNodeId,
    currentContent,
    tokenCount,
    onMarkdownChange,
    onCreateNote,
    onCreateFolder,
    editorRef,
    codeEditorRef
  }) => {
    const { t } = useTranslation()
    const dispatch = useAppDispatch()
    const { settings } = useNotesSettings()
    const { enableSpellCheck } = useSettings()
    const currentViewMode = useMemo(() => {
      if (settings.defaultViewMode === 'edit') {
        return settings.defaultEditMode
      } else {
        return settings.defaultViewMode
      }
    }, [settings.defaultEditMode, settings.defaultViewMode])
    const [tmpViewMode, setTmpViewMode] = useState(currentViewMode)

    const handleCommandsReady = useCallback((commandAPI: Pick<RichEditorRef, 'unregisterCommand'>) => {
      const disabledCommands = ['image', 'inlineMath']
      disabledCommands.forEach((commandId) => {
        commandAPI.unregisterCommand(commandId)
      })
    }, [])

    if (!activeNodeId) {
      return (
        <EmptyContainer>
          <Empty description={t('notes.empty')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
          {(onCreateNote || onCreateFolder) && (
            <EmptyActions>
              {onCreateNote && (
                <EmptyActionButton type="button" $primary onClick={onCreateNote}>
                  <FilePlus2 size={15} />
                  <span>{t('notes.new_note')}</span>
                </EmptyActionButton>
              )}
              {onCreateFolder && (
                <EmptyActionButton type="button" onClick={onCreateFolder}>
                  <FolderPlus size={15} />
                  <span>{t('notes.new_folder')}</span>
                </EmptyActionButton>
              )}
            </EmptyActions>
          )}
        </EmptyContainer>
      )
    }

    return (
      <>
        <RichEditorContainer>
          {tmpViewMode === 'source' ? (
            <SourceEditorWrapper isFullWidth={settings.isFullWidth} fontSize={settings.fontSize}>
              <CodeEditor
                ref={codeEditorRef}
                value={currentContent}
                language="markdown"
                onChange={onMarkdownChange}
                height="100%"
                expanded={false}
                style={{
                  height: '100%',
                  fontSize: `${settings.fontSize}px`
                }}
              />
            </SourceEditorWrapper>
          ) : (
            <RichEditor
              key={`${activeNodeId}-${tmpViewMode === 'preview' ? 'preview' : 'read'}`}
              ref={editorRef}
              initialContent={currentContent}
              onMarkdownChange={tmpViewMode === 'preview' ? onMarkdownChange : undefined}
              onCommandsReady={handleCommandsReady}
              showToolbar={tmpViewMode === 'preview'}
              editable={tmpViewMode === 'preview'}
              showTableOfContents={settings.showTableOfContents}
              enableContentSearch
              className="notes-rich-editor"
              isFullWidth={settings.isFullWidth}
              fontFamily={settings.fontFamily}
              fontSize={settings.fontSize}
              enableSpellCheck={enableSpellCheck}
            />
          )}
        </RichEditorContainer>
        <BottomPanel>
          <HSpaceBetweenStack width="100%" justifyContent="space-between" alignItems="center">
            <TokenCount>
              {t('notes.characters')}: {tokenCount}
            </TokenCount>
            <div
              style={{
                fontSize: '12px',
                color: 'var(--color-text-3)',
                display: 'flex',
                alignItems: 'center',
                gap: 12
              }}>
              {tmpViewMode === 'preview' && (
                <Tooltip placement="top" title={t('notes.spell_check_tooltip')} mouseLeaveDelay={0} arrow>
                  <ActionIconButton
                    active={enableSpellCheck}
                    onClick={() => {
                      const newValue = !enableSpellCheck
                      dispatch(setEnableSpellCheck(newValue))
                      void window.api.setEnableSpellCheck(newValue)
                    }}>
                    <SpellCheck size={18} />
                  </ActionIconButton>
                </Tooltip>
              )}
              <Selector
                value={tmpViewMode as EditorView}
                onChange={(value: EditorView) => setTmpViewMode(value)}
                options={[
                  { label: t('notes.settings.editor.edit_mode.preview_mode'), value: 'preview' },
                  { label: t('notes.settings.editor.edit_mode.source_mode'), value: 'source' },
                  { label: t('notes.settings.editor.view_mode.read_mode'), value: 'read' }
                ]}
              />
            </div>
          </HSpaceBetweenStack>
        </BottomPanel>
      </>
    )
  }
)

NotesEditor.displayName = 'NotesEditor'

const EmptyContainer = styled.div`
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  gap: 16px;
  width: 100%;
  height: 100%;
  flex: 1;
`

const EmptyActions = styled.div`
  display: flex;
  align-items: center;
  gap: 10px;
`

const EmptyActionButton = styled.button<{ $primary?: boolean }>`
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 36px;
  padding: 0 16px;
  border: 0;
  border-radius: var(--zen-radius-pill);
  background: ${({ $primary }) => ($primary ? 'var(--zen-glass-pill-hover)' : 'var(--zen-glass-pill)')};
  backdrop-filter: blur(24px) saturate(165%);
  box-shadow: ${({ $primary }) => ($primary ? 'var(--zen-shadow-pill-hover)' : 'var(--zen-shadow-pill)')};
  color: ${({ $primary }) => ($primary ? 'var(--zen-text-1)' : 'var(--zen-text-2)')};
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition:
    background 160ms ease,
    color 150ms ease,
    box-shadow 180ms ease,
    transform 150ms ease;

  &:hover {
    background: var(--zen-glass-pill-hover);
    box-shadow: var(--zen-shadow-pill-hover);
    color: var(--zen-text-1);
    transform: translateY(-0.5px);
  }
`

const RichEditorContainer = styled.div`
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  transition: opacity 0.2s ease-in-out;

  .notes-rich-editor {
    border: none;
    border-radius: 0;
    flex: 1;
    background: transparent;

    .rich-editor-wrapper {
      height: 100%;
      display: flex;
      flex-direction: column;
      transition: all 0.15s ease-in-out;
    }

    .rich-editor-content {
      flex: 1;
      overflow: auto;
      padding: 16px;
      transition: all 0.15s ease-in-out;
    }

    /* 预览模式下的样式优化 */
    &[data-preview='true'] {
      .ProseMirror {
        cursor: default !important;
      }
    }
  }
`

const SourceEditorWrapper = styled.div<{ isFullWidth: boolean; fontSize: number }>`
  height: 100%;
  width: ${({ isFullWidth }) => (isFullWidth ? '100%' : '60%')};
  margin: ${({ isFullWidth }) => (isFullWidth ? '0' : '0 auto')};

  /* 应用字体大小到CodeEditor */
  .monaco-editor {
    font-size: ${({ fontSize }) => fontSize}px !important;
  }

  /* 确保CodeEditor内部元素也应用字体大小 */
  .monaco-editor .monaco-editor-background,
  .monaco-editor .inputarea.ime-input,
  .monaco-editor .monaco-editor-container,
  .monaco-editor .overflow-guard,
  .monaco-editor .monaco-scrollable-element,
  .monaco-editor .lines-content.monaco-editor-background,
  .monaco-editor .view-line {
    font-size: ${({ fontSize }) => fontSize}px !important;
  }
`

const BottomPanel = styled.div`
  padding: 8px 16px;
  border-top: 0.5px solid var(--color-border);
  background: var(--color-background-soft);
  flex-shrink: 0;
  height: 48px;
  display: flex;
  align-items: center;
`

const TokenCount = styled.div`
  font-size: 12px;
  color: var(--color-text-3);
  user-select: none;
  line-height: 1;
`

export default NotesEditor
