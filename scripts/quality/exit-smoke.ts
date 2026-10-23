// Repeated real-process shutdown checks. No model or external network requests.
import assert from 'node:assert/strict'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { closeIsolated, launchIsolated } from './electron'

export async function exitSmoke(root: string, directory: string, iterations = 5) {
  assert(Number.isInteger(iterations) && iterations >= 1 && iterations <= 20)
  const results: Array<{ iteration: number; exitCode: number | null; cleanupMs: number }> = []
  await mkdir(directory, { recursive: true })
  for (let iteration = 1; iteration <= iterations; iteration++) {
    const target = path.join(directory, `startup-${iteration}`)
    const instance = await launchIsolated(root, target)
    const child = instance.application.process()
    const started = performance.now()
    await closeIsolated(instance.application)
    assert.equal(child.exitCode, 0, 'Real application did not exit normally')
    assert.equal(child.signalCode, null, 'Real application exited through a signal')
    const logs = path.join(instance.instance, 'userData', 'logs')
    const records = (
      await Promise.all(
        (
          await readdir(logs)
        )
          .filter((name) => /^app\.\d{4}-\d{2}-\d{2}\.log$/.test(name))
          .map((name) => readFile(path.join(logs, name), 'utf8'))
      )
    )
      .join('\n')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const steps = records.filter((record) => record.message === 'Application cleanup step')
    assert(steps.length > 0, 'No flushed cleanup evidence; exit zero alone is insufficient')
    for (const step of steps.filter((step) => step.state === 'started')) {
      assert(
        steps.some((record) => record.service === step.service && record.state === 'completed'),
        `Missing cleanup completion: ${step.service}`
      )
    }
    assert.equal(steps.at(-1)?.service, 'assistant-database', 'Database must be the last service to close')
    assert.equal(steps.at(-1)?.state, 'completed')
    const result = { iteration, exitCode: child.exitCode, cleanupMs: Math.round(performance.now() - started) }
    results.push(result)
    await writeFile(path.join(directory, 'exit-results.json'), JSON.stringify({ paidRequests: 0, results }, null, 2))
    process.stdout.write(`PASS shutdown ${iteration}/${iterations}: exit 0, all cleanup stages flushed\n`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const directory = path.resolve('local/quality-reports', `exit-${Date.now()}`)
  exitSmoke(path.resolve(__dirname, '../..'), directory, Number(process.argv[2] ?? 5)).catch((error) => {
    process.stderr.write(`${String(error)}\n证据：${directory}\n`)
    process.exitCode = 1
  })
}
