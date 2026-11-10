import { createHmac, randomBytes } from 'node:crypto'

import { ContextSourceAudit } from './contextSourceAudit'

export const TOOL_ARGUMENT_AUDIT_VERSION = 1
const MAX_ARGUMENT_BYTES = 256 * 1024
const MAX_REQUEST_BYTES = 2 * 1024 * 1024
const MAX_CALLS = 128
const object = (value: unknown): Record<string, any> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : undefined
const label = (value: unknown) => (typeof value === 'string' && value.length <= 200 ? value : undefined)

// Canonical JSON makes whitespace and object key order irrelevant. A new secret
// per turn prevents exported fingerprints from becoming a dictionary of inputs.
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error('argument depth limit')
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item, depth + 1)).join(',')}]`
  const record = object(value)
  if (record)
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key], depth + 1)}`)
      .join(',')}}`
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('not JSON')
  return encoded
}

function boundedInput(value: unknown): boolean {
  let bytes = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > 10_000 || depth > 64 || bytes > MAX_ARGUMENT_BYTES) return false
    if (typeof item === 'string') bytes += Buffer.byteLength(item)
    else if (Array.isArray(item)) {
      for (const child of item) if (!visit(child, depth + 1)) return false
    } else {
      const record = object(item)
      if (record)
        for (const key in record) {
          if (!Object.hasOwn(record, key)) continue
          bytes += Buffer.byteLength(key)
          if (!visit(record[key], depth + 1)) return false
        }
    }
    return bytes <= MAX_ARGUMENT_BYTES
  }
  return visit(value, 0)
}

type RecordAudit = (event: string, details: Record<string, unknown>) => void
type Schema = { required: string[]; fingerprint: string }
type Call = {
  id?: string
  name?: string
  text: string
  snapshot?: unknown
  snapshotFinal?: boolean
  fragments: number
  limited: boolean
  completed: boolean
}

/** Observation only: no argument values are logged, persisted or rewritten. */
export class ToolArgumentAuditScope {
  private key = randomBytes(32)
  private emitted = 0
  private contextRequests = 0
  private contextAudit = new ContextSourceAudit((text) => this.fingerprint(text))
  constructor(private record: RecordAudit) {}

  fingerprint(value: string) {
    return createHmac('sha256', this.key).update(value).digest('hex')
  }

  requestContext(transportRequestId: string, requestBytes: number, body?: Record<string, any>) {
    if (this.contextRequests++ >= MAX_CALLS) return
    try {
      this.record('context-sources', {
        runtime: 'opencode',
        transportRequestId,
        requestBytes,
        ...(body ? this.contextAudit.inspect(body) : { contextAuditVersion: 1, coverage: 'unavailable' })
      })
    } catch {
      /* Diagnostic failures never change forwarding. */
    }
  }

  emit(details: Record<string, unknown>) {
    // A pathological model cannot fill diagnostics or stall execution.
    if (this.emitted > MAX_CALLS * 4) return
    if (this.emitted === MAX_CALLS * 4) details = { phase: 'audit-limit', argumentComplete: false }
    this.emitted++
    try {
      this.record('tool-arguments', { runtime: 'opencode', auditVersion: TOOL_ARGUMENT_AUDIT_VERSION, ...details })
    } catch {
      /* Diagnostics cannot change a tool's outcome. */
    }
  }

  describe(input: unknown, encoded = false): Record<string, unknown> {
    try {
      if (!boundedInput(input)) return { argumentState: 'limited' }
      const text = encoded && typeof input === 'string' ? input : JSON.stringify(input)
      if (text === undefined) return { argumentState: 'missing', argumentBytes: 0 }
      const bytes = Buffer.byteLength(text)
      if (bytes > MAX_ARGUMENT_BYTES) return { argumentState: 'limited', argumentBytes: bytes }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        return { argumentState: 'invalid-json', argumentBytes: bytes }
      }
      const record = object(parsed)
      return {
        argumentState: record ? (Object.keys(record).length ? 'object' : 'empty-object') : 'not-object',
        argumentBytes: bytes,
        argumentKeys: record ? Object.keys(record).length : 0,
        argumentFingerprint: this.fingerprint(canonical(parsed))
      }
    } catch {
      return { argumentState: 'limited' }
    }
  }

  native(toolCallId: string, toolName: string, input: unknown) {
    this.emit({
      phase: 'native-decoded',
      toolCallId: label(toolCallId),
      nativeToolCallId: label(toolCallId.slice(toolCallId.indexOf(':') + 1)),
      toolName: label(toolName),
      ...this.describe(input)
    })
  }

  execution(toolName: string, input: unknown, executionRequestId: string) {
    // MCP JSON-RPC IDs are NOT model tool call IDs. Keep them distinct; exports
    // may correlate by name + fingerprint only when there is one candidate.
    this.emit({ phase: 'mcp-execution', toolName: label(toolName), executionRequestId, ...this.describe(input) })
  }

  wire(transportRequestId: string) {
    return new ToolArgumentWireAudit(this, transportRequestId)
  }
}

export class ToolArgumentWireAudit {
  private requestChunks: Buffer[] = []
  private requestBytes = 0
  private schemas = new Map<string, Schema>()
  private schemaCoverage = 'unavailable'
  private calls = new Map<string, Call>()
  private aliases = new Map<string, string>()
  private buffered = 0
  private limited = false
  private requestId?: string

  constructor(
    private scope: ToolArgumentAuditScope,
    private transportRequestId: string
  ) {}

  request(bytes: Uint8Array) {
    this.requestBytes += bytes.byteLength
    if (this.requestBytes <= MAX_REQUEST_BYTES) this.requestChunks.push(Buffer.from(bytes))
    else this.requestChunks = []
  }

  requestFinished(complete: boolean) {
    let body: Record<string, any> | undefined
    try {
      this.schemaCoverage = complete && this.requestBytes <= MAX_REQUEST_BYTES ? 'complete' : 'limited'
      if (this.schemaCoverage !== 'complete') return
      body = object(JSON.parse(Buffer.concat(this.requestChunks).toString('utf8')))
      if (!body) return
      const tools = Array.isArray(body.tools) ? body.tools : []
      if (tools.length > 256) this.schemaCoverage = 'limited'
      for (const item of tools.slice(0, 256)) {
        const tool = object(item?.function) ?? object(item)
        if (!tool || typeof tool.name !== 'string') continue
        const schema = object(tool.parameters) ?? object(tool.input_schema)
        if (!schema) continue
        this.schemas.set(tool.name, {
          required: Array.isArray(schema.required) ? schema.required.filter((key) => typeof key === 'string') : [],
          fingerprint: this.scope.fingerprint(canonical(schema))
        })
      }
    } catch {
      this.schemaCoverage = 'invalid-json'
    } finally {
      this.scope.requestContext(this.transportRequestId, this.requestBytes, body)
      this.requestChunks = []
    }
  }

  headers(requestId: string | null) {
    this.requestId = requestId ?? undefined
  }

  private call(key: string, id?: unknown, name?: unknown): Call | undefined {
    key = this.aliases.get(key) ?? key
    let call = this.calls.get(key)
    if (!call) {
      if (this.calls.size >= MAX_CALLS) {
        this.limited = true
        return
      }
      call = { text: '', fragments: 0, limited: false, completed: false }
      this.calls.set(key, call)
    }
    const nextId = label(id)
    const nextName = label(name)
    if ((nextId && call.id && nextId !== call.id) || (nextName && call.name && nextName !== call.name))
      call.limited = this.limited = true
    call.id = nextId || call.id
    call.name = nextName || call.name
    return call
  }

  private append(call: Call | undefined, text: unknown) {
    if (!call || typeof text !== 'string') return
    call.fragments++
    const bytes = Buffer.byteLength(text)
    this.buffered += bytes
    if (
      call.limited ||
      Buffer.byteLength(call.text) + bytes > MAX_ARGUMENT_BYTES ||
      this.buffered > MAX_REQUEST_BYTES
    ) {
      call.limited = this.limited = true
      call.text = ''
    } else call.text += text
  }

  private snapshot(call: Call | undefined, value: unknown, completed = true) {
    if (!call || value === undefined) return
    call.completed ||= completed
    const summary = this.scope.describe(value, typeof value === 'string')
    this.buffered += Number(summary.argumentBytes ?? 0)
    if (summary.argumentState === 'limited' || this.buffered > MAX_REQUEST_BYTES) call.limited = this.limited = true
    else {
      call.snapshot = value
      call.snapshotFinal = completed
    }
  }

  frame(body: Record<string, any>) {
    try {
      for (const [choiceIndex, choice] of (Array.isArray(body.choices) ? body.choices : []).entries()) {
        const prefix = `chat:${choice.index ?? choiceIndex}:`
        for (const [index, item] of (choice.delta?.tool_calls ?? []).entries()) {
          const call = this.call(`${prefix}${item.index ?? index}`, item.id, item.function?.name)
          this.append(call, item.function?.arguments)
        }
        for (const [index, item] of (choice.message?.tool_calls ?? []).entries()) {
          this.snapshot(
            this.call(`${prefix}${item.index ?? index}`, item.id, item.function?.name),
            item.function?.arguments
          )
        }
        if (choice.finish_reason)
          for (const [key, call] of this.calls) if (key.startsWith(prefix)) call.completed = true
      }
      const type = String(body.type ?? '')
      if (type.startsWith('response.')) {
        const item = object(body.item)
        const indexKey = `responses:${body.output_index ?? ''}`
        const idKey = `item:${body.item_id ?? item?.id ?? ''}`
        if (item?.type === 'function_call') {
          this.aliases.set(`item:${item.id}`, indexKey)
          const call = this.call(indexKey, item.call_id, item.name)
          if (type.endsWith('.done')) this.snapshot(call, item.arguments)
        } else if (type === 'response.function_call_arguments.delta') {
          if (body.item_id && !this.aliases.has(idKey)) this.limited = true
          this.append(this.call(body.item_id ? idKey : indexKey), body.delta)
        } else if (type === 'response.function_call_arguments.done') {
          this.snapshot(this.call(body.item_id ? idKey : indexKey), body.arguments)
        }
      }
      for (const item of body.output ?? body.response?.output ?? []) {
        if (item.type !== 'function_call') continue
        const key = this.aliases.get(`item:${item.id}`) ?? `call:${item.call_id}`
        this.snapshot(this.call(key, item.call_id, item.name), item.arguments)
      }
      const blockKey = `anthropic:${body.index ?? 0}`
      if (type === 'content_block_start' && body.content_block?.type === 'tool_use') {
        const item = body.content_block
        this.snapshot(this.call(blockKey, item.id, item.name), item.input, false)
      }
      if (type === 'content_block_delta' && body.delta?.type === 'input_json_delta')
        this.append(this.call(blockKey), body.delta.partial_json)
      if (type === 'content_block_stop') {
        const call = this.calls.get(blockKey)
        if (call) call.completed = true
      }
      for (const item of body.content ?? []) {
        if (item.type === 'tool_use') this.snapshot(this.call(`tool:${item.id}`, item.id, item.name), item.input)
      }
    } catch {
      this.limited = true
    }
  }

  finish(complete: boolean) {
    for (const call of this.calls.values()) {
      const input = call.fragments ? call.text : call.snapshot
      const summary = call.limited
        ? { argumentState: 'limited' }
        : this.scope.describe(input, typeof input === 'string')
      const schema = call.name ? this.schemas.get(call.name) : undefined
      let missingRequired: number | undefined
      if (schema && ['object', 'empty-object'].includes(String(summary.argumentState))) {
        const parsed = typeof input === 'string' ? JSON.parse(input) : input
        missingRequired = schema.required.filter((key) => !Object.hasOwn(parsed, key)).length
      }
      const snapshot =
        call.snapshot === undefined ? undefined : this.scope.describe(call.snapshot, typeof call.snapshot === 'string')
      this.scope.emit({
        phase: 'provider-wire',
        transportRequestId: this.transportRequestId,
        requestId: this.requestId,
        nativeToolCallId: call.id,
        toolName: call.name,
        ...summary,
        argumentFragments: call.fragments,
        argumentComplete: complete && call.completed && !call.limited && !this.limited,
        schemaCoverage: this.schemaCoverage,
        schemaFingerprint: schema?.fingerprint,
        requiredKeys: schema?.required.length,
        missingRequiredKeys: missingRequired,
        // Anthropic starts with a placeholder {}. Only completed snapshots can
        // be compared to assembled deltas; placeholders must not imply loss.
        ...(call.fragments && call.snapshotFinal
          ? { snapshotMatches: snapshot?.argumentFingerprint === summary.argumentFingerprint }
          : {})
      })
    }
    this.scope.emit({
      phase: 'wire-coverage',
      transportRequestId: this.transportRequestId,
      requestId: this.requestId,
      toolCount: this.calls.size,
      argumentComplete: complete && !this.limited,
      schemaCoverage: this.schemaCoverage
    })
    this.calls.clear()
    this.requestChunks = []
  }
}
