import Fastify from 'fastify';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * 中继服务（relay）
 *
 * 为什么要有它：两个实例在不同网络时，家用宽带多半没有公网地址，光猫/路由器还会拦入站，
 * 于是「A 加 B 好友」这种要求对方当下可达的操作必然失败（以前报「对方实例没连上」）。
 *
 * 中继只做一件很窄的事：**替离线的实例存消息**。
 *   - 每个实例启动后主动连中继（出站长连接/轮询），不需要任何入站端口映射
 *   - 发不出去的投递（好友申请、好友回执、私聊消息）先丢给中继排队
 *   - 对方上线后自己来拉，拉完回执确认删除
 *
 * 它不存账号、不存聊天记录的主体、不参与加密，消息在队列里最多放 7 天，
 * 所以「自托管」这条没有丢：数据仍然在各自的实例里，中继只是邮局。
 *
 * 单独运行：
 *   node server/relay.js            # 默认 0.0.0.0:7800
 *   FE_RELAY_PORT=9000 node server/relay.js
 */

export const RELAY_EVENT_TTL = 7 * 24 * 3600 * 1000;
/** 超过这个时间没心跳就当作离线（只影响状态显示，消息照存） */
export const RELAY_ONLINE_WINDOW = 90_000;

function readVersion() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '');
  } catch {
    return '';
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length || x.length === 0) return false;
  return timingSafeEqual(x, y);
}

/**
 * 建中继应用。返回的 fastify 实例可以 listen，也可以直接 inject 做测试。
 */
export function buildRelay({ dbFile = process.env.FE_RELAY_DB || join(homedir(), '.furry-everpony', 'relay.db'), log = console, version = '' } = {}) {
  mkdirSync(dirname(dbFile), { recursive: true });
  // 中继数据库的父目录可能还不存在（首次跑中继的机器），先建出来
  try {
    mkdirSync(dirname(dbFile), { recursive: true });
  } catch {
    /* 目录已存在或无权限，交给下面报错 */
  }
  const raw = new DatabaseSync(dbFile);
  raw.exec('PRAGMA journal_mode = WAL');
  raw.exec(`
    CREATE TABLE IF NOT EXISTS relay_instances (
      instance_id TEXT PRIMARY KEY,
      secret      TEXT NOT NULL,
      addr        TEXT NOT NULL DEFAULT '',
      version     TEXT NOT NULL DEFAULT '',
      last_seen   INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS relay_queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id    TEXT NOT NULL,
      to_id      TEXT NOT NULL,
      kind       TEXT NOT NULL,
      payload    TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_relay_queue_to ON relay_queue (to_id, id);
  `);

  const db = {
    raw,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    close: () => raw.close(),
  };

  const app = Fastify({ logger: false, bodyLimit: 4 * 1024 * 1024 });

  function instance(id) {
    return db.prepare('SELECT * FROM relay_instances WHERE instance_id = ?').get(String(id || ''));
  }

  function touch(id) {
    db.prepare('UPDATE relay_instances SET last_seen = ? WHERE instance_id = ?').run(Date.now(), String(id));
  }

  function authOk(id, secret) {
    const row = instance(id);
    if (!row) return { code: 404, error: '这个实例还没在中继登记' };
    if (!safeEqual(row.secret, secret)) return { code: 403, error: '中继密钥不对' };
    return { ok: true, row };
  }

  function sweep() {
    const now = Date.now();
    const out = db.prepare('DELETE FROM relay_queue WHERE expires_at < ?').run(now);
    return Number(out.changes || 0);
  }

  function queueCount(toId) {
    const row = db.prepare('SELECT COUNT(*) AS n FROM relay_queue WHERE to_id = ?').get(String(toId || ''));
    return Number(row?.n || 0);
  }

  app.get('/api/health', async () => {
    const instances = db.prepare('SELECT COUNT(*) AS n FROM relay_instances').get();
    const queued = db.prepare('SELECT COUNT(*) AS n FROM relay_queue').get();
    return {
      ok: true,
      role: 'relay',
      version,
      instances: Number(instances?.n || 0),
      queued: Number(queued?.n || 0),
    };
  });

  /** 实例登记：第一次带 secret 建号，之后必须 secret 一致 */
  app.post('/api/relay/register', async (req, reply) => {
    const body = req.body || {};
    const id = String(body.instanceId || '').trim();
    const secret = String(body.secret || '').trim();
    if (!/^[0-9a-f]{8,64}$/i.test(id)) return reply.code(400).send({ error: 'instanceId 不对' });
    if (secret.length < 16 || secret.length > 128) return reply.code(400).send({ error: 'secret 太短' });
    const addr = String(body.addr || '').slice(0, 200);
    const ver = String(body.version || '').slice(0, 40);
    const now = Date.now();
    const row = instance(id);
    if (row) {
      if (!safeEqual(row.secret, secret)) return reply.code(403).send({ error: '这个实例已经被别的密钥登记了' });
      db.prepare('UPDATE relay_instances SET addr = ?, version = ?, last_seen = ? WHERE instance_id = ?').run(addr, ver, now, id);
    } else {
      db.prepare(
        'INSERT INTO relay_instances (instance_id, secret, addr, version, last_seen, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, secret, addr, ver, now, now);
    }
    sweep();
    return { ok: true, instanceId: id, queued: queueCount(id), onlineWindow: RELAY_ONLINE_WINDOW };
  });

  app.post('/api/relay/heartbeat', async (req, reply) => {
    const body = req.body || {};
    const auth = authOk(body.instanceId, body.secret);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.error });
    touch(body.instanceId);
    return { ok: true, queued: queueCount(body.instanceId) };
  });

  /** 投递：不管对方在不在线都先入队，对方来拉才删 */
  app.post('/api/relay/send', async (req, reply) => {
    const body = req.body || {};
    const auth = authOk(body.from, body.secret);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.error });
    const to = String(body.to || '').trim();
    const kind = String(body.kind || '').trim();
    if (!to) return reply.code(400).send({ error: '缺少收件实例' });
    if (!['handshake', 'accept', 'deliver'].includes(kind)) return reply.code(400).send({ error: '不认识的事件类型' });
    if (!instance(to)) return reply.code(404).send({ error: '收件实例还没在中继登记' });
    const payload = JSON.stringify(body.payload ?? {});
    if (payload.length > 2 * 1024 * 1024) return reply.code(413).send({ error: '内容太大' });
    const now = Date.now();
    const out = db
      .prepare('INSERT INTO relay_queue (from_id, to_id, kind, payload, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(String(body.from), to, kind, payload, now, now + RELAY_EVENT_TTL);
    touch(body.from);
    const target = instance(to);
    const online = target ? now - Number(target.last_seen || 0) < RELAY_ONLINE_WINDOW : false;
    log.info?.('[relay] ' + body.from.slice(0, 8) + ' → ' + to.slice(0, 8) + ' ' + kind + '（' + (online ? '对方在线' : '对方离线，先存着') + '）');
    return { ok: true, id: Number(out.lastInsertRowid), online };
  });

  /** 拉取：since 之后的事件，按 id 升序，最多 100 条 */
  app.get('/api/relay/pull', async (req, reply) => {
    const q = req.query || {};
    const auth = authOk(q.instanceId, q.secret);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.error });
    touch(q.instanceId);
    const since = Math.max(0, Number(q.since) || 0);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
    sweep();
    const rows = db
      .prepare('SELECT id, from_id, kind, payload, created_at FROM relay_queue WHERE to_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(String(q.instanceId), since, limit);
    const events = rows.map((r) => {
      let payload = {};
      try {
        payload = JSON.parse(r.payload);
      } catch {
        payload = {};
      }
      return { id: Number(r.id), from: r.from_id, kind: r.kind, payload, at: Number(r.created_at) };
    });
    const next = events.length ? events[events.length - 1].id : since;
    return { ok: true, events, next, more: events.length >= limit };
  });

  /** 确认收到，删掉队列里的这些条（不确认就会一直重发） */
  app.post('/api/relay/ack', async (req, reply) => {
    const body = req.body || {};
    const auth = authOk(body.instanceId, body.secret);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.error });
    const ids = Array.isArray(body.ids) ? body.ids.map((x) => Number(x)).filter((x) => Number.isFinite(x)) : [];
    if (!ids.length) return { ok: true, removed: 0 };
    const stmt = db.prepare('DELETE FROM relay_queue WHERE id = ? AND to_id = ?');
    let removed = 0;
    for (const id of ids) removed += Number(stmt.run(id, String(body.instanceId)).changes || 0);
    return { ok: true, removed };
  });

  /**
   * 不带 instanceId 就是「中继整体状态」（运维看板用：多少实例、多少积压）；
   * 带 instanceId 必须同时给 secret，返回这个实例自己的在线状态和积压条数。
   */
  app.get('/api/relay/status', async (req, reply) => {
    const q = req.query || {};
    if (!q.instanceId) {
      const instances = Number(db.prepare('SELECT COUNT(*) AS n FROM relay_instances').get().n || 0);
      const queued = Number(db.prepare('SELECT COUNT(*) AS n FROM relay_queue').get().n || 0);
      return { ok: true, role: 'relay', version, instances, queued };
    }
    const auth = authOk(q.instanceId, q.secret);
    if (!auth.ok) return reply.code(auth.code).send({ error: auth.error });
    const row = auth.row;
    return {
      ok: true,
      online: Date.now() - Number(row.last_seen || 0) < RELAY_ONLINE_WINDOW,
      lastSeen: Number(row.last_seen || 0),
      queued: queueCount(q.instanceId),
    };
  });

  app.addHook('onClose', async () => {
    try {
      db.close();
    } catch {
      /* 已关 */
    }
  });

  return app;
}

/* 直接 node server/relay.js 跑起来时自启 */
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const version = readVersion();
  const port = Number(process.env.FE_RELAY_PORT || 7800);
  const host = process.env.FE_RELAY_HOST || '0.0.0.0';
  const app = buildRelay({ version });
  await app.listen({ port, host });
  console.log('[relay] 中继已启动 http://' + host + ':' + port + ' 版本 ' + version);
  console.log('[relay] 数据库：' + (process.env.FE_RELAY_DB || join(homedir(), '.furry-everpony', 'relay.db')));
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      app.close().finally(() => process.exit(0));
    });
  }
}
