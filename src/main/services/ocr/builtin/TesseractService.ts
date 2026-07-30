import { loggerService } from '@logger'
import { getIpCountry } from '@main/utils/ipService'
import { loadOcrImage } from '@main/utils/ocr'
import { MB } from '@shared/config/constant'
import type { ImageFileMetadata, OcrResult, OcrTesseractConfig, SupportedOcrFile } from '@types'
import { isImageFileMetadata } from '@types'
import { app } from 'electron'
import fs from 'fs'
import { isEqual } from 'lodash'
import path from 'path'
import type { LanguageCode } from 'tesseract.js'
import type Tesseract from 'tesseract.js'
import { createWorker, PSM } from 'tesseract.js'

import { OcrBaseService } from './OcrBaseService'

const logger = loggerService.withContext('TesseractService')

// config
const MB_SIZE_THRESHOLD = 50
const defaultLangs = ['chi_sim', 'eng'] satisfies LanguageCode[]
enum TesseractLangsDownloadUrl {
  CN = 'https://gitcode.com/beyondkmp/tessdata-best/releases/download/1.0.0/'
}

export class TesseractService extends OcrBaseService {
  private worker: Tesseract.Worker | null = null
  private previousLangs: LanguageCode[]

  constructor() {
    super()
    this.previousLangs = []
  }

  async getWorker(options?: OcrTesseractConfig): Promise<Tesseract.Worker> {
    let langsArray: LanguageCode[]
    if (options?.langs) {
      // TODO: use type safe objectKeys
      langsArray = Object.keys(options.langs) as LanguageCode[]
      if (langsArray.length === 0) {
        logger.warn('Empty langs option. Fallback to defaultLangs.')
        langsArray = defaultLangs
      }
    } else {
      langsArray = defaultLangs
    }
    logger.debug('langsArray', langsArray)
    if (!this.worker || !isEqual(this.previousLangs, langsArray)) {
      if (this.worker) {
        await this.dispose()
      }
      logger.debug('use langsArray to create worker', langsArray)
      const langPath = await this._getLangPath()
      const cachePath = await this._getCacheDir()
      const promise = new Promise<Tesseract.Worker>((resolve, reject) => {
        createWorker(langsArray, undefined, {
          langPath,
          cachePath,
          logger: (m) => logger.debug('From worker', m),
          errorHandler: (e) => {
            logger.error('Worker Error', e)
            reject(e)
          }
        })
          .then(resolve)
          .catch(reject)
      })
      this.worker = await promise
      this.previousLangs = [...langsArray]
    }
    return this.worker
  }

  private async imageOcr(file: ImageFileMetadata, options?: OcrTesseractConfig): Promise<OcrResult> {
    const worker = await this.getWorker(options)
    const stat = await fs.promises.stat(file.path)
    if (stat.size > MB_SIZE_THRESHOLD * MB) {
      throw new Error(`This image is too large (max ${MB_SIZE_THRESHOLD}MB)`)
    }
    const buffer = await loadOcrImage(file, options?.preprocess)
    await worker.setParameters({
      tessedit_pageseg_mode: options?.pageSegMode ?? PSM.AUTO,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300'
    })
    const result = await worker.recognize(buffer, { rotateAuto: true }, { blocks: true, text: true })
    let paragraph = 0
    const lines =
      result.data.blocks?.flatMap((block) =>
        block.paragraphs.flatMap((entry) => {
          const paragraphIndex = paragraph++
          return entry.lines.map((line) => ({
            text: line.text.trimEnd(),
            confidence: line.confidence,
            bbox: line.bbox,
            paragraph: paragraphIndex
          }))
        })
      ) ?? undefined
    return { text: result.data.text, confidence: result.data.confidence, lines }
  }

  public ocr = async (file: SupportedOcrFile, options?: OcrTesseractConfig): Promise<OcrResult> => {
    if (!isImageFileMetadata(file)) {
      throw new Error('Only image files are supported currently')
    }
    return this.imageOcr(file, options)
  }

  private async _getLangPath(): Promise<string> {
    const country = await getIpCountry()
    return country.toLowerCase() === 'cn' ? TesseractLangsDownloadUrl.CN : ''
  }

  private async _getCacheDir(): Promise<string> {
    const cacheDir = path.join(app.getPath('userData'), 'tesseract')
    // use access to check if the directory exists
    if (
      !(await fs.promises
        .access(cacheDir, fs.constants.F_OK)
        .then(() => true)
        .catch(() => false))
    ) {
      await fs.promises.mkdir(cacheDir, { recursive: true })
    }
    return cacheDir
  }

  async dispose(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate()
      this.worker = null
      this.previousLangs = []
    }
  }
}

export const tesseractService = new TesseractService()
