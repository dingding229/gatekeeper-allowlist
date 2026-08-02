#!/bin/sh
set -eu

: "${ALLOWLIST_URL:=http://127.0.0.1:8787}"
: "${FIREWALL_SYNC_TOKEN:?FIREWALL_SYNC_TOKEN is required}"
: "${NFT_TABLE:=gatekeeper}"

case "$NFT_TABLE" in
  *[!A-Za-z0-9_]*)
    echo "NFT_TABLE may contain only letters, numbers, and underscores" >&2
    exit 1
    ;;
esac

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }
command -v nft >/dev/null 2>&1 || { echo "nft is required" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "flock is required" >&2; exit 1; }

exec 9>/run/gatekeeper-sync.lock
flock -w 15 9 || { echo "another firewall sync is still running" >&2; exit 1; }

snapshot="$(curl --fail --silent --show-error --max-time 10 \
  -H "Authorization: Bearer ${FIREWALL_SYNC_TOKEN}" \
  "${ALLOWLIST_URL}/api/internal/firewall-snapshot")"

printf '%s' "$snapshot" | jq -e '
  (.ipv4 | type == "array") and
  (.ipv6 | type == "array") and
  (.tcpPorts | type == "array") and
  (.udpPorts | type == "array") and
  (all(.ipv4[]; type == "string")) and
  (all(.ipv6[]; type == "string")) and
  (all(.tcpPorts[]; type == "string")) and
  (all(.udpPorts[]; type == "string"))
' >/dev/null

v4="$(printf '%s' "$snapshot" | jq -r '.ipv4 | join(", ")')"
v6="$(printf '%s' "$snapshot" | jq -r '.ipv6 | join(", ")')"
tcp_ports="$(printf '%s' "$snapshot" | jq -r '.tcpPorts | join(", ")')"
udp_ports="$(printf '%s' "$snapshot" | jq -r '.udpPorts | join(", ")')"
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT INT TERM

{
  printf 'flush set inet %s allowed_v4\n' "$NFT_TABLE"
  [ -z "$v4" ] || printf 'add element inet %s allowed_v4 { %s }\n' "$NFT_TABLE" "$v4"
  printf 'flush set inet %s allowed_v6\n' "$NFT_TABLE"
  [ -z "$v6" ] || printf 'add element inet %s allowed_v6 { %s }\n' "$NFT_TABLE" "$v6"
  printf 'flush set inet %s protected_tcp_ports\n' "$NFT_TABLE"
  [ -z "$tcp_ports" ] || printf 'add element inet %s protected_tcp_ports { %s }\n' "$NFT_TABLE" "$tcp_ports"
  printf 'flush set inet %s protected_udp_ports\n' "$NFT_TABLE"
  [ -z "$udp_ports" ] || printf 'add element inet %s protected_udp_ports { %s }\n' "$NFT_TABLE" "$udp_ports"
} > "$tmpfile"

nft -c -f "$tmpfile"
nft -f "$tmpfile"
echo "Gatekeeper firewall sets synchronized"
