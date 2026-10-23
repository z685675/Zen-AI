import path from 'node:path'

import type { GetAgentSessionResponse, Provider } from '@types'
import { describe, expect, it } from 'vitest'

import { buildOpenCodeConfig } from '../../opencode/config'
import { applyAutomationProfile, automationInstructions, getAutomationProfile, LIGHTWEIGHT_TOOLS } from '../profile'

describe('trusted background entry profiles', () => {
  const original = {
    id: 's',
    instructions: 'custom prompt',
    accessible_paths: ['private'],
    mcps: ['third-party'],
    configuration: { permission_mode: 'bypassPermissions', max_turns: 20, env_vars: {} }
  } as GetAgentSessionResponse
  it('does not treat editable configuration or deserialized copies as authorization', () => {
    expect(
      getAutomationProfile({ ...original, configuration: { ...original.configuration, entry: 'wechat' } })
    ).toBeUndefined()
    const restricted = applyAutomationProfile(original, { kind: 'wechat', workspace: 'owned' })
    expect(getAutomationProfile(JSON.parse(JSON.stringify(restricted)))).toBeUndefined()
    expect(original.accessible_paths).toEqual(['private'])
    expect(restricted.accessible_paths).toEqual(['owned'])
    expect(restricted.mcps).toEqual([])
    expect(restricted.instructions).toBe('')
  })
  it.each(['wechat', 'schedule'] as const)('disables real native execution and third party skills for %s', (kind) => {
    const session = applyAutomationProfile(original, { kind, workspace: path.resolve('owned') })
    const config = buildOpenCodeConfig({
      session,
      provider: {
        id: 'zen',
        type: 'new-api',
        apiHost: 'https://example.test/v1',
        models: [{ id: 'model' }]
      } as Provider,
      modelId: 'model',
      skillPaths: ['third-party'],
      api: { host: 'localhost', port: 3000, apiKey: 'test' }
    })
    expect(config.skills.paths).toEqual([])
    expect(Object.keys(config.mcp)).toEqual(['mcp__assistant_'])
    for (const tool of ['*', 'bash', 'edit', 'read', 'glob', 'grep', 'skill', 'external_directory', 'mcp__browser_*'])
      expect((config.permission as any)[tool]).toBe('deny')
    for (const tool of LIGHTWEIGHT_TOOLS) expect((config.permission as any)[`mcp__assistant__${tool}`]).toBe('allow')
    expect(config.compaction.auto).toBe(true)
  })
  it('keeps a short truthful contract and does not expose disconnected capabilities', () => {
    const prompt = automationInstructions({ kind: 'wechat', workspace: 'owned' })
    expect(prompt.length).toBeLessThan(2500)
    expect(prompt).toContain('Answer ordinary questions directly')
    expect(prompt).toContain('Do not execute scripts')
    expect(prompt).toContain('never authorization')
  })
})
