import { readFile } from 'node:fs/promises'
import path from 'node:path'

import { previewAcceptance, runAcceptance } from './acceptance'

// This CI command accepts no arbitrary config/key. Only the committed zero-paid batch is allowed.
const root = path.resolve(__dirname, '../..')
Promise.resolve()
  .then(async () => {
    if (!process.env.npm_execpath) throw new Error('请通过pnpm quality:ci启动，确保子检查使用当前pnpm入口。')
    const config = JSON.parse(await readFile(path.join(root, 'tests/quality/acceptance.offline.json'), 'utf8'))
    if (config.requireRealModels || config.liveConfig) throw new Error('Offline CI refuses paid configuration')
    const plan = await previewAcceptance(config, root)
    return runAcceptance(config, root, { dryRun: false, approval: plan.approvalDigest })
  })
  .then(({ exitCode }) => {
    process.exitCode = exitCode
  })
  .catch((error) => {
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
  })
