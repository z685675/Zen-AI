import type { GetAgentSessionResponse } from '@types'

type Bridge = {
  prepare: (session: GetAgentSessionResponse) => Promise<GetAgentSessionResponse>
  mirror: (sessionId: string, input: string, answer: string, stopped: boolean, files: string[]) => Promise<void>
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
  files: string[] = []
) {
  if (bridge) await bridge.mirror(sessionId, input, answer, stopped, files)
}

export async function invalidateAutomationSession(sessionId: string) {
  await bridge?.invalidate?.(sessionId)
}
