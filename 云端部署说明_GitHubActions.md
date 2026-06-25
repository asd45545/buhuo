# GitHub Actions 部署说明

这个仓库里的 GitHub Actions 现在分两类：

1. `ldxp-stock-monitor.yml`
   - 每 5 分钟触发一次
   - 只请求 Vercel 的 `/api/monitor`
   - 不再直接抓 `pay.ldxp.cn`
   - 顺手删除到期的 Telegram 通知

2. `telegram-notify.yml`
   - 由 Vercel 触发
   - 负责把补货消息发到 Telegram 群组
   - 发送成功后把 `message_id` 放进 `data/telegram-delete-queue.json`
   - 通知会在约 5 小时后被删除，实际删除时间取决于下一次 5 分钟定时任务

## 需要配置的 Secrets

在仓库 `Settings -> Secrets and variables -> Actions` 里添加：

```text
CRON_SECRET
LDXP_MONITOR_URL
LDXP_TELEGRAM_BOT_TOKEN
LDXP_TELEGRAM_CHAT_ID
LDXP_TELEGRAM_THREAD_ID   # 可选
```

其中：

- `CRON_SECRET` 要和 Vercel 里的同名值一致
- `LDXP_MONITOR_URL` 默认可以不填，workflow 会用 `https://buhuo-monitor.vercel.app/api/monitor`

## 通知规则

- 只有“之前缺货，现在有库存”的商品才通知
- 已经从商品列表消失过的商品，会被视为下架商品；即使后来重新出现有库存，也不会作为补货通知
- Telegram 通知格式为：

```text
商品：ChatGPT Plus 月卡
库存：0 → 25
售价：¥19.90
商品链接：https://pay.ldxp.cn/item/xxxx
```

## 触发检查

可以在 GitHub Actions 页面手动运行：

- `LDXP Stock Monitor`

如果 Telegram 想单独测试，可以手动运行：

- `Telegram Notify`

## 常见结果

- `401`：通常是 `CRON_SECRET` 不一致
- `ok: true`：说明 GitHub 已经成功唤醒 Vercel
- Vercel 返回 `500`：去看 Vercel 日志和 GitHub token 权限
