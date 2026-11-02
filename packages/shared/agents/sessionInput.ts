export type AgentInputState = 'accepted' | 'applied' | 'deferred' | 'uncertain' | 'rejected'
export type AgentInputReceipt = {
  id: string
  state: AgentInputState
  nativeMessageId?: string
  code?: 'not_running' | 'not_ready' | 'invalid_input' | 'delivery_uncertain' | 'receipt_unavailable'
}
export type AgentRunInput = {
  sessionId: string
  turnId: string
  id: string
  text: string
  images?: Array<{ data: string; media_type: string }>
}
export type AgentRunInputStatus = { active: boolean; ready: boolean; turnId?: string }
