# Vercel 部署说明

这套方案现在是：

1. GitHub Actions 每 5 分钟触发一次
2. GitHub Actions 只请求 Vercel 的 `/api/monitor`
3. Vercel 直接去抓 `https://pay.ldxp.cn/shop/jisuai`
4. Vercel 把库存状态写回 GitHub 仓库
5. 如果发现补货，Vercel 再触发 `telegram-notify.yml` 发群消息

## Vercel 环境变量

在 Vercel 项目里添加：

```text
CRON_SECRET=一串随机长字符串
LDXP_GITHUB_TOKEN=GitHub fine-grained token
```

可选项：

```text
LDXP_STATE_REPO=asd45545/buhuo
LDXP_STATE_BRANCH=main
LDXP_STATE_FILE=data/ldxp-stock-state.json
LDXP_ALERT_FILE=data/ldxp-stock-alerts.md
LDXP_TELEGRAM_WORKFLOW_ID=telegram-notify.yml
```

## GitHub Token 权限

给 `LDXP_GITHUB_TOKEN` 创建 Fine-grained token，并只授权仓库 `asd45545/buhuo`：

- Actions: Read and write
- Contents: Read and write
- Metadata: Read-only

## Telegram 相关 Secrets

Telegram 发送消息用的是 GitHub Actions workflow `telegram-notify.yml`，所以还要在 GitHub 仓库 Secrets 里配置：

```text
LDXP_TELEGRAM_BOT_TOKEN
LDXP_TELEGRAM_CHAT_ID
LDXP_TELEGRAM_THREAD_ID   # 可选，群组话题才需要
```

## GitHub Actions 触发器

`ldxp-stock-monitor.yml` 现在只负责定时触发 Vercel。

它默认请求：

```text
https://buhuo-monitor.vercel.app/api/monitor
```

如果你换了 Vercel 域名，可以在 GitHub 仓库 Secrets 里加：

```text
LDXP_MONITOR_URL=https://你的域名.vercel.app/api/monitor
```

## 部署检查

1. 先部署 Vercel 项目
2. 配好上面的 Vercel 环境变量
3. GitHub 仓库里配好 Telegram secrets
4. 运行 GitHub Actions 的 `LDXP Stock Monitor`
5. 检查 Vercel 返回是否正常

如果没有带 `secret` 访问 `/api/monitor`，返回 `401` 是正常的。
