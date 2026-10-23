import { readFile } from 'node:fs/promises'

import * as z from 'zod'

import type { Manifest } from './types'

const project = z.enum(['ai', 'api'])
const names = z.array(z.string().min(1)).min(1)
const schema = z.strictObject({
  schemaVersion: z.literal(1),
  checks: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[A-Z][A-Z0-9-]+$/),
        project,
        title: z.string().min(1),
        executor: z.enum(['vitest', 'script', 'go-test', 'go-vet', 'api-web']),
        target: z.array(z.string().min(1)),
        modes: z.array(z.enum(['offline', 'release'])).min(1),
        tags: names,
        timeoutMs: z.number().int().min(100).max(3600000)
      })
    )
    .min(1),
  rules: z.array(z.strictObject({ project, prefixes: names, tags: names })),
  manual: z.array(
    z.strictObject({
      id: z.string().min(1),
      tags: names,
      title: z.string().min(1),
      steps: names,
      prompt: z.string().min(1),
      expected: z.string().min(1),
      reason: z.string().min(1)
    })
  )
})

export function parseManifest(value: unknown): Manifest {
  const original = schema.safeParse(value)
  let result: Manifest
  if (original.success) result = original.data
  else if (value && typeof value === 'object' && !Array.isArray(value)) {
    // An invalid impact map can only expand checks, never reduce them. Broken check definitions fail closed.
    result = { ...schema.parse({ ...value, rules: [] }), mappingError: '影响映射解析失败，改动检查扩大为全量。' }
  } else throw new Error('Invalid quality manifest')
  for (const collection of [result.checks, result.manual]) {
    if (new Set(collection.map((entry) => entry.id)).size !== collection.length) {
      throw new Error('Duplicate quality case ID')
    }
  }
  for (const check of result.checks) {
    if (check.project === 'api' && (check.executor === 'vitest' || check.executor === 'script')) {
      throw new Error(`Invalid executor for ${check.id}`)
    }
    if (check.project === 'ai' && !['vitest', 'script'].includes(check.executor)) {
      throw new Error(`Invalid executor for ${check.id}`)
    }
  }
  if (
    result.rules.some((rule) =>
      rule.tags.some(
        (tag) => !result.checks.some((check) => check.project === rule.project && check.tags.includes(tag))
      )
    )
  ) {
    result.rules = []
    result.mappingError = '影响映射引用不存在的检查标签，改动检查扩大为全量。'
  }
  return result
}

export async function loadManifest(file: string) {
  return parseManifest(JSON.parse(await readFile(file, 'utf8')))
}
