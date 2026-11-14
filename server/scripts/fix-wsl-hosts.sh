#!/bin/bash
# 把 /etc/hosts 里被 Steam++ 重定向到 127.0.0.1 的域名改指到 Windows 宿主网关
# 原因：Steam++ 在 Windows 的 0.0.0.0:443 上做 TLS 加速，WSL 里的 127.0.0.1 不是 Windows 宿主
set -euo pipefail

GW="$(ip route show default | awk '{print $3; exit}')"
if [ -z "$GW" ]; then
  echo "拿不到默认网关" >&2
  exit 1
fi

TMP="$(mktemp)"
awk -v gw="$GW" '
  /^127\.0\.0\.1[[:space:]]/ {
    n = split($0, a, /[[:space:]]+/)
    if (a[2] == "localhost") { print; next }
    line = gw
    for (i = 2; i <= n; i++) if (a[i] != "") line = line " " a[i]
    print line
    next
  }
  { print }
' /etc/hosts > "$TMP"
cat "$TMP" > /etc/hosts
rm -f "$TMP"

echo "已把 127.0.0.1 的域名改指到 $GW"
grep -E "github|huggingface" /etc/hosts | head -8
