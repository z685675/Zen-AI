import * as z from 'zod'

import { hotpatchBaseSchema, hotpatchFileSchema } from './hotpatch'

export const hotpatchDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    bases: z.array(hotpatchBaseSchema).min(1).max(12),
    builtin: z.array(hotpatchFileSchema).min(5).max(10000),
    frozenSources: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
    sourceClean: z.boolean()
  })
  .strict()
export type HotpatchDescriptor = z.infer<typeof hotpatchDescriptorSchema>

// Allowlist, not an ignore list. Persistent stores, APIs, DB, preload and dependency changes require installers.
export function patchableSource(name: string): boolean {
  if (!name.startsWith('src/renderer/src/')) return false
  return (
    ['components/', 'pages/', 'assets/', 'i18n/'].some((prefix) => name.startsWith(`src/renderer/src/${prefix}`)) &&
    !/(?:^|\/)(?:store|stores|databases|migrations|types)(?:\/|\.)/i.test(name)
  )
}
