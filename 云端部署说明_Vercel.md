# Vercel 免费版云端库存监控部署说明

这个版本适配 Vercel Hobby 免费版：

- Vercel 只托管 `/api/monitor`
- 免费外部定时器每 5 分钟访问 `/api/monitor?secret=你的密钥`
- `/api/monitor` 触发 GitHub Actions 的 `ldxp-stock-monitor.yml`
- GitHub Actions 负责检查 `https://pay.ldxp.cn/shop/jisuai`
- Telegram 通知继续使用 GitHub Secrets，不需要在 Vercel 里再填 Telegram token
- 库存状态继续保存到 GitHub 仓库 `data/ldxp-stock-state.json`

## 为什么不用 Vercel 自带 Cron

Vercel Hobby 免费版 Cron 只能每天运行一次，`*/5 * * * *` 这种 5 分钟一次会部署失败。

所以免费版使用：

```text
cron-job.org -> Vercel /api/monitor -> GitHub Actions -> Telegram
```

## Vercel 环境变量

在 Vercel 项目左侧点 `Environment Variables`，添加：

```text
CRON_SECRET=任意随机长字符串
LDXP_GITHUB_TOKEN=GitHub fine-grained token
```

可选，不填也可以：

```text
LDXP_STATE_REPO=asd45545/buhuo
LDXP_STATE_BRANCH=main
LDXP_WORKFLOW_ID=ldxp-stock-monitor.yml
```

## GitHub Token 权限

创建 Fine-grained personal access token：

- Repository access: 只选择 `asd45545/buhuo`
- Actions: Read and write
- Contents: Read-only
- Metadata: Read-only

然后把 token 填到 Vercel 的 `LDXP_GITHUB_TOKEN`。

## Vercel 部署步骤

1. Vercel 项目连接 GitHub 仓库 `asd45545/buhuo`
2. 添加上面的环境变量
3. 重新部署 Production
4. 部署完成后访问：

```text
https://你的域名.vercel.app/api/monitor
```

如果返回 `401`，说明密钥保护正常。

再访问：

```text
https://你的域名.vercel.app/api/monitor?secret=你的CRON_SECRET
```

如果返回 `ok: true` 和 `dispatched: true`，说明 Vercel 已成功触发 GitHub Actions。

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

Telegram 补货通知格式仍然是：

```text
商品：ChatGPT Plus 月卡
库存：0 → 25
售价：¥19.90
商品链接：https://pay.ldxp.cn/item/xxxx
```
