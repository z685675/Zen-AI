export type AssistantFileChange = {
  id: string
  turn: string
  path: string
  kind: 'created' | 'modified' | 'deleted'
  changedAt: number
  canRestore: boolean
  restoredAt?: number
}

export type AssistantFileRestoreResult = 'restored' | 'conflict' | 'unavailable' | 'busy'

export type AssistantFilePreview = {
  format: 'text' | 'document' | 'metadata'
  beforeBytes: number | null
  currentBytes: number | null
  before?: string
  current?: string
  partial: boolean
  changedSince: boolean
}
