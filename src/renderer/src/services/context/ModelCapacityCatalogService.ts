import { loggerService } from '@logger'
import { setModelCapacityCatalog } from '@shared/modelCapacity'

const logger = loggerService.withContext('ModelCapacityCatalogClient')
let lastRead = -Infinity
let pending: Promise<void> | undefined

/** Read the local main-process snapshot; its remote refresh runs independently. */
export function ensureModelCapacityCatalog(): Promise<void> {
  if (pending) return pending
  if (Date.now() - lastRead < 60_000 || !window.api?.modelCapacity?.get) return Promise.resolve()
  lastRead = Date.now()
  pending = window.api.modelCapacity
    .get()
    .then(setModelCapacityCatalog)
    .catch((error) => logger.warn('Cannot read capacity catalog; using bundled data', error as Error))
    .finally(() => {
      pending = undefined
    })
  return pending
}
