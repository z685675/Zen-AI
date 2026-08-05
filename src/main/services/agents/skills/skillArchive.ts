/**
 * Validate a ZIP entry before extracting a user-provided Skill archive.
 * ZIP entries are archive-relative paths; absolute paths and parent traversal
 * must never be allowed to escape the temporary extraction directory.
 */
export function assertSafeSkillArchiveEntry(entryName: string): void {
  const normalized = entryName.replaceAll('\\', '/')

  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new Error(`Unsafe ZIP entry path: ${entryName}`)
  }
}
