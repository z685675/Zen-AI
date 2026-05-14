import { describe, expect, it, vi } from 'vitest'

import { formatErrorForClipboard, formatErrorMessage, getErrorDetails, isAbortError, isTimeoutError } from '../error'

describe('error', () => {
  describe('getErrorDetails', () => {
    it('should handle null or non-object values', () => {
      expect(getErrorDetails(null)).toBeNull()
      expect(getErrorDetails('string error')).toBe('string error')
      expect(getErrorDetails(123)).toBe(123)
    })

    it('should handle circular references', () => {
      const circularObj: any = {}
      circularObj.self = circularObj

      const result = getErrorDetails(circularObj)
      expect(result).toEqual({ self: circularObj })
    })

    it('should extract properties from Error objects', () => {
      const error = new Error('Test error')
      const result = getErrorDetails(error)

      expect(result.message).toBe('Test error')
      expect(result.stack).toBeDefined()
    })

    it('should skip function properties', () => {
      const objWithFunction = {
        prop: 'value',
        func: () => 'function'
      }

      const result = getErrorDetails(objWithFunction)
      expect(result.prop).toBe('value')
      expect(result.func).toBeUndefined()
    })

    it('should handle nested objects', () => {
      const nestedError = {
        message: 'Outer error',
        cause: new Error('Inner error')
      }

      const result = getErrorDetails(nestedError)
      expect(result.message).toBe('Outer error')
      expect(result.cause.message).toBe('Inner error')
    })
  })

  describe('formatErrorMessage', () => {
    it('should format error with message directly when message exists', () => {
      console.error = vi.fn()

      const error = new Error('Test error')
      const result = formatErrorMessage(error)

      // When error has a message property, it returns the message directly
      expect(result).toBe('Test error')
    })

    it('should return message directly when error object has message property', () => {
      console.error = vi.fn()

      const error = {
        message: 'API error',
        headers: { Authorization: 'Bearer token' },
        stack: 'Error stack trace',
        request_id: '12345'
      }

      const result = formatErrorMessage(error)

      // When error has a message property, it returns the message directly
      expect(result).toBe('API error')
    })

    it('should handle errors during formatting and return placeholder message', () => {
      console.error = vi.fn()

      const problematicError = {
        get message() {
          throw new Error('Cannot access')
        }
      }

      const result = formatErrorMessage(problematicError)
      // When message property throws error, it's caught and set to '<Unable to access property>'
      expect(result).toBe('<Unable to access property>')
    })

    it('should format error object without message property with full details', () => {
      console.error = vi.fn()

      const errorWithoutMessage = {
        code: 500,
        status: 'Internal Server Error'
      }

      const result = formatErrorMessage(errorWithoutMessage)
      // When no message property exists, it returns full error details
      expect(result).toContain('Error Details:')
      expect(result).toContain('"code": 500')
      expect(result).toContain('"status": "Internal Server Error"')
    })
  })

  describe('isAbortError', () => {
    it('should identify OpenAI abort errors by message', () => {
      const openaiError = { message: 'Request was aborted.' }
      expect(isAbortError(openaiError)).toBe(true)
    })

    it('should identify DOM AbortError', () => {
      const domError = new DOMException('The operation was aborted', 'AbortError')
      expect(isAbortError(domError)).toBe(true)
    })

    it('should identify aborted signal errors', () => {
      const signalError = { message: 'The operation was aborted because signal is aborted without reason' }
      expect(isAbortError(signalError)).toBe(true)
    })

    it('should return false for other errors', () => {
      expect(isAbortError(new Error('Generic error'))).toBe(false)
      expect(isAbortError({ message: 'Not an abort error' })).toBe(false)
      expect(isAbortError('String error')).toBe(false)
      expect(isAbortError(null)).toBe(false)
    })

    it('should return false for timeout errors', () => {
      const timeoutError = new DOMException('The operation timed out', 'TimeoutError')
      expect(isAbortError(timeoutError)).toBe(false)
    })
  })

  describe('isTimeoutError', () => {
    it('should identify DOM TimeoutError', () => {
      const timeoutError = new DOMException('The operation timed out', 'TimeoutError')
      expect(isTimeoutError(timeoutError)).toBe(true)
    })

    it('should identify timeout errors wrapped in error.cause', () => {
      const timeoutError = new DOMException('The operation timed out', 'TimeoutError')
      const wrappedError = new Error('Wrapped error') as Error & { cause: unknown }
      wrappedError.cause = timeoutError
      expect(isTimeoutError(wrappedError)).toBe(true)
    })

    it('should return false for AbortError', () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      expect(isTimeoutError(abortError)).toBe(false)
    })

    it('should return false for generic errors', () => {
      expect(isTimeoutError(new Error('Generic error'))).toBe(false)
      expect(isTimeoutError({ message: 'Not a timeout error' })).toBe(false)
      expect(isTimeoutError('String error')).toBe(false)
      expect(isTimeoutError(null)).toBe(false)
    })

    it('should return false when error.cause is not a TimeoutError', () => {
      const abortError = new DOMException('The operation was aborted', 'AbortError')
      const wrappedError = new Error('Wrapped error') as Error & { cause: unknown }
      wrappedError.cause = abortError
      expect(isTimeoutError(wrappedError)).toBe(false)
    })
  })

  describe('formatErrorForClipboard', () => {
    it('keeps clipboard output concise for API errors with huge payloads', () => {
      const result = formatErrorForClipboard({
        name: 'AI_APICallError',
        message: 'Request failed',
        stack: 'stack',
        providerId: 'openai',
        modelId: 'gpt-4.1',
        statusCode: 400,
        zenTraceId: 'trace_123',
        responseBody: JSON.stringify({
          error: {
            message: 'context length exceeded',
            type: 'invalid_request_error',
            code: 'context_length_exceeded'
          },
          huge: 'x'.repeat(10000)
        }),
        requestBodyValues: {
          messages: new Array(500).fill('very long prompt')
        }
      })

      expect(result).toContain('错误消息: Request failed')
      expect(result).toContain('状态码: 400')
      expect(result).toContain('Provider: openai')
      expect(result).toContain('模型: gpt-4.1')
      expect(result).toContain('Trace ID: trace_123')
      expect(result).toContain('服务返回:')
      expect(result).not.toContain('very long prompt')
      expect(result.length).toBeLessThanOrEqual(3100)
    })

    it('extracts nested service error summaries instead of dumping raw json', () => {
      const result = formatErrorForClipboard({
        name: 'AI_APICallError',
        message: 'Upstream failed',
        stack: null,
        data: {
          error: {
            message: 'insufficient_quota',
            code: 'quota_exceeded',
            type: 'billing_error'
          }
        }
      })

      expect(result).toContain('错误消息: Upstream failed')
      expect(result).toContain('服务返回: message: insufficient_quota; type: billing_error; code: quota_exceeded')
    })
  })
})
