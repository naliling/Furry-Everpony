#!/usr/bin/env bash
# 在 WSL2 的 Ubuntu 里安装 tuwunel homeserver
# 用法：bash /mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/server/scripts/install-tuwunel.sh
set -euo pipefail

DEB="/mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/.tools/tuwunel-v2.0.0-x86_64-v1.deb"

echo "==> 检查安装包"
if [ ! -f "$DEB" ]; then
  echo "找不到 $DEB" >&2
  exit 1
fi
ls -l "$DEB"

echo "==> 更新 apt 索引"
sudo apt-get update -y

echo "==> 安装基础依赖"
sudo apt-get install -y --no-install-recommends ca-certificates

echo "==> 安装 tuwunel"
sudo dpkg -i "$DEB" || sudo apt-get install -f -y

echo "==> 验证二进制"
command -v tuwunel || { echo "tuwunel 不在 PATH 里" >&2; exit 1; }
tuwunel --version || true

echo "==> 包内文件"
dpkg -L tuwunel 2>/dev/null | grep -E 'bin/|systemd|\.toml' || true

echo "==> 完成"
