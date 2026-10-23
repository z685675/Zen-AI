import { PassThrough } from 'node:stream'

import { describe, expect, it, vi } from 'vitest'

import { readSecret } from '../terminal'

function fixture() {
  const stream = new PassThrough()
  const input = Object.assign(stream, {
    isTTY: true,
    isRaw: false,
    setRawMode: vi.fn()
  }) as unknown as NodeJS.ReadStream
  const write = vi.fn()
  return { input, write }
}

describe('hidden credential input', () => {
  it('masks input, supports correction and restores terminal listeners/raw mode', async () => {
    const { input, write } = fixture()
    const pending = readSecret('Key', undefined, input, { write })
    input.emit('keypress', 's', { name: 's' })
    input.emit('keypress', 'x', { name: 'x' })
    input.emit('keypress', undefined, { name: 'backspace' })
    input.emit('keypress', 'ecret', {})
    input.emit('keypress', '\r', { name: 'return' })
    expect(await pending).toBe('secret')
    expect(write.mock.calls.flat().join('')).not.toContain('secret')
    expect(input.setRawMode).toHaveBeenLastCalledWith(false)
    expect(input.listenerCount('keypress')).toBe(0)
  })
  it('cleans up on Ctrl+C and abort, and refuses an echoing pipe', async () => {
    const { input, write } = fixture()
    const pending = readSecret('Key', undefined, input, { write })
    input.emit('keypress', 'c', { name: 'c', ctrl: true })
    await expect(pending).rejects.toThrow('取消')
    const controller = new AbortController()
    const next = readSecret('Key', controller.signal, input, { write })
    controller.abort()
    await expect(next).rejects.toThrow('取消')
    expect(input.listenerCount('keypress')).toBe(0)
    expect(() => readSecret('Key', undefined, new PassThrough() as unknown as NodeJS.ReadStream, { write })).toThrow(
      '交互终端'
    )
  })
})
