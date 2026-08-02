#!/bin/bash
set -Eeuo pipefail

REPOSITORY="${GATEKEEPER_REPOSITORY:-dingding229/gatekeeper-allowlist}"
BRANCH="${GATEKEEPER_BRANCH:-main}"
INSTALL_DIR="${GATEKEEPER_INSTALL_DIR:-/opt/gatekeeper}"
CONFIG_DIR="/etc/gatekeeper"
TTY="/dev/tty"

green='\033[0;32m'
yellow='\033[0;33m'
red='\033[0;31m'
reset='\033[0m'

info() { printf "${green}==>${reset} %s\n" "$*"; }
warn() { printf "${yellow}警告:${reset} %s\n" "$*" >&2; }
fail() { printf "${red}错误:${reset} %s\n" "$*" >&2; exit 1; }

prompt() {
  local message="$1" default="${2:-}" value
  if [[ -n "$default" ]]; then
    read -r -p "$message [$default]: " value <"$TTY"
    printf '%s' "${value:-$default}"
  else
    read -r -p "$message: " value <"$TTY"
    printf '%s' "$value"
  fi
}

prompt_secret() {
  local message="$1" value
  read -r -s -p "$message: " value <"$TTY"
  printf '\n' >"$TTY"
  printf '%s' "$value"
}

confirm() {
  local message="$1" default="${2:-y}" answer
  if [[ "$default" == "y" ]]; then
    read -r -p "$message [Y/n]: " answer <"$TTY"
    [[ ! "${answer:-y}" =~ ^[Nn]$ ]]
  else
    read -r -p "$message [y/N]: " answer <"$TTY"
    [[ "${answer:-n}" =~ ^[Yy]$ ]]
  fi
}

configure_docker_mirror() {
  local mirror daemon_file temp_file
  mirror="$(prompt 'Docker Hub 镜像加速地址' 'https://docker.m.daocloud.io')"
  [[ "$mirror" =~ ^https://[A-Za-z0-9._:-]+/?$ ]] || fail "镜像地址必须是有效的 HTTPS URL"

  install -d -m 0755 /etc/docker
  daemon_file="/etc/docker/daemon.json"
  temp_file="$(mktemp /etc/docker/daemon.json.XXXXXX)"
  if [[ -s "$daemon_file" ]]; then
    jq -e . "$daemon_file" >/dev/null || fail "$daemon_file 不是有效 JSON，请先手动修复"
    jq --arg mirror "${mirror%/}" \
      '."registry-mirrors" = (((."registry-mirrors" // []) + [$mirror]) | unique)' \
      "$daemon_file" >"$temp_file"
  else
    jq -n --arg mirror "${mirror%/}" '{"registry-mirrors": [$mirror]}' >"$temp_file"
  fi
  chmod 0644 "$temp_file"
  mv "$temp_file" "$daemon_file"
  systemctl restart docker
  info "已配置 Docker 镜像加速：${mirror%/}"
}

ensure_docker_images() {
  info "检测 Docker Hub 镜像拉取"
  if timeout 60 docker pull caddy:2-alpine \
    && timeout 60 docker pull node:24-alpine; then
    return
  fi

  warn "Docker Hub 无法访问，可能是 DNS、IPv6 路由或网络限制"
  warn "接下来可配置第三方镜像加速；生产使用前请自行评估镜像服务提供方"
  configure_docker_mirror
  timeout 180 docker pull caddy:2-alpine \
    || fail "通过镜像源拉取 Caddy 仍然失败，请检查 DNS 和镜像地址"
  timeout 180 docker pull node:24-alpine \
    || fail "通过镜像源拉取 Node.js 仍然失败，请检查 DNS 和镜像地址"
}

[[ $EUID -eq 0 ]] || fail "请使用 root 运行：curl -fsSL https://raw.githubusercontent.com/$REPOSITORY/$BRANCH/install.sh | sudo bash"
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "安装目录只能使用绝对路径及字母、数字、点、下划线、斜杠和连字符"
case "$INSTALL_DIR" in
  / | /opt | /usr | /etc | /var | /home | /root | /tmp | *"/../"* | *"/.." | *"/./"*)
    fail "安装目录范围过大或包含不安全路径：$INSTALL_DIR"
    ;;
esac
[[ -r /etc/os-release ]] || fail "无法识别操作系统"
source /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "12" ]] || fail "此脚本仅支持 Debian 12"
[[ -r "$TTY" ]] || fail "需要交互式 SSH 终端"

printf '\nGatekeeper Debian 12 一键部署\n\n'

info "安装基础依赖"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg jq nftables openssl python3 tar util-linux

while true; do
  DOMAIN="$(prompt '访问域名（需提前解析到本机）')"
  [[ "$DOMAIN" =~ ^([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$ ]] && break
  warn "域名格式不正确，例如 allowlist.example.com"
done

while true; do
  ACME_EMAIL="$(prompt 'HTTPS 证书通知邮箱')"
  [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$ ]] && break
  warn "邮箱格式不正确"
done

while true; do
  ADMIN_USERNAME="$(prompt '后台管理员账号' 'admin')"
  [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_.-]{1,64}$ ]] && break
  warn "账号只能包含字母、数字、点、下划线和连字符"
done

DEFAULT_ADMIN_PATH="manage-$(openssl rand -hex 4)"
while true; do
  ADMIN_PATH="$(prompt '后台访问路径' "$DEFAULT_ADMIN_PATH")"
  ADMIN_PATH="${ADMIN_PATH#/}"
  [[ "$ADMIN_PATH" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$ ]] && break
  warn "路径只能包含 3-64 位字母、数字、下划线和连字符"
done

while true; do
  ADMIN_PASSWORD="$(prompt_secret '后台管理员密码')"
  ADMIN_PASSWORD_CONFIRM="$(prompt_secret '再次输入管理员密码')"
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    warn "密码不能为空"
  elif [[ "$ADMIN_PASSWORD" != "$ADMIN_PASSWORD_CONFIRM" ]]; then
    warn "两次密码不一致"
  elif [[ ! "$ADMIN_PASSWORD" =~ ^[A-Za-z0-9@%_+=:,./!-]+$ ]]; then
    warn "密码仅支持字母、数字和 @%_+=:,./!-，不支持空格、美元符号和引号"
  else
    break
  fi
done

DETECTED_SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
SSH_PORT="$(prompt 'SSH 端口' "${DETECTED_SSH_PORT:-22}")"
[[ "$SSH_PORT" =~ ^[0-9]+$ ]] && ((SSH_PORT >= 1 && SSH_PORT <= 65535)) || fail "SSH 端口无效"

SSH_CONNECTION_VALUE="${SSH_CONNECTION:-}"
INITIAL_IP="${SSH_CONNECTION_VALUE%% *}"
while true; do
  INITIAL_IP="$(prompt '当前 SSH 客户端 IP（将作为初始白名单）' "$INITIAL_IP")"
  python3 -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$INITIAL_IP" 2>/dev/null && break
  warn "IP 地址格式不正确"
done
INITIAL_USER="$(prompt '初始 API Key 名称' 'initial-device')"
[[ -n "$INITIAL_USER" && ${#INITIAL_USER} -le 64 ]] || fail "初始名称无效"
ENABLE_FIREWALL=0
if confirm "是否立即启用 nftables 网段白名单保护？" y; then ENABLE_FIREWALL=1; fi

if [[ -e "$INSTALL_DIR/.install-complete" ]]; then
  fail "$INSTALL_DIR 已是完整部署。为保护数据，本脚本不会覆盖现有安装"
fi
if [[ -e "$INSTALL_DIR/.env" ]]; then
  warn "检测到上次未完成的部署，将保留 Docker 数据卷并更新程序文件"
  confirm "是否继续修复安装？" y || fail "已取消安装"
fi

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  conflicts="$(dpkg-query -W -f='${binary:Package}\n' docker.io docker-compose docker-doc podman-docker containerd runc 2>/dev/null || true)"
  if [[ -n "$conflicts" ]]; then
    warn "检测到与 Docker CE 冲突的软件包：$conflicts"
    confirm "是否移除这些冲突包并继续？" n || fail "已取消安装"
    # Package removal does not delete /var/lib/docker data.
    apt-get remove -y $conflicts
  fi

  info "添加 Docker 官方 Debian 软件源"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat >/etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: bookworm
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
ensure_docker_images

SOURCE_DIR=""
SCRIPT_PATH="${BASH_SOURCE[0]:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${SCRIPT_PATH:-.}")" 2>/dev/null && pwd || true)"
if [[ -f "$SCRIPT_DIR/package.json" && -f "$SCRIPT_DIR/compose.yaml" ]] \
  && grep -q '"name": "gatekeeper-allowlist"' "$SCRIPT_DIR/package.json"; then
  SOURCE_DIR="$SCRIPT_DIR"
else
  info "下载 Gatekeeper 源码"
  TEMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TEMP_DIR"' EXIT
  curl --retry 3 --retry-delay 2 -fsSL "https://github.com/$REPOSITORY/archive/refs/heads/$BRANCH.tar.gz" \
    | tar -xz -C "$TEMP_DIR" --strip-components=1
  SOURCE_DIR="$TEMP_DIR"
fi
[[ -x "$SOURCE_DIR/scripts/render-nftables.sh" \
  && -x "$SOURCE_DIR/scripts/install-nftables-config.sh" \
  && -x "$SOURCE_DIR/scripts/watch-firewall.sh" \
  && -f "$SOURCE_DIR/deploy/systemd/gatekeeper-sync-listener.service" ]] \
  || fail "源码缺少防火墙安装脚本"

info "安装到 $INSTALL_DIR"
install -d -m 0755 "$INSTALL_DIR"
if [[ "$(realpath "$SOURCE_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  cp -a "$SOURCE_DIR/." "$INSTALL_DIR/"
fi
cd "$INSTALL_DIR"

FIREWALL_SYNC_TOKEN="$(openssl rand -hex 32)"
cat >.env <<EOF
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
ADMIN_USERNAME=$ADMIN_USERNAME
ADMIN_PASSWORD=$ADMIN_PASSWORD
ADMIN_PATH=/$ADMIN_PATH
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
TRUST_PROXY=1
COOKIE_SECURE=1
EOF
chmod 600 .env
chmod 755 scripts/*.sh

info "构建并启动 Gatekeeper 与 Caddy"
docker compose up -d --build
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8787/health >/dev/null || {
  docker compose logs --tail=100
  fail "Gatekeeper 启动失败"
}

info "创建初始用户和白名单"
BOOTSTRAP_JSON="$(docker compose exec -T gatekeeper node src/cli.js bootstrap "$INITIAL_USER" "$INITIAL_IP" "$SSH_PORT")"
INITIAL_API_KEY="$(printf '%s' "$BOOTSTRAP_JSON" | jq -er .apiKey)"
INITIAL_NETWORK="$(printf '%s' "$BOOTSTRAP_JSON" | jq -er .ip)"

if ((ENABLE_FIREWALL)); then
  info "配置 nftables 网段白名单"
  if [[ "$INITIAL_NETWORK" == *:* ]]; then
    INITIAL_IPV4=""
    INITIAL_IPV6="$INITIAL_NETWORK"
  else
    INITIAL_IPV4="$INITIAL_NETWORK"
    INITIAL_IPV6=""
  fi
  scripts/install-nftables-config.sh \
    deploy/nftables/gatekeeper.nft.template \
    "$CONFIG_DIR/gatekeeper.nft" \
    "$INITIAL_IPV4" "$INITIAL_IPV6" "$SSH_PORT" ""

  cat >"$CONFIG_DIR/gatekeeper-sync.env" <<EOF
ALLOWLIST_URL=http://127.0.0.1:8787
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
NFT_TABLE=gatekeeper
EOF
  chmod 600 "$CONFIG_DIR/gatekeeper-sync.env"
  install -m 0644 deploy/systemd/gatekeeper-firewall.service /etc/systemd/system/
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    deploy/systemd/gatekeeper-sync.service \
    > /etc/systemd/system/gatekeeper-sync.service
  chmod 0644 /etc/systemd/system/gatekeeper-sync.service
  sed "s|__INSTALL_DIR__|$INSTALL_DIR|g" \
    deploy/systemd/gatekeeper-sync-listener.service \
    > /etc/systemd/system/gatekeeper-sync-listener.service
  chmod 0644 /etc/systemd/system/gatekeeper-sync-listener.service
  install -m 0644 deploy/systemd/gatekeeper-sync.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable gatekeeper-firewall.service
  systemctl restart gatekeeper-firewall.service
  systemctl start gatekeeper-sync.service
  systemctl enable --now gatekeeper-sync-listener.service
  systemctl enable --now gatekeeper-sync.timer
  systemctl is-active --quiet gatekeeper-firewall.service || fail "防火墙服务未运行"
  systemctl is-active --quiet gatekeeper-sync.timer || fail "同步定时器未运行"
  systemctl is-active --quiet gatekeeper-sync-listener.service || fail "即时同步服务未运行"
  nft list table inet gatekeeper >/dev/null || fail "nftables 规则表未加载"
  scripts/firewall-doctor.sh || fail "防火墙自检失败"
fi

touch "$INSTALL_DIR/.install-complete"

printf '\n%b部署完成%b\n' "$green" "$reset"
printf '后台地址: https://%s/%s/\n' "$DOMAIN" "$ADMIN_PATH"
printf '管理员账号: %s\n' "$ADMIN_USERNAME"
printf '初始用户: %s\n' "$INITIAL_USER"
printf '初始 API Key（仅显示这一次）: %s\n' "$INITIAL_API_KEY"
printf '\n请立即保存 API Key。证书签发需要域名已正确解析并开放 80/443 端口。\n'
if ((ENABLE_FIREWALL)); then
  printf 'SSH 白名单已启用，初始允许网段: %s，端口: %s\n' "$INITIAL_NETWORK" "$SSH_PORT"
else
  printf 'SSH 白名单未启用，可继续使用后台和 API。\n'
fi
