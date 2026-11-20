# v2026.11.20.0.10.41 — 2026-11-20

## 桌面一键启动 + 固定地址可靠性加固

- **弹窗显示固定地址**：桌面「Everony 服务开关」和开机自启脚本的状态弹窗，优先读 `data/funnel.json` 的固定地址（`https://ponynaliling.tail31c195.ts.net/`），不再显示会变的临时地址。
- **启动幂等确保 Funnel**：一键启动/开机自启时调用 `Ensure-Funnel`——Tailscale 已登录就 `funnel --bg 7788` 幂等重建，万一 Funnel 配置丢了会自动恢复；没登录则跳过，不阻塞本地服务。
- **修 PowerShell 中文乱码**：`everony.ps1` 补 UTF-8 BOM，解决 PowerShell 5.1 把无 BOM 的 UTF-8 按 ANSI 解读导致中文字符串语法报错。
- 实测 stop → start 全链路：本机服务 200、固定地址公网 200、桌面开关 status 正常返回版本，Funnel 仍绑定 `ponynaliling.tail31c195.ts.net`。
- 固定地址原理：Tailscale Funnel 的 `*.ts.net` 名绑在 tailnet 节点（主机名 PONYnaliling）上，只要同一账号同一设备登录就不变；Funnel 配置持久化在 tailscaled 里，重启/重连后自动恢复。

# v2026.11.20.0.10.40 — 2026-11-20
# v2026.11.20.0.10.40 — 2026-11-20

## 固定公网地址：Tailscale Funnel 接入，网站永久可访问

- **固定地址上线**：`https://ponynaliling.tail31c195.ts.net/`，公网实测 `/api/health` 200、首页 200，永久不变、免费、不用银行卡/实名。
- 过程：winget 装 Tailscale 1.104.7 → 用户 GitHub(naliling) 登录 → tailnet 开启 Funnel → `tailscale funnel --bg 7788` 把本机服务发布到公网。关键教训：`tailscale login` 的等回调进程不能被超时杀掉（之前 60s 超时导致网页显示成功但本机一直 NeedsLogin）；Funnel 要先在 `login.tailscale.com/f/funnel` 开账号级开关。
- 服务端 `/api/server-info` 优先读 `data/funnel.json` 的固定地址，站点「我的 → 访问入口」卡片显示固定地址；没有才回退到 quick tunnel 临时地址。
- 修复 Funnel 502：本机服务和看门狗曾同时挂掉，用 launch-server.mjs 拉起看门狗后恢复；现看门狗常驻，服务挂了自动重启。
- Cloudflare named tunnel / Cloudflare One / 樱花FRP 这些要银行卡/2FA/实名的路全部放弃，不再折腾账号。
- `everong.dpdns.org`（DigitalPlat）NS 正常但 DNS 记录空：在 DigitalPlat 加一条 CNAME（名称 @，值 `ponynaliling.tail31c195.ts.net`）即可用该域名访问，这一步需用户本人填（只有 DNS 编辑权限在他手里）。

# v2026.11.18.0.10.39 — 2026-11-18
# v2026.11.18.0.10.39 — 2026-11-18

## 修好点开 Bot 崩溃：setStats is not defined