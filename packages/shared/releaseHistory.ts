import { rcompare, valid } from 'semver'

export interface ReleaseHistoryEntry {
  version: string
  releaseDate: string | null
  notes: string
}

export interface ReleaseHistoryData {
  schemaVersion: 1
  updatedAt: string
  entries: ReleaseHistoryEntry[]
}

export interface ReleaseHistorySnapshot {
  currentVersion: string
  entries: ReleaseHistoryEntry[]
  refreshedAt: string | null
  refreshFailed: boolean
}

export const RELEASE_HISTORY_MAX_BYTES = 5 * 1024 * 1024

export function isStableReleaseVersion(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 32 && /^\d+\.\d+\.\d+$/.test(value) && Boolean(valid(value))
}

export function readReleaseHistory(value: unknown): ReleaseHistoryData | undefined {
  if (!value || typeof value !== 'object') return
  const data = value as Partial<ReleaseHistoryData>
  if (
    data.schemaVersion !== 1 ||
    typeof data.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(data.updatedAt)) ||
    !Array.isArray(data.entries) ||
    data.entries.length > 500
  )
    return
  const seen = new Set<string>()
  const entries: ReleaseHistoryEntry[] = []
  for (const entry of data.entries) {
    if (
      !entry ||
      !isStableReleaseVersion(entry.version) ||
      seen.has(entry.version) ||
      typeof entry.releaseDate !== 'string' ||
      !Number.isFinite(Date.parse(entry.releaseDate)) ||
      typeof entry.notes !== 'string' ||
      entry.notes.length > 128 * 1024
    )
      return
    seen.add(entry.version)
    entries.push({ version: entry.version, releaseDate: entry.releaseDate, notes: entry.notes })
  }
  return {
    schemaVersion: 1,
    updatedAt: data.updatedAt,
    entries: entries.sort((a, b) => rcompare(a.version, b.version))
  }
}

export function mergeReleaseHistory(...groups: ReleaseHistoryEntry[][]): ReleaseHistoryEntry[] {
  const entries = new Map<string, ReleaseHistoryEntry>()
  for (const group of groups) for (const entry of group) entries.set(entry.version, entry)
  return [...entries.values()].sort((a, b) => rcompare(a.version, b.version))
}
