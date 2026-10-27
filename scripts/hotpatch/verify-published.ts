import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'

import { verifyPublishedArtifact } from './artifact'

async function main() {
  const { values } = parseArgs({ options: { publication: { type: 'string' } } })
  if (!values.publication) throw new Error('Missing --publication')
  const record = JSON.parse(await readFile(values.publication, 'utf8'))
  if (!/^[a-f0-9]{64}$/.test(record.manifestSha256)) throw new Error('Invalid publication digest')
  const artifact = await verifyPublishedArtifact(record.manifestUrl, record.manifestSha256)
  if (
    record.patchId !== artifact.patchId ||
    record.baseId !== artifact.base.baseBuildId ||
    record.archiveSha256 !== artifact.archive.sha256
  )
    throw new Error('Publication receipt differs from signed metadata')
  process.stdout.write(`Verified immutable HTTPS publication ${artifact.patchId} for ${artifact.base.baseBuildId}.\n`)
}
main().catch((error) => {
  process.stderr.write(`${String(error)}\n`)
  process.exitCode = 1
})
