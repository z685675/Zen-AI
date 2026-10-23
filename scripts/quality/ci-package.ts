import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { auditPackage } from './package-audit'
import { redact } from './process'

const root = path.resolve(__dirname, '../..')
Promise.resolve()
  .then(async () => {
    const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux'
    const directory =
      platform === 'windows'
        ? 'win-unpacked/resources'
        : platform === 'mac'
          ? `${process.arch === 'arm64' ? 'mac-arm64' : 'mac'}/Zen AI.app/Contents/Resources`
          : 'linux-unpacked/resources'
    const result = await auditPackage(root, {
      resources: path.join(root, 'dist', directory),
      platform,
      arch: process.arch as 'x64' | 'arm64',
      expectedVersion: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
      ...(platform === 'mac'
        ? { bundle: path.join(root, 'dist', process.arch === 'arm64' ? 'mac-arm64' : 'mac', 'Zen AI.app') }
        : {})
    })
    const reports = path.join(root, 'local/quality-reports', `package-${Date.now()}`)
    await mkdir(reports, { recursive: true })
    await writeFile(path.join(reports, 'package-audit.json'), JSON.stringify(result, null, 2))
  })
  .catch(async (error) => {
    const reports = path.join(root, 'local/quality-reports', `package-failed-${Date.now()}`)
    await mkdir(reports, { recursive: true })
    await writeFile(
      path.join(reports, 'package-audit.json'),
      JSON.stringify(
        { status: 'failed', platform: process.platform, arch: process.arch, detail: redact(String(error)) },
        null,
        2
      )
    )
    process.stderr.write(redact(String(error)) + '\n')
    process.exitCode = 1
  })
