import { AssistantMessageStatus, type Message, UserMessageStatus } from '@renderer/types/newMessage'
import { bench, describe, expect, test } from 'vitest'

// ============================================================================
// 1. 缂栧啓鐢ㄤ簬瀵规瘮鐨勭畻娉?// ============================================================================

// 鏃х増鏈綔涓哄熀绾匡細鍖呭惈 [...messages].reverse()
const baseline = (messages: Message[], startIndex: number, displayCount: number) => {
  const reversedMessages = [...messages].reverse()

  if (reversedMessages.length - startIndex <= displayCount) {
    return reversedMessages.slice(startIndex)
  }

  const userIdSet = new Set<string>()
  const assistantIdSet = new Set<string>()
  const displayMessages: Message[] = []

  const processMessage = (message: Message) => {
    if (!message) return
    const idSet = message.role === 'user' ? userIdSet : assistantIdSet
    const messageId = message.role === 'user' ? message.id : message.askId

    if (!idSet.has(messageId!)) {
      idSet.add(messageId!)
      displayMessages.push(message)
      return
    }
    displayMessages.push(message)
  }

  for (let i = startIndex; i < reversedMessages.length && userIdSet.size + assistantIdSet.size < displayCount; i++) {
    processMessage(reversedMessages[i])
  }

  return displayMessages
}

// 鏂扮増鏈細鐩存帴浣跨敤鍘熺敓绱㈠紩鍊掑簭閬嶅巻
const byBackwardIndex = (messages: Message[], startIndex: number, displayCount: number) => {
  if (messages.length - startIndex <= displayCount) {
    const result: Message[] = []
    for (let i = messages.length - 1 - startIndex; i >= 0; i--) {
      result.push(messages[i])
    }
    return result
  }

  const userIdSet = new Set<string>()
  const assistantIdSet = new Set<string>()
  const displayMessages: Message[] = []

  const processMessage = (message: Message) => {
    if (!message) return
    const idSet = message.role === 'user' ? userIdSet : assistantIdSet
    const messageId = message.role === 'user' ? message.id : message.askId

    if (!idSet.has(messageId!)) {
      idSet.add(messageId!)
      displayMessages.push(message)
      return
    }
    displayMessages.push(message)
  }

  for (let i = messages.length - 1 - startIndex; i >= 0 && userIdSet.size + assistantIdSet.size < displayCount; i--) {
    processMessage(messages[i])
  }

  return displayMessages
}

// ============================================================================
// 2. 鏋勯?犳祴璇曟暟鎹紝骞堕獙璇佺畻娉曠粨鏋滀竴鑷存??// ============================================================================

// 浣跨敤鍥哄畾鏃堕棿鎴?const generateMockMessages = (count: number): Message[] => {
  const BASE_TIMESTAMP = 1700000000000
  const messages: Message[] = []

  for (let i = 0; i < count; i++) {
    const isUser = i % 2 === 0
    messages.push({
      id: `msg-${i}`,
      role: isUser ? 'user' : 'assistant',
      assistantId: 'mock-assistant',
      topicId: 'mock-topic',
      createdAt: new Date(BASE_TIMESTAMP + i * 1000).toISOString(),
      status: isUser ? UserMessageStatus.SUCCESS : AssistantMessageStatus.SUCCESS,

      blocks: [],
      askId: isUser ? undefined : `msg-${i - 1}`
    } satisfies Message)
  }

  return messages
}

// 鍦烘櫙锛氫笉鍚屾秷鎭暟閲?const SCENARIOS = [100, 1000, 10000] as const
const mockDataMap = Object.fromEntries(SCENARIOS.map((n) => [n, generateMockMessages(n)])) as Record<
  (typeof SCENARIOS)[number],
  Message[]
>

// 娴嬭瘯缁撴灉鏄惁涓?鑷?test('computeOld and computeNew should produce identical results', () => {
  const sample = mockDataMap[100]
  expect(baseline(sample, 0, 20)).toEqual(byBackwardIndex(sample, 0, 20))
})

// ============================================================================
// 3. 鍩哄噯娴嬭瘯
// ============================================================================

// Benchmark 閰嶇疆
const benchOptions = (overrides = {}) => ({
  iterations: 1000,
  warmupIterations: 200,
  ...overrides
})

describe('computeDisplayMessages Performance', () => {
  SCENARIOS.forEach((totalCount) => {
    describe(`${totalCount} messages`, () => {
      const mockData = mockDataMap[totalCount]

      bench(
        'spread + reverse (O(n) copy)',
        () => {
          baseline(mockData, 0, 20)
        },
        benchOptions()
      )

      bench(
        'in-place backward index (no copy)',
        () => {
          byBackwardIndex(mockData, 0, 20)
        },
        benchOptions()
      )
    })
  })
})
