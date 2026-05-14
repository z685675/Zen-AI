/**
 * Parse the current version from `openclaw --version` output.
 * Example input: "OpenClaw 2026.3.9 (fe96034)"
 */
export function parseCurrentVersion(versionOutput: string): string | null {
  const match = versionOutput.match(/OpenClaw\s+([\d.]+)/i)
  return match?.[1] ?? null
}

/**
 * Parse the update status from `openclaw update status` output.
 * Returns the latest version string if a binary update is available, otherwise null.
 */
export function parseUpdateStatus(statusOutput: string): string | null {
  const tableMatch = statusOutput.match(/available[^\n]*\bbinary\b[^\n]*?(\d+(?:\.\d+)+)/i)
  if (tableMatch) return tableMatch[1]

  const summaryMatch = statusOutput.match(/Update available\s*\(binary\s+([\d.]+)\)/i)
  if (summaryMatch) return summaryMatch[1]

  return null
}
