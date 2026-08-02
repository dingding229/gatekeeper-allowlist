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

validate_port_ranges() {
  python3 - "$1" <<'PY'
import re, sys
value = sys.argv[1].strip()
if not value:
    raise SystemExit(0)
for token in re.split(r"[,，\s]+", value):
    if not token:
        continue
    match = re.fullmatch(r"(\d{1,5})(?:-(\d{1,5}))?", token)
    if not match:
        raise SystemExit(1)
    start = int(match.group(1))
    end = int(match.group(2) or start)
    if start < 1 or end > 65535 or start > end:
        raise SystemExit(1)
PY
}

port_is_covered() {
  python3 - "$1" "$2" <<'PY'
import re, sys
port = int(sys.argv[1])
for token in re.split(r"[,，\s]+", sys.argv[2].strip()):
    if not token:
        continue
    values = token.split("-", 1)
    start = int(values[0])
    end = int(values[-1])
    if start <= port <= end:
        raise SystemExit(0)
raise SystemExit(1)
PY
}

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
[[ "$INSTALL_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || fail "安装目录只能使用绝对路径及字母、数字、点、下划线、斜杠和连字符"
case "$INSTALL_DIR" in
  / | /opt | /usr | /etc | /var | /home | /root | /tmp | *"/../"* | *"/.." | *"/./"*)
    fail "安装目录范围过大或包含不安全路径：$INSTALL_DIR"
    ;;
esac
command -v docker >/dev/null 2>&1 || fail "未安装 Docker"
docker compose version >/dev/null 2>&1 || fail "未安装 Docker Compose 插件"
command -v nft >/dev/null 2>&1 || fail "未安装 nftables"
command -v jq >/dev/null 2>&1 || fail "未安装 jq"
command -v python3 >/dev/null 2>&1 || fail "未安装 python3"
if ! command -v flock >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y util-linux
fi

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
DEFAULT_TCP_PORTS="${DETECTED_SSH_PORT:-22}"
DEFAULT_UDP_PORTS=""
EXISTING_TOKEN="$(env_value FIREWALL_SYNC_TOKEN)"
if [[ ${#EXISTING_TOKEN} -ge 24 ]]; then
  EXISTING_SNAPSHOT="$(curl -fsS --max-time 5 \
    -H "Authorization: Bearer $EXISTING_TOKEN" \
    http://127.0.0.1:8787/api/internal/firewall-snapshot 2>/dev/null || true)"
  if printf '%s' "$EXISTING_SNAPSHOT" | jq -e '.tcpPorts and .udpPorts' >/dev/null 2>&1; then
    DEFAULT_TCP_PORTS="$(printf '%s' "$EXISTING_SNAPSHOT" | jq -r '.tcpPorts | join(",")')"
    DEFAULT_UDP_PORTS="$(printf '%s' "$EXISTING_SNAPSHOT" | jq -r '.udpPorts | join(",")')"
  fi
fi
while true; do
  TCP_PORTS="$(prompt '受白名单保护的 TCP 端口（输入 none 清空）' "${DEFAULT_TCP_PORTS:-无}")"
  [[ "${TCP_PORTS,,}" == "none" || "$TCP_PORTS" == "无" ]] && TCP_PORTS=""
  if ! validate_port_ranges "$TCP_PORTS"; then
    warn "端口范围无效，例如 22,443,8000-9000"
    continue
  fi
  PORTS_CONFIRMED=1
  if ((ENABLE_FIREWALL)) && ! port_is_covered "${DETECTED_SSH_PORT:-22}" "$TCP_PORTS"; then
    warn "SSH 端口 ${DETECTED_SSH_PORT:-22} 不在 TCP 保护范围中，将可被任意来源访问"
    confirm "确认继续？" n || PORTS_CONFIRMED=0
  fi
  for public_port in 80 443; do
    if port_is_covered "$public_port" "$TCP_PORTS"; then
      warn "TCP $public_port 被加入保护范围，未加白设备将无法访问后台和 API"
      confirm "确认仍要保护 TCP $public_port？" n || PORTS_CONFIRMED=0
    fi
  done
  ((PORTS_CONFIRMED)) && break
  warn "请重新填写 TCP 保护范围"
done
while true; do
  UDP_PORTS="$(prompt '受白名单保护的 UDP 端口（输入 none 清空）' "${DEFAULT_UDP_PORTS:-无}")"
  [[ "${UDP_PORTS,,}" == "none" || "$UDP_PORTS" == "无" ]] && UDP_PORTS=""
  validate_port_ranges "$UDP_PORTS" && break
  warn "端口范围无效，例如 53,6000-7000"
done

info "下载最新源码"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT
curl --retry 3 --retry-delay 2 -fsSL "https://github.com/$REPOSITORY/archive/refs/heads/$BRANCH.tar.gz" \
  | tar -xz -C "$TEMP_DIR" --strip-components=1
[[ -x "$TEMP_DIR/scripts/render-nftables.sh" \
  && -x "$TEMP_DIR/scripts/install-nftables-config.sh" \
  && -x "$TEMP_DIR/scripts/firewall-doctor.sh" \
  && -x "$TEMP_DIR/scripts/watch-firewall.sh" \
  && -f "$TEMP_DIR/deploy/systemd/gatekeeper-sync-listener.service" \
  && -f "$TEMP_DIR/deploy/nftables/gatekeeper.nft.template" ]] \
  || fail "下载的源码不完整"

info "更新程序文件（保留数据库、证书和 .env）"
cp -a "$TEMP_DIR/." "$INSTALL_DIR/"
set_env_value ADMIN_PATH "/$ADMIN_PATH"
chmod 755 "$INSTALL_DIR/scripts/"*.sh
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

if ((ENABLE_FIREWALL)); then
  if ((NEW_FIREWALL)); then
    FIREWALL_SYNC_TOKEN="$(env_value FIREWALL_SYNC_TOKEN)"
    ALLOWLIST_URL="http://127.0.0.1:8787"
  else
    # shellcheck disable=SC1090
    source "$CONFIG_DIR/gatekeeper-sync.env"
  fi
  FIREWALL_SYNC_TOKEN="${FIREWALL_SYNC_TOKEN:-}"
  ALLOWLIST_URL="${ALLOWLIST_URL:-http://127.0.0.1:8787}"
  [[ ${#FIREWALL_SYNC_TOKEN} -ge 24 ]] || fail "缺少有效的 FIREWALL_SYNC_TOKEN"
  SAFETY_SNAPSHOT="$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $FIREWALL_SYNC_TOKEN" \
    "$ALLOWLIST_URL/api/internal/firewall-snapshot")"

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
    CURRENT_ALLOWED="$(printf '%s' "$SAFETY_SNAPSHOT" | jq -r --arg network "$CURRENT_NETWORK" '.ipv4 | index($network) != null')"
  else
    CURRENT_ALLOWED="$(printf '%s' "$SAFETY_SNAPSHOT" | jq -r --arg network "$CURRENT_NETWORK" '.ipv6 | index($network) != null')"
  fi
  if [[ "$CURRENT_ALLOWED" != "true" ]]; then
    fail "当前 SSH 网段 $CURRENT_NETWORK 不在白名单中。请先用 API Key 上报当前 IP，再重新运行更新脚本"
  fi
fi

info "保存受保护端口范围"
docker compose exec -T gatekeeper node src/cli.js set-firewall "$TCP_PORTS" "$UDP_PORTS" >/dev/null

if ((ENABLE_FIREWALL)); then
  info "升级 nftables 规则并同步网段与端口"
  SNAPSHOT="$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $FIREWALL_SYNC_TOKEN" \
    "$ALLOWLIST_URL/api/internal/firewall-snapshot")"
  IPV4="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv4 | join(", ")')"
  IPV6="$(printf '%s' "$SNAPSHOT" | jq -er '.ipv6 | join(", ")')"
  TCP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.tcpPorts | join(", ")')"
  UDP_ELEMENTS="$(printf '%s' "$SNAPSHOT" | jq -er '.udpPorts | join(", ")')"

  scripts/install-nftables-config.sh \
    deploy/nftables/gatekeeper.nft.template \
    "$CONFIG_DIR/gatekeeper.nft" \
    "$IPV4" "$IPV6" "$TCP_ELEMENTS" "$UDP_ELEMENTS"
  if ((NEW_FIREWALL)); then
    cat >"$CONFIG_DIR/gatekeeper-sync.env" <<EOF
ALLOWLIST_URL=http://127.0.0.1:8787
FIREWALL_SYNC_TOKEN=$FIREWALL_SYNC_TOKEN
NFT_TABLE=gatekeeper
EOF
    chmod 600 "$CONFIG_DIR/gatekeeper-sync.env"
  fi
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

DOMAIN="$(env_value DOMAIN)"
printf '\n%b更新完成%b\n' "$green" "$reset"
printf '后台地址: https://%s/%s/\n' "$DOMAIN" "$ADMIN_PATH"
printf 'TCP 保护端口: %s\n' "$TCP_PORTS"
printf 'UDP 保护端口: %s\n' "${UDP_PORTS:-无}"
if ((!ENABLE_FIREWALL)); then
  warn "nftables 防火墙仍未启用，以上端口设置暂时不会拦截流量"
fi
