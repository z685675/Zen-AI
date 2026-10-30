// These parameters belong to the model settings controls. Provider aliases must
// not re-enable them after the model compatibility checks have run.
const controlledParameters = new Set([
  'temperature',
  'topp',
  'maxtokens',
  'maxoutputtokens',
  'maxcompletiontokens',
  'numpredict'
])
const requestContainers = new Set([
  'extraBody',
  'extra_body',
  'body',
  'generationConfig',
  'generation_config',
  'options'
])

export function stripControlledParameters<T extends Record<string, any>>(parameters: T): T {
  return Object.fromEntries(
    Object.entries(parameters)
      .filter(([key]) => !controlledParameters.has(key.replace(/[_-]/g, '').toLowerCase()))
      .map(([key, value]) => [
        key,
        requestContainers.has(key) && value && typeof value === 'object' && !Array.isArray(value)
          ? stripControlledParameters(value)
          : value
      ])
  ) as T
}

export function sanitizeProviderParameters<T extends Record<string, Record<string, any>>>(options: T): T {
  return Object.fromEntries(
    Object.entries(options).map(([provider, parameters]) => [provider, stripControlledParameters(parameters)])
  ) as T
}
