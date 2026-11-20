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

- 根因：v0.10.35 删「发言排行」时删掉了 stats 的 useState 声明，但 BotDetail 的 useEffect 里还留着 `setStats(null)`，一点开任意 Bot 详情就抛 `setStats is not defined`、整页渲染失败（手机浏览器直接显示错误页）。
- 修复：删掉这行残留调用；全项目扫过其它已删 state（invite/frame/stats）的残留引用，没有别的了。
- 实测（CDP 390×844 手机）：点 Bot 卡片 → 资料卡正常弹出（标题「茉心·陌斯」）、无 error boundary、无 JS 报错；点关闭 150ms 弹窗仍在播 fe-overlay-out、800ms 才卸载。
- 测试：p1 17/17、admin 24/24、captcha 13/13。

# v2026.11.18.0.10.38 — 2026-11-18

## 全站浮层动画统一：桌面手机同一套、侧栏也有动画

- 根因：pages.css 手机断点里把 .overlay/.drawer/.modal 的 animation 设成 none，手机端浮层零动画；桌面端右键菜单 ContextMenu 从未接退出动画；侧栏切换无动画。
- 修复：删掉手机端 animation:none；ContextMenu 接入 useOverlayClose（0.52s）；effects.css 追加全站统一动画——所有浮层开关 0.6s 淡入淡出（!important 强制），覆盖桌面/手机/浅色/深色主题；侧栏按钮与主内容切换也有 0.6s 过渡。
- 实测（CDP 桌面）：点关闭后 150ms 弹窗仍在且 animation=fe-fade-out，850ms 才卸载，动画可见。

# v2026.11.18.0.10.37 — 2026-11-18

## 关闭动画 + 邮箱注册 + 手机 Bot 资料卡