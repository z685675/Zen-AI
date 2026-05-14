import { describe, expect, it } from 'vitest'

import { getExtensionByLanguage, getLanguageByExtension, getLanguageByFilePath } from '../code-language'

describe('code-language utils', () => {
  it('resolves language names from extensions', () => {
    expect(getLanguageByExtension('.ts')).toBe('TypeScript')
    expect(getLanguageByExtension('JS')).toBe('JavaScript')
    expect(getLanguageByExtension('')).toBe('text')
  })

  it('resolves language names from file paths', () => {
    expect(getLanguageByFilePath('src/app.tsx')).toBe('TSX')
    expect(getLanguageByFilePath('README')).toBe('readme')
  })

  it('resolves extensions from exact names, case-insensitive names, and aliases', () => {
    expect(getExtensionByLanguage('TypeScript')).toBe('.ts')
    expect(getExtensionByLanguage('typescript')).toBe('.ts')
    expect(getExtensionByLanguage('js')).toBe('.js')
    expect(getExtensionByLanguage('visual basic')).toBe('.vb')
  })

  it('falls back to a dotted language name for unknown languages', () => {
    expect(getExtensionByLanguage('custom-language')).toBe('.custom-language')
  })
})
