export type InternalDataPathMigrationResult<T> = {
  value: T
  changed: boolean
}

type InternalDataPathMigrationOptions = {
  appDataDirNames?: string[]
}

const DEFAULT_APP_DATA_DIR_NAMES = ['zen-ai', 'ZenAIDev', 'zen-aiDev', 'CherryStudio', 'Cherry Studio']

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function normalizeSlashes(value: string, separator: '/' | '\\'): string {
  return value.replace(/[\\/]+/g, separator)
}

function trimTrailingSeparators(value: string): string {
  return value.replace(/[\\/]+$/, '')
}

function uniqueValues(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function getAppDataDirNames(currentUserDataPath: string, options?: InternalDataPathMigrationOptions): string[] {
  const currentName = trimTrailingSeparators(currentUserDataPath).split(/[\\/]/).pop()
  return uniqueValues([...(options?.appDataDirNames ?? DEFAULT_APP_DATA_DIR_NAMES), currentName ?? ''])
}

function hasMigrationCandidate(value: string, appDataDirNames: string[]): boolean {
  if (!value.includes('Data')) {
    return false
  }

  const lowerValue = value.toLowerCase()
  return appDataDirNames.some((name) => lowerValue.includes(name.toLowerCase()))
}

function replaceWithPatterns(value: string, currentUserDataPath: string, appDataDirNames: string[]): string {
  const namesPattern = appDataDirNames.map(escapeRegExp).join('|')
  const currentDataBackslash = `${normalizeSlashes(trimTrailingSeparators(currentUserDataPath), '\\')}\\Data`
  const currentDataSlash = `${normalizeSlashes(trimTrailingSeparators(currentUserDataPath), '/')}/Data`
  const currentDataEscaped = currentDataBackslash.replace(/\\/g, '\\\\')
  const windowsSegment = '[^\\\\/"<>|\\r\\n]+'
  const posixSegment = `[^/"'<>|\\r\\n]+`

  const windowsBackslash = new RegExp(
    `(?<![A-Za-z])[A-Za-z]:\\\\(?:${windowsSegment}\\\\){0,16}(?:${namesPattern})\\\\Data(?=\\\\|$)`,
    'gi'
  )
  const windowsSlash = new RegExp(
    `(?<![A-Za-z])[A-Za-z]:/(?:${windowsSegment}/){0,16}(?:${namesPattern})/Data(?=/|$)`,
    'gi'
  )
  const windowsEscaped = new RegExp(
    `(?<![A-Za-z])[A-Za-z]:(?:\\\\\\\\)(?:[^"<>|\\\\\\r\\n]+(?:\\\\\\\\)){0,16}(?:${namesPattern})(?:\\\\\\\\)Data(?=(?:\\\\\\\\)|$)`,
    'gi'
  )
  const posixFileUrl = new RegExp(`file://(/(?:${posixSegment}/){0,32}(?:${namesPattern})/Data)(?=/|$)`, 'gi')
  const posix = new RegExp(`(^|[\\s"'(=])(/(?:${posixSegment}/){0,32}(?:${namesPattern})/Data)(?=/|$)`, 'gi')

  return value
    .replace(windowsEscaped, currentDataEscaped)
    .replace(windowsBackslash, currentDataBackslash)
    .replace(windowsSlash, currentDataSlash)
    .replace(posixFileUrl, `file://${currentDataSlash}`)
    .replace(posix, (_match, prefix) => `${prefix}${currentDataSlash}`)
}

export function migrateInternalDataPathsInString(
  value: string,
  currentUserDataPath: string,
  options?: InternalDataPathMigrationOptions
): InternalDataPathMigrationResult<string> {
  if (!value || !currentUserDataPath) {
    return { value, changed: false }
  }

  const appDataDirNames = getAppDataDirNames(currentUserDataPath, options)
  if (!hasMigrationCandidate(value, appDataDirNames)) {
    return { value, changed: false }
  }

  const migrated = replaceWithPatterns(value, currentUserDataPath, appDataDirNames)
  return { value: migrated, changed: migrated !== value }
}

export function migrateInternalDataPathsDeep<T>(
  value: T,
  currentUserDataPath: string,
  options?: InternalDataPathMigrationOptions
): InternalDataPathMigrationResult<T> {
  let changed = false

  const visit = (input: unknown): unknown => {
    if (typeof input === 'string') {
      const result = migrateInternalDataPathsInString(input, currentUserDataPath, options)
      changed ||= result.changed
      return result.value
    }

    if (Array.isArray(input)) {
      return input.map((item) => visit(item))
    }

    if (isPlainObject(input)) {
      const output: Record<string, unknown> = {}
      for (const [key, item] of Object.entries(input)) {
        output[key] = visit(item)
      }
      return output
    }

    return input
  }

  return { value: visit(value) as T, changed }
}
