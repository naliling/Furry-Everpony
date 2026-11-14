#!/bin/bash
echo "=== 1. tuwunel 二进制 ==="
command -v tuwunel || echo "未找到"
tuwunel --version 2>&1 | head -3
echo
echo "=== 2. 配置文件 ==="
cat /root/fe/tuwunel.toml 2>/dev/null || echo "配置不存在"
echo
echo "=== 3. 进程 ==="
pgrep -af tuwunel || echo "没有 tuwunel 进程"
echo
echo "=== 4. 端口 8008 ==="
ss -lntp 2>/dev/null | grep -E ':8008' || echo "8008 没在监听"
echo
echo "=== 5. HTTP 探活 ==="
curl -sS --max-time 6 http://127.0.0.1:8008/_matrix/client/versions 2>&1 | head -c 400
echo
echo "=== 6. 日志尾部 ==="
tail -25 /root/fe/logs/tuwunel.log 2>/dev/null || echo "日志不存在"
