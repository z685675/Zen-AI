import { net } from 'electron'

import { ConfigKeys, configManager } from './ConfigManager'
import { ClientConnectionRouter } from './modelTransport/routes'

let router: ClientConnectionRouter | undefined
export function getClientConnectionRouter(): ClientConnectionRouter {
  return (router ??= new ClientConnectionRouter({
    fetch: (input, init) => net.fetch(input instanceof URL ? input.href : input, init),
    load: () => configManager.get<unknown>(ConfigKeys.ClientConnectionPolicy),
    save: (policy) => configManager.set(ConfigKeys.ClientConnectionPolicy, policy)
  }))
}
