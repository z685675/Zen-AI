import fs from 'node:fs/promises'
import path from 'node:path'

/** Prepare a real bundled installation: no runtime npm registry downloads. */
export async function prepareOpenCodeOfflineConfig(root: string, bundle: string): Promise<void> {
  const config = path.join(root, 'config', 'opencode')
  const modules = path.join(bundle, 'node_modules')
  // Fail early with an actionable dev instruction, rather than quietly doing
  // a network install while the user is waiting for a greeting.
  await fs.access(path.join(modules, '@opencode-ai', 'plugin', 'package.json')).catch(() => {
    throw new Error(
      'OpenCode offline dependencies are missing. Run pnpm runtime:opencode before development or rebuild the installer.'
    )
  })
  await fs.mkdir(config, { recursive: true })
  for (const name of ['package.json', 'package-lock.json'])
    await fs.copyFile(path.join(bundle, name), path.join(config, name))
  await fs.writeFile(
    path.join(config, '.gitignore'),
    'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n'
  )
  const target = path.join(config, 'node_modules')
  const existing = await fs.lstat(target).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  })
  if (existing?.isSymbolicLink()) {
    if ((await fs.realpath(target).catch(() => '')) === (await fs.realpath(modules))) return
    // Remove only our app-owned junction, never the installed dependency tree.
    await fs.unlink(target)
  } else if (existing) {
    throw new Error('Unexpected native assistant dependency directory; refusing to replace it automatically')
  }
  await fs.symlink(modules, target, process.platform === 'win32' ? 'junction' : 'dir')
}
