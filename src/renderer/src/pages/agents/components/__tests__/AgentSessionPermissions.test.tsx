import { configureStore } from '@reduxjs/toolkit'
import toolPermissions, {
  selectPendingPermission,
  type ToolPermissionRequestPayload,
  toolPermissionsActions
} from '@renderer/store/toolPermissions'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Provider } from 'react-redux'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AgentSessionPermissions from '../AgentSessionPermissions'

vi.mock('@renderer/store', async () => {
  const redux = await import('react-redux')
  return { useAppSelector: redux.useSelector, useAppDispatch: redux.useDispatch }
})
vi.mock('@renderer/pages/home/Messages/NarrowLayout', () => ({ default: ({ children }: any) => children }))
vi.mock('@renderer/utils', () => ({
  cn: (...items: unknown[]) => items.filter((item) => typeof item === 'string').join(' ')
}))
vi.mock('@renderer/pages/home/Messages/Tools/MessageAgentTools/GenericTools', () => ({
  SkeletonValue: ({ value }: any) => <span>{value}</span>
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const request: ToolPermissionRequestPayload = {
  requestId: 'permission-1',
  toolName: 'doom_loop',
  toolId: 'doom_loop',
  toolCallId: 'session-one:permission:per_native',
  requiresPermissions: true,
  input: { patterns: ['skill'], tool: 'skill' },
  inputPreview: '{"patterns":["skill"]}',
  createdAt: 1,
  suggestions: []
}

describe('session-level native permissions', () => {
  beforeEach(() => {
    window.api.agentTools = { respondToPermission: vi.fn().mockResolvedValue({ success: true }) } as any
  })
  it('shows a question form instead of a generic allow button and preserves multi-select labels', async () => {
    const store = configureStore({ reducer: { toolPermissions } })
    store.dispatch(
      toolPermissionsActions.requestReceived({
        ...request,
        toolName: 'question',
        toolId: 'question',
        toolCallId: 'session-one:child:child-native:ask',
        input: {
          questions: [
            {
              question: 'Choose output',
              header: 'Output',
              multiple: true,
              options: [{ label: 'Word, PDF' }, { label: 'PPT' }]
            }
          ]
        }
      })
    )
    const view = (sessionId: string) => (
      <Provider store={store}>
        <AgentSessionPermissions sessionId={sessionId} />
      </Provider>
    )
    const result = render(view('session-one'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /agent.askUserQuestion.submit/ })).toBeDisabled()
    fireEvent.click(screen.getByText('Word, PDF'))
    fireEvent.click(screen.getByText('PPT'))
    fireEvent.click(screen.getByRole('button', { name: 'agent.askUserQuestion.submit' }))
    await waitFor(() =>
      expect(window.api.agentTools.respondToPermission).toHaveBeenCalledWith(
        expect.objectContaining({ updatedInput: expect.objectContaining({ nativeAnswers: [['Word, PDF', 'PPT']] }) })
      )
    )
    expect(screen.getByRole('button', { name: /agent.askUserQuestion.submit/ })).toBeDisabled()
    result.rerender(view('another-session'))
    expect(screen.queryByText('Choose output')).not.toBeInTheDocument()
    result.rerender(view('session-one'))
    expect(screen.getByText('Choose output')).toBeInTheDocument()
  })
  it('allows dismissing a native clarification and respects a question without free text', async () => {
    const store = configureStore({ reducer: { toolPermissions } })
    store.dispatch(
      toolPermissionsActions.requestReceived({
        ...request,
        toolName: 'question',
        toolCallId: 'session-one:ask',
        input: {
          questions: [
            {
              question: 'Choose output',
              header: 'Output',
              multiSelect: false,
              allowCustom: false,
              options: [{ label: 'PDF' }]
            }
          ]
        }
      })
    )
    render(
      <Provider store={store}>
        <AgentSessionPermissions sessionId="session-one" />
      </Provider>
    )
    expect(screen.queryByText('agent.askUserQuestion.other')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() =>
      expect(window.api.agentTools.respondToPermission).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: request.requestId, behavior: 'deny' })
      )
    )
  })
  it('lets users answer a permission without a tool block and removes it after resolution', async () => {
    const store = configureStore({ reducer: { toolPermissions } })
    store.dispatch(toolPermissionsActions.requestReceived(request))
    render(
      <Provider store={store}>
        <AgentSessionPermissions sessionId="session-one" />
      </Provider>
    )
    expect(screen.getByRole('alert')).toHaveTextContent('new_assistant.permission.loopTitle')
    fireEvent.click(screen.getByRole('button', { name: 'new_assistant.permission.loopAllow' }))
    await waitFor(() =>
      expect(window.api.agentTools.respondToPermission).toHaveBeenCalledWith({
        requestId: request.requestId,
        behavior: 'allow',
        updatedInput: request.input,
        updatedPermissions: undefined
      })
    )
    act(() => {
      store.dispatch(
        toolPermissionsActions.requestResolved({ requestId: request.requestId, behavior: 'allow', reason: 'response' })
      )
    })
    expect(store.getState().toolPermissions.requests).toEqual({})
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })
  it('keeps pending confirmations with their own session across navigation and supports denial', async () => {
    const store = configureStore({ reducer: { toolPermissions } })
    store.dispatch(toolPermissionsActions.requestReceived(request))
    const view = (sessionId: string) => (
      <Provider store={store}>
        <AgentSessionPermissions sessionId={sessionId} />
      </Provider>
    )
    const result = render(view('session-two'))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    result.rerender(view('session-one'))
    expect(screen.getByRole('alert')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'new_assistant.permission.loopSkip' }))
    await waitFor(() =>
      expect(window.api.agentTools.respondToPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: request.requestId,
          behavior: 'deny'
        })
      )
    )
  })
})

it('answers the displayed request when two permissions share the same tool call', async () => {
  const store = configureStore({ reducer: { toolPermissions } })
  const first = { ...request, toolCallId: 'session-one:call_shared', input: { command: 'first' } }
  const second = { ...first, requestId: 'permission-2', createdAt: 2, input: { command: 'second' } }
  store.dispatch(toolPermissionsActions.requestReceived(first))
  store.dispatch(toolPermissionsActions.requestReceived(second))
  window.api.agentTools = { respondToPermission: vi.fn().mockResolvedValue({ success: true }) } as any
  render(
    <Provider store={store}>
      <AgentSessionPermissions sessionId="session-one" />
    </Provider>
  )
  fireEvent.click(
    within(screen.getAllByRole('alert')[1]).getByRole('button', { name: 'new_assistant.permission.loopAllow' })
  )
  await waitFor(() =>
    expect(window.api.agentTools.respondToPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'permission-2',
        updatedInput: { command: 'second' }
      })
    )
  )
})

it('does not let an earlier approved request mask another pending request and clears all on completion', () => {
  const store = configureStore({ reducer: { toolPermissions } })
  const first = { ...request, toolCallId: 'session-one:call_shared' }
  store.dispatch(toolPermissionsActions.requestReceived(first))
  store.dispatch(
    toolPermissionsActions.requestResolved({
      requestId: first.requestId,
      behavior: 'allow',
      reason: 'response',
      updatedInput: first.input
    })
  )
  store.dispatch(toolPermissionsActions.requestReceived({ ...first, requestId: 'permission-2', createdAt: 2 }))
  expect(selectPendingPermission(store.getState().toolPermissions, first.toolCallId)?.requestId).toBe('permission-2')
  store.dispatch(toolPermissionsActions.removeByToolCallId({ toolCallId: first.toolCallId }))
  expect(store.getState().toolPermissions).toEqual({ requests: {}, resolvedInputs: {} })
})
