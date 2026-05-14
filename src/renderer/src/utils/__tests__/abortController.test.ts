import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  abortCompletion,
  abortMap,
  addAbortController,
  createAbortPromise,
  removeAbortController
} from '../abortController'

vi.mock('@renderer/config/logger', () => ({
  default: {
    log: vi.fn()
  }
}))

describe('abortController', () => {
  beforeEach(() => {
    abortMap.clear()
  })

  describe('addAbortController', () => {
    it('adds an abort function to the map', () => {
      const abortFn = vi.fn()

      addAbortController('test-id', abortFn)

      expect(abortMap.get('test-id')).toContain(abortFn)
    })

    it('supports multiple abort functions for the same id', () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn()

      addAbortController('test-id', fn1)
      addAbortController('test-id', fn2)

      expect(abortMap.get('test-id')).toEqual([fn1, fn2])
    })

    it('allows duplicate functions for the same id', () => {
      const fn = vi.fn()

      addAbortController('test-id', fn)
      addAbortController('test-id', fn)

      expect(abortMap.get('test-id')).toEqual([fn, fn])
    })

    it('supports an empty string id', () => {
      const fn = vi.fn()

      addAbortController('', fn)

      expect(abortMap.get('')).toContain(fn)
    })
  })

  describe('removeAbortController', () => {
    it('removes a specific abort function', () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn()

      addAbortController('test-id', fn1)
      addAbortController('test-id', fn2)
      removeAbortController('test-id', fn1)

      expect(abortMap.get('test-id')).toEqual([fn2])
    })

    it('ignores non-existent functions', () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn()

      addAbortController('test-id', fn1)
      removeAbortController('test-id', fn2)

      expect(abortMap.get('test-id')).toEqual([fn1])
    })

    it('handles an empty string id', () => {
      const fn = vi.fn()

      addAbortController('', fn)
      removeAbortController('', fn)

      expect(abortMap.get('')).toEqual([])
    })

    it('ignores non-existent ids', () => {
      const fn = vi.fn()

      expect(() => removeAbortController('missing-id', fn)).not.toThrow()
    })
  })

  describe('abortCompletion', () => {
    it('calls all abort functions and cleans them up', () => {
      const fn1 = vi.fn()
      const fn2 = vi.fn()

      addAbortController('test-id', fn1)
      addAbortController('test-id', fn2)
      abortCompletion('test-id')

      expect(fn1).toHaveBeenCalledTimes(1)
      expect(fn2).toHaveBeenCalledTimes(1)
      expect(abortMap.get('test-id')).toEqual([])
    })

    it('ignores non-existent ids', () => {
      expect(() => abortCompletion('missing-id')).not.toThrow()
    })

    it('handles an empty string id', () => {
      expect(() => abortCompletion('')).not.toThrow()
    })

    it('keeps empty arrays untouched', () => {
      abortMap.set('test-id', [])

      expect(() => abortCompletion('test-id')).not.toThrow()
      expect(abortMap.has('test-id')).toBe(true)
    })
  })

  describe('createAbortPromise', () => {
    it('rejects immediately when the signal is already aborted', async () => {
      const controller = new AbortController()
      controller.abort()

      await expect(createAbortPromise(controller.signal, Promise.resolve('success'))).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Operation aborted'
      })
    })

    it('rejects when the signal aborts later', async () => {
      const controller = new AbortController()
      const finallyPromise = new Promise<string>(() => {})
      const promise = createAbortPromise(controller.signal, finallyPromise)

      setTimeout(() => controller.abort(), 10)

      await expect(promise).rejects.toThrow('Operation aborted')
    })

    it('cleans up the event listener when the tracked promise settles', async () => {
      const controller = new AbortController()
      const finallyPromise = Promise.resolve('completed')
      const removeEventListenerSpy = vi.spyOn(controller.signal, 'removeEventListener')

      void createAbortPromise(controller.signal, finallyPromise)
      await finallyPromise
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(removeEventListenerSpy).toHaveBeenCalledWith('abort', expect.any(Function))
    })

    it('stays pending when the tracked promise resolves normally', async () => {
      const controller = new AbortController()
      const finallyPromise = Promise.resolve('success')
      const abortPromise = createAbortPromise(controller.signal, finallyPromise)

      await finallyPromise

      let rejected = false
      abortPromise.catch(() => {
        rejected = true
      })

      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(rejected).toBe(false)
    })

    it('rejects if the signal is already aborted before promise creation', async () => {
      const controller = new AbortController()
      controller.abort()

      const finallyPromise = new Promise<string>(() => {})

      await expect(createAbortPromise(controller.signal, finallyPromise)).rejects.toMatchObject({
        name: 'AbortError',
        message: 'Operation aborted'
      })
    })
  })
})
