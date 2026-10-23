import { emitKeypressEvents, type Key } from 'node:readline'
import { createInterface } from 'node:readline/promises'

/** Read directly from the terminal without ever echoing the credential or putting it in shell history. */
export function readSecret(
  question: string,
  signal?: AbortSignal,
  input: NodeJS.ReadStream = process.stdin,
  output: Pick<NodeJS.WriteStream, 'write'> = process.stdout
): Promise<string> {
  if (!input.isTTY || !input.setRawMode) throw new Error('请在交互终端中输入Key，不接受命令行参数或重定向输入。')
  if (signal?.aborted) throw new Error('已取消。')
  output.write(question + '\n> ')
  emitKeypressEvents(input)
  const previousRaw = input.isRaw
  return new Promise((resolve, reject) => {
    let secret = ''
    let finished = false
    const finish = (error?: Error) => {
      if (finished) return
      finished = true
      input.off('keypress', keypress)
      input.off('end', ended)
      signal?.removeEventListener('abort', cancelled)
      input.setRawMode(previousRaw)
      input.pause()
      output.write('\n')
      const result = secret
      secret = ''
      if (error) reject(error)
      else resolve(result)
    }
    const cancelled = () => finish(new Error('已取消。'))
    const ended = () => finish(new Error('输入已关闭。'))
    const keypress = (text: string | undefined, key: Key) => {
      if (key.ctrl && key.name === 'c') return cancelled()
      if (key.name === 'return' || key.name === 'enter') return finish()
      if (key.name === 'backspace') {
        if (secret) {
          secret = [...secret].slice(0, -1).join('')
          output.write('\b \b')
        }
      } else if (text && !key.ctrl && !key.meta && !/[\p{Cc}\p{Cf}]/u.test(text)) {
        secret += text
        output.write('*'.repeat([...text].length))
      }
    }
    input.on('keypress', keypress)
    input.once('end', ended)
    signal?.addEventListener('abort', cancelled, { once: true })
    input.setRawMode(true)
    input.resume()
  })
}

export async function askTerminal(question: string, signal?: AbortSignal) {
  const terminal = createInterface({ input: process.stdin, output: process.stdout })
  const controller = new AbortController()
  const cancel = () => controller.abort()
  terminal.once('SIGINT', cancel)
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) cancel()
  try {
    return (await terminal.question(question + '\n> ', { signal: controller.signal })).trim()
  } finally {
    signal?.removeEventListener('abort', cancel)
    terminal.close()
  }
}
