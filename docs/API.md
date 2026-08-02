# Gatekeeper API 参考

默认地址为 `http://127.0.0.1:8787`，生产环境请替换成 HTTPS 域名。

## 鉴权

客户端接口支持以下方式，推荐第一种：

```http
Authorization: Bearer awl_xxx
```

```http
X-API-Key: awl_xxx
```

出于防止密钥进入代理日志和浏览器历史的考虑，不支持 URL 查询参数传递 API Key。

## 添加网段

```http
POST /api/v1/whitelist
Content-Type: application/json
Authorization: Bearer awl_xxx

{"source":"laptop"}
```

省略 `ip` 时使用请求来源 IP；也可以显式传入一个地址：

```json
{"ip":"203.0.113.8","source":"office"}
```

服务端会把 IPv4 规范化为所属 `/24`，IPv6 规范化为所属 `/64`。新网段返回 `201`，已存在的网段返回 `200`。每个用户默认保留 3 个不同网段，管理员可在后台调整为 1–100 个；超出配额会淘汰最早加入的网段。每次成功上报都会写入历史记录。客户端可先通过 `https://64.ipcheck.ing/geo` 查询自己的信息，再附带 `ipInfo`；Surge 模块已自动完成此步骤。该展示信息不参与授权判断。

```json
{
  "ip": "203.0.113.8",
  "source": "surge",
  "ipInfo": {
    "source": "ipcheck.ing",
    "country": "CN",
    "region": "Guangdong",
    "city": "Shenzhen",
    "isp": "Example ISP"
  }
}
```

如果所属网段已被管理员拉黑，返回 `403 network_blacklisted`。黑名单优先于用户白名单和永久放行 IP。

```json
{
  "ok": true,
  "status": "added",
  "ip": "203.0.113.0/24",
  "evicted": null,
  "slots": 1,
  "limit": 3,
  "ips": []
}
```

`ips` 中的每一项还包含 `source`、创建时间和最后上报时间。

## 访问频率

同一用户的全部客户端接口共用请求间隔，默认 60 秒，管理员可在后台“系统设置”立即修改。API Key 与该用户的 Surge 专属令牌计入同一个限额。超限时返回：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
RateLimit-Limit: 1
RateLimit-Remaining: 0
```

## 查询当前 Key 的网段

```http
GET /api/v1/whitelist
Authorization: Bearer awl_xxx
```

## 健康检查

```http
GET /health
```

```json
{"ok":true}
```

## 错误

| 状态码 | 错误值 | 说明 |
|---|---|---|
| 400 | `invalid_ip` | IP 地址格式错误 |
| 401 | `missing_api_key` | 未提供 Key |
| 401 | `invalid_api_key` | Key 错误、已轮换或用户已停用 |
| 403 | `network_blacklisted` | 该 IP 所属网段已被管理员拉黑 |
| 429 | `rate_limit_exceeded` | 该用户在管理员设置的最短间隔内已访问客户端 API |
| 500 | `internal_error` | 服务端异常 |

管理员接口供自带 Web 后台使用，通过 HttpOnly 会话 Cookie 鉴权，不作为公开集成接口。防火墙快照和版本通知接口只允许本机访问，Caddy 对公网统一返回 404。用户新增、淘汰、移除、清空、启停和端口设置变更后，宿主机即时同步服务会刷新 nftables；每分钟定时器作为失败兜底。
