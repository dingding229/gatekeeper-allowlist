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

兼容 `?key=awl_xxx`，但 URL 可能进入代理日志，不建议使用。

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

服务端会把 IPv4 规范化为所属 `/24`，IPv6 规范化为所属 `/64`。新网段返回 `201`，已存在的网段返回 `200`。每个 Key 最多保留 3 个不同网段，第 4 个会淘汰最早加入的网段。

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
| 500 | `internal_error` | 服务端异常 |

管理员接口供自带 Web 后台使用，通过 HttpOnly 会话 Cookie 鉴权，不作为公开集成接口。防火墙快照接口只应允许本机访问。后台保存端口设置后，宿主机 systemd 任务会在一分钟内同步到 nftables。
