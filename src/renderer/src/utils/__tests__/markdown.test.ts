import { describe, expect, it } from 'vitest'

import {
  convertMathFormula,
  findCitationInChildren,
  isHtmlCode,
  markdownToPlainText,
  processLatexBrackets,
  purifyMarkdownImages,
  removeTrailingDoubleSpaces,
  updateCodeBlock
} from '../markdown'

describe('markdown utils', () => {
  it('finds citations in nested children', () => {
    expect(findCitationInChildren(null)).toBe('')
    expect(findCitationInChildren([{ props: { 'data-citation': 'direct' } }])).toBe('direct')
    expect(
      findCitationInChildren([
        {
          props: {
            children: [{ props: { 'data-citation': 'nested' } }]
          }
        }
      ])
    ).toBe('nested')
  })

  it('converts latex delimiters to markdown math', () => {
    expect(convertMathFormula('Some text \\[math\\] more text')).toBe('Some text $$math$$ more text')
    expect(convertMathFormula('Some text \\(inline\\) more text')).toBe('Some text $inline$ more text')
  })

  it('processes latex brackets while protecting code and links', () => {
    expect(processLatexBrackets('The formula is \\[a+b=c\\]')).toBe('The formula is $$a+b=c$$')
    expect(processLatexBrackets('The formula is \\(a+b=c\\)')).toBe('The formula is $a+b=c$')
    expect(processLatexBrackets('Math: \\[x+y\\] and code: `arr = \\[1,2\\]`')).toBe(
      'Math: $$x+y$$ and code: `arr = \\[1,2\\]`'
    )
    expect(processLatexBrackets('[\\[pdf\\] file](url) and \\(z\\)')).toBe('[\\[pdf\\] file](url) and $z$')
  })

  it('removes trailing double spaces', () => {
    expect(removeTrailingDoubleSpaces('Line one  \nLine two  \nLine three')).toBe('Line one\nLine two\nLine three')
  })

  it('updates a code block by id', () => {
    const markdown = '# Test\n```js\nvar x = 1;\n```\nOther content'
    const result = updateCodeBlock(markdown, '2:1:7', 'const x = 2;')

    expect(result).toContain('const x = 2;')
    expect(result).not.toContain('var x = 1;')
  })

  it('converts markdown to plain text', () => {
    expect(markdownToPlainText('# Header')).toBe('Header')
    expect(markdownToPlainText('**bold**')).toBe('bold')
    expect(markdownToPlainText('[link](http://example.com)')).toBe('link')
    expect(markdownToPlainText('`code`')).toBe('code')
  })

  it('detects html-like code', () => {
    expect(isHtmlCode('<!doctype html><html><body>Hello</body></html>')).toBe(true)
    expect(isHtmlCode('<div>Hello</div>')).toBe(true)
    expect(isHtmlCode('const x = 1')).toBe(false)
  })

  it('replaces base64 markdown images', () => {
    expect(purifyMarkdownImages('![image](data:image/png;base64,AAAA)')).toBe('![image](image_url)')
  })
})
