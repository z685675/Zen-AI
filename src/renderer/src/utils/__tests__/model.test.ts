import type { Model, ModelTag } from '@renderer/types'
import { describe, expect, it, vi } from 'vitest'

import { getDuplicateModelNames, getModelTags, isFreeModel } from '../model'
import { getModelFamilyPriority, sortModelGroupsByFamily, sortModelsByFamily } from '../modelSorting'

// Mock the model checking functions from @renderer/config/models
vi.mock('@renderer/config/models', () => ({
  isVisionModel: vi.fn().mockImplementation((m: Model) => m.id === 'vision'),
  isEmbeddingModel: vi.fn().mockImplementation((m: Model) => m.id === 'embedding'),
  isReasoningModel: vi.fn().mockImplementation((m: Model) => m.id === 'reasoning'),
  isFunctionCallingModel: vi.fn().mockImplementation((m: Model) => m.id === 'tool'),
  isWebSearchModel: vi.fn().mockImplementation((m: Model) => m.id === 'search'),
  isRerankModel: vi.fn().mockImplementation((m: Model) => m.id === 'rerank')
}))

describe('model', () => {
  describe('model display sorting', () => {
    const createModel = (id: string, group = ''): Model => ({
      id,
      name: id,
      provider: 'provider',
      group
    })

    it('orders GPT, Gemini, Claude, Grok, then all remaining families', () => {
      const models = [
        createModel('deepseek-v3'),
        createModel('grok-4'),
        createModel('claude-opus-4-6'),
        createModel('gemini-3.1-pro'),
        createModel('gpt-5.4')
      ]

      expect(sortModelsByFamily(models).map((model) => model.id)).toEqual([
        'gpt-5.4',
        'gemini-3.1-pro',
        'claude-opus-4-6',
        'grok-4',
        'deepseek-v3'
      ])
      expect(models[0].id).toBe('deepseek-v3')
    })

    it('recognizes provider-family aliases from model groups', () => {
      expect(getModelFamilyPriority(createModel('custom-openai-model', 'OpenAI'))).toBe(0)
      expect(getModelFamilyPriority(createModel('custom-google-model', 'Google'))).toBe(1)
      expect(getModelFamilyPriority(createModel('custom-anthropic-model', 'Anthropic'))).toBe(2)
      expect(getModelFamilyPriority(createModel('custom-xai-model', 'xAI'))).toBe(3)
    })

    it('prefers an explicit model family over a generic provider group', () => {
      expect(getModelFamilyPriority(createModel('claude-opus-4-6', 'OpenAI'))).toBe(2)
      expect(getModelFamilyPriority(createModel('gemini-3.1-pro', 'OpenAI'))).toBe(1)
    })

    it('keeps models with the same prefix adjacent using natural numeric ordering', () => {
      const sorted = sortModelsByFamily([
        createModel('gpt-5.2-pro'),
        createModel('gpt-4o'),
        createModel('gpt-5.2'),
        createModel('gpt-5.2-mini')
      ])

      expect(sorted.map((model) => model.id)).toEqual(['gpt-4o', 'gpt-5.2', 'gpt-5.2-mini', 'gpt-5.2-pro'])
    })

    it('orders existing provider groups by family and sorts models inside each group', () => {
      const groups = sortModelGroupsByFamily({
        Other: [createModel('qwen-3')],
        Anthropic: [createModel('claude-sonnet-4-6'), createModel('claude-opus-4-6')],
        Google: [createModel('gemini-3.1-flash')],
        OpenAI: [createModel('gpt-5.4-pro'), createModel('gpt-5.4')],
        xAI: [createModel('grok-4')]
      })

      expect(Object.keys(groups)).toEqual(['OpenAI', 'Google', 'Anthropic', 'xAI', 'Other'])
      expect(groups.OpenAI.map((model) => model.id)).toEqual(['gpt-5.4', 'gpt-5.4-pro'])
    })
  })

  describe('isFreeModel', () => {
    const base = { provider: '', group: '' }
    it('should return true if id or name contains "free" (case-insensitive)', () => {
      expect(isFreeModel({ id: 'free-model', name: 'test', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'FreePlan', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'notfree', ...base })).toBe(true)
      expect(isFreeModel({ id: 'model', name: 'test', ...base })).toBe(false)
    })

    it('should handle empty id or name', () => {
      expect(isFreeModel({ id: '', name: 'free', ...base })).toBe(true)
      expect(isFreeModel({ id: 'free', name: '', ...base })).toBe(true)
      expect(isFreeModel({ id: '', name: '', ...base })).toBe(false)
    })
  })

  describe('getModelTags', () => {
    const baseModel: Model = {
      id: 'test',
      provider: 'test',
      group: 'test',
      name: 'test'
    }
    const visionModel: Model = {
      ...baseModel,
      id: 'vision'
    }
    const embeddingModel: Model = {
      ...baseModel,
      id: 'embedding'
    }
    const reasoningModel: Model = {
      ...baseModel,
      id: 'reasoning'
    }
    const searchModel: Model = {
      ...baseModel,
      id: 'search'
    }
    const rerankModel: Model = {
      ...baseModel,
      id: 'rerank'
    }
    const toolModel: Model = {
      ...baseModel,
      id: 'tool'
    }
    const freeModel: Model = {
      ...baseModel,
      id: 'free'
    }

    it('should get correct tags', () => {
      const models_1 = [visionModel, embeddingModel, reasoningModel, searchModel]
      const expected_1: Record<ModelTag, boolean> = {
        vision: true,
        embedding: true,
        reasoning: true,
        rerank: false,
        free: false,
        function_calling: false,
        web_search: true
      }
      expect(getModelTags(models_1)).toStrictEqual(expected_1)

      const models_2 = [rerankModel, toolModel, freeModel]
      const expected_2: Record<ModelTag, boolean> = {
        vision: false,
        embedding: false,
        reasoning: false,
        rerank: true,
        free: true,
        function_calling: true,
        web_search: false
      }
      expect(getModelTags(models_2)).toStrictEqual(expected_2)
    })
  })

  describe('getDuplicateModelNames', () => {
    it('should return an empty Set for an empty array', () => {
      expect(getDuplicateModelNames([])).toStrictEqual(new Set())
    })

    it('should return an empty Set when no model names are duplicated', () => {
      expect(getDuplicateModelNames([{ name: 'gpt-4o' }, { name: 'claude-3-7-sonnet' }])).toStrictEqual(new Set())
    })

    it('should return the duplicated model names', () => {
      expect(
        getDuplicateModelNames([{ name: 'gpt-4o' }, { name: 'claude-3-7-sonnet' }, { name: 'gpt-4o' }])
      ).toStrictEqual(new Set(['gpt-4o']))
    })

    it('should return all names when every name appears more than once', () => {
      expect(
        getDuplicateModelNames([
          { name: 'gpt-4o' },
          { name: 'gpt-4o' },
          { name: 'claude-3-7-sonnet' },
          { name: 'claude-3-7-sonnet' }
        ])
      ).toStrictEqual(new Set(['gpt-4o', 'claude-3-7-sonnet']))
    })
  })
})
