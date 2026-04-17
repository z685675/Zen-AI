# Zen AI AI Provider 鎶€鏈灦鏋勬枃妗?(鏂版柟妗?

## 1. 鏍稿績璁捐鐞嗗康涓庣洰鏍?
鏈灦鏋勬棬鍦ㄩ噸鏋?Zen AI 鐨?AI Provider锛堢幇绉颁负 `aiCore`锛夊眰锛屼互瀹炵幇浠ヤ笅鐩爣锛?
- **鑱岃矗娓呮櫚**锛氭槑纭垝鍒嗗悇缁勪欢鐨勮亴璐ｏ紝闄嶄綆鑰﹀悎搴︺€?- **楂樺害澶嶇敤**锛氭渶澶у寲涓氬姟閫昏緫鍜岄€氱敤澶勭悊閫昏緫鐨勫鐢紝鍑忓皯閲嶅浠ｇ爜銆?- **鏄撲簬鎵╁睍**锛氭柟渚垮揩鎹峰湴鎺ュ叆鏂扮殑 AI Provider (LLM渚涘簲鍟? 鍜屾坊鍔犳柊鐨?AI 鍔熻兘 (濡傜炕璇戙€佹憳瑕併€佸浘鍍忕敓鎴愮瓑)銆?- **鏄撲簬缁存姢**锛氱畝鍖栧崟涓粍浠剁殑澶嶆潅鎬э紝鎻愰珮浠ｇ爜鐨勫彲璇绘€у拰鍙淮鎶ゆ€с€?- **鏍囧噯鍖?*锛氱粺涓€鍐呴儴鏁版嵁娴佸拰鎺ュ彛锛岀畝鍖栦笉鍚?Provider 涔嬮棿鐨勫樊寮傚鐞嗐€?
鏍稿績鎬濊矾鏄皢绾补鐨?**SDK 閫傞厤灞?(`XxxApiClient`)**銆?*閫氱敤閫昏緫澶勭悊涓庢櫤鑳借В鏋愬眰 (涓棿浠?** 浠ュ強 **缁熶竴涓氬姟鍔熻兘鍏ュ彛灞?(`AiCoreService`)** 娓呮櫚鍦板垎绂诲紑鏉ャ€?
## 2. 鏍稿績缁勪欢璇﹁В

### 2.1. `aiCore` (鍘?`AiProvider` 鏂囦欢澶?

杩欐槸鏁翠釜 AI 鍔熻兘鐨勬牳蹇冩ā鍧椼€?
#### 2.1.1. `XxxApiClient` (渚嬪 `aiCore/clients/openai/OpenAIApiClient.ts`)

- **鑱岃矗**锛氫綔涓虹壒瀹?AI Provider SDK 鐨勭函绮归€傞厤灞傘€?  - **鍙傛暟閫傞厤**锛氬皢搴旂敤鍐呴儴缁熶竴鐨?`CoreRequest` 瀵硅薄 (瑙佷笅鏂? 杞崲涓虹壒瀹?SDK 鎵€闇€鐨勮姹傚弬鏁版牸寮忋€?  - **鍩虹鍝嶅簲杞崲**锛氬皢 SDK 杩斿洖鐨勫師濮嬫暟鎹潡 (`RawSdkChunk`锛屼緥濡?`OpenAI.Chat.Completions.ChatCompletionChunk`) 杞崲涓轰竴缁勬渶鍩虹銆佹渶鐩存帴鐨勫簲鐢ㄥ眰 `Chunk` 瀵硅薄 (瀹氫箟浜?`src/renderer/src/types/chunk.ts`)銆?    - 渚嬪锛歋DK 鐨?`delta.content` -> `TextDeltaChunk`锛汼DK 鐨?`delta.reasoning_content` -> `ThinkingDeltaChunk`锛汼DK 鐨?`delta.tool_calls` -> `RawToolCallChunk` (鍖呭惈鍘熷宸ュ叿璋冪敤鏁版嵁)銆?    - **鍏抽敭**锛歚XxxApiClient` **涓嶅鐞?*鑰﹀悎鍦ㄦ枃鏈唴瀹逛腑鐨勫鏉傜粨鏋勶紝濡?`<think>` 鎴?`<tool_use>` 鏍囩銆?- **鐗圭偣**锛氭瀬搴﹁交閲忓寲锛屼唬鐮侀噺灏戯紝鏄撲簬瀹炵幇鍜岀淮鎶ゆ柊鐨?Provider 閫傞厤銆?
#### 2.1.2. `ApiClient.ts` (鎴?`BaseApiClient.ts` 鐨勬牳蹇冩帴鍙?

- 瀹氫箟浜嗘墍鏈?`XxxApiClient` 蹇呴』瀹炵幇鐨勬帴鍙ｏ紝濡傦細
  - `getSdkInstance(): Promise<TSdkInstance> | TSdkInstance`
  - `getRequestTransformer(): RequestTransformer<TSdkParams>`
  - `getResponseChunkTransformer(): ResponseChunkTransformer<TRawChunk, TResponseContext>`
  - 鍏朵粬鍙€夌殑銆佷笌鐗瑰畾 Provider 鐩稿叧鐨勮緟鍔╂柟娉?(濡傚伐鍏疯皟鐢ㄨ浆鎹?銆?
#### 2.1.3. `ApiClientFactory.ts`

- 鏍规嵁 Provider 閰嶇疆鍔ㄦ€佸垱寤哄拰杩斿洖鐩稿簲鐨?`XxxApiClient` 瀹炰緥銆?
#### 2.1.4. `AiCoreService.ts` (`aiCore/index.ts`)

- **鑱岃矗**锛氫綔涓烘墍鏈?AI 鐩稿叧涓氬姟鍔熻兘鐨勭粺涓€鍏ュ彛銆?  - 鎻愪緵闈㈠悜搴旂敤鐨勯珮灞傛帴鍙ｏ紝渚嬪锛?    - `executeCompletions(params: CompletionsParams): Promise<AggregatedCompletionsResult>`
    - `translateText(params: TranslateParams): Promise<AggregatedTranslateResult>`
    - `summarizeText(params: SummarizeParams): Promise<AggregatedSummarizeResult>`
    - 鏈潵鍙兘鐨?`generateImage(prompt: string): Promise<ImageResult>` 绛夈€?  - **杩斿洖 `Promise`**锛氭瘡涓湇鍔℃柟娉曡繑鍥炰竴涓?`Promise`锛岃 `Promise` 浼氬湪鏁翠釜锛堝彲鑳芥槸娴佸紡鐨勶級鎿嶄綔瀹屾垚鍚庯紝浠ュ寘鍚墍鏈夎仛鍚堢粨鏋滐紙濡傚畬鏁存枃鏈€佸伐鍏疯皟鐢ㄨ鎯呫€佹渶缁堢殑`usage`/`metrics`绛夛級鐨勫璞℃潵 `resolve`銆?  - **鏀寔娴佸紡鍥炶皟**锛氭湇鍔℃柟娉曠殑鍙傛暟 (濡?`CompletionsParams`) 渚濈劧鍖呭惈 `onChunk` 鍥炶皟锛岀敤浜庡悜璋冪敤鏂瑰疄鏃舵帹閫佸鐞嗚繃绋嬩腑鐨?`Chunk` 鏁版嵁锛屽疄鐜版祦寮廢I鏇存柊銆?  - **灏佽鐗瑰畾浠诲姟鐨勬彁绀哄伐绋?(Prompt Engineering)**锛?    - 渚嬪锛宍translateText` 鏂规硶鍐呴儴浼氭瀯寤轰竴涓寘鍚壒瀹氱炕璇戞寚浠ょ殑 `CoreRequest`銆?  - **缂栨帓鍜岃皟鐢ㄤ腑闂翠欢閾?*锛氶€氳繃鍐呴儴鐨?`MiddlewareBuilder` (鍙傝 `middleware/BUILDER_USAGE.md`) 瀹炰緥锛屾牴鎹皟鐢ㄧ殑涓氬姟鏂规硶鍜屽弬鏁帮紝鍔ㄦ€佹瀯寤哄拰缁勭粐鍚堥€傜殑涓棿浠跺簭鍒楋紝鐒跺悗閫氳繃 `applyCompletionsMiddlewares` 绛夌粍鍚堝嚱鏁版墽琛屻€?  - 鑾峰彇 `ApiClient` 瀹炰緥骞跺皢鍏舵敞鍏ュ埌涓棿浠朵笂娓哥殑 `Context` 涓€?  - **灏?`Promise` 鐨?`resolve` 鍜?`reject` 鍑芥暟浼犻€掔粰涓棿浠堕摼** (閫氳繃 `Context`)锛屼互渚?`FinalChunkConsumerAndNotifierMiddleware` 鍙互鍦ㄦ搷浣滃畬鎴愭垨鍙戠敓閿欒鏃剁粨鏉熻 `Promise`銆?- **浼樺娍**锛?  - 涓氬姟閫昏緫锛堝缈昏瘧銆佹憳瑕佺殑鎻愮ず鏋勫缓鍜屾祦绋嬫帶鍒讹級鍙渶瀹炵幇涓€娆★紝鍗冲彲鏀寔鎵€鏈夐€氳繃 `ApiClient` 鎺ュ叆鐨勫簳灞?Provider銆?  - **鏀寔澶栭儴缂栨帓**锛氳皟鐢ㄦ柟鍙互 `await` 鏈嶅姟鏂规硶浠ヨ幏鍙栨渶缁堣仛鍚堢粨鏋滐紝鐒跺悗灏嗘缁撴灉浣滀负鍚庣画鎿嶄綔鐨勮緭鍏ワ紝杞绘澗瀹炵幇澶氭楠ゅ伐浣滄祦銆?  - **鏀寔鍐呴儴缁勫悎**锛氭湇鍔¤嚜韬篃鍙互閫氳繃 `await` 璋冪敤鍏朵粬鍘熷瓙鏈嶅姟鏂规硶鏉ユ瀯寤烘洿澶嶆潅鐨勭粍鍚堝姛鑳姐€?
#### 2.1.5. `coreRequestTypes.ts` (鎴?`types.ts`)

- 瀹氫箟鏍稿績鐨勩€丳rovider 鏃犲叧鐨勫唴閮ㄨ姹傜粨鏋勶紝渚嬪锛?  - `CoreCompletionsRequest`: 鍖呭惈鏍囧噯鍖栧悗鐨勬秷鎭垪琛ㄣ€佹ā鍨嬮厤缃€佸伐鍏峰垪琛ㄣ€佹渶澶oken鏁般€佹槸鍚︽祦寮忚緭鍑虹瓑銆?  - `CoreTranslateRequest`, `CoreSummarizeRequest` 绛?(濡傛灉涓?`CoreCompletionsRequest` 缁撴瀯宸紓杈冨ぇ锛屽惁鍒欏彲澶嶇敤骞舵坊鍔犱换鍔＄被鍨嬫爣璁?銆?
### 2.2. `middleware`

涓棿浠跺眰璐熻矗澶勭悊璇锋眰鍜屽搷搴旀祦涓殑閫氱敤閫昏緫鍜岀壒瀹氱壒鎬с€傚叾璁捐鍜屼娇鐢ㄩ伒寰?`middleware/BUILDER_USAGE.md` 涓畾涔夌殑瑙勮寖銆?
**鏍稿績缁勪欢鍖呮嫭锛?*

- **`MiddlewareBuilder`**: 涓€涓€氱敤鐨勩€佹彁渚涙祦寮廇PI鐨勭被锛岀敤浜庡姩鎬佹瀯寤轰腑闂翠欢閾俱€傚畠鏀寔浠庡熀纭€閾惧紑濮嬶紝鏍规嵁鏉′欢娣诲姞銆佹彃鍏ャ€佹浛鎹㈡垨绉婚櫎涓棿浠躲€?- **`applyCompletionsMiddlewares`**: 璐熻矗鎺ユ敹 `MiddlewareBuilder` 鏋勫缓鐨勯摼骞舵寜椤哄簭鎵ц锛屼笓闂ㄧ敤浜?Completions 娴佺▼銆?- **`MiddlewareRegistry`**: 闆嗕腑绠＄悊鎵€鏈夊彲鐢ㄤ腑闂翠欢鐨勬敞鍐岃〃锛屾彁渚涚粺涓€鐨勪腑闂翠欢璁块棶鎺ュ彛銆?- **鍚勭鐙珛鐨勪腑闂翠欢妯″潡** (瀛樻斁浜?`common/`, `core/`, `feat/` 瀛愮洰褰?銆?
#### 2.2.1. `middlewareTypes.ts`

- 瀹氫箟涓棿浠剁殑鏍稿績绫诲瀷锛屽 `AiProviderMiddlewareContext` (鎵╁睍鍚庡寘鍚?`_apiClientInstance` 鍜?`_coreRequest`)銆乣MiddlewareAPI`銆乣CompletionsMiddleware` 绛夈€?
#### 2.2.2. 鏍稿績涓棿浠?(`middleware/core/`)

- **`TransformCoreToSdkParamsMiddleware.ts`**: 璋冪敤 `ApiClient.getRequestTransformer()` 灏?`CoreRequest` 杞崲涓虹壒瀹?SDK 鐨勫弬鏁帮紝骞跺瓨鍏ヤ笂涓嬫枃銆?- **`RequestExecutionMiddleware.ts`**: 璋冪敤 `ApiClient.getSdkInstance()` 鑾峰彇 SDK 瀹炰緥锛屽苟浣跨敤杞崲鍚庣殑鍙傛暟鎵ц瀹為檯鐨?API 璋冪敤锛岃繑鍥炲師濮?SDK 娴併€?- **`StreamAdapterMiddleware.ts`**: 灏嗗悇绉嶅舰鎬佺殑鍘熷 SDK 娴?(濡傚紓姝ヨ凯浠ｅ櫒) 缁熶竴閫傞厤涓?`ReadableStream<RawSdkChunk>`銆?  - **`RawSdkChunk`**锛氭寚鐗瑰畾AI鎻愪緵鍟哠DK鍦ㄦ祦寮忓搷搴斾腑杩斿洖鐨勩€佹湭缁忓簲鐢ㄥ眰缁熶竴澶勭悊鐨勫師濮嬫暟鎹潡鏍煎紡 (渚嬪 OpenAI 鐨?`ChatCompletionChunk`锛孏emini 鐨?`GenerateContentResponse` 涓殑閮ㄥ垎绛?銆?- **`RawSdkChunkToAppChunkMiddleware.ts`**: (鏂板) 娑堣垂 `ReadableStream<RawSdkChunk>`锛屽湪鍏跺唴閮ㄥ姣忎釜 `RawSdkChunk` 璋冪敤 `ApiClient.getResponseChunkTransformer()`锛屽皢鍏惰浆鎹负涓€涓垨澶氫釜鍩虹鐨勫簲鐢ㄥ眰 `Chunk` 瀵硅薄锛屽苟杈撳嚭 `ReadableStream<Chunk>`銆?
#### 2.2.3. 鐗规€т腑闂翠欢 (`middleware/feat/`)

杩欎簺涓棿浠舵秷璐圭敱 `ResponseTransformMiddleware` 杈撳嚭鐨勩€佺浉瀵规爣鍑嗗寲鐨?`Chunk` 娴侊紝骞跺鐞嗘洿澶嶆潅鐨勯€昏緫銆?
- **`ThinkingTagExtractionMiddleware.ts`**: 妫€鏌?`TextDeltaChunk`锛岃В鏋愬叾涓彲鑳藉寘鍚殑 `<think>...</think>` 鏂囨湰鍐呭祵鏍囩锛岀敓鎴?`ThinkingDeltaChunk` 鍜?`ThinkingCompleteChunk`銆?- **`ToolUseExtractionMiddleware.ts`**: 妫€鏌?`TextDeltaChunk`锛岃В鏋愬叾涓彲鑳藉寘鍚殑 `<tool_use>...</tool_use>` 鏂囨湰鍐呭祵鏍囩锛岀敓鎴愬伐鍏疯皟鐢ㄧ浉鍏崇殑 Chunk銆傚鏋?`ApiClient` 杈撳嚭浜嗗師鐢熷伐鍏疯皟鐢ㄦ暟鎹紝姝や腑闂翠欢涔熻礋璐ｅ皢鍏惰浆鎹负鏍囧噯鏍煎紡銆?
#### 2.2.4. 鏍稿績澶勭悊涓棿浠?(`middleware/core/`)

- **`TransformCoreToSdkParamsMiddleware.ts`**: 璋冪敤 `ApiClient.getRequestTransformer()` 灏?`CoreRequest` 杞崲涓虹壒瀹?SDK 鐨勫弬鏁帮紝骞跺瓨鍏ヤ笂涓嬫枃銆?- **`SdkCallMiddleware.ts`**: 璋冪敤 `ApiClient.getSdkInstance()` 鑾峰彇 SDK 瀹炰緥锛屽苟浣跨敤杞崲鍚庣殑鍙傛暟鎵ц瀹為檯鐨?API 璋冪敤锛岃繑鍥炲師濮?SDK 娴併€?- **`StreamAdapterMiddleware.ts`**: 灏嗗悇绉嶅舰鎬佺殑鍘熷 SDK 娴佺粺涓€閫傞厤涓烘爣鍑嗘祦鏍煎紡銆?- **`ResponseTransformMiddleware.ts`**: 灏嗗師濮?SDK 鍝嶅簲杞崲涓哄簲鐢ㄥ眰鏍囧噯 `Chunk` 瀵硅薄銆?- **`TextChunkMiddleware.ts`**: 澶勭悊鏂囨湰鐩稿叧鐨?Chunk 娴併€?- **`ThinkChunkMiddleware.ts`**: 澶勭悊鎬濊€冪浉鍏崇殑 Chunk 娴併€?- **`McpToolChunkMiddleware.ts`**: 澶勭悊宸ュ叿璋冪敤鐩稿叧鐨?Chunk 娴併€?- **`WebSearchMiddleware.ts`**: 澶勭悊 Web 鎼滅储鐩稿叧閫昏緫銆?
#### 2.2.5. 閫氱敤涓棿浠?(`middleware/common/`)

- **`LoggingMiddleware.ts`**: 璇锋眰鍜屽搷搴旀棩蹇椼€?- **`AbortHandlerMiddleware.ts`**: 澶勭悊璇锋眰涓銆?- **`FinalChunkConsumerMiddleware.ts`**: 娑堣垂鏈€缁堢殑 `Chunk` 娴侊紝閫氳繃 `context.onChunk` 鍥炶皟閫氱煡搴旂敤灞傚疄鏃舵暟鎹€?  - **绱Н鏁版嵁**锛氬湪娴佸紡澶勭悊杩囩▼涓紝绱Н鍏抽敭鏁版嵁锛屽鏂囨湰鐗囨銆佸伐鍏疯皟鐢ㄤ俊鎭€乣usage`/`metrics` 绛夈€?  - **缁撴潫 `Promise`**锛氬綋杈撳叆娴佺粨鏉熸椂锛屼娇鐢ㄧ疮绉殑鑱氬悎缁撴灉鏉ュ畬鎴愭暣涓鐞嗘祦绋嬨€?  - 鍦ㄦ祦缁撴潫鏃讹紝鍙戦€佸寘鍚渶缁堢疮鍔犱俊鎭殑瀹屾垚淇″彿銆?
### 2.3. `types/chunk.ts`

- 瀹氫箟搴旂敤鍏ㄥ眬缁熶竴鐨?`Chunk` 绫诲瀷鍙婂叾鎵€鏈夊彉浣撱€傝繖鍖呮嫭鍩虹绫诲瀷 (濡?`TextDeltaChunk`, `ThinkingDeltaChunk`)銆丼DK鍘熺敓鏁版嵁浼犻€掔被鍨?(濡?`RawToolCallChunk`, `RawFinishChunk` - 浣滀负 `ApiClient` 杞崲鐨勪腑闂翠骇鐗?锛屼互鍙婂姛鑳芥€х被鍨?(濡?`McpToolCallRequestChunk`, `WebSearchCompleteChunk`)銆?
## 3. 鏍稿績鎵ц娴佺▼ (浠?`AiCoreService.executeCompletions` 涓轰緥)

```markdown
**搴旂敤灞?(渚嬪 UI 缁勪欢)**
||
\\/
**`AiProvider.completions` (`aiCore/index.ts`)**
(1. prepare ApiClient instance. 2. use `CompletionsMiddlewareBuilder.withDefaults()` to build middleware chain. 3. call `applyCompletionsMiddlewares`)
||
\\/
**`applyCompletionsMiddlewares` (`middleware/composer.ts`)**
(鎺ユ敹鏋勫缓濂界殑閾俱€丄piClient瀹炰緥銆佸師濮婼DK鏂规硶锛屽紑濮嬫寜搴忔墽琛屼腑闂翠欢)
||
\\/
**[ 棰勫鐞嗛樁娈典腑闂翠欢 ]**
(渚嬪: `FinalChunkConsumerMiddleware`, `TransformCoreToSdkParamsMiddleware`, `AbortHandlerMiddleware`)
|| (Context 涓噯澶囧ソ SDK 璇锋眰鍙傛暟)
\\/
**[ 澶勭悊闃舵涓棿浠?]**
(渚嬪: `McpToolChunkMiddleware`, `WebSearchMiddleware`, `TextChunkMiddleware`, `ThinkingTagExtractionMiddleware`)
|| (澶勭悊鍚勭鐗规€у拰Chunk绫诲瀷)
\\/
**[ SDK璋冪敤闃舵涓棿浠?]**
(渚嬪: `ResponseTransformMiddleware`, `StreamAdapterMiddleware`, `SdkCallMiddleware`)
|| (杈撳嚭: 鏍囧噯鍖栫殑搴旂敤灞侰hunk娴?
\\/
**`FinalChunkConsumerMiddleware` (鏍稿績)**
(娑堣垂鏈€缁堢殑 `Chunk` 娴? 閫氳繃 `context.onChunk` 鍥炶皟閫氱煡搴旂敤灞? 骞跺湪娴佺粨鏉熸椂瀹屾垚澶勭悊)
||
\\/
**`AiProvider.completions` 杩斿洖 `Promise<CompletionsResult>`**
```

## 4. 寤鸿鐨勬枃浠?鐩綍缁撴瀯

```
src/renderer/src/
鈹斺攢鈹€ aiCore/
    鈹溾攢鈹€ clients/
    鈹?  鈹溾攢鈹€ openai/
    鈹?  鈹溾攢鈹€ gemini/
    鈹?  鈹溾攢鈹€ anthropic/
    鈹?  鈹溾攢鈹€ BaseApiClient.ts
    鈹?  鈹溾攢鈹€ ApiClientFactory.ts
    鈹?  鈹溾攢鈹€ AihubmixAPIClient.ts
    鈹?  鈹溾攢鈹€ index.ts
    鈹?  鈹斺攢鈹€ types.ts
    鈹溾攢鈹€ middleware/
    鈹?  鈹溾攢鈹€ common/
    鈹?  鈹溾攢鈹€ core/
    鈹?  鈹溾攢鈹€ feat/
    鈹?  鈹溾攢鈹€ builder.ts
    鈹?  鈹溾攢鈹€ composer.ts
    鈹?  鈹溾攢鈹€ index.ts
    鈹?  鈹溾攢鈹€ register.ts
    鈹?  鈹溾攢鈹€ schemas.ts
    鈹?  鈹溾攢鈹€ types.ts
    鈹?  鈹斺攢鈹€ utils.ts
    鈹溾攢鈹€ types/
    鈹?  鈹溾攢鈹€ chunk.ts
    鈹?  鈹斺攢鈹€ ...
    鈹斺攢鈹€ index.ts
```

## 5. 杩佺Щ鍜屽疄鏂藉缓璁?
- **灏忔蹇窇锛岄€愭杩唬**锛氫紭鍏堝畬鎴愭牳蹇冩祦绋嬬殑閲嶆瀯锛堜緥濡?`completions`锛夛紝鍐嶉€愭杩佺Щ鍏朵粬鍔熻兘锛坄translate` 绛夛級鍜屽叾浠?Provider銆?- **浼樺厛瀹氫箟鏍稿績绫诲瀷**锛歚CoreRequest`, `Chunk`, `ApiClient` 鎺ュ彛鏄暣涓灦鏋勭殑鍩虹煶銆?- **涓?`ApiClient` 鐦﹁韩**锛氬皢鐜版湁 `XxxProvider` 涓殑澶嶆潅閫昏緫鍓ョ鍒版柊鐨勪腑闂翠欢鎴?`AiCoreService` 涓€?- **寮哄寲涓棿浠?*锛氳涓棿浠舵壙鎷呰捣鏇村瑙ｆ瀽鍜岀壒鎬у鐞嗙殑璐ｄ换銆?- **缂栧啓鍗曞厓娴嬭瘯鍜岄泦鎴愭祴璇?*锛氱‘淇濇瘡涓粍浠跺拰鏁翠綋娴佺▼鐨勬纭€с€?
姝ゆ灦鏋勬棬鍦ㄦ彁渚涗竴涓洿鍋ュ．銆佹洿鐏垫椿銆佹洿鏄撲簬缁存姢鐨?AI 鍔熻兘鏍稿績锛屾敮鎾?Zen AI 鏈潵鐨勫彂灞曘€?
## 6. 杩佺Щ绛栫暐涓庡疄鏂藉缓璁?
鏈妭鍐呭鎻愮偧鑷棭鏈熺殑 `migrate.md` 鏂囨。锛屽苟鏍规嵁鏈€鏂扮殑鏋舵瀯璁ㄨ杩涜浜嗚皟鏁淬€?
**鐩爣鏋舵瀯鏍稿績缁勪欢鍥為【锛?*

涓庣 2 鑺傛弿杩扮殑鏍稿績缁勪欢涓€鑷达紝涓昏鍖呮嫭 `XxxApiClient`, `AiCoreService`, 涓棿浠堕摼, `CoreRequest` 绫诲瀷, 鍜屾爣鍑嗗寲鐨?`Chunk` 绫诲瀷銆?
**杩佺Щ姝ラ锛?*

**Phase 0: 鍑嗗宸ヤ綔鍜岀被鍨嬪畾涔?*

1.  **瀹氫箟鏍稿績鏁版嵁缁撴瀯 (TypeScript 绫诲瀷)锛?*
    - `CoreCompletionsRequest` (Type)锛氬畾涔夊簲鐢ㄥ唴閮ㄧ粺涓€鐨勫璇濊姹傜粨鏋勩€?    - `Chunk` (Type - 妫€鏌ュ苟鎸夐渶鎵╁睍鐜版湁 `src/renderer/src/types/chunk.ts`)锛氬畾涔夋墍鏈夊彲鑳界殑閫氱敤Chunk绫诲瀷銆?    - 涓哄叾浠朅PI锛堢炕璇戙€佹€荤粨锛夊畾涔夌被浼肩殑 `CoreXxxRequest` (Type)銆?2.  **瀹氫箟 `ApiClient` 鎺ュ彛锛?* 鏄庣‘ `getRequestTransformer`, `getResponseChunkTransformer`, `getSdkInstance` 绛夋牳蹇冩柟娉曘€?3.  **璋冩暣 `AiProviderMiddlewareContext`锛?*
    - 纭繚鍖呭惈 `_apiClientInstance: ApiClient<any,any,any>`銆?    - 纭繚鍖呭惈 `_coreRequest: CoreRequestType`銆?    - 鑰冭檻娣诲姞 `resolvePromise: (value: AggregatedResultType) => void` 鍜?`rejectPromise: (reason?: any) => void` 鐢ㄤ簬 `AiCoreService` 鐨?Promise 杩斿洖銆?
**Phase 1: 瀹炵幇绗竴涓?`ApiClient` (浠?`OpenAIApiClient` 涓轰緥)**

1.  **鍒涘缓 `OpenAIApiClient` 绫伙細** 瀹炵幇 `ApiClient` 鎺ュ彛銆?2.  **杩佺ЩSDK瀹炰緥鍜岄厤缃€?*
3.  **瀹炵幇 `getRequestTransformer()`锛?* 灏?`CoreCompletionsRequest` 杞崲涓?OpenAI SDK 鍙傛暟銆?4.  **瀹炵幇 `getResponseChunkTransformer()`锛?* 灏?`OpenAI.Chat.Completions.ChatCompletionChunk` 杞崲涓哄熀纭€鐨?`

