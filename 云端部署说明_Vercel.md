# Vercel 云端库存监控部署说明

这个版本把定时任务迁移到 Vercel：

- Vercel Cron 每 5 分钟请求 `/api/monitor`
- `/api/monitor` 检查 `https://pay.ldxp.cn/shop/jisuai`
- 补货时发送 Telegram 群通知
- 库存状态继续保存到 GitHub 仓库 `data/ldxp-stock-state.json`
- GitHub Actions 只保留手动运行，不再自动定时运行

## 重要限制

Vercel Hobby 免费版 Cron 目前只能每天运行一次。`*/5 * * * *` 这种 5 分钟一次的 Cron 需要 Vercel Pro，否则部署会失败。

如果你要坚持免费 5 分钟一次，可以保留这个 Vercel 接口，然后用外部免费定时器去访问它。

## Vercel 环境变量

在 Vercel 项目里添加这些 Environment Variables，Production 环境要启用：

```text
CRON_SECRET=任意随机长字符串
LDXP_GITHUB_TOKEN=GitHub fine-grained token
LDXP_STATE_REPO=asd45545/buhuo
LDXP_STATE_BRANCH=main
LDXP_TELEGRAM_BOT_TOKEN=你的 Telegram bot token
LDXP_TELEGRAM_CHAT_ID=-1004429750164
```

可选：

```text
LDXP_TELEGRAM_THREAD_ID=Telegram 话题 ID，没有话题就不填
LDXP_STATE_FILE=data/ldxp-stock-state.json
LDXP_ALERT_FILE=data/ldxp-stock-alerts.md
```

## GitHub Token 权限

创建 Fine-grained personal access token：

- Repository access: 只选择 `asd45545/buhuo`
- Contents: Read and write
- Metadata: Read-only

然后把 token 填到 Vercel 的 `LDXP_GITHUB_TOKEN`。

## 部署步骤

1. 在 Vercel 新建项目，Import Git Repository，选择 `asd45545/buhuo`
2. Framework Preset 选择 Other
3. 添加上面的环境变量
4. Deploy
5. 部署完成后，到 Project Settings -> Cron Jobs，确认 `/api/monitor` 已注册
6. 在浏览器访问 `https://你的域名.vercel.app/api/monitor` 应该返回 `401`，说明保护生效
7. 等 Vercel Cron 自动触发，或在 Vercel Logs 里查看 `/api/monitor` 运行记录

## 通知格式

Telegram 补货通知格式：

```text
商品：ChatGPT Plus 月卡
库存：0 → 25
售价：¥19.90
商品链接：https://pay.ldxp.cn/item/xxxx
```
