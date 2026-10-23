import type { ApiModel, Provider } from '@types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  records: {} as Record<string, unknown>,
  cached: true,
  developer: false,
  now: 1000,
  policy: { assistant: { fallbackModels: ['B', 'C'], blockedModels: [], nonDeveloperAllowlist: [] } }
}))
vi.mock('@main/services/ConfigManager', () => ({
  configManager: {
    get: () => structuredClone(mocks.records),
    set: (_key: string, value: any) => {
      mocks.records = structuredClone(value)
    },
    getEnableDeveloperMode: () => mocks.developer
  }
}))
vi.mock('@main/services/ModelAvailabilityService', () => ({
  getCachedModelAvailability: () => (mocks.cached ? {} : undefined)
}))
vi.mock('@main/services/RemoteModelPolicyService', () => ({
  remoteModelPolicyService: { getSnapshot: () => ({ policy: mocks.policy }) }
}))

import { forgetSessionModelIntent, resolveManagedSessionModel } from '../managedModelRecovery'

const models = (...ids: string[]) =>
  ids.map((id) => ({ id: `zen:${id}`, provider: 'zen', provider_model_id: id, name: id }) as ApiModel)
const providers = [{ id: 'zen', apiHost: 'https://zenai.925636.xyz' }] as Provider[]

describe('managed session recovery intent', () => {
  beforeEach(() => {
    mocks.records = {}
    mocks.cached = true
    mocks.developer = false
    vi.spyOn(Date, 'now').mockReturnValue(1000)
  })
  it('uses ordered in-provider fallback then restores the original preference after stable recovery', () => {
    expect(resolveManagedSessionModel('s', 'zen:A', { models: models('C'), providers })).toEqual({
      managed: true,
      selected: 'zen:C'
    })
    expect(resolveManagedSessionModel('s', 'zen:C', { models: models('A', 'C'), providers }).selected).toBe('zen:C')
    vi.mocked(Date.now).mockReturnValue(301_001)
    expect(resolveManagedSessionModel('s', 'zen:C', { models: models('A', 'C'), providers }).selected).toBe('zen:A')
  })
  it('keeps intent through an empty selection and does not use another provider or arbitrary model', () => {
    expect(
      resolveManagedSessionModel('s', 'zen:A', {
        models: [...models('expensive'), { id: 'other:B', provider: 'other', name: 'B' } as ApiModel],
        providers
      })
    ).toEqual({ managed: true, selected: undefined })
    expect(resolveManagedSessionModel('s', '', { models: models('A'), providers }).selected).toBe('zen:A')
  })
  it('honors a manual selection of the same temporary model', () => {
    resolveManagedSessionModel('s', 'zen:A', { models: models('B'), providers })
    forgetSessionModelIntent('s')
    expect(resolveManagedSessionModel('s', 'zen:B', { models: models('A', 'B'), providers }).selected).toBe('zen:B')
  })
  it('does not interpret an absent verified snapshot as empty supply', () => {
    mocks.cached = false
    expect(resolveManagedSessionModel('s', 'zen:A', { models: [], providers })).toEqual({
      managed: false,
      selected: 'zen:A'
    })
  })
})
