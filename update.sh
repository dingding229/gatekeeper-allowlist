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

if [[ -f "$CONFIG_DIR/gatekeeper-sync.env" ]]; then
  info "升级 nftables 规则并同步网段与端口"
  # shellcheck disable=SC1090
  source "$CONFIG_DIR/gatekeeper-sync.env"
  SNAPSHOT="$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $FIREWALL_SYNC_TOKEN" \
    "${ALLOWLIST_URL:-http://127.0.0.1:8787}/api/internal/firewall-snapshot")"
  IPV4="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv4 | join(", ")')"
  IPV6="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv6 | join(", ")')"
  TCP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.tcpPorts | join(", ")')"
  UDP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.udpPorts | join(", ")')"

  install -d -m 0700 "$CONFIG_DIR"
  sed \
    -e "s|__INITIAL_IPV4__|$IPV4|g" \
    -e "s|__INITIAL_IPV6__|$IPV6|g" \
    -e "s|__INITIAL_TCP_PORTS__|$TCP_ELEMENTS|g" \
    -e "s|__INITIAL_UDP_PORTS__|$UDP_ELEMENTS|g" \
    deploy/nftables/gatekeeper.nft.template >"$CONFIG_DIR/gatekeeper.nft"
  nft -c -f "$CONFIG_DIR/gatekeeper.nft"
  install -m 0644 deploy/systemd/gatekeeper-firewall.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.service /etc/systemd/system/
  install -m 0644 deploy/systemd/gatekeeper-sync.timer /etc/systemd/system/
  systemctl daemon-reload
  systemctl restart gatekeeper-firewall.service
  systemctl start gatekeeper-sync.service
  systemctl enable --now gatekeeper-sync.timer
fi

DOMAIN="$(env_value DOMAIN)"
printf '\n%s更新完成%s\n' "$green" "$reset"
printf '后台地址: https://%s/%s/\n' "$DOMAIN" "$ADMIN_PATH"
printf 'TCP 保护端口: %s\n' "$TCP_PORTS"
printf 'UDP 保护端口: %s\n' "${UDP_PORTS:-无}"
