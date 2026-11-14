#!/bin/bash
# 装上 Steam++ 的两张同名根证书，再验证
set -uo pipefail

CERTDIR=/mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/.tools

install -d /usr/local/share/ca-certificates
for f in "$CERTDIR"/steampp-root*.cer; do
  [ -f "$f" ] || continue
  b="$(basename "$f" .cer)"
  install -m 0644 "$f" "/usr/local/share/ca-certificates/$b.crt"
  echo "装入 $b"
done

update-ca-certificates --fresh 2>&1 | tail -2

echo "=== 证书链校验 ==="
echo | timeout 15 openssl s_client -connect github.com:443 -servername github.com -showcerts 2>/dev/null > /tmp/chain.txt
awk '/BEGIN CERTIFICATE/,/END CERTIFICATE/' /tmp/chain.txt | awk 'BEGIN{n=0} /BEGIN/{n++} {print > ("/tmp/leaf" n ".pem")}'
for p in /tmp/leaf*.pem; do
  [ -f "$p" ] || continue
  echo "--- 校验 $p"
  openssl verify -CAfile /etc/ssl/certs/ca-certificates.crt "$p" 2>&1 | head -2
done

echo "=== curl 验证 ==="
curl -sS -o /dev/null -w "github.com  %{http_code}  %{time_total}s\n" --max-time 20 https://github.com
