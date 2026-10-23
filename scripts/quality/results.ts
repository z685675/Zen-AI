import * as z from 'zod'

import type { TestCounts } from './types'

const count = z.number().int().nonnegative()
const vitestSchema = z.object({
  success: z.boolean(),
  numTotalTests: count,
  numPassedTests: count,
  numFailedTests: count,
  numPendingTests: count,
  numTodoTests: count,
  numFailedTestSuites: count,
  testResults: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['passed', 'failed']),
      assertionResults: z.array(
        z.object({ fullName: z.string(), status: z.enum(['passed', 'failed', 'skipped', 'pending', 'todo']) })
      )
    })
  )
})

export function parseVitest(text: string): { tests: TestCounts; successful: boolean } {
  const data = vitestSchema.parse(JSON.parse(text))
  if (!data.numTotalTests || !data.testResults.length) throw new Error('没有执行任何测试，不能标为通过。')
  const assertions = data.testResults.flatMap((file) => file.assertionResults)
  if (assertions.length !== data.numTotalTests) throw new Error('Vitest 总数与断言明细不一致。')
  if (data.numPassedTests + data.numFailedTests + data.numPendingTests + data.numTodoTests !== data.numTotalTests) {
    throw new Error('Vitest 计数不完整。')
  }
  const statusCounts = { passed: 0, failed: 0, skipped: 0, pending: 0, todo: 0 }
  for (const assertion of assertions) statusCounts[assertion.status]++
  if (
    statusCounts.passed !== data.numPassedTests ||
    statusCounts.failed !== data.numFailedTests ||
    statusCounts.skipped + statusCounts.pending !== data.numPendingTests ||
    statusCounts.todo !== data.numTodoTests
  )
    throw new Error('Vitest 汇总与逐项状态不一致。')
  return {
    tests: {
      passed: data.numPassedTests,
      failed: data.numFailedTests,
      skipped: statusCounts.skipped,
      pending: statusCounts.pending + statusCounts.todo
    },
    successful:
      data.success &&
      data.numPassedTests > 0 &&
      data.numFailedTests === 0 &&
      data.numFailedTestSuites === 0 &&
      statusCounts.pending === 0 &&
      data.testResults.every((file) => file.status === 'passed')
  }
}

const goEvent = z.object({ Action: z.string(), Package: z.string().optional(), Test: z.string().optional() })

export function parseGo(text: string): { tests: TestCounts; successful: boolean } {
  const outcomes = new Map<string, string>()
  const packages = new Map<string, string>()
  const started = new Set<string>()
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    const event = goEvent.parse(JSON.parse(line))
    if (event.Action === 'run' && event.Test && event.Package) started.add(`${event.Package}\0${event.Test}`)
    if (!['pass', 'fail', 'skip'].includes(event.Action)) continue
    if (!event.Package) throw new Error('Go 测试事件缺少 package。')
    if (event.Test) {
      const key = `${event.Package}\0${event.Test}`
      if (outcomes.has(key)) throw new Error('Go 测试终态重复，拒绝重复计数。')
      outcomes.set(key, event.Action)
    } else packages.set(event.Package, event.Action)
  }
  if (!outcomes.size || !packages.size) throw new Error('Go 测试没有完整结果。')
  for (const key of started) if (!outcomes.has(key)) throw new Error('Go 测试存在没有终态的用例。')
  for (const key of outcomes.keys()) if (!packages.has(key.split('\0')[0])) throw new Error('Go 包结果不完整。')
  const tests = { passed: 0, failed: 0, skipped: 0, pending: 0 }
  for (const action of outcomes.values()) {
    if (action === 'pass') tests.passed++
    else if (action === 'fail') tests.failed++
    else tests.skipped++
  }
  return { tests, successful: tests.passed > 0 && tests.failed === 0 && ![...packages.values()].includes('fail') }
}

const attachmentCases = [
  'oversized PNG file URL',
  'oversized JPEG data URL',
  'multi-file PNG + JPEG + text',
  'native 9.9MB PDF read and large event',
  'product client consumes native large PDF event',
  'native compaction strips base64 and retains recent turns / paths',
  'failed native compaction never reports success / hides history',
  'empty native compaction is discarded without losing original context',
  'loopback mock / native still healthy'
]

export function parseNativeSmoke(text: string, attachments: boolean): { tests: TestCounts; successful: boolean } {
  if (!attachments) {
    if (!/^PASS OpenCode [\d.]+:.*zero paid requests/m.test(text))
      throw new Error('原生 smoke 缺少最终工具链完成证据。')
    return { tests: { passed: 1, failed: 0, skipped: 0, pending: 0 }, successful: true }
  }
  const results = text.split(/\r?\n/).filter((line) => line.startsWith('RESULT '))
  if (results.length !== 1) throw new Error('原生附件 smoke 缺少唯一结构化结果。')
  const data = z
    .object({
      version: z.string().min(1),
      paidRequests: z.literal(0),
      mockRequests: z.number().int().positive(),
      results: z.array(z.object({ name: z.string(), status: z.enum(['PASS', 'FAIL']) })).min(1)
    })
    .parse(JSON.parse(results[0].slice(7)))
  const names = new Set(data.results.map((result) => result.name))
  if (names.size !== data.results.length || attachmentCases.some((name) => !names.has(name)))
    throw new Error('原生附件 smoke 有缺失或重复场景。')
  const passed = data.results.filter((result) => result.status === 'PASS').length
  const failed = data.results.length - passed
  return { tests: { passed, failed, skipped: 0, pending: 0 }, successful: failed === 0 }
}
