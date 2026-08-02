#!/bin/sh
set -u

CONFIG_DIR="${GATEKEEPER_CONFIG_DIR:-/etc/gatekeeper}"
failed=0

check_unit() {
  label="$1"
  unit="$2"
  state="$(systemctl is-active "$unit" 2>/dev/null || true)"
  printf '%-28s %s\n' "$label" "${state:-unknown}"
  [ "$state" = "active" ] || failed=1
}

printf 'Gatekeeper 防火墙诊断\n\n'
check_unit "防火墙服务" gatekeeper-firewall.service
check_unit "即时同步服务" gatekeeper-sync-listener.service
check_unit "同步定时器" gatekeeper-sync.timer

enabled="$(systemctl is-enabled gatekeeper-firewall.service 2>/dev/null || true)"
printf '%-28s %s\n' "防火墙开机启动" "${enabled:-unknown}"
[ "$enabled" = "enabled" ] || failed=1

if nft list table inet gatekeeper >/dev/null 2>&1; then
  printf '%-28s %s\n' "nftables 规则表" "存在"
else
  printf '%-28s %s\n' "nftables 规则表" "缺失"
  failed=1
fi

if [ -r "$CONFIG_DIR/gatekeeper-sync.env" ]; then
  # shellcheck disable=SC1090
  . "$CONFIG_DIR/gatekeeper-sync.env"
  token="${FIREWALL_SYNC_TOKEN:-}"
  if [ "${#token}" -lt 24 ]; then
    snapshot=""
  else
    snapshot="$(curl -fsS --max-time 10 \
      -H "Authorization: Bearer $FIREWALL_SYNC_TOKEN" \
      "${ALLOWLIST_URL:-http://127.0.0.1:8787}/api/internal/firewall-snapshot" 2>/dev/null || true)"
  fi
  if printf '%s' "$snapshot" | jq -e '.ipv4 and .ipv6 and .tcpPorts and .udpPorts' >/dev/null 2>&1; then
    printf '%-28s %s\n' "内部快照接口" "正常"
    printf 'IPv4 网段: %s\n' "$(printf '%s' "$snapshot" | jq -r '.ipv4 | join(", ") | if length == 0 then "无" else . end')"
    printf 'IPv6 网段: %s\n' "$(printf '%s' "$snapshot" | jq -r '.ipv6 | join(", ") | if length == 0 then "无" else . end')"
    printf 'TCP 保护端口: %s\n' "$(printf '%s' "$snapshot" | jq -r '.tcpPorts | join(", ") | if length == 0 then "无" else . end')"
    printf 'UDP 保护端口: %s\n' "$(printf '%s' "$snapshot" | jq -r '.udpPorts | join(", ") | if length == 0 then "无" else . end')"
  else
    printf '%-28s %s\n' "内部快照接口" "失败"
    failed=1
  fi
else
  printf '%-28s %s\n' "同步配置" "缺失"
  failed=1
fi

printf '\n'
if [ "$failed" -eq 0 ]; then
  echo "结论：防火墙运行正常"
else
  echo "结论：防火墙存在异常，请查看："
  echo "  journalctl -u gatekeeper-firewall.service -u gatekeeper-sync-listener.service -u gatekeeper-sync.service -n 80 --no-pager"
fi
exit "$failed"
