# 智能助手文献研究：超时与 skill 等待排查

## 2026-11-02 的结论

- 16:10:24 开始的续做任务，在 16:56:29 被外层 180 秒无进展保护终止。内核本来有 15 分钟无进展保护，两套规则不一致。最后一轮 API 记录 client_gone，与本地超时取消相吻合。
- 17:06:08 开始的研究任务，前 12 次模型请求成功，17:12:10 开始整理上下文，17:14:09 被本地“深度研究 8 分钟总时限”终止。期间还遇到失效链接、页面导航超时及 Cloudflare 人工验证；这些增加工作量，但不是最终中止原因。
- 16:12:46 开始的研究计划成功完成，两个并发 skill 调用都等待约 130 秒。后续另一轮 skill 调用约 50 毫秒和 1 毫秒。原诊断包没有搜索工具下载记录，不能直接认定首次 130 秒就是下载。

## 本轮修复

OpenCode 新助手启动后的任务进度由内核适配层统一管理：持续出现有效进展可以继续工作，15 分钟无有效进展暂停，人工接管另有累计 30 分钟等待保护。保留启动保护及原生模型请求/网络超时，不增加自动重试或重新执行。

工具参数增量通过现有本地转发层观察，只传递字符数和时间。原生 v1.19.4 不持续发布 pending 工具参数增长事件，仅修改原生事件转换无法覆盖这段生成。心跳、空帧、usage、完成后的完整参数快照不算新进展。

安装包已有的搜索工具目录现在加入内核 PATH，避免在普通用户没有系统 rg 时走首次下载。错误说明读取真实时限；旧的 180 秒和 8 分钟诊断也按本地终止解释。

## 已完成的无费用对照

在全新的隔离 HOME、两个小型本地 skill、固定本地模拟模型下，各做 3 次：

| 条件 | 结果 |
| --- | --- |
| PATH 中没有 rg，下载由本地拒绝代理阻断 | 每次观察到 1 次下载尝试，两个 skill 均失败 |
| PATH 接入现有随包 rg | 6 次 skill 全部成功，原生耗时 62–79 毫秒，没有下载请求 |

此试验只验证资源连接缺口，拒绝代理模拟离线条件，没有重现真实网络下载的 130 秒，也不能拿小型 fixture 的耗时保证完整文献任务的速度。

## 用户端复测步骤

本机可直接使用当前源码验收：先结束正在进行的任务，正常退出旧版 Zen AI；若已有开发进程，在其终端按 Ctrl+C 停止，再在 PowerShell 执行：

```powershell
Set-Location -LiteralPath 'C:\Users\admin\Documents\project\Zen-AI'
pnpm dev
```

其他电脑需要使用包含本轮修复的新安装包。现有安装包不会因为本机源码修改而改变。本轮无需修改服务器配置。

1. 使用包含修复的客户端。在独立测试工作目录中，先发“加载研究设计和学术研究技能，确认后简短回复”，导出本轮诊断包。不要删除真实会话、浏览器账号或用户数据来制造冷启动。
2. 同一环境重复一次，比较首次与再次调用。新建会话不等于全新内核缓存，所以判断冷启动应看搜索工具解析与进程启动证据。
3. 执行原来的文献研究任务。遇到网页验证时，按提示完成人工接管；记录等待时段，再导出诊断包。
4. 按下面的时间点定位，避免把所有等待都算成模型生成或用户网络问题。

| 观测 | 用途 |
| --- | --- |
| search-tool-resolved / bundledSearchAvailable | 内核是否拿到了随包搜索工具 |
| native-tool-timing / nativeStartedAt、nativeFinishedAt、nativeDurationMs | 原生工具阶段耗时；可能包括权限等待，不能直接当作纯文件读取时间 |
| native-tool-timing / observationDelayMs | 原生阶段结束到客户端处理到事件的间隔 |
| permission-requested、permission-resolved | 单独识别权限等待 |
| body-progress、body-complete、failed、cancelled / lastDataAt、lastForwardedAt、receivedBytes | 本地收到模型响应与写入原生连接的时间；写入不代表原生已处理 |
| performance.activity / lastMeaningfulProgressAt、lastToolInputAt、lastNativeEventAt | 区分传输仍有数据、参数持续生成与内核是否发布进展 |
| timeoutMs、phase、progressEvidence | 实际触发哪种本地保护及其时限 |

内存中的最后收包时间逐块更新，持久化 body-progress 最多每 10 秒一条，结束或取消事件保留最后状态。日志仅保留时间、计数和工具标识，不新增参数正文记录。

lastNativeEventAt 可能包含状态心跳，不能单独证明任务正在有效推进；应结合 lastMeaningfulProgressAt 与具体进展事件判断。

若原生工具已结束而 observationDelayMs 很大，查本地事件传递与主进程负载；若原生执行阶段本身很长，先核对搜索工具解析和权限等待，再调查文件扫描。若本地收包停止，使用同一 requestId 对照 API 与上游记录，区分转发链路和上游等待。仅凭累计流量、ping 或 HTTP 200 都不能证明整个流持续正常。

## 官方源码依据

- [OpenCode v1.19.4 工具参数事件](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/session/processor.ts#L295-L330)
- [原生 skill 执行路径](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/opencode/src/tool/skill.ts#L18-L39)
- [搜索工具解析与首次下载](https://github.com/anomalyco/opencode/blob/v1.19.4/packages/core/src/ripgrep/binary.ts#L83-L108)
