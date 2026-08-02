#!/bin/sh
set -eu

if [ "$#" -ne 5 ]; then
  echo "Usage: render-nftables.sh <template> <ipv4> <ipv6> <tcp-ports> <udp-ports>" >&2
  exit 1
fi

template="$1"
ipv4="$2"
ipv6="$3"
tcp_ports="$4"
udp_ports="$5"

elements() {
  [ -z "$1" ] || printf 'elements = { %s };' "$1"
}

ipv4_elements="$(elements "$ipv4")"
ipv6_elements="$(elements "$ipv6")"
tcp_elements="$(elements "$tcp_ports")"
udp_elements="$(elements "$udp_ports")"

sed \
  -e "s|__INITIAL_IPV4_ELEMENTS__|$ipv4_elements|g" \
  -e "s|__INITIAL_IPV6_ELEMENTS__|$ipv6_elements|g" \
  -e "s|__INITIAL_TCP_PORT_ELEMENTS__|$tcp_elements|g" \
  -e "s|__INITIAL_UDP_PORT_ELEMENTS__|$udp_elements|g" \
  "$template"
