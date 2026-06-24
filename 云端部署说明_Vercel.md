# Vercel 免费版云端库存监控部署说明

这个版本适配 Vercel Hobby 免费版：

- Vercel 负责托管 `/api/monitor`
- 免费外部定时器每 5 分钟访问 `/api/monitor?secret=你的密钥`
- `/api/monitor` 检查 `https://pay.ldxp.cn/shop/jisuai`
- 补货时发送 Telegram 群通知
- 库存状态继续保存到 GitHub 仓库 `data/ldxp-stock-state.json`
- GitHub Actions 不再自动定时运行，只保留手动按钮

## 为什么不用 Vercel 自带 Cron

Vercel Hobby 免费版 Cron 只能每天运行一次，`*/5 * * * *` 这种 5 分钟一次会部署失败。

所以免费版要用：

```text
cron-job.org / 其他免费定时器 -> Vercel /api/monitor -> Telegram
```

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

## Vercel 部署步骤

1. 在 Vercel 新建项目，Import Git Repository，选择 `asd45545/buhuo`
2. Framework Preset 选择 Other
3. 添加上面的环境变量
4. Deploy
5. 部署完成后，访问：

```text
https://你的域名.vercel.app/api/monitor
```

如果返回 `401`，说明密钥保护正常。

再访问：

```text
https://你的域名.vercel.app/api/monitor?secret=你的CRON_SECRET
```

如果返回 `ok: true`，说明检测接口正常。

## 免费 5 分钟定时器设置

推荐用 cron-job.org：

1. 打开 `https://cron-job.org`
2. 注册并登录
3. 新建 Cronjob
4. URL 填：

```text
https://你的域名.vercel.app/api/monitor?secret=你的CRON_SECRET
```

5. Schedule 选择 Every 5 minutes
6. Method 选择 GET
7. 保存并启用

这样电脑关机也会自动检测。

## 通知格式

Telegram 补货通知格式：

```text
商品：ChatGPT Plus 月卡
库存：0 → 25
售价：¥19.90
商品链接：https://pay.ldxp.cn/item/xxxx
```
