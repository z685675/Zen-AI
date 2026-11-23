export function createModelLatencyFormatter(locale: string) {
  const secondUnit = { style: 'unit', unit: 'second', unitDisplay: 'narrow' } as const
  const seconds = new Intl.NumberFormat(locale, { ...secondUnit, maximumFractionDigits: 1 })
  const subsecond = new Intl.NumberFormat(locale, { ...secondUnit, maximumFractionDigits: 3 })
  const minutes = new Intl.NumberFormat(locale, { style: 'unit', unit: 'minute', unitDisplay: 'narrow' })

  return (milliseconds: number | null): Intl.NumberFormatPart[] => {
    if (milliseconds === null) return [{ type: 'literal', value: '—' }]
    if (milliseconds < 1000) return subsecond.formatToParts(milliseconds / 1000)

    const roundedSeconds = Math.round(milliseconds / 100) / 10
    if (roundedSeconds < 60) return seconds.formatToParts(roundedSeconds)

    const wholeSeconds = Math.round(milliseconds / 1000)
    const minuteParts = minutes.formatToParts(Math.floor(wholeSeconds / 60))
    const secondsLeft = wholeSeconds % 60
    if (secondsLeft === 0) return minuteParts
    return [...minuteParts, { type: 'literal', value: ' ' }, ...seconds.formatToParts(secondsLeft)]
  }
}
