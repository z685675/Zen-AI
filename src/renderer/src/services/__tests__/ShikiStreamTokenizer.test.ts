import type { HighlighterCore } from 'shiki'
import { createHighlighter } from 'shiki'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { ShikiStreamTokenizer } from '../ShikiStreamTokenizer'
import {
  generateEqualLengthChunks,
  getExpectedHighlightedCode,
  highlightCode
} from './helpers/ShikiStreamTokenizer.helper'

describe('ShikiStreamTokenizer', () => {
  const highlighterPromise = createHighlighter({
    langs: ['typescript'],
    themes: ['one-light']
  })

  let highlighter: HighlighterCore | null = null
  let tokenizer: ShikiStreamTokenizer

  beforeEach(async () => {
    highlighter = await highlighterPromise
    tokenizer = new ShikiStreamTokenizer({
      highlighter,
      lang: 'typescript',
      theme: 'one-light'
    })
  })

  afterEach(() => {
    tokenizer.clear()
    highlighter = null
  })

  describe('enqueue', () => {
    it('should handle single line code chunk correctly', async () => {
      const chunk = 'const x = 5;'
      const result = await tokenizer.enqueue(chunk)
      expect(result.stable).toEqual([])
      expect(result.unstable.length).toBe(1)
      expect(result.recall).toBe(0)
    })

    it('should handle multi-line code chunk with stable and unstable lines', async () => {
      const chunk = 'const x = 5;\nconst y = 10;'

      const result = await tokenizer.enqueue(chunk)
      expect(result.stable.length).toBe(1)
      expect(result.unstable.length).toBe(1)
      expect(result.recall).toBe(0)
    })

    it('should handle empty chunk', async () => {
      const chunk = ''

      const result = await tokenizer.enqueue(chunk)
      expect(result.stable).toEqual([])
      expect(result.unstable).toEqual([[]]) // 有一个空�?token
      expect(result.recall).toBe(0)
    })

    it('should handle very long single line', async () => {
      const longLine = 'const longVariableName = ' + 'a'.repeat(1000) + ';'

      const result = await tokenizer.enqueue(longLine)
      expect(result.stable).toEqual([])
      expect(result.unstable.length).toBe(1)
      expect(result.recall).toBe(0)
    })

    it('should handle sequential chunks where the first is a full line', async () => {
      const firstChunk = 'const x = 5;\n'
      const secondChunk = 'const y = 10;'

      // 由于第一�?chunk 是完整的行，会产生一�?stable line 和一�?unstable line (空的)
      const firstResult = await tokenizer.enqueue(firstChunk)
      expect(firstResult.stable.length).toBe(1)
      expect(firstResult.unstable.length).toBe(1)
      expect(firstResult.recall).toBe(0)

      // 第二�?chunk 来的时候，前面�?unstable line 实际上是空的，因此不会有 stable line
      const secondResult = await tokenizer.enqueue(secondChunk)
      expect(secondResult.stable.length).toBe(0)
      expect(secondResult.unstable.length).toBe(1)
      expect(secondResult.recall).toBe(1)
    })

    it('should handle sequential chunks where the first is a partial line', async () => {
      const firstChunk = 'const x = 5'
      const secondChunk = ';\nconst y = 10;'

      const firstResult = await tokenizer.enqueue(firstChunk)
      expect(firstResult.stable.length).toBe(0)
      expect(firstResult.unstable.length).toBe(1)
      expect(firstResult.recall).toBe(0)

      const secondResult = await tokenizer.enqueue(secondChunk)
      expect(secondResult.stable.length).toBe(1)
      expect(secondResult.unstable.length).toBe(1)
      expect(secondResult.recall).toBe(1)
    })
  })

  describe('close', () => {
    it('should finalize unstable lines to stable', async () => {
      await tokenizer.enqueue('const x = 5;')

      const result = tokenizer.close()
      expect(result.stable.length).toBe(1)
      expect(tokenizer.linesUnstable).toEqual([])
      expect(tokenizer.lastUnstableCodeChunk).toBe('')
    })

    it('should handle close with no unstable lines', () => {
      const result = tokenizer.close()
      expect(result.stable).toEqual([])
      expect(tokenizer.linesUnstable).toEqual([])
      expect(tokenizer.lastUnstableCodeChunk).toBe('')
    })
  })

  describe('clear', () => {
    it('should reset tokenizer state', async () => {
      await tokenizer.enqueue('const x = 5;')

      tokenizer.clear()
      expect(tokenizer.linesUnstable).toEqual([])
      expect(tokenizer.lastUnstableCodeChunk).toBe('')
      expect(tokenizer.lastStableGrammarState).toBeUndefined()
    })

    it('should handle clear with no data', () => {
      tokenizer.clear()
      expect(tokenizer.linesUnstable).toEqual([])
      expect(tokenizer.lastUnstableCodeChunk).toBe('')
      expect(tokenizer.lastStableGrammarState).toBeUndefined()
    })
  })

  describe('streaming', () => {
    const fixture = {
      tsCode: `
/* 块注�?*/
enum E{A,B='C'} interface I{id:number;fn:(x:string)=>boolean} type T=[num:number,str:string]|'fixed'; // 枚举/接口/类型别名
const f=<T extends string|number>(a:T):T=>a; // 泛型函数
// 单行注释
class C{static s=0; private #p=''; readonly r:symbol=Symbol(); m():\`\${string}-\${number}\`{return \`\${this.#p}\${C.s}\`}} // �?静�?私有/只读/模板类型

const v:string|undefined=null??'val'; const n=v?.length??0; const u=v as string; // 空值合�?可选链/类型断言
const [x,,y]:T=[10,'ts']; const {id:z}:I={id:1,fn:s=>s.length>0}; // 元组解构/对象解构重命�?console.log(typeof f, E.B, new C() instanceof C, /^ts$/.test('ts')); // typeof/枚举�?instanceof/正则
`
    }

    it('should handle a single chunk of complex code', async () => {
      const result = await highlightCode([fixture.tsCode], tokenizer)
      const expected = getExpectedHighlightedCode(fixture.tsCode, highlighter)

      expect(result).toBe(expected)
    })

    it('should handle chunks of full lines', async () => {
      const lines = fixture.tsCode.split('\n')
      const chunks = lines.map((line, index) => {
        if (index === lines.length - 1) {
          return line
        }
        return line + '\n'
      })

      const result = await highlightCode(chunks, tokenizer)
      const expected = getExpectedHighlightedCode(fixture.tsCode, highlighter)

      expect(result).toBe(expected)
    })

    it('should handle chunks of partial lines with leading newlines', async () => {
      const lines = fixture.tsCode.split('\n')
      const chunks = lines.map((line, index) => {
        if (index === 0) {
          return line
        }
        return '\n' + line
      })

      const result = await highlightCode(chunks, tokenizer)
      const expected = getExpectedHighlightedCode(fixture.tsCode, highlighter)

      expect(result).toBe(expected)
    })

    it.each([13, 31, 53, 101])('should handle chunks of equal length %i', async (chunkLength) => {
      const chunks = generateEqualLengthChunks(fixture.tsCode, chunkLength)

      const result = await highlightCode(chunks, tokenizer)
      const expected = getExpectedHighlightedCode(fixture.tsCode, highlighter)

      expect(result).toBe(expected)
    })
  })
})
