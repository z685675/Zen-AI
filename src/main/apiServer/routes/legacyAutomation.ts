import {
  isLegacyAutomationEnabled,
  LEGACY_AUTOMATION_DISABLED_CODE,
  LEGACY_AUTOMATION_DISABLED_MESSAGE
} from '@shared/agents/legacyAutomation'
import type { RequestHandler } from 'express'

/** History/cleanup remain available. Disabled features cannot be started via local REST. */
export const guardLegacyAutomationWrites: RequestHandler = (req, res, next) => {
  if (!isLegacyAutomationEnabled() && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    res.status(410).json({
      error: {
        type: 'feature_disabled',
        code: LEGACY_AUTOMATION_DISABLED_CODE,
        message: LEGACY_AUTOMATION_DISABLED_MESSAGE
      }
    })
    return
  }
  next()
}
