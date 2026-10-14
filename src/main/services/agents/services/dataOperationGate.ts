import { randomUUID } from 'node:crypto'

export type AssistantDataOperation = 'backup' | 'restore' | 'reset'
let current: { token: string; kind: AssistantDataOperation; owner?: number } | undefined

export function assertAssistantDataAvailable(): void {
  if (current)
    throw Object.assign(
      new Error('Assistant data is being backed up, restored or reset; try again after it finishes'),
      { code: 'assistant_data_busy' }
    )
}

export function ownsAssistantDataOperation(kind: AssistantDataOperation, owner?: number): boolean {
  return owner !== undefined && current?.owner === owner && current.kind === kind
}

export function acquireAssistantDataOperation(kind: AssistantDataOperation, isBusy: () => boolean, owner?: number) {
  assertAssistantDataAvailable()
  if (isBusy())
    throw Object.assign(new Error('Stop active assistant tasks before backing up, restoring or resetting data'), {
      code: 'assistant_data_busy'
    })
  const token = randomUUID()
  current = { token, kind, owner }
  return {
    token,
    release: () => {
      if (current?.token === token) current = undefined
    }
  }
}
