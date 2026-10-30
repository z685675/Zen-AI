import type { GetAgentSessionResponse } from '@types'

import type { AutomationTarget } from './AutomationRepository'

export type AutomationMirrorContext = { target?: AutomationTarget; exchangeId: string }

type Bridge = {
  prepare: (session: GetAgentSessionResponse) => Promise<GetAgentSessionResponse>
  captureMirrorTarget?: (sessionId: string) => Promise<AutomationTarget | undefined>
  mirror: (
    sessionId: string,
    input: string,
    answer: string,
    stopped: boolean,
    files: string[],
    context?: AutomationMirrorContext
  ) => Promise<{ runId: string } | boolean | void>
  invalidate?: (sessionId: string) => Promise<void>
}
let bridge: Bridge | undefined

export function registerAutomationBridge(value: Bridge) {
  bridge = value
}

export async function prepareAutomationSession(session: GetAgentSessionResponse) {
  return bridge ? bridge.prepare(session) : session
}

export async function mirrorAutomationExchange(
  sessionId: string,
  input: string,
  answer: string,
  stopped = false,
  files: string[] = [],
  context?: AutomationMirrorContext
) {
  return bridge ? bridge.mirror(sessionId, input, answer, stopped, files, context) : false
}

export async function captureAutomationMirrorTarget(sessionId: string) {
  return bridge?.captureMirrorTarget?.(sessionId)
}

export async function invalidateAutomationSession(sessionId: string) {
  await bridge?.invalidate?.(sessionId)
}
