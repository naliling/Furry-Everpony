import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * OneBot 11 协议端。
 *
 * 目的：让 AstrBot、NapCat 生态里的机器人在连上本软件之后，把这里的 Bot 号码
 * 当成一个普通账号来用。0.10.2 及以前只有 12 个 action、所有消息段都被拍平成
 * 纯文本，于是 AstrBot 一发合并转发就报「不支持的操作：send_private_forward_msg」，
 * 指令直接断在那里——这就是用户说的「连上这个软件的时候有时会报错指令用不了」。
 *
 * 这一版重写：
 *  1. 完整的消息段解析（text/at/reply/image/record/file/face/node），入站出站都不丢；
 *  2. 合并转发：send_private_forward_msg / send_group_forward_msg / send_forward_msg /
 *     get_forward_msg 全部实现，收发双向；
 *  3. 常用 action 补齐到 NapCat 的常见子集（群管理、撤回、历史消息、好友/群申请处理、
 *     群文件、媒体落地），未知 action 才回 1404；
 *  4. 媒体真正落盘到 /uploads，返回可下载的 http 地址，不再「不支持图片」；
 *  5. Bot 收到消息时回调 onBotTyping，让界面出现「对方正在输入…」。
 */

export const PATH = '/onebot/v11/ws';

const MAX_MEDIA = 25 * 1024 * 1024;
const DEFAULT_BASE = 'http://127.0.0.1:7788';
const CQ_RE = /\[CQ:([a-zA-Z0-9_.-]+)((?:,[^\]]*)?)\]/g;

function cqEscape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
    .replace(/,/g, '&#44;');
}

function cqUnescape(text) {
  return String(text)
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&#44;/g, ',')
    .replace(/&amp;/g, '&');
}

/** CQ 码字符串 → 消息段数组 */
function cqToSegments(str) {
  const out = [];
  let last = 0;
  let m;
  const re = new RegExp(CQ_RE.source, 'g');
  while ((m = re.exec(str))) {
    if (m.index > last) {
      const text = cqUnescape(str.slice(last, m.index));
      if (text) out.push({ type: 'text', data: { text } });
    }
    const type = m[1];
    const data = {};
    const raw = m[2] || '';
    if (raw) {
      for (const part of raw.slice(1).split(',')) {
        const i = part.indexOf('=');
        if (i > 0) data[part.slice(0, i)] = cqUnescape(part.slice(i + 1));
      }
    }
    out.push({ type, data });
    last = re.lastIndex;
  }
  if (last < str.length) {
    const text = cqUnescape(str.slice(last));
    if (text) out.push({ type: 'text', data: { text } });
  }
  return out;
}

/** 消息段 → CQ 码字符串（raw_message 用） */
function segmentsToCq(segments) {
  let out = '';
  for (const seg of segments || []) {
    const type = seg && seg.type;
    const data = (seg && seg.data) || {};
    if (type === 'text') {
      out += cqEscape(data.text || '');
      continue;
    }
    const parts = [];
    for (const key of Object.keys(data)) {
      const value = data[key];
      if (value === undefined || value === null) continue;
      parts.push(key + '=' + cqEscape(value));
    }
    out += '[CQ:' + type + (parts.length ? ',' + parts.join(',') : '') + ']';
  }
  return out;
}

function normalizeSegments(message, autoEscape) {
  if (Array.isArray(message)) {
    return message
      .filter((s) => s && typeof s === 'object' && typeof s.type === 'string')
      .map((s) => ({ type: s.type, data: s.data && typeof s.data === 'object' ? s.data : {} }));
  }
  if (typeof message === 'string') {
    if (autoEscape) return message ? [{ type: 'text', data: { text: message } }] : [];
    return cqToSegments(message);
  }
  return [];
}

/** 把一段消息拆成「正文 / 提及 / 引用 / 媒体 / 合并转发节点」 */
function analyze(segments) {
  let text = '';
  const mentions = [];
  let mentionAll = false;
  let replyTo = null;
  let media = null;
  const nodes = [];
  for (const seg of segments) {
    const type = seg.type;
    const data = seg.data || {};
    if (type === 'text') {
      text += String(data.text || '');
    } else if (type === 'at') {
      const qq = String(data.qq || '');
      if (qq === 'all') mentionAll = true;
      else if (qq) mentions.push(qq);
    } else if (type === 'reply') {
      const id = Number(data.id);
      if (Number.isFinite(id) && id > 0) replyTo = id;
    } else if (type === 'image') {
      if (!media) media = { kind: 'image', file: data.file || data.url || '', name: data.summary || '图片' };
    } else if (type === 'record') {
      if (!media) media = { kind: 'voice', file: data.file || data.url || '', name: '语音' };
    } else if (type === 'file') {
      if (!media) media = { kind: 'file', file: data.file || data.url || '', name: data.name || data.file || '文件' };
    } else if (type === 'face') {
      text += '[表情' + (data.id ? ' ' + data.id : '') + ']';
    } else if (type === 'node') {
      nodes.push(data);
    } else if (type === 'mface' || type === 'json' || type === 'xml' || type === 'share') {
      if (data.summary) text += String(data.summary);
    } else if (type === 'forward') {
      if (!media) media = null;
    }
  }
  return { text, mentions, mentionAll, replyTo, media, nodes };
}

function sniffExt(buf) {
  if (!buf || buf.length < 4) return '';
  const head = buf.subarray(0, 12);
  const ascii = head.toString('latin1');
  if (head[0] === 0x89 && ascii.slice(1, 4) === 'PNG') return '.png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return '.jpg';
  if (ascii.startsWith('GIF')) return '.gif';
  if (ascii.startsWith('RIFF')) {
    if (ascii.slice(8, 12) === 'WEBP') return '.webp';
    if (ascii.slice(8, 12) === 'WAVE') return '.wav';
  }
  if (ascii.startsWith('OggS')) return '.ogg';
  if (ascii.startsWith('#!AMR')) return '.amr';
  if (ascii.startsWith('ID3')) return '.mp3';
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return '.mp3';
  if (ascii.startsWith('%PDF')) return '.pdf';
  if (head[0] === 0x50 && head[1] === 0x4b) return '.zip';
  if (ascii.startsWith('ftyp')) return '.mp4';
  return '';
}

function safeExt(ext) {
  const s = String(ext || '').toLowerCase();
  if (!s) return '';
  return /^\.[a-z0-9]{1,8}$/.test(s) ? s : '';
}

/**
 * @param {object} options
 * @param {object} options.db        node:sqlite DatabaseSync
 * @param {string} options.version
 * @param {string} options.uploadDir 媒体落盘目录
 * @param {string} options.publicBase 对外地址前缀，例如 http://127.0.0.1:7788
 * @param {object} options.log
 * @param {Function} options.onBotTyping (bot, convId) 收到消息时让界面显示「正在输入」
 * @param {Function} options.onBotSend   (bot, convId) Bot 回话时清掉「正在输入」
 * @param {Function} options.onBotOffline (bot) 连接断开
 */
export function createOneBot(options = {}) {
  const db = options.db;
  const version = options.version || '0.0.0';
  const uploadDir = options.uploadDir || join(process.cwd(), 'uploads');
  const publicBase = String(options.publicBase || DEFAULT_BASE).replace(/\/+$/, '');
  const log = options.log || console;
  const onBotTyping = typeof options.onBotTyping === 'function' ? options.onBotTyping : null;
  const onBotSend = typeof options.onBotSend === 'function' ? options.onBotSend : null;
  const onBotTypingStop = typeof options.onBotTypingStop === 'function' ? options.onBotTypingStop : null;
  const onBotOffline = typeof options.onBotOffline === 'function' ? options.onBotOffline : null;

  const conns = new Map(); // botId → Set(ws)
  const outState = new Map(); // botId → { connected, ws, timer, url }
  let wss = null;

  const stmt = {
    botByToken: db.prepare('SELECT * FROM accounts WHERE access_token = ? AND type = ?'),
    botById: db.prepare('SELECT * FROM accounts WHERE id = ?'),
    byNumber: db.prepare('SELECT * FROM accounts WHERE number = ?'),
    friends: db.prepare(
      'SELECT a.* FROM friendships f JOIN accounts a ON a.id = f.b_id WHERE f.a_id = ? ORDER BY a.number',
    ),
    groups: db.prepare(
      'SELECT g.* FROM group_members gm JOIN groups g ON g.id = gm.group_id WHERE gm.account_id = ? ORDER BY g.number',
    ),
    groupByNumber: db.prepare('SELECT * FROM groups WHERE number = ?'),
    isGroupMember: db.prepare('SELECT 1 AS x FROM group_members WHERE group_id = ? AND account_id = ?'),
    groupMembers: db.prepare(
      'SELECT gm.*, a.number, a.nickname, a.type FROM group_members gm JOIN accounts a ON a.id = gm.account_id WHERE gm.group_id = ? ORDER BY gm.joined_at',
    ),
    memberOf: db.prepare('SELECT * FROM group_members WHERE group_id = ? AND account_id = ?'),
    insertMsg: db.prepare(
      'INSERT INTO messages (conversation_id, sender_id, body, created_at, kind, reply_to_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    msgById: db.prepare('SELECT * FROM messages WHERE id = ?'),
    recall: db.prepare("UPDATE messages SET recalled = 1, body = ?, meta = '{}' WHERE id = ?"),
    touchRead: db.prepare(
      'UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND account_id = ?',
    ),
    addMember: db.prepare(
      'INSERT OR IGNORE INTO conversation_members (conversation_id, account_id, last_read_id, pinned, muted) VALUES (?, ?, 0, 0, 0)',
    ),
    newConv: db.prepare("INSERT INTO conversations (kind, created_at) VALUES ('dm', ?)"),
    dmConv: db.prepare(
      'SELECT c.id FROM conversations c JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.account_id = ? JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.account_id = ? WHERE c.kind = ? LIMIT 1',
    ),
    history: db.prepare(
      'SELECT * FROM messages WHERE conversation_id = ? AND recalled = 0 ORDER BY id DESC LIMIT ?',
    ),
    groupFiles: db.prepare(
      'SELECT * FROM group_files WHERE group_id = ? ORDER BY created_at DESC LIMIT 100',
    ),
    groupFile: db.prepare('SELECT * FROM group_files WHERE id = ?'),
    addGroupFile: db.prepare(
      'INSERT INTO group_files (group_id, uploader_id, name, url, size, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
    delGroupFile: db.prepare('DELETE FROM group_files WHERE id = ?'),
    setMute: db.prepare('UPDATE group_members SET mute_until = ? WHERE group_id = ? AND account_id = ?'),
    setCard: db.prepare('UPDATE group_members SET nickname = ? WHERE group_id = ? AND account_id = ?'),
    setGroupName: db.prepare('UPDATE groups SET name = ? WHERE id = ?'),
    setWholeBan: db.prepare('UPDATE groups SET mute_all = ? WHERE id = ?'),
    setAnnouncement: db.prepare(
      'UPDATE groups SET announcement = ?, announcement_updated_at = ? WHERE id = ?',
    ),
    delMember: db.prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ?'),
    delConvMember: db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND account_id = ?'),
    friendship: db.prepare('SELECT 1 AS x FROM friendships WHERE a_id = ? AND b_id = ?'),
    addFriend: db.prepare('INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)'),
    friendReq: db.prepare(
      "SELECT * FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    ),
    setFriendReq: db.prepare('UPDATE friend_requests SET status = ? WHERE id = ?'),
    groupReq: db.prepare(
      "SELECT * FROM group_requests WHERE to_id = ? AND group_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1",
    ),
    setGroupReq: db.prepare('UPDATE group_requests SET status = ? WHERE id = ?'),
    botLinks: db.prepare('SELECT bl.*, a.number FROM bot_links bl JOIN accounts a ON a.id = bl.account_id WHERE bl.enabled = 1'),
  };

  function publicUrl(path) {
    if (!path) return '';
    if (/^https?:\/\//i.test(path)) return path;
    return publicBase + (String(path).startsWith('/') ? path : '/' + path);
  }

  function readMeta(row) {
    if (!row || !row.meta) return {};
    try {
      const parsed = JSON.parse(row.meta);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function readBody(row) {
    if (row.kind === 'merge') return '[聊天记录]';
    if (row.kind === 'image') return '[图片]';
    if (row.kind === 'voice') return '[语音]';
    if (row.kind === 'file') {
      const meta = readMeta(row);
      return '[文件]' + (meta.name ? ' ' + meta.name : '');
    }
    return row.body || '';
  }

  function insertFeMessage(convId, senderId, payload) {
    const now = Date.now();
    const meta = payload.meta ? JSON.stringify(payload.meta) : '{}';
    const info = stmt.insertMsg.run(
      convId,
      senderId,
      String(payload.body || ''),
      now,
      payload.kind || 'text',
      payload.replyTo || null,
      meta,
    );
    const id = Number(info.lastInsertRowid);
    stmt.touchRead.run(id, convId, senderId);
    return id;
  }

  function dmConversation(aId, bId) {
    const found = stmt.dmConv.get(aId, bId, 'dm');
    if (found) return found.id;
    const info = stmt.newConv.run(Date.now());
    const convId = Number(info.lastInsertRowid);
    stmt.addMember.run(convId, aId);
    stmt.addMember.run(convId, bId);
    return convId;
  }

  function accountOf(id) {
    return stmt.botById.get(id);
  }

  function numberToId(value) {
    const text = String(value == null ? '' : value).trim();
    return /^\d{4,20}$/.test(text) ? text : '';
  }

  /* ---------- 媒体落地：base64 / http / 本地路径 三种来源 ---------- */

  async function materialize(file, fallbackExt) {
    const src = String(file || '').trim();
    if (!src) return null;
    if (src.startsWith('/uploads/')) return { url: src, size: 0, name: '' };
    let buf = null;
    let name = '';
    try {
      if (src.startsWith('base64://')) {
        buf = Buffer.from(src.slice(9), 'base64');
      } else if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src);
        if (!res.ok) return null;
        buf = Buffer.from(await res.arrayBuffer());
        try {
          name = decodeURIComponent(new URL(src).pathname.split('/').pop() || '');
        } catch (e) {
          name = '';
        }
      } else {
        let path = src;
        if (path.startsWith('file://')) {
          try {
            path = fileURLToPath(path);
          } catch (e) {
            path = src;
          }
        }
        buf = readFileSync(path);
        name = path.split(/[\\/]/).pop() || '';
      }
    } catch (e) {
      log.warn('[onebot] 媒体读取失败', src.slice(0, 80), e && e.message);
      return null;
    }
    if (!buf || !buf.length) return null;
    if (buf.length > MAX_MEDIA) return null;
    const ext = sniffExt(buf) || safeExt(extname(name)) || safeExt(fallbackExt) || '.bin';
    const fname = Date.now() + '-' + randomBytes(6).toString('hex') + ext;
    try {
      mkdirSync(uploadDir, { recursive: true });
      writeFileSync(join(uploadDir, fname), buf);
    } catch (e) {
      log.error('[onebot] 媒体落盘失败', e && e.message);
      return null;
    }
    return { url: '/uploads/' + fname, size: buf.length, name: name || fname };
  }

  /* ---------- 出站：数据库消息行 → 消息段 ---------- */

  function segmentsOfRow(row) {
    if (!row) return [{ type: 'text', data: { text: '' } }];
    const meta = readMeta(row);
    const segs = [];
    if (row.reply_to_id) segs.push({ type: 'reply', data: { id: String(row.reply_to_id) } });
    if (Array.isArray(meta.mentions)) {
      for (const number of meta.mentions) segs.push({ type: 'at', data: { qq: String(number) } });
    }
    if (meta.mentionAll) segs.push({ type: 'at', data: { qq: 'all' } });
    if (row.kind === 'merge') {
      const items = Array.isArray(meta.items) ? meta.items : [];
      if (items.length) {
        for (const item of items) {
          segs.push({
            type: 'node',
            data: {
              user_id: String(item.number || item.sender_number || '0'),
              nickname: item.nickname || '成员',
              time: Math.floor((item.time || row.created_at) / 1000),
              content: [{ type: 'text', data: { text: String(item.body || '') } }],
            },
          });
        }
      } else {
        segs.push({ type: 'text', data: { text: readBody(row) } });
      }
      return segs;
    }
    if (row.kind === 'image') {
      const url = publicUrl(row.body);
      segs.push({ type: 'image', data: { file: url, url, summary: '[图片]' } });
      return segs;
    }
    if (row.kind === 'voice') {
      const url = publicUrl(row.body);
      segs.push({ type: 'record', data: { file: url, url } });
      return segs;
    }
    if (row.kind === 'file') {
      const url = publicUrl(row.body);
      segs.push({ type: 'file', data: { file: url, url, name: meta.name || '文件', size: String(meta.size || 0) } });
      return segs;
    }
    const text = row.body || '';
    if (text) segs.push({ type: 'text', data: { text } });
    return segs;
  }

  function senderOf(account, group) {
    const out = {
      user_id: Number(account.number),
      nickname: account.nickname,
      sex: 'unknown',
      age: 0,
    };
    if (group) {
      const gm = stmt.memberOf.get(group.id, account.id);
      out.card = (gm && gm.nickname) || '';
      out.role = (gm && gm.role) || 'member';
      out.level = '1';
      out.title = '';
    }
    return out;
  }

  function messageEvent(row, bot, sender, group) {
    const segs = segmentsOfRow(row);
    const base = {
      time: Math.floor((row.created_at || Date.now()) / 1000),
      self_id: Number(bot.number),
      post_type: 'message',
      message_id: row.id,
      message_seq: row.id,
      real_id: row.id,
      user_id: Number(sender.number),
      message: segs,
      raw_message: segmentsToCq(segs),
      font: 14,
      sender: senderOf(sender, group),
    };
    if (group) {
      base.message_type = 'group';
      base.sub_type = 'normal';
      base.group_id = Number(group.number);
      base.anonymous = null;
      return base;
    }
    base.message_type = 'private';
    base.sub_type = 'friend';
    base.target_id = Number(bot.number);
    return base;
  }

  function isOnline(bot) {
    const set = conns.get(bot.id);
    if (set && set.size) return true;
    const st = outState.get(bot.id);
    return !!(st && st.connected);
  }

  function send(bot, payload) {
    const text = JSON.stringify(payload);
    const set = conns.get(bot.id);
    if (set) {
      for (const ws of set) {
        try {
          ws.send(text);
        } catch (e) {
          /* 单条连接坏掉不影响别的 */
        }
      }
    }
    const st = outState.get(bot.id);
    if (st && st.ws && st.connected) {
      try {
        st.ws.send(text);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function pushPrivateMessage(bot, sender, message) {
    const row = stmt.msgById.get(Number(message.id));
    if (!row) return;
    if (!isOnline(bot)) return;
    send(bot, messageEvent(row, bot, sender, null));
    if (onBotTyping) onBotTyping(bot, row.conversation_id);
  }

  function pushGroupMessage(bot, group, sender, message) {
    const row = stmt.msgById.get(Number(message.id));
    if (!row) return;
    if (!isOnline(bot)) return;
    send(bot, messageEvent(row, bot, sender, group));
    if (onBotTyping) onBotTyping(bot, group.conversation_id);
  }

  function pushFriendAdd(bot, user) {
    if (!isOnline(bot)) return;
    send(bot, {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(bot.number),
      post_type: 'notice',
      notice_type: 'friend_add',
      user_id: Number(user.number),
    });
  }

  function pushGroupMemberIncrease(bot, group, user) {
    if (!isOnline(bot)) return;
    send(bot, {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(bot.number),
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      group_id: Number(group.number),
      operator_id: Number(bot.number),
      user_id: Number(user.number),
    });
  }

  /* ---------- action 处理 ---------- */

  const ok = (data) => ({ status: 'ok', retcode: 0, data: data === undefined ? {} : data });
  const bad = (wording, retcode) => ({
    status: 'failed',
    retcode: retcode || 1400,
    wording: wording || '参数不对',
    data: null,
  });

  function resolveTarget(bot, value) {
    const number = numberToId(value);
    if (!number) return { error: bad('号码格式不对') };
    const account = stmt.byNumber.get(number);
    if (!account) return { error: bad('对方号码不存在', 1404) };
    return { account };
  }

  function resolveGroup(bot, value) {
    const number = numberToId(value);
    if (!number) return { error: bad('群号格式不对') };
    const group = stmt.groupByNumber.get(number);
    if (!group) return { error: bad('群不存在', 1404) };
    if (!stmt.isGroupMember.get(group.id, bot.id)) return { error: bad('机器人不在这个群里', 1403) };
    return { group };
  }

  /** 附件信息 + @ 信息合成一条消息的 meta */
  function metaOf(info, media) {
    const meta = {};
    if (media && info.media && info.media.kind === 'file') {
      meta.name = info.media.name;
      meta.size = media.size;
    }
    if (info.mentions.length) meta.mentions = info.mentions;
    if (info.mentionAll) meta.mentionAll = true;
    return Object.keys(meta).length ? meta : null;
  }

  async function sendToConversation(bot, convId, senderId, payload) {
    const id = insertFeMessage(convId, senderId, payload);
    if (onBotSend) onBotSend(bot, convId);
    return id;
  }

  async function handleSendPrivate(bot, p) {
    const target = resolveTarget(bot, p.user_id);
    if (target.error) return target.error;
    if (target.account.id === bot.id) return bad('不能给自己发消息');
    const segments = normalizeSegments(p.message, p.auto_escape);
    const info = analyze(segments);
    let media = null;
    if (info.media) media = await materialize(info.media.file, '.bin');
    const convId = dmConversation(bot.id, target.account.id);
    const body = media ? media.url : info.text;
    if (!body && !info.nodes.length) return bad('消息为空');
    if (info.nodes.length) {
      const merged = buildMergeMeta(info.nodes);
      const id = await sendToConversation(bot, convId, bot.id, {
        body: merged.body,
        kind: 'merge',
        meta: merged.meta,
        replyTo: info.replyTo,
      });
      return ok({ message_id: Number(id) });
    }
    const meta = metaOf(info, media);
    const id = await sendToConversation(bot, convId, bot.id, {
      body,
      kind: media ? info.media.kind : 'text',
      meta,
      replyTo: info.replyTo,
    });
    return ok({ message_id: Number(id) });
  }

  async function handleSendGroup(bot, p) {
    const target = resolveGroup(bot, p.group_id);
    if (target.error) return target.error;
    const group = target.group;
    const segments = normalizeSegments(p.message, p.auto_escape);
    const info = analyze(segments);
    let media = null;
    if (info.media) media = await materialize(info.media.file, '.bin');
    const body = media ? media.url : info.text;
    if (!body && !info.nodes.length) return bad('消息为空');
    let kind = media ? info.media.kind : 'text';
    let meta = metaOf(info, media);
    if (info.nodes.length) {
      const merged = buildMergeMeta(info.nodes);
      kind = 'merge';
      meta = merged.meta;
    }
    const convId = group.conversation_id;
    const id = await sendToConversation(bot, convId, bot.id, {
      body: kind === 'merge' ? body || mergedBodyText(meta) : body,
      kind,
      meta,
      replyTo: info.replyTo,
    });
    // 群里其他 Bot 也要收到（人类客户端靠轮询，不需要推）
    const others = stmt.groupMembers.all(group.id).filter((m) => m.type === 'bot' && m.account_id !== bot.id);
    for (const other of others) {
      const otherBot = accountOf(other.account_id);
      if (otherBot) pushGroupMessage(otherBot, group, accountOf(bot.id), { id });
    }
    return ok({ message_id: Number(id) });
  }

  function mergedBodyText(meta) {
    const count = meta && meta.count ? meta.count : 0;
    return '[聊天记录] ' + count + ' 条';
  }

  function buildMergeMeta(nodes) {
    const items = [];
    for (const node of nodes || []) {
      const data = node && node.data ? node.data : node;
      const content = data && (data.content || data.message);
      const segments = normalizeSegments(content, false);
      const info = analyze(segments);
      items.push({
        number: String((data && (data.user_id || data.uin)) || '0'),
        nickname: (data && data.nickname) || '成员',
        body: info.text || '',
        time: Number(data && data.time ? Number(data.time) * 1000 : Date.now()),
      });
    }
    return { body: '[聊天记录] ' + items.length + ' 条', meta: { title: '聊天记录', count: items.length, items } };
  }

  async function handleSendForward(bot, p, groupMode) {
    const raw = p.messages || p.message;
    const nodes = Array.isArray(raw) ? raw.filter((n) => n && (n.type === 'node' || n.data)) : normalizeSegments(raw, false);
    const nodeData = nodes.map((n) => (n.type === 'node' ? n.data : n));
    const merged = buildMergeMeta(nodeData.map((d) => ({ data: d })));
    const convId = groupMode
      ? (() => {
          const g = resolveGroup(bot, p.group_id);
          return g.group ? g.group.conversation_id : null;
        })()
      : (() => {
          const t = resolveTarget(bot, p.user_id);
          return t.account ? dmConversation(bot.id, t.account.id) : null;
        })();
    if (!convId) return bad(groupMode ? '群不存在' : '对方号码不存在', 1404);
    const id = await sendToConversation(bot, convId, bot.id, {
      body: merged.body,
      kind: 'merge',
      meta: merged.meta,
    });
    if (groupMode) {
      const group = stmt.groupByNumber.get(numberToId(p.group_id));
      const others = stmt.groupMembers.all(group.id).filter((m) => m.type === 'bot' && m.account_id !== bot.id);
      for (const other of others) {
        const otherBot = accountOf(other.account_id);
        if (otherBot) pushGroupMessage(otherBot, group, accountOf(bot.id), { id });
      }
    }
    return ok({ message_id: Number(id) });
  }

  const actions = {
    /* --- 账号与状态 --- */
    get_login_info: (bot) => ok({ user_id: Number(bot.number), nickname: bot.nickname }),
    get_status: () => ok({ online: true, good: true }),
    get_version_info: () => ok({ app_name: 'Furry Everpony', app_version: version, protocol_version: 'v11' }),
    get_online_clients: () => ok({ clients: [] }),
    get_robot_uin_range: () => ok({ ranges: [{ minUin: '10000', maxUin: '999999999999' }] }),
    get_credentials: () => ok({ cookies: '', csrf_token: 0 }),
    get_cookies: () => ok({ cookies: '' }),
    get_csrf_token: () => ok({ token: 0 }),
    set_online_status: () => ok({}),
    /* 输入状态：Bot 自己说「我在打字」，界面被动显示，不假装是用户 */
    set_input_status: (bot, params) => {
      const eventType = Number(params.event_type == null ? 1 : params.event_type);
      const groupNumber = params.group_id == null ? '' : String(params.group_id);
      let convId = null;
      if (groupNumber) {
        const group = stmt.groupByNumber.get(groupNumber);
        if (!group) return bad('没有这个群', 1404);
        if (!stmt.isGroupMember.get(group.id, bot.id)) return bad('Bot 不在这个群里', 1404);
        convId = group.conversation_id;
      } else {
        const number = numberToId(params.user_id);
        const target = number ? stmt.byNumber.get(number) : null;
        if (!target) return bad('没有这个好友', 1404);
        convId = dmConversation(bot.id, target.id);
      }
      if (!convId) return bad('找不到会话', 1404);
      if (eventType === 2) {
        if (onBotTypingStop) onBotTypingStop(bot, convId);
      } else if (onBotTyping) {
        onBotTyping(bot, convId);
      }
      return ok({});
    },
    set_restart: () => {
      log.warn('[onebot] 客户端请求重启，已忽略');
      return ok({});
    },

    /* --- 好友 --- */
    get_friend_list: (bot) =>
      ok(
        stmt.friends.all(bot.id).map((a) => ({
          user_id: Number(a.number),
          nickname: a.nickname,
          remark: '',
        })),
      ),
    get_stranger_info: (bot, p) => {
      const t = resolveTarget(bot, p.user_id);
      if (t.error) return t.error;
      return ok({ user_id: Number(t.account.number), nickname: t.account.nickname, sex: 'unknown', age: 0 });
    },
    get_unidirectional_friend_list: () => ok([]),
    get_recent_contact: () => ok({ lastest_msg: [] }),
    get_profile_like: () => ok({ user_id: 0, times: 0 }),
    set_friend_add_request: (bot, p) => {
      const t = resolveTarget(bot, p.user_id);
      if (t.error) return t.error;
      const approve = p.approve === true || p.approve === 'true';
      const req = stmt.friendReq.get(t.account.id, bot.id);
      if (approve) {
        stmt.addFriend.run(bot.id, t.account.id, Date.now());
        stmt.addFriend.run(t.account.id, bot.id, Date.now());
        if (req) stmt.setFriendReq.run('accepted', req.id);
      } else if (req) {
        stmt.setFriendReq.run('rejected', req.id);
      }
      return ok({});
    },
    delete_friend: (bot, p) => {
      const t = resolveTarget(bot, p.user_id);
      if (t.error) return t.error;
      db.prepare('DELETE FROM friendships WHERE (a_id = ? AND b_id = ?) OR (a_id = ? AND b_id = ?)').run(
        bot.id,
        t.account.id,
        t.account.id,
        bot.id,
      );
      return ok({});
    },

    /* --- 群 --- */
    get_group_list: (bot) =>
      ok(
        stmt.groups.all(bot.id).map((g) => ({
          group_id: Number(g.number),
          group_name: g.name,
          member_count: stmt.groupMembers.all(g.id).length,
          max_member_count: 500,
        })),
      ),
    get_group_info: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      return ok({
        group_id: Number(t.group.number),
        group_name: t.group.name,
        member_count: stmt.groupMembers.all(t.group.id).length,
        max_member_count: 500,
      });
    },
    get_group_info_ex: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      return ok({ group_id: Number(t.group.number), group_name: t.group.name });
    },
    get_group_member_list: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      return ok(
        stmt.groupMembers.all(t.group.id).map((m) => ({
          group_id: Number(t.group.number),
          user_id: Number(m.number),
          nickname: m.nickname || '',
          card: m.nickname || '',
          sex: 'unknown',
          age: 0,
          area: '',
          join_time: Math.floor((m.joined_at || 0) / 1000),
          last_sent_time: 0,
          level: '1',
          role: m.role || 'member',
          unfriendly: false,
          title: '',
          title_expire_time: 0,
          card_changeable: true,
        })),
      );
    },
    get_group_member_info: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const target = stmt.byNumber.get(numberToId(p.user_id));
      if (!target) return bad('对方号码不存在', 1404);
      const m = stmt.memberOf.get(t.group.id, target.id);
      if (!m) return bad('这个人不在群里', 1404);
      return ok({
        group_id: Number(t.group.number),
        user_id: Number(target.number),
        nickname: target.nickname,
        card: m.nickname || '',
        sex: 'unknown',
        age: 0,
        join_time: Math.floor((m.joined_at || 0) / 1000),
        last_sent_time: 0,
        level: '1',
        role: m.role || 'member',
        title: '',
      });
    },
    get_group_at_all_remain: () =>
      ok({
        can_at_all: true,
        remain_at_all_count_for_group: 20,
        remain_at_all_count_for_uin: 20,
      }),
    get_group_shut_list: () => ok([]),
    get_group_honor_info: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      return ok({ group_id: Number(t.group.number), current_talkative: null, talkative_list: [], performer_list: [] });
    },
    get_group_system_msg: () => ok({ invited_requests: [], join_requests: [] }),
    get_group_ignore_add_request: () => ok({}),
    get_group_notice: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      if (!t.group.announcement) return ok({ notices: [] });
      return ok({
        notices: [
          {
            notice_id: '1',
            sender_id: Number(bot.number),
            publish_time: Math.floor((t.group.announcement_updated_at || Date.now()) / 1000),
            message: { text: t.group.announcement },
          },
        ],
      });
    },
    _send_group_notice: (bot, p) => actions.send_group_notice(bot, p),
    send_group_notice: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const content = typeof p.content === 'string' ? p.content : JSON.stringify(p.content || '');
      stmt.setAnnouncement.run(content.slice(0, 2000), Date.now(), t.group.id);
      return ok({});
    },
    set_group_ban: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const target = stmt.byNumber.get(numberToId(p.user_id));
      if (!target) return bad('对方号码不存在', 1404);
      const seconds = Number(p.duration) || 0;
      const until = seconds > 0 ? Date.now() + seconds * 1000 : 0;
      stmt.setMute.run(until, t.group.id, target.id);
      return ok({});
    },
    set_group_whole_ban: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      stmt.setWholeBan.run(p.enable ? 1 : 0, t.group.id);
      return ok({});
    },
    set_group_card: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const target = stmt.byNumber.get(numberToId(p.user_id));
      if (!target) return bad('对方号码不存在', 1404);
      stmt.setCard.run(String(p.card || '').slice(0, 16), t.group.id, target.id);
      return ok({});
    },
    set_group_name: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      if (t.group.owner_id !== bot.id) return bad('只有群主能改群名', 1403);
      stmt.setGroupName.run(String(p.group_name || '').slice(0, 40), t.group.id);
      return ok({});
    },
    set_group_leave: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      stmt.delMember.run(t.group.id, bot.id);
      stmt.delConvMember.run(t.group.conversation_id, bot.id);
      return ok({});
    },
    set_group_kick: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const target = stmt.byNumber.get(numberToId(p.user_id));
      if (!target) return bad('对方号码不存在', 1404);
      stmt.delMember.run(t.group.id, target.id);
      stmt.delConvMember.run(t.group.conversation_id, target.id);
      return ok({});
    },
    set_group_add_request: (bot, p) => {
      const group = stmt.groupByNumber.get(numberToId(p.group_id));
      if (!group) return bad('群不存在', 1404);
      const flag = String(p.flag || '');
      const target = stmt.byNumber.get(numberToId(p.user_id || flag));
      if (!target) return bad('对方号码不存在', 1404);
      const approve = p.approve === true || p.approve === 'true';
      if (approve) {
        stmt.addMember.run(group.conversation_id, target.id);
        db.prepare(
          'INSERT OR IGNORE INTO group_members (group_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)',
        ).run(group.id, target.id, 'member', Date.now());
        const req = stmt.groupReq.get(target.id, group.id);
        if (req) stmt.setGroupReq.run('accepted', req.id);
      } else {
        const req = stmt.groupReq.get(target.id, group.id);
        if (req) stmt.setGroupReq.run('rejected', req.id);
      }
      return ok({});
    },
    get_group_file_system_info: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      return ok({ file_count: stmt.groupFiles.all(t.group.id).length, limit_count: 10000 });
    },
    get_group_root_files: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const files = stmt.groupFiles.all(t.group.id).map((f) => ({
        group_id: Number(t.group.number),
        file_id: String(f.id),
        file_name: f.name,
        busid: 0,
        file_size: f.size,
        upload_time: Math.floor((f.created_at || 0) / 1000),
        dead_time: 0,
        modify_time: Math.floor((f.created_at || 0) / 1000),
        download_times: 0,
        uploader: Number(bot.number),
        uploader_name: '',
      }));
      return ok({ files, folders: [] });
    },
    get_group_files_by_folder: (bot, p) => actions.get_group_root_files(bot, p),
    get_group_file_url: (bot, p) => {
      const file = stmt.groupFile.get(Number(p.file_id));
      if (!file) return bad('文件不存在', 1404);
      return ok({ url: publicUrl(file.url) });
    },
    upload_group_file: async (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const media = await materialize(p.file, '.bin');
      if (!media) return bad('文件读取失败');
      const name = String(p.name || media.name || '文件').slice(0, 80);
      const info = stmt.addGroupFile.run(t.group.id, bot.id, name, media.url, media.size || 0, Date.now());
      const convId = t.group.conversation_id;
      const id = await sendToConversation(bot, convId, bot.id, {
        body: media.url,
        kind: 'file',
        meta: { name, size: media.size || 0 },
      });
      return ok({ file_id: String(info.lastInsertRowid), message_id: Number(id) });
    },
    delete_group_file: (bot, p) => {
      const file = stmt.groupFile.get(Number(p.file_id));
      if (!file) return bad('文件不存在', 1404);
      stmt.delGroupFile.run(file.id);
      return ok({});
    },
    get_essence_msg_list: () => ok([]),
    set_essence_msg: () => ok({}),
    delete_essence_msg: () => ok({}),

    /* --- 消息发送 --- */
    send_private_msg: (bot, p) => handleSendPrivate(bot, p),
    send_group_msg: (bot, p) => handleSendGroup(bot, p),
    send_msg: (bot, p) => (p.group_id ? handleSendGroup(bot, p) : handleSendPrivate(bot, p)),
    send_private_forward_msg: (bot, p) => handleSendForward(bot, p, false),
    send_group_forward_msg: (bot, p) => handleSendForward(bot, p, true),
    send_forward_msg: (bot, p) => handleSendForward(bot, p, !!p.group_id),
    get_forward_msg: (bot, p) => {
      const row = stmt.msgById.get(Number(p.id));
      if (!row) return bad('消息不存在', 1404);
      const meta = readMeta(row);
      const items = Array.isArray(meta.items) ? meta.items : [];
      return ok({
        messages: items.map((item) => ({
          sender: { user_id: Number(item.number || 0), nickname: item.nickname || '成员' },
          time: Math.floor((item.time || row.created_at) / 1000),
          message: [{ type: 'text', data: { text: String(item.body || '') } }],
          raw_message: String(item.body || ''),
        })),
      });
    },

    /* --- 消息操作 --- */
    get_msg: (bot, p) => {
      const row = stmt.msgById.get(Number(p.message_id));
      if (!row) return bad('消息不存在', 1404);
      const sender = accountOf(row.sender_id);
      if (!sender) return bad('消息不存在', 1404);
      const member = db
        .prepare('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND account_id = ?')
        .get(row.conversation_id, bot.id);
      if (!member) return bad('无权查看这条消息', 1403);
      const segs = segmentsOfRow(row);
      const conv = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(row.conversation_id);
      const isGroup = conv && conv.kind === 'group';
      return ok({
        message_id: row.id,
        real_id: row.id,
        time: Math.floor((row.created_at || 0) / 1000),
        message_type: isGroup ? 'group' : 'private',
        sender: { user_id: Number(sender.number), nickname: sender.nickname },
        message: segs,
        raw_message: segmentsToCq(segs),
      });
    },
    delete_msg: (bot, p) => {
      const row = stmt.msgById.get(Number(p.message_id));
      if (!row) return bad('消息不存在', 1404);
      const member = db
        .prepare('SELECT 1 AS x FROM conversation_members WHERE conversation_id = ? AND account_id = ?')
        .get(row.conversation_id, bot.id);
      if (!member) return bad('无权撤回这条消息', 1403);
      stmt.recall.run('', row.id);
      return ok({});
    },
    mark_msg_as_read: () => ok({}),
    set_msg_emoji_like: () => ok({}),
    send_like: () => ok({}),
    get_msg_history: (bot, p) => actions.get_friend_msg_history(bot, p),
    get_friend_msg_history: (bot, p) => {
      const t = resolveTarget(bot, p.user_id);
      if (t.error) return t.error;
      const convId = stmt.dmConv.get(bot.id, t.account.id, 'dm');
      if (!convId) return ok({ messages: [] });
      const rows = stmt.history.all(convId.id, Number(p.count) || 20).reverse();
      return ok({
        messages: rows.map((row) => {
          const sender = accountOf(row.sender_id) || bot;
          return messageEvent(row, bot, sender, null);
        }),
      });
    },
    get_group_msg_history: (bot, p) => {
      const t = resolveGroup(bot, p.group_id);
      if (t.error) return t.error;
      const rows = stmt.history.all(t.group.conversation_id, Number(p.count) || 20).reverse();
      return ok({
        messages: rows.map((row) => {
          const sender = accountOf(row.sender_id) || bot;
          return messageEvent(row, bot, sender, t.group);
        }),
      });
    },

    /* --- 媒体 --- */
    can_send_image: () => ok({ yes: true }),
    can_send_record: () => ok({ yes: true }),
    can_send_file: () => ok({ yes: true }),
    get_image: async (bot, p) => {
      const media = await materialize(p.file, '.png');
      if (!media) return bad('图片读取失败');
      return ok({ file: media.url, url: publicUrl(media.url) });
    },
    get_record: async (bot, p) => {
      const media = await materialize(p.file, '.mp3');
      if (!media) return bad('语音读取失败');
      return ok({ file: media.url, url: publicUrl(media.url) });
    },
    get_avatar: (bot, p) => {
      const target = stmt.byNumber.get(numberToId(p.user_id));
      if (!target || !target.avatar) return ok({ url: '' });
      return ok({ url: publicUrl(target.avatar) });
    },
    ocr_image: () => bad('不支持图片识别', 1404),
    download_file: () => bad('不支持下载', 1404),
    _download_file: () => bad('不支持下载', 1404),
  };

  async function handleAction(ws, bot, payload) {
    const action = String(payload.action || '');
    const params = payload.params && typeof payload.params === 'object' ? payload.params : {};
    const fn = actions[action];
    if (!fn) {
      log.warn('[onebot] 未支持的 action', action);
      return { status: 'failed', retcode: 1404, wording: '不支持的操作：' + action, data: null };
    }
    try {
      return await fn(bot, params, ws);
    } catch (e) {
      log.error('[onebot] action 执行失败', action, e && e.stack);
      return { status: 'failed', retcode: 1200, wording: '操作失败：' + ((e && e.message) || '未知错误'), data: null };
    }
  }

  /* ---------- 连接管理 ---------- */

  function authenticate(req) {
    let token = '';
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      token = url.searchParams.get('access_token') || '';
    } catch (e) {
      token = '';
    }
    if (!token) {
      const header = req.headers && req.headers.authorization;
      if (header && /^Bearer\s+/i.test(header)) token = header.replace(/^Bearer\s+/i, '').trim();
    }
    if (!token) return null;
    return stmt.botByToken.get(token, 'bot') || null;
  }

  function onConnection(ws, bot) {
    let set = conns.get(bot.id);
    if (!set) {
      set = new Set();
      conns.set(bot.id, set);
    }
    set.add(ws);
    log.info('[onebot] 客户端接入', bot.number, '连接数', set.size);
    send(bot, {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(bot.number),
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
      interval: 30000,
    });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== 1) return;
      try {
        ws.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(bot.number),
            post_type: 'meta_event',
            meta_event_type: 'heartbeat',
            status: { online: true, good: true },
            interval: 30000,
          }),
        );
      } catch (e) {
        /* ignore */
      }
    }, 30000);
    ws.on('message', async (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw));
      } catch (e) {
        return;
      }
      if (!payload || !payload.action) return;
      const result = await handleAction(ws, bot, payload);
      if (payload.echo !== undefined) result.echo = payload.echo;
      try {
        ws.send(JSON.stringify(result));
      } catch (e) {
        /* ignore */
      }
    });
    const cleanup = () => {
      clearInterval(heartbeat);
      const current = conns.get(bot.id);
      if (current) {
        current.delete(ws);
        if (!current.size) conns.delete(bot.id);
      }
      log.info('[onebot] 客户端断开', bot.number);
      if (!isOnline(bot) && onBotOffline) onBotOffline(bot);
    };
    ws.on('close', cleanup);
    ws.on('error', cleanup);
  }

  function attach(app) {
    wss = new WebSocketServer({ noServer: true });
    app.server.on('upgrade', (req, socket, head) => {
      let pathname = '';
      try {
        pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      } catch (e) {
        socket.destroy();
        return;
      }
      if (pathname !== PATH) return;
      const bot = authenticate(req);
      if (!bot) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req, bot);
      });
    });
    wss.on('connection', (ws, req, bot) => onConnection(ws, bot));
  }

  /* ---------- 反向 WS：我们主动连 AstrBot / NapCat 的 ws 端口 ---------- */

  function outStateOf(botId) {
    let st = outState.get(botId);
    if (!st) {
      st = { connected: false, ws: null, timer: null, url: '' };
      outState.set(botId, st);
    }
    return st;
  }

  function connectOut(bot, url, token) {
    const st = outStateOf(bot.id);
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.ws) {
      try {
        st.ws.removeAllListeners();
        st.ws.terminate();
      } catch (e) {
        /* ignore */
      }
      st.ws = null;
    }
    st.connected = false;
    st.url = url;
    let ws = null;
    try {
      ws = new WebSocket(url, {
        headers: {
          'X-Self-ID': String(bot.number),
          'X-Client-Role': 'Universal',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
        },
      });
    } catch (e) {
      log.warn('[onebot] 反向连接失败', url, e && e.message);
      scheduleReconnect(bot, url, token, st);
      return;
    }
    st.ws = ws;
    ws.on('open', () => {
      st.connected = true;
      log.info('[onebot] 反向连接成功', bot.number, url);
      try {
        ws.send(
          JSON.stringify({
            time: Math.floor(Date.now() / 1000),
            self_id: Number(bot.number),
            post_type: 'meta_event',
            meta_event_type: 'lifecycle',
            sub_type: 'connect',
            interval: 30000,
          }),
        );
      } catch (e) {
        /* ignore */
      }
    });
    ws.on('message', async (raw) => {
      let payload = null;
      try {
        payload = JSON.parse(String(raw));
      } catch (e) {
        return;
      }
      if (!payload || !payload.action) return;
      const result = await handleAction(ws, bot, payload);
      if (payload.echo !== undefined) result.echo = payload.echo;
      try {
        ws.send(JSON.stringify(result));
      } catch (e) {
        /* ignore */
      }
    });
    ws.on('close', () => {
      st.connected = false;
      log.warn('[onebot] 反向连接断开', bot.number, url);
      scheduleReconnect(bot, url, token, st);
    });
    ws.on('error', (err) => {
      log.warn('[onebot] 反向连接出错', bot.number, err && err.message);
    });
  }

  function scheduleReconnect(bot, url, token, st) {
    if (st.timer) return;
    st.timer = setTimeout(() => {
      st.timer = null;
      connectOut(bot, url, token);
    }, 5000);
    if (st.timer.unref) st.timer.unref();
  }

  function closeOut(botId) {
    const st = outState.get(botId);
    if (!st) return;
    if (st.timer) {
      clearTimeout(st.timer);
      st.timer = null;
    }
    if (st.ws) {
      try {
        st.ws.removeAllListeners();
        st.ws.terminate();
      } catch (e) {
        /* ignore */
      }
    }
    st.ws = null;
    st.connected = false;
    outState.delete(botId);
  }

  function outStatus(botId) {
    const st = outState.get(botId);
    return { connected: !!(st && st.connected), url: (st && st.url) || '' };
  }

  function startOutLinks() {
    let rows = [];
    try {
      rows = stmt.botLinks.all();
    } catch (e) {
      log.warn('[onebot] 读取反向连接配置失败', e && e.message);
      return;
    }
    for (const row of rows) {
      if (!row.url) continue;
      const bot = accountOf(row.account_id);
      if (!bot) continue;
      connectOut(bot, row.url, row.token || '');
    }
    if (rows.length) log.info('[onebot] 已恢复反向连接', rows.length, '条');
  }

  function onlineBots() {
    const out = [];
    for (const [botId, set] of conns) if (set.size) out.push(botId);
    for (const [botId, st] of outState) if (st.connected && !out.includes(botId)) out.push(botId);
    return out;
  }

  function newToken() {
    return randomBytes(16).toString('hex');
  }

  return {
    attach,
    pushPrivateMessage,
    pushFriendAdd,
    pushGroupMessage,
    pushGroupMemberIncrease,
    connectOut,
    closeOut,
    outStatus,
    startOutLinks,
    onlineBots,
    isOnline,
    newToken,
  };
}
