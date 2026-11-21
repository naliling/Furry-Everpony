# v2026.11.21.0.10.47 — 2026-11-21

## 去掉邮箱门禁 + 修图标乱摆 + 补注册页动画 + 竖屏错位

- **去掉邮箱验证码门禁**：本机发信授权码非 QQ 16 位标准、实测 535 被拒，按用户决定默认 `registerGate=none`，注册只需图形验证码，别人能正常注册。线上库已同步。
- **修图标疯狂摆动**：撤销上一版 `*{animation-duration:500ms!important}` 对循环装饰动画的误伤（logo 漂浮 7s、光环呼吸 8s、轨道旋转 30s 恢复原生节奏）；全局兜底只作用于 transition。
- **补登录/注册页动画**：认证页每个元素错落进场，登录/注册/切换按钮补悬停抬升、按压回弹、发光，均 ≥0.5 秒。
- **修竖屏错位**：手机认证页顶对齐 + 底部安全区兜底，卡片限宽居中；底部导航安全区补偿。
# v2026.11.21.0.10.46 — 2026-11-21

## 动画有头有尾 + 最短 0.5 秒 + 删除左上角 logo 点击

- **动画对称**：页面切换改用浏览器原生视图过渡，旧页淡出、新页淡入各 620ms，不再一瞬间晃眼；进场和退场都有（有头有尾）。
- **时长统一**：全站所有 transition/animation 时长兜底 ≥500ms；根变量 --dur/--motion-feedback 提升到 500ms 以上；错落延时保留。
- **删无用点击**：左上角小马 logo 由 button 改为纯展示 div，删除跳广场的点击功能和手型光标、hover 变换。
# v2026.11.21.0.10.45 — 2026-11-21

## 首页全站动画 + 手机滚动回弹 + 授权码校验提示

- **全站动画总层** `web/src/motion-all.css`：统一所有 button/输入/卡片/图标的悬停抬升、按压回弹、聚焦发光；首页游客广场每个区块（品牌、按钮、标题、统计、搜索框、Bot 卡片、怎么玩、页脚）按 40–940ms 错落进场；骨架屏流光；尊重 prefers-reduced-motion。
- **手机滚动与回弹**：`body` 从 `overflow:hidden` 改为可滚动并恢复边缘回弹；根高度改用 `100dvh`（原来 `100dvh` 被后面的 `100vh` 覆盖）；`app-shell`、消息列表、会话列表、各页面 body 的 `overscroll-behavior:contain` 改回 auto；游客广场交给 body 自然滚动。
- **授权码校验**：管理台填 QQ 邮箱授权码时，非 16 位字母会当场红字提醒，避免填错后发信才报 535。
- 邮箱真实发信仍取决于有效授权码：实测生产配置返回 535（SMTP_AUTH_REJECTED），库中授权码为 12 位字母数字，非 QQ 标准 16 位字母。需本人去 QQ 邮箱重新生成授权码。
# v2026.11.21.0.10.44 — 2026-11-21

## 注册体验、全站动效、首屏提速与邮箱发信整改

- **注册页**：改为独占原生滚动容器，支持软键盘 VisualViewport 补偿、短屏/窄屏自适应与系统回弹，不再拦截触摸；返回按钮移入同一滚动流，不遮表单。注册入口直达注册模式（Auth `initialMode="register"`）。
- **全站动效**：统一弹窗/抽屉的入出场与明确「取消/关闭」出口（约 620ms）；修手机抽屉内部滚动、旧聊天列退场和静止 transform 覆盖；主题壁纸按当前主题只加载 1 张，省流模式 0 张；尊重 `prefers-reduced-motion`。
- **首屏提速**：访客、注册、聊天、管理拆成按需加载，入口从单个 645KB 包拆成约 265KB 主包；会话校验加超时与重试出口，网络慢不再一直卡住；构建期生成 Brotli/gzip，服务端按 Accept-Encoding 协商、指纹资源 immutable 缓存；缺资源返回 404 不回退 HTML，避免更新后白屏。
- **发信**：SMTP 保留 AUTH LOGIN、强制 TLS，把认证/发件人/收件人/投递拒绝分类提示且不泄露供应商原文；配置不完整直接拒绝发信，新验证码只有被 SMTP 接收后才替换旧码；管理台区分「配置完整」与「服务商已接收」。
- **修聊天背景**：`ChatPanel` 两个 `style` 属性互相覆盖，导致背景铺法/对齐设置失效，已合并为单一样式对象。
# v2026.11.20.0.10.43 — 2026-11-20

## 移除自动守护，服务完全交给桌面一键开关

- **停用开机自启**：Startup 里的 EveronyServer.vbs 改成只留说明、不启动任何东西——用户要自己用桌面开关控制，机器不用时不希望服务一直挂着。
- **删掉 Tailscale/Funnel 哨兵**：`.tools/guard-tailscale.ps1` 删除；一键启动脚本不再拉任何常驻守护进程。
- **一键 start 改直连**：直接 `Start-Process node --env-file=.tools/server.env server/index.js`，不经过会自动重启的看门狗；关掉就是关掉，不会被拉起。
- 澄清「启动10秒就断」：根因是测试时从 DSH 工具后台 job 启的服务被工具进程树清理，并非桌面开关问题；用 wscript/Start-Process 脱离方式启动，实测 8 秒、23 秒后均 200 持续在线。
- 桌面开关 stop 不动 Tailscale，固定地址 https://ponynaliling.tail31c195.ts.net/ 保持。

# v2026.11.20.0.10.42 — 2026-11-20

## Tailscale/Funnel 常驻自愈：外网固定地址挂了自动恢复

- **PowerShell 哨兵** `.tools/guard-tailscale.ps1`：每 20 秒确保 Tailscale 服务在跑、已登录、Funnel 指向 7788。因 node 子进程对 tailscaled 受保护 pipe 没权限（Access is denied），改用 PowerShell 直调 tailscale.exe（已验证可行）。
- **实测自愈**：故意 tailscale funnel reset 打掉固定地址，25 秒内哨兵自动重建，公网 /api/health 从 000 恢复 200，地址仍是 ponynaliling.tail31c195.ts.net。
- **Tailscale 服务本身**：StartType 已是 Automatic（开机自启）；实测普通 PowerShell 连 Stop-Service 都停不掉它（系统保护），误停风险极低；哨兵仍会在服务非 Running 时 Start-Service 兜底。
- **接入自启链**：开机自启 VBS 和桌面一键启动脚本都拉起哨兵（幂等）。桌面开关 stop 动作不碰 Tailscale，只停网站服务，固定地址保持。
- **桌面开关弹窗**：外网地址旁显示 [固定·正常] / [Tailscale未登录] / [临时地址]，一眼看出固定地址健康状态。
- 修 everony.ps1 每次 edit 后 UTF-8 BOM 丢失导致的 PowerShell 5.1 中文乱码语法错。