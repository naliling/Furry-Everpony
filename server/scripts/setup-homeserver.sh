#!/usr/bin/env bash
# 在 WSL2 的 Ubuntu 里一键装好并启动 tuwunel homeserver（开发用，只听 127.0.0.1）
# 用法：bash /mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/server/scripts/setup-homeserver.sh
set -euo pipefail

DEB="/mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/.tools/tuwunel-v2.0.0-x86_64-v1.deb"
FE_HOME="${FE_HOME:-$HOME/fe}"
SERVER_NAME="${FE_SERVER_NAME:-localhost}"
PORT="${FE_PORT:-8008}"

# 以 root 跑时不需要 sudo；普通用户则需要
if [ "$(id -u)" -eq 0 ]; then
  SUDO=""
else
  SUDO="sudo"
fi

echo "==> 1/5 检查安装包"
if [ ! -f "$DEB" ]; then
  echo "找不到 $DEB" >&2
  exit 1
fi
ls -l "$DEB"

echo "==> 2/5 安装基础依赖"
$SUDO apt-get update -y
$SUDO apt-get install -y --no-install-recommends ca-certificates curl

echo "==> 3/5 安装 tuwunel"
if command -v tuwunel >/dev/null 2>&1; then
  echo "已安装，跳过"
else
  $SUDO dpkg -i "$DEB" || $SUDO apt-get install -f -y
fi
tuwunel --version

echo "==> 4/5 生成配置"
mkdir -p "$FE_HOME/data" "$FE_HOME/logs"
REG_TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)"
cat > "$FE_HOME/tuwunel.toml" <<EOF
[global]
server_name = "$SERVER_NAME"
database_path = "$FE_HOME/data"
address = ["127.0.0.1"]
port = $PORT

[global.authentication.login]
with_password = true

[global.registration]
enable = true
token = "$REG_TOKEN"
EOF
echo "--- $FE_HOME/tuwunel.toml ---"
cat "$FE_HOME/tuwunel.toml"
echo "--- 注册令牌（记下来，建号要用）: $REG_TOKEN ---"

echo "==> 5/5 启动"
if pgrep -f "tuwunel -c" >/dev/null 2>&1; then
  echo "已有 tuwunel 在跑，先停掉"
  pkill -f "tuwunel -c" || true
  sleep 2
fi
nohup tuwunel -c "$FE_HOME/tuwunel.toml" > "$FE_HOME/logs/tuwunel.log" 2>&1 &
sleep 6

echo "==> 验证"
if curl -sS --max-time 5 "http://127.0.0.1:$PORT/_matrix/client/versions" >/tmp/fe_versions.json 2>/dev/null; then
  echo "OK: /_matrix/client/versions 有响应"
  head -c 300 /tmp/fe_versions.json
  echo
else
  echo "失败：端口 $PORT 没响应，看日志" >&2
  tail -30 "$FE_HOME/logs/tuwunel.log" >&2
  exit 1
fi

echo "==> 完成"
echo "日志：tail -f $FE_HOME/logs/tuwunel.log"
echo "服务：http://127.0.0.1:$PORT"
