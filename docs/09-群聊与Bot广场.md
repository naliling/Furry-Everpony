# 群聊 与 Bot 广场

本文说明两件事：群怎么走，以及「别人的 Bot 怎么挂到一个列表里」。

## 一、群

群在数据上是 `groups` 表 + 一个 `kind='group'` 的会话。消息还是走 `messages` 表，和私聊同一套，只是会话类型不同。

| 动作 | 接口 |
|---|---|
| 建群 | `POST /api/groups` `{ number, name }` |
| 我建的 / 我在的群 | `GET /api/groups` |
| 进群 | `POST /api/groups/:number/join` |
| 邀请人（或 Bot）进群 | `POST /api/groups/:number/invite` `{ number }` |
| 群成员 | `GET /api/groups/:number/members` |
| 群消息 | `POST /api/groups/:number/messages` `{ body }` |

规则：

- 群号 5–12 位数字，实例内唯一，和用户号码共用同一套校验。
- 只有群成员能发言、能看成员、能邀请人。
- 群主是创建者，`group_members.role = 'owner'`，其余为 `'member'`。
- Bot 也是群成员，邀请方式和邀请人一样，填 Bot 的号码即可。

### OneBot 侧

- `get_group_list` 返回这个 Bot 所在的群：`[{ group_id, group_name, member_count }]`
- 群里有人说话 → 推 `post_type='message'`、`message_type='group'` 事件，`group_id` 是群号，`sender.role` 是 `'member'`
- `send_group_msg` `{ group_id, message }` 让 Bot 在群里回话；Bot 不在群里会返回失败

## 二、Bot 广场

### 要解决什么

一个实例上可能有很多人的 Bot。别人怎么找到它们、怎么把「别人的 Bot」加到自己的联系人里？

答案是 **Bot 广场**：Bot 主人把 Bot 标记为公开，它就出现在广场里，其他人可以搜、可以看简介、可以一键加好友。

### 数据

`accounts.is_public`（0/1，只对 `type='bot'` 有意义）。默认 0，建 Bot 时可以传 `public: true`，之后也能改。

### 接口

| 接口 | 说明 |
|---|---|
| `GET /api/bots/public?q=&limit=&offset=` | 公开 Bot 列表，`q` 同时匹配号码和昵称；返回 `added`（多少人加了它）、`isFriend`、`isMine` |
| `PATCH /api/bots/:number` | 主人改 `nickname` / `bio` / `public` |
| `POST /api/bots` | 建 Bot 时支持 `bio` 和 `public` |

### 为什么不做「全局排行榜」

- 数据只在本实例里，没有中心服务器就没有全局数据；要做就得把所有实例的聊天量汇总，那是隐私问题，也违反「零中心依赖」。
- 排行榜对使用者没什么用，对 Bot 主人有点用。所以做成 **Bot 主人的私人统计**：`GET /api/bots/:number/stats` 只给主人看，统计「和这个 Bot 私聊最多的人」。

### 上百个 Bot 怎么撑

- 分页：`limit` 最大 100，`offset` 翻页。
- 搜索：`q` 直接进 SQL 的 `LIKE`，号码和昵称都命中。
- 前端目前一次拉 50 条；到几百个时改成滚动加载即可，接口已经支持。
- 数据量级：几百个 Bot 对 SQLite 是小菜，不需要额外索引也能跑；真要优化就加 `CREATE INDEX idx_accounts_public ON accounts(is_public, type)`。

### 跨实例怎么办（v0.2）

广场目前是「本实例的公开 Bot」。跨实例时同一套结构直接复用：

- 每个实例暴露 `GET /api/fed/bots`（和 `/api/bots/public` 同样的返回结构）
- 客户端维护「已订阅的实例」列表，把多个实例的广场合并展示
- 点「加好友」走跨实例好友申请（见 `03-架构与互联.md`）

也就是说，广场这一层不用为联邦重写，只要多一个数据来源。
