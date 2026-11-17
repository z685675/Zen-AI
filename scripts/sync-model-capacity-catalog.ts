import fs from 'node:fs/promises'
import path from 'node:path'

import { MODEL_CAPACITY_SOURCE_ENDPOINT, normalizeModelCapacityCatalog } from '../packages/shared/modelCapacity'

// Optional snapshot refresh for release preparation. Running clients refresh independently.
async function main(): Promise<void> {
  const response = await fetch(MODEL_CAPACITY_SOURCE_ENDPOINT, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`Model capacity catalog HTTP ${response.status}`)
  const snapshot = normalizeModelCapacityCatalog(await response.json(), new Date().toISOString())
  snapshot.models = Object.fromEntries(Object.entries(snapshot.models).sort(([a], [b]) => a.localeCompare(b)))
  const checkOnly = process.argv.includes('--check')
  if (!checkOnly) {
    await fs.writeFile(
      path.resolve(__dirname, '../packages/shared/config/modelCapacitySnapshot.json'),
      `${JSON.stringify(snapshot, null, 2)}\n`
    )
  }
  process.stdout.write(
    `${checkOnly ? 'Validated' : 'Updated bundled'} capacities for ${Object.keys(snapshot.models).length} canonical models.\n`
  )
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
