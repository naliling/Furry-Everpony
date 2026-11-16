# v2026.11.17.0.10.24 — 2026-11-17

## 注册审核 + IP/设备识别 + 站点防护 + 清库重建站长

这一版回答的是「邮箱能不能不被泛滥注册、能不能识别别人 IP 和设备、怎么防攻击」——全部落到可查的数字上。

- **注册三种模式**（`settings.registerMode`，管理台「防护」里切换）：`open` 谁都能注册、`approval` 新号先进待审核（默认）、`closed` 直接关闭注册。空库第一个注册的人永远是站长，不受模式限制。
- **待审核队列**：`GET /api/admin/pending` 列出未放行的账号，带注册时的 IP 与设备；管理台「审核」分区一键通过 / 拒绝，拒绝等于连号带会话一起删掉。待审核账号登录返回 403「账号还在等站长审核」。
- **登录记录与设备识别**：新增 `login_logs` 表记录每次登录的 IP、UA、设备名、成功/失败与原因；`deviceOf(ua)` 把 UA 归成「Windows · Edge」「Android · Chrome」这类可读名字；管理台「登录记录」分区可看全部或只看失败（撞库排查）。
- **我的登录设备**：「我的 → 账号与安全」新增设备列表，显示每个会话的 IP、设备、最近活跃时间，本机标「本机」，其余可一键踢掉（`GET/DELETE /api/me/sessions`）。
- **防攻击**：全局每 IP 每分钟最多 900 次 API 请求；同 IP 10 分钟错 20 次密码、同账号 10 分钟错 5 次即锁；注册同 IP 10 分钟 20 次；IP 封禁表 `ip_bans` 在 `onRequest` 阶段直接 403（连页面都打不开），封禁时顺手删掉该 IP 的所有会话；服务端开 `trustProxy`，经 cloudflared 反代时拿到的是真实访客 IP。
- **一键开关有反馈**：`.tools/everony.ps1` 重写——点一下先弹「正在启动，最多等十几秒」，起来后弹「已启动 + 版本 + 本机/局域网/外网三个地址」并自动打开网页；停止同理弹「正在停止 / 已停止」；带互斥锁防连点。桌面 `Everony 开关.vbs` 与开机自启 `Startup\EveronyServer.vbs` 都重写成纯 ASCII 无 BOM（原来带 BOM 会让 WSH 报 800A0408「无效字符」，等于开机自启一直是坏的）。
- **数据清零重建**：按用户要求删掉全部账号/消息/会话/登录记录/上传文件与旧日志，重新注册站长 **灰凝（3881756548 / 3881756548@qq.com）**，空库首注册者自动成为管理员。
- 测试：新增防护与审核专项 20 项（含待审核登录 403、拒绝删号、IP 封禁 403、解封恢复、撞库 429、普通用户越权 403），四套回归 **RAN=74 PASS=74 FAIL=0 ERR=0**。

# v2026.11.17.0.10.23 — 2026-11-17

## 登录页去掉服务器自选 + 注册图形验证码 + 桌面一键开关 + 看门狗 + 管理台入口

- **登录页不再让用户填服务器地址**（用户原话：「为啥会有服务器自选你妈的想干啥」）：`web/src/lib/api.js` 的 `serverBase()` 恒返回空字符串（同源请求），`setServerBase()` 只清理不写入，旧版本留在 localStorage 的 `fe_server` 自动删掉；`web/src/views/Auth.jsx` 删掉整块服务器输入框、连接按钮、连接状态文字，以及「局域网里发现 N 台服务器」列表和配套的 `probeServer/applyServer` 逻辑。
- **注册加图形验证码**：服务端新增 `GET /api/captcha`（132×44 SVG，4 位字符，5 分钟有效，同 IP 10 分钟限 40 次），注册接口 schema 增加 `captchaId/captcha`——错码可重试 5 次、超过作废、一次一码；同 IP 10 分钟最多 20 次注册。前端在确认密码下方显示验证码图片，点图换一张，输错自动换。
- **桌面一键开关**：桌面新增 `Everony 开关.vbs`，双击 = 正在运行就停止、没运行就启动并打开网页，结果用弹窗提示；背后是 `.tools/everony.ps1`（start/stop/status/toggle）。
- **看门狗保稳定**：`.tools/watchdog.mjs` 每 20 秒探 `/api/health`，连续 3 次失败自动重启服务端，日志写 `data/logs/watchdog.log`；开机自启项 `Startup\EveronyServer.vbs` 改为先拉看门狗再拉隧道。
- **管理台入口显眼化**：「我的」页第一张卡片就是管理台（仅管理员可见），显示账号 / Bot / 消息 / 在线四个真实数字 + 「进入管理台」按钮；底部导航同时保留「管理」。
- **广场顶部显示真实站点地址**（`window.location.host`），不再可能显示成空或「本站」以外的猜测值。
- 测试：验证码专项 13 项、P1 回归 17 项、管理台 24 项，全绿（RAN=54 PASS=54 FAIL=0 ERR=0）。

# v2026.11.16.0.10.22 — 2026-11-17

## 广场三列铺满 + 站点信息条 + 头像按钮收口

- **登录后的 Bot 广场不再空一列**：`.bot-grid` 由 `auto-fill` 改成固定三列 `repeat(3, minmax(0, 1fr))`，1120px 以下降两列、手机一列（`web/src/pages.css`）。原来只有 3 个 Bot 时右侧会空出一整列。
- **广场底部新增站点信息条** `.plaza-site-strip`（`web/src/views/discover/DiscoverTab.jsx`）：本站地址（取 `window.location.host`）、公开 Bot 数、在线人数、数据只在本站四项，让新来的人一眼知道这是哪台服务器。
- **头像换图按钮收口**：原来贴在头像下缘的「换」小胶囊会压住头像，改成右下角 24px 圆形相机按钮（`.avatar-edit-hint`，hover 青色描边），桌面与手机一致。
- **桌面「我的」宽度实测**：1440 视口下 `.settings-body` 实测 1120px、卡片 1058px（`199–1319`），已占满内容区，不需要再加两栏布局。

# v2026.11.16.0.10.21 — 2026-11-16

## 手机直接能用：访问入口卡片 + 外网隧道 + 管理后台

这一版解决的是「不给安装包，手机怎么进来、运营者怎么管」。

- **设置页新增「访问入口」卡片**（`web/src/views/Settings.jsx`）：列出所有可用的局域网地址（每台电脑的网卡名一并显示）、一键复制、旁边直接放二维码，手机扫码就打开；不再依赖桌面外壳，纯网页下也会显示（旧版这块被 `isDesktop` 挡住，拆掉客户端后永远看不见）。
- **外网地址自动出现**：新增 `.tools/tunnel.mjs` 常驻脚本，用 cloudflared quick tunnel 把 7788 端口映射出去，拿到地址后写入 `data/tunnel.json`，`/api/server-info` 把它带给前端；断线自动重连，地址变了页面自动更新。开机自启项 `Startup\EveronyServer.vbs` 现在同时拉起「后台服务端」和「隧道」两个进程。
- **管理后台**（新增 `web/src/views/admin/AdminPage.jsx` + `/api/admin/*` 接口）：概览统计（账号/Bot/消息/群/今日新增/在线数/库大小/运行时长）、账号管理（搜索、筛选、封禁解封、设/取消管理员）、Bot 管理（上架下架、所属人、消息数）、消息管理（最近 100 条、管理员删除）。入口只对 `is_admin` 显示。
- **账号新增三个字段**：`accounts.is_admin`、`banned`、`ban_reason`（`server/db.js` 自动迁移）。被封禁的账号登录直接 403，已登录的会话立即失效（封禁时清 sessions）。
- **管理员引导**：启动时读 `FE_ADMIN_NUMBERS`（逗号分隔的号码）；一个管理员都没有时，把最早注册的个人号设为管理员，保证新库也能进后台。
- **修掉 `/api/server-info` 重复注册**：新加的实现与旧实现撞路由（Fastify 会抛 `FST_ERR_DUPLICATED_ROUTE`），合并成一份，保留旧的 `lanUrls/lanNames/webReady` 并新增 `lan`（含网卡名）与 `tunnel`。

# v2026.11.16.0.10.20 — 2026-11-16

- **界面品牌统一为 Everony**：登录页顶部「NapChat聊天社交~」、启动页、浏览器标题、设置页「关于」全部改成 Everony（`web/src/views/Auth.jsx`、`web/src/App.jsx`、`web/src/views/Shell.jsx`、`web/src/views/Settings.jsx`）。
- **桌面广场不再空一大片**：卡片墙改成 `auto-fit` + 上限 340px 并整排居中，Bot 少时也不会挤在左边；底部新增「挑一个就开聊 / 号码记住你 / 自己的 Bot 也能挂」三格说明（手机端单列）。
- **管理页样式补齐**：`web/src/pages.css` 增加整套 `.admin-*`（统计卡自适应、胶囊 tab、账号行按钮对齐、720px 手机断点），并修掉 `web/src/styles.css` 里错用的 `var(--line-1)`。
- **空库也能进管理台**：注册时如果库里还没有管理员，注册者自动成为管理员。

## 彻底拆掉客户端：只剩一个后台服务 + 浏览器

上一版还是「网页能用，但软件还在」。这一版把软件本身删了——因为它的唯一不可替代作用是**托管服务端进程**，而这件事一个无窗口的后台进程就能做，不需要 159 MB 的外壳。

- **服务端独立运行**：`server/index.js` 不再由 Electron 启动，改为独立后台进程（Windows 用 `wscript` 隐藏窗口启动，`.tools/start-server.vbs` 带端口占用检查），并放进开机启动项 `Startup\EveronyServer.vbs`；崩溃/重启后网页端无感。
- **数据库搬出 AppData**：从 `%APPDATA%\furry-everpony\data\everpony.db` 迁到项目 `data/everpony.db`（该目录原先写入报 `attempt to write a readonly database`）。迁移核对：12 个账号、108 条消息、2 个 Bot 全部在位。
- **删除 Electron 外壳**：`electron/` 目录、`package.json` 的 `main`/`start`/`dist`/`pack` 脚本、`electron` 与 `electron-builder` 依赖、整个 `build` 打包段全部移除。
- **删除安卓 App**：`android/` 源码目录与 `dist-apk/` 产物移除；手机改用浏览器「添加到主屏幕」，不再需要安装包。
- **服务端删掉 APK 分发接口**：`GET /api/apk/info` 与 `GET /apk` 整段删除（含 `APK_DIRS` / `compareVersions` / `latestApk`）。
- **设置页删掉 APK 与「连接的实例」区块**：`Settings.jsx` 不再请求安装包状态，也不再显示安卓专属的实例切换。
- **发布流程简化**：以前是「打包 exe → 部署到安装目录 → 重启应用」，现在是「`vite build` → 重启后台进程」，一次发布从几分钟缩到几秒。
# v2026.11.16.0.10.19 — 2026-11-16

## P1 整改：广场做首页 + 邮箱注册 + 8–11 位号码 + Bot 标签

产品从「下载客户端」转成「打开网页就能用」的第一刀。核心是一句话：**没登录也能先逛广场，看见 Bot 再决定注册**。

- **游客首页就是 Bot 广场**（新增 `web/src/views/plaza/PlazaPage.jsx`）：未登录直接看到公开 Bot 的卡片墙（头像、名字、`#号码`、标签、在线状态、签名），顶部只有「登录 / 注册」两个按钮，20 秒自动刷新在线状态，搜索 300ms 防抖。点任何卡片都引导去登录。
- **`GET /api/bots/public` 改为可选鉴权**：不带 token 也能读，返回 `tags` 与 `isMine`（匿名恒为 false）；搜索命中号码、名字、签名、标签。
- **注册改成邮箱 + 自选号码**（`POST /api/register`）：新增 `email` 列与唯一索引（`server/db.js`），邮箱重复回 409「这个邮箱已经注册过了」，号码重复回 409「这个号码已经被用了」；密码仍走 scrypt。
- **登录支持邮箱或号码**（`POST /api/login`）：入参 `identifier`，含 `@` 按邮箱查（忽略大小写），否则按号码查。
- **号码规则从 5–12 位收成 8–11 位**（`NUMBER_RE = /^[1-9]\d{7,10}$/`），不能以 0 开头；登录页、创建 Bot 弹窗、号码可用性检查全部同步。
- **Bot 标签**：`accounts.tags` 列（JSON 数组，最多 5 个、每个 12 字内），创建与编辑 Bot 都能填，广场卡片、Bot 详情、`/api/bots` 都返回；广场搜索能按标签命中。
- **导航改成广场优先**（`Shell.jsx`）：左侧第一项是「广场」并作为默认页，原「发现」并入广场页的分段控件（Bot 广场 / 我的 Bot）；侧栏 Bot 按钮直接跳到「我的 Bot」。
- **免加好友直聊公开 Bot**：`canOpenDm()` 让公开 Bot 不用加好友就能开私聊与直接发消息（`POST /api/dm`、`POST /api/messages` 都放行）。
- **按钮宽度修正**：旧样式表给 `.btn-primary` / `.btn-ghost` 写了 `width:100%`，导致工具栏小按钮撑满整行；统一收回 `width:auto`，需要整行的仍用 `.btn-block`。
- 页面标题与 `index.html` 的 title/description 改成 Everony。

# v2026.11.16.0.10.18 — 2026-11-16

## 换成「一台服务器 + 输号码就加」：客户端可以连任意一台服务器

上一版还是「每个实例各跑各的，靠邀请码/中转站互相找」。这一版把主干换成主流聊天软件的做法：**一台服务器、注册即用、号码就是身份、输号码就能加好友**，同时保留原来的自托管与实例互联（不配服务器就是本机自用，和以前一样）。

- **服务端放开跨域**（`server/index.js`）：新增 onRequest 钩子统一回 `Access-Control-Allow-Origin`（回显来源，无来源用 `*`）、允许 `Authorization / Content-Type / X-FE-Secret / X-FE-Instance` 头、允许 GET/POST/PATCH/PUT/DELETE/OPTIONS，预检直接 204。这样网页版、手机 WebView、别的电脑的客户端都能连同一台服务器。
- **客户端可以指定服务器**（`web/src/lib/api.js`）：新增 `serverBase() / setServerBase() / normalizeServerUrl() / apiUrl()`，所有请求（含上传、媒体地址）都拼在所选服务器上；登录状态按服务器各自保存。
- **登录页加「服务器」一行**（`web/src/views/Auth.jsx`）：填地址点「连接」即探测 `/api/health` 显示「已连上 X · 版本 Y」；留空就是本机。没填服务器时会自动列出同一 Wi-Fi 下发现的服务器，点一下即连。
- **加好友改成输号码**（`AddFriendModal`）：最上面就是一个号码输入框 + 「添加」按钮，回车即发；扫码 / 邀请码 / 跨网络这些旧路径收进「扫码 / 邀请码 / 跨网络（可选）」折叠里，不再是主流程。
- **局域网服务器发现**：新增**不需要登录**的 `GET /api/discover/lan`（桌面与安卓同源实现），只回地址、版本、人数，不回任何账号名单，供登录页列出「同一个 Wi-Fi 下的服务器」。
- **设置里给出可复制的服务器地址**（`Settings.jsx` → 实例互联）：局域网地址与公网地址各一行 + 复制按钮，方便把手机/别的电脑接过来。

### 实测

- 跨源预检：`OPTIONS /api/login` → 204，响应头含 `Access-Control-Allow-Headers: Authorization, Content-Type, X-FE-Secret, X-FE-Instance`。
- 局域网发现：第二实例起在 7790，6 秒后 `GET /api/discover/lan` 返回 `{"instances":[{"addr":"192.168.18.69:7788","version":"...","people":7}]}`。
- 端到端「填服务器 → 注册 → 进主界面」：在登录页填 `127.0.0.1:7790`，注册的新账号**只存在于那台服务器**（远程库 accounts 仅 1 行），本机库没有新账号。

### 产物

- 桌面单文件 exe：见文末（打包完成后补数字）。
- 安卓 APK：`android/dist/FurryEverpony-2026.11.16.0.10.18.apk`（versionCode 101018）。
- 测试：后端 13 套 RAN 501 PASS 501 FAIL 0 ERR 0；安卓 7 套 RAN 322 PASS 322 FAIL 0 ERR 0；合计 RAN 823 PASS 823 FAIL 0 ERR 0。

# v2026.11.16.0.10.17 — 2026-11-16

## 一条中转站 + 一个二维码：跨网络加好友不用配任何东西

上一版的中继要自己找一台公网服务器填进去，普通人根本做不到。这一版把「中转站」做进电脑端：在你自己的电脑上点一下，它就同时跑一个中继和一个公网隧道，得到一个 `https://xxx.trycloudflare.com` 地址，并把地址写进你的邀请码与二维码。对方扫一下，手机就自动接上这台中转站——不用注册、不用填地址、不用端口映射。

- 新增 `server/relay-host.js`：在应用进程内起一个中继（默认 7801，数据库在 `data/relay-host.db`），并拉起 `cloudflared` 快速隧道把中继暴露到公网；隧道掉线自动重连（3 秒），30 秒看门狗；状态 `off / starting / running / error` 可从接口读到。开关持久化在 `instance_meta` 的 `host_relay`，重启自动恢复。
- 中继客户端新增「对外地址」（`publicUrl`）：邀请码优先写对外地址，避免把 `127.0.0.1` 写进邀请码发给别人。
- **扫码零配置**：`/api/federation/invite/accept` 在发握手之前，先按邀请码里的中继地址自动接入并注册（响应里 `relayAuto: true`）。原因是手机与内网设备无法被回连，必须先把中继接上，对方才能把「同意」回执放进队列。
- **修掉一个真 bug**：已经是好友时，握手原来直接返回「已经是好友」，不再补发回执。于是对方重装、清库、或上一次回执丢了，发起方永远补不上好友。现在会重新走一次 `notifyAccepted` 补发，并返回 `friend`。安卓端同源修复。
- **手机端补齐联邦接口**：安卓本地服务原来一个 `/api/federation/*` 路由都没有，导致手机生成不了邀请码、也收不到别人握手，只能单向加人。现在补齐 10 个路由（info / invite / invite/accept / request / nearby / settings / handshake / accept / deliver），手机也能被加、也能显示自己的二维码。

### 实测（本机 + 隧道，非真机）

- 同网段扫码：`{via:'direct', friend:true}`，1 秒内双方好友互现。
- 模拟 4G（把邀请码地址改成不可达）：`{via:'relay', queued:true}`，**10.5 秒后双方好友互现**，中继游标从 0 前进到 7。
- 模拟对方重装清库：同账号再扫一次，9 秒成功（补发回执生效）。
- 新增安卓联邦接口测试 21 条：手机生成邀请码 → 电脑扫 → 直接成为好友 → 双方互现 → 手机收握手并补回执。

### 产物

- 桌面单文件 exe：`release/FurryEverpony-2026.11.16.0.10.17.exe` 159,806,384 字节 sha256 726abf87b85e6fb9bf288cd03853402b122921bca794ac74fb2d43bb9db25654（启动器 139,264 字节含版本串，载荷 159,667,104 字节，魔数 FESFX001 校验通过）。
- 安卓 APK：`android/dist/FurryEverpony-2026.11.16.0.10.17.apk` 943,748 字节 sha256 4e0b8523a177a6d776c8bc6a2ee4aeb686781aa34d07de9e2d859e1fbb5ec761（versionCode 101017，签名 CN=Furry Everpony 校验通过）。
- 测试：后端 13 套 RAN 492 PASS 492 FAIL 0 ERR 0（新增 test-host 12 条：中转站开关/鉴权/参数校验、邀请码带对外中继地址）；安卓 7 套 RAN 319 PASS 319 FAIL 0 ERR 0（新增 federation-routes 21 条）；合计 RAN 811 PASS 811 FAIL 0 ERR 0。
- 已部署到已安装目录并重启：`/api/health` 返回 2026.11.16.0.10.17，`/apk` 200 943,748 字节；桌面与 Downloads 各一份同哈希。


# v2026.11.16.0.10.16 — 2026-11-16

## 中继兜底：不在同一个网络也能加好友、发消息

以前加好友要求「对方实例此刻能被连上」：家里宽带没有公网地址、光猫路由器又拦入站，于是对方不在同一个 Wi-Fi 就必然报「对方实例没连上」。这一版加了一条可选兜底通道——中继。

- 新增 `server/relay.js`：只做转存的中继服务。它不存账号、不存聊天记录主体，只按实例 ID 暂存「好友申请 / 好友回执 / 私聊消息」，最多放 7 天，收方拉走并回执后立刻删除。单独跑：`node server/relay.js`（默认 0.0.0.0:7800，`FE_RELAY_PORT` / `FE_RELAY_HOST` / `FE_RELAY_DB` 可改）。
- 新增 `server/relay-client.js`：每个实例主动出站连中继（注册 + 心跳 + 8 秒轮询拉取），不需要任何入站端口映射，也不用公网地址。
- 加好友、同意回执、消息投递三条链路都加了中继兜底：直连失败、或手上只有对方实例 ID 而没有任何可直连地址时，自动排队到中继，对方上线后自己来拉。自托管直连仍然优先；不配中继就完全不参与，行为与之前一致。
- 邀请码现在带实例 ID 与中继地址（`i` / `r`）：跨网络的两个人互换邀请码就能加，不必有公网地址。
- 设置 → 实例互联 新增「中继服务器」：填地址点保存即注册，可一键关掉回到纯直连；状态行显示已连/未连。
- 加好友弹窗在走中继时给出明确文案：「直连不通，申请已排进中继队列，对方上线后会自动收到」。
- 手机端（安卓本地服务）同步实现 `Relay.java`，协议与电脑端完全一致，设置页同一个开关。
- 连不上时的错误提示改成中文人话：连不上（对方没在 N 秒内应答）/ 连不上（地址解析失败）/ 连不上（对方这个端口没开）/ 连不上（网络不通，可能被防火墙拦了）。

### 产物

- 桌面单文件 exe：`release/FurryEverpony-2026.11.16.0.10.16.exe` 159,798,913 字节 sha256 bf444eff66cdf05619f52085eb2e6d757f9d0c04a6ff3ddde805673465b72b94（启动器 139,264 字节含版本串，载荷 159,659,633 字节，魔数 FESFX001 校验通过）。
- 安卓 APK：`android/dist/FurryEverpony-2026.11.16.0.10.16.apk` 939,653 字节 sha256 382cf2113ac0e6d3fa911f2211a214514ff45a8ac5d9b7459c1dee5ff6b91835（versionName 2026.11.16.0.10.16 / versionCode 101016 / minSdk 24 / targetSdk 34，签名 CN=Furry Everpony 校验通过）。
- 已部署到已安装目录并重启：`/api/health` 返回 2026.11.16.0.10.16，`/apk` 200 939,653 字节；桌面与 Downloads 各一份同哈希。
- 测试：后端 12 套 RAN 480 PASS 480 FAIL 0 ERR 0（新增 test-relay 37 条）；安卓 6 套 RAN 298 PASS 298 FAIL 0 ERR 0（新增 relay-test 30 条）；合计 778/778。
- 界面实测：设置 → 实例互联填 `http://127.0.0.1:7800` 保存后顶部提示「中继已连上」，中继侧 `instances` 从 0 变 1；清空地址保存后回到纯直连（`enabled=false`）。
# v2026.11.15.0.10.15 — 2026-11-16

## 扫码加好友（电脑显示码，手机扫一下）

- 加好友弹窗「我的邀请码」下面新增 **我的二维码**：把邀请码直接画成二维码（纯 SVG 渲染，不依赖 canvas/图片，缩放不糊），对方扫一下就能加。
- 输入区右上角新增 **扫一扫** 按钮：打开取景框实时识别二维码，识别到自动填进输入框并立刻走加好友流程（邀请码 → 一步成为好友；自动通过开着的话扫完直接是好友）。
- 摄像头打不开 / 没权限 / 没有摄像头时，弹层里保留 **从图片识别**：从相册或截图选一张二维码图片，用同一套解码器识别（电脑端没有摄像头也能用）。
- 安卓端：AndroidManifest 增加 CAMERA 权限（required=false，没摄像头的设备照常安装），MainActivity 的 WebChromeClient 增加 onPermissionRequest 放行视频采集，并在没有权限时弹系统授权；拒绝后提示改用「从图片识别」。
- 新增 web/src/ui/qr.jsx（QrCode + QrScanner，依赖 qrcode-generator 与 jsqr），pages.css 增加 .qr-box / .af-qr / .af-scan-btn / .qr-scan 系列样式（手机端全屏取景、扫描线动画）。

## 修掉「好友申请点拒绝，报没有这条申请，列表还挂着」

- 现象：别人申请加我的 Bot，在「新朋友」里点拒绝（或同意）一直报「没有这条申请」，但列表里那条申请还在，删不掉。
- 根因：server/index.js 的 resolveFriendRequest 在按 requestId 找申请时只认 `row.to_id === me.id`；而「别人加我的 Bot」这条申请的接收方是 Bot，我作为 owner 本来有权审批，于是被判成 404。列表接口 /api/friends/requests 的 botIncoming 又是按 status='pending' 查的，所以拒绝失败后仍然显示。
- 修法：requestId 分支改成 JOIN accounts 取 to_type / to_owner，判定 `row.to_id === me.id || (row.to_type === 'bot' && row.to_owner === me.id)` 才算我的申请；不满足才 404。拒绝成功后 status 置 rejected，列表即时消失。

### 产物

- 桌面 exe：release/FurryEverpony-2026.11.15.0.10.15.exe，159,778,101 字节，sha256 742b6443f1281827f73f685b98175d707abe80c9fc95408b87c9604ccc4c606d；启动器 139,264 字节（含 0.10.15），载荷 version=2026.11.15.0.10.15，web assets index-BxYmpsql.js / index-01Ug83hq.css，dist-apk 里只有 0.10.15 一个包。
- 安卓 APK：android/dist/FurryEverpony-2026.11.15.0.10.15.apk，935,556 字节，sha256 b1efc1ddd1ba08c3b6219bc2acc98491e2c40fd91455c97b2e3a561c40d9f7d4，versionCode 101015，签名 CN=Furry Everpony。
- 已部署到 C:\Users\36328\Furry Everpony\resources\app（server + dist/web + dist-apk + package.json），/api/health = {"ok":true,"version":"2026.11.15.0.10.15"}，/apk 返回 200、935,556 字节。
- 已分发到桌面与 Downloads 的 FurryEverpony.exe / FurryEverpony.apk，哈希与上面一致（旧同名文件先删后放，不留旧版本）。
- 测试：后端 11 套 RAN 443 PASS 443 FAIL 0 ERR 0（api 33、backup 35、features 25、federation 75、groups 36、im 78、link 18、model 37、offline 28、onebot-plus 62、onebot 16）；安卓 5 套 RAN 266 PASS 266 FAIL 0 ERR 0（local-api 133、boot-login 28、shim 31、apk 29、federation 45）。合计 RAN 709 PASS 709 FAIL 0 ERR 0。

# v2026.11.15.0.10.14 — 2026-11-16

## 修掉「附近的实例」里混进自己

- 现象：加好友弹窗「同一个 Wi-Fi 下的实例」里会出现本机自己的地址（192.168.x.x:7788），点「加」等于给自己发好友申请。
- 根因：实例重启后 instanceId 可能变（换数据库/换网卡），只靠 instanceId 判自身会漏；UDP 广播来源是本机地址时也被当成别人。
- 修法：
  - 前端 web/src/views/shared/Dialogs.jsx 除了比 instanceId，还把 publicAddr / myAddresses / lanUrls 归一化成地址集合，地址命中的一律不算「附近的实例」。
  - 服务端 server/federation.js 的 onAnnounce 增加兜底：广播来源地址等于本机监听地址时直接丢弃。

### 产物

- 桌面 exe：release/FurryEverpony-2026.11.15.0.10.14.exe，160,539,005 字节，sha256 424789bb36a46a717d1c65569ebc91f1fa6bf26a5047cd094cf4f3378ead3490；启动器 139,264 字节（含 0.10.14），载荷 version=2026.11.15.0.10.14，web assets index-DblJUD_L.js / index-DuLawIYr.css。
- 安卓 APK：android/dist/FurryEverpony-2026.11.15.0.10.14.apk，874,115 字节，sha256 fabeb3f89ddf2fb16ddf54e97c483e6d305bd10783bafa1dde930dd67867f034，versionCode 101014。
- 已分发到桌面与 Downloads 的 FurryEverpony.exe / FurryEverpony.apk，哈希与上面一致；/apk 路由返回 200、874,115 字节。
- 测试：后端 11 套 RAN 435 PASS 435 FAIL 0 ERR 0（api 25、backup 35、features 25、federation 75、groups 36、im 78、link 18、model 37、offline 28、onebot-plus 62、onebot 16）；安卓 5 套 RAN 266 PASS 266 FAIL 0 ERR 0（local-api 133、boot-login 28、shim 31、apk 29、federation 45）。合计 RAN 701 PASS 701 FAIL 0 ERR 0。

# v2026.11.15.0.10.13 — 2026-11-15

## 加好友不再麻烦：自动通过 + 附近的人一键加

用户反馈「测试拒绝 这很明显太麻烦 不知道的人加好友只会难上加难」，这次把加好友从「手抄邀请码 + 对方点同意 + 回连确认」压成一步。

### 自动通过好友（默认开，可在「设置 → 实例互联」关掉）
- 服务端 `server/federation.js` 新增 `autoAccept()` / `setAutoAccept()`，开关存 `instance_meta` 的 `auto_accept`。
- `handleHandshake` 改为 async：对方用我的邀请码/二维码来加，直接 `notifyAccepted` 建立双向好友并回执 `friend: true`，不再插一条待处理申请；回执失败自动退回人工同意，不会把关系搞成单边。
- `/api/federation/invite/accept` 返回值新增 `friend`，前端据此直接显示「已加为好友，现在就能聊天了」。
- `/api/federation/settings` 支持 `autoAccept`，`/api/federation/info` 带出当前开关。
- 手机端 `android/server-src/fe/local/Federation.java` 同步实现：`autoAccept()` / `setAutoAccept()`、握手内自动通过、`sendRequest` 与邀请码接口透出 `friend`、设置接口支持 `autoAccept`。

### 附近的人一键加（同一个 Wi-Fi 不用任何输入）
- 加好友弹窗把「局域网发现的实例」从「点一下填地址」升级成列出对方实例里的账号（昵称 + 号码 + 头像），点「加」直接发申请；开了自动通过就是立刻成为好友。
- 实例没公布名单时，仍保留「点一下把地址填进去」的兜底。
- 弹窗里新增自动通过状态条，一眼能看出别人加你要不要你点同意。

### 测试
- 后端联邦测试 `server/scripts/test-federation.mjs`：RAN 75 PASS 75 FAIL 0 ERR 0（新增自动通过用例：关掉开关测人工同意、打开开关测邀请码一步成为好友、不留下待处理申请、自己的邀请码 400）。
- 安卓侧 `android/test/federation-test.mjs` 45/45、`android/test/local-api-test.mjs` 133/133。

### 产物
- 桌面单文件安装包 `FurryEverpony-2026.11.15.0.10.13.exe`：159,670,353 字节，sha256 `29cb160ddced7dab6776503b31eab2e887a983621a08ce9b4fccb8cf281dc08f`。
- 安卓安装包 `FurryEverpony-2026.11.15.0.10.13.apk`：874,114 字节，versionCode 101013，sha256 `620ff7b98e231cddebf8cfd3bc37b3895672d1700542c10b81747bf646c47879`，签名证书 CN=Furry Everpony。
- 全量测试：后端 11 套 RAN 435 PASS 435；安卓 5 套 RAN 266 PASS 266；合计 RAN 701 PASS 701 FAIL 0 ERR 0。
# v2026.11.15.0.10.12 — 2026-11-15

## 手机版补上跨实例（联邦）能力：终于能和电脑版互相加好友

- **新增 `android/server-src/fe/local/Federation.java`（约 1080 行）**：协议与电脑版 `server/federation.js` 一比一 —— 邀请码 `FEINV1.` 生成/解析、`/api/federation/{info,lookup,request,handshake,accept,deliver,profile,directory,bots}`、`x-fe-secret` 常数时间校验、UDP 7799 广播发现、离线外发队列（4 秒一轮，失败退避 5→300 秒，60 次放弃）。安卓 min-api 24 没有 `java.util.Base64`，所以自己写了 base64url。
- **手机不再显示「没有这个接口」**：原来 `Api.java` 里一条 `/api/federation/*` 都没有，未匹配的 `/api/*` 直接落 404「没有这个接口」，前端只能给红字。现在这些路由全部存在。
- **手机实例地址显示真实值**：`GET /api/server-info` 原来硬编码 `host="127.0.0.1"`、`lanUrls=[]`、`boundToLan=false`，设置页与加好友弹窗拿不到地址。改成走 `fed.info()` 枚举真实网卡。
- **手机 Bot 广场能看见电脑上的 Bot**：`GET /api/bots/public` 现在合并 `fed.remoteBots()`。
- **手机好友列表**带 `remote`/`addr`；给远端好友发消息自动进联邦外发队列；同意远端申请前先 `notifyAccepted`，失败返回 502 而不是假装成功。

## 电脑版：目录放宽到公开 Bot，Bot 广场跨实例

- `directory()` 与握手判定放宽：普通用户 + 公开 Bot 都可被跨实例查到/添加（原来只认 `type='user'`）。
- 新增无鉴权 `GET /api/federation/bots`，返回本实例公开 Bot 列表（最多 200 个），供别的实例抓取。
- `POST /api/federation/invite/accept` 查到人之后**自动发出好友申请**，返回体带 `requested` / `requestError`。
- `GET /api/bots/public` 重写为合并远端：本机公开 Bot + 最多 8 个已知远端实例的 Bot，远端项带 `remote/addr/instance`，并附 `note` 说明。

## 加好友弹窗重写：一个输入框，三种写法都能认

- 删掉「同一台服务器 / 别的服务器」两个标签页，只留一个输入框：**邀请码**、**地址 + 号码**、**纯号码**都能自动识别。
- 弹窗顶部固定显示「我的实例地址」「我的邀请码」，各带复制按钮；手机上 `navigator.clipboard` 在 http 页面不可用，已退回 `textarea + execCommand('copy')`，长按也能选中整段。
- 纯号码本地查不到时，会自动去附近实例逐个 `lookup`，再走跨实例申请，不再只报「没有这个号码」。

## 修：电脑版邀请码在只有局域网时生成不出来

- 现象：`GET /api/federation/invite` 返回 409「这台电脑还没有可以被外部连上的地址」，加好友弹窗里「我的邀请码」只能显示这句错误 —— 用户拿不到能发给手机的码。
- 修法：`makeInvite` 的地址候选在公网地址、公网 IPv6 之后补上局域网地址（同一 Wi-Fi 下手机直连即可用）。
- 实测：重启后 `/api/federation/invite` 返回 200，`addrs=["192.168.18.69:7788"]`，`boundToLan=true`；`test-federation` 仍 66/66。

## 测试

- 后端十一套 **RAN 426 PASS 426 FAIL 0 ERR 0**。
- 安卓四套：local-api-test 133、boot-login-test 28、shim-test 31、apk-test 29，新增 `android/test/federation-test.mjs` 45（同机双实例 17881/17882、账号 700001/700002，覆盖真实地址、401、目录、邀请码往返、自动申请、双向投递、Bot 广场、502 文案）→ 合计 **266**。
- 总计 **RAN 692 PASS 692 FAIL 0 ERR 0**。

## 产物

- 桌面：`dist/web`（index-5My2pUrU.js 453.63 kB、index-GjUk3vJK.css 147.38 kB）已部署到 `C:\Users\36328\Furry Everpony\resources\app`，`/api/health` = `{"ok":true,"version":"2026.11.15.0.10.12"}`。
- 安卓：`android/dist/FurryEverpony-2026.11.15.0.10.12.apk`，853.6 KB，sha256 `8f39e552306c309c1e0d0bcccfd1845605946fa87345c837920b0a0432de8738`，versionCode 101012。
- 桌面单文件：`release/FurryEverpony-2026.11.15.0.10.12.exe`，160,408,428 字节，sha256 `0b7055ca483c1c405889163565a0770a6a69bb68b51e37e3081df2433e767601`（桌面与 Downloads 各一份 `FurryEverpony.exe`，同哈希）。
- 打包踩坑：这台机器上「node 脚本 → csc.exe」这条链写不出 exe（CS0016/CS1567 拒绝访问），但「run_code 直连 csc」可以。已把 `tools/sfx/build-launcher.mjs` 的编译改成 spawnSync + 补 TEMP/SystemRoot，并在编译被拒时检查现成 `launcher.exe` 里的版本号是否匹配，匹配就复用、不中断打包。

# v2026.11.15.0.10.11 — 2026-11-15

## 跨网络加好友（不需要同一个 Wi-Fi，也不需要任何服务器）

- **服务端双栈监听**：局域网开关打开后绑 `::`（原来是 `0.0.0.0`，只收 IPv4）。IPv4 照旧可连，同时开始接收公网 IPv6 —— 这是「不在同一个 Wi-Fi 也能加好友」的前提。
- **公网 IPv6 自动探测**：新增 `publicV6Candidates()`，只挑全局单播地址（剔掉 `fe80::` 链路本地、`fc00::/7` 唯一本地、带 `%` 作用域的），`GET /api/federation/info` 多返回 `publicV6` 与 `publicV6Urls`。
- **邀请码**：`GET /api/federation/invite` 生成 `FEINV1.<base64url>`，内含地址候选列表 + 号码 + 昵称 + 24 小时有效期；`POST /api/federation/invite/accept` 粘贴解析，挨个地址试连，全不通时明确报「对方可能没有公网 IPv6，或光猫/路由器把入站拦了」。
- **前端**：加好友弹窗拆成「不同网络（邀请码）」与「填地址」两个模式，前者一键复制自己的邀请码、粘贴对方的邀请码直接查人；设置页「实例互联」显示公网 IPv6。
- **防火墙**：规则 profile 从 `private` 改为 `any`，公用网络（手机热点、公司 Wi-Fi）下也能被连进来。

## 界面细节（自查发现）

- 修：设置 →「关于」里的「监听地址」原来直接显示 `:::7788`（双栈绑定的原始值），看不懂。改成「全部网卡（IPv4 + IPv6）:7788」。
- 修：加好友弹窗里自己的邀请码原来整串铺开、框里出现滚动条。改成只显示前 64 个字符 + 省略号，完整串点「复制」拿，框不再溢出（实测 scrollHeight === clientHeight）。

## 测试

- 后端十二套 **RAN 426 PASS 426 FAIL 0 ERR 0**（test-federation 从 48 增到 66，新增 18 条邀请码用例：401、无地址 409/有 IPv6 可生成、有效期、地址列表、自己的码、重复查、截断、非邀请码、过期、非法号码、IPv6 地址解析、info 字段）。
- 安卓四套：local-api-test 133、boot-login-test 28、shim-test 31、apk-test 29，合计 221 全绿。
- 总计 **RAN 647 PASS 647 FAIL 0 ERR 0**。

## 部署验证

- 双栈生效：`netstat -ano` 同时出现 `0.0.0.0:7788 LISTENING` 与 `[::]:7788 LISTENING`。
- 公网 IPv6 直接访问本机服务：`http://[2409:8a55:b48d:bc40:c3ce:900a:262f:b5c8]:7788/api/health` 返回 200 与 `{"ok":true,"version":"2026.11.15.0.10.11"}`。
- 邀请码实测：`GET /api/federation/invite` 返回 200，`addrs` 含三段公网 IPv6（`[2409:8a55:b48d:bc40:c3ce:900a:262f:b5c8]:7788` 等）。
- 手机视口（390×844 dpr2）截图：加好友弹窗两种模式都不溢出。

## 产物

- 桌面单文件：`release/FurryEverpony-2026.11.15.0.10.11.exe`，159,539,453 字节，sha256 `414afdfa0dca006150b4ca9f144baf53e912ed03fe838ab2d77a1335f04ccef7`；桌面与 `C:\Users\36328\Downloads\` 各一份同哈希副本。
- 安卓：`android/dist/FurryEverpony-2026.11.15.0.10.11.apk`，857,731 字节，sha256 `47eadaf2cc0cfd08eda4bda880999aa2b00cccb2e15ef058020c4b08e5730990`。

## 自查 bug：exe 打包链路不重编启动器

- 现象：按老流程打完 exe，装好一跑 `/api/health` 还是 0.10.10。查 `%TEMP%\fe-sfx.log` 看到「目标目录=…app-2026.11.15.0.10.10 已解包=True」——解包的是旧版本。
- 根因：`pack-sfx.mjs` 只负责「启动器 + 载荷 + 尾标」拼接，从不重新编译 `Launcher.cs`；而启动器里硬编码了两处版本（`const string Version` 与 `AssemblyInformationalVersion`），所以 exe 名义版本对、实际跑的旧版。
- 修法：新增 `tools/sfx/build-launcher.mjs`（读 package.json 的 version，改 `AssemblyVersion` / `AssemblyFileVersion` / `AssemblyInformationalVersion` / `const string Version`，再用 `Framework64\v4.0.30319\csc.exe` 编译），`tools/sfx/pack-sfx.mjs` 第 0 步先调它；`.tools/pack-sfx.mjs` 变成薄封装。
- 验证：重打后启动桌面 exe，日志显示「目标目录=C:\Users\36328\AppData\Local\FurryEverpony\app-2026.11.15.0.10.11 已解包=False」「条目数=2020」「已清理旧版本目录 app-2026.11.15.0.10.10」；`/api/health` = `{"ok":true,"version":"2026.11.15.0.10.11"}`；`/apk` 返回 200 与 857,731 字节；`netstat` 同时有 `0.0.0.0:7788` 与 `[::]:7788` LISTENING。
# v2026.11.15.0.10.10 — 2026-11-15

### 实例互联（跨实例查到人 + 加好友 + 聊天）

- 新增：局域网自动发现。同一 Wi-Fi 下的实例用 UDP 7799 广播互相打招呼（5 秒一次，20 秒内算在线），不需要任何中心服务器、不需要填 IP。
- 新增：跨实例加好友。加好友弹窗分两个标签页：「同一台服务器」走原号码流程；「别的服务器 / 别人的电脑」可以点选发现的实例或手填地址（`192.168.1.8:7788`、DDNS 也行），填对方号码 → 查资料 → 发申请。
- 新增：对方同意后双方自动成为好友，并交换一次性共享密钥；之后的消息由实例直接投递给实例（`POST /api/federation/deliver`，`x-fe-secret` 校验），不经过任何第三方。
- 新增：消息投递队列。对方离线/关机时消息进 `federation_outbox`，按 5 秒、10 秒、20 秒……最多 300 秒的间隔重试，最多 60 次，对方一上线就送到。
- 新增：设置 →「实例互联」卡片，显示我的实例地址（可一键复制）、可手填对外地址（公网 IP / DDNS）、列出同一 Wi-Fi 下发现的其它实例。
- 新增：好友列表里跨实例的好友带「远程」标记，鼠标悬停显示来自哪个地址。

### 账号搬迁（换设备不丢数据）

- 新增：设置 →「账号搬迁」。导出成加密包（`.feacct`，scrypt 派生密钥 + AES-256-GCM），换电脑或换手机时导入，好友、会话、消息、群、收藏、Bot 全部回来，原密码照样能登录。
- 安全：包里别人的密码哈希一律清空，只有自己的保留；密码不对打不开；号码在新实例已被占用时拒绝导入（409），不会覆盖别人。
- 导入成功后自动登录并刷新界面，不用再手输号码。

### 手机端

- 修：安卓端「删掉后台就要重新登录」。根因是登录态只存在网页 localStorage，而 localStorage 按端口隔离，服务端重启后端口漂移就找不到 token。现在：端口优先复用上次成功的端口（`SharedPreferences` 记住），并且服务端把 token 落盘、在返回首页时注入 `localStorage`，杀后台重开直接是登录状态。
- 新增：界面登录/退出/切号时同步本机 token（`POST /api/native/token`），桌面端没有这个接口，失败静默不影响任何流程。

### 测试

- 新增 `server/scripts/test-federation.mjs`（48 条，两个真实实例两个临时库）：地址归一化与非法地址、远端查号、跨实例申请→审批→双方好友、跨实例发消息与回复、投递队列、密钥错误/陌生实例 403、离线实例报错。
- 新增 `server/scripts/test-backup.mjs`（35 条）：导出鉴权与密码校验、包是密文、别人哈希清空、号码冲突 409、导入后好友/会话/消息/群/收藏/Bot/原密码登录全部恢复。
- 后端十一套合计 RAN 408 / PASS 408 / FAIL 0 / ERR 0。
- 安卓四套：local-api-test 133、boot-login-test 28、shim-test 31、apk-test 29，合计 221 全绿。总计 RAN 629 / PASS 629 / FAIL 0 / ERR 0。

### 界面排版修复（自查发现）

- 修：设置页里「复制」「保存」「下载 APK」「放行防火墙」等按钮被撑成整行宽。根因是老样式表 `web/src/styles.css:875` 的 `.btn-ghost { width: 100% }` 与 `styles.css:151` 的 `.btn-primary { width: 100% }`，新样式层从未覆盖宽度。现在设置卡片内按钮按内容宽度排（实测「复制」69px、「保存」48px，此前都是 1020px）。
- 修：「手机打开这个地址」那一行的地址按钮被挤成半截、文字截断。改为独立成行、内容宽度、地址不换行，手机断点下整行宽。
- 修：跨实例加好友弹窗里「我的实例地址」标签被挤断行、地址块撑出大片空白。改为标签不换行、弹窗内纵向紧凑排列（高度 273px → 112px）。

### 产物

- APK：`android/dist/FurryEverpony-2026.11.15.0.10.10.apk` 857,732 字节，sha256 `47690a200d064c5c0c4735399b51f358a3aaa50f9b49e30b3839b967e54238c9`。
- 单文件 exe：`release/FurryEverpony-2026.11.15.0.10.10.exe` 159,534,900 字节，sha256 `05b0b57429fec78e65fb062c218f46533aacc2aa84cba99e4613ea5ae9109873`；桌面 `FurryEverpony.exe` 与 `FurryEverpony.apk` 同版。
- 部署：`C:\Users\36328\Furry Everpony\resources\app`，`/api/health` = `{"ok":true,"version":"2026.11.15.0.10.10"}`。

# v2026.11.15.0.10.9 — 2026-11-15

### 手机端

- 修：群资料抽屉在手机上点开就黑屏、退不出去。根因是浮层入场动画用了 `animation ... both`，动画没跑起来就停在 `opacity: 0`，只剩一层黑遮罩。已去掉 `both` 填充，手机断点与「减少动态效果」下直接不播动画。
- 修：返回键在抽屉/弹层打开时直接退出应用。现在网页先接管（`window.__feBack`），关掉最上层浮层；没人接管才回退网页历史，再不行才两次返回退到后台。
- 新增：群资料里直接「退出这个群」（手机端此前没有入口）。
- 修：群资料标题后面显示 `[object Object] 人`。手机端本机服务端把成员数组塞进了 `members` 字段，桌面端返回的是人数，现已统一成人数；界面同时兼容两种形状。
- 新增：手机 App 可以「连接电脑或朋友的实例」。设置 →「连接的实例」可切本机模式 / 连到指定地址；启动页与错误页都有入口。两台手机各自一套库，号码天然不通，要互加必须连到同一个实例。
- 新增：崩溃兜底页（React 错误边界），界面某块炸了不再整屏空白。

### Bot

- 新增 OneBot 11 动作 `set_input_status`：Bot 自己声明「正在输入 / 停止输入」（`event_type=2` 为停止），群里按 `group_id`、私聊按 `user_id`，界面被动显示，不再由服务端猜。

### 测试

- 新增 `server/scripts/test-offline.mjs`（28 条）：离线期间发的消息上线必须收到、发完就退对方上线必须收到、下线期间的群消息必须看到、重启服务端历史不丢、退群后看不到群消息、被重新拉回群历史还在。
- 后端九套合计 RAN 315 / PASS 315 / FAIL 0 / ERR 0；安卓三套 local-api-test 107、shim-test 31、apk-test 29 全绿。

## v2026.11.13.0.7.0 —— Bot 独立成页 + 图片 + 撤回 + 群成员

### 新增
- Bot 从设置里搬出来，rail 上的 Bot 图标现在是真的页面：我的 Bot（创建、在线状态、token 复制、点一下直接聊）+ Bot 广场（搜索、加好友、发消息）
- 建 Bot 后自动和主人互为好友，建完立刻能聊
- 发图片：输入区「图片」按钮，自动压到 1280 以内，气泡里直接显示
- 撤回：自己两分钟内的消息，鼠标悬停点「撤回」，双方都显示「这条消息已撤回」
- 群成员：群聊头部「群成员」按钮，看成员和群主，底部可以退出这个群

### 变更
- 设置页只留账号资料、切换账号、退出、注意事项
- 消息表加 kind（text/image）与 recalled 两列，老库自动迁移

### 测试
- test-api 25/25、test-onebot 16/16、test-groups 32/32，共 73 条

## v2026.11.13.0.6.2 —— 切换账号常驻

### 修复
- 「切换账号」之前只在已经存过第二个账号时才显示，只有一个账号的用户根本看不到 —— 现在常驻在设置里
- 新增「＋ 登录另一个账号」：直接进登录页，当前账号不会被退出，登录完自动加进列表，随时能切回来

## v2026.11.13.0.6.1 —— 头像、群聊界面、空状态

### 新增
- 头像：`accounts.avatar` 存 256×256 PNG data URL；设置里点头像即可换，前端自动压缩；会话列表、气泡、聊天头部、侧边栏全部用真头像
- 资料编辑：`PATCH /api/me` 改昵称与签名，失焦自动保存
- 群聊界面：联系人面板里「建群 / 用群号加入 / 我的群」，群会话在消息列表里跟私聊并列，群消息显示发送者昵称
- 空状态：没有会话时给「加个好友 / 建个群 / 养个 Bot」三个入口，不再是一片空白

### 修复
- `findAccountByNumber`、`auth`、好友列表、会话对端、Bot 广场、群消息发送者全部带上 `avatar` 字段
- 文档里数据库路径写错：实际是 `%APPDATA%\furry-everpony\data\everpony.db`

### 测试
- test-api 25/25、test-onebot 16/16、test-groups 32/32，共 73 条全过

## v2026.11.13.0.6.0 —— 桌面打包 + 数据库换成 Node 内置 SQLite

### 新增
- Electron 45.3.1 + electron-builder 26.18.0 打包：`npm run pack` 出 `release/win-unpacked`，`npm run dist` 出 NSIS 安装包
- `electron/main.cjs`：主进程内起服务端（数据库放 `%APPDATA%\furry-everpony\data\everpony.db`），单实例锁，端口被占就复用已有实例
- 服务端托管 `dist/web` 静态产物：桌面端用 `http://127.0.0.1:7788/` 打开，前端相对路径请求天然成立
- 应用图标：`docs/assets/icon-1024.png`、`icon.ico`（16–256 七档）、Android 五档 mipmap，全部保持透明底

### 变更
- 数据库驱动从 `better-sqlite3` 换成 Node 内置 `node:sqlite`（Node 22 / Electron 45 的 Node 24 都自带）——不再有原生模块，打包不需要 Python 和 MSVC，也不会因为 ABI 对不上而炸
- `server/db.js` 加一层薄垫片，保留 `pragma()` / `transaction()` 写法；**嵌套事务自动降级成 SAVEPOINT**（与 better-sqlite3 行为一致）

### 修复
- `api()` 给 GET 请求也带 body，浏览器直接报 `Request with GET/HEAD method cannot have body`，导致登录态校验永远失败

### 测试
- `test-api.mjs` 25/25、`test-onebot.mjs` 16/16、`test-groups.mjs` 32/32，共 73 条全过（换数据库驱动后回归）

## v2026.11.13.0.5.0 —— 群聊 + Bot 广场 + 发言排行

### 新增
- 群：建群（6–9 位群号）、进群、邀请、群成员、群消息；群对应一个 `kind='group'` 的会话
- OneBot 11 群能力：`get_group_list` 返回 Bot 所在的群，群里有人说话推 `message_type='group'` 事件，`send_group_msg` 让 Bot 在群里回话
- Bot 广场：Bot 可以标记为公开，别人在联系人页的广场里搜号码/名字、看简介和「多少人加了它」，一键加好友
- Bot 发言排行：`GET /api/bots/:number/stats` 统计和这个 Bot 私聊最多的人（只有 Bot 主人能看）

### 接口
- `POST /api/groups`、`GET /api/groups`、`POST /api/groups/:number/join`、`POST /api/groups/:number/invite`、`GET /api/groups/:number/members`、`POST /api/groups/:number/messages`
- `GET /api/bots/public?q=&limit=&offset=`、`PATCH /api/bots/:number`（改昵称/简介/是否公开）
- `POST /api/bots` 支持 `bio` 与 `public`

### 修复
- `findAccountByNumber` 少了 `owner_id` / `is_public` 两列，导致 Bot 主人校验永远失败（PATCH 和排行都 404）

### 测试
- 新增 `server/scripts/test-groups.mjs`：32 条全过
- `test-api.mjs` 25/25、`test-onebot.mjs` 16/16 回归通过

## v2026.11.13.0.4.1 —— 账号模型：个人 / 为您的孩子

- 登录页只出现个人账号，卡片下方一行提示「创建账号后可以为您的孩子也创建多个账号」
- 新增设置弹层（点齿轮进入）：账号、切换账号、退出登录、为您的孩子（Bot 列表 + 在线状态 + token 复制 + 创建）、限制与注意事项
- 本机登录过的账号记在 `localStorage.fe_accounts`，设置里可一键切换
- 限制与注意事项写清「删软件 = 数据不存在」「没有找回密码」「号码不能改」「token 是钥匙」
- 修：`.auth-wrap` 改成纵向布局，脚注不再跑到卡片右边

## v2026.11.13.0.4.0 —— OneBot 11 接入

- 新增 `server/onebot.js`：OneBot 11 协议端，AstrBot 这类客户端连 `ws://127.0.0.1:7788/onebot/v11/ws` 就能把这里的 Bot 当成普通 QQ 账号
- 支持事件：`meta_event`（lifecycle / 心跳 30 秒）、`message/private`、`notice/friend_add`
- 支持操作：`get_login_info`、`get_status`、`get_version_info`、`get_friend_list`、`get_group_list`、`get_stranger_info`、`send_private_msg`、`send_msg`、`get_msg`、`delete_msg`、`can_send_image`、`can_send_record`
- Bot 账号：`accounts` 加 `owner_id`、`access_token`；新增 `POST /api/bots`、`GET /api/bots`、`POST /api/bots/:number/token`
- 新增 `groups` / `group_members` 两张表（群消息下个版本接）
- 加 Bot 为好友立即生效（审批 UI 后面补）
- `server/scripts/test-onebot.mjs`：16 条用例全过；`test-api.mjs` 回归 25 条全过

## v2026.11.13.0.3.1 —— 界面跑通真实数据

- 修 bug：前端 `api()` 给 GET 请求也塞了 body，浏览器直接拒绝（`Request with GET/HEAD method cannot have body`），导致登录态失效、永远停在登录页
- 修 bug：无头浏览器有最小窗口宽度 510，手机截图改用 390 宽 iframe + 裁切
- 会话列表默认打开最近一条，进来就能看到消息
- 输入框改成灰底圆角块，发送按钮不再悬空

## v2026.11.13.0.3.0 —— 好友与私聊打通

- 后端新增 friend_requests / friendships / blocks 三张表，conversation_members 加 last_read_id
- 新增接口：查找用户、好友列表、好友申请/同意/拒绝/删除、会话列表、拉消息、发消息、标记已读、按号码开私聊
- Fastify 允许空 JSON body（否则 POST 无 body 直接 400）
- `server/scripts/test-api.mjs`：25 条用例全过

## v2026.11.13.0.2.0 —— 后端骨架与登录页

- Fastify + better-sqlite3 骨架，6 张表
- 号码注册 / 登录 / me / logout，scrypt 密码，Bearer 会话
- React + Vite：登录页与三栏主界面（QQ NT 布局，QQ 蓝）

## v2026.11.13.0.1.1 —— 底座改为 Matrix（仍无代码）

- 新增 `docs/06-基于Matrix的改造方案.md`：协议层改用 Matrix homeserver，我们只写旁路层与客户端
- 重写 `docs/01-技术选型.md`：tuwunel + Fastify sidecar + React/matrix-js-sdk 三层
- 重写 `docs/05-路线图.md`：工期按新架构重算，v0.1 收敛为「单实例能聊天」
- 需求清单 24 条不变，仅落地方式改变
- 待拍板：客户端走「改 Element」（AGPL 传染）还是「自写客户端」（推荐）

## v2026.11.13.0.1.0 —— 项目初始化（仅文档）

- 建立项目目录结构与项目规则 `AGENTS.md`
- 完成需求清单（24 条主需求 + 3 条补充 + 9 条视觉需求，已定稿）
- 完成技术选型、数据模型、架构与互联、视觉规范、路线图
- 视觉方向定稿：结构取 Linear、色温取 Claude、科幻细节取 xAI，双主题 FE-Dawn / FE-Void
- 无代码，无可运行产物

### 未定项

- 开源许可证（默认 MIT，待确认）
- 邮箱验证是否默认开启（默认关，待确认）

# v2026.11.15.0.10.8

手机端真机可用性收尾：界面在手机自带的服务端上完整跑通，两处会误导人的提示改掉。

## 手机端
- **界面跑在本机服务端上已验证**：用无头浏览器连桌面 JVM 跑起的同一套 Java 服务端，走真实界面登录（778001）、打开会话、发送消息，服务端数据库里确实多了这条消息（共 2 条，最后一条来自界面），发送失败气泡 0 个。
- **Bot 创建给明确提示**：手机版原来点「创建 Bot」会撞 404「没有这个接口」，现在返回「手机版不创建 Bot：Bot 要有一台一直开着的电脑跑接入服务，请在电脑版创建」。

## 界面
- **设置页 APK 行按端区分**：手机上看设置时不再显示「这台电脑上还没有打包好的 APK」，改为服务端给的说明「手机端自己就是服务端，不需要再下载安装包」，也不再出现下载按钮。

## 修复：收消息看起来「卡住」

- **真根因是轮询被每秒重渲染打断**：只要有一个会话在「正在输入」，界面每秒刷新一次，而消息轮询的 useEffect 依赖了一个每次渲染都会变的回调 → 定时器每秒被清掉重建，永远等不到触发点。表现出来就是「对方回了我这边一直卡住」，服务端其实早就把消息写进去了。改成轮询只跟会话 id 绑定（回调放 ref），并加 4 秒看门狗，超过 8 秒没有一次成功轮询就强制重启。
- **Bot 回复期间提示不再提前消失**：后端每 4 秒续期一次「正在输入」（原来 15 秒过期，而接 AstrBot 的 Bot 平均 20 秒才回），界面按对方类型显示「正在思考…」/「正在输入…」。
- **Bot 没接上话不再一声不吭**：先收掉提示，再落一条 Bot 消息「（我这边没接上话，等下再聊？）」。
- **窗口被遮挡或最小化时也照常收消息**：桌面主进程加 backgroundThrottling: false。
- **修掉连带 bug**：内置模型没接管时（没配模型 / 对面也是 Bot）不再误清 OneBot 的「正在输入」。

# v2026.11.15.0.10.7

手机端不再依赖电脑：App 自己就是服务端。

## 手机端（重做）

- **本机服务**：手机里内置一个用 Java 写的 HTTP 服务端（android/server-src/fe/local/，零第三方依赖），App 启动时在本机 7788 端口跑起来，界面直接连 127.0.0.1，不需要电脑在线、不需要填地址。
- **数据在手机里**：账号、好友、消息、群聊、收藏、通知全部存在 App 私有目录（dataDir/local-db.json，临时文件 + 改名写入，断电不坏）。注册、加好友、聊天、群聊都能在手机上独立完成。
- **界面文件随包**：vite 构建产物打进 APK 的 assets/web，首次启动解压到私有目录，版本号变了才重新解压（web/.version 比对）。
- **端口固定优先**：先试 7788，被占用才往后找，避免端口变化导致 localStorage 里的登录态失效。
- **删掉连接器时代的东西**：Discovery.java、ServerStore.java 与「手动输入地址」入口全部移除，启动页改成「独立即时通讯 · 数据都在手机里」，错误页只留「重试」和「退出应用」。
- **手机版不跑的接口**：Bot 广场 / AstrBot 平台扫描返回空列表（不报错），Bot 请在电脑版使用。

## 接口

- 补 `POST /api/conversations/:id/forward-merge`（多选合并转发，kind=merge，正文 `[聊天记录] N 条`，meta 带 title/count/items），电脑端与手机端行为一致。

## 测试

- 新增 `android/test/local-api-test.mjs`：在桌面 JVM 上真起 HTTP 服务打 107 条用例（注册/登录/好友/分组/私聊/引用/表情/收藏/仅自己删除/转发/合并转发/搜索/群全套/禁言/公告/群文件/上传/通知/静态兜底/退出登录失效），RAN 107 PASS 107。
- APK 包体校验扩到 28 条：新增「本机服务端类进包」「assets/web 界面文件进包」「没有把电脑端服务端打进去」。
- 修掉真问题：aapt2 在 Windows 上把 assets 子目录写成反斜杠路径（assets/web\\assets\\x.js），安卓按正斜杠找资源会全部读不到 → 改用 jar 以正斜杠写入。

# v2026.11.15.0.10.6

这一版修两个真问题：把安装包发给别人，在只装了 .NET 4.0 的电脑上打不开；手机端下载入口给的是旧版安装包。

## 安装包（exe）

- **不再依赖 .NET 4.5**：自解压启动器原来用 `System.IO.Compression.ZipArchive`（.NET 4.5 才有），在只装了 .NET 4.0 的电脑上会弹「未能加载文件或程序集 System.IO.Compression, Version=4.0.0.0」。现在启动器自带 ZIP 解析（中央目录 + DeflateStream 解压），只引用 .NET 4.0 就有的程序集，装不上新版 .NET 的机器也能解包启动。
- **老系统直接说清楚**：系统低于 Windows 10（构建号 < 10240）时，启动器不再解包 370MB 再抛一串 DLL 错误，而是弹中文说明「这个版本需要 Windows 10 或更高版本」，并给出两条替代路：换 Win10/11 电脑、或用手机 App 连已经在跑的那台。
- **失败能查**：启动器日志新增「运行时=」「系统=」「系统构建=」三行，对方机器缺什么一眼能看出来（本机实测：`Environment.OSVersion` 报 6.2，注册表构建号 19045，说明只能查注册表）。

## 手机端

- **下载入口不再发旧包**：`/apk` 之前按文件修改时间挑安装包，刚被复制过的旧包会被当成最新，导致手机下到旧版。现在按版本号逐段比较，版本相同才看时间。

## 工程

- 后端测试 276 → 277 条（新增「挑的是版本号最新的包，不是时间最新的旧包」用例）。
- 新增 `.tools/pack-sfx.mjs`：一条命令同步代码进打包目录、压缩载荷、拼出单文件 exe。
- 交付包：158,773,477 字节，sha256 `a966d255a57986344c9c2b11e0aad2aee925f428ef3efb18c852d2b7953cb93a`；干净状态首启 36 秒，`/api/health` = {"ok":true,"version":"2026.11.15.0.10.6"}。

# v2026.11.15.0.10.5

这一版重做手机端：以前装完打开是个「连接器」，要自己填电脑地址才能用；现在打开就自动找、自动进，断开有原生错误页，网页里的通知会走手机系统的通知栏。

## 手机端（重做）

- **打开就能用**：启动先试上次连过的地址，连不上或没有记录就自动扫同一 Wi-Fi，找到唯一一台电脑直接进聊天，找到多台才让你选。手填地址还在，但折叠在启动页下方，只在自动发现失败时出现。
- **启动页**：品牌图形 + 进度文案（「正在同一 Wi-Fi 下找你的电脑…」「已检查 96 / 254 个地址…」），不再是黑屏等 WebView。
- **原生错误页**：连不上时不再是白屏或浏览器的错误提示，而是本产品自己的页面，写清楚「连不上服务器」「电脑可能关机了，或者手机换了网络」，并给三个按钮：重试 / 重新搜索局域网 / 手动输入地址。服务器 5xx 也会转成这个页面。
- **系统通知**：网页里的 `new Notification(...)` 被接管，转给 Android 通知渠道「消息通知」（高优先级、带振动、点击回到 App）。另外钩住会话列表轮询：页面在后台且未读数比上次大时，按未读最多的会话弹一条通知，标题优先用好友昵称、群名，正文用最后一条预览。前台不打扰。
- **返回键**：错误页上按返回 = 重试；网页能后退就后退；再按一次才退到后台（Toast 提示），不会一按就把正在用的界面关掉。
- **探测更快**：局域网扫描改成先 TCP 连端口（260ms 超时、96 线程并发），端口通了再打 `/api/health` 确认是本产品，比直接发 HTTP 快一个量级。
- **版本号单一来源**：App 里显示的版本来自构建时生成的 `BuildInfo.java`，源头是 `package.json`，不再手改。

## 工程

- 新增 `android/test/apk-test.mjs`：用 `aapt2 dump badging` 校验打出来的 APK —— versionName 与 package.json 一致、versionCode 按 主/次/修 推出、minSdk 24 / targetSdk 34、通知与联网权限都在、dex 里确实有 MainActivity / Discovery / Notifier / fe_messages / 启动页文案，并校验签名证书。
- `android/test/LogicTest.java` 从 18 条扩到 29 条：加了 TCP 端口探测、`probeBase("")`、没有 Context 时 `prefixes(null)` / `scan(null,null)` 的兜底。
- `android/test/shim-test.mjs` 从 16 条扩到 31 条：原生通知接管、后台未读弹通知、未读不涨不重复弹、前台不打扰、群消息标题与「你收到 N 条新消息」兜底、桥缺失时不接管。

# v2026.11.13.0.10.4

这一版补上了手机端：一个能装的安卓 App，以及电脑端设置页里的安装包下载入口。

## 新增

- **安卓 APK（瘦客户端）**：WebView 壳 + 局域网自动发现。界面仍由电脑上的服务端提供，所以服务端升级不用重装 App；App 自己只负责找服务器、把 WebView 指过去、补手机端缺的能力。包名 `dev.furryeverpony.app`，minSdk 24 / targetSdk 34，装出来约 25KB。
- **局域网自动发现**：点「搜索局域网里的服务器」，对手机当前 /24 网段 32 线程并发探 `/api/health`，要求 200 且同时含 `ok` 与 `version` 才认，避免把别的 7788 端口服务当成本产品。
- **地址输入容错**：`192.168.1.108`、`192.168.1.108:7788`、`http://x:7788/`、`[::1]` 都能规范化成可用基地址；只写了 `http://` 这种没主机的会判为无效而不是拼出 `http:`。
- **手机端三个 Web API 缺口补齐**：http 局域网不是安全上下文，`navigator.clipboard`、`crypto.randomUUID`、`navigator.serviceWorker` 会缺失，App 在页面加载后注入补丁（已有实现不覆盖，连跑两次也不重复包装）。
- **设置页「下载 APK」**：桌面端「设置 → 手机与局域网」新增一行，显示版本与体积，点一下就把安装包递给手机；服务端新增 `GET /api/apk/info` 与 `GET /apk`（后者不校验登录，手机首次装 App 时还没账号）。

## 工程

