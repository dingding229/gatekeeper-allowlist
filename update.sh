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
  read -r -p "$message${default:+ [$default]}: " value <"$TTY"
  printf '%s' "${value:-$default}"
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

env_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$INSTALL_DIR/.env" | tail -n 1
}

set_env_value() {
  local key="$1" value="$2" temp_file
  temp_file="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { found = 0 }
    $0 ~ "^" key "=" { if (!found) print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$INSTALL_DIR/.env" >"$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$INSTALL_DIR/.env"
}

[[ $EUID -eq 0 ]] || fail "请使用 root 运行更新脚本"
[[ -r /etc/os-release ]] || fail "无法识别操作系统"
source /etc/os-release
[[ "${ID:-}" == "debian" && "${VERSION_ID:-}" == "12" ]] || fail "此脚本仅支持 Debian 12"
[[ -r "$TTY" ]] || fail "需要交互式 SSH 终端"
[[ -f "$INSTALL_DIR/.env" && -f "$INSTALL_DIR/compose.yaml" ]] || fail "未找到 $INSTALL_DIR 中的现有部署"
command -v docker >/dev/null 2>&1 || fail "未安装 Docker"
docker compose version >/dev/null 2>&1 || fail "未安装 Docker Compose 插件"

printf '\nGatekeeper Debian 12 一键更新\n\n'

CURRENT_ADMIN_PATH="$(env_value ADMIN_PATH)"
CURRENT_ADMIN_PATH="${CURRENT_ADMIN_PATH#/}"
DEFAULT_ADMIN_PATH="${CURRENT_ADMIN_PATH:-manage-$(openssl rand -hex 4)}"
while true; do
  ADMIN_PATH="$(prompt '后台访问路径' "$DEFAULT_ADMIN_PATH")"
  ADMIN_PATH="${ADMIN_PATH#/}"
  [[ "$ADMIN_PATH" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$ ]] && break
  warn "路径只能包含 3-64 位字母、数字、下划线和连字符"
done

ENABLE_FIREWALL=0
NEW_FIREWALL=0
if [[ -f "$CONFIG_DIR/gatekeeper-sync.env" ]]; then
  ENABLE_FIREWALL=1
else
  warn "当前未安装 Gatekeeper nftables 防火墙；后台端口设置不会自动产生拦截"
  if confirm "是否现在启用网段白名单防火墙？" y; then
    ENABLE_FIREWALL=1
    NEW_FIREWALL=1
  fi
fi

DETECTED_SSH_PORT="$(sshd -T 2>/dev/null | awk '$1 == "port" { print $2; exit }' || true)"
while true; do
  TCP_PORTS="$(prompt '受白名单保护的 TCP 端口（逗号分隔，支持 8000-9000）' "${DETECTED_SSH_PORT:-22}")"
  [[ "$TCP_PORTS" =~ ^[0-9,[:space:]-]+$ ]] && break
  warn "请输入端口或范围，例如 22,443,8000-9000"
done
while true; do
  UDP_PORTS="$(prompt '受白名单保护的 UDP 端口（留空表示无）' '')"
  [[ -z "$UDP_PORTS" || "$UDP_PORTS" =~ ^[0-9,[:space:]-]+$ ]] && break
  warn "请输入端口或范围，例如 53,6000-7000"
done

info "下载最新源码"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL "https://github.com/$REPOSITORY/archive/refs/heads/$BRANCH.tar.gz" \
  | tar -xz -C "$TEMP_DIR" --strip-components=1

info "更新程序文件（保留数据库、证书和 .env）"
cp -a "$TEMP_DIR/." "$INSTALL_DIR/"
set_env_value ADMIN_PATH "/$ADMIN_PATH"
chmod 755 "$INSTALL_DIR/scripts/sync-nftables.sh"
cd "$INSTALL_DIR"

info "重新构建并启动服务"
docker compose up -d --build
for _ in $(seq 1 60); do
  curl -fsS http://127.0.0.1:8787/health >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS http://127.0.0.1:8787/health >/dev/null || {
  docker compose logs --tail=100
  fail "Gatekeeper 启动失败"
}

info "保存受保护端口范围"
docker compose exec -T gatekeeper node src/cli.js set-firewall "$TCP_PORTS" "$UDP_PORTS" >/dev/null

if ((ENABLE_FIREWALL)); then
  info "升级 nftables 规则并同步网段与端口"
  if ((NEW_FIREWALL)); then
    FIREWALL_SYNC_TOKEN="$(env_value FIREWALL_SYNC_TOKEN)"
    [[ ${#FIREWALL_SYNC_TOKEN} -ge 24 ]] || fail "现有 .env 缺少有效的 FIREWALL_SYNC_TOKEN"
    ALLOWLIST_URL="http://127.0.0.1:8787"
  else
    # shellcheck disable=SC1090
    source "$CONFIG_DIR/gatekeeper-sync.env"
  fi
  SNAPSHOT="$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $FIREWALL_SYNC_TOKEN" \
    "${ALLOWLIST_URL:-http://127.0.0.1:8787}/api/internal/firewall-snapshot")"
  IPV4="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv4 | join(", ")')"
  IPV6="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv6 | join(", ")')"
  TCP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.tcpPorts | join(", ")')"
  UDP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.udpPorts | join(", ")')"

  SSH_CONNECTION_VALUE="${SSH_CONNECTION:-}"
  CURRENT_IP="${SSH_CONNECTION_VALUE%% *}"
  while true; do
    CURRENT_IP="$(prompt '当前 SSH 客户端 IP（启用防火墙前安全校验）' "$CURRENT_IP")"
    python3 -c 'import ipaddress,sys; ipaddress.ip_address(sys.argv[1])' "$CURRENT_IP" 2>/dev/null && break
    warn "IP 地址格式不正确"
  done
  CURRENT_NETWORK_JSON="$(docker compose exec -T gatekeeper node src/cli.js normalize-network "$CURRENT_IP")"
  CURRENT_NETWORK="$(printf '%s' "$CURRENT_NETWORK_JSON" | jq -er .network)"
  CURRENT_FAMILY="$(printf '%s' "$CURRENT_NETWORK_JSON" | jq -er .family)"
  if [[ "$CURRENT_FAMILY" == "4" ]]; then
    CURRENT_ALLOWED="$(printf '%s' "$SNAPSHOT" | jq -r --arg network "$CURRENT_NETWORK" '.ipv4 | index($network) != null')"
  else
    CURRENT_ALLOWED="$(printf '%s' "$SNAPSHOT" | jq -r --arg network "$CURRENT_NETWORK" '.ipv6 | index($network) != null')"
  fi
  if [[ "$CURRENT_ALLOWED" != "true" ]]; then
    fail "当前 SSH 网段 $CURRENT_NETWORK 不在白名单中。请先用 API Key 上报当前 IP，再重新运行更新脚本"
  fi

  install -d -m 0700 "$CONFIG_DIR"
  sed \
    -e "s|__INITIAL_IPV4__|$IPV4|g" \
    -e "s|__INITIAL_IPV6__|$IPV6|g" \
    -e "s|__INITIAL_TCP_PORTS__|$TCP_ELEMENTS|g" \
    -e "s|__INITIAL_UDP_PORTS__|$UDP_ELEMENTS|g" \
    deploy/nftables/gatekeeper.nft.template >"$CONFIG_DIR/gatekeeper.nft"
  nft -c -f "$CONFIG_DIR/gatekeeper.nft"
  if ((NEW_FIREWALL)); then
    cat >"$CONFIG_DIR/gatekeeper-sync.env" <<EOF
ALLOWLIST_URL=http://127.0.0.1:8787
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
NFT_TABLE=gatekeeper
EOF
    chmod 600 "$CONFIG_DIR/gatekeeper-sync.env"
  fi
  install -m 0644 deploy/systemd/gatekeeper-firewall.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl enable --now gatekeeper-firewall.service
  systemctl start gatekeeper-sync.service
  systemctl enable --now gatekeeper-sync.timer
fi

DOMAIN="$(env_value DOMAIN)"
printf '\n%s更新完成%s\n' "$green" "$reset"
printf '后台地址: https://%s/%s/\n' "$DOMAIN" "$ADMIN_PATH"
printf 'TCP 保护端口: %s\n' "$TCP_PORTS"
printf 'UDP 保护端口: %s\n' "${UDP_PORTS:-无}"
if ((!ENABLE_FIREWALL)); then
  warn "nftables 防火墙仍未启用，以上端口设置暂时不会拦截流量"
fi
