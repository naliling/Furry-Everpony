import { randomBytes, timingSafeEqual } from 'node:crypto';
import dgram from 'node:dgram';

/**
 * 实例互联（federation）
 *
 * 每个 FE 实例都是一个独立服务端，号码只在实例内唯一。想让两个实例上的人互相加好友、
 * 直接收发消息，就必须让它们能互相找到并连上。这里不引入任何中心服务器：
 *
 *   - 局域网内：UDP 7799 广播互相发现（同 Wi-Fi 自动出现，不用填地址）
 *   - 局域网外：用户把自己的「实例地址」发给对方，对方填地址 + 号码
 *   - 消息：实例 → 实例直接投递，失败进队列按指数退避重试
 *
 * 远端联系人在本地库里是 accounts.type = 'remote' 的账号行，所以私聊会话、消息、
 * 未读数、置顶、免打扰这些逻辑完全不用改。
 */

const DISCOVERY_PORT = 7799;
const DEFAULT_PORT = 7788;
const ONLINE_WINDOW = 20_000;
const MAX_ATTEMPTS = 60;
/** 邀请码有效期：24 小时（里面带的是地址快照，过期让对方重新生成就行） */
const INVITE_TTL = 24 * 3600 * 1000;
const INVITE_PREFIX = 'FEINV1.';
const NUMBER_RE = /^[1-9]\d{4,11}$/;

/** 把 "1.2.3.4" / "1.2.3.4:7788" / "http://1.2.3.4:7788/" 统一成 "1.2.3.4:7788" */
export function normalizeAddr(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  // 去掉可能的路径部分
  s = s.split('/')[0];
  if (!s) return '';
  if (!/^[A-Za-z0-9.\-]+(:\d{1,5})?$/.test(s) && !/^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(s)) {
    return '';
  }
  if (!s.includes(':')) s = s + ':' + DEFAULT_PORT;
  return s;
}

/**
 * 解析邀请码：对方粘贴过来的一串文本。
 * 格式 FEINV1.<base64url(JSON)>，JSON 里 a 是地址候选列表（公网 IPv6 / 手动填的地址），
 * n 是号码，k 是昵称，e 是过期时间。故意不带任何签名密钥：地址和号码本来就是公开信息，
 * 防的是「手抄错一个字符」而不是防伪造。
 */
export function parseInvite(code) {
  const raw = String(code || '').trim().replace(/\s+/g, '');
  if (!raw) return { error: '请先粘贴对方的邀请码' };
  if (!raw.startsWith(INVITE_PREFIX)) return { error: '这不是邀请码（应该以 ' + INVITE_PREFIX + ' 开头）' };
  let obj = null;
  try {
    obj = JSON.parse(Buffer.from(raw.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'));
  } catch {
    return { error: '邀请码不完整，让对方重新复制一次' };
  }
  if (!obj || obj.v !== 1) return { error: '这个邀请码的版本不认识，让对方升级后再生成' };
  const expiresAt = Number(obj.e) || 0;
  if (!expiresAt || expiresAt < Date.now()) return { error: '邀请码已经过期了，让对方重新生成一个' };
  const number = String(obj.n || '');
  if (!NUMBER_RE.test(number)) return { error: '邀请码里的号码不对，可能复制时漏了字符' };
  const list = Array.isArray(obj.a) ? obj.a : [obj.a];
  const addrs = [];
  for (const item of list) {
    const addr = normalizeAddr(item);
    if (addr && !addrs.includes(addr)) addrs.push(addr);
  }
  if (!addrs.length) return { error: '邀请码里没有可用的地址' };
  return { number, nickname: String(obj.k || ''), addrs, expiresAt };
}

function addrOf(addr, path) {
  return 'http://' + normalizeAddr(addr) + path;
}

async function callPeer(addr, path, { method = 'GET', body, headers = {}, timeout = 6000 } = {}) {
  const url = addrOf(addr, path);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, body: json };
  } catch (err) {
    return { ok: false, status: 0, body: null, error: err?.name === 'AbortError' ? '超时' : err?.message || '连不上' };
  } finally {
    clearTimeout(timer);
  }
}

export function createFederation({ db, log, port = DEFAULT_PORT, version = '', lanUrls = () => [], publicV6 = () => [] }) {
  const peers = new Map(); // instanceId → { instanceId, addr, port, version, lastSeen, numbers, numbersAt }

  let worker = null;
  let discovery = null;
  let sock = null;
  let started = false;

  function meta(key) {
    const row = db.prepare('SELECT value FROM instance_meta WHERE key = ?').get(key);
    return row ? row.value : '';
  }

  function setMeta(key, value) {
    db.prepare(
      'INSERT INTO instance_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value ?? ''));
  }

  function instanceId() {
    let id = meta('instance_id');
    if (!id) {
      id = randomBytes(16).toString('hex');
      setMeta('instance_id', id);
    }
    return id;
  }

  /** 自动通过：拿我邀请码/二维码来加我的人，直接成为好友（默认开，可在设置里关） */
  function autoAccept() {
    return meta('auto_accept') !== '0';
  }

  function setAutoAccept(on) {
    setMeta('auto_accept', on ? '1' : '0');
    return autoAccept();
  }

  function publicAddr() {
    return meta('public_addr');
  }

  function setPublicAddr(raw) {
    const value = normalizeAddr(raw);
    setMeta('public_addr', value);
    return value;
  }

  function myAddresses() {
    const out = [];
    const pub = publicAddr();
    if (pub) out.push(pub);
    for (const url of lanUrls() || []) {
      const m = /^https?:\/\/([^/]+)/.exec(String(url));
      if (m && !out.includes(m[1])) out.push(m[1]);
    }
    return out;
  }

  /** 本机公网 IPv6 候选（[2409:...]:7788）。同一台机器可能有多条（临时地址会变），全给出去让对面挨个试 */
  function v6Addresses() {
    const out = [];
    for (const raw of publicV6() || []) {
      const addr = normalizeAddr(raw);
      if (addr && !out.includes(addr)) out.push(addr);
    }
    return out;
  }

  /** 生成邀请码：把「我能在哪被连上」打包成一段可以微信/短信发出去的文本 */
  function makeInvite(me) {
    const list = [];
    const pub = publicAddr();
    if (pub) list.push(pub);
    for (const addr of v6Addresses()) if (!list.includes(addr)) list.push(addr);
    /* 局域网地址放最后：同一个 Wi-Fi 下（手机连家里路由器）也能靠邀请码直接加，不要求有公网 IPv6 */
    for (const addr of myAddresses()) if (!list.includes(addr)) list.push(addr);
    if (!list.length) return null;
    const expiresAt = Date.now() + INVITE_TTL;
    const payload = { v: 1, a: list, n: me.number, k: String(me.nickname || ''), e: expiresAt };
    const code = INVITE_PREFIX + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return { code, expiresAt, addrs: list };
  }

  function info(boundToLan) {
    return {
      instanceId: instanceId(),
      version,
      port,
      boundToLan: !!boundToLan,
      lanUrls: lanUrls(),
      publicAddr: publicAddr(),
      publicV6: v6Addresses(),
      myAddresses: myAddresses(),
      autoAccept: autoAccept(),
    };
  }

  /** 本实例对外可查的账号：普通用户 + 公开的 Bot（不含远端镜像账号） */
  function directory() {
    const rows = db
      .prepare(
        "SELECT number, nickname, avatar, type FROM accounts WHERE type = 'user' OR (type = 'bot' AND is_public = 1) ORDER BY id",
      )
      .all();
    return { instanceId: instanceId(), version, numbers: rows };
  }

  function remoteAccountByNumber(number) {
    return db
      .prepare(
        "SELECT id, number, nickname, avatar, remote_addr, remote_instance, remote_secret FROM accounts WHERE number = ? AND type = 'remote'",
      )
      .get(number);
  }

  /** 记下某个远端号码的候选地址（对方实例可能报了一个连不上的地址，留几个备选） */
  function setPeerAddrs(number, addrs) {
    const list = rankAddrs(addrs);
    if (list.length) setMeta('peer_addrs:' + number, JSON.stringify(list.slice(0, 6)));
    return list;
  }

  function peerAddrs(number) {
    try {
      const raw = meta('peer_addrs:' + number);
      const list = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? rankAddrs(list) : [];
    } catch {
      return [];
    }
  }

  /** IPv4 排前面：同一个 Wi-Fi 下 IPv4 最稳，公网 IPv6 常因为临时地址/防火墙连不上 */
  function rankAddrs(list) {
    const seen = [];
    for (const raw of list || []) {
      const addr = normalizeAddr(raw);
      if (addr && !seen.includes(addr)) seen.push(addr);
    }
    const v4 = seen.filter((a) => !a.startsWith('['));
    const v6 = seen.filter((a) => a.startsWith('['));
    return [...v4, ...v6];
  }

  /**
   * 一个远端账号可能连得上的地址：历史候选 → 库里存的地址 → 本次请求的来源 IP → 局域网发现到的同实例地址。
   * 以前只用 remote_addr 一个地址，对方报错（比如手机只报公网 IPv6）就整条链路死掉。
   */
  function candidatesFor(acc, hint = '') {
    const list = [];
    if (acc?.number) list.push(...peerAddrs(acc.number));
    if (acc?.remote_addr) list.push(acc.remote_addr);
    if (hint) list.push(hint);
    const inst = acc?.remote_instance || '';
    if (inst) {
      for (const p of peers.values()) {
        if (p.instanceId === inst) list.push(p.addr);
      }
    }
    return rankAddrs(list);
  }

  function anyAccountByNumber(number) {
    return db.prepare('SELECT id, number, type, is_public FROM accounts WHERE number = ?').get(number);
  }

  function upsertRemote({ number, nickname, avatar, addr, instance }) {
    const existing = anyAccountByNumber(number);
    const now = Date.now();
    if (existing) {
      if (existing.type !== 'remote') return { conflict: true };
      db.prepare(
        "UPDATE accounts SET nickname = COALESCE(NULLIF(?, ''), nickname), avatar = COALESCE(NULLIF(?, ''), avatar), remote_addr = COALESCE(NULLIF(?, ''), remote_addr), remote_instance = COALESCE(NULLIF(?, ''), remote_instance) WHERE id = ?",
      ).run(nickname || '', avatar || '', addr || '', instance || '', existing.id);
      return { id: existing.id };
    }
    const info2 = db
      .prepare(
        "INSERT INTO accounts (number, type, nickname, bio, created_at, remote_addr, remote_instance) VALUES (?, 'remote', ?, '', ?, ?, ?)",
      )
      .run(number, nickname || number, now, addr || '', instance || '');
    return { id: Number(info2.lastInsertRowid) };
  }

  function makeFriends(aId, bId) {
    const now = Date.now();
    const ins = db.prepare('INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)');
    const tx = db.transaction(() => {
      ins.run(aId, bId, now);
      ins.run(bId, aId, now);
    });
    tx();
  }

  function areFriends(aId, bId) {
    return !!db
      .prepare('SELECT 1 AS x FROM friendships WHERE a_id = ? AND b_id = ?')
      .get(aId, bId);
  }

  function getOrCreateDm(aId, bId) {
    const existing = db
      .prepare(
        `SELECT c.id FROM conversations c
           JOIN conversation_members m1 ON m1.conversation_id = c.id AND m1.account_id = ?
           JOIN conversation_members m2 ON m2.conversation_id = c.id AND m2.account_id = ?
          WHERE c.kind = 'dm'`,
      )
      .get(aId, bId);
    if (existing) return existing.id;
    const tx = db.transaction(() => {
      const created = db.prepare("INSERT INTO conversations (kind, created_at) VALUES ('dm', ?)").run(Date.now());
      const id = Number(created.lastInsertRowid);
      const ins = db.prepare('INSERT INTO conversation_members (conversation_id, account_id) VALUES (?, ?)');
      ins.run(id, aId);
      ins.run(id, bId);
      return id;
    });
    return tx();
  }

  /** 查一个远端号码：addr 为空表示本实例 */
  async function lookup(me, addr, number) {
    const clean = normalizeAddr(addr);
    if (!clean) {
      const local = anyAccountByNumber(number);
      if (!local) return { code: 404, error: '没有这个号码' };
      const acc = db
        .prepare('SELECT id, number, type, nickname, bio, avatar FROM accounts WHERE id = ?')
        .get(local.id);
      const pending = db
        .prepare("SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
        .get(local.id, me.id);
      return {
        account: { ...acc, remote: false, addr: '' },
        isFriend: areFriends(me.id, local.id),
        hasPending: !!pending,
      };
    }
    const res = await callPeer(clean, '/api/federation/profile?number=' + encodeURIComponent(number));
    if (!res.ok) {
      if (res.status === 404 && res.body?.error) return { code: 404, error: res.body.error };
      return { code: 404, error: '对方实例连不上' };
    }
    const acc = res.body?.account;
    if (!acc) return { code: 404, error: '对方没有这个号码' };
    const mirror = remoteAccountByNumber(number);
    const pending = mirror
      ? db
          .prepare("SELECT 1 AS x FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
          .get(mirror.id, me.id)
      : null;
    return {
      account: { ...acc, remote: true, addr: clean },
      isFriend: mirror ? areFriends(me.id, mirror.id) : false,
      hasPending: !!pending,
    };
  }

  /** 发起跨实例好友申请 */
  async function sendRequest(me, addr, number, message) {
    const clean = normalizeAddr(addr);
    if (!clean) return { code: 400, error: '实例地址格式不对' };
    if (me.number === number) return { code: 400, error: '不能加自己' };
    const res = await callPeer(clean, '/api/federation/handshake', {
      method: 'POST',
      body: {
        from_instance: instanceId(),
        from_addr: myAddresses()[0] || '',
        from_addrs: myAddresses().slice(0, 4),
        from_number: me.number,
        from_nickname: me.nickname,
        from_avatar: me.avatar || '',
        to_number: number,
        message: message || '',
      },
    });
    if (!res.ok) {
      const map = {
        404: res.body?.error || '对方没有这个号码',
        409: res.body?.error || '这个号码在本实例已被占用',
        429: '对方实例太忙，稍后再试',
      };
      return { code: res.status || 502, error: map[res.status] || '对方实例连不上' };
    }
    return { ok: true, pending: true, friend: !!res.body?.friend, auto: !!res.body?.auto };
  }

  /** 收到别人的好友申请（对方实例调过来） */
  async function handleHandshake(body, hint = '') {
    const number = String(body?.to_number || '');
    const fromNumber = String(body?.from_number || '');
    if (!/^[1-9]\d{4,11}$/.test(number) || !/^[1-9]\d{4,11}$/.test(fromNumber)) {
      return { code: 400, error: '号码格式不对' };
    }
    const target = anyAccountByNumber(number);
    // 允许加别的实例上的公开 Bot，私有 Bot 不对外
    const joinable = !!target && (target.type === 'user' || (target.type === 'bot' && target.is_public === 1));
    if (!joinable) return { code: 404, error: '没有这个号码' };
    if (fromNumber === number) return { code: 400, error: '不能加自己' };

    const reported = [
      ...(Array.isArray(body?.from_addrs) ? body.from_addrs : []),
      body?.from_addr,
      body?.from_addr_hint,
      hint,
    ];
    const addrs = rankAddrs(reported);
    setPeerAddrs(fromNumber, addrs);
    const mirror = upsertRemote({
      number: fromNumber,
      nickname: String(body?.from_nickname || ''),
      avatar: String(body?.from_avatar || ''),
      addr: addrs[0] || '',
      instance: String(body?.from_instance || ''),
    });
    if (mirror.conflict) return { code: 409, error: '这个号码在本实例已被占用' };
    if (areFriends(target.id, mirror.id)) return { ok: true, already: true };

    const dup = db
      .prepare("SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'")
      .get(mirror.id, target.id);

    /* 自动通过：对方用我的邀请码/二维码来加，就不用再等我在界面上点「同意」。
       这里直接把好友关系建立起来并回执对方，两边同时成为好友。 */
    if (autoAccept()) {
      const targetRow = db
        .prepare('SELECT id, number, nickname, avatar, remote_addr, remote_instance, remote_secret FROM accounts WHERE id = ?')
        .get(target.id);
      const mirrorRow = db
        .prepare('SELECT id, number, nickname, avatar, remote_addr, remote_instance, remote_secret FROM accounts WHERE id = ?')
        .get(mirror.id);
      const out = await notifyAccepted(mirrorRow, targetRow);
      if (out.ok) {
        if (dup) db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(dup.id);
        log?.info?.('[fed] 自动通过 ' + fromNumber + ' → ' + number);
        return { ok: true, friend: true, auto: true };
      }
      log?.warn?.('[fed] 自动通过失败，退回人工同意：' + (out.error || ''));
    }

    if (dup) return { ok: true, pending: true };
    db.prepare(
      "INSERT INTO friend_requests (from_id, to_id, message, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    ).run(mirror.id, target.id, String(body?.message || '').slice(0, 120), Date.now());
    log?.info?.('[fed] 收到远端好友申请 ' + fromNumber + ' → ' + number);
    return { ok: true, pending: true };
  }

  /** 本端同意了一个远端好友申请 → 回执对方实例，建立双向好友 */
  async function notifyAccepted(remoteAccount, me) {
    const secret = randomBytes(24).toString('hex');
    const payload = {
      instance_id: instanceId(),
      secret,
      from_number: me.number,
      to_number: remoteAccount.number,
      nickname: me.nickname,
      avatar: me.avatar || '',
      addr: myAddresses()[0] || '',
      addrs: myAddresses().slice(0, 4),
    };
    const cands = candidatesFor(remoteAccount);
    if (!cands.length) return { ok: false, error: '缺少对方实例地址' };
    const tried = [];
    for (const addr of cands) {
      const res = await callPeer(addr, '/api/federation/accept', { method: 'POST', body: payload, timeout: 5000 });
      if (res.ok) {
        db.prepare('UPDATE accounts SET remote_secret = ?, remote_addr = ? WHERE id = ?').run(secret, addr, remoteAccount.id);
        setPeerAddrs(remoteAccount.number, [addr, ...cands]);
        makeFriends(me.id, remoteAccount.id);
        log?.info?.('[fed] 好友建立成功 ' + me.number + ' ↔ ' + remoteAccount.number + ' @ ' + addr);
        return { ok: true, addr };
      }
      tried.push(addr + (res.status ? '(' + res.status + ')' : ''));
    }
    log?.warn?.('[fed] 好友回执失败 ' + remoteAccount.number + ' 试过 ' + tried.join(', '));
    return { ok: false, error: '对方实例没连上（试过 ' + cands.length + ' 个地址：' + cands.join(' / ') + '）' };
  }

  /** 对方实例回执：加好友成功 */
  function handleAccept(body, hint = '') {
    const number = String(body?.from_number || '');
    const toNumber = String(body?.to_number || '');
    const secret = String(body?.secret || '');
    if (!number || !secret) return { code: 400, error: '参数不全' };
    const meRow = anyAccountByNumber(toNumber);
    if (!meRow) return { code: 404, error: '没有这个号码' };
    const reported = [...(Array.isArray(body?.addrs) ? body.addrs : []), body?.addr, hint];
    const addrs = rankAddrs(reported);
    setPeerAddrs(number, addrs);
    const mirror = upsertRemote({
      number,
      nickname: String(body?.nickname || ''),
      avatar: String(body?.avatar || ''),
      addr: addrs[0] || '',
      instance: String(body?.instance_id || ''),
    });
    if (mirror.conflict) return { code: 409, error: '这个号码在本实例已被占用' };
    db.prepare('UPDATE accounts SET remote_secret = ? WHERE id = ?').run(secret, mirror.id);
    makeFriends(meRow.id, mirror.id);
    db.prepare(
      "UPDATE friend_requests SET status = 'accepted' WHERE from_id = ? AND to_id = ? AND status = 'pending'",
    ).run(meRow.id, mirror.id);
    log?.info?.('[fed] 远端好友建立 ' + toNumber + ' ↔ ' + number);
    return { ok: true };
  }

  /** 对方实例投递一条消息过来 */
  function handleDeliver(headers, body) {
    const fromNumber = String(body?.from_number || '');
    const toNumber = String(body?.to_number || '');
    const secret = String(headers['x-fe-secret'] || '');
    const instance = String(headers['x-fe-instance'] || '');
    const mirror = remoteAccountByNumber(fromNumber);
    if (!mirror) return { code: 403, error: '不认识的实例' };
    if (!mirror.remote_secret || !secret || mirror.remote_secret.length !== secret.length) {
      return { code: 403, error: '密钥不对' };
    }
    if (!timingSafeEqual(Buffer.from(mirror.remote_secret), Buffer.from(secret))) {
      return { code: 403, error: '密钥不对' };
    }
    if (instance && mirror.remote_instance && instance !== mirror.remote_instance) {
      return { code: 403, error: '实例身份不匹配' };
    }
    const me = anyAccountByNumber(toNumber);
    if (!me) return { code: 404, error: '没有这个号码' };

    const msg = body?.message || {};
    const kind = ['text', 'image', 'file', 'voice', 'forward', 'merge'].includes(msg.kind) ? msg.kind : 'text';
    const text = String(msg.body || '');
    if (!text) return { code: 400, error: '空消息' };

    const convId = getOrCreateDm(me.id, mirror.id);
    const now = Date.now();
    const created = Number(msg.created_at) || now;
    const info2 = db
      .prepare(
        'INSERT INTO messages (conversation_id, sender_id, body, created_at, kind, reply_to_id, meta) VALUES (?, ?, ?, ?, ?, NULL, ?)',
      )
      .run(convId, mirror.id, text, created, kind, String(msg.meta || ''));
    return { ok: true, id: Number(info2.lastInsertRowid), conversationId: convId };
  }

  /** 本地发出一条消息后，把它塞进投递队列 */
  function enqueue(convId, me, peer, msg) {
    const addr = candidatesFor(peer)[0] || normalizeAddr(peer.remote_addr);
    if (!addr || !peer.remote_secret) return { ok: false, error: '远端好友缺少地址或密钥' };
    db.prepare(
      `INSERT INTO federation_outbox
         (conv_id, from_number, to_number, to_addr, to_secret, payload, attempts, next_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).run(
      convId,
      me.number,
      peer.number,
      addr,
      peer.remote_secret,
      JSON.stringify(msg),
      Date.now(),
      Date.now(),
    );
    return { ok: true };
  }

  async function flushOnce() {
    const due = db
      .prepare('SELECT * FROM federation_outbox WHERE next_at <= ? ORDER BY id LIMIT 20')
      .all(Date.now());
    for (const row of due) {
      const res = await callPeer(row.to_addr, '/api/federation/deliver', {
        method: 'POST',
        headers: { 'x-fe-instance': instanceId(), 'x-fe-secret': row.to_secret },
        body: { from_number: row.from_number, to_number: row.to_number, message: JSON.parse(row.payload) },
      });
      if (res.ok) {
        db.prepare('DELETE FROM federation_outbox WHERE id = ?').run(row.id);
        continue;
      }
      const attempts = row.attempts + 1;
      // 对方地址可能变了（换了 Wi-Fi / IPv6 临时地址过期）：换一个候选地址再投
      const alt = candidatesFor({ number: row.to_number, remote_addr: row.to_addr }).find((a) => a !== row.to_addr);
      if (alt) {
        db.prepare('UPDATE federation_outbox SET to_addr = ? WHERE id = ?').run(alt, row.id);
        log?.info?.('[fed] 投递改地址 ' + row.to_number + ' → ' + alt);
      }
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare('DELETE FROM federation_outbox WHERE id = ?').run(row.id);
        log?.warn?.('[fed] 投递放弃 ' + row.to_number + ' → ' + row.to_addr);
        continue;
      }
      const backoff = Math.min(5000 * 2 ** Math.min(attempts, 6), 300_000);
      db.prepare('UPDATE federation_outbox SET attempts = ?, next_at = ?, last_error = ? WHERE id = ?').run(
        attempts,
        Date.now() + backoff,
        String(res.body?.error || res.error || res.status || '').slice(0, 200),
        row.id,
      );
    }
  }

  function nearbyList() {
    const now = Date.now();
    const out = [];
    for (const p of peers.values()) {
      out.push({
        instanceId: p.instanceId,
        addr: p.addr,
        port: p.port,
        version: p.version,
        lastSeen: p.lastSeen,
        numbers: p.numbers || [],
      });
    }
    return { instances: out.sort((a, b) => b.lastSeen - a.lastSeen) };
  }

  async function refreshNumbers(peer) {
    const res = await callPeer(peer.addr, '/api/federation/directory', { timeout: 3000 });
    peer.numbersAt = Date.now();
    if (res.ok && Array.isArray(res.body?.numbers)) {
      peer.numbers = res.body.numbers.filter((n) => n && (n.type === 'user' || n.type === 'bot'));
    }
  }

  function onAnnounce(msg, rinfo) {
    if (!msg || msg.fe !== 1 || !msg.instanceId || msg.instanceId === instanceId()) return;
    /* 本机地址发出来的广播当成自己（同一台机器起过两个实例、或 instanceId 变过时会漏进来），
       这种「附近的实例」点加就是加自己，直接丢掉 */
    const fromAddr = rinfo.address + ':' + (Number(msg.port) || DEFAULT_PORT);
    if (myAddresses().includes(fromAddr)) return;
    const addr = rinfo.address + ':' + (Number(msg.port) || DEFAULT_PORT);
    const prev = peers.get(msg.instanceId);
    const peer = prev || { instanceId: msg.instanceId, numbers: [], numbersAt: 0 };
    peer.addr = addr;
    peer.port = Number(msg.port) || DEFAULT_PORT;
    peer.version = String(msg.version || '');
    peer.lastSeen = Date.now();
    peers.set(msg.instanceId, peer);
    if (Date.now() - (peer.numbersAt || 0) > 30_000) {
      refreshNumbers(peer).catch(() => {});
    }
  }

  function startDiscovery() {
    if (process.env.FE_DISCOVERY === '0') return;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', (err) => log?.warn?.('[fed] 发现端口不可用：' + err.message));
      sock.on('message', (buf, rinfo) => {
        try {
          onAnnounce(JSON.parse(buf.toString('utf8')), rinfo);
        } catch {
          /* 别人家的广播，忽略 */
        }
      });
      sock.bind(DISCOVERY_PORT, () => {
        try {
          sock.setBroadcast(true);
        } catch {
          /* 某些系统不允许，降级为只能被动接收 */
        }
      });
      discovery = setInterval(() => {
        if (!sock) return;
        const payload = Buffer.from(JSON.stringify({ fe: 1, instanceId: instanceId(), version, port }));
        try {
          sock.send(payload, 0, payload.length, DISCOVERY_PORT, '255.255.255.255', () => {});
        } catch {
          /* 广播失败就等下个周期 */
        }
      }, 5000);
      discovery.unref?.();
    } catch (err) {
      log?.warn?.('[fed] 局域网发现启动失败：' + err.message);
    }
  }

  function start() {
    if (started) return;
    started = true;
    instanceId();
    worker = setInterval(() => {
      flushOnce().catch((err) => log?.warn?.('[fed] 投递失败：' + err.message));
    }, 4000);
    worker.unref?.();
    startDiscovery();
    flushOnce().catch(() => {});
  }

  function stop() {
    started = false;
    if (worker) clearInterval(worker);
    if (discovery) clearInterval(discovery);
    worker = null;
    discovery = null;
    try {
      sock?.close();
    } catch {
      /* 已经关了 */
    }
    sock = null;
    peers.clear();
  }

  return {
    instanceId,
    autoAccept,
    setAutoAccept,
    publicAddr,
    setPublicAddr,
    myAddresses,
    v6Addresses,
    makeInvite,
    info,
    directory,
    nearby: nearbyList,
    lookup,
    sendRequest,
    handleHandshake,
    handleAccept,
    handleDeliver,
    notifyAccepted,
    enqueue,
    flushOnce,
    start,
    stop,
  };
}
