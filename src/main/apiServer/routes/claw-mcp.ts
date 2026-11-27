import {
  LEGACY_ASSISTANT_READ_ONLY_CODE,
  LEGACY_ASSISTANT_READ_ONLY_MESSAGE
} from '@shared/agents/assistantAvailability'
import express from 'express'

const router: express.Router = express.Router({ mergeParams: true })

router.all('/:agentId/claw-mcp', (_req, res) => {
  res.status(410).json({
    error: { code: LEGACY_ASSISTANT_READ_ONLY_CODE, type: 'read_only', message: LEGACY_ASSISTANT_READ_ONLY_MESSAGE }
  })
})

export { router as clawMcpRoutes }
