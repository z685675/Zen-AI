import type {
  QuickPanelCloseAction,
  QuickPanelOpenOptions,
  QuickPanelTriggerInfo
} from '@renderer/components/QuickPanel/types'
import { QuickPanelReservedSymbol } from '@renderer/components/QuickPanel/types'
import { TopicType } from '@renderer/types'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { TextAreaRef } from 'antd/lib/input/TextArea'
import type { PropsWithChildren, Ref, TextareaHTMLAttributes } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  type InputbarToolsDispatch,
  InputbarToolsProvider,
  useInputbarToolsDispatch
} from '../../context/InputbarToolsProvider'
import type { InputbarScope } from '../../types'
import { InputbarCore } from '../InputbarCore'

const mocks = vi.hoisted(() => ({
  quickPanel: {
    open: vi.fn<(options: QuickPanelOpenOptions) => void>(),
    close: vi.fn(),
    isVisible: false,
    symbol: '',
    multiple: false,
    lastCloseAction: undefined as QuickPanelCloseAction,
    triggerInfo: undefined as QuickPanelTriggerInfo | undefined
  },
  saveText: vi.fn(),
  resourceTrigger: vi.fn(),
  noop: vi.fn(),
  t: (key: string) => key
}))

vi.mock('@renderer/components/QuickPanel', async () => ({
  ...(await vi.importActual('@renderer/components/QuickPanel/types')),
  useQuickPanel: () => mocks.quickPanel,
  QuickPanelView: () => null
}))

vi.mock('antd/es/input/TextArea', async () => {
  const { useImperativeHandle, useRef } = await import('react')
  return {
    default: function MockTextArea({
      ref,
      value,
      onChange,
      className
    }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<TextAreaRef> }) {
      const element = useRef<HTMLTextAreaElement>(null)
      useImperativeHandle(ref, () => ({ resizableTextArea: { textArea: element.current } }) as TextAreaRef)
      return <textarea ref={element} aria-label="message" className={className} value={value} onChange={onChange} />
    }
  }
})

vi.mock('antd', () => ({ Tooltip: ({ children }: PropsWithChildren) => children }))
vi.mock('@ant-design/icons', () => ({ HolderOutlined: () => null }))
vi.mock('@renderer/components/Buttons', () => ({ ActionIconButton: () => null }))
vi.mock('@renderer/components/TranslateButton', () => ({ default: () => null }))
vi.mock('../../../Messages/NarrowLayout', () => ({ default: ({ children }: PropsWithChildren) => children }))
vi.mock('../../AttachmentPreview', () => ({ default: () => null }))
vi.mock('../../SendMessageButton', () => ({ default: () => null }))

vi.mock('@renderer/hooks/useRuntime', () => ({ useRuntime: () => ({ searching: false }) }))
vi.mock('@renderer/hooks/useSettings', () => ({
  useSettings: () => ({
    enableQuickPanelTriggers: true,
    enableSpellCheck: false,
    fontSize: 14,
    autoTranslateWithSpace: false
  })
}))
vi.mock('@renderer/hooks/useTimer', () => ({ useTimer: () => ({ setTimeoutTimer: mocks.noop }) }))
vi.mock('@renderer/hooks/useTranslate', () => ({ default: () => ({ getLanguageByLangcode: mocks.noop }) }))
vi.mock('@renderer/services/PasteService', () => ({
  default: {
    init: mocks.noop,
    registerHandler: mocks.noop,
    unregisterHandler: mocks.noop,
    setLastFocusedComponent: mocks.noop,
    getLastFocusedComponent: mocks.noop
  }
}))
vi.mock('@renderer/services/TranslateService', () => ({ translateText: vi.fn() }))
vi.mock('@renderer/store', () => ({ useAppDispatch: () => mocks.noop }))
vi.mock('@renderer/store/runtime', () => ({ setSearching: mocks.noop }))
vi.mock('@renderer/utils', () => ({ classNames: (...names: unknown[]) => names.filter(Boolean).join(' ') }))
vi.mock('@renderer/utils/formats', () => ({ formatQuotedText: (text: string) => text }))
vi.mock('@renderer/utils/input', () => ({ isSendMessageKeyPressed: () => false }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }))
vi.mock('../../hooks/usePasteHandler', () => ({ usePasteHandler: () => ({ handlePaste: mocks.noop }) }))
vi.mock('../../hooks/useFileDragDrop', () => ({ useFileDragDrop: () => ({ isDragging: false }) }))

const rootItem = { label: 'Root tool', icon: null, action: mocks.noop }
const resourceItem = { label: 'Resource', icon: null, action: mocks.noop }
const supportedExts: string[] = []
const actions = {
  resizeTextArea: mocks.noop,
  addNewTopic: mocks.noop,
  clearTopic: mocks.noop,
  onNewContext: mocks.noop,
  onTextChange: mocks.noop,
  toggleExpanded: mocks.noop
}

function observeRegistry(dispatch: InputbarToolsDispatch) {
  return {
    ...dispatch,
    registerTrigger: vi.spyOn(dispatch.toolsRegistry, 'registerTrigger'),
    emit: vi.spyOn(dispatch.triggers, 'emit')
  }
}

type ObservedRegistry = ReturnType<typeof observeRegistry>

// Keep the production provider and its registry/dispatch implementation intact.
// These contributions stand in for toolbar tools, not InputbarCore's handlers.
function RegistryProbe({ capture }: { capture: (registry: ObservedRegistry) => void }) {
  const dispatch = useInputbarToolsDispatch()
  useEffect(() => {
    const disposeMenu = dispatch.toolsRegistry.registerRootMenu('test-root-tool', [rootItem])
    const disposeMention = dispatch.toolsRegistry.registerTrigger(
      'test-resources',
      QuickPanelReservedSymbol.MentionModels,
      (payload) => {
        mocks.resourceTrigger(payload)
        mocks.quickPanel.open({
          symbol: QuickPanelReservedSymbol.MentionModels,
          list: [resourceItem],
          triggerInfo: payload as QuickPanelTriggerInfo
        })
      }
    )
    capture(observeRegistry(dispatch))
    return () => {
      disposeMention()
      disposeMenu()
    }
  }, [capture, dispatch])
  return null
}

type HarnessOptions = {
  scope?: InputbarScope
  enableRootMenuTrigger?: boolean
  initialText?: string
}

function Harness({
  capture,
  scope = TopicType.Chat,
  enableRootMenuTrigger,
  initialText = ''
}: HarnessOptions & { capture: (registry: ObservedRegistry) => void }) {
  const [text, setText] = useState(initialText)
  const textareaRef = useRef<TextAreaRef>(null)
  const onTextChange = useCallback((next: string) => {
    mocks.saveText(next)
    setText(next)
  }, [])
  return (
    <InputbarToolsProvider actions={actions}>
      <RegistryProbe capture={capture} />
      <InputbarCore
        scope={scope}
        enableRootMenuTrigger={enableRootMenuTrigger}
        text={text}
        onTextChange={onTextChange}
        textareaRef={textareaRef}
        resizeTextArea={mocks.noop}
        focusTextarea={mocks.noop}
        height={undefined}
        onHeightChange={mocks.noop}
        supportedExts={supportedExts}
        isLoading={false}
        handleSendMessage={mocks.noop}
      />
    </InputbarToolsProvider>
  )
}

function renderInputbar(options: HarnessOptions = {}) {
  let registry!: ObservedRegistry
  const capture = (observed: ObservedRegistry) => {
    registry = observed
  }
  const view = render(<Harness {...options} capture={capture} />)
  const change = (value: string) => {
    fireEvent.change(screen.getByRole('textbox', { name: 'message' }), {
      target: { value, selectionStart: value.length, selectionEnd: value.length }
    })
  }
  return {
    ...view,
    registry,
    change,
    rerenderInputbar: (next: HarnessOptions) => view.rerender(<Harness {...next} capture={capture} />)
  }
}

describe('InputbarCore root and resource triggers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.quickPanel.isVisible = false
    mocks.quickPanel.symbol = ''
    mocks.quickPanel.lastCloseAction = undefined
    mocks.quickPanel.triggerInfo = undefined
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it.each(['/', '/hello', 'hello /hello'])('saves %j without emitting or opening root menus when disabled', (text) => {
    const { change, registry } = renderInputbar({ scope: TopicType.Session, enableRootMenuTrigger: false })
    expect(registry.triggers.getRootMenu()).toEqual([rootItem])
    expect(registry.registerTrigger).not.toHaveBeenCalledWith('inputbar-root', '/', expect.any(Function))

    change(text)

    expect(mocks.saveText).toHaveBeenLastCalledWith(text)
    expect(screen.getByRole('textbox', { name: 'message' })).toHaveValue(text)
    expect(registry.emit).not.toHaveBeenCalled()
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
    expect(mocks.quickPanel.close).not.toHaveBeenCalled()

    // A direct registry dispatch must not find a hidden/stale root handler either.
    registry.triggers.emit(QuickPanelReservedSymbol.Root, { type: 'button' })
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
  })

  it('does not resume slash search when deleting text with the root trigger disabled', () => {
    const { change, registry } = renderInputbar({
      scope: TopicType.Session,
      enableRootMenuTrigger: false,
      initialText: '/hello'
    })

    change('/hell')
    change('/')

    expect(mocks.saveText.mock.calls.map(([text]) => text)).toEqual(['/hell', '/'])
    expect(screen.getByRole('textbox', { name: 'message' })).toHaveValue('/')
    expect(registry.emit).not.toHaveBeenCalled()
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
  })

  it.each(['@', '@resource'])('still emits and opens resources for %j with the root trigger disabled', (text) => {
    const { change, registry } = renderInputbar({ scope: TopicType.Session, enableRootMenuTrigger: false })
    change(text)

    const triggerInfo = { type: 'input', position: 0, originalText: text }
    expect(mocks.saveText).toHaveBeenLastCalledWith(text)
    expect(screen.getByRole('textbox', { name: 'message' })).toHaveValue(text)
    expect(registry.emit).toHaveBeenCalledWith(QuickPanelReservedSymbol.MentionModels, triggerInfo)
    expect(registry.emit).not.toHaveBeenCalledWith(QuickPanelReservedSymbol.Root, expect.anything())
    expect(mocks.resourceTrigger).toHaveBeenCalledWith(triggerInfo)
    expect(mocks.quickPanel.open).toHaveBeenCalledWith({
      symbol: QuickPanelReservedSymbol.MentionModels,
      list: [resourceItem],
      triggerInfo
    })
  })

  it('keeps the default chat slash trigger registered and opening its root menu', () => {
    const { change, registry } = renderInputbar()
    expect(registry.registerTrigger).toHaveBeenCalledWith('inputbar-root', '/', expect.any(Function))

    change('/')

    expect(mocks.saveText).toHaveBeenLastCalledWith('/')
    expect(screen.getByRole('textbox', { name: 'message' })).toHaveValue('/')
    expect(registry.emit).toHaveBeenCalledWith('/', { type: 'input', position: 0, originalText: '/' })
    expect(mocks.quickPanel.open).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: '/', list: expect.arrayContaining([rootItem]) })
    )
  })

  it('unregisters root handlers across chat/session switches and restores them only when enabled', () => {
    const { registry, change, rerenderInputbar } = renderInputbar()
    change('/hello')
    expect(mocks.quickPanel.open).toHaveBeenCalled()

    rerenderInputbar({ scope: TopicType.Session, enableRootMenuTrigger: false })
    mocks.quickPanel.open.mockClear()
    registry.emit.mockClear()
    registry.triggers.emit(QuickPanelReservedSymbol.Root, { type: 'button' })
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
    registry.emit.mockClear()
    change('/')
    expect(registry.emit).not.toHaveBeenCalled()

    change('@')
    expect(mocks.resourceTrigger).toHaveBeenCalled()

    rerenderInputbar({ scope: TopicType.Chat })
    mocks.quickPanel.open.mockClear()
    change('/')
    expect(mocks.quickPanel.open).toHaveBeenCalledWith(expect.objectContaining({ symbol: '/' }))

    rerenderInputbar({ scope: TopicType.Session, enableRootMenuTrigger: false })
    mocks.quickPanel.open.mockClear()
    registry.triggers.emit(QuickPanelReservedSymbol.Root, { type: 'button' })
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
  })

  it('cleans up the root handler on unmount', () => {
    const enabled = renderInputbar()
    enabled.unmount()
    // Keep a menu entry after unmount so an accidentally retained handler cannot
    // hide behind the normal "no menu items" early return.
    const disposeMenu = enabled.registry.toolsRegistry.registerRootMenu('post-unmount', [rootItem])
    mocks.quickPanel.open.mockClear()
    enabled.registry.triggers.emit(QuickPanelReservedSymbol.Root, { type: 'button' })
    expect(mocks.quickPanel.open).not.toHaveBeenCalled()
    disposeMenu()
  })
})
