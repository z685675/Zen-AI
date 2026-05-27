import { QuickPanelReservedSymbol } from '@renderer/components/QuickPanel'
import { useResourcePanel } from '@renderer/pages/home/Inputbar/tools/components/useResourcePanel'
import { defineTool, registerTool, TopicType } from '@renderer/pages/home/Inputbar/types'
import { filterSupportedFiles } from '@renderer/utils/file'
import { Popover } from 'antd'
import { ChevronDown, FolderOpen, Lightbulb, Paperclip, Terminal, Zap } from 'lucide-react'
import type React from 'react'
import { useCallback, useMemo, useState } from 'react'
import styled from 'styled-components'

const sessionMoreTool = defineTool({
  key: 'session_more',
  label: (t) => t('chat.input.more.title', 'More'),
  visibleInScopes: [TopicType.Session],

  dependencies: {
    state: ['files', 'couldAddImageFile', 'extensions'] as const,
    actions: ['onTextChange', 'setFiles'] as const
  },

  render: function SessionMoreRender(context) {
    const { t, session, quickPanel, quickPanelController, state, actions } = context
    const accessiblePaths = session?.accessiblePaths ?? []
    const [selecting, setSelecting] = useState(false)
    const [open, setOpen] = useState(false)

    const { handleOpenQuickPanel: openResourcePanel } = useResourcePanel(
      {
        quickPanel,
        quickPanelController,
        accessiblePaths,
        setText: actions.onTextChange as React.Dispatch<React.SetStateAction<string>>
      },
      'button'
    )

    const runAfterClose = useCallback((action: () => void) => {
      setOpen(false)
      setTimeout(() => {
        action()
      }, 0)
    }, [])

    const openSlashCommands = useCallback(() => {
      const slashCommands = session?.slashCommands || []
      quickPanelController.open({
        title: t('chat.input.slash_commands.title'),
        symbol: QuickPanelReservedSymbol.SlashCommands,
        list:
          slashCommands.length > 0
            ? slashCommands.map((cmd) => ({
                label: cmd.command,
                description: cmd.description || '',
                icon: <Terminal size={16} />,
                filterText: `${cmd.command} ${cmd.description || ''}`,
                action: () => {
                  actions.onTextChange((prev: string) => `${prev}${prev ? ' ' : ''}${cmd.command} `)
                }
              }))
            : [
                {
                  label: t('chat.input.slash_commands.empty', 'No slash commands available'),
                  description: '',
                  icon: <Terminal size={16} />,
                  disabled: true,
                  action: () => {}
                }
              ]
      })
    }, [actions, quickPanelController, session, t])

    const openAttachmentPicker = useCallback(() => {
      const run = async () => {
        if (selecting) {
          return
        }

        const useAllFiles = state.extensions.length > 20
        setSelecting(true)

        try {
          const selectedFiles = await window.api.file.select({
            properties: ['openFile', 'multiSelections'],
            filters: [
              {
                name: 'Files',
                extensions: useAllFiles ? ['*'] : state.extensions.map((extension) => extension.replace('.', ''))
              }
            ]
          })

          if (!selectedFiles) {
            return
          }

          if (!useAllFiles) {
            actions.setFiles([...state.files, ...selectedFiles])
            return
          }

          const supportedFiles = await filterSupportedFiles(selectedFiles, state.extensions)
          if (supportedFiles.length > 0) {
            actions.setFiles([...state.files, ...supportedFiles])
          }

          if (supportedFiles.length !== selectedFiles.length) {
            window.toast.info(
              t('chat.input.file_not_supported_count', {
                count: selectedFiles.length - supportedFiles.length
              })
            )
          }
        } finally {
          setSelecting(false)
        }
      }

      setOpen(false)
      void run()
    }, [actions, selecting, state.extensions, state.files, t])

    const openQuickPhrases = useCallback(() => {
      const quickPhrasesButton = document.querySelector('[data-key="quick_phrases"] button') as HTMLButtonElement | null
      quickPhrasesButton?.click()
    }, [])

    const openThinking = useCallback(() => {
      const thinkingButton = document.querySelector('[data-key="thinking"] button') as HTMLButtonElement | null
      thinkingButton?.click()
    }, [])

    const moreItems = useMemo(
      () => [
        {
          key: 'quick-phrases',
          label: t('settings.quickPhrase.title'),
          description: t('chat.input.more.quick_phrases', 'Insert a commonly used phrase or preset content'),
          icon: <Zap size={16} />,
          onClick: () => runAfterClose(openQuickPhrases)
        },
        {
          key: 'attachment',
          label: t('chat.input.upload.attachment'),
          description: t('chat.input.more.attachment', 'Upload images or documents'),
          icon: <Paperclip size={16} />,
          onClick: openAttachmentPicker
        },
        {
          key: 'thinking',
          label: t('chat.input.thinking.label'),
          description: t('chat.input.more.thinking', 'Adjust the model thinking mode or reasoning depth'),
          icon: <Lightbulb size={16} />,
          onClick: () => runAfterClose(openThinking)
        },
        {
          key: 'slash-commands',
          label: t('chat.input.slash_commands.title'),
          description: t('chat.input.more.slash_commands', 'View quick commands provided by this assistant'),
          icon: <Terminal size={16} />,
          onClick: () => runAfterClose(openSlashCommands)
        },
        {
          key: 'resource-panel',
          label: t('chat.input.resource_panel.title'),
          description: t('chat.input.more.resource_panel', 'Browse files and skills available to this session'),
          icon: <FolderOpen size={16} />,
          disabled: accessiblePaths.length === 0,
          onClick: () => runAfterClose(openResourcePanel)
        }
      ],
      [
        accessiblePaths.length,
        openAttachmentPicker,
        openQuickPhrases,
        openResourcePanel,
        openSlashCommands,
        openThinking,
        runAfterClose,
        t
      ]
    )

    const popoverContent = (
      <MoreMenu>
        {moreItems.map((item) => (
          <MoreOption key={item.key} type="button" disabled={item.disabled} onClick={item.onClick}>
            <MoreOptionIcon>{item.icon}</MoreOptionIcon>
            <MoreOptionBody>
              <MoreOptionTitle>{item.label}</MoreOptionTitle>
              <MoreOptionDescription>{item.description}</MoreOptionDescription>
            </MoreOptionBody>
          </MoreOption>
        ))}
      </MoreMenu>
    )

    return (
      <Popover
        trigger="click"
        placement="bottomLeft"
        open={open}
        onOpenChange={setOpen}
        content={popoverContent}
        arrow={false}
        overlayStyle={{ paddingTop: 8, zIndex: 1400 }}
        destroyOnHidden>
        <MoreButton type="button" aria-label={t('chat.input.more.title', 'More')}>
          <MoreText>{t('chat.input.more.title', 'More')}</MoreText>
          <ChevronDown size={14} />
        </MoreButton>
      </Popover>
    )
  }
})

const MoreButton = styled.button`
  display: inline-flex;
  align-items: center;
  flex-shrink: 0;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background);
  color: var(--color-text);
  font-size: 12px;
  transition:
    border-color 0.18s ease,
    background-color 0.18s ease,
    box-shadow 0.18s ease;

  &:hover {
    background: var(--color-background-soft);
    border-color: var(--color-primary-soft);
    box-shadow: 0 4px 10px rgba(15, 23, 42, 0.06);
  }
`

const MoreText = styled.span`
  white-space: nowrap;
  font-weight: 500;
`

const MoreMenu = styled.div`
  width: 282px;
  padding: 6px;
  border-radius: 18px;
  background: rgba(255, 255, 255, 0.98);
  box-shadow:
    0 18px 40px rgba(15, 23, 42, 0.14),
    0 2px 10px rgba(15, 23, 42, 0.06);
  backdrop-filter: blur(18px);
`

const MoreOption = styled.button`
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 11px;
  padding: 10px 12px;
  border: 0;
  border-radius: 14px;
  background: transparent;
  text-align: left;
  transition:
    background-color 0.18s ease,
    box-shadow 0.18s ease,
    opacity 0.18s ease;

  &:hover:not(:disabled) {
    background: rgba(248, 250, 252, 0.92);
    box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
  }

  &:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }
`

const MoreOptionIcon = styled.span`
  width: 30px;
  height: 30px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 1px;
  border-radius: 10px;
  background: rgba(248, 250, 252, 0.96);
  box-shadow: inset 0 0 0 1px rgba(15, 23, 42, 0.04);
`

const MoreOptionBody = styled.div`
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
`

const MoreOptionTitle = styled.div`
  font-size: 13px;
  line-height: 1.35;
  font-weight: 600;
  color: var(--color-text);
`

const MoreOptionDescription = styled.div`
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
`

registerTool(sessionMoreTool)

export default sessionMoreTool
