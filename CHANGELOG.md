# v2026.11.20.0.10.43 — 2026-11-20

## 移除自动守护，服务完全交给桌面一键开关

- **停用开机自启**：Startup 里的 EveronyServer.vbs 改成只留说明、不启动任何东西——用户要自己用桌面开关控制，机器不用时不希望服务一直挂着。
- **删掉 Tailscale/Funnel 哨兵**：`.tools/guard-tailscale.ps1` 删除；一键启动脚本不再拉任何常驻守护进程。
- **一键 start 改直连**：直接 `Start-Process node --env-file=.tools/server.env server/index.js`，不经过会自动重启的看门狗；关掉就是关掉，不会被拉起。
- 澄清「启动10秒就断」：根因是测试时从 DSH 工具后台 job 启的服务被工具进程树清理，并非桌面开关问题；用 wscript/Start-Process 脱离方式启动，实测 8 秒、23 秒后均 200 持续在线。
- 桌面开关 stop 不动 Tailscale，固定地址 https://ponynaliling.tail31c195.ts.net/ 保持。

# v2026.11.20.0.10.42 — 2026-11-20
# v2026.11.20.0.10.42 — 2026-11-20

## Tailscale/Funnel 常驻自愈：外网固定地址挂了自动恢复

- **PowerShell 哨兵** `.tools/guard-tailscale.ps1`：每 20 秒确保 Tailscale 服务在跑、已登录、Funnel 指向 7788。因 node 子进程对 tailscaled 受保护 pipe 没权限（Access is denied），改用 PowerShell 直调 tailscale.exe（已验证可行）。
- **实测自愈**：故意 tailscale funnel reset 打掉固定地址，25 秒内哨兵自动重建，公网 /api/health 从 000 恢复 200，地址仍是 ponynaliling.tail31c195.ts.net。
- **Tailscale 服务本身**：StartType 已是 Automatic（开机自启）；实测普通 PowerShell 连 Stop-Service 都停不掉它（系统保护），误停风险极低；哨兵仍会在服务非 Running 时 Start-Service 兜底。
- **接入自启链**：开机自启 VBS 和桌面一键启动脚本都拉起哨兵（幂等）。桌面开关 stop 动作不碰 Tailscale，只停网站服务，固定地址保持。
- **桌面开关弹窗**：外网地址旁显示 [固定·正常] / [Tailscale未登录] / [临时地址]，一眼看出固定地址健康状态。
- 修 everony.ps1 每次 edit 后 UTF-8 BOM 丢失导致的 PowerShell 5.1 中文乱码语法错。