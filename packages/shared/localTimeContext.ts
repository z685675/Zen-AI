export interface LocalTimeSnapshot {
  localDateTime: string
  timeZone: string
  utcOffset: string
}

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? ''
}

export function getLocalTimeSnapshot(
  now: Date = new Date(),
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
): LocalTimeSnapshot {
  const dateParts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(now)
  const offsetParts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset'
  }).formatToParts(now)

  return {
    localDateTime: `${getPart(dateParts, 'year')}-${getPart(dateParts, 'month')}-${getPart(dateParts, 'day')} ${getPart(dateParts, 'hour')}:${getPart(dateParts, 'minute')}:${getPart(dateParts, 'second')}`,
    timeZone,
    utcOffset: getPart(offsetParts, 'timeZoneName') || 'UTC offset unavailable'
  }
}

export function buildCurrentLocalTimeContext(now?: Date, timeZone?: string): string {
  const snapshot = getLocalTimeSnapshot(now, timeZone)

  return [
    '## Current Local Time',
    `- Request time: ${snapshot.localDateTime}`,
    `- Time zone: ${snapshot.timeZone} (${snapshot.utcOffset})`,
    '- Interpret "today", "now", "current", and "latest" using this request time.',
    '- Keep request time separate from each source publication/update timestamp. Never label a source timestamp as the request or retrieval time.',
    '- For rapidly changing rankings, hot lists, market quotes, weather, and similar live data, treat a source older than 30 minutes as potentially stale: try another source and clearly disclose the age if no fresher source is available.',
    '- For official daily reference data, the latest available value may be from the prior business day; state that data date explicitly.'
  ].join('\n')
}
