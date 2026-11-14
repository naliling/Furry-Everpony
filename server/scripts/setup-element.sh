#!/bin/bash
# 下载并部署 Element Web（走 gh-proxy 镜像），静态服务起在 8080
set -euo pipefail

FE=/root/fe
VER=v1.12.35
PKG="element-${VER}.tar.gz"
LOCAL="/mnt/c/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony/.tools/${PKG}"
GH="https://github.com/element-hq/element-web/releases/download/${VER}/${PKG}"

mkdir -p "$FE"

# 1. 取包：本地有完整副本就直接用，否则走镜像
if [ -f "$LOCAL" ] && [ "$(stat -c%s "$LOCAL")" -gt 20000000 ]; then
  echo "[1/4] 使用 Windows 侧已下载的包"
  cp -f "$LOCAL" "$FE/$PKG"
else
  echo "[1/4] 从镜像下载"
  ok=0
  for m in "https://gh-proxy.com/$GH" "https://ghproxy.net/$GH"; do
    echo "  -> $m"
    if curl -L --fail --retry 2 --max-time 600 -C - -o "$FE/$PKG" "$m"; then
      ok=1
      break
    fi
  done
  [ "$ok" -eq 1 ] || { echo "所有镜像都失败" >&2; exit 1; }
fi
ls -l "$FE/$PKG"

# 2. 解压
echo "[2/4] 解压"
rm -rf "$FE/element"
mkdir -p "$FE/element"
tar -xzf "$FE/$PKG" -C "$FE/element" --strip-components=1

# 3. 写配置
echo "[3/4] 写 config.json"
cat > "$FE/element/config.json" <<'JSON'
{
  "default_server_config": {
    "m.homeserver": {
      "base_url": "http://localhost:8008",
      "server_name": "localhost"
    }
  },
  "brand": "Furry Everpony (测试)",
  "disable_custom_urls": false,
  "disable_guests": true,
  "show_labs_settings": true
}
JSON

# 4. 起静态服务
echo "[4/4] 启动 8080"
pkill -f "http.server 8080" 2>/dev/null || true
sleep 1
cd "$FE/element"
nohup python3 -m http.server 8080 --bind 0.0.0.0 > "$FE/element-server.log" 2>&1 &
sleep 2
curl -sS -o /dev/null -w "本地 8080: %{http_code}\n" --max-time 10 http://127.0.0.1:8080/
echo "完成"
