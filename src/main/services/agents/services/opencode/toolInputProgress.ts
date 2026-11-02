/** Observe parameter deltas only. Never retain arguments, execute tools, or
 * treat heartbeat/usage/full-result snapshots as generation progress. */
export class ToolInputProgress {
  private sequence = -1

  characters(body: Record<string, any>): number {
    let count = 0
    const add = (value: unknown) => {
      if (typeof value === 'string' && value.trim()) count += value.length
    }
    if (Array.isArray(body.choices)) {
      for (const choice of body.choices) {
        if (Array.isArray(choice?.delta?.tool_calls))
          for (const call of choice.delta.tool_calls) add(call?.function?.arguments)
        add(choice?.delta?.function_call?.arguments)
      }
    } else if (body.type === 'response.function_call_arguments.delta') {
      // Responses supplies an increasing sequence across the response. A
      // replayed frame must not keep a stalled request alive.
      if (Number.isSafeInteger(body.sequence_number)) {
        if (body.sequence_number <= this.sequence) return 0
        this.sequence = body.sequence_number
      }
      add(body.delta)
    } else if (body.type === 'content_block_delta' && body.delta?.type === 'input_json_delta') {
      add(body.delta.partial_json)
    }
    return count
  }
}
