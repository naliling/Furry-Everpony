#!/bin/bash
# 测试几个 GitHub 镜像是否可用（WSL 里不走加速器，直连这些域名）
set -uo pipefail

URL_PATH="https://github.com/element-hq/element-web/releases/download/v1.12.35/element-v1.12.35.tar.gz"

for m in \
  "https://ghfast.top/" \
  "https://gh-proxy.com/" \
  "https://ghproxy.net/" \
  "https://gh.llkk.cc/" \
  "https://github.moeyy.xyz/"
do
  code=$(curl -sS -o /dev/null -w "%{http_code}" -I -L --max-time 8 "${m}${URL_PATH}" 2>/dev/null || echo "ERR")
  printf "%-28s %s\n" "$m" "$code"
done

echo
echo "=== 官方直连对照（应失败）==="
curl -sS -o /dev/null -w "%{http_code}\n" -I --max-time 6 "$URL_PATH" 2>&1 | tail -1
