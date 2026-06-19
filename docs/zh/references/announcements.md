# 公告维护说明

公告数据由 `announcements.json` 提供，应用生产环境默认读取线上地址。开发环境会优先读取同源的 `/announcements-dev.json`，也可以通过 `VITE_RENDERER_ANNOUNCEMENT_FEED_URL` 临时覆盖公告地址，便于在本地验证公告入口、弹窗、未读角标、内容变更对比和紧急公告。

## 常驻公告更新时间

常驻公告建议保留稳定的 `id` 和 `startsAt`：

- `id` 不变：用户看过后不会因为内容编辑而再次弹窗。
- `startsAt` 表示首次发布时间，会作为普通发布时间使用。
- `updatedAt` 表示单条公告最近一次内容更新时间。它晚于 `startsAt` 时，公告入口右上角会显示“最近更新 {{time}}”。

示例：

```json
{
  "id": "product-vision-and-models",
  "type": "announcement",
  "enabled": true,
  "title": "产品愿景与模型说明",
  "startsAt": "2026-06-01T10:00:00+08:00",
  "updatedAt": "2026-06-19T18:30:00+08:00",
  "content": "这里填写公告正文。"
}
```

编辑已发布公告时，只更新 `content` 和 `updatedAt`。不要更换 `id`，否则会被视为一条新公告并重新弹窗。

如果用户本地已经读过旧版内容，同一个 `id` 的公告再次更新后，公告入口会显示“查看变更”按钮。默认仍展示最新版正文；用户点击“查看变更”后，会根据本地旧版内容展示差异：新增内容以红色显示，删除内容以中划线显示。首次看到的新公告没有旧版内容可比对，会按普通公告展示。

“查看变更”的红色提醒与公告已读状态分开记录：

- 用户打开公告入口后，可以清掉公告入口的未读角标。
- 如果这版内容的变更还没有被用户点开看过，“查看变更”按钮仍保持红色。
- 用户点击一次“查看变更”后，这版内容的变更被记录为已查看，按钮恢复普通样式。
- 后续再次编辑同一条公告时，只要 `content` 或 `updatedAt` 形成新的公告版本，按钮会重新进入红色提醒状态。

红点只表达当前页面内这条公告存在未读更新。用户展开公告或查看变更后，红点会消失；如果只是已经查看过变更，仍可以继续通过普通“查看变更”按钮回看差异。

## 本地验证

开发环境不需要等 GitHub 发版才能看公告效果。可以临时创建本地公告 JSON，然后让 dev 环境读取它。

1. 在项目根目录临时创建 `src/renderer/public/announcements-dev.json`。
2. 写入一份测试公告数据。
3. 启动 dev：

```powershell
pnpm dev
```

如果需要指定其他地址，再额外设置：

```powershell
$env:VITE_RENDERER_ANNOUNCEMENT_FEED_URL='http://localhost:5173/announcements-dev.json'
pnpm dev
```

测试数据示例：

```json
{
  "version": 1,
  "updatedAt": "2026-06-19T18:30:00+08:00",
  "items": [
    {
      "id": "product-vision-and-models",
      "type": "announcement",
      "enabled": true,
      "title": "产品愿景与模型说明",
      "startsAt": "2026-06-01T10:00:00+08:00",
      "updatedAt": "2026-06-19T18:30:00+08:00",
      "content": "这是一条常驻公告。更新后不会重新弹窗，但公告入口会显示最近更新时间。\\n\\n如果本地存在旧版快照，还会提供查看变更按钮，用来验证新增红字和删除线效果。"
    },
    {
      "id": "plan-description",
      "type": "announcement",
      "enabled": true,
      "title": "套餐说明",
      "startsAt": "2026-06-01T10:00:00+08:00",
      "content": "这是一条未更新的常驻公告。"
    }
  ]
}
```

验证完成后删除临时的 `src/renderer/public/announcements-dev.json`，或取消环境变量后重启 dev。这个测试文件只用于本地验证，不应随正式版本提交。
