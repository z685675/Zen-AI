import type { ShikiStreamTokenizer } from '@renderer/services/ShikiStreamTokenizer'
import type { HighlighterCore } from 'shiki/core'
import { getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from 'shiki/core'

/**
 * 浣跨敤 ShikiStreamTokenizer 鑾峰彇娴佸紡楂樹寒浠ｇ爜
 * @param chunks 浠ｇ爜鍧楁暟缁勶紝妯℃嫙娴佸紡鍝嶅簲
 * @param tokenizer tokenizer 瀹炰緥
 * @returns 楂樹寒鍚庣殑 HTML
 */
export async function highlightCode(chunks: string[], tokenizer: ShikiStreamTokenizer): Promise<string> {
  let tokenLines: ThemedToken[][] = []

  for (const chunk of chunks) {
    const result = await tokenizer.enqueue(chunk)

    // 鏍规嵁 recall 鍊肩Щ闄ゅ彲鑳介渶瑕侀噸鏂板鐞嗙殑琛?    if (result.recall > 0 && tokenLines.length > 0) {
      tokenLines = tokenLines.slice(0, Math.max(0, tokenLines.length - result.recall))
    }

    // 娣诲姞绋冲畾鐨勮鍜屼笉绋冲畾鐨勮
    tokenLines = [...tokenLines, ...result.stable, ...result.unstable]
  }

  // 杩欓噷灏变笉鑾峰彇杩斿洖鍊间簡锛屽洜涓烘渶鍚庝竴琛屽簲璇ュ凡缁忓鐞嗗畬浜?  tokenizer.close()

  return tokenLinesToHtml(tokenLines)
}

/**
 * 浣跨敤 shiki codeToTokens 鑾峰彇姝ｇ‘鐨勯珮浜唬鐮? * @param code 浠ｇ爜
 * @param highlighter 楂樹寒鍣? * @returns 棰勬湡鐨?html
 */
export function getExpectedHighlightedCode(code: string, highlighter: HighlighterCore | null) {
  const expected = highlighter?.codeToTokens(code, {
    lang: 'typescript',
    theme: 'one-light'
  })

  return tokenLinesToHtml(expected?.tokens ?? [])
}

/**
 * 灏嗗崟涓?token 杞崲涓?html
 * @param token
 * @returns span
 */
export function tokenToHtml(token: ThemedToken): string {
  return `<span style="${stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token))}">${escapeHtml(token.content)}</span>`
}

/**
 * 灏嗗崟琛?token 杞崲涓?html
 * @param tokenLine token 鏁扮粍
 * @returns span with className line
 */
export function tokenLineToHtml(tokenLine: ThemedToken[]): string {
  return `<span className="line">${tokenLine.map(tokenToHtml).join('')}</span>`
}

/**
 * 灏嗗琛?token 杞崲涓?html
 * @param tokenLines token 鏁扮粍
 * @returns spans with className line
 */
export function tokenLinesToHtml(tokenLines: ThemedToken[][]): string {
  return tokenLines.map(tokenLineToHtml).join('\n')
}

/**
 * 杞箟 html
 * @param html html
 * @returns 杞箟鍚庣殑 html
 */
export function escapeHtml(html: string): string {
  return html.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 灏嗗瓧绗︿覆鎸夋寚瀹氶暱搴?n 鍒囧垎涓哄瓧绗︿覆鏁扮粍
 * @param code 鍘熷瀛楃涓? * @param n 姣忎釜鍏冪礌鐨勯暱搴? * @returns 鍒囧垎鍚庣殑瀛楃涓叉暟缁? */
export function generateEqualLengthChunks(code: string, n: number): string[] {
  if (n <= 0) throw new Error('n must be greater than 0')
  const result: string[] = []
  for (let i = 0; i < code.length; i += n) {
    result.push(code.slice(i, i + n))
  }
  return result
}
