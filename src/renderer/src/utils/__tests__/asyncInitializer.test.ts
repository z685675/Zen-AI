import { describe, expect, it, vi } from 'vitest'

import { AsyncInitializer } from '../asyncInitializer'

describe('AsyncInitializer', () => {
  it('should initialize value lazily on first get', async () => {
    const mockFactory = vi.fn().mockResolvedValue('test-value')
    const initializer = new AsyncInitializer(mockFactory)

    // factory 涓嶅簲璇ュ湪鏋勯?犳椂璋冪敤
    expect(mockFactory).not.toHaveBeenCalled()

    // 绗竴娆¤皟鐢?get
    const result = await initializer.get()

    expect(mockFactory).toHaveBeenCalledTimes(1)
    expect(result).toBe('test-value')
  })

  it('should cache value and return same instance on subsequent calls', async () => {
    const mockFactory = vi.fn().mockResolvedValue('test-value')
    const initializer = new AsyncInitializer(mockFactory)

    // 澶氭璋冪敤 get
    const result1 = await initializer.get()
    const result2 = await initializer.get()
    const result3 = await initializer.get()

    // factory 鍙簲璇ヨ璋冪敤涓?娆?    expect(mockFactory).toHaveBeenCalledTimes(1)

    // 鎵?鏈夌粨鏋滃簲璇ョ浉鍚?    expect(result1).toBe('test-value')
    expect(result2).toBe('test-value')
    expect(result3).toBe('test-value')
  })

  it('should handle concurrent calls properly', async () => {
    let resolveFactory: (value: string) => void
    const factoryPromise = new Promise<string>((resolve) => {
      resolveFactory = resolve
    })
    const mockFactory = vi.fn().mockReturnValue(factoryPromise)

    const initializer = new AsyncInitializer(mockFactory)

    // 鍚屾椂璋冪敤澶氭 get
    const promise1 = initializer.get()
    const promise2 = initializer.get()
    const promise3 = initializer.get()

    // factory 鍙簲璇ヨ璋冪敤涓?娆?    expect(mockFactory).toHaveBeenCalledTimes(1)

    // 瑙ｆ瀽 promise
    resolveFactory!('concurrent-value')

    const results = await Promise.all([promise1, promise2, promise3])
    expect(results).toEqual(['concurrent-value', 'concurrent-value', 'concurrent-value'])
  })

  it('should handle and cache errors', async () => {
    const error = new Error('Factory error')
    const mockFactory = vi.fn().mockRejectedValue(error)
    const initializer = new AsyncInitializer(mockFactory)

    // 澶氭璋冪敤閮藉簲璇ヨ繑鍥炵浉鍚岀殑閿欒
    await expect(initializer.get()).rejects.toThrow('Factory error')
    await expect(initializer.get()).rejects.toThrow('Factory error')

    // factory 鍙簲璇ヨ璋冪敤涓?娆?    expect(mockFactory).toHaveBeenCalledTimes(1)
  })

  it('should not retry after failure', async () => {
    // 纭閿欒琚紦瀛橈紝涓嶄細閲嶈瘯
    const error = new Error('Initialization failed')
    const mockFactory = vi.fn().mockRejectedValue(error)
    const initializer = new AsyncInitializer(mockFactory)

    // 绗竴娆″け璐?    await expect(initializer.get()).rejects.toThrow('Initialization failed')

    // 绗簩娆¤皟鐢ㄤ笉搴旇閲嶈瘯
    await expect(initializer.get()).rejects.toThrow('Initialization failed')

    // factory 鍙璋冪敤涓?娆?    expect(mockFactory).toHaveBeenCalledTimes(1)
  })
})
