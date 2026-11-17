import { net } from 'electron'

import type { ConnectionRecord } from './connection'
import type { ClientConnectionRouter } from './routes'

let router: ClientConnectionRouter | undefined
export const installClientConnectionRouter = (value: ClientConnectionRouter) => {
  router = value
}
export function routeManagedFetch(native: typeof fetch, record?: ConnectionRecord): typeof fetch {
  return (input, init) => (router ? router.fetch(input, init, native, record) : native(input, init))
}
export const managedApiFetch = routeManagedFetch((input, init) =>
  net.fetch(input instanceof URL ? input.href : input, init)
)
