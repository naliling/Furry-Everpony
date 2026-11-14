#!/bin/bash
# 用注册令牌在本地 homeserver 上创建一个纯数字 localpart 账号
# 用法: REG_TOKEN=<令牌> bash create-account.sh <号码> <密码>
set -euo pipefail

BASE="${BASE:-http://127.0.0.1:8008}"

# 没给 REG_TOKEN 就从配置文件里读
if [ -z "${REG_TOKEN:-}" ]; then
  CFG="${FE_CONFIG:-/root/fe/tuwunel.toml}"
  REG_TOKEN=$(sed -n 's/^token = "\(.*\)"$/\1/p' "$CFG" | head -1)
fi
TOKEN="${REG_TOKEN:?没找到注册令牌，请设 REG_TOKEN 或检查 $CFG}"
USER="${1:?用法: create-account.sh <号码> <密码>}"
PASS="${2:?用法: create-account.sh <号码> <密码>}"

echo "==> 1. 发起注册（拿 UIA session）"
r1=$(curl -sS -X POST "$BASE/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}")
echo "$r1"

session=$(echo "$r1" | sed -n 's/.*"session"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -z "$session" ]; then
  echo "!! 没拿到 session，注册流程可能不需要 UIA 或出错了" >&2
  exit 1
fi
echo "session=$session"

echo "==> 2. 提交注册令牌"
r2=$(curl -sS -X POST "$BASE/_matrix/client/v3/register" \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\",\"auth\":{\"type\":\"m.login.registration_token\",\"token\":\"$TOKEN\",\"session\":\"$session\"}}")
echo "$r2"

echo "==> 3. 用密码登录验证"
r3=$(curl -sS -X POST "$BASE/_matrix/client/v3/login" \
  -H 'Content-Type: application/json' \
  -d "{\"type\":\"m.login.password\",\"identifier\":{\"type\":\"m.id.user\",\"user\":\"$USER\"},\"password\":\"$PASS\",\"initial_device_display_name\":\"FE 命令行测试\"}")
echo "$r3"

echo "==> 4. 用 token 读自己的 whoami"
at=$(echo "$r3" | sed -n 's/.*"access_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
if [ -n "$at" ]; then
  curl -sS -H "Authorization: Bearer $at" "$BASE/_matrix/client/v3/account/whoami"
  echo
fi
