import type { Model } from '@types'
import * as z from 'zod'

import { ProviderTypeSchema } from './provider'

const ApiEndpointTypeSchema = z.enum([
  'openai',
  'openai-response',
  'anthropic',
  'gemini',
  'image-generation',
  'jina-rerank'
])

// Request schema for /v1/models
export const ApiModelsFilterSchema = z.object({
  providerType: ProviderTypeSchema.optional(),
  offset: z.coerce.number().min(0).default(0).optional(),
  limit: z.coerce.number().min(1).default(20).optional()
})

// OpenAI compatible model schema
export const ApiModelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number(),
  name: z.string(),
  owned_by: z.string(),
  provider: z.string().optional(),
  provider_name: z.string().optional(),
  provider_type: ProviderTypeSchema.optional(),
  provider_model_id: z.string().optional(),
  is_official_provider: z.boolean().optional(),
  endpoint_type: ApiEndpointTypeSchema.optional(),
  supported_endpoint_types: z.array(ApiEndpointTypeSchema).optional(),
  agent_runtime_compatibility: z.array(z.enum(['claude-code', 'codex'])).optional()
})

// Response schema for /v1/models
export const ApiModelsResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(ApiModelSchema),
  total: z.number().optional(),
  offset: z.number().optional(),
  limit: z.number().optional()
})

// Inferred TypeScript types
export type ApiModel = z.infer<typeof ApiModelSchema>
export type ApiModelsFilter = z.infer<typeof ApiModelsFilterSchema>
export type ApiModelsResponse = z.infer<typeof ApiModelsResponseSchema>

// Adapted
export type AdaptedApiModel = Model & {
  origin: ApiModel
}
