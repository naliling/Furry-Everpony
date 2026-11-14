#!/bin/bash
# 临时移除 hosts 里的加速器重定向，测试 WSL 能否直连 GitHub
set -uo pipefail

cp /etc/hosts /tmp/hosts.accelerated
grep -vE '^172\.17\.16\.1[[:space:]]' /etc/hosts > /tmp/hosts.direct
cat /tmp/hosts.direct > /etc/hosts

echo "=== 去掉重定向后的 DNS 解析 ==="
getent hosts github.com || echo "解析失败"
getent hosts objects.githubusercontent.com || echo "解析失败"

echo "=== 直连测试（5 秒超时）==="
curl -sS -o /dev/null -w "github.com  %{http_code}  %{time_total}s\n" --max-time 5 https://github.com || echo "github.com 直连失败"
curl -sS -o /dev/null -w "raw.githubusercontent  %{http_code}  %{time_total}s\n" --max-time 5 https://raw.githubusercontent.com || echo "raw 直连失败"

echo "=== 恢复加速器 hosts ==="
cat /tmp/hosts.accelerated > /etc/hosts
echo "已恢复"
