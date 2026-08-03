# Gatekeeper API 参考

默认地址为 `http://127.0.0.1:8787`，生产环境请替换成 HTTPS 域名。

## 鉴权

客户端接口支持以下方式，推荐第一种：

```http
Authorization: Bearer awl_xxx
X-Gatekeeper-Device-ID: laptop_main
X-Gatekeeper-Device-Name: My Laptop
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
{ "ip": "203.0.113.8", "source": "office" }
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

## 设备识别与访问频率

客户端可通过 `X-Gatekeeper-Device-ID` 提供 3–64 位的稳定设备 ID（仅允许字母、数字、`_` 和 `-`），并通过 `X-Gatekeeper-Device-Name` 提供后台显示名称。也可在 JSON 中使用 `deviceId` 和 `deviceName`。未提供 ID 的旧客户端统一归入 `legacy` 设备。

请求间隔按“用户 + 设备 ID”独立计算，默认 60 秒，管理员可在后台立即修改。同一用户的不同 Surge 设备互不卡住；同一设备的 API Key 和 Surge 专属令牌仍共用限额。超限时返回：

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 42
RateLimit-Limit: 1
RateLimit-Remaining: 0
```

Surge 专属模块包含与后台间隔一致的本地防重复锁。即使定时任务和 `network-changed` 同时触发，也只会发送一次；如果服务端仍返回频率限制，面板显示中文原因和剩余等待时间，不显示 HTTP 状态码。

Surge 上报还必须包含当前 `moduleVersion` 和 `scriptVersion`。服务端会与自身要求的版本严格匹配；不匹配时不写入设备或白名单，并返回：

```json
{
  "error": "module_update_required",
  "serverVersion": "2.0.0",
  "requiredModuleVersion": "2.0.0",
  "requiredScriptVersion": "2.0.0"
}
```

Surge 脚本会将该响应转换成中文更新通知，点击通知可打开当前用户的最新模块安装页。

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
{ "ok": true }
```

## 错误

| 状态码 | 错误值                  | 说明                                                 |
| ------ | ----------------------- | ---------------------------------------------------- |
| 400    | `invalid_ip`            | IP 地址格式错误                                      |
| 401    | `missing_api_key`       | 未提供 Key                                           |
| 401    | `invalid_api_key`       | Key 错误、已轮换或用户已停用                         |
| 403    | `network_blacklisted`   | 该 IP 所属网段已被管理员拉黑                         |
| 400    | `invalid_device_id`     | 设备 ID 格式无效                                     |
| 409    | `device_limit_exceeded` | 该用户已达到 20 台已登记设备上限，需在后台移除旧设备 |
| 429    | `rate_limit_exceeded`   | 该用户的该设备在最短间隔内已访问客户端 API           |
| 500    | `internal_error`        | 服务端异常                                           |

管理员接口供自带 Web 后台使用，通过 HttpOnly 会话 Cookie 鉴权，不作为公开集成接口。防火墙快照和版本通知接口只允许本机访问，Caddy 对公网统一返回 404。用户新增、淘汰、移除、清空、启停和端口设置变更后，宿主机即时同步服务会刷新 nftables；每分钟定时器作为失败兜底。
