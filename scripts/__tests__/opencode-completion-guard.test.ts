import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { describe, expect, it, vi } from 'vitest'

vi.unmock('node:path')
const file = pathToFileURL(path.resolve('resources/opencode-runtime/completion-guard.mjs')).href

const user = { info: { id: 'user-1', role: 'user' }, parts: [{ type: 'text', text: 'Research this' }] }
const answer = {
  info: { id: 'answer', role: 'assistant', parentID: 'user-1', finish: 'stop', time: { completed: 12 } },
  parts: [{ type: 'text', text: 'Final report' }]
}
const compact = { info: { id: 'compact', role: 'user' }, parts: [{ type: 'compaction' }] }

async function evaluate(messages: unknown[], overflow = false) {
  const module = await import(/* @vite-ignore */ file)
  const client = { session: { messages: vi.fn(async () => ({ data: messages })) } }
  const hooks = await module.default({ client })
  const output = { enabled: true }
  await hooks['experimental.compaction.autocontinue']({ sessionID: 'session', message: compact.info, overflow }, output)
  return output.enabled
}

describe('native compaction completion guard', () => {
  it('routes raw PDF webfetch output to the text parser and bounds oversized webpages', async () => {
    const module = await import(/* @vite-ignore */ file)
    const hooks = await module.default({ client: {} })
    const pdf = { output: '%PDF-1.7 binary garbage', metadata: {}, title: 'Paper' }
    await hooks['tool.execute.after']({ tool: 'webfetch', args: { url: 'https://papers.example/a.pdf' } }, pdf)
    expect(JSON.parse(pdf.output)).toMatchObject({ status: 'pdf_requires_parser', evidence_level: 'unavailable' })
    expect(pdf.output).not.toContain('binary garbage')
    const page = { output: 'x'.repeat(40000), metadata: {}, title: 'Page' }
    await hooks['tool.execute.after']({ tool: 'webfetch', args: {} }, page)
    expect(page.output.length).toBeLessThan(16500)
    expect(page.output).toContain('Partial webpage')
    const local = { output: '%PDF-1.7', metadata: {}, title: 'Native read' }
    await hooks['tool.execute.after']({ tool: 'read', args: {} }, local)
    expect(local.output).toBe('%PDF-1.7')
  })
  it('retains the compaction but suppresses synthetic revival after a completed answer', async () => {
    expect(await evaluate([user, answer, compact])).toBe(false)
  })
  it('keeps native continuation for tool results, even when the provider says stop', async () => {
    expect(await evaluate([user, { ...answer, parts: [...answer.parts, { type: 'tool' }] }, compact])).toBe(true)
  })
  it('keeps native overflow recovery and unfinished requests', async () => {
    expect(await evaluate([user, answer, compact], true)).toBe(true)
    expect(await evaluate([user, { ...answer, info: { ...answer.info, finish: 'tool-calls' } }, compact])).toBe(true)
    expect(await evaluate([user, { ...answer, info: { ...answer.info, error: { name: 'failed' } } }, compact])).toBe(
      true
    )
  })
  it('does not stop a newer user request using an old completed answer', async () => {
    expect(await evaluate([user, answer, { ...user, info: { ...user.info, id: 'user-2' } }, compact])).toBe(true)
    expect(await evaluate([user, answer])).toBe(true)
  })
})
