# @cherrystudio/ai-core

Zen AI AI Core 鏄竴涓熀浜?Vercel AI SDK 鐨勭粺涓€ AI Provider 鎺ュ彛鍖咃紝涓?AI 搴旂敤鎻愪緵寮哄ぇ鐨勬娊璞″眰鍜屾彃浠跺寲鏋舵瀯銆?
## 鉁?鏍稿績浜偣

### 馃彈锔?浼橀泤鐨勬灦鏋勮璁?
- **绠€鍖栧垎灞?*锛歚models`锛堟ā鍨嬪眰锛夆啋 `runtime`锛堣繍琛屾椂灞傦級锛屾竻鏅扮殑鑱岃矗鍒嗙
- **鍑芥暟寮忎紭鍏?*锛氶伩鍏嶈繃搴︽娊璞★紝鎻愪緵绠€娲佺洿瑙傜殑 API
- **绫诲瀷瀹夊叏**锛氬畬鏁寸殑 TypeScript 鏀寔锛岀洿鎺ュ鐢?AI SDK 绫诲瀷绯荤粺
- **鏈€灏忓寘瑁?*锛氱洿鎺ヤ娇鐢?AI SDK 鐨勬帴鍙ｏ紝閬垮厤閲嶅瀹氫箟鍜屾€ц兘鎹熻€?
### 馃攲 寮哄ぇ鐨勬彃浠剁郴缁?
- **鐢熷懡鍛ㄦ湡閽╁瓙**锛氭敮鎸佽姹傚叏鐢熷懡鍛ㄦ湡鐨勬墿灞曠偣
- **娴佽浆鎹㈡敮鎸?*锛氬熀浜?AI SDK 鐨?`experimental_transform` 瀹炵幇娴佸鐞?- **鎻掍欢鍒嗙被**锛欶irst銆丼equential銆丳arallel 涓夌閽╁瓙绫诲瀷锛屾弧瓒充笉鍚屽満鏅?- **鍐呯疆鎻掍欢**锛歸ebSearch銆乴ogging銆乼oolUse 绛夊紑绠卞嵆鐢ㄧ殑鍔熻兘

### 馃寪 缁熶竴澶?Provider 鎺ュ彛

- **鎵╁睍娉ㄥ唽**锛氭敮鎸佽嚜瀹氫箟 Provider 娉ㄥ唽锛屾棤闄愭墿灞曡兘鍔?- **閰嶇疆缁熶竴**锛氱粺涓€鐨勯厤缃帴鍙ｏ紝绠€鍖栧 Provider 绠＄悊

### 馃殌 澶氱浣跨敤鏂瑰紡

- **鍑芥暟寮忚皟鐢?*锛氶€傚悎绠€鍗曞満鏅殑鐩存帴鍑芥暟璋冪敤
- **鎵ц鍣ㄥ疄渚?*锛氶€傚悎澶嶆潅鍦烘櫙鐨勫彲澶嶇敤鎵ц鍣?- **闈欐€佸伐鍘?*锛氫究鎹风殑闈欐€佸垱寤烘柟娉?- **鍘熺敓鍏煎**锛氬畬鍏ㄥ吋瀹?AI SDK 鍘熺敓 Provider Registry

### 馃敭 闈㈠悜鏈潵

- **Agent 灏辩华**锛氫负 OpenAI Agents SDK 闆嗘垚棰勭暀鏋舵瀯绌洪棿
- **妯″潡鍖栬璁?*锛氱嫭绔嬪寘缁撴瀯锛屾敮鎸佽法椤圭洰澶嶇敤
- **娓愯繘寮忚縼绉?*锛氬彲浠ラ€愭浠庣幇鏈?AI SDK 浠ｇ爜杩佺Щ

## 鐗规€?
- 馃殌 缁熶竴鐨?AI Provider 鎺ュ彛
- 馃攧 鍔ㄦ€佸鍏ユ敮鎸?- 馃洜锔?TypeScript 鏀寔
- 馃摝 寮哄ぇ鐨勬彃浠剁郴缁?- 馃實 鍐呯疆webSearch(Openai,Google,Anthropic,xAI)
- 馃幆 澶氱浣跨敤妯″紡锛堝嚱鏁板紡/瀹炰緥寮?闈欐€佸伐鍘傦級
- 馃攲 鍙墿灞曠殑 Provider 娉ㄥ唽绯荤粺
- 馃З 瀹屾暣鐨勪腑闂翠欢鏀寔
- 馃搳 鎻掍欢缁熻鍜岃皟璇曞姛鑳?
## 鏀寔鐨?Providers

鍩轰簬 [AI SDK 瀹樻柟鏀寔鐨?providers](https://ai-sdk.dev/providers/ai-sdk-providers)锛?
**鏍稿績 Providers锛堝唴缃敮鎸侊級:**

- OpenAI
- Anthropic
- Google Generative AI
- OpenAI-Compatible
- xAI (Grok)
- Azure OpenAI
- DeepSeek

**鎵╁睍 Providers锛堥€氳繃娉ㄥ唽API鏀寔锛?**

- Google Vertex AI
- ...
- 鑷畾涔?Provider

## 瀹夎

```bash
npm install @cherrystudio/ai-core ai @ai-sdk/google @ai-sdk/openai
```

### React Native

濡傛灉浣犲湪 React Native 椤圭洰涓娇鐢ㄦ鍖咃紝闇€瑕佸湪 `metro.config.js` 涓坊鍔犱互涓嬮厤缃細

```javascript
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

// 娣诲姞瀵?@cherrystudio/ai-core 鐨勬敮鎸?config.resolver.resolverMainFields = ['react-native', 'browser', 'main']
config.resolver.platforms = ['ios', 'android', 'native', 'web']

module.exports = config
```

杩橀渶瑕佸畨瑁呬綘瑕佷娇鐢ㄧ殑 AI SDK provider:

```bash
npm install @ai-sdk/openai @ai-sdk/anthropic @ai-sdk/google
```

## 浣跨敤绀轰緥

### 鍩虹鐢ㄦ硶

```typescript
import { AiCore } from '@cherrystudio/ai-core'

// 鍒涘缓 OpenAI executor
const executor = AiCore.create('openai', {
  apiKey: 'your-api-key'
})

// 娴佸紡鐢熸垚
const result = await executor.streamText('gpt-4', {
  messages: [{ role: 'user', content: 'Hello!' }]
})

// 闈炴祦寮忕敓鎴?const response = await executor.generateText('gpt-4', {
  messages: [{ role: 'user', content: 'Hello!' }]
})
```

### 渚挎嵎鍑芥暟

```typescript
import { createOpenAIExecutor } from '@cherrystudio/ai-core'

// 蹇€熷垱寤?OpenAI executor
const executor = createOpenAIExecutor({
  apiKey: 'your-api-key'
})

// 浣跨敤 executor
const result = await executor.streamText('gpt-4', {
  messages: [{ role: 'user', content: 'Hello!' }]
})
```

### 澶?Provider 鏀寔

```typescript
import { AiCore } from '@cherrystudio/ai-core'

// 鏀寔澶氱 AI providers
const openaiExecutor = AiCore.create('openai', { apiKey: 'openai-key' })
const anthropicExecutor = AiCore.create('anthropic', { apiKey: 'anthropic-key' })
const googleExecutor = AiCore.create('google', { apiKey: 'google-key' })
const xaiExecutor = AiCore.create('xai', { apiKey: 'xai-key' })
```

### 鎵╁睍 Provider 娉ㄥ唽

瀵逛簬闈炲唴缃殑 providers锛屽彲浠ラ€氳繃娉ㄥ唽 API 鎵╁睍鏀寔锛?
```typescript
import { registerProvider, AiCore } from '@cherrystudio/ai-core'

// 鏂瑰紡涓€锛氬鍏ュ苟娉ㄥ唽绗笁鏂?provider
import { createGroq } from '@ai-sdk/groq'

registerProvider({
  id: 'groq',
  name: 'Groq',
  creator: createGroq,
  supportsImageGeneration: false
})

// 鐜板湪鍙互浣跨敤 Groq
const groqExecutor = AiCore.create('groq', { apiKey: 'groq-key' })

// 鏂瑰紡浜岋細鍔ㄦ€佸鍏ユ柟寮忔敞鍐?registerProvider({
  id: 'mistral',
  name: 'Mistral AI',
  import: () => import('@ai-sdk/mistral'),
  creatorFunctionName: 'createMistral'
})

const mistralExecutor = AiCore.create('mistral', { apiKey: 'mistral-key' })
```

## 馃攲 鎻掍欢绯荤粺

AI Core 鎻愪緵浜嗗己澶х殑鎻掍欢绯荤粺锛屾敮鎸佽姹傚叏鐢熷懡鍛ㄦ湡鐨勬墿灞曘€?
### 鍐呯疆鎻掍欢

#### webSearchPlugin - 缃戠粶鎼滅储鎻掍欢

涓轰笉鍚?AI Provider 鎻愪緵缁熶竴鐨勭綉缁滄悳绱㈣兘鍔涳細

```typescript
import { webSearchPlugin } from '@cherrystudio/ai-core/built-in/plugins'

const executor = AiCore.create('openai', { apiKey: 'your-key' }, [
  webSearchPlugin({
    openai: {
      /* OpenAI 鎼滅储閰嶇疆 */
    },
    anthropic: { maxUses: 5 },
    google: {
      /* Google 鎼滅储閰嶇疆 */
    },
    xai: {
      mode: 'on',
      returnCitations: true,
      maxSearchResults: 5,
      sources: [{ type: 'web' }, { type: 'x' }, { type: 'news' }]
    }
  })
])
```

#### loggingPlugin - 鏃ュ織鎻掍欢

鎻愪緵璇︾粏鐨勮姹傛棩蹇楄褰曪細

```typescript
import { createLoggingPlugin } from '@cherrystudio/ai-core/built-in/plugins'

const executor = AiCore.create('openai', { apiKey: 'your-key' }, [
  createLoggingPlugin({
    logLevel: 'info',
    includeParams: true,
    includeResult: false
  })
])
```

#### promptToolUsePlugin - 鎻愮ず宸ュ叿浣跨敤鎻掍欢

涓轰笉鏀寔鍘熺敓 Function Call 鐨勬ā鍨嬫彁渚?prompt 鏂瑰紡鐨勫伐鍏疯皟鐢細

```typescript
import { createPromptToolUsePlugin } from '@cherrystudio/ai-core/built-in/plugins'

// 瀵逛簬涓嶆敮鎸?function call 鐨勬ā鍨?const executor = AiCore.create(
  'providerId',
  {
    apiKey: 'your-key',
    baseURL: 'https://your-model-endpoint'
  },
  [
    createPromptToolUsePlugin({
      enabled: true,
      // 鍙€夛細鑷畾涔夌郴缁熸彁绀虹鏋勫缓
      buildSystemPrompt: (userPrompt, tools) => {
        return `${userPrompt}\n\nAvailable tools: ${Object.keys(tools).join(', ')}`
      }
    })
  ]
)
```

### 鑷畾涔夋彃浠?
鍒涘缓鑷畾涔夋彃浠堕潪甯哥畝鍗曪細

```typescript
import { definePlugin } from '@cherrystudio/ai-core'

const customPlugin = definePlugin({
  name: 'custom-plugin',
  enforce: 'pre', // 'pre' | 'post' | undefined

  // 鍦ㄨ姹傚紑濮嬫椂璁板綍鏃ュ織
  onRequestStart: async (context) => {
    console.log(`Starting request for model: ${context.modelId}`)
  },

  // 杞崲璇锋眰鍙傛暟
  transformParams: async (params, context) => {
    // 娣诲姞鑷畾涔夌郴缁熸秷鎭?    if (params.messages) {
      params.messages.unshift({
        role: 'system',
        content: 'You are a helpful assistant.'
      })
    }
    return params
  },

  // 澶勭悊鍝嶅簲缁撴灉
  transformResult: async (result, context) => {
    // 娣诲姞鍏冩暟鎹?    if (result.text) {
      result.metadata = {
        processedAt: new Date().toISOString(),
        modelId: context.modelId
      }
    }
    return result
  }
})

// 浣跨敤鑷畾涔夋彃浠?const executor = AiCore.create('openai', { apiKey: 'your-key' }, [customPlugin])
```

### 浣跨敤 AI SDK 鍘熺敓 Provider 娉ㄥ唽琛?
> https://ai-sdk.dev/docs/reference/ai-sdk-core/provider-registry

闄や簡浣跨敤鍐呭缓鐨?provider 绠＄悊锛屼綘杩樺彲浠ヤ娇鐢?AI SDK 鍘熺敓鐨?`createProviderRegistry` 鏉ユ瀯寤鸿嚜宸辩殑 provider 娉ㄥ唽琛ㄣ€?
#### 鍩烘湰鐢ㄦ硶绀轰緥

```typescript
import { createClient } from '@cherrystudio/ai-core'
import { createProviderRegistry } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'

// 1. 鍒涘缓 AI SDK 鍘熺敓娉ㄥ唽琛?export const registry = createProviderRegistry({
  // register provider with prefix and default setup:
  anthropic,

  // register provider with prefix and custom setup:
  openai: createOpenAI({
    apiKey: process.env.OPENAI_API_KEY
  })
})

// 2. 鍒涘缓client,'openai'鍙互浼犵┖鎴栬€呬紶providerId(鍐呭缓鐨刾rovider)
const client = PluginEnabledAiClient.create('openai', {
  apiKey: process.env.OPENAI_API_KEY
})

// 3. 鏂瑰紡1锛氫娇鐢ㄥ唴寤洪€昏緫锛堜紶缁熸柟寮忥級
const result1 = await client.streamText('gpt-4', {
  messages: [{ role: 'user', content: 'Hello with built-in logic!' }]
})

// 4. 鏂瑰紡2锛氫娇鐢ㄨ嚜瀹氫箟娉ㄥ唽琛紙鐏垫椿鏂瑰紡锛?const result2 = await client.streamText({
  model: registry.languageModel('openai:gpt-4'),
  messages: [{ role: 'user', content: 'Hello with custom registry!' }]
})

// 5. 鏀寔鐨勯噸杞芥柟娉?await client.generateObject({
  model: registry.languageModel('openai:gpt-4'),
  schema: z.object({ name: z.string() }),
  messages: [{ role: 'user', content: 'Generate a user' }]
})

await client.streamObject({
  model: registry.languageModel('anthropic:claude-3-opus-20240229'),
  schema: z.object({ items: z.array(z.string()) }),
  messages: [{ role: 'user', content: 'Generate a list' }]
})
```

#### 涓庢彃浠剁郴缁熼厤鍚堜娇鐢?
鏇村己澶х殑鏄紝浣犺繕鍙互灏嗚嚜瀹氫箟娉ㄥ唽琛ㄤ笌 Zen AI 鐨勬彃浠剁郴缁熺粨鍚堜娇鐢細

```typescript
import { PluginEnabledAiClient } from '@cherrystudio/ai-core'
import { createProviderRegistry } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { anthropic } from '@ai-sdk/anthropic'

// 1. 鍒涘缓甯︽彃浠剁殑瀹㈡埛绔?const client = PluginEnabledAiClient.create(
  'openai',
  {
    apiKey: process.env.OPENAI_API_KEY
  },
  [LoggingPlugin, RetryPlugin]
)

// 2. 鍒涘缓鑷畾涔夋敞鍐岃〃
const registry = createProviderRegistry({
  openai: createOpenAI({ apiKey: process.env.OPENAI_API_KEY }),
  anthropic: anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
})

// 3. 鏂瑰紡1锛氫娇鐢ㄥ唴寤洪€昏緫 + 瀹屾暣鎻掍欢绯荤粺
await client.streamText('gpt-4', {
  messages: [{ role: 'user', content: 'Hello with plugins!' }]
})

// 4. 鏂瑰紡2锛氫娇鐢ㄨ嚜瀹氫箟娉ㄥ唽琛?+ 鏈夐檺鎻掍欢鏀寔
await client.streamText({
  model: registry.languageModel('anthropic:claude-3-opus-20240229'),
  messages: [{ role: 'user', content: 'Hello from Claude!' }]
})

// 5. 鏀寔鐨勬柟娉?await client.generateObject({
  model: registry.languageModel('openai:gpt-4'),
  schema: z.object({ name: z.string() }),
  messages: [{ role: 'user', content: 'Generate a user' }]
})

await client.streamObject({
  model: registry.languageModel('openai:gpt-4'),
  schema: z.object({ items: z.array(z.string()) }),
  messages: [{ role: 'user', content: 'Generate a list' }]
})
```

#### 娣峰悎浣跨敤鐨勪紭鍔?
- **鐏垫椿鎬?*锛氬彲浠ユ牴鎹渶瑕侀€夋嫨浣跨敤鍐呭缓閫昏緫鎴栬嚜瀹氫箟娉ㄥ唽琛?- **鍏煎鎬?*锛氬畬鍏ㄥ吋瀹?AI SDK 鐨?`createProviderRegistry` API
- **娓愯繘寮?*锛氬彲浠ラ€愭杩佺Щ鐜版湁浠ｇ爜锛屾棤闇€涓€娆℃€ч噸鏋?- **鎻掍欢鏀寔**锛氳嚜瀹氫箟娉ㄥ唽琛ㄤ粛鍙韩鍙楁彃浠剁郴缁熺殑閮ㄥ垎鍔熻兘
- **鏈€浣冲疄璺?*锛氱粨鍚堜袱绉嶆柟寮忕殑浼樼偣锛屾棦鏈夊姩鎬佸姞杞界殑鎬ц兘浼樺娍锛屽張鏈夌粺涓€娉ㄥ唽琛ㄧ殑渚垮埄鎬?
## 馃摎 鐩稿叧璧勬簮

- [Vercel AI SDK 鏂囨。](https://ai-sdk.dev/)
- [Zen AI 椤圭洰](https://github.com/z685675/Zen-AI)
- [AI SDK Providers](https://ai-sdk.dev/providers/ai-sdk-providers)

## 鏈潵鐗堟湰

- 馃敭 澶?Agent 缂栨帓
- 馃敭 鍙鍖栨彃浠堕厤缃?- 馃敭 瀹炴椂鐩戞帶鍜屽垎鏋?- 馃敭 浜戠鎻掍欢鍚屾

## 馃搫 License

MIT License - 璇﹁ [LICENSE](https://github.com/z685675/Zen-AI/blob/main/LICENSE) 鏂囦欢

---

**Zen AI AI Core** - 璁?AI 寮€鍙戞洿绠€鍗曘€佹洿寮哄ぇ銆佹洿鐏垫椿 馃殌

