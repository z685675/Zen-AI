import AiSdkToChunkAdapter from '@renderer/aiCore/chunk/AiSdkToChunkAdapter'
import { type Chunk, ChunkType } from '@renderer/types/chunk'
import { AgentTaskLimitError, getAgentTaskLimitDetails } from '@shared/agents/taskConcurrency'
import { describe, expect, it, vi } from 'vitest'

import { getAgentTaskDeadlineKind } from '../agentTaskDeadline'
import {
  formatErrorForClipboard,
  formatErrorMessage,
  getErrorDetails,
  isAbortError,
  isTimeoutError,
  serializeError
} from '../error'

describe('error', () => {
  it.each(['agent_human_wait_timeout', 'agent_execution_timeout'])(
    'preserves %s through stream conversion and saved history',
    async (code) => {
      const chunks: Chunk[] = []
      const adapter = new AiSdkToChunkAdapter((chunk) => chunks.push(chunk))
      await adapter.processStream({
        text: Promise.resolve(''),
        fullStream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'error',
              error: {
                name: 'Error',
                message: 'saved task state was preserved',
                code,
                zenFailureStage: 'local-task-deadline'
              }
            })
            controller.close()
          }
        })
      })
      const chunk = chunks.find((part) => part.type === ChunkType.ERROR)
      if (chunk?.type !== ChunkType.ERROR) throw new Error('Expected error chunk')
      const saved = JSON.parse(JSON.stringify(serializeError(chunk.error)))
      expect(getAgentTaskDeadlineKind(saved)).toBe(code === 'agent_human_wait_timeout' ? 'human-wait' : 'execution')
      expect(saved.zenFailureStage).toBe('local-task-deadline')
      expect(isAbortError(chunk.error)).toBe(false)
    }
  )
  it('keeps task-capacity details for the compact notice after saving and reloading history', () => {
    const saved = JSON.parse(JSON.stringify(serializeError(new AgentTaskLimitError(3, 3))))
    expect(getAgentTaskLimitDetails(saved)).toEqual({ limit: 3, activeTasks: 3 })
    expect(saved.zenFailureStage).toBe('local-task-admission')
  })
  it.each([1, 3])(
    'preserves the %i-task notice through the actual SSE-to-SDK adapter and serialization',
    async (limit) => {
      const chunks: Chunk[] = []
      const adapter = new AiSdkToChunkAdapter((chunk) => chunks.push(chunk))
      await adapter.processStream({
        text: Promise.resolve(''),
        fullStream: new ReadableStream({
          start(controller) {
            controller.enqueue({
              type: 'error',
              error: JSON.parse(JSON.stringify(new AgentTaskLimitError(limit, limit)))
            })
            controller.close()
          }
        })
      })
      const errorChunk = chunks.find((chunk) => chunk.type === ChunkType.ERROR)
      expect(errorChunk?.type).toBe(ChunkType.ERROR)
      if (errorChunk?.type !== ChunkType.ERROR) throw new Error('Expected error chunk')
      expect(getAgentTaskLimitDetails(errorChunk.error)).toEqual({ limit, activeTasks: limit })
      const saved = JSON.parse(JSON.stringify(serializeError(errorChunk.error)))
      expect(getAgentTaskLimitDetails(saved)).toEqual({ limit, activeTasks: limit })
      expect(saved.zenFailureStage).toBe('local-task-admission')
    }
  )
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
