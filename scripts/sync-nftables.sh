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

snapshot="$(curl --fail --silent --show-error --max-time 10 \
  -H "Authorization: Bearer ${FIREWALL_SYNC_TOKEN}" \
  "${ALLOWLIST_URL}/api/internal/firewall-snapshot")"

printf '%s' "$snapshot" | jq -e '
  (.ipv4 | type == "array") and
  (.ipv6 | type == "array") and
  (all(.ipv4[]; type == "string")) and
  (all(.ipv6[]; type == "string"))
' >/dev/null

v4="$(printf '%s' "$snapshot" | jq -r '.ipv4 | join(", ")')"
v6="$(printf '%s' "$snapshot" | jq -r '.ipv6 | join(", ")')"
tmpfile="$(mktemp)"
trap 'rm -f "$tmpfile"' EXIT INT TERM

{
  printf 'flush set inet %s allowed_v4\n' "$NFT_TABLE"
  [ -z "$v4" ] || printf 'add element inet %s allowed_v4 { %s }\n' "$NFT_TABLE" "$v4"
  printf 'flush set inet %s allowed_v6\n' "$NFT_TABLE"
  [ -z "$v6" ] || printf 'add element inet %s allowed_v6 { %s }\n' "$NFT_TABLE" "$v6"
} > "$tmpfile"

nft -c -f "$tmpfile"
nft -f "$tmpfile"
echo "Gatekeeper firewall sets synchronized"
