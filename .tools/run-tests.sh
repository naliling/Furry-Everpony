#!/bin/bash
# 一次性跑完三套回归测试：每次干净库 + 预置 registerMode=open + 独立 7799 实例
cd "$(dirname "$0")/.." || exit 1
NODE=./.tools/node-v22.23.5-win-x64/node.exe
ROOTW="C:/Users/36328/Documents/deepseek-harness/default-workspace/projects/furry-everpony"
DBDIR="$ROOTW/data"

run_one() {
  local name=$1 db=$2 script=$3 mode=${4:-open}
  powershell -NoProfile -ExecutionPolicy Bypass -File .tools/kill-7799.ps1 > /dev/null 2>&1
  rm -f "data/$db" "data/$db-wal" "data/$db-shm"
  FE_DB="$DBDIR/$db" FE_PORT=7799 FE_HOST=127.0.0.1 FE_LOG_DIR="$DBDIR/logs" $NODE server/index.js > "data/logs/test-$name.log" 2>&1 &
  sleep 2.6
  if [ "$mode" != "skip" ]; then $NODE .tools/seed-mode.mjs "data/$db" "$mode" 2>/dev/null; fi
  echo "===== $name ====="
  $NODE ".tools/$script" 2>&1 | tail -6
}

run_one p1 test-p1.db test-p1.mjs
run_one admin test-admin.db test-admin.mjs
run_one captcha test-captcha.db test-captcha.mjs
run_one guard test-guard.db test-guard.mjs skip
powershell -NoProfile -ExecutionPolicy Bypass -File .tools/kill-7799.ps1 > /dev/null 2>&1
echo "ALL DONE"
