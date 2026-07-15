# 库存明细 API 接口文档

## 1. 接口用途

该接口用于让其他网站的后端、Serverless Function 或服务器读取当前商品库存明细。

- 仅读取服务器上的脱敏监控快照，不会增加店铺接口请求次数。
- 返回当前仍在售的有货、缺货商品。
- 不返回历史下架商品。
- 不返回代理配置、Telegram 配置、店铺令牌、访客 ID 或运行日志。

## 2. 请求地址

```http
GET https://103.193.172.111.sslip.io/stock-monitor/api/v1/inventory
```

业务请求使用 HTTPS `GET`；浏览器跨域预检支持 `OPTIONS`。GET 请求不需要查询参数或请求体。

## 3. 身份验证

在 HTTP 请求头中携带管理员发放的 API Key：

```http
Authorization: Bearer <API_KEY>
```

注意事项：

- 不支持把 API Key 放在 URL 查询参数中。
- 监控中心的登录密码和登录 Cookie 不能代替 API Key。
- API Key 应保存在调用网站的服务端环境变量中。
- 不要把 API Key 写进浏览器 JavaScript、HTML 或公开 GitHub 仓库。

## 4. 调用示例

### cURL

```bash
curl --fail --silent \
  -H "Authorization: Bearer <API_KEY>" \
  https://103.193.172.111.sslip.io/stock-monitor/api/v1/inventory
```

### Node.js

```js
const response = await fetch(
  "https://103.193.172.111.sslip.io/stock-monitor/api/v1/inventory",
  {
    headers: {
      Authorization: `Bearer ${process.env.LDXP_INVENTORY_API_KEY}`,
    },
  },
);

if (!response.ok) {
  throw new Error(`Inventory API returned ${response.status}`);
}

const inventory = await response.json();
console.log(inventory.items);
```

### PHP

```php
<?php
$apiKey = getenv('LDXP_INVENTORY_API_KEY');
$url = 'https://103.193.172.111.sslip.io/stock-monitor/api/v1/inventory';

$context = stream_context_create([
    'http' => [
        'method' => 'GET',
        'header' => "Authorization: Bearer {$apiKey}\r\n",
        'timeout' => 10,
    ],
]);

$response = file_get_contents($url, false, $context);
$inventory = json_decode($response, true, 512, JSON_THROW_ON_ERROR);
```

## 5. 成功响应

HTTP 状态码：`200 OK`

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-07-16T00:00:00.000Z",
  "snapshotAt": "2026-07-15T23:59:00.000Z",
  "source": {
    "status": "healthy",
    "lastSuccessAt": "2026-07-15T23:59:00.000Z",
    "ageMs": 60000
  },
  "summary": {
    "total": 123,
    "inStock": 91,
    "outOfStock": 32
  },
  "items": [
    {
      "id": "example",
      "name": "示例商品",
      "url": "https://pay.ldxp.cn/item/example",
      "category": {
        "id": 1,
        "name": "GPT PLUS"
      },
      "price": 9.9,
      "stock": 12,
      "status": "in_stock",
      "lastChangedAt": "2026-07-15T23:50:00.000Z"
    }
  ]
}
```

## 6. 字段说明

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `schemaVersion` | number | 响应结构版本，目前为 `1`。 |
| `generatedAt` | ISO 8601 string | 本次 API 响应生成时间。 |
| `snapshotAt` | ISO 8601 string / null | 库存快照生成时间。 |
| `source.status` | string | 200 响应为 `healthy` 或 `degraded`。`starting`、`down` 状态返回 503。 |
| `source.lastSuccessAt` | ISO 8601 string / null | 最近成功轮询时间。 |
| `source.ageMs` | number / null | 最近成功轮询距当前的毫秒数。 |
| `summary.total` | integer | 当前在售商品总数。 |
| `summary.inStock` | integer | 有货商品数。 |
| `summary.outOfStock` | integer | 缺货商品数。 |
| `items[].id` | string | 商品唯一标识。 |
| `items[].name` | string | 商品名称。 |
| `items[].url` | string / null | `pay.ldxp.cn` 商品链接。 |
| `items[].category` | object | 商品分类 ID 与名称。 |
| `items[].price` | number | 当前售价，人民币。 |
| `items[].stock` | integer | 当前库存，最小为 0。 |
| `items[].status` | string | `in_stock` 或 `out_of_stock`。 |
| `items[].lastChangedAt` | ISO 8601 string / null | 最近一次库存状态变化时间。 |

## 7. 错误响应

应用服务产生的错误体格式：

```json
{
  "ok": false,
  "error": "unauthorized"
}
```

| HTTP 状态码 | error | 含义与处理 |
| --- | --- | --- |
| `401` | `unauthorized` | API Key 缺失或错误。检查 `Authorization` 请求头。 |
| `403` | `origin_rejected` | 浏览器来源未加入跨域白名单；浏览器 JavaScript 通常只会看到 CORS 或网络错误。 |
| `405` | `method_not_allowed` | 请求方法不是 GET 或 OPTIONS。 |
| `429` | `rate_limited` | 超过每 IP 每分钟 120 次限制，降低调用频率后重试。 |
| `503` | `snapshot_stale` | 监控已停止或快照过期，不应继续展示旧库存。 |
| `503` | `snapshot_unavailable` | 监控尚未完成首次成功轮询，或快照文件暂时不可读取。 |

如果请求先被 Nginx 限流，429 响应体可能是 HTML，并且不一定包含 `Retry-After`。调用方应先判断 HTTP 状态码，不要假设所有非 2xx 响应都能按 JSON 解析。

## 8. 跨域调用

推荐从调用网站的后端请求，本方式没有浏览器 CORS 限制。

如果确实需要浏览器前端直接调用，应把调用网站的精确 HTTPS Origin 加入服务器环境变量：

```dotenv
LDXP_INVENTORY_API_ALLOWED_ORIGINS=https://shop.example.com,https://www.example.com
```

修改后只需重启 `ldxp-dashboard`。不要使用通配符 `*`，也不要把 API Key 放入公开前端代码；CORS 不能保护密钥。

## 9. 限流与数据新鲜度

- Nginx 和应用层都按真实来源 IP 限制为每分钟 120 次。
- 页面库存监控通常每 5 分钟更新一次，调用方无需高频轮询。
- 建议调用网站每 30 至 60 秒轮询一次；响应头为 `Cache-Control: private, no-store`，不要依赖 HTTP 缓存。
- `source.status=degraded` 时仍会返回数据，调用方可以展示轻量提示。
- 快照达到 `down` 标准时接口返回 `503 snapshot_stale`，避免把旧库存当实时库存。

## 10. API Key 轮换

轮换 API Key 时：

1. 生成新的 32 字节随机 base64url Key。
2. 把新 Key 的 SHA-256 十六进制摘要写入 `LDXP_INVENTORY_API_KEY_HASH`。
3. 重启 `ldxp-dashboard`。
4. 在调用网站后端更新环境变量并验证 200 响应。
5. 删除旧 Key 的副本。

API 服务只保存 Key 的 SHA-256 摘要，不在环境变量、日志或网页文档中保存原始 Key。
