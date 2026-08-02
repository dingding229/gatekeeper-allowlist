# Gatekeeper

面向 Debian 12 的多用户服务器 IP 白名单。每个 API Key 最多保存 3 个 IP；第 4 个不同 IP 会自动淘汰最早加入的地址。

## 一键部署

部署前准备：

- Debian 12 服务器和 root/sudo 权限
- 一个已经解析到服务器公网 IP 的域名
- 云安全组已开放 TCP 80、443 和实际 SSH 端口
- 保留当前 SSH 会话，并确认有云厂商控制台或救援入口
- 如果使用 Cloudflare，部署证书期间建议先将 DNS 记录设为“仅 DNS”

在 SSH 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/install.sh | sudo bash
```

所有自定义信息都会在 SSH 中交互填写：

- 访问域名
- HTTPS 证书通知邮箱
- 后台管理员账号和密码
- SSH 端口
- 当前 SSH 客户端 IP
- 初始 API Key 名称
- 是否立即启用 nftables SSH 白名单

脚本会自动完成：

1. 检查 Debian 12 和 root 权限。
2. 安装 Docker 官方仓库版本、Compose、nftables 等依赖。
3. 下载项目并部署到 `/opt/gatekeeper`。
4. 启动 Gatekeeper 和 Caddy，自动申请 HTTPS 证书。
5. 创建初始用户，把当前 SSH 来源 IP 加入白名单。
6. 经确认后配置 nftables，并每分钟同步有效 IP。

> API Key 只在部署完成时显示一次，请立即保存。

## 使用 API

自动添加当前出口 IP：

```bash
curl -X POST https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"source":"laptop"}'
```

查询当前 Key 的 IP：

```bash
curl https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥"
```

更多字段见 [API 参考](docs/API.md)。

## 部署后管理

```bash
cd /opt/gatekeeper

# 查看容器
docker compose ps

# 查看日志
docker compose logs -f --tail=100

# 重启
docker compose restart

# 更新源码后重新构建
docker compose up -d --build

# 检查防火墙同步
systemctl status gatekeeper-sync.timer
journalctl -u gatekeeper-sync.service -n 50 --no-pager
```

数据保存在 Docker 命名卷中。不要执行 `docker compose down -v`，否则会删除数据库和 HTTPS 证书数据。

## 安全说明

- Gatekeeper 应只通过 Caddy 的 HTTPS 入口访问。
- 内部防火墙快照接口不会由 Caddy 对公网开放。
- Docker 容器不具备修改宿主机防火墙的权限；nftables 同步由宿主机 systemd 任务完成。
- Docker 官方文档提醒容器发布端口可能绕过部分主机防火墙规则。本项目只用 Gatekeeper nftables 表保护宿主机 SSH，80/443 由 Caddy 提供。
- 启用 SSH 白名单前，脚本会把当前 SSH 来源 IP 写入初始集合，但仍应保留控制台救援能力。

## 本地检查

```bash
npm install
npm run check
```

项目设计参考了 [reallinzc/po0fw](https://github.com/reallinzc/po0fw) 的客户端主动上报与 FIFO 淘汰机制。
