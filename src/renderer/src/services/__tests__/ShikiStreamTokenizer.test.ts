import type { HighlighterCore } from 'shiki'
import { createHighlighter } from 'shiki'
import { beforeEach, describe, expect, it } from 'vitest'

import { ShikiStreamTokenizer, splitToSubTrunks } from '../ShikiStreamTokenizer'

describe('ShikiStreamTokenizer', () => {
  let highlighter: HighlighterCore
  let tokenizer: ShikiStreamTokenizer

  beforeEach(async () => {
    highlighter = await createHighlighter({
      langs: ['typescript'],
      themes: ['one-light']
    })
    tokenizer = new ShikiStreamTokenizer({
      highlighter,
      lang: 'typescript',
      theme: 'one-light'
    })
  })

  it('keeps single-line chunks as unstable output', async () => {
    const result = await tokenizer.enqueue('const value = 1')

    expect(result.stable).toEqual([])
    expect(result.unstable).toHaveLength(1)
    expect(result.recall).toBe(0)
  })

  it('emits stable and unstable lines for multi-line chunks', async () => {
    const result = await tokenizer.enqueue('const a = 1;\nconst b = 2;')

    expect(result.stable).toHaveLength(1)
    expect(result.unstable).toHaveLength(1)
  })

  it('recalls the previous unstable line on continued streaming input', async () => {
    await tokenizer.enqueue('const a = 1')
    const result = await tokenizer.enqueue(';\nconst b = 2')

    expect(result.recall).toBe(1)
    expect(result.stable).toHaveLength(1)
    expect(result.unstable).toHaveLength(1)
  })

  it('finalizes unstable lines on close', async () => {
    await tokenizer.enqueue('const a = 1')

    const result = tokenizer.close()

    expect(result.stable).toHaveLength(1)
    expect(tokenizer.linesUnstable).toEqual([])
  })

  it('resets internal state on clear', async () => {
    await tokenizer.enqueue('const a = 1')
    tokenizer.clear()

    expect(tokenizer.linesUnstable).toEqual([])
    expect(tokenizer.lastUnstableCodeChunk).toBe('')
    expect(tokenizer.lastStableGrammarState).toBeUndefined()
  })

  it('splits chunks on the last newline only', () => {
    expect(splitToSubTrunks('abc')).toEqual(['abc'])
    expect(splitToSubTrunks('a\nb\nc')).toEqual(['a\nb', 'c'])
  })
})
