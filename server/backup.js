import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * 账号搬迁包：把一个账号在本机的全部数据打成一个加密文件，
 * 换设备/换实例时导入就能恢复。加密用密码派生密钥（scrypt + AES-256-GCM），
 * 所以备份文件离开这台机器也安全，没有密码谁也读不出内容。
 */

export const BACKUP_FORMAT = 'fe-account-backup';
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 32;

function deriveKey(password, salt) {
  return scryptSync(String(password), salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

/** 把明文对象加密成可传输的包 */
export function sealPackage(payload, password) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(password, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const plain = Buffer.from(JSON.stringify(payload), 'utf8');
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    format: BACKUP_FORMAT,
    v: 1,
    kdf: { name: 'scrypt', N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, salt: salt.toString('hex') },
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: data.toString('base64'),
  };
}

/** 解包；密码不对会抛错，调用方要捕获 */
export function openPackage(pkg, password) {
  if (!pkg || pkg.format !== BACKUP_FORMAT) throw new Error('这不是本应用的账号备份文件');
  const salt = Buffer.from(String(pkg.kdf?.salt || ''), 'hex');
  const iv = Buffer.from(String(pkg.iv || ''), 'hex');
  const tag = Buffer.from(String(pkg.tag || ''), 'hex');
  const data = Buffer.from(String(pkg.data || ''), 'base64');
  if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16 || data.length === 0) {
    throw new Error('备份文件损坏了，读不出来');
  }
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let plain;
  try {
    plain = Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    throw new Error('密码不对，打不开这个备份');
  }
  try {
    return JSON.parse(plain.toString('utf8'));
  } catch {
    throw new Error('备份内容坏了，解析失败');
  }
}

/* ---------------- 导出 ---------------- */

function pick(db, sql, ...args) {
  return db.prepare(sql).all(...args);
}

/** 收集一个账号的全部数据（纯数据，不含本机会话 token） */
export function collectAccount(db, accountId) {
  const me = db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId);
  if (!me) throw new Error('没有这个账号');

  const convIds = pick(db, 'SELECT conversation_id FROM conversation_members WHERE account_id = ?', accountId).map((r) => r.conversation_id);
  const groupIds = pick(db, 'SELECT group_id FROM group_members WHERE account_id = ?', accountId).map((r) => r.group_id);
  const botRows = pick(db, "SELECT id FROM accounts WHERE type = 'bot' AND owner_id = ?", accountId).map((r) => r.id);
  const friendIds = pick(
    db,
    'SELECT b_id AS id FROM friendships WHERE a_id = ? UNION SELECT a_id AS id FROM friendships WHERE b_id = ?',
    accountId,
    accountId
  ).map((r) => r.id);

  const msgRows = convIds.length
    ? pick(db, 'SELECT * FROM messages WHERE conversation_id IN (' + convIds.map(() => '?').join(',') + ') ORDER BY id', ...convIds)
    : [];
  const msgIds = msgRows.map((m) => m.id);

  /* 会话里的其他成员也要带上，不然恢复后看不到对方是谁 */
  const convMemberIds = convIds.length
    ? pick(db, 'SELECT account_id FROM conversation_members WHERE conversation_id IN (' + convIds.map(() => '?').join(',') + ')', ...convIds).map((r) => r.account_id)
    : [];
  const groupMemberIds = groupIds.length
    ? pick(db, 'SELECT account_id FROM group_members WHERE group_id IN (' + groupIds.map(() => '?').join(',') + ')', ...groupIds).map((r) => r.account_id)
    : [];
  const requestIds = pick(db, 'SELECT from_id, to_id FROM friend_requests WHERE from_id = ? OR to_id = ?', accountId, accountId)
    .flatMap((r) => [r.from_id, r.to_id]);

  const accountIds = Array.from(new Set([accountId, ...friendIds, ...botRows, ...convMemberIds, ...groupMemberIds, ...requestIds])).filter(Boolean);

  const accounts = accountIds.length
    ? pick(db, 'SELECT * FROM accounts WHERE id IN (' + accountIds.map(() => '?').join(',') + ')', ...accountIds).map((row) => {
        const copy = { ...row };
        /* 别人的密码哈希没必要带走，自己的要带走：换设备后还能用原密码登录 */
        if (copy.id !== accountId) copy.password_hash = null;
        return copy;
      })
    : [];

  const conversations = convIds.length
    ? pick(db, 'SELECT * FROM conversations WHERE id IN (' + convIds.map(() => '?').join(',') + ')', ...convIds)
    : [];
  const members = convIds.length
    ? pick(db, 'SELECT * FROM conversation_members WHERE conversation_id IN (' + convIds.map(() => '?').join(',') + ')', ...convIds)
    : [];
  const reactions = msgIds.length
    ? pick(db, 'SELECT * FROM message_reactions WHERE message_id IN (' + msgIds.map(() => '?').join(',') + ')', ...msgIds)
    : [];
  const deletions = msgIds.length
    ? pick(db, 'SELECT * FROM message_deletions WHERE account_id = ? AND message_id IN (' + msgIds.map(() => '?').join(',') + ')', accountId, ...msgIds)
    : [];
  const favorites = msgIds.length
    ? pick(db, 'SELECT * FROM favorites WHERE account_id = ? AND message_id IN (' + msgIds.map(() => '?').join(',') + ')', accountId, ...msgIds)
    : [];

  const groups = groupIds.length
    ? pick(db, 'SELECT * FROM groups WHERE id IN (' + groupIds.map(() => '?').join(',') + ')', ...groupIds)
    : [];
  const groupMembers = groupIds.length
    ? pick(db, 'SELECT * FROM group_members WHERE group_id IN (' + groupIds.map(() => '?').join(',') + ')', ...groupIds)
    : [];
  const groupFiles = groupIds.length
    ? pick(db, 'SELECT * FROM group_files WHERE group_id IN (' + groupIds.map(() => '?').join(',') + ')', ...groupIds)
    : [];
  const groupRequests = groupIds.length
    ? pick(db, 'SELECT * FROM group_requests WHERE to_id = ? OR from_id = ?', accountId, accountId)
    : [];

  return {
    format: BACKUP_FORMAT,
    v: 1,
    exportedAt: Date.now(),
    ownerNumber: me.number,
    ownerId: accountId,
    tables: {
      accounts,
      friendships: pick(db, 'SELECT * FROM friendships WHERE a_id = ? OR b_id = ?', accountId, accountId),
      friend_requests: pick(db, 'SELECT * FROM friend_requests WHERE from_id = ? OR to_id = ?', accountId, accountId),
      blocks: pick(db, 'SELECT * FROM blocks WHERE a_id = ?', accountId),
      friend_groups: pick(db, 'SELECT * FROM friend_groups WHERE account_id = ?', accountId),
      bot_links: botRows.length ? pick(db, 'SELECT * FROM bot_links WHERE account_id IN (' + botRows.map(() => '?').join(',') + ')', ...botRows) : [],
      bot_models: botRows.length ? pick(db, 'SELECT * FROM bot_models WHERE account_id IN (' + botRows.map(() => '?').join(',') + ')', ...botRows) : [],
      conversations,
      conversation_members: members,
      messages: msgRows,
      message_reactions: reactions,
      message_deletions: deletions,
      favorites,
      groups,
      group_members: groupMembers,
      group_files: groupFiles,
      group_requests: groupRequests,
    },
  };
}

/* ---------------- 导入 ---------------- */

function columnsOf(row) {
  return Object.keys(row).filter((k) => k !== 'id' || row.id === undefined);
}

function insertRow(db, table, row, overrides = {}) {
  const data = { ...row, ...overrides };
  const cols = Object.keys(data).filter((k) => data[k] !== undefined);
  const sql = 'INSERT INTO ' + table + ' (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')';
  const info = db.prepare(sql).run(...cols.map((k) => data[k]));
  return Number(info.lastInsertRowid || 0);
}

/**
 * 把备份写回本机，返回新账号 id。
 * 号码已经存在会直接报错（调用方翻译成人话）。
 */
export function restoreAccount(db, payload) {
  if (!payload || payload.format !== BACKUP_FORMAT || !payload.tables) throw new Error('备份内容不完整');
  const t = payload.tables;
  const owner = (t.accounts || []).find((a) => a.id === payload.ownerId) || (t.accounts || []).find((a) => a.number === payload.ownerNumber);
  if (!owner) throw new Error('备份里找不到账号资料');
  const exists = db.prepare('SELECT id FROM accounts WHERE number = ?').get(owner.number);
  if (exists) {
    const err = new Error('这个号码已经在本机存在了');
    err.code = 'NUMBER_TAKEN';
    throw err;
  }

  const accountMap = new Map();
  const convMap = new Map();
  const msgMap = new Map();
  const groupMap = new Map();
  const fgroupMap = new Map();

  db.exec('BEGIN IMMEDIATE');
  try {
    /* 1. 账号：先建自己，再建别人（别人的号码本机已有就复用） */
    const ordered = [owner, ...(t.accounts || []).filter((a) => a.id !== owner.id)];
    for (const row of ordered) {
      const hit = db.prepare('SELECT id FROM accounts WHERE number = ?').get(row.number);
      if (hit) { accountMap.set(row.id, hit.id); continue; }
      const copy = { ...row };
      delete copy.id;
      const newId = insertRow(db, 'accounts', copy);
      accountMap.set(row.id, newId);
    }
    const myId = accountMap.get(owner.id);

    /* 2. 会话与成员 */
    for (const row of t.conversations || []) {
      const newId = insertRow(db, 'conversations', { kind: row.kind, created_at: row.created_at });
      convMap.set(row.id, newId);
    }
    for (const row of t.conversation_members || []) {
      const conv = convMap.get(row.conversation_id);
      const acc = accountMap.get(row.account_id);
      if (!conv || !acc) continue;
      const copy = { ...row, conversation_id: conv, account_id: acc };
      const cols = Object.keys(copy);
      db.prepare('INSERT OR IGNORE INTO conversation_members (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')')
        .run(...cols.map((k) => copy[k]));
    }

    /* 3. 消息 */
    for (const row of t.messages || []) {
      const conv = convMap.get(row.conversation_id);
      const sender = accountMap.get(row.sender_id);
      if (!conv || !sender) continue;
      const copy = { ...row };
      delete copy.id;
      copy.conversation_id = conv;
      copy.sender_id = sender;
      if (copy.reply_to_id) copy.reply_to_id = msgMap.get(copy.reply_to_id) || null;
      const newId = insertRow(db, 'messages', copy);
      msgMap.set(row.id, newId);
    }
    for (const row of t.message_reactions || []) {
      const msg = msgMap.get(row.message_id);
      const acc = accountMap.get(row.account_id);
      if (!msg || !acc) continue;
      db.prepare('INSERT OR IGNORE INTO message_reactions (message_id, account_id, emoji, created_at) VALUES (?, ?, ?, ?)')
        .run(msg, acc, row.emoji, row.created_at);
    }
    for (const row of t.message_deletions || []) {
      const msg = msgMap.get(row.message_id);
      const acc = accountMap.get(row.account_id);
      if (!msg || !acc) continue;
      db.prepare('INSERT OR IGNORE INTO message_deletions (message_id, account_id, created_at) VALUES (?, ?, ?)').run(msg, acc, row.created_at);
    }
    for (const row of t.favorites || []) {
      const msg = msgMap.get(row.message_id);
      const acc = accountMap.get(row.account_id);
      if (!msg || !acc) continue;
      db.prepare('INSERT OR IGNORE INTO favorites (account_id, message_id, created_at) VALUES (?, ?, ?)').run(acc, msg, row.created_at);
    }

    /* 4. 好友关系、分组、拉黑 */
    for (const row of t.friend_groups || []) {
      const acc = accountMap.get(row.account_id);
      if (!acc) continue;
      const newId = insertRow(db, 'friend_groups', { account_id: acc, name: row.name, sort_order: row.sort_order || 0, created_at: row.created_at });
      fgroupMap.set(row.id, newId);
    }
    for (const row of t.friendships || []) {
      const a = accountMap.get(row.a_id);
      const b = accountMap.get(row.b_id);
      if (!a || !b) continue;
      const cols = ['a_id', 'b_id', 'created_at'];
      const vals = [a, b, row.created_at];
      if (row.group_id != null && fgroupMap.has(row.group_id)) { cols.push('group_id'); vals.push(fgroupMap.get(row.group_id)); }
      if (row.remark != null) { cols.push('remark'); vals.push(row.remark); }
      if (row.special != null) { cols.push('special'); vals.push(row.special); }
      db.prepare('INSERT OR IGNORE INTO friendships (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...vals);
    }
    for (const row of t.blocks || []) {
      const a = accountMap.get(row.a_id);
      const b = accountMap.get(row.b_id);
      if (!a || !b) continue;
      db.prepare('INSERT OR IGNORE INTO blocks (a_id, b_id, created_at) VALUES (?, ?, ?)').run(a, b, row.created_at);
    }
    for (const row of t.friend_requests || []) {
      const from = accountMap.get(row.from_id);
      const to = accountMap.get(row.to_id);
      if (!from || !to) continue;
      const copy = { ...row, from_id: from, to_id: to };
      delete copy.id;
      insertRow(db, 'friend_requests', copy);
    }

    /* 5. 群 */
    for (const row of t.groups || []) {
      const hit = db.prepare('SELECT id FROM groups WHERE number = ?').get(row.number);
      if (hit) { groupMap.set(row.id, hit.id); continue; }
      const copy = { ...row };
      delete copy.id;
      copy.owner_id = accountMap.get(row.owner_id) || myId;
      copy.conversation_id = row.conversation_id ? convMap.get(row.conversation_id) || null : null;
      groupMap.set(row.id, insertRow(db, 'groups', copy));
    }
    for (const row of t.group_members || []) {
      const g = groupMap.get(row.group_id);
      const acc = accountMap.get(row.account_id);
      if (!g || !acc) continue;
      const copy = { ...row, group_id: g, account_id: acc };
      const cols = Object.keys(copy);
      db.prepare('INSERT OR IGNORE INTO group_members (' + cols.join(', ') + ') VALUES (' + cols.map(() => '?').join(', ') + ')').run(...cols.map((k) => copy[k]));
    }
    for (const row of t.group_files || []) {
      const g = groupMap.get(row.group_id);
      const up = accountMap.get(row.uploader_id);
      if (!g || !up) continue;
      const copy = { ...row, group_id: g, uploader_id: up };
      delete copy.id;
      insertRow(db, 'group_files', copy);
    }
    for (const row of t.group_requests || []) {
      const g = groupMap.get(row.group_id);
      const from = accountMap.get(row.from_id);
      const to = accountMap.get(row.to_id);
      if (!g || !from || !to) continue;
      const copy = { ...row, group_id: g, from_id: from, to_id: to };
      delete copy.id;
      insertRow(db, 'group_requests', copy);
    }

    /* 6. Bot 接线与模型配置 */
    for (const row of t.bot_links || []) {
      const acc = accountMap.get(row.account_id);
      if (!acc) continue;
      insertRow(db, 'bot_links', { ...row, account_id: acc });
    }
    for (const row of t.bot_models || []) {
      const acc = accountMap.get(row.account_id);
      if (!acc) continue;
      insertRow(db, 'bot_models', { ...row, account_id: acc });
    }

    db.exec('COMMIT');
    return { accountId: myId, number: owner.number, counts: countRestored(db, myId) };
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败也别掩盖原错误 */ }
    throw err;
  }
}

function countRestored(db, accountId) {
  const one = (sql, ...args) => db.prepare(sql).get(...args).c;
  return {
    friends: one('SELECT COUNT(*) AS c FROM friendships WHERE a_id = ?', accountId),
    conversations: one('SELECT COUNT(*) AS c FROM conversation_members WHERE account_id = ?', accountId),
    messages: one(
      'SELECT COUNT(*) AS c FROM messages WHERE conversation_id IN (SELECT conversation_id FROM conversation_members WHERE account_id = ?)',
      accountId
    ),
    groups: one('SELECT COUNT(*) AS c FROM group_members WHERE account_id = ?', accountId),
  };
}
