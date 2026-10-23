import type { StructuredFileSection } from '@types'

import { runDocumentProcess } from './assistantDocumentProcess'

// PDF.js is the existing FileStorage text engine. Bound the requested pages
// and isolate its native dependencies in a process, not an Electron thread.
export function readAssistantPdf(
  data: Buffer,
  startPage: number,
  maxPages: number,
  signal?: AbortSignal
): Promise<{ sections: StructuredFileSection[]; total: number }> {
  return runDocumentProcess(
    `
      const { PDFParse } = require(workerData.modulePath)
      const parser = new PDFParse({
        data: workerData.data, isEvalSupported: false, disableFontFace: true,
        maxImageSize: 0, stopAtErrors: true
      })
      try {
        const info = await parser.getInfo({ parsePageInfo: false })
        if (workerData.startPage > info.total) throw new Error('start_page is outside the document')
        const last = Math.min(info.total, workerData.startPage + workerData.maxPages - 1)
        const pages = Array.from({ length: last - workerData.startPage + 1 }, (_, i) => workerData.startPage + i)
        const result = await parser.getText({ partial: pages })
        let characters = 0
        const sections = result.pages.map(page => {
          characters += page.text.length
          if (characters > 4000000) throw new Error('PDF text exceeds safe parse limit; use fewer pages')
          return { text: page.text.trim(), metadata: { page: page.num } }
        })
        if (sections.length !== pages.length) throw new Error('PDF parser returned an incomplete page range')
        return { sections, total: info.total }
      } finally { await parser.destroy() }
    `,
    { data, startPage, maxPages, modulePath: require.resolve('pdf-parse') },
    'PDF',
    signal
  )
}
