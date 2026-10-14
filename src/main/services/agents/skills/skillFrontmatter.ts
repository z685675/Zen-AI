import { parseDocument } from 'yaml'

/** Inspection is data-only. Never let a frontmatter library select a JS/eval engine. */
export function readSkillFrontmatter(source: string): { data: Record<string, unknown>; content: string } {
  const match = source
    .replace(/^\uFEFF/, '')
    .match(/^---(?:yaml|yml|json)?[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/)
  if (!match) throw new Error('Skill frontmatter must be YAML or JSON data')
  const document = parseDocument(match[1], { schema: 'failsafe' })
  if (document.errors.length || document.warnings.length) throw new Error('Unsupported skill metadata')
  const value: unknown = document.toJS({ maxAliasCount: 20 })
  return {
    data: value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    content: match[2]
  }
}
