import type { Model, Provider } from '@renderer/types'
import { DEFAULT_MODEL_POLICY } from '@shared/config/modelPolicy'
import { beforeEach, describe, expect, it } from 'vitest'

import { modelRecoveryIntents } from '../modelRecoveryIntents'
import { resolveNextManagedRequestModel } from '../ModelRequestRecovery'

const model = (id: string, provider = 'zen'): Model => ({ id, provider, name: id, group: 'default' })
const provider = (id: string, ...ids: string[]): Provider => ({
  id,
  apiHost: id === 'zen' ? 'https://zenai.925636.xyz' : 'https://other.invalid',
  apiKey: 'fake',
  name: id,
  type: 'new-api',
  enabled: true,
  models: ids.map((value) => model(value, id))
})
const policy = { ...DEFAULT_MODEL_POLICY, assistant: { ...DEFAULT_MODEL_POLICY.assistant, fallbackModels: ['B', 'C'] } }

describe('new auxiliary requests while global settings are frozen by another turn', () => {
  beforeEach(() => modelRecoveryIntents.set('global:quick', undefined))
  it('uses the first eligible fallback without mutating the original settings or intent', () => {
    const current = model('A')
    expect(
      resolveNextManagedRequestModel('global:quick', current, [provider('zen', 'C', 'expensive')], policy)?.id
    ).toBe('C')
    expect(current.id).toBe('A')
    expect(modelRecoveryIntents.get('global:quick')).toBeUndefined()
  })
  it('never picks a different Provider or an unconfigured model when exhausted', () => {
    expect(
      resolveNextManagedRequestModel(
        'global:quick',
        model('A'),
        [provider('zen', 'expensive'), provider('third', 'B')],
        policy
      )
    ).toBeUndefined()
  })
  it('preserves a healthy temporary B during the primary stability window', () => {
    modelRecoveryIntents.set('global:quick', { preferred: 'zen:A', actual: 'zen:B', unavailableAt: Date.now() - 1000 })
    expect(resolveNextManagedRequestModel('global:quick', model('B'), [provider('zen', 'A', 'B')], policy)?.id).toBe(
      'B'
    )
  })
  it('does not interfere with a third-party Provider', () => {
    const current = model('D', 'third')
    expect(resolveNextManagedRequestModel('global:quick', current, [provider('third')], policy)).toBe(current)
  })
})
