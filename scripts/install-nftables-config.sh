#!/bin/sh
set -eu

if [ "$#" -ne 6 ]; then
  echo "Usage: install-nftables-config.sh <template> <output> <ipv4> <ipv6> <tcp-ports> <udp-ports>" >&2
  exit 1
fi

template="$1"
output="$2"
ipv4="$3"
ipv6="$4"
tcp_ports="$5"
udp_ports="$6"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
output_dir="$(dirname -- "$output")"

command -v nft >/dev/null 2>&1 || {
  echo "nft is required" >&2
  exit 1
}

install -d -m 0700 "$output_dir"
temporary="$(mktemp "$output_dir/.gatekeeper.nft.XXXXXX")"
trap 'rm -f "$temporary"' EXIT INT TERM

"$script_dir/render-nftables.sh" \
  "$template" "$ipv4" "$ipv6" "$tcp_ports" "$udp_ports" \
  >"$temporary"
nft -c -f "$temporary"
chmod 0600 "$temporary"
mv "$temporary" "$output"
trap - EXIT INT TERM
