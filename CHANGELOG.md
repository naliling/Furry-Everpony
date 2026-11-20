# v2026.11.20.0.10.42 — 2026-11-20

## Tailscale/Funnel 常驻自愈：外网固定地址挂了自动恢复

- **PowerShell 哨兵** `.tools/guard-tailscale.ps1`：每 20 秒确保 Tailscale 服务在跑、已登录、Funnel 指向 7788。因 node 子进程对 tailscaled 受保护 pipe 没权限（Access is denied），改用 PowerShell 直调 tailscale.exe（已验证可行）。
- **实测自愈**：故意 tailscale funnel reset 打掉固定地址，25 秒内哨兵自动重建，公网 /api/health 从 000 恢复 200，地址仍是 ponynaliling.tail31c195.ts.net。
- **Tailscale 服务本身**：StartType 已是 Automatic（开机自启）；实测普通 PowerShell 连 Stop-Service 都停不掉它（系统保护），误停风险极低；哨兵仍会在服务非 Running 时 Start-Service 兜底。
- **接入自启链**：开机自启 VBS 和桌面一键启动脚本都拉起哨兵（幂等）。桌面开关 stop 动作不碰 Tailscale，只停网站服务，固定地址保持。
- **桌面开关弹窗**：外网地址旁显示 [固定·正常] / [Tailscale未登录] / [临时地址]，一眼看出固定地址健康状态。
- 修 everony.ps1 每次 edit 后 UTF-8 BOM 丢失导致的 PowerShell 5.1 中文乱码语法错。

# v2026.11.20.0.10.41 — 2026-11-20
# v2026.11.20.0.10.41 — 2026-11-20

## 桌面一键启动 + 固定地址可靠性加固

- **弹窗显示固定地址**：桌面「Everony 服务开关」和开机自启脚本的状态弹窗，优先读 `data/funnel.json` 的固定地址（`https://ponynaliling.tail31c195.ts.net/`），不再显示会变的临时地址。
- **启动幂等确保 Funnel**：一键启动/开机自启时调用 `Ensure-Funnel`——Tailscale 已登录就 `funnel --bg 7788` 幂等重建，万一 Funnel 配置丢了会自动恢复；没登录则跳过，不阻塞本地服务。
- **修 PowerShell 中文乱码**：`everony.ps1` 补 UTF-8 BOM，解决 PowerShell 5.1 把无 BOM 的 UTF-8 按 ANSI 解读导致中文字符串语法报错。
- 实测 stop → start 全链路：本机服务 200、固定地址公网 200、桌面开关 status 正常返回版本，Funnel 仍绑定 `ponynaliling.tail31c195.ts.net`。
- 固定地址原理：Tailscale Funnel 的 `*.ts.net` 名绑在 tailnet 节点（主机名 PONYnaliling）上，只要同一账号同一设备登录就不变；Funnel 配置持久化在 tailscaled 里，重启/重连后自动恢复。

# v2026.11.20.0.10.40 — 2026-11-20
# v2026.11.20.0.10.40 — 2026-11-20