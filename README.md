# Gatekeeper

面向 Debian 12 的多用户服务器网段白名单。每个用户可独立设置允许的网段数量；超出配额时自动淘汰最早加入的网段。IPv4 按 `/24`、IPv6 按 `/64` 保存。

主要功能：

- 多用户 API Key，每个用户默认 3 个网段，可在后台调整为 1–100 个，按 FIFO 自动轮换。
- 后台查看用户、网段和审计记录；独立“防火墙配置”页面显示目标规则、实际同步状态，并设置受保护的 TCP/UDP 端口或范围。
- 后台显示上报 IP、网段、国家/地区/城市、运营商、服务器公网 IP 和用户历史 IP。
- 支持清空单个用户当前网段而保留历史记录。
- 支持删除用户、拉黑 `/24` 或 `/64` 网段、添加全局网段或指定用户网段，以及添加不占用户槽位的永久放行 IP；黑名单始终优先。
- 客户端 API 按“用户 + 设备”独立限制访问频率，后台可查看每个用户的设备、最近 IP 和上报时间。
- 后台可修改管理员账号和密码，不限制密码最短位数；密码使用 scrypt 加盐哈希保存，修改后所有后台会话立即失效。
- 后台仅在安装时生成的自定义路径开放，直接访问域名根路径返回 404。
- 后台为每个用户生成独立的 Surge 一键安装地址。
- 宿主机回传 nftables 已应用 revision、集合数量和最后成功时间；后台对超时或未同步状态显示红色警告。
- 每日执行 SQLite 在线备份、`quick_check` 校验和过期数据清理；备份保存到宿主机 `/var/backups/gatekeeper`。
- 每个用户最多登记 20 台设备，可在后台移除设备；Surge 模块地址可按用户单独撤销。
- Surge 每 10 分钟检查出口 IP，只有 IP 变化时才提交；网络切换会立即检查，并提供独立的手动刷新面板。
- Caddy 自动 HTTPS、SQLite 持久化、nftables 变更后即时同步，并保留每分钟兜底同步。

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
6. 经确认后配置 nftables，即时同步有效网段和保护端口，并启用每分钟兜底任务。

如果 Docker Hub 因 DNS、IPv6 或地区网络限制无法访问，脚本会在 SSH 中询问 Docker Hub 镜像加速地址，并安全合并现有 `/etc/docker/daemon.json`。默认建议值来自 [DaoCloud public-image-mirror](https://github.com/DaoCloud/public-image-mirror)。第三方镜像服务不由本项目运营，使用前请自行评估。

> API Key 只在部署完成时显示一次，请立即保存。

“初始 API Key 名称”只是后台中用于辨认这个 Key 的设备名称，例如 `home-surge` 或 `my-laptop`；它不是 Key 本身，也不参与登录。

## 从旧版本一键更新

已经部署过本项目时，在服务器 SSH 中执行：

```bash
curl -fsSL https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/update.sh | sudo bash
```

更新脚本会保留数据库、API Key、历史 IP、`.env` 和 HTTPS 证书，并自动迁移数据库。每次更新前后都会生成经完整性校验的宿主机数据库备份。默认保留已有 TCP/UDP 保护范围。端口支持逗号及范围，例如 `22,443,8000-9000`；输入 `none` 可清空。如果旧安装没有启用 nftables，脚本会主动询问是否启用，并在加载规则前确认当前 SSH 网段已经在白名单中。脚本使用临时文件生成并检查规则，检查通过后才会原子替换正式配置，最后强制验证 systemd、即时同步服务、兜底定时器和 nftables 规则表。

Gatekeeper 2.0 将后台拆分为用户、全局规则、防火墙配置、操作记录、系统设置和 API 使用六个独立页面。防火墙完整快照改为进入该页面时按需读取，旧数据库和现有规则会在更新过程中自动兼容，无需重新创建用户。

## 使用 API

自动添加当前出口 IP 所属网段：

```bash
curl -X POST https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥" \
  -H "X-Gatekeeper-Device-ID: laptop_main" \
  -H "X-Gatekeeper-Device-Name: My Laptop" \
  -H "Content-Type: application/json" \
  -d '{"source":"laptop"}'
```

查询当前 Key 的网段：

```bash
curl https://你的域名/api/v1/whitelist \
  -H "Authorization: Bearer awl_你的密钥"
```

更多字段见 [API 参考](docs/API.md)。

请求间隔按“用户 + `X-Gatekeeper-Device-ID`”独立计算，默认 60 秒，可在后台“系统设置”修改。每台 Surge 会在首次运行时生成并持久化独立设备 ID；手动 API 客户端应为每台设备使用稳定且唯一的 ID。未提供时归入 `legacy` 默认设备。超限时 API 返回 `Retry-After`；Surge 面板显示可读的失败原因，不显示 429 等 HTTP 代码。

## Surge 自动添加

推荐从后台获取用户专属模块：

1. 登录安装时生成的后台地址。
2. 展开目标用户，点击“Surge 安装地址”。
3. 在 Surge 设备上点击“在 Surge 中安装”，或复制地址后导入 Surge。

每个用户的模块地址都包含独立的签名授权令牌，不需要填写或暴露该用户原来的 `awl_` API Key。该地址应当像密码一样保管，不要公开分享。停用用户后，对应模块地址和授权令牌会立即失效；重新启用后原地址恢复可用。修改 `FIREWALL_SYNC_TOKEN` 会使全部既有 Surge 专属地址失效，需要从后台重新获取。

> 从旧版升级后，需从后台对每台 Surge **最后覆盖安装一次**，以获取自动脚本更新和独立设备 ID 配置。完成这次迁移后，后续脚本更新不再需要重装模块。

后台“全局规则”可选择两种网段归属：“所有用户”作为全局规则、不占用户配额；“单独用户”记入该用户并占用配额。需要注意，nftables 只能看到连接的来源 IP，无法识别应用层用户；因此任何生效的用户网段在受保护端口上都会放行该来源网段。

专属模块会：

- 每 10 分钟检查一次出口 IP；IP 与上次成功提交相同时只更新面板，不调用 Gatekeeper 白名单接口。
- 网络切换时立即检查；检测到新出口 IP 时跳过本地冷却并提交，服务器仍以请求来源 IP 为准。Surge 再按 `/24` 或 `/64` 校验当前网段已出现在返回的白名单中，未命中时显示“加白未生效”。
- 以稳定 URL 安装，并每 300 秒检查远程脚本更新；今后更新脚本无需重复安装模块。
- 首次运行会持久化本机设备 ID，并自动上报 Surge 提供的设备型号和系统，例如 `iPhone17,1 · iOS`；不同设备的请求频率互不影响。
- 在 Surge 的策略页面提供“Gatekeeper”面板，点击面板右上角刷新按钮即可手动上报。
- 将 Gatekeeper API 域名设为直连，避免代理出口导致识别到错误 IP。
- 所有触发器共用短时执行锁和服务端冷却时间，自动任务遇到限频时静默合并，避免重复通知。

如果看不到手动刷新面板，请在 Surge iOS 的策略选择页面查看，并确认使用 Surge iOS 4.9.3 或更新版本且订阅状态满足面板要求。该功能的官方说明标记为 iOS 专属；即使面板未显示，定时和网络切换自动上报仍会继续工作。面板本身没有后台刷新周期，只有手动点击才执行，避免额外消耗 API 次数。

如果后台一直显示“尚无地区信息”，请先更新服务端，然后在后台重新获取该用户的 Surge 安装地址并覆盖安装模块。模块脚本带有版本参数，更新后会绕过 Surge 的旧脚本缓存；手动刷新一次后，面板应显示“IP 信息已更新”。服务器自身查询失败时，后台会显示 IPCheck.ing 返回的错误并在 30 秒后重试，不再缓存空结果 10 分钟。

下面的公共模板仅作为旧版手动配置兼容方案：

```text
https://raw.githubusercontent.com/dingding229/gatekeeper-allowlist/main/surge/gatekeeper.sgmodule
```

编辑模块参数：

- `domain`：仅填写域名，如 `allowlist.example.com`。
- `url`：填写完整 HTTPS 地址，如 `https://allowlist.example.com`。
- `key`：后台创建的 `awl_` 开头 API Key。
- `cooldown`：本地防重复上报秒数，默认 `30`，应不小于后台 API 请求间隔。
  设备 ID 由 Surge 自动生成并保存。Surge iOS 5.9.0+ 或 Mac 5.5.0+ 会显示“设备型号 · 系统”；旧版 Surge 无法提供型号时回退为 `Surge · iOS`、`Surge · macOS` 或 `Surge`。

公共模板同样会在 `network-changed` 事件和每 10 分钟周期中检查出口 IP，并提供手动刷新面板。只有出口 IP 变化时，自动任务才调用 Gatekeeper API。Surge 会先通过 `64.ipcheck.ing/geo` 获取地区信息，但不用客户端字段决定放行 IP；Gatekeeper 始终以直连请求的来源 IP 为准。IPCheck 查询失败且不在冷却期时仍可由服务端按请求来源 IP 识别。服务端会将出口 IPv4 转为 `/24`，同一网段重复上报不会占用新槽位。

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
journalctl -u gatekeeper-sync-listener.service -n 50 --no-pager
journalctl -u gatekeeper-sync.service -n 50 --no-pager

# 一键诊断防火墙、同步接口和当前端口范围
sudo /opt/gatekeeper/scripts/firewall-doctor.sh

# 立即创建一份经校验的宿主机备份
sudo /opt/gatekeeper/scripts/backup.sh

# 查看每日备份定时器
systemctl status gatekeeper-backup.timer

# 从备份恢复（会先自动备份当前数据）
sudo /opt/gatekeeper/scripts/restore.sh /var/backups/gatekeeper/gatekeeper-YYYYMMDDTHHMMSSZ.db.gz

# 查看当前服务端版本
curl -fsS https://你的域名/health
```

后台左上角会显示服务端版本。Surge 模块名称和描述会显示模块版本；点击面板刷新后，结果中会同时显示“模块版本 · 脚本版本 · 服务端版本”，可用于判断远程更新是否生效。

服务端会强制校验 Surge 模块和脚本版本。任意一层与服务端要求不一致时，该次上报不会写入设备、历史或白名单；Surge 会显示“必须更新”通知，点击通知可打开当前用户的最新模块安装页。受 Surge 安全机制限制，脚本不能在无用户确认的情况下静默重装模块。

数据库保存在 Docker 命名卷中，默认每日备份到宿主机 `/var/backups/gatekeeper` 并保留 30 天。不要执行 `docker compose down -v`，否则会删除数据库和 HTTPS 证书数据。

### 上次部署中断

直接重新执行一键部署命令即可。脚本通过 `/opt/gatekeeper/.install-complete` 区分完整安装和未完成安装；未完成安装会保留已有 Docker 数据卷并继续部署。

## 安全说明

- Gatekeeper 应只通过 Caddy 的 HTTPS 入口访问。
- Surge 通过 IPCheck.ing 的命令行接口查询自身出口 IP、地区和运营商，再随上报提交。地区字段用于展示，属于客户端提供的辅助信息，不参与防火墙授权判断。
- 服务器分别通过 `https://4.ipcheck.ing/geo` 和 `https://6.ipcheck.ing/geo` 查询公网 IPv4/IPv6 并缓存 10 分钟；查询失败时后台安全显示“暂未获取”。
- 内部防火墙快照接口不会由 Caddy 对公网开放。
- Docker 容器不具备修改宿主机防火墙的权限；应用通过本机内部长轮询通知宿主机 systemd 服务即时同步，定时器每分钟再次校准。
- 后台自定义路径用于减少无意义扫描，管理员密码和会话认证仍是主要安全边界；API 路径保持固定以支持客户端自动上报。
- 首次启动使用 `.env` 中的管理员凭据初始化数据库。此后在后台修改的账号密码以数据库为准；新密码不会明文写回 `.env`。
- nftables 设置同时保护宿主机 `input` 链和 Docker 发布端口经过的 `forward` 链。不要把 80/443 加入保护范围，否则未加白设备将无法调用 API 或打开后台。
- Docker 官方文档提醒容器发布端口可能绕过部分主机防火墙规则；容器额外发布的端口应同时通过云安全组或 Docker 网络规则限制。
- 启用白名单前，脚本会把当前 SSH 来源 IP 所属网段写入初始集合，但仍应保留控制台救援能力。

## 本地检查

```bash
npm install
npm run check
```

项目设计参考了 [reallinzc/po0fw](https://github.com/reallinzc/po0fw) 的客户端主动上报与 FIFO 淘汰机制。
