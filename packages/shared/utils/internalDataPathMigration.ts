type InternalDataPathMigrationResult = {
  value: string
  changed: boolean
}

type InternalDataPathMigrationOptions = {
  appDataDirNames?: string[]
}

const DEFAULT_APP_DATA_DIR_NAMES = ['zen-ai', 'ZenAIDev', 'zen-aiDev', 'CherryStudio', 'Cherry Studio']
const DRIVE = /^[A-Za-z]:/

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function pathPatterns(currentUserDataPath: string, wholeValue: boolean, options?: InternalDataPathMigrationOptions) {
  const destination = currentUserDataPath.replace(/[\\/]+$/, '')
  const currentName = destination.split(/[\\/]/).pop()
  const names = [...(options?.appDataDirNames ?? DEFAULT_APP_DATA_DIR_NAMES), currentName].filter(
    (name): name is string => Boolean(name)
  )
  const escapedNames = [...new Set(names.flatMap((name) => [name, encodeURIComponent(name)]))].map(escapeRegExp)
  const app = '(?:' + escapedNames.join('|') + ')'
  const windowsSegment = String.raw`[^\\/"<>|\r\n]+`
  const posixSegment = wholeValue ? String.raw`[^\\/\r\n]+` : String.raw`[^\\/"'<>|\r\n]+`
  const backslash = String.raw`\\`
  const escapedSlash = backslash.repeat(2)
  const root = [
    ...[escapedSlash, backslash, '/'].map(
      (separator) => '[A-Za-z]:' + separator + '(?:' + windowsSegment + separator + '){0,16}' + app + separator + 'Data'
    ),
    '/(?:' + posixSegment + '/){0,32}' + app + '/Data',
    // Older restores could encode a POSIX root with Windows separators.
    ...(!DRIVE.test(destination) && destination.startsWith('/')
      ? [escapedSlash, backslash].map(
          (separator) => separator + '(?:' + posixSegment + separator + '){0,32}' + app + separator + 'Data'
        )
      : [])
  ].join('|')
  const source = '(?:(?<url>file://)(?:/(?=[A-Za-z]:))?)?(?<root>' + root + ')'

  return { names, destination, source }
}

function rewritePath(root: string, suffix: string, destination: string, url: boolean): string {
  const normalized = destination.replace(/\\/g, '/')
  if (url) {
    const pathname = normalized.startsWith('//')
      ? normalized.slice(2)
      : DRIVE.test(normalized)
        ? '/' + normalized
        : normalized
    const encodeSegment = (segment: string) => (/^[A-Za-z]:$/.test(segment) ? segment : encodeURIComponent(segment))
    return 'file://' + pathname.split('/').map(encodeSegment).join('/') + '/Data' + suffix.replace(/\\+/g, '/')
  }
  if (!root.includes('\\')) return normalized + '/Data' + suffix
  const escaped = root.includes('\\\\')
  const target =
    DRIVE.test(normalized) || normalized.startsWith('//')
      ? normalized.replace(/\//g, '\\') + '\\Data' + (escaped ? suffix.replace(/\\\\/g, '\\') : suffix)
      : normalized + '/Data' + suffix.replace(/\\+/g, '/')
  return escaped ? JSON.stringify(target).slice(1, -1) : target
}

/** A complete path/URL from a typed storage field. */
export function migrateInternalDataPath(
  value: string,
  currentUserDataPath: string,
  options?: InternalDataPathMigrationOptions
): InternalDataPathMigrationResult {
  return migrate(value, currentUserDataPath, options, true)
}

/** Paths embedded in legacy SQLite JSON values or Markdown links. */
export function migrateInternalDataPathsInString(
  value: string,
  currentUserDataPath: string,
  options?: InternalDataPathMigrationOptions
): InternalDataPathMigrationResult {
  return migrate(value, currentUserDataPath, options)
}

function migrate(
  value: string,
  currentUserDataPath: string,
  options?: InternalDataPathMigrationOptions,
  wholeValue = false
): InternalDataPathMigrationResult {
  if (!value || !currentUserDataPath || !value.includes('Data')) return { value, changed: false }
  const { names, destination, source } = pathPatterns(currentUserDataPath, wholeValue, options)
  const lower = value.toLowerCase()
  if (
    !names.some((name) => lower.includes(name.toLowerCase()) || lower.includes(encodeURIComponent(name).toLowerCase()))
  )
    return { value, changed: false }

  const pattern = wholeValue
    ? new RegExp('^' + source + String.raw`(?<suffix>[/\\][\s\S]*)?$`, 'i')
    : new RegExp(
        String.raw`(?<prefix>^|[\s"'(<\[=])` +
          source +
          String.raw`(?<suffix>[/\\][^"'\r\n<>|)\]}]*)?(?=$|[\s"')>\]},;])`,
        'gi'
      )
  const migrated = value.replace(pattern, (...args: unknown[]) => {
    const { root, prefix = '', suffix = '', url } = args.at(-1) as Record<string, string | undefined>
    return prefix + rewritePath(root!, suffix, destination, Boolean(url))
  })
  return { value: migrated, changed: migrated !== value }
}
