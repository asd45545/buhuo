# 极速AI库存监控云端部署说明

这个目录已经准备好 GitHub Actions 云端定时运行配置：

- 工作流文件：`.github/workflows/ldxp-stock-monitor.yml`
- 监控脚本：`scripts/monitor-ldxp-stock.mjs`
- 状态文件：`data/ldxp-stock-state.json`

## 推荐部署方式

1. 新建一个 GitHub 私有仓库。
2. 把本目录里的文件上传/推送到仓库。
3. 进入仓库 `Settings -> Secrets and variables -> Actions -> New repository secret`。
4. 添加下面这些 Repository Secrets：

| Secret 名称 | 值 |
| --- | --- |
| `LDXP_NOTIFY_EMAIL_TO` | `2582681729@qq.com` |
| `LDXP_NOTIFY_EMAIL_FROM` | `admin@aimf.shop` |
| `LDXP_SMTP_HOST` | `smtpdm.aliyun.com` |
| `LDXP_SMTP_PORT` | `465` |
| `LDXP_SMTP_SECURE` | `true` |
| `LDXP_SMTP_USER` | `admin@aimf.shop` |
| `LDXP_SMTP_PASS` | SMTP 访问凭证 |

5. 进入仓库 `Actions -> LDXP Stock Monitor -> Run workflow`，手动运行一次测试。
6. 之后 GitHub Actions 会按计划每 10 分钟运行一次。

## 通知规则

脚本只会在“之前缺货，现在库存大于 0”的商品出现时发送邮件。

没有补货时，只会更新状态文件，不会发邮件。

## 状态持久化

GitHub Actions 每次运行后会把 `data/ldxp-stock-state.json` 提交回仓库。

这个文件用于记录上一次库存状态，不能删除；删除后会重新建立基线，可能漏掉一次补货变化。

## 安全注意

不要把 `data/ldxp-stock-email.json` 上传到 GitHub。

仓库里的 `.gitignore` 已经忽略了这个本地邮箱配置文件。云端只使用 GitHub Secrets。
