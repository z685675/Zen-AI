import type { WorkBook } from '@e965/xlsx'
import { describe, expect, it } from 'vitest'

import { SpreadsheetExtractionLimitError, spreadsheetSections } from '../spreadsheetSections'

describe('bounded sparse spreadsheet extraction', () => {
  it('ignores a whole-grid used range and preserves distant actual cells without expanding empty space', () => {
    const workbook: WorkBook = {
      SheetNames: ['Data'],
      Sheets: {
        Data: {
          '!ref': 'A1:XFD1048576',
          A1: { t: 's', v: 'Header' },
          B2: { t: 'n', v: 0 },
          XFD1048576: { t: 'n', v: 42, f: 'SUM(B2:B3)' }
        }
      }
    }
    const sections = spreadsheetSections(workbook, [])
    const text = sections.map((section) => section.text).join('\n')
    expect(sections).toHaveLength(1)
    expect(text).toContain('B2: 0')
    expect(text).toContain('XFD1048576: =SUM(B2:B3) [结果: 42]')
    expect(text.length).toBeLessThan(1000)
  })

  it('keeps real row numbers across distant rows in ordinary-width tables', () => {
    const workbook: WorkBook = {
      SheetNames: ['Data'],
      Sheets: {
        Data: {
          '!ref': 'A1:B1048576',
          A1: { t: 's', v: 'Header' },
          B1048576: { t: 'b', v: false }
        }
      }
    }
    expect(spreadsheetSections(workbook, [])[0].text).toContain('| 1048576 |  | false |')
  })

  it('stops excessive extracted content instead of returning a silently partial workbook', () => {
    const workbook: WorkBook = {
      SheetNames: ['Data'],
      Sheets: {
        Data: {
          A1: { t: 's', v: 'x'.repeat(2_000_001) }
        }
      }
    }
    expect(() => spreadsheetSections(workbook, [])).toThrow(SpreadsheetExtractionLimitError)
  })
})
