# 本地图片画布

> 历史设计记录（2026-10-25 更新）：产品现仅保留“图片工作台”和“本地图片”。
> 本文所述 infinite-canvas 演示入口、`packages/image-canvas` 及其构建已移除，不再作为当前使用说明。
> 原生成任务/作品存储和安全 IPC 由图片工作台继续复用；为兼容既有记录，内部仍保留 `image-canvas` 命名与数据目录，不删除用户历史。

绘画页面默认打开“图片画布”。基于 basketikun/infinite-canvas v0.20.0，固定提交
`3a6b64b602ad062b29fac66902ed18a7ef5fd9dc`，修改后的源码在 `packages/image-canvas`，
MIT 许可证和页面中的作者归属均保留。每次桌面构建会生成本地静态页面和独立的沙盒 preload；
无需发布外部网站。使用 Zen 托管服务商时，必须先升级 Zen-API 后台任务接口；
其他受支持服务商使用各自的直接请求。原“图片工作台”和“本地图片”仍可切换。

## 使用

1. 在 Zen-AI 服务商设置中填写地址、密钥，启用服务商并添加图片模型。
2. 进入绘画 → 图片画布，新建画布，添加图片节点，在节点中选择模型并输入提示词。
3. 生成结果可下载、加入素材、裁剪、设置参考图或蒙版继续编辑。画布项目自动保存在本地。
4. 离开页面后生成任务继续运行。重新打开“生成记录”可查看结果并插入当前画布。

模型目录复用所有已启用服务商，而非旧绘画服务商过滤器。自定义模型可以声明
`endpoint_type: image-generation`，无需匹配固定名称；已知图片模型名用于补充识别。
只获取已配置的模型列表，不自动调用远端模型发现，也不把文本模型全部当图片模型。
多个密钥时使用配置中的第一个非空密钥；本轮没有增加新的轮换规则。

## 当前协议范围

| 服务商/模型 | 请求方式 | 参考图 | 限制 |
| --- | --- | --- | --- |
| Zen 托管服务商（925636.xyz 及其子域） | /api/image-studio 后台任务、短请求查询、鉴权作品下载 | 支持 | 服务端必须提供 submission_lookup 能力；模型及参数取后台允许的能力范围 |
| OpenAI 和其他 OpenAI 兼容服务商 | images/generations、multipart images/edits | 支持 | 每次 1–4 张，具体尺寸和参数仍取决于上游模型 |
| 原生 Gemini 图片模型 | models/{model}:generateContent | inlineData | 每次提交一次生成请求，不把 n 映射为 candidateCount；不保证模型实际只返回一张 |
| 火山方舟 Seedream | /api/v3/images/generations | JSON image 数据地址 | 每次提交一次请求，不传 OpenAI n/quality/透明背景字段 |

原生 Gemini 按画面比例组装 imageConfig；已识别的 Gemini 3 / Pro Image 模型可设置图片分辨率，
明确传递所选 1K/2K/4K，避免通用画布预设的像素边长造成误判。旧 Gemini 图片模型只显示自动分辨率。
OAuth、Vertex、Azure、原生 DashScope 等其他鉴权或协议暂不纳入这个画布适配器；
国产模型通过 OpenAI 兼容网关接入时按网关协议调用。兼容声明不代表所有上游模型参数一致。
自定义 API base 沿用 Zen-AI 的尾部 `#` 约定。

## 权限边界

主窗口将 provider 配置交给主进程；画布只拿到 provider ID、显示名称、模型 ID 和协议。
密钥、服务商地址和额外请求头不进入画布 JavaScript。页面仅有 catalog/submit/task/history/asset/recover
以及保存确认接口，没有任意 HTTP、文件路径、Shell、聊天或代理执行权限。

本地页面使用独立持久化分区、sandbox、contextIsolation、webSecurity，禁用 Node 集成。
IPC 同时验证具体 WebContents、主 frame 和固定的本地入口 URL。导航、弹窗和权限请求被拒绝。
页面请求限于打包目录、data 和 blob，CSP 禁止外部脚本和动态脚本执行。
上游 analytics、Agent 自动连接、插件加载器、模型脚本、远程提示词源、独立密钥配置与 WebDAV
入口不装配。视频、音频请求在模块边界拒绝，工具栏不展示其创建按钮。

生成由主进程 net.fetch 执行，使用既有网络代理配置；付费 POST 不自动重试、重定向或降级。
结果图片由主进程下载。直接协议返回的外部图片链接不携带服务商鉴权头或 cookies；
仅接受 HTTPS 公网地址，拒绝重定向。Zen 后台任务的作品从同一服务商的固定 API 路径鉴权下载，
拒绝重定向；恢复任务时要求服务商 origin 与提交时一致。图片在归档前使用 sharp 解码、限制像素并转为 PNG。

## 任务和数据

- 项目、参考图、素材继续使用画布独立的 IndexedDB，不修改 Zen-AI 的 Redux 或 Dexie schema。
- 任务索引和生成图片保存在 `{userData}/Data/image-canvas`；关闭页面前请求画布刷新保存。
- 先原子保存任务 ID，再发送请求；相同 ID 和内容只发一次。相同 ID 改内容会被拒绝。
- 最多同时运行 2 个任务；参考图最多 4 张、合计 20 MiB。生成结果限制大小和解码像素。
- 应用重启时运行中任务改为“待确认”，不自动重发。Zen 后台任务在付费 POST 前保存提交 UUID
  和服务商 origin；丢失创建响应时只用该 UUID 查询，不重复创建。生成记录的“检查服务端结果”
  只读取原任务与作品，重新启动本地归档，不调用模型。
- Zen 旧服务端缺少 bootstrap 或 submission_lookup 能力时，在付费请求前提示更新；不回退长连接。
  客户端继续使用 pnpm dev 启动，服务端更新需要单独发布。短查询避免客户端长期占用生成连接，
  但不能保证上游速度、出图或计费状态，也不能修复上游自身连接超时。
- 直接协议发生 524 等网关超时会显示具体原因，状态为“待确认”。只有用量记录、没有作品或
  可查询的后台任务时，无法从日志还原图片。“重新生成”会提交新任务，可能再次计费。
- “停止等待”仅让画布停止等待当前请求。已接受的宿主任务继续运行，结果保留在生成记录。
- 任务索引不保存密钥、请求头或参考图副本。生成记录显示最近 100 个任务，图片可单独保存。
- 本地任务与画布不是 Zen-API 服务端作品库，暂不提供跨设备同步或独立备份管理。

## 验证

```sh
pnpm --filter @zen-ai/image-canvas typecheck
pnpm --filter @zen-ai/image-canvas build
pnpm exec vitest run src/main/services/imageCanvas/__tests__ src/main/services/__tests__/ImageCanvasService.test.ts src/renderer/src/pages/paintings/__tests__/imageCanvasProviders.test.ts --pool=forks --maxWorkers=1 --no-file-parallelism
pnpm exec tsx scripts/image-canvas-smoke.ts
pnpm lint
pnpm test
pnpm exec electron-vite build
```

Electron smoke 使用独立临时 userData 和本地模拟上游，验证真实沙盒 preload、脱敏目录、
关闭后完成任务、重新打开恢复和网页外网阻断。浏览器离线界面检查使用
`node packages/image-canvas/e2e/preview.mjs`，地址为 `http://127.0.0.1:4190`，
其图片带有 OFFLINE TEST FIXTURE 标记，不调用付费 API。该测试夹具不进入桌面包。
可设置 CANVAS_FIXTURE_PORT=4191 与 CANVAS_FIXTURE_ERROR=upstream_http_524，离线验证超时提示；
错误夹具不返回图片，不能用来证明实际服务商已经接通。
未用生产账户进行实际付费出图，不能据此保证真实上游的速度、画质或可用率。
