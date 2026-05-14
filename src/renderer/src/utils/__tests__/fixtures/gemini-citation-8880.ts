/**
 * Fixture data for issue #8880 鈥?Gemini citation over-matching.
 *
 * groundingMetadata sourced from a real Gemini 3 Pro response to the query
 * "璇锋悳绱簩姘у寲纭兘鍚︾噧鐑? (Can sulfur dioxide burn?).
 *
 * The content is reconstructed so that segment byte offsets align exactly
 * with the groundingSupports data; gaps between segments are filled with
 * ASCII spaces (1 byte each) to preserve byte positions.
 */
import type { GroundingChunk, GroundingMetadata, GroundingSupport } from '@google/genai'

export const groundingChunks: GroundingChunk[] = [
  { web: { uri: 'https://example.com/teck', title: 'teck.com' } },
  { web: { uri: 'https://example.com/service-gov', title: 'service.gov.uk' } },
  { web: { uri: 'https://example.com/mozaweb', title: 'mozaweb.com' } },
  { web: { uri: 'https://example.com/ivhhn', title: 'ivhhn.org' } },
  { web: { uri: 'https://example.com/airliquide', title: 'airliquide.com' } },
  { web: { uri: 'https://example.com/osha', title: 'osha.gov.tw' } },
  { web: { uri: 'https://example.com/ccohs', title: 'ccohs.ca' } }
]

export const groundingSupports: GroundingSupport[] = [
  {
    segment: {
      endIndex: 99,
      text: '**浜屾哀鍖栫～锛?SO_2$锛変笉鑳界噧鐑?*锛屽畠鏄竴绉?*涓嶅彲鐕?*涓旈?氬父**涓嶅姪鐕?*鐨勬皵浣?
    },
    groundingChunkIndices: [0, 1, 2]
  },
  {
    segment: {
      startIndex: 184,
      endIndex: 275,
      text: '**涓嶅彲鐕冩??*锛氬湪鏃ュ父鍜屾秷闃叉爣鍑嗕腑锛屼簩姘у寲纭鏄庣‘褰掔被涓轰笉鐕冩皵浣?
    },
    groundingChunkIndices: [0, 3, 4]
  },
  {
    segment: {
      startIndex: 278,
      endIndex: 332,
      text: '瀹冩湰韬氨鏄～鎴栧惈纭寲鍚堢墿鐕冪儳鍚庣殑浜х墿'
    },
    groundingChunkIndices: [2, 5]
  },
  {
    segment: {
      startIndex: 861,
      endIndex: 1097,
      text: '**瀹夊叏璀﹀憡**锛氳櫧鐒朵簩姘у寲纭湰韬笉浼氱噧鐑э紝浣嗛渶瑕佹敞鎰忕殑鏄紝濡傛灉瑁呮湁楂樺帇娑叉?佷簩姘у寲纭殑閽㈢摱鎴栧偍缃愯鍗峰叆鐏伨涓紝鍙楃儹浼氬鑷村鍣ㄥ唴鍘嬪姏鎬ュ墽涓婂崌锛屾湁**鍙戠敓鐗╃悊鐖嗙偢**鐨勫嵄闄?
    },
    groundingChunkIndices: [0, 6]
  },
  {
    segment: {
      startIndex: 1100,
      endIndex: 1226,
      text: '姝ゅ锛屼簩姘у寲纭槸涓?绉嶅叿鏈夊己鐑堝埡婵?鎬у拰鑵愯殌鎬х殑鏈夋瘨姘斾綋锛屽惛鍏ヤ細瀵逛汉浣撳懠鍚搁亾閫犳垚涓ラ噸浼ゅ'
    },
    groundingChunkIndices: [0, 6, 4]
  },
  {
    segment: {
      startIndex: 1231,
      endIndex: 1286,
      text: '鎬荤粨鏉ヨ锛屼簩姘у寲纭嚜韬粷瀵?*涓嶈兘鐕冪儳**'
    },
    groundingChunkIndices: [0, 6]
  }
]

export const groundingMetadata: GroundingMetadata = {
  groundingChunks,
  groundingSupports,
  webSearchQueries: ['Is sulfur dioxide flammable', '"浜屾哀鍖栫～" 鑳藉惁鐕冪儳']
}

/**
 * Build a content string where segments sit at their correct UTF-8 byte
 * positions. Gaps are filled with ASCII spaces so byte offsets stay valid.
 */
export function buildContent(): string {
  const encoder = new TextEncoder()
  const decoder = new TextDecoder()
  const totalBytes = 1286 // endIndex of the last segment
  const buffer = new Uint8Array(totalBytes).fill(0x20) // ASCII space

  for (const support of groundingSupports) {
    if (!support.segment?.text) continue
    const start = support.segment.startIndex ?? 0
    buffer.set(encoder.encode(support.segment.text), start)
  }

  return decoder.decode(buffer)
}
