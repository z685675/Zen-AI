import { DEFAULT_FUSION_AGENT_NAME, DEFAULT_OPENCODE_AGENT_NAME } from '@shared/config/agents'
import { describe, expect, it, vi } from 'vitest'

vi.mock('./index', async () => {
  const { default: locale } = await import('./locales/zh-cn.json')
  return {
    default: {
      t: (key: string) => {
        let value: unknown = locale
        for (const field of key.split('.')) {
          if (!value || typeof value !== 'object') return key
          value = (value as Record<string, unknown>)[field]
        }
        return typeof value === 'string' ? value : key
      }
    }
  }
})

import { getSidebarIconLabel, getTitleLabel } from './label'

describe('assistant entry labels are separate from agent names', () => {
  it('names the new entry 新版助手 and its managed agent 智能助手', () => {
    expect(getSidebarIconLabel('new_assistant')).toBe('新版助手')
    expect(getTitleLabel('new-assistant')).toBe('新版助手')
    expect(DEFAULT_OPENCODE_AGENT_NAME).toBe('智能助手')
  })

  it('names the old entry 旧助手 and its managed agent 请弃用旧助手', () => {
    expect(getSidebarIconLabel('agents')).toBe('旧助手')
    expect(getTitleLabel('agents')).toBe('旧助手')
    expect(DEFAULT_FUSION_AGENT_NAME).toBe('请弃用旧助手')
  })
})
