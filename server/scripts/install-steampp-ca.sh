#!/bin/bash
# 把 Steam++ 根证书装进 WSL 的信任库，让 WSL 能走同一个加速通道
set -euo pipefail

CERT=/mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/.tools/steampp-root.cer

if [ ! -f "$CERT" ]; then
  echo "证书不存在：$CERT" >&2
  exit 1
fi

install -d /usr/local/share/ca-certificates
install -m 0644 "$CERT" /usr/local/share/ca-certificates/steampp-root.crt
update-ca-certificates 2>&1 | tail -3

echo "=== 连通性验证 ==="
curl -sS -o /dev/null -w "github.com                %{http_code}  %{time_total}s\n" --max-time 20 https://github.com
curl -sS -o /dev/null -w "raw.githubusercontent.com %{http_code}  %{time_total}s\n" --max-time 20 https://raw.githubusercontent.com
curl -sS -o /dev/null -w "objects.githubusercontent %{http_code}  %{time_total}s\n" --max-time 20 https://objects.githubusercontent.com
