import AdmZip from 'adm-zip'

export type WorkbookPrimitive = string | number | boolean | null
export type WorkbookCellStyle =
  | 'normal'
  | 'header'
  | 'title'
  | 'section'
  | 'percent'
  | 'integer'
  | 'duration'
  | 'wrap'
  | 'center'
  | 'pass'
  | 'fail'
  | 'warning'

export interface WorkbookCellInput {
  value?: WorkbookPrimitive
  formula?: string
  result?: WorkbookPrimitive
  style?: WorkbookCellStyle
}

export interface WorkbookConditionalFormatInput {
  range?: string
  operator?: 'equal' | 'notEqual' | 'greaterThan' | 'lessThan' | 'greaterThanOrEqual' | 'lessThanOrEqual'
  value?: string | number
  style?: 'pass' | 'fail' | 'warning'
}

export interface WorkbookChartSeriesInput {
  name?: string
  categories?: string[]
  values?: number[]
  category_range?: string
  value_range?: string
  color?: string
}

export interface WorkbookChartInput {
  type?: 'column' | 'bar' | 'line'
  title?: string
  series?: WorkbookChartSeriesInput[]
  from_col?: number
  from_row?: number
  to_col?: number
  to_row?: number
}

export interface WorkbookSheetInput {
  name?: string
  rows?: Array<Array<WorkbookPrimitive | WorkbookCellInput>>
  header_rows?: number
  freeze_rows?: number
  freeze_columns?: number
  auto_filter?: boolean | string
  column_widths?: number[]
  merges?: string[]
  conditional_formats?: WorkbookConditionalFormatInput[]
  charts?: WorkbookChartInput[]
}

export interface WorkbookInput {
  creator?: string
  sheets?: WorkbookSheetInput[]
}

interface NormalizedCell {
  value: WorkbookPrimitive
  formula?: string
  result?: WorkbookPrimitive
  style?: WorkbookCellStyle
}

interface NormalizedConditionalFormat {
  range: string
  operator: NonNullable<WorkbookConditionalFormatInput['operator']>
  value: string | number
  style: 'pass' | 'fail' | 'warning'
}

interface NormalizedChartSeries {
  name: string
  categories: string[]
  values: number[]
  categoryRange?: string
  valueRange?: string
  color: string
}

interface NormalizedChart {
  type: 'column' | 'bar' | 'line'
  title: string
  series: NormalizedChartSeries[]
  showDataLabels: boolean
  fromCol: number
  fromRow: number
  toCol: number
  toRow: number
}

interface NormalizedSheet {
  name: string
  rows: NormalizedCell[][]
  headerRows: number
  freezeRows: number
  freezeColumns: number
  autoFilter?: string
  columnWidths: number[]
  merges: string[]
  conditionalFormats: NormalizedConditionalFormat[]
  charts: NormalizedChart[]
}

interface NormalizedWorkbook {
  title: string
  creator: string
  sheets: NormalizedSheet[]
}

const MAX_SHEETS = 20
const MAX_ROWS = 5000
const MAX_COLUMNS = 100
const MAX_CHARTS_PER_SHEET = 4
const STYLE_IDS: Record<WorkbookCellStyle, number> = {
  normal: 12,
  header: 1,
  title: 2,
  section: 3,
  percent: 4,
  integer: 5,
  duration: 6,
  wrap: 7,
  center: 8,
  pass: 9,
  fail: 10,
  warning: 11
}
const CHART_COLORS = ['2563EB', '059669', 'D97706', '7C3AED', 'DC2626', '0891B2']
const CELL_RANGE_RE = /^\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?$/
const FORMULA_RANGE_REF_RE =
  /(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)\s*:\s*\$?([A-Z]{1,3})\$?([1-9]\d*)/giu
const FORMULA_CELL_REF_RE = /(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)/giu

export function createXlsxBuffer(workbookInput: WorkbookInput | undefined, fallbackRows: string[][], title: string) {
  const workbook = normalizeWorkbook(workbookInput, fallbackRows, title)
  const zip = new AdmZip()
  const drawings: Array<{ sheetIndex: number; drawingIndex: number; charts: NormalizedChart[] }> = []
  let chartIndex = 0

  workbook.sheets.forEach((sheet, sheetIndex) => {
    if (!sheet.charts.length) return
    const drawingIndex = drawings.length + 1
    drawings.push({ sheetIndex, drawingIndex, charts: sheet.charts })
    chartIndex += sheet.charts.length
  })

  zip.addFile('[Content_Types].xml', toBuffer(createContentTypes(workbook.sheets.length, drawings, chartIndex)))
  zip.addFile('_rels/.rels', toBuffer(createRootRelationships()))
  zip.addFile('docProps/core.xml', toBuffer(createCoreProperties(workbook)))
  zip.addFile('docProps/app.xml', toBuffer(createAppProperties(workbook)))
  zip.addFile('xl/workbook.xml', toBuffer(createWorkbookXml(workbook)))
  zip.addFile('xl/_rels/workbook.xml.rels', toBuffer(createWorkbookRelationships(workbook.sheets.length)))
  zip.addFile('xl/styles.xml', toBuffer(XLSX_STYLES))

  let nextChartIndex = 1
  workbook.sheets.forEach((sheet, sheetIndex) => {
    const drawing = drawings.find((item) => item.sheetIndex === sheetIndex)
    zip.addFile(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      toBuffer(createWorksheetXml(sheet, drawing ? 'rId1' : undefined))
    )
    if (drawing) {
      zip.addFile(
        `xl/worksheets/_rels/sheet${sheetIndex + 1}.xml.rels`,
        toBuffer(createWorksheetRelationships(drawing.drawingIndex))
      )
      zip.addFile(
        `xl/drawings/drawing${drawing.drawingIndex}.xml`,
        toBuffer(createDrawingXml(drawing.charts, nextChartIndex))
      )
      zip.addFile(
        `xl/drawings/_rels/drawing${drawing.drawingIndex}.xml.rels`,
        toBuffer(createDrawingRelationships(drawing.charts.length, nextChartIndex))
      )
      drawing.charts.forEach((chart) => {
        zip.addFile(`xl/charts/chart${nextChartIndex}.xml`, toBuffer(createChartXml(chart, nextChartIndex)))
        nextChartIndex += 1
      })
    }
  })

  return zip.toBuffer()
}

function normalizeWorkbook(
  input: WorkbookInput | undefined,
  fallbackRows: string[][],
  title: string
): NormalizedWorkbook {
  const rawSheets =
    Array.isArray(input?.sheets) && input.sheets.length ? input.sheets : [{ name: 'Sheet1', rows: fallbackRows }]
  if (rawSheets.length > MAX_SHEETS) throw new Error(`Workbook supports at most ${MAX_SHEETS} sheets.`)

  const usedNames = new Set<string>()
  const sheets = rawSheets.map((sheet, index) => normalizeSheet(sheet, index, usedNames))
  validateFormulaDependencies(sheets)
  validateSimpleAggregateFormulaCaches(sheets)
  return {
    title: String(title || 'Workbook').slice(0, 200),
    creator: String(input?.creator || 'Zen AI').slice(0, 100),
    sheets
  }
}

interface FormulaCell {
  key: string
  sheet: string
  ref: string
  row: number
  column: number
  formula: string
}

function validateFormulaDependencies(sheets: NormalizedSheet[]) {
  const formulaCells: FormulaCell[] = []

  for (const sheet of sheets) {
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (!cell.formula) return
        const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`
        formulaCells.push({
          key: formulaCellKey(sheet.name, ref),
          sheet: sheet.name,
          ref,
          row: rowIndex + 1,
          column: columnIndex + 1,
          formula: cell.formula
        })
      })
    })
  }

  const formulaCellMap = new Map(formulaCells.map((cell) => [cell.key, cell]))
  const dependencies = new Map<string, Set<string>>()

  for (const cell of formulaCells) {
    const refs = new Set<string>()
    const formula = cell.formula.replace(/"(?:[^"]|"")*"/g, '')

    for (const match of formula.matchAll(FORMULA_RANGE_REF_RE)) {
      const sheetName = normalizeFormulaSheetName(match[1] ?? match[2] ?? cell.sheet)
      const startColumn = columnNumber(match[3])
      const startRow = Number(match[4])
      const endColumn = columnNumber(match[5])
      const endRow = Number(match[6])
      const minColumn = Math.min(startColumn, endColumn)
      const maxColumn = Math.max(startColumn, endColumn)
      const minRow = Math.min(startRow, endRow)
      const maxRow = Math.max(startRow, endRow)

      for (const candidate of formulaCells) {
        if (
          candidate.sheet.toLocaleLowerCase() === sheetName.toLocaleLowerCase() &&
          candidate.column >= minColumn &&
          candidate.column <= maxColumn &&
          candidate.row >= minRow &&
          candidate.row <= maxRow
        ) {
          refs.add(candidate.key)
        }
      }
    }

    const formulaWithoutRanges = formula.replace(FORMULA_RANGE_REF_RE, '')
    for (const match of formulaWithoutRanges.matchAll(FORMULA_CELL_REF_RE)) {
      const sheetName = normalizeFormulaSheetName(match[1] ?? match[2] ?? cell.sheet)
      const key = formulaCellKey(sheetName, `${match[3].toUpperCase()}${match[4]}`)
      if (formulaCellMap.has(key)) refs.add(key)
    }

    dependencies.set(cell.key, refs)
  }

  const state = new Map<string, 'visiting' | 'visited'>()
  const stack: string[] = []

  const visit = (key: string): string[] | null => {
    if (state.get(key) === 'visited') return null
    if (state.get(key) === 'visiting') {
      const cycleStart = stack.indexOf(key)
      return [...stack.slice(cycleStart), key]
    }

    state.set(key, 'visiting')
    stack.push(key)
    for (const dependency of dependencies.get(key) ?? []) {
      const cycle = visit(dependency)
      if (cycle) return cycle
    }
    stack.pop()
    state.set(key, 'visited')
    return null
  }

  for (const cell of formulaCells) {
    const cycle = visit(cell.key)
    if (!cycle) continue
    const path = cycle
      .map((key) => formulaCellMap.get(key))
      .filter((item): item is FormulaCell => Boolean(item))
      .map((item) => `'${item.sheet}'!${item.ref}`)
      .join(' -> ')
    throw new Error(`Circular formula reference detected: ${path}`)
  }
}

function normalizeFormulaSheetName(value: string) {
  return value.replace(/''/g, "'")
}

function formulaCellKey(sheetName: string, ref: string) {
  return `${sheetName.toLocaleLowerCase()}\u0000${ref.toUpperCase()}`
}

function columnNumber(value: string) {
  return value
    .toUpperCase()
    .split('')
    .reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0)
}

const SIMPLE_FORMULA_RANGE_RE =
  /^(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$/iu
const SIMPLE_FORMULA_CELL_RE = /^(?:(?:'((?:[^']|'')+)'|([\p{L}_][\p{L}\p{N}_.]*))!)?\$?([A-Z]{1,3})\$?([1-9]\d*)$/iu

function validateSimpleAggregateFormulaCaches(sheets: NormalizedSheet[]) {
  for (const sheet of sheets) {
    sheet.rows.forEach((row, rowIndex) => {
      row.forEach((cell, columnIndex) => {
        if (!cell.formula || typeof cell.result !== 'number') return
        const evaluated = evaluateSimpleSumFormula(cell.formula, sheet.name, sheets)
        if (evaluated === undefined) return
        const tolerance = Math.max(1e-8, Math.abs(evaluated) * 1e-9)
        if (Math.abs(evaluated - cell.result) <= tolerance) return
        const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`
        throw new Error(
          `Formula cached result mismatch at '${sheet.name}'!${ref}: expected ${evaluated}, received ${cell.result}. Check SUMIF/SUMIFS criteria labels and ranges.`
        )
      })
    })
  }
}

function evaluateSimpleSumFormula(
  formula: string,
  currentSheet: string,
  sheets: NormalizedSheet[]
): number | undefined {
  const match = formula.match(/^\s*(SUMIFS|SUMIF)\((.*)\)\s*$/i)
  if (!match || /[()]/.test(match[2])) return undefined
  const args = splitFormulaArguments(match[2])

  if (match[1].toUpperCase() === 'SUMIFS') {
    if (args.length < 3 || args.length % 2 === 0) return undefined
    const sumValues = resolveFormulaRangeValues(args[0], currentSheet, sheets)
    if (!sumValues) return undefined
    const criteria: Array<{ values: WorkbookPrimitive[]; expected: WorkbookPrimitive }> = []
    for (let index = 1; index < args.length; index += 2) {
      const values = resolveFormulaRangeValues(args[index], currentSheet, sheets)
      const expected = resolveFormulaCriterion(args[index + 1], currentSheet, sheets)
      if (!values || expected === undefined || values.length !== sumValues.length) return undefined
      criteria.push({ values, expected })
    }
    return sumValues.reduce<number>((total, value, index) => {
      if (!criteria.every((criterion) => formulaValuesEqual(criterion.values[index], criterion.expected))) return total
      const numeric = Number(value)
      return Number.isFinite(numeric) ? total + numeric : total
    }, 0)
  }

  if (args.length !== 2 && args.length !== 3) return undefined
  const criteriaValues = resolveFormulaRangeValues(args[0], currentSheet, sheets)
  const expected = resolveFormulaCriterion(args[1], currentSheet, sheets)
  const sumValues = resolveFormulaRangeValues(args[2] ?? args[0], currentSheet, sheets)
  if (!criteriaValues || expected === undefined || !sumValues || criteriaValues.length !== sumValues.length) {
    return undefined
  }
  return sumValues.reduce<number>((total, value, index) => {
    if (!formulaValuesEqual(criteriaValues[index], expected)) return total
    const numeric = Number(value)
    return Number.isFinite(numeric) ? total + numeric : total
  }, 0)
}

function splitFormulaArguments(value: string) {
  const args: string[] = []
  let start = 0
  let inString = false
  let inSheetName = false
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === '"' && !inSheetName) {
      if (inString && value[index + 1] === '"') index += 1
      else inString = !inString
    } else if (character === "'" && !inString) {
      if (inSheetName && value[index + 1] === "'") index += 1
      else inSheetName = !inSheetName
    } else if (character === ',' && !inString && !inSheetName) {
      args.push(value.slice(start, index).trim())
      start = index + 1
    }
  }
  args.push(value.slice(start).trim())
  return args
}

function resolveFormulaRangeValues(reference: string, currentSheet: string, sheets: NormalizedSheet[]) {
  const match = reference.match(SIMPLE_FORMULA_RANGE_RE)
  if (!match) return undefined
  const sheetName = normalizeFormulaSheetName(match[1] ?? match[2] ?? currentSheet)
  const sheet = sheets.find((candidate) => candidate.name.toLocaleLowerCase() === sheetName.toLocaleLowerCase())
  if (!sheet) return undefined
  const startColumn = columnNumber(match[3])
  const startRow = Number(match[4])
  const endColumn = columnNumber(match[5])
  const endRow = Number(match[6])
  const values: WorkbookPrimitive[] = []
  for (let row = Math.min(startRow, endRow); row <= Math.max(startRow, endRow); row += 1) {
    for (let column = Math.min(startColumn, endColumn); column <= Math.max(startColumn, endColumn); column += 1) {
      const cell = sheet.rows[row - 1]?.[column - 1]
      values.push(cell?.formula ? (cell.result ?? null) : (cell?.value ?? null))
    }
  }
  return values
}

function resolveFormulaCriterion(reference: string, currentSheet: string, sheets: NormalizedSheet[]) {
  const cellMatch = reference.match(SIMPLE_FORMULA_CELL_RE)
  if (cellMatch) {
    const sheetName = normalizeFormulaSheetName(cellMatch[1] ?? cellMatch[2] ?? currentSheet)
    const sheet = sheets.find((candidate) => candidate.name.toLocaleLowerCase() === sheetName.toLocaleLowerCase())
    const cell = sheet?.rows[Number(cellMatch[4]) - 1]?.[columnNumber(cellMatch[3]) - 1]
    return cell?.formula ? cell.result : cell?.value
  }
  if (/^"(?:[^"]|"")*"$/.test(reference)) return reference.slice(1, -1).replace(/""/g, '"')
  const numeric = Number(reference)
  return Number.isFinite(numeric) ? numeric : undefined
}

function formulaValuesEqual(left: WorkbookPrimitive, right: WorkbookPrimitive) {
  if (typeof left === 'number' && typeof right === 'number') return Math.abs(left - right) <= 1e-10
  return String(left ?? '').toLocaleLowerCase() === String(right ?? '').toLocaleLowerCase()
}

function normalizeSheet(input: WorkbookSheetInput, index: number, usedNames: Set<string>): NormalizedSheet {
  const name = normalizeSheetName(input.name || `Sheet${index + 1}`, usedNames)
  const rawRows = Array.isArray(input.rows) && input.rows.length ? input.rows : [['Content'], ['']]
  if (rawRows.length > MAX_ROWS) throw new Error(`${name}: at most ${MAX_ROWS} rows are supported.`)

  const rows = rawRows.map((row, rowIndex) => {
    if (!Array.isArray(row)) throw new Error(`${name}: row ${rowIndex + 1} must be an array.`)
    if (row.length > MAX_COLUMNS) throw new Error(`${name}: at most ${MAX_COLUMNS} columns are supported.`)
    return row.map((cell) => normalizeCell(cell, name))
  })
  const maxColumns = Math.max(1, ...rows.map((row) => row.length))
  const headerRows = clampInteger(input.header_rows ?? 1, 0, Math.min(10, rows.length))
  const freezeRows = clampInteger(input.freeze_rows ?? 0, 0, rows.length)
  const freezeColumns = clampInteger(input.freeze_columns ?? 0, 0, maxColumns)
  const dimension = sheetDimension(rows)
  const autoFilter =
    input.auto_filter === true
      ? dimension
      : typeof input.auto_filter === 'string' && input.auto_filter.trim()
        ? normalizeCellRange(input.auto_filter, `${name} auto_filter`)
        : undefined
  const columnWidths = Array.from({ length: maxColumns }, (_, columnIndex) => {
    const requested = input.column_widths?.[columnIndex]
    if (typeof requested === 'number' && Number.isFinite(requested)) return Math.max(5, Math.min(60, requested))
    return estimateColumnWidth(rows, columnIndex)
  })
  const merges = (input.merges || []).map((range) => normalizeCellRange(range, `${name} merge`))
  const conditionalFormats = (input.conditional_formats || []).map((format, formatIndex) =>
    normalizeConditionalFormat(format, name, formatIndex)
  )
  const charts = (input.charts || [])
    .slice(0, MAX_CHARTS_PER_SHEET)
    .map((chart, chartPosition) => normalizeChart(chart, name, chartPosition))

  return {
    name,
    rows,
    headerRows,
    freezeRows,
    freezeColumns,
    autoFilter,
    columnWidths,
    merges,
    conditionalFormats,
    charts
  }
}

function normalizeCell(input: WorkbookPrimitive | WorkbookCellInput, sheetName: string): NormalizedCell {
  if (isCellObject(input)) {
    const formula =
      typeof input.formula === 'string' && input.formula.trim() ? normalizeFormula(input.formula, sheetName) : undefined
    const style = input.style && input.style in STYLE_IDS ? input.style : undefined
    return {
      value: normalizePrimitive(input.value),
      formula,
      result: formula ? normalizePrimitive(input.result ?? input.value ?? 0) : undefined,
      style
    }
  }
  return { value: normalizePrimitive(input) }
}

function isCellObject(value: WorkbookPrimitive | WorkbookCellInput): value is WorkbookCellInput {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function normalizePrimitive(value: unknown): WorkbookPrimitive {
  if (value === null || value === undefined) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  return String(value).slice(0, 32767)
}

function normalizeFormula(value: string, sheetName: string) {
  const formula = value.trim().replace(/^=/, '')
  if (!formula || formula.length > 8192) throw new Error(`${sheetName}: invalid formula length.`)
  if (/\[[^\]]*\]|(?:https?|file):\/\/|\\\\|\b(?:WEBSERVICE|RTD|DDE)\s*\(/i.test(formula)) {
    throw new Error(`${sheetName}: external workbook, URL, DDE, or live-data formulas are not allowed.`)
  }
  return formula
}

function normalizeSheetName(value: string, usedNames: Set<string>) {
  const name = String(value).trim()
  const hasInvalidCharacter = [...name].some((character) => ':\\/?*[]'.includes(character))
  if (!name || name.length > 31 || hasInvalidCharacter || name.startsWith("'") || name.endsWith("'")) {
    throw new Error(`Invalid worksheet name: ${value}`)
  }
  const key = name.toLocaleLowerCase()
  if (usedNames.has(key)) throw new Error(`Duplicate worksheet name: ${name}`)
  usedNames.add(key)
  return name
}

function normalizeCellRange(value: string, label: string) {
  const range = String(value).trim().toUpperCase()
  if (!CELL_RANGE_RE.test(range)) throw new Error(`${label}: invalid cell range '${value}'.`)
  return range
}

function normalizeConditionalFormat(
  input: WorkbookConditionalFormatInput,
  sheetName: string,
  index: number
): NormalizedConditionalFormat {
  const operator = input.operator || 'equal'
  const allowedOperators = new Set<NormalizedConditionalFormat['operator']>([
    'equal',
    'notEqual',
    'greaterThan',
    'lessThan',
    'greaterThanOrEqual',
    'lessThanOrEqual'
  ])
  if (!allowedOperators.has(operator)) throw new Error(`${sheetName}: invalid conditional-format operator.`)
  return {
    range: normalizeCellRange(input.range || 'A1', `${sheetName} conditional format ${index + 1}`),
    operator,
    value: typeof input.value === 'number' ? input.value : String(input.value ?? ''),
    style: input.style === 'fail' || input.style === 'warning' ? input.style : 'pass'
  }
}

function normalizeChart(input: WorkbookChartInput, sheetName: string, index: number): NormalizedChart {
  const type = input.type === 'bar' ? 'bar' : input.type === 'line' ? 'line' : 'column'
  const rawSeries = Array.isArray(input.series) ? input.series : []
  if (!rawSeries.length) throw new Error(`${sheetName}: chart ${index + 1} needs at least one series.`)
  const series = rawSeries.slice(0, 6).map((item, seriesIndex) => {
    const categories = (item.categories || []).map((value) => String(value))
    const values = (item.values || []).map((value) => Number(value))
    if (!categories.length || categories.length !== values.length || values.some((value) => !Number.isFinite(value))) {
      throw new Error(`${sheetName}: chart ${index + 1} series ${seriesIndex + 1} has invalid cached data.`)
    }
    return {
      name: String(item.name || `Series ${seriesIndex + 1}`).slice(0, 100),
      categories,
      values,
      categoryRange: normalizeChartRange(item.category_range),
      valueRange: normalizeChartRange(item.value_range),
      color: normalizeColor(item.color || CHART_COLORS[seriesIndex % CHART_COLORS.length])
    }
  })
  const fromCol = clampInteger(input.from_col ?? 5, 0, 50)
  const fromRow = clampInteger(input.from_row ?? 1, 0, 500)
  const toCol = clampInteger(input.to_col ?? fromCol + 8, fromCol + 2, 60)
  const toRow = clampInteger(input.to_row ?? fromRow + 16, fromRow + 4, 520)
  return {
    type,
    title: String(input.title || `${sheetName} chart`).slice(0, 200),
    series,
    showDataLabels: shouldShowChartDataLabels(series),
    fromCol,
    fromRow,
    toCol,
    toRow
  }
}

function shouldShowChartDataLabels(series: NormalizedChartSeries[]) {
  const categoryCount = Math.max(0, ...series.map((item) => item.categories.length))
  const pointCount = series.reduce((total, item) => total + item.values.length, 0)
  return categoryCount <= 8 && pointCount <= 12
}

function normalizeChartRange(value: string | undefined) {
  if (!value) return undefined
  const range = value.trim()
  if (/\[[^\]]*\]|(?:https?|file):\/\/|\\\\/.test(range)) throw new Error('External chart ranges are not allowed.')
  if (!/^'?[^'!]{1,31}'?!\$?[A-Z]{1,3}\$?\d+:\$?[A-Z]{1,3}\$?\d+$/.test(range)) {
    throw new Error(`Invalid internal chart range: ${value}`)
  }
  return range
}

function normalizeColor(value: string) {
  const color = value.trim().replace(/^#/, '').toUpperCase()
  return /^[0-9A-F]{6}$/.test(color) ? color : '2563EB'
}

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min
  return Math.max(min, Math.min(max, Math.trunc(value)))
}

function estimateColumnWidth(rows: NormalizedCell[][], columnIndex: number) {
  const maxLength = Math.max(
    0,
    ...rows.slice(0, 300).map((row) => displayLength(row[columnIndex]?.value ?? row[columnIndex]?.result ?? ''))
  )
  return Math.max(10, Math.min(42, maxLength + 2))
}

function displayLength(value: WorkbookPrimitive) {
  return [...String(value ?? '')].reduce((total, char) => total + ((char.codePointAt(0) ?? 0) > 0xff ? 2 : 1), 0)
}

function sheetDimension(rows: NormalizedCell[][]) {
  const lastRow = Math.max(1, rows.length)
  const lastColumn = Math.max(1, ...rows.map((row) => row.length))
  return `A1:${columnName(lastColumn)}${lastRow}`
}

function createWorksheetXml(sheet: NormalizedSheet, drawingRelationshipId?: string) {
  const dimension = sheetDimension(sheet.rows)
  const columns = sheet.columnWidths
    .map((width, index) => `<col min="${index + 1}" max="${index + 1}" width="${width}" customWidth="1"/>`)
    .join('')
  const rowXml = sheet.rows
    .map((row, rowIndex) => {
      const cells = row
        .map((cell, columnIndex) => createCellXml(cell, rowIndex, columnIndex, rowIndex < sheet.headerRows))
        .join('')
      const height = rowIndex < sheet.headerRows ? ' ht="24" customHeight="1"' : ''
      return `<row r="${rowIndex + 1}"${height}>${cells}</row>`
    })
    .join('')
  const autoFilter = sheet.autoFilter ? `<autoFilter ref="${sheet.autoFilter}"/>` : ''
  const merges = sheet.merges.length
    ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((range) => `<mergeCell ref="${range}"/>`).join('')}</mergeCells>`
    : ''
  const conditionalFormats = sheet.conditionalFormats
    .map((format, index) => createConditionalFormatXml(format, index + 1))
    .join('')
  const drawing = drawingRelationshipId ? `<drawing r:id="${drawingRelationshipId}"/>` : ''

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dimension}"/>
  ${createSheetViewsXml(sheet)}
  <sheetFormatPr defaultRowHeight="18"/>
  <cols>${columns}</cols>
  <sheetData>${rowXml}</sheetData>
  ${autoFilter}
  ${merges}
  ${conditionalFormats}
  <printOptions horizontalCentered="0" verticalCentered="0"/>
  <pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/>
  <pageSetup orientation="landscape" fitToWidth="1" fitToHeight="0"/>
  ${drawing}
</worksheet>`
}

function createSheetViewsXml(sheet: NormalizedSheet) {
  if (!sheet.freezeRows && !sheet.freezeColumns) return '<sheetViews><sheetView workbookViewId="0"/></sheetViews>'
  const topLeftCell = `${columnName(sheet.freezeColumns + 1)}${sheet.freezeRows + 1}`
  const pane = sheet.freezeRows && sheet.freezeColumns ? 'bottomRight' : sheet.freezeRows ? 'bottomLeft' : 'topRight'
  const xSplit = sheet.freezeColumns ? ` xSplit="${sheet.freezeColumns}"` : ''
  const ySplit = sheet.freezeRows ? ` ySplit="${sheet.freezeRows}"` : ''
  return `<sheetViews><sheetView workbookViewId="0"><pane${xSplit}${ySplit} topLeftCell="${topLeftCell}" activePane="${pane}" state="frozen"/><selection pane="${pane}" activeCell="${topLeftCell}" sqref="${topLeftCell}"/></sheetView></sheetViews>`
}

function createCellXml(cell: NormalizedCell, rowIndex: number, columnIndex: number, isHeader: boolean) {
  const ref = `${columnName(columnIndex + 1)}${rowIndex + 1}`
  const style = resolveStyle(cell, isHeader)
  const styleAttr = ` s="${style}"`
  if (cell.formula) {
    const result = cell.result ?? 0
    const typeAttr = typeof result === 'string' ? ' t="str"' : typeof result === 'boolean' ? ' t="b"' : ''
    const serializedResult = typeof result === 'boolean' ? (result ? '1' : '0') : xmlEscape(String(result ?? 0))
    return `<c r="${ref}"${styleAttr}${typeAttr}><f>${xmlEscape(cell.formula)}</f><v>${serializedResult}</v></c>`
  }
  if (cell.value === null || cell.value === '') return `<c r="${ref}"${styleAttr}/>`
  if (typeof cell.value === 'number') return `<c r="${ref}"${styleAttr}><v>${cell.value}</v></c>`
  if (typeof cell.value === 'boolean') return `<c r="${ref}"${styleAttr} t="b"><v>${cell.value ? 1 : 0}</v></c>`
  const preserve = /^\s|\s$|\s{2}/.test(cell.value) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}"${styleAttr} t="inlineStr"><is><t${preserve}>${xmlEscape(cell.value)}</t></is></c>`
}

function resolveStyle(cell: NormalizedCell, isHeader: boolean) {
  if (cell.style) return STYLE_IDS[cell.style]
  if (isHeader) return STYLE_IDS.header
  const value = String(cell.value ?? '')
    .trim()
    .toLocaleLowerCase()
  if (['通过', 'pass', 'passed', 'yes'].includes(value)) return STYLE_IDS.pass
  if (['失败', 'fail', 'failed', 'no'].includes(value)) return STYLE_IDS.fail
  if (['待确认', '进行中', 'warning', 'pending'].includes(value)) return STYLE_IDS.warning
  return STYLE_IDS.normal
}

function createConditionalFormatXml(format: NormalizedConditionalFormat, priority: number) {
  const dxfId = format.style === 'pass' ? 0 : format.style === 'fail' ? 1 : 2
  const formula =
    typeof format.value === 'number' ? String(format.value) : `&quot;${xmlEscape(String(format.value))}&quot;`
  return `<conditionalFormatting sqref="${format.range}"><cfRule type="cellIs" dxfId="${dxfId}" priority="${priority}" operator="${format.operator}"><formula>${formula}</formula></cfRule></conditionalFormatting>`
}

function createContentTypes(sheetCount: number, drawings: Array<{ drawingIndex: number }>, chartCount: number) {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join('')
  const drawingParts = drawings
    .map(
      (drawing) =>
        `<Override PartName="/xl/drawings/drawing${drawing.drawingIndex}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`
    )
    .join('')
  const chartParts = Array.from(
    { length: chartCount },
    (_, index) =>
      `<Override PartName="/xl/charts/chart${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  ${sheets}${drawingParts}${chartParts}
</Types>`
}

function createRootRelationships() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`
}

function createWorkbookXml(workbook: NormalizedWorkbook) {
  const sheets = workbook.sheets
    .map((sheet, index) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27328"/>
  <workbookPr updateLinks="never" saveExternalLinkValues="0"/>
  <bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="14000" activeTab="0"/></bookViews>
  <sheets>${sheets}</sheets>
  <calcPr calcId="191029" calcMode="auto" fullCalcOnLoad="1" forceFullCalc="1"/>
</workbook>`
}

function createWorkbookRelationships(sheetCount: number) {
  const sheets = Array.from(
    { length: sheetCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets}
  <Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`
}

function createWorksheetRelationships(drawingIndex: number) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>
</Relationships>`
}

function createDrawingRelationships(chartCount: number, firstChartIndex: number) {
  const relationships = Array.from(
    { length: chartCount },
    (_, index) =>
      `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart" Target="../charts/chart${firstChartIndex + index}.xml"/>`
  ).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`
}

function createDrawingXml(charts: NormalizedChart[], firstChartIndex: number) {
  const anchors = charts
    .map((chart, index) => {
      const chartIndex = firstChartIndex + index
      return `<xdr:twoCellAnchor>
  <xdr:from><xdr:col>${chart.fromCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${chart.fromRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
  <xdr:to><xdr:col>${chart.toCol}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${chart.toRow}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to>
  <xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${index + 2}" name="Chart ${chartIndex}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:id="rId${index + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame>
  <xdr:clientData/>
</xdr:twoCellAnchor>`
    })
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`
}

function createChartXml(chart: NormalizedChart, chartIndex: number) {
  const axisBase = 48_650_000 + chartIndex * 10
  const categoryAxis = axisBase + 1
  const valueAxis = axisBase + 2
  const values = chart.series.flatMap((item) => item.values)
  const rawMinimum = Math.min(...values)
  const rawMaximum = Math.max(...values)
  const rawRange = rawMaximum - rawMinimum
  const constantPadding = Math.max(Math.abs(rawMinimum) * 0.1, 1)
  const linePadding = rawRange > 0 ? rawRange * 0.12 : constantPadding
  const minimumValue = chart.type === 'line' ? rawMinimum - linePadding : Math.min(0, rawMinimum)
  const maximumValue = chart.type === 'line' ? rawMaximum + linePadding : Math.max(1, rawMaximum)
  const majorUnit = niceChartAxisUnit(maximumValue - minimumValue)
  const axisMinimum = Math.floor(minimumValue / majorUnit) * majorUnit
  const axisMaximum = Math.max(axisMinimum + majorUnit, Math.ceil(maximumValue / majorUnit) * majorUnit)
  const series = chart.series
    .map((item, index) =>
      chart.type === 'line' ? createLineChartSeriesXml(item, index) : createChartSeriesXml(item, index)
    )
    .join('')
  const dataLabels = chart.showDataLabels
    ? `<c:dLbls><c:dLblPos val="${chart.type === 'line' ? 't' : 'outEnd'}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showLeaderLines val="0"/></c:dLbls>`
    : ''
  const legend =
    chart.series.length > 1 ? '<c:legend><c:legendPos val="r"/><c:layout/><c:overlay val="0"/></c:legend>' : ''
  const barDirection = chart.type === 'bar' ? 'bar' : 'col'
  const categoryPosition = chart.type === 'bar' ? 'l' : 'b'
  const valuePosition = chart.type === 'bar' ? 'b' : 'l'
  const chartBody =
    chart.type === 'line'
      ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}${dataLabels}<c:marker val="1"/><c:smooth val="0"/><c:axId val="${categoryAxis}"/><c:axId val="${valueAxis}"/></c:lineChart>`
      : `<c:barChart><c:barDir val="${barDirection}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}${dataLabels}<c:gapWidth val="80"/><c:axId val="${categoryAxis}"/><c:axId val="${valueAxis}"/></c:barChart>`
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <c:date1904 val="0"/><c:lang val="zh-CN"/><c:roundedCorners val="0"/>
  <c:chart>
    ${createChartTitleXml(chart.title)}
    <c:autoTitleDeleted val="0"/>
    <c:plotArea><c:layout/>
      ${chartBody}
      <c:catAx><c:axId val="${categoryAxis}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${categoryPosition}"/><c:tickLblPos val="nextTo"/><c:crossAx val="${valueAxis}"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx>
      <c:valAx><c:axId val="${valueAxis}"/><c:scaling><c:orientation val="minMax"/><c:max val="${axisMaximum}"/><c:min val="${axisMinimum}"/></c:scaling><c:delete val="0"/><c:axPos val="${valuePosition}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="${categoryAxis}"/><c:crosses val="autoZero"/><c:crossBetween val="between"/><c:majorUnit val="${majorUnit}"/></c:valAx>
    </c:plotArea>
    ${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/><c:showDLblsOverMax val="0"/>
  </c:chart>
  <c:printSettings><c:headerFooter/><c:pageMargins b="0.75" l="0.7" r="0.7" t="0.75" header="0.3" footer="0.3"/><c:pageSetup/></c:printSettings>
</c:chartSpace>`
}

function niceChartAxisUnit(range: number) {
  const roughUnit = Math.max(1e-9, range / 5)
  const magnitude = 10 ** Math.floor(Math.log10(roughUnit))
  const normalized = roughUnit / magnitude
  const multiplier = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return multiplier * magnitude
}

function createChartTitleXml(title: string) {
  return `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="1500" b="1"/><a:t>${xmlEscape(title)}</a:t></a:r></a:p></c:rich></c:tx><c:layout/><c:overlay val="0"/></c:title>`
}

function createChartSeriesXml(series: NormalizedChartSeries, index: number) {
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xmlEscape(series.name)}</c:v></c:tx><c:spPr><a:solidFill><a:srgbClr val="${series.color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr><c:invertIfNegative val="0"/><c:cat>${createCategoryDataXml(series)}</c:cat><c:val>${createValueDataXml(series)}</c:val></c:ser>`
}

function createLineChartSeriesXml(series: NormalizedChartSeries, index: number) {
  return `<c:ser><c:idx val="${index}"/><c:order val="${index}"/><c:tx><c:v>${xmlEscape(series.name)}</c:v></c:tx><c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${series.color}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="5"/><c:spPr><a:solidFill><a:srgbClr val="${series.color}"/></a:solidFill><a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln></c:spPr></c:marker><c:cat>${createCategoryDataXml(series)}</c:cat><c:val>${createValueDataXml(series)}</c:val><c:smooth val="0"/></c:ser>`
}

function createCategoryDataXml(series: NormalizedChartSeries) {
  const cache = `<c:ptCount val="${series.categories.length}"/>${series.categories.map((value, index) => `<c:pt idx="${index}"><c:v>${xmlEscape(value)}</c:v></c:pt>`).join('')}`
  return series.categoryRange
    ? `<c:strRef><c:f>${xmlEscape(series.categoryRange)}</c:f><c:strCache>${cache}</c:strCache></c:strRef>`
    : `<c:strLit>${cache}</c:strLit>`
}

function createValueDataXml(series: NormalizedChartSeries) {
  const cache = `<c:formatCode>General</c:formatCode><c:ptCount val="${series.values.length}"/>${series.values.map((value, index) => `<c:pt idx="${index}"><c:v>${value}</c:v></c:pt>`).join('')}`
  return series.valueRange
    ? `<c:numRef><c:f>${xmlEscape(series.valueRange)}</c:f><c:numCache>${cache}</c:numCache></c:numRef>`
    : `<c:numLit>${cache}</c:numLit>`
}

function createCoreProperties(workbook: NormalizedWorkbook) {
  const now = new Date().toISOString()
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(workbook.title)}</dc:title><dc:creator>${xmlEscape(workbook.creator)}</dc:creator><cp:lastModifiedBy>${xmlEscape(workbook.creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`
}

function createAppProperties(workbook: NormalizedWorkbook) {
  const titles = workbook.sheets.map((sheet) => `<vt:lpstr>${xmlEscape(sheet.name)}</vt:lpstr>`).join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Zen AI</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>${workbook.sheets.length}</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="${workbook.sheets.length}" baseType="lpstr">${titles}</vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>`
}

function columnName(columnNumber: number) {
  let name = ''
  let value = columnNumber
  while (value > 0) {
    const remainder = (value - 1) % 26
    name = String.fromCharCode(65 + remainder) + name
    value = Math.floor((value - 1) / 26)
  }
  return name
}

function xmlEscape(value: string) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function toBuffer(value: string) {
  return Buffer.from(value, 'utf-8')
}

const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="2"><numFmt numFmtId="164" formatCode="0.0%"/><numFmt numFmtId="165" formatCode="0.0 &quot;s&quot;"/></numFmts>
  <fonts count="7">
    <font><sz val="11"/><color rgb="FF1F2937"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF17365D"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="18"/><color rgb="FF17365D"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF166534"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF991B1B"/><name val="Microsoft YaHei"/><family val="2"/></font>
    <font><b/><sz val="11"/><color rgb="FF92400E"/><name val="Microsoft YaHei"/><family val="2"/></font>
  </fonts>
  <fills count="8">
    <fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1F4E78"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD9EAF7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>
  </fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD1D5DB"/></left><right style="thin"><color rgb="FFD1D5DB"/></right><top style="thin"><color rgb="FFD1D5DB"/></top><bottom style="thin"><color rgb="FFD1D5DB"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="13">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>
    <xf numFmtId="164" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="1" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="165" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="6" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
  <dxfs count="3"><dxf><font><b/><color rgb="FF166534"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><font><b/><color rgb="FF991B1B"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/><bgColor indexed="64"/></patternFill></fill></dxf><dxf><font><b/><color rgb="FF92400E"/></font><fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/><bgColor indexed="64"/></patternFill></fill></dxf></dxfs>
  <tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`
