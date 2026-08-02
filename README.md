# Gatekeeper

面向 Debian 12 的多用户服务器网段白名单。每个 API Key 最多保存 3 个 IPv4 `/24` 网段；第 4 个不同网段会自动淘汰最早加入的网段。IPv6 按 `/64` 保存。

主要功能：

- 多用户 API Key，每个 Key 独立维护 3 个网段，按 FIFO 自动轮换。
- 后台查看用户、网段和审计记录，设置受保护的 TCP/UDP 端口或端口范围。
- 后台仅在安装时生成的自定义路径开放，直接访问域名根路径返回 404。
- Surge 在网络切换时和每 10 分钟自动上报当前出口 IP。
- Caddy 自动 HTTPS、SQLite 持久化、nftables 定时同步。

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
- 后台访问路径（默认随机生成）
- SSH 端口
- 当前 SSH 客户端 IP
- 初始 API Key 名称
- 是否立即启用 nftables SSH 白名单

脚本会自动完成：

1. 检查 Debian 12 和 root 权限。
2. 安装 Docker 官方仓库版本、Compose、nftables 等依赖。
3. 下载项目并部署到 `/opt/gatekeeper`。
4. 启动 Gatekeeper 和 Caddy，自动申请 HTTPS 证书。
5. 创建初始用户，把当前 SSH 来源 IP 所属 `/24` 加入白名单。
6. 经确认后配置 nftables，并每分钟同步有效网段和保护端口。

如果 Docker Hub 因 DNS、IPv6 或地区网络限制无法访问，脚本会在 SSH 中询问 Docker Hub 镜像加速地址，并安全合并现有 `/etc/docker/daemon.json`。默认建议值来自 [DaoCloud public-image-mirror](https://github.com/DaoCloud/public-image-mirror)。第三方镜像服务不由本项目运营，使用前请自行评估。

> API Key 只在部署完成时显示一次，请立即保存。

“初始 API Key 名称”只是后台中用于辨认这个 Key 的设备名称，例如 `home-surge` 或 `my-laptop`；它不是 Key 本身，也不参与登录。

## 从旧版本一键更新

已经部署过本项目时，在服务器 SSH 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/update.sh | sudo bash
```

更新脚本会保留数据库、API Key、`.env` 和 HTTPS 证书，并默认保留已有 TCP/UDP 保护范围。端口支持逗号及范围，例如 `22,443,8000-9000`；输入 `none` 可清空。如果旧安装没有启用 nftables，脚本会主动询问是否启用，并在加载规则前确认当前 SSH 网段已经在白名单中。脚本使用临时文件生成并检查规则，检查通过后才会原子替换正式配置，最后强制验证 systemd、同步任务和 nftables 规则表。

## 使用 API

自动添加当前出口 IP 所属网段：

```bash
curl -X POST https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥" \
  -H "Content-Type: application/json" \
  -d '{"source":"laptop"}'
```

查询当前 Key 的网段：

```bash
curl https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥"
```

更多字段见 [API 参考](docs/API.md)。

## Surge 自动添加

在 Surge 中安装模块：

```text
https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/surge/gatekeeper.sgmodule
```

编辑模块参数：

- `domain`：仅填写域名，如 `allowlist.example.com`。
- `url`：填写完整 HTTPS 地址，如 `https://allowlist.example.com`。
- `key`：后台创建的 `awl_` 开头 API Key。

模块会让 API 域名直连，在 `network-changed` 事件和每 10 分钟定时任务中上报，并提供手动刷新面板。服务端会将出口 IPv4 转为 `/24`；同一网段重复上报不会占用新槽位。

## 部署后管理

```bash
cd /opt/gatekeeper

# 查看容器
docker compose ps

# 查看日志
docker compose logs -f --tail=100

# 重启
docker compose restart

# 一键更新（推荐）
curl -fsSL https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/update.sh | sudo bash

# 检查防火墙同步
systemctl status gatekeeper-sync.timer
journalctl -u gatekeeper-sync.service -n 50 --no-pager

# 一键诊断防火墙、同步接口和当前端口范围
sudo /opt/gatekeeper/scripts/firewall-doctor.sh
```

数据保存在 Docker 命名卷中。不要执行 `docker compose down -v`，否则会删除数据库和 HTTPS 证书数据。

### 上次部署中断

直接重新执行一键部署命令即可。脚本通过 `/opt/gatekeeper/.install-complete` 区分完整安装和未完成安装；未完成安装会保留已有 Docker 数据卷并继续部署。

## 安全说明

- Gatekeeper 应只通过 Caddy 的 HTTPS 入口访问。
- 内部防火墙快照接口不会由 Caddy 对公网开放。
- Docker 容器不具备修改宿主机防火墙的权限；nftables 同步由宿主机 systemd 任务完成。
- 后台自定义路径用于减少无意义扫描，管理员密码和会话认证仍是主要安全边界；API 路径保持固定以支持客户端自动上报。
- nftables 设置同时保护宿主机 `input` 链和 Docker 发布端口经过的 `forward` 链。不要把 80/443 加入保护范围，否则未加白设备将无法调用 API 或打开后台。
- Docker 官方文档提醒容器发布端口可能绕过部分主机防火墙规则；容器额外发布的端口应同时通过云安全组或 Docker 网络规则限制。
- 启用白名单前，脚本会把当前 SSH 来源 IP 所属网段写入初始集合，但仍应保留控制台救援能力。

## 本地检查

```bash
npm install
npm run check
```

项目设计参考了 [reallinzc/po0fw](https://github.com/reallinzc/po0fw) 的客户端主动上报与 FIFO 淘汰机制。
