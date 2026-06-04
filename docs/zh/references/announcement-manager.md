# 公告管理器

这个工具用于可视化管理客户端读取的远程公告文件：

```text
https://download.925636.xyz/zen-ai/announcements.json
```

默认对应服务器文件：

```text
/opt/zen-ai-update/html/zen-ai/announcements.json
```

## 启动

在服务器上进入项目目录，执行：

```bash
ANNOUNCEMENT_MANAGER_PASSWORD='换成一个强密码' \
ANNOUNCEMENT_FILE='/opt/zen-ai-update/html/zen-ai/announcements.json' \
ANNOUNCEMENT_MANAGER_HOST='127.0.0.1' \
ANNOUNCEMENT_MANAGER_PORT='37891' \
node scripts/announcement-manager.js
```

然后访问：

```text
http://127.0.0.1:37891
```

默认用户名是：

```text
admin
```

## 推荐部署方式

建议保持管理器只监听 `127.0.0.1`，不要直接暴露公网。需要远程访问时，用 Nginx 做 HTTPS 反代，并额外加一层访问限制。

示例：

```nginx
location /announcement-admin/ {
  proxy_pass http://127.0.0.1:37891/;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
}
```

## 使用说明

- 普通公告会对每个客户端按 `id` 只弹窗一次。
- 如果同一条公告内容更新但 `id` 不变，已经关闭过的用户不会再次弹窗。
- 紧急信息不可由用户关闭，只能在管理器里关闭或设置过期时间。
- 如果只是下线公告，优先点击“关闭”，不要直接删除。
- 保存时会自动备份旧文件，备份文件在同目录下，后缀为 `.bak`。

## 本地校验

可以用下面命令检查公告 JSON 是否可读取：

```bash
ANNOUNCEMENT_FILE='/opt/zen-ai-update/html/zen-ai/announcements.json' \
ANNOUNCEMENT_MANAGER_ALLOW_NO_PASSWORD='true' \
node scripts/announcement-manager.js --check
```
