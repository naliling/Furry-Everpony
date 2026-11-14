#!/bin/bash
echo "=== resolv.conf ==="
cat /etc/resolv.conf
echo "=== 默认路由 ==="
ip route | head -3
echo "=== DNS 解析 ==="
getent hosts github.com || echo "github.com 解析失败"
getent hosts registry.npmjs.org || echo "registry.npmjs.org 解析失败"
echo "=== 连通性 ==="
curl -sS -o /dev/null -w "github.com      %{http_code}  %{time_total}s\n" --max-time 8 https://github.com || echo "github.com 连不上"
curl -sS -o /dev/null -w "registry.npmjs  %{http_code}  %{time_total}s\n" --max-time 8 https://registry.npmjs.org || echo "npm 连不上"
curl -sS -o /dev/null -w "archive.ubuntu  %{http_code}  %{time_total}s\n" --max-time 8 http://archive.ubuntu.com || echo "ubuntu 连不上"
curl -sS -o /dev/null -w "objects.githubusercontent %{http_code}  %{time_total}s\n" --max-time 8 https://objects.githubusercontent.com || echo "github objects 连不上"
echo "=== 代理环境变量 ==="
env | grep -iE '^(http|https|all|no)_proxy' || echo "无代理变量"
