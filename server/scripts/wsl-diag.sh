#!/bin/bash
echo "=== os-release ==="
head -3 /etc/os-release
echo "=== id ==="
id
echo "=== home 目录 ==="
ls -la /home
echo "=== 普通用户 ==="
getent passwd | awk -F: '$3>=1000 && $3<65534 {print $1" uid="$3" home="$6}'
echo "=== 磁盘 ==="
df -h / | tail -1
echo "=== 架构 ==="
uname -m
echo "=== 网络 ==="
ip -4 addr show 2>/dev/null | grep -E 'inet ' | head -3
echo "=== 能否读到 Windows 目录 ==="
ls -d /mnt/c/Users/36328 2>&1
