import { createHash } from 'node:crypto'

import * as z from 'zod'

const rate = z.number().finite().min(0).max(1000000)
export const priceSchema = z.strictObject({
  providerRef: z.string().min(1).max(128),
  modelId: z.string().min(1).max(200),
  currency: z.enum(['CNY', 'USD']),
  basis: z.enum(['key-charge', 'procurement']),
  source: z.string().min(1).max(500),
  group: z.string().min(1).max(128),
  capturedAt: z.string().datetime(),
  validUntil: z.string().datetime(),
  // Explicit effective rates, AFTER the selected key's group/discount. Never evaluate panel billing expressions here.
  tiers: z
    .array(
      z.strictObject({
        throughInputTokens: z.number().int().positive().max(10000000),
        input: rate,
        output: rate,
        cacheRead: rate,
        cacheWrite: rate
      })
    )
    .min(1)
    .max(20)
})
export type Price = z.infer<typeof priceSchema>
export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}
const SCALE = 1000000000n

function count(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid token count')
  return value
}

function nanorate(value: number) {
  // Upward rounding, including sub-micro currency amounts; never round a small request to free.
  return BigInt(Math.ceil(value * Number(SCALE)))
}

function tokenCost(tokens: number, price: number) {
  return (BigInt(count(tokens)) * nanorate(price) + 999999n) / 1000000n
}

export function validatePrice(value: unknown, now = Date.now()) {
  const price = priceSchema.parse(value)
  if (
    Date.parse(price.capturedAt) > now ||
    Date.parse(price.validUntil) <= now ||
    Date.parse(price.validUntil) <= Date.parse(price.capturedAt)
  )
    throw new Error('价格快照未生效或已过期。')
  let previous = 0
  for (const tier of price.tiers) {
    if (tier.throughInputTokens <= previous) throw new Error('价格阶梯必须严格递增。')
    previous = tier.throughInputTokens
  }
  return price
}

export function costNano(price: Price, usage: Usage): bigint {
  Object.values(usage).forEach(count)
  if (usage.cacheRead + usage.cacheWrite > usage.input) throw new Error('缓存不能超过总输入。')
  const tier = price.tiers.find((candidate) => usage.input <= candidate.throughInputTokens)
  if (!tier) throw new Error('输入超出已核实价格阶梯。')
  return (
    tokenCost(usage.input - usage.cacheRead - usage.cacheWrite, tier.input) +
    tokenCost(usage.cacheRead, tier.cacheRead) +
    tokenCost(usage.cacheWrite, tier.cacheWrite) +
    tokenCost(usage.output, tier.output)
  )
}

export function reserveNano(price: Price, input: number, output: number) {
  count(input)
  count(output)
  if (input > price.tiers.at(-1)!.throughInputTokens) throw new Error('预留输入超出报价范围。')
  // A lower tier can be more expensive. Unknown read/write distribution uses the most expensive possibility.
  return price.tiers
    .filter((_tier, index) => index === 0 || price.tiers[index - 1].throughInputTokens < input)
    .reduce((maximum, tier) => {
      const amount =
        tokenCost(input, Math.max(tier.input, tier.cacheRead, tier.cacheWrite)) + tokenCost(output, tier.output)
      return amount > maximum ? amount : maximum
    }, 0n)
}

export function amount(nano: bigint) {
  return Number(nano) / Number(SCALE)
}

export function planDigest(value: unknown) {
  const stable = (item: unknown): unknown =>
    Array.isArray(item)
      ? item.map(stable)
      : item && typeof item === 'object'
        ? Object.fromEntries(
            Object.entries(item)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, val]) => [key, stable(val)])
          )
        : item
  return createHash('sha256')
    .update(JSON.stringify(stable(value)))
    .digest('hex')
}

export class MoneyBudget {
  private held = new Map<number, bigint>()
  private spent = 0n
  private next = 0
  private halted = false
  private unknown = 0
  private limit: bigint

  constructor(maxAmount: number) {
    if (!Number.isFinite(maxAmount) || maxAmount <= 0 || maxAmount > 1000000) throw new Error('Invalid money budget')
    this.limit = BigInt(Math.floor(maxAmount * Number(SCALE)))
  }

  reserve(price: Price, input: number, output: number) {
    const reserve = reserveNano(price, input, output)
    const inFlight = [...this.held.values()].reduce((sum, item) => sum + item, 0n)
    if (this.halted || this.spent + inFlight + reserve > this.limit) throw new Error('金额预算不足，未发送请求。')
    const id = ++this.next
    this.held.set(id, reserve)
    return id
  }

  settle(id: number, price: Price, usage?: Usage) {
    const reserved = this.held.get(id)
    if (reserved === undefined) throw new Error('Unknown/already settled money reservation')
    let charge = reserved
    let basis = 'conservative-reservation'
    if (usage) {
      try {
        charge = costNano(price, usage)
        basis = 'priced-usage'
      } catch {
        this.halted = true
        this.unknown++
      }
    } else this.unknown++
    this.held.delete(id)
    this.spent += charge
    if (charge > reserved || this.spent > this.limit) this.halted = true
    return { amount: amount(charge), basis }
  }

  stop() {
    this.halted = true
  }
  releaseUnsent(id: number) {
    if (!this.held.delete(id)) throw new Error('Unknown/already settled money reservation')
  }
  snapshot() {
    return {
      amount: amount(this.spent),
      reserved: amount([...this.held.values()].reduce((sum, item) => sum + item, 0n)),
      limit: amount(this.limit),
      stopped: this.halted,
      unknownUsage: this.unknown,
      inFlight: this.held.size,
      basis: 'price-snapshot-estimate-not-settled-invoice'
    }
  }
}
