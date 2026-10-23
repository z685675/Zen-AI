import { describe, expect, it, vi } from 'vitest'

import {
  chooseFileInputs,
  chooseFormats,
  chooseModules,
  chooseProviderURL,
  DEFAULT_QUALITY_PROVIDER_URL,
  parseChoices
} from '../choices'
import { fileKinds } from '../matrix'

describe('interactive acceptance scope choices', () => {
  const modules = ['files', 'history', 'memory'] as const

  it.each(['', '   ', 'all', ' ALL ', '全部'])('selects the entire displayed list for %j', (answer) => {
    expect(parseChoices(answer, modules)).toEqual(modules)
    const formats = parseChoices(answer, fileKinds)
    expect(formats).toEqual(fileKinds)
    expect(formats).not.toBe(fileKinds)
  })

  it.each(['files', 'history', 'memory'])('accepts the English word %s alone', (answer) => {
    expect(parseChoices(answer, modules)).toEqual([answer])
  })

  it.each(['FILES,HISTORY', ' files history ', 'Files，History', 'files、history', 'files;history'])(
    'normalizes case and separators in %j',
    (answer) => {
      expect(parseChoices(answer, modules)).toEqual(['files', 'history'])
    }
  )

  it('accepts file formats without silently adding other formats', () => {
    expect(parseChoices('JSON XLSX', fileKinds)).toEqual(['json', 'xlsx'])
  })

  it.each([',,,', 'file', 'files,unknown', 'all,files', '1', 'files文件'])(
    'rejects %j instead of silently expanding or dropping choices',
    (answer) => {
      expect(() => parseChoices(answer, modules)).toThrow('选择无效')
    }
  )

  it('rejects duplicate choices after normalization', () => {
    expect(() => parseChoices('files,FILES', modules)).toThrow('重复')
  })

  it('retries invalid choices in place and prints the actual selection', async () => {
    const ask = vi.fn().mockResolvedValueOnce('files,typo').mockResolvedValueOnce('history')
    const write = vi.fn()
    await expect(chooseModules({ ask, write }, 'release')).resolves.toEqual(['history'])
    expect(ask).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.flat().join('')).toContain('选择无效')
    expect(write.mock.calls.flat().join('')).toContain('已选择：history')
  })

  it('requires memory in deep mode but accepts Enter as all modules', async () => {
    const ask = vi.fn().mockResolvedValueOnce('files').mockResolvedValueOnce('')
    const write = vi.fn()
    await expect(chooseModules({ ask, write }, 'deep')).resolves.toEqual(modules)
    expect(ask).toHaveBeenCalledTimes(2)
    expect(write.mock.calls.flat().join('')).toContain('deep必须包含memory')
  })

  it('makes image billing requirements visible before accepting all formats', async () => {
    const ask = vi.fn().mockResolvedValue('')
    await expect(chooseFormats({ ask, write: vi.fn() })).resolves.toEqual(fileKinds)
    expect(ask.mock.calls[0][0]).toContain('回车默认全部')
    expect(ask.mock.calls[0][0]).toContain('png/jpg稍后需确认')
  })

  it('lets the operator cancel rather than treating q as all', async () => {
    await expect(chooseModules({ ask: vi.fn().mockResolvedValue(' Q '), write: vi.fn() }, 'release')).rejects.toThrow(
      '已取消选择'
    )
  })

  it('propagates terminal cancellation rather than swallowing it as a bad choice', async () => {
    const ask = vi.fn().mockRejectedValue(new Error('已取消。'))
    await expect(chooseFormats({ ask, write: vi.fn() })).rejects.toThrow('已取消')
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('shows the default API address and accepts Enter without asking for any other value', async () => {
    const ask = vi.fn().mockResolvedValue('  ')
    const write = vi.fn()
    await expect(chooseProviderURL({ ask, write })).resolves.toBe('https://zenai.925636.xyz/v1')
    expect(ask).toHaveBeenCalledTimes(1)
    expect(ask.mock.calls[0][0]).toContain(DEFAULT_QUALITY_PROVIDER_URL)
    expect(write).toHaveBeenCalledWith(`本次API地址：${DEFAULT_QUALITY_PROVIDER_URL}\n`)
  })

  it('respects a custom API address rather than replacing it with the default', async () => {
    await expect(
      chooseProviderURL({ ask: vi.fn().mockResolvedValue(' https://owned-fixture.invalid/v1/ '), write: vi.fn() })
    ).resolves.toBe('https://owned-fixture.invalid/v1')
  })

  it.each(['not-a-url', 'http://external.invalid/v1', 'https://fixture.invalid/v1?key=do-not-echo'])(
    're-prompts an invalid or unsafe API address %s without echoing credentials',
    async (answer) => {
      const ask = vi.fn().mockResolvedValueOnce(answer).mockResolvedValueOnce('')
      const write = vi.fn()
      await expect(chooseProviderURL({ ask, write })).resolves.toBe(DEFAULT_QUALITY_PROVIDER_URL)
      expect(ask).toHaveBeenCalledTimes(2)
      expect(write.mock.calls.flat().join('')).toContain('API地址无效')
      expect(write.mock.calls.flat().join('')).not.toContain('do-not-echo')
    }
  )

  it('allows a local test API address', async () => {
    await expect(
      chooseProviderURL({ ask: vi.fn().mockResolvedValue('http://127.0.0.1:1234/v1'), write: vi.fn() })
    ).resolves.toBe('http://127.0.0.1:1234/v1')
  })

  it('allows cancelling the provider step instead of silently using the default', async () => {
    await expect(chooseProviderURL({ ask: vi.fn().mockResolvedValue(' Q '), write: vi.fn() })).rejects.toThrow(
      '已取消选择'
    )
  })

  it.each(['', '   ', '0', '-1', '1.5', '200001', '1e4', '8192abc', 'NaN'])(
    're-prompts image reservation %j without changing formats or silently authorizing billing',
    async (answer) => {
      const ask = vi.fn().mockResolvedValueOnce('png').mockResolvedValueOnce(answer).mockResolvedValueOnce('8192')
      const write = vi.fn()
      await expect(chooseFileInputs({ ask, write })).resolves.toEqual({
        formats: ['png'],
        vision: { maxImageTokensPerRequest: 8192, acknowledgedTokenBilling: true }
      })
      expect(ask).toHaveBeenCalledTimes(3)
      expect(write.mock.calls.flat().join('')).toContain('图片Token预留不能为空')
      expect(ask.mock.calls[1][0]).toContain('建议8192')
      expect(ask.mock.calls[1][0]).toContain('确认此Provider的图片按输入Token计费')
    }
  )

  it.each([1, 200000])('accepts the image reservation boundary %i', async (tokens) => {
    const ask = vi.fn().mockResolvedValueOnce('jpg').mockResolvedValueOnce(String(tokens))
    await expect(chooseFileInputs({ ask, write: vi.fn() })).resolves.toEqual({
      formats: ['jpg'],
      vision: { maxImageTokensPerRequest: tokens, acknowledgedTokenBilling: true }
    })
  })

  it.each(['b', 'BACK', '返回'])('returns to explicit format selection on %s', async (answer) => {
    const ask = vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce(answer).mockResolvedValueOnce('json,xlsx')
    const write = vi.fn()
    await expect(chooseFileInputs({ ask, write })).resolves.toEqual({ formats: ['json', 'xlsx'] })
    expect(write.mock.calls.flat().join('')).toContain('已返回文件格式选择')
    expect(ask.mock.calls[2][0]).toContain('选择文件格式')
  })

  it('still requires image billing after returning and selecting images again', async () => {
    const ask = vi
      .fn()
      .mockResolvedValueOnce('png')
      .mockResolvedValueOnce('b')
      .mockResolvedValueOnce('jpg')
      .mockResolvedValueOnce('4096')
    await expect(chooseFileInputs({ ask, write: vi.fn() })).resolves.toEqual({
      formats: ['jpg'],
      vision: { maxImageTokensPerRequest: 4096, acknowledgedTokenBilling: true }
    })
    expect(ask).toHaveBeenCalledTimes(4)
  })

  it('does not ask about image billing when no image format was selected', async () => {
    const ask = vi.fn().mockResolvedValueOnce('pdf')
    await expect(chooseFileInputs({ ask, write: vi.fn() })).resolves.toEqual({ formats: ['pdf'] })
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('allows cancellation after an empty image reservation', async () => {
    const ask = vi.fn().mockResolvedValueOnce('png').mockResolvedValueOnce('').mockResolvedValueOnce('q')
    await expect(chooseFileInputs({ ask, write: vi.fn() })).rejects.toThrow('已取消选择')
    expect(ask).toHaveBeenCalledTimes(3)
  })

  it('propagates terminal cancellation during image billing instead of retrying', async () => {
    const ask = vi.fn().mockResolvedValueOnce('png').mockRejectedValueOnce(new Error('已取消。'))
    await expect(chooseFileInputs({ ask, write: vi.fn() })).rejects.toThrow('已取消')
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
