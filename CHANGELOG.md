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

- 打包链路不用 Gradle / Android Studio：`aapt2` 编资源 → `javac` → `d8` 转 dex → `zipalign` → `apksigner`，脚本是 `android/build-apk.mjs`，versionCode 由版本号推出（0.10.4 → 101004），保证覆盖安装不冲突。
- 签名密钥 `android/keystore/fe-release.jks` 必须保留，换钥匙会导致已装用户无法覆盖升级。

# v2026.11.13.0.10.3

这一版修的是「明明写了却不生效」和「接上框架就报错」两类问题：正在输入、合并转发、聊天背景入口、AstrBot 指令、稳定性。

## 修复

- **「对方正在输入…」永远不出现**：typing 只在人与人之间有效，而这个实例唯一的聊天对象是 Bot——Bot 收到消息时服务端根本没置过 typing，所以永远等不到。现在 Bot 一收到消息就置 15 秒 typing，回话或断开立刻清除；typing 有效期从硬编码 6 秒改为可传参。
- **AstrBot 报「不支持的操作：send_private_forward_msg」，指令用不了**：OneBot 实现只认 12 个 action，AstrBot 的合并转发与群管理链路一律 1404。现在 action 覆盖到 60 多个，含 `send_private_forward_msg`、`send_group_forward_msg`、`send_forward_msg`、`get_forward_msg`、群禁言、群名片、群文件、群公告、历史消息、撤回。
- **消息段全被拍平成纯文本**：以前收到消息只取文本，at / 回复 / 图片 / 语音 / 文件 / 合并转发全丢，raw_message 也不对。现在收发双向解析 CQ 码与段数组。
- **图片语音「不支持」**：`can_send_image` 以前直接回 no，`get_image` 抛异常。现在 base64://、http(s)://、file:// 与本地路径都能落盘成 `/uploads` 地址，按魔数判扩展名，上限 25MB。
- **反向 WS 启动后不会自动连**：进程启动时从来没调用过 `startOutLinks()`，只有手动点「连接」才连上。现在监听成功后自动恢复所有已启用的接入。
- **桌面版反向 WS 从来没连过（部署阶段挖出的致命根因）**：0.10.3 起桌面端把服务端改成子进程托管，`electron/server-host.cjs` 只调 `buildServer()` + `listen()`，而 `startOutLinks()` 只写在「直接 node 运行」那条分支里——于是桌面版 Bot 恒离线、typing 永不到来、AstrBot 收不到消息。现在 `startOutLinks()` 收进 `buildServer` 的 `onListen` 钩子，两种启动方式共用；顺手修掉子进程托管下日志每行重复两遍（`echo: !process.send`）。

## 新增

- **日志落盘**：服务端日志写 `<数据目录>/logs/app-YYYYMMDD.log`，按天滚动保留 7 天；HTTP 500、未捕获异常、未处理的 Promise 拒绝全部落盘且不让进程退出。可用 `FE_LOG_DIR` / `FE_LOG_LEVEL` 覆盖。
- **OneBot 群管理**：禁言 / 全员禁言 / 群名片 / 群名 / 踢人 / 退群 / 群文件 / 公告 / 精华 / 历史消息 / 撤回。

## 测试

新增 `server/scripts/test-onebot-plus.mjs` 52 条，八套合计 RAN 271 / PASS 271 / FAIL 0 / ERR 0。

真机验证（Electron + CDP，2026-11-14 07:50–07:56）：正在输入三处同显；合并转发卡片与查看器正常；「更多」→ 聊天背景面板可开；杀掉服务端子进程后 1.2 秒出现顶栏断线提示、16 秒内自动重启并恢复、提示自动收起；日志 app-YYYYMMDD.log 同时含 [main]/[console]/[server] 行、保留 7 天。

# v2026.11.13.0.10.2

这一版把「看得见的毛病」一次性清掉：发送失败、手机连不上、资料卡、聊天背景、头像框、昵称字体、消息多选、退出登录，并给整个界面补上过渡动画。

## 修复

- **发消息「发送失败」**：前端四种发送都把 `replyTo` 写成 `reply?.id || null`，服务端 `zod` 的 `.optional()` 不接受 `null`，于是普通消息（不引用）100% 被 400 打回，只有引用回复能发出去。服务端改 `.nullable().optional()`，前端改为不引用时根本不传该字段。
- **手机打不开局域网地址**：`/api/server-info` 把 `networkInterfaces()` 里所有非 internal 的 IPv4 都塞进 `lanUrls`，本机顺序里 `vEthernet (WSL) 172.17.16.1` 排在 `WLAN 192.168.1.108` 前面，用户点第一个必然是打不开的虚拟网卡。现在过滤 WSL/Hyper-V/VirtualBox/VMware/Loopback/Tailscale/ZeroTier/Docker/Bluetooth 与 `169.254.*`，WLAN/以太网优先，并新增 `lanNames` 让设置页显示网卡名。
- **头像上传报「格式不对」**：前端把头像压成 1280px PNG，base64 常超 400KB 上限被拒。头像改为 256px JPEG（几十 KB），服务端上限放宽到 800KB 并允许 gif。
- **「发送失败」不能重发**：失败气泡上的红字改成可点按钮，点一下自动重发。

## 新增

- **聊天背景**：可多选添加（最多 12 张）、点选切换、单张删除、全部删除、一键恢复默认；本机保存，切主题不影响。
- **资料卡**：自定义背景图 + 最多 9 张公开照片，好友点开资料卡能翻看大图。
- **头像框**：内置六款（无 / 霓虹 / 流光金 / 糖果 / 像素 / 轨道）。
- **昵称字体**：内置五档（默认 / 圆体 / 衬线 / 等宽 / 加粗）。
- **消息多选**：聊天头部新增多选按钮，选中后底部出现「已选 N 条」工具条，可合并转发。
- **Bot 入口**：侧栏底部新增 Bot 按钮，一键直达 Bot 广场，不再需要翻「发现」。
- **设置页**：「放行防火墙」按钮（一键加 Windows 入站规则）、「退出应用」按钮（真退出，不是最小化到托盘）。
- **消息里的链接可点**：http/https 自动识别成链接，桌面端用系统浏览器打开。

## 调整

- 「清空本地数据」从通知卡片里挪到页面最底部的红色危险区，带红字警告和二次确认。
- 局域网地址列表显示对应网卡名，并提示「手机和电脑要在同一个 Wi-Fi」。
- 补充全站过渡动画（页面切换、卡片入场、弹窗、按钮悬停），并尊重 `prefers-reduced-motion`。

## 测试

- 七套后端测试全绿：test-api 25、test-onebot 16、test-groups 36、test-features 25、test-model 27、test-link 18、test-im 72 —— **RAN 219 PASS 219 FAIL 0 ERR 0**。

# v2026.11.13.0.10.1

这一版只修交互，不加新功能：退出、全屏、右键、点空白关闭、手机连不进来。

## 修复

- **点叉退不出去**：`mainWindow.on('close')` 原来无条件 `preventDefault()` 并隐藏到托盘，叉号等于永远退不掉。改为默认真退出；想常驻托盘的用户可在「我的 → 桌面窗口」里打开「点叉时最小化到托盘」。实测点叉后进程数 0、7788 端口关闭。
- **右键没有「粘贴」**：主进程 `Menu.setApplicationMenu(null)` 把默认菜单关掉了，Electron 也就不再有原生右键菜单。已补 `contents.on('context-menu')`：可编辑区给 撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选，选中文字给 复制 / 全选，链接给 在浏览器打开，图片给 在新窗口打开。
- **点开一个菜单只能点菜单项才关**：右键菜单那层 `.ctx-layer` 是 `position: fixed; inset: 0` 的全屏层，桌面端没写「点空白关闭」，点击全被它吞掉。已补 `onPointerDown` 判断 `target === currentTarget` 即关闭。三种关闭路径（ESC / 点空白 / 点聊天区空白）用真实鼠标事件验过。
- **不能全屏**：主进程原本没有任何全屏处理。已补 F11 切换、`window.feWin.toggleFullscreen()`，设置页也有「切换全屏」按钮。实测窗口 1234x868 → 1564x1043 → 再按回 1234x868。
- **手机连不进来**：服务端只绑 `127.0.0.1`，同一个 Wi-Fi 下手机也打不开。新增「我的 → 手机与局域网」卡片，一键切到 `0.0.0.0` 监听并重启应用，卡片里直接列出手机该打开的地址（可点复制）。实测 `netstat` 显示 `0.0.0.0:7788 LISTENING`，`curl http://192.168.1.108:7788/api/health` 返回本版本号。

## 测试

七套合计 **RAN 219 PASS 219 FAIL 0 ERR 0**。

# v2026.11.13.0.10.0

后端把主流即时通讯的进阶功能一次补齐，桌面端与手机 PWA 壳同步重写。

## 新增（服务端）

- **消息进阶**：引用回复、表情回应（同一个人再点即取消）、仅自己删除（对方仍可见）、收藏、单条转发、多选合并转发（聊天记录卡片）、正在输入提示。
- **会话与好友**：会话免打扰；好友分组（最多 20 组）、特别关心、备注；在线状态（在线 / 离开 / 忙碌 / 隐身），隐身对外一律显示离线。
- **群管理**：群详情、设置/取消管理员、单人禁言（0–43200 分钟）、全员禁言、群名片、群公告已读回执、群文件（登记 / 列表 / 删除）。
- **Bot 归属审批**：人加 Bot 必须 Bot 主人同意；把 Bot 拉进群也要主人同意（替代原先直接通过）。
- **通知中心**：好友申请、Bot 好友申请、入群邀请、群公告未读统一聚合。
- **文件与网络**：`POST /api/upload` + `GET /uploads/*`（单文件 25MB，MIME 白名单），`GET /api/server-info` 给出局域网地址，手机可直接连电脑。
- **账号**：改密码（旧密码校验）、退出登录。

## 测试

新增 `server/scripts/test-im.mjs` 72 条用例；七套合计 **RAN 219 PASS 219 FAIL 0 ERR 0**。

## 桌面 / 手机

- Electron 主进程与 preload 全量重写：窗口位置记忆与屏外回退、托盘、系统通知、任务栏角标、开机自启、外链安全打开。
- Web 端加入 PWA manifest + Service Worker + 图标，手机浏览器可「添加到主屏幕」。
- 桌面端打桩冒烟 47/47、重启恢复 49/49、屏外回退 49/49。

## 界面

- 前端拆成 theme / layout / chat / pages 四层样式，三套主题（深空、暗夜紫、晨雾）+ 三档字号，桌面三栏、平板两栏、手机单页栈 + 底部四 tab，安全区适配。
- 桌面端 34px 拖拽区与窗口按钮重做，按钮层级抬到最上层，不再被拖拽区吃掉点击。

## 修复

- **最大化按钮从来没生效**：基线主进程只接了 `win:minimize` 和 `win:close`，preload 发的 `win:toggle-max` 没有接收方。三个窗口操作 IPC 现已补齐，CDP 实测最小化 → `IsIconic=True`，最大化 → `IsZoomed` 在 True / False 之间切换。
- **私聊消息发送者显示「未知」**：`Message.jsx` 只读 `message.sender`，而私聊消息没有这个字段。改为回落到会话对端的昵称与头像，头像不再显示「未」字。
- **窗口按钮被拖拽区遮挡**：`.win-controls` 的 z-index 抬到 4000 并显式 `pointer-events:auto`，`.win-btn` 显式 `-webkit-app-region:no-drag`，登录页的拖拽条不再横跨到右上角按钮区。

## 备注

已合并构建并部署到安装目录，`/api/health` 返回 0.10.0；提交 a673e23，标签 v2026.11.13.0.10.0。

# v2026.11.13.0.9.4

修深色主题下「对方消息看不见」的配色 bug。

## 修复

- **对方消息白底白字**：`.bubble` 的背景写死成浅色 `#f2f3f5`，而深色主题的文字色是 `#e9e9ec`，两者叠在一起几乎读不出来。改成语义变量 `--bubble-peer`：浅色主题 `#f2f3f5`，深色主题 `#2c2c31`。
- 顺带把错误提示块 `--danger-bg`（浅色 `#fff1f0` / 深色 `rgba(255,77,79,0.12)`）和成功提示块 `--success-bg` 也改成变量，深色下不再出现刺眼白块。

## 验证

CDP 实测对方气泡：背景 `rgb(44,44,49)`、文字 `rgb(233,233,236)`，对比度正常；截图 `docs/assets/chat-dark.png` 已肉眼确认。

# v2026.11.13.0.9.3

拿本机真 AstrBot 实测，抓出两个让「连不上 / 连上也不说话」的硬 bug。

## 修复

- **握手被 401**：aiocqhttp 的反向 WS 只认 `Authorization: Bearer <token>` + `X-Client-Role` + `X-Self-ID` 三个请求头，光带 `?access_token=` 一律 401。现在连出去时三个头都带上了。
- **连上也不回话**：消息事件的 `message` 字段必须是 OneBot 11 的段数组（`[{type:'text',data:{text:'...'}}]`），传纯字符串时 AstrBot 会回「aiocqhttp: 无法识别的消息类型，此条消息将被忽略」。私聊和群聊事件都改成段数组，`raw_message` 保留原文。

## 实测

本机 AstrBot（6199 / 娜莉灵平台）真实连通：FEP 里给娜莉灵发「你好，我是灰凝。你叫什么名字？」，几秒后收到它的人格回复「迷迷糊糊的……连我都不认识啦？我是娜莉灵呀，宝宝快抱抱我~❤️」，整条链路 FEP → AstrBot → 人格/记忆/插件 → FEP 打通。

## 测试

test-link 从 14 条加到 18 条（新增三个握手头断言 + message 段数组断言）；test-groups 的群事件断言改用 raw_message。六套合计 **RAN 143 PASS 143 FAIL 0 ERR 0**。

# v2026.11.13.0.9.2

Bot 现在能主动连到 AstrBot 了 —— 不用再手抄地址去框架那边填。

## 新增

- **反向 WS 客户端**：AstrBot 这类框架的 aiocqhttp 只开端口等人连，之前 FEP 只会等别人连进来，所以根本接不上。现在每个 Bot 的设置里多一块「连到 AstrBot」：填地址和令牌，点连接，FEP 就像 NapCat 一样主动连过去，AstrBot 那边看到的和 NapCat 一模一样，模型、人格、记忆、插件全都不用动。
- **从本机 AstrBot 读取**：一键读 `~/.astrbot/data/cmd_config.json` 里已有的 aiocqhttp 平台，点一下就把端口和令牌填好。
- 断线自动重连（5 秒一次），开机自动连（`bot_links.enabled = 1` 的会在服务启动时连上）。
- 新表 `bot_links(account_id, url, token, enabled, updated_at)`；新接口 `GET/PUT /api/bots/:number/link`、`POST /api/bots/:number/link/reconnect`、`GET /api/astrbot/platforms`。

## 测试

新增 `server/scripts/test-link.mjs`（14 条：假框架起反向 WS 服务器，验证 lifecycle、get_login_info、私聊事件推送、send_private_msg 回话进聊天、断开后状态归零）。六套合计 **RAN 139 PASS 139 FAIL 0 ERR 0**。

# v2026.11.13.0.9.1

设置页按身份分区：个人号只看到个人号的，Bot 只看到 Bot 自己的。

## 修复

- **设置页串了身份**：以个人号登录时，设置里却挂着 Bot 的反向 WS 地址和令牌。现在「接入框架」只在以 **Bot 身份登录**时出现，而且只显示这个 Bot 自己的地址、令牌、号码；个人号的设置里不再出现任何 Bot 的钥匙。
- 设置页标题写明这是谁的设置，后面跟一个「个人号 / Bot 号」标签，不会再分不清看的是哪一个。
- 以 Bot 登录时，「切到我的 Bot」不再出现（自己切自己没有意义），切换列表里只有其它账号。
- 个人号的「切到我的 Bot」去掉已经出现在「切换账号」里的重复项，同一个 Bot 不再出现两次。

## 保留

- Bot 页每一行的「接入」按钮仍然保留：那是从个人号管理 Bot 的入口，点开能看到那个 Bot 的接入信息，和 Bot 自己的设置页是同一份数据。

# v2026.11.13.0.9.0

Bot 能接入框架了：一页把「地址 / 令牌 / 号码」摆出来，直接填进 AstrBot。

## 新增

- **接入框架**：设置里新增一栏，Bot 页每行也有一个「接入」按钮，两处都直接给出接入 AstrBot 这类框架需要的三条信息，各带一键复制：
  - 反向 WS 地址 `ws://127.0.0.1:7788/onebot/v11/ws`
  - 令牌（这个 Bot 自己的 token）
  - 号码
  并注明每一条在框架里对应填哪一格。框架连上后这里显示「在线」。
- `server/ai.js`：Bot 自带模型层（**可选**，默认关闭，藏在接入弹层最下面的按钮里）。直接调 OpenAI 兼容的 `/chat/completions`，不引任何 SDK。
- 表 `bot_models`：每个 Bot 一份配置（接口地址、密钥、模型名、人设、温度、开关）。
- `GET /api/bots/:number/model`：读配置，密钥一律打码成 `前4位••••后4位`，任何接口都不回传明文。
- `PUT /api/bots/:number/model`：保存配置。密钥有三种语义——不传=保留、传打码串=保留、传空串=清空。
- `POST /api/bots/:number/model/test`：拿当前配置真发一次请求，把模型的回复或报错原样带回来。
- 收到私聊消息时，如果对面是「配好并开启」的 Bot，自动用模型生成回复并落库（按会话串行，同一条消息只回一次）。Bot 和 Bot 之间默认不自动互刷。
- Bot 列表行重排：昵称+在线状态 / 号码 / 「复制 token」「接入」/ token 一行省略号，不再把按钮挤成竖排。

## 测试

- 新增 `server/scripts/test-model.mjs`：起一个本地假模型服务器，覆盖未配置、鉴权、越权、打码、保留密钥、连通性测试、真发消息、Bot 自动回复、关开关不回、清空密钥共 27 条。
- 五套合计 RAN 125 PASS 125 FAIL 0 ERR 0。

# v2026.11.13.0.8.2

可以切到自己的 Bot 了。

## 新增

- `POST /api/bots/:number/session`：Bot 的主人可以给自己的 Bot 开一个会话，返回独立 token。非主人 403，个人号 404。
- 设置 →「切换账号」下面新增「切到我的 Bot」一组，列出你名下所有 Bot（带在线状态），点一下就切过去。
- 切换回来不需要重新登录：个人号的 token 一直留在本机账号列表里。

## 修复

- Bot 账号根本没有密码，原来切换列表里永远不出现，等于「切不过去」。
- 以 Bot 身份登录时，设置页底部标签从「个人号」改成「Bot 号」。

## 测试

- test-features 从 19 条增到 25 条（新增 6 条 Bot 会话用例），四套合计 98 条。

# v2026.11.13.0.8.1

界面按用户给的 QQ 截图重做，并修掉三个真 bug。

## 界面

- 深色主题（照 QQ）：`--bg-app #0f0f11` / `--bg-rail #17171a` / `--bg-list #1c1c1f` / `--bg-main #232326` / `--bg-input #2c2c31`，默认深色，设置里可切浅色。
- 侧栏收窄：图标条 64 → 52px，会话列表 264 → 232px。
- 头像全部改成圆形（原来是有 6px 圆角的方块）。
- 联系人页改成 QQ 的三入口：「好友管理器」大按钮 + 「新朋友」「新群聊」两行。
- 输入栏改成 QQ 样式：左侧图片/表情两个 32×32 图标按钮，右下角蓝色「发送」。
- 窗口标题栏改成自绘深色条（原来被 Windows 强调色染成绿色），并补上最小化/最大化/关闭三个按钮。

## 修复

- 输入栏误用了 `.btn-ghost`（全宽红色危险按钮），导致「图片/表情」变成两条红色通栏、发送按钮被挤成竖排。
- 「好友管理器」原来只是折叠/展开，没有独立页面。
- 深色模式下搜索框、消息输入框仍是白底（写死的 `#fff`）。

## 测试

- test-api 25 / test-onebot 16 / test-groups 32 / test-features 19，合计 92 条。

# v2026.11.13.0.8.0

全套功能补齐（用户要求一次性做完，不许一条一条补）。

## 新增

- 会话置顶：右键会话「置顶 / 取消置顶」，置顶会话永远排在最前。
- 已读回执：消息气泡显示「已读 / 未读」，服务端 `peerRead` 取对方 `last_read_id`。
- 好友备注：名片里改备注（≤24 字）。
- 拉黑 / 解除拉黑：名片里操作，拉黑后互不可见、互不可发。
- 消息搜索：`GET /api/messages/search?q=&conversationId=`，排除已撤回消息。
- 群资料：群主/管理员可改群名与群公告。
- 群成员管理：群主/管理员可移出成员（不能踢群主）。
- 表情面板（26 个常用表情）。
- 群内 `@` 成员选择器。
- 会话列表按昵称/号码过滤。

## 修复

- 新建 Bot 后自动与主人互加好友，Bot 立刻出现在联系人里、可以聊天。
- Bot 管理从设置页移出，独立成 Bot 页（我的 Bot / 新建 / Bot 广场）。
- 设置页只剩账号、切换账号与注意事项。

## 测试

- test-api 25/25、test-onebot 16/16、test-groups 32/32、test-features 19/19，合计 92 条全绿。


# CHANGELOG
