import type { StructuredFileSection } from '@types'

import { createStructuredOfficeReaders } from './assistantDocumentOfficeParsers'
import { runDocumentWorker } from './assistantDocumentWorker'

export function readAssistantOffice(
  data: Buffer,
  format: string,
  signal?: AbortSignal
): Promise<{ sections: StructuredFileSection[] }> {
  // xmldom is a production dependency of the existing Office parser. Resolve
  // from that package, not a dev-only root dependency absent from app.asar.
  const domPath = require.resolve('@xmldom/xmldom', { paths: [require.resolve('officeparser')] })
  return runDocumentWorker(
    String.raw`
    const { parentPort, workerData } = require('node:worker_threads')
    const { inflateRawSync, crc32 } = require('node:zlib')
    const { DOMParser } = require(workerData.domPath)
    const createReaders = (${createStructuredOfficeReaders.toString()})
    try {
      const data = Buffer.from(workerData.data.buffer, workerData.data.byteOffset, workerData.data.byteLength)
      const MiB = 1024 * 1024
      // Reject ZIP64/multipart archives and cap the central directory BEFORE
      // allocating entry objects. Binary media is listed, never decompressed.
      let end = -1
      for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
        if (data.readUInt32LE(i) === 0x06054b50 && i + 22 + data.readUInt16LE(i + 20) === data.length) { end = i; break }
      }
      if (end < 0) throw new Error('Corrupt Office ZIP: missing end record')
      const count = data.readUInt16LE(end + 10)
      const directorySize = data.readUInt32LE(end + 12)
      let cursor = data.readUInt32LE(end + 16)
      if (data.readUInt32LE(end + 4) !== 0 || data.readUInt16LE(end + 8) !== count || count > 4096 ||
          directorySize > 4 * MiB || cursor + directorySize !== end) {
        throw new Error('Office ZIP exceeds safe directory limits (4096 entries; no ZIP64/multipart)')
      }
      const directoryEnd = cursor + directorySize
      const entries = new Map()
      let inflatedTotal = 0
      const relevant = workerData.format === 'docx' ? /^word\/document\.xml$/i
        : workerData.format === 'pptx' ? /^ppt\/(?:presentation\.xml|slides\/slide\d+\.xml|notesSlides\/notesSlide\d+\.xml|charts\/chart\d+\.xml)$/i
        : /^xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml|charts\/chart\d+\.xml)$/i
      for (let index = 0; index < count; index++) {
        if (cursor + 46 > directoryEnd || data.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Corrupt ZIP directory')
        const flags = data.readUInt16LE(cursor + 8)
        const method = data.readUInt16LE(cursor + 10)
        const crc = data.readUInt32LE(cursor + 16)
        const compressedSize = data.readUInt32LE(cursor + 20)
        const size = data.readUInt32LE(cursor + 24)
        const nameLength = data.readUInt16LE(cursor + 28)
        const extraLength = data.readUInt16LE(cursor + 30)
        const commentLength = data.readUInt16LE(cursor + 32)
        const offset = data.readUInt32LE(cursor + 42)
        const next = cursor + 46 + nameLength + extraLength + commentLength
        if (nameLength > 256 || next > directoryEnd || data.readUInt16LE(cursor + 34) !== 0) throw new Error('Unsafe ZIP entry name/disk')
        const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')
        if (entries.has(name)) throw new Error('Duplicate Office ZIP entry')
        entries.set(name, '')
        cursor = next
        if (!relevant.test(name)) continue
        if ((flags & 1) || ![0, 8].includes(method) || size > 8 * MiB || inflatedTotal + size > 24 * MiB ||
            (size && (!compressedSize || size / compressedSize > 1000))) throw new Error('Unsafe XML entry size/compression (8 MiB per entry/24 MiB total)')
        if (offset + 30 > directoryEnd || data.readUInt32LE(offset) !== 0x04034b50 || data.readUInt16LE(offset + 8) !== method) throw new Error('Corrupt ZIP local header')
        const start = offset + 30 + data.readUInt16LE(offset + 26) + data.readUInt16LE(offset + 28)
        if (start + compressedSize > directoryEnd) throw new Error('Corrupt ZIP data range')
        const compressed = data.subarray(start, start + compressedSize)
        const inflated = method === 8 ? inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) }) : compressed
        if (inflated.length !== size || crc32(inflated) !== crc) throw new Error('Corrupt XML entry size/CRC')
        inflatedTotal += inflated.length
        const xml = new TextDecoder('utf-8', { fatal: true }).decode(inflated)
        if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Office XML DTD/entities are not supported')
        const fail = message => { throw new Error('Corrupt Office XML: ' + String(message).slice(0, 200)) }
        new DOMParser({ errorHandler: { warning: fail, error: fail, fatalError: fail } }).parseFromString(xml, 'text/xml')
        entries.set(name, xml)
      }
      if (cursor !== directoryEnd) throw new Error('Corrupt Office ZIP directory size')
      const required = { docx: 'word/document.xml', pptx: 'ppt/presentation.xml', xlsx: 'xl/workbook.xml' }[workerData.format]
      if (!entries.get(required)) throw new Error('Corrupt Office document: missing ' + required)
      const zip = {
        getEntry: name => entries.has(name) ? { getData: () => ({ toString: () => entries.get(name) }) } : null,
        getEntries: () => [...entries].map(([entryName, text]) => ({ entryName, getData: () => ({ toString: () => text }) }))
      }
      const sections = createReaders(require('node:path'))[workerData.format](zip)
      if (sections.length > 2048 || sections.reduce((sum, section) => sum + section.text.length, 0) > 4000000) {
        throw new Error('Office extracted text exceeds safe parse limits (2048 sections/4 million characters); split the document')
      }
      parentPort.postMessage({ sections })
    } catch (error) { parentPort.postMessage({ error: String(error.message || error).slice(0, 1000) }) }
  `,
    { data, format, domPath },
    'Office',
    signal
  )
}
