#!/bin/sh
set -eu

# Root runs ONLY this immutable bootstrap, before any application code. Never
# source .env or a file from APP_DATA_DIR here. A failed rule install aborts boot.
proxy_ip=${NOAH_EGRESS_PROXY_IP:-172.30.247.2}
case "$proxy_ip" in
  ''|*[!0-9.]*) echo 'NOAH_EGRESS_PROXY_IP must be an IPv4 address' >&2; exit 1 ;;
esac

# Replace our namespace's OUTPUT policy atomically on every boot. INPUT stays
# available for published app ports; replies are allowed by conntrack below.
# DNS is rejected even on Docker's embedded loopback resolver (127.0.0.11).
# Only the proxy resolves destination names. No NET_RAW or NET_ADMIN survives
# into Noah, so raw sockets, alternate DNS and direct IP connections cannot
# bypass this boundary.
iptables-restore <<EOF
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -p udp --dport 53 -j REJECT
-A OUTPUT -p tcp --dport 53 -j REJECT
-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -d 127.0.0.1/32 -o lo -j ACCEPT
-A OUTPUT -d $proxy_ip/32 -p tcp --dport 3128 -j ACCEPT
-A OUTPUT -d $proxy_ip/32 -p tcp --dport 3129 -j ACCEPT
COMMIT
EOF
ip6tables-restore <<'EOF'
*filter
:INPUT ACCEPT [0:0]
:FORWARD DROP [0:0]
:OUTPUT DROP [0:0]
-A OUTPUT -p udp --dport 53 -j REJECT
-A OUTPUT -p tcp --dport 53 -j REJECT
-A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
-A OUTPUT -d ::1/128 -o lo -j ACCEPT
COMMIT
EOF

# Overwrite inherited corporate proxy / NO_PROXY settings. The proxy itself can
# use a corporate parent; the app must never connect to that parent directly.
export HTTP_PROXY="http://$proxy_ip:3128" HTTPS_PROXY="http://$proxy_ip:3128"
export http_proxy="$HTTP_PROXY" https_proxy="$HTTPS_PROXY"
export ALL_PROXY="$HTTP_PROXY" all_proxy="$HTTP_PROXY"
export NO_PROXY='localhost,127.0.0.1,::1' no_proxy='localhost,127.0.0.1,::1'
# Node 22's global fetch doesn't automatically use HTTP_PROXY. Load before app
# modules and inherit into Node subprocesses. This is routing, NOT enforcement.
export NODE_OPTIONS='--require=/usr/local/lib/noah-proxy-bootstrap.cjs'
export NOAH_EGRESS_POLICY=domain-proxy
export NOAH_EGRESS_CONTROL_URL="http://$proxy_ip:3129"

exec setpriv --reuid=node --regid=node --init-groups \
  --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs "$@"
