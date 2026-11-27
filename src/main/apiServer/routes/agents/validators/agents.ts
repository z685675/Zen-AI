import { AgentIdParamSchema, ReplaceAgentRequestSchema, UpdateAgentRequestSchema } from '@types'

import { createZodValidator } from './zodValidator'

export const validateAgentReplace = createZodValidator({
  body: ReplaceAgentRequestSchema
})

export const validateAgentUpdate = createZodValidator({
  body: UpdateAgentRequestSchema
})

export const validateAgentId = createZodValidator({
  params: AgentIdParamSchema
})
