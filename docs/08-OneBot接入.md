# OneBot 11 接入（v2026.11.13.0.4.0）

## 定位

Furry Everpony 不是 QQ 的中间商。它就是那台"服务器"本身：账号、好友、会话、消息全在本地库里。
OneBot 11 是它对外开的一个口子，让 AstrBot 这类框架把它当成一个普通 QQ 账号来用。

```
客户端（桌面/手机）  ⇄  我们的服务端（聊天网络 + OneBot 11 协议端）  ⇄  AstrBot（插件、人格、记忆）
```

对 AstrBot 来说，对面就是一个普通 OneBot 账号，所以 `/help`、人设、长期记忆、所有插件都不需要改。

## 连接

```
ws://127.0.0.1:7788/onebot/v11/ws?access_token=<Bot 的 token>
```

也支持 `Authorization: Bearer <token>`。token 不对直接 401，连不上。

和 NapCat 的配置一一对应：

| NapCat | Furry Everpony |
|---|---|
| 账号（扫码/密码登录） | 在客户端里创建 Bot，拿到号码 |
| 反向 WS 地址 + token | `ws://127.0.0.1:7788/onebot/v11/ws?access_token=...` |
| 心跳间隔 | 固定 30 秒，`meta_event/heartbeat` |

## 事件

| 事件 | 何时发 |
|---|---|
| `meta_event/lifecycle` (`sub_type: connect`) | 客户端连上时 |
| `meta_event/heartbeat` | 每 30 秒 |
| `message/private` (`sub_type: friend`) | 有人给这个 Bot 发私聊 |
| `notice/friend_add` | 有人加了这个 Bot |

`message` 事件字段：`post_type`、`message_type`、`sub_type`、`time`、`self_id`（Bot 号码）、
`message_id`、`user_id`（发送者号码）、`target_id`、`message`、`raw_message`、`font`、`sender`。

## 操作

`get_login_info`、`get_status`、`get_version_info`、`get_friend_list`、`get_group_list`、
`get_stranger_info`、`send_private_msg`、`send_msg`、`get_msg`、`delete_msg`、
`can_send_image`、`can_send_record`。

返回值统一是 `{ status: 'ok' | 'failed', retcode, data, echo }`。

## 消息格式

发送时接受字符串，也接受 OneBot 的段数组：
`text` 原样取；`image` → `[图片]`；`face` → `[表情]`；`record` → `[语音]`；`at` → `@号码`；`reply` 忽略。

## 已知限制

- 群消息还没接（`send_msg` 里 `message_type: group` 会报"群消息还没做"），表已经建好
- 图片、语音只占位，不传输
- 加 Bot 为好友目前立即通过，主人审批 UI 待补
- 单实例只监听 `127.0.0.1`，跨机器互联在 v0.2
