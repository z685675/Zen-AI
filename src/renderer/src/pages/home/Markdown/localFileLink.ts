/** Only local, absolute paths may use the file IPC. Never pass URL schemes or shares to the shell. */
export function localFilePath(href: string): string | undefined {
  if (!href || /[\0\r\n]/.test(href)) return
  let value = href
  try {
    if (/^file:/i.test(value)) {
      const url = new URL(value)
      if (url.hostname && url.hostname !== 'localhost') return
      if (url.username || url.password || url.port || url.search || url.hash) return
      value = url.pathname
      if (/^\/[a-z]:\//i.test(value)) value = value.slice(1)
    }
    value = decodeURIComponent(value)
  } catch {
    return
  }
  if (/[\0\r\n]/.test(value) || (value.includes('\\') && !/^[a-z]:[\\/]/i.test(value))) return
  if (/^[a-z]:[\\/]/i.test(value)) return value.replace(/\\/g, '/')
  if (value.startsWith('/') && !value.startsWith('//')) return value
  return
}
