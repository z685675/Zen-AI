import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Query an existing directory; do not change the volume's short-name settings.
export async function shortDirectory(directory: string) {
  const { stdout } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
      (New-Object -ComObject Scripting.FileSystemObject).GetFolder('${directory.replaceAll("'", "''")}').ShortPath`
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 }
  )
  const alias = stdout.trim()
  if (!alias.includes('~') || (await realpath(alias)) !== (await realpath(directory))) {
    throw new Error('The Windows installer regression requires an 8.3 alias for its temporary fixture directory')
  }
  return alias
}
