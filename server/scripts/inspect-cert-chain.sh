#!/bin/bash
# 看加速器实际下发的证书链，确认该信任哪张根证书
set -uo pipefail

echo "=== 服务器实际下发的证书 ==="
echo | timeout 15 openssl s_client -connect github.com:443 -servername github.com -showcerts 2>/dev/null \
  | openssl x509 -noout -subject -issuer -fingerprint -sha1 2>/dev/null || echo "取不到"

echo
echo "=== 完整链 ==="
echo | timeout 15 openssl s_client -connect github.com:443 -servername github.com -showcerts 2>/dev/null \
  | grep -E "^ *[0-9]+ s:|^ *i:" | head -10

echo
echo "=== 本机已装的自签根 ==="
for f in /usr/local/share/ca-certificates/*.crt; do
  [ -f "$f" ] || continue
  echo "--- $f"
  openssl x509 -in "$f" -noout -subject -fingerprint -sha1 2>/dev/null
done
