import { describe, expect, it } from 'vitest'

import { buildCurrentLocalTimeContext, getLocalTimeSnapshot } from './localTimeContext'

describe('localTimeContext', () => {
  const now = new Date('2026-07-31T16:25:30.000Z')

  it('formats the request time in the selected local time zone', () => {
    expect(getLocalTimeSnapshot(now, 'Asia/Shanghai')).toEqual({
      localDateTime: '2026-08-01 00:25:30',
      timeZone: 'Asia/Shanghai',
      utcOffset: 'GMT+08:00'
    })
  })

  it('tells the runtime to distinguish request time from source time', () => {
    const context = buildCurrentLocalTimeContext(now, 'Asia/Shanghai')

    expect(context).toContain('Request time: 2026-08-01 00:25:30')
    expect(context).toContain('Never label a source timestamp as the request or retrieval time')
    expect(context).toContain('older than 30 minutes as potentially stale')
  })
})
