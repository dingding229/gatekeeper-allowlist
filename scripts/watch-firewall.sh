#!/bin/sh
set -eu

: "${ALLOWLIST_URL:=http://127.0.0.1:8787}"
: "${FIREWALL_SYNC_TOKEN:?FIREWALL_SYNC_TOKEN is required}"

command -v curl >/dev/null 2>&1 || { echo "curl is required" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "jq is required" >&2; exit 1; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
revision=""

while :; do
  response=$(curl --fail --silent --show-error --max-time 35 \
    -H "Authorization: Bearer ${FIREWALL_SYNC_TOKEN}" \
    "${ALLOWLIST_URL}/api/internal/firewall-revision?since=${revision}" 2>/dev/null) || {
      sleep 2
      continue
    }
  next_revision=$(printf '%s' "$response" | jq -er '.revision | numbers' 2>/dev/null) || {
    sleep 2
    continue
  }
  if [ "$next_revision" != "$revision" ]; then
    "$script_dir/sync-nftables.sh"
    revision="$next_revision"
  fi
done
