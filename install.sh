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

[[ $EUID -eq 0 ]] || fail "请使用 root 运行：curl -fsSL https://raw.githubusercontent.com/$REPOSITORY/$BRANCH/install.sh | sudo bash"
[[ -r /etc/os-release ]] || fail "无法识别操作系统"
source /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "12" ]] || fail "此脚本仅支持 Debian 12"
[[ -r "$TTY" ]] || fail "需要交互式 SSH 终端"

printf '\nGatekeeper Debian 12 一键部署\n\n'

info "安装基础依赖"
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl gnupg jq nftables openssl python3 tar

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

while true; do
  ADMIN_PASSWORD="$(prompt_secret '后台管理员密码（至少 12 位）')"
  ADMIN_PASSWORD_CONFIRM="$(prompt_secret '再次输入管理员密码')"
  if [[ ${#ADMIN_PASSWORD} -lt 12 ]]; then
    warn "密码至少需要 12 位"
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
if confirm "是否立即启用 SSH IP 白名单保护？" y; then ENABLE_FIREWALL=1; fi

if [[ -e "$INSTALL_DIR/.env" ]]; then
  fail "$INSTALL_DIR 已存在部署。为保护数据，本脚本不会覆盖现有安装"
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
  curl -fsSL "https://github.com/$REPOSITORY/archive/refs/heads/$BRANCH.tar.gz" \
    | tar -xz -C "$TEMP_DIR" --strip-components=1
  SOURCE_DIR="$TEMP_DIR"
fi

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
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
TRUST_PROXY=1
COOKIE_SECURE=1
EOF
chmod 600 .env
chmod 755 scripts/sync-nftables.sh

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
BOOTSTRAP_JSON="$(docker compose exec -T gatekeeper node src/cli.js bootstrap "$INITIAL_USER" "$INITIAL_IP")"
INITIAL_API_KEY="$(printf '%s' "$BOOTSTRAP_JSON" | jq -er .apiKey)"

if ((ENABLE_FIREWALL)); then
  info "配置 nftables SSH 白名单"
  install -d -m 0700 "$CONFIG_DIR"
  if [[ "$INITIAL_IP" == *:* ]]; then
    INITIAL_IPV4=""
    INITIAL_IPV6="$INITIAL_IP"
  else
    INITIAL_IPV4="$INITIAL_IP"
    INITIAL_IPV6=""
  fi
  sed \
    -e "s|__SSH_PORT__|$SSH_PORT|g" \
    -e "s|__INITIAL_IPV4__|$INITIAL_IPV4|g" \
    -e "s|__INITIAL_IPV6__|$INITIAL_IPV6|g" \
    deploy/nftables/gatekeeper.nft.template >"$CONFIG_DIR/gatekeeper.nft"
  nft -c -f "$CONFIG_DIR/gatekeeper.nft"

  cat >"$CONFIG_DIR/gatekeeper-sync.env" <<EOF
ALLOWLIST_URL=http://127.0.0.1:8787
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
NFT_TABLE=gatekeeper
EOF
  chmod 600 "$CONFIG_DIR/gatekeeper-sync.env"
  install -m 0644 deploy/systemd/gatekeeper-firewall.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now gatekeeper-firewall.service
  systemctl start gatekeeper-sync.service
  systemctl enable --now gatekeeper-sync.timer
fi

printf '\n%s部署完成%s\n' "$green" "$reset"
printf '后台地址: https://%s\n' "$DOMAIN"
printf '管理员账号: %s\n' "$ADMIN_USERNAME"
printf '初始用户: %s\n' "$INITIAL_USER"
printf '初始 API Key（仅显示这一次）: %s\n' "$INITIAL_API_KEY"
printf '\n请立即保存 API Key。证书签发需要域名已正确解析并开放 80/443 端口。\n'
if ((ENABLE_FIREWALL)); then
  printf 'SSH 白名单已启用，初始允许地址: %s，端口: %s\n' "$INITIAL_IP" "$SSH_PORT"
else
  printf 'SSH 白名单未启用，可继续使用后台和 API。\n'
fi
