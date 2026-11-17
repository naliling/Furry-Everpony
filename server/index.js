import Fastify from 'fastify';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { openDb } from './db.js';
import { createOneBot } from './onebot.js';
import { createLogger } from './log.js';
import { createAi } from './ai.js';
import { createFederation, normalizeAddr, parseInvite } from './federation.js';
import { createRelayClient, normalizeRelayUrl } from './relay-client.js';
import { createRelayHost } from './relay-host.js';
import { collectAccount, openPackage, restoreAccount, sealPackage } from './backup.js';
import { sendMail } from './mail.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(HERE, '..', 'dist', 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webp': 'image/webp',
};

/** 运行数据目录（数据库所在目录；Electron 下在 userData/data） */
const DATA_DIR = dirname(process.env.FE_DB || join(homedir(), '.furry-everpony', 'data', 'everpony.db'));

/** 上传文件目录：默认和数据库放一起（Electron 下在 userData/data/uploads），测试可注入临时目录 */
const DEFAULT_UPLOAD_DIR = process.env.FE_UPLOAD_DIR || join(DATA_DIR, 'uploads');

const UPLOAD_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const PORT = Number(process.env.FE_PORT || 7788);
const HOST = process.env.FE_HOST || '127.0.0.1';
const VERSION = '2026.11.18.0.10.35';

const NUMBER_RE = /^[1-9]\d{7,10}$/;
const numberSchema = z.string().regex(NUMBER_RE, '号码必须是 8–11 位数字，且不能以 0 开头');

/* 邮箱只做形状校验，不校验 MX（自托管不联网也能注册） */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const emailSchema = z
  .string()
  .trim()
  .max(120, '邮箱太长了')
  .refine((v) => EMAIL_RE.test(v), '邮箱格式不对')
  .transform((v) => v.toLowerCase());

/* Bot 标签：最多 5 个、每个 12 字内，去重 */
const tagsSchema = z
  .array(z.string().trim().min(1, '标签不能为空').max(12, '标签最多 12 个字'))
  .max(5, '最多 5 个标签')
  .transform((arr) => [...new Set(arr.map((t) => t.trim()).filter(Boolean))]);

export function buildServer({ db = openDb(), uploadDir, log: injectedLog } = {}) {
  const app = Fastify({ logger: false, bodyLimit: 30 * 1024 * 1024, trustProxy: true });
  app.decorate('db', db);
  /* 中心服务器模式：客户端可能是桌面窗口（file://）、局域网页面或远程域名，
     浏览器跨源时会先发 OPTIONS 预检。这里统一放行；鉴权仍然只认 Bearer token。 */
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', req.headers.origin || '*');
    reply.header('Vary', 'Origin');
    reply.header('Access-Control-Allow-Credentials', 'false');
    reply.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-FE-Secret, X-FE-Instance');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    reply.header('Access-Control-Max-Age', '86400');
    if (req.method === 'OPTIONS') return reply.code(204).send();
    /* 被封禁的 IP 一律挡在门外（爬虫、刷号、爆破） */
    const visitorIp = clientIp(req);
    if (isIpBanned(visitorIp)) {
      return reply.code(403).send({ error: '这个 IP 已被本站封禁' });
    }
    /* 全站防洪：每 IP 每分钟 900 次请求，正常用完全够，脚本刷立刻 429 */
    if (req.url.startsWith('/api/') && req.url !== '/api/health') {
      if (!hitAllowed(globalHits, visitorIp, 900, 60 * 1000)) {
        return reply.code(429).send({ error: '请求太频繁了，慢一点再试' });
      }
    }
    return undefined;
  });
  const UPLOAD_DIR = uploadDir || DEFAULT_UPLOAD_DIR;
  mkdirSync(UPLOAD_DIR, { recursive: true });
  app.decorate('uploadDir', UPLOAD_DIR);

  // 落盘日志：以前一行都不写，用户报「时不时稳定性不行」时完全无从查起
  // 被桌面端以子进程托管时（有 IPC 通道），stdout 会被主进程再抄一遍写进同一个日志文件，
  // 这时不再 echo，避免每行都出现两遍；直接 node 启动时照常打到控制台。
  const log =
    injectedLog ||
    createLogger({ level: process.env.FE_LOG_LEVEL || 'info', name: 'server', echo: !process.send });
  app.decorate('log2', log);

  // 所有路由抛出来的错误都记一笔，并且别把异常细节直接甩给前端
  app.setErrorHandler((err, req, reply) => {
    log.error('[http] ' + req.method + ' ' + req.url + ' → ' + ((err && err.stack) || err));
    if (reply.sent) return;
    const code = err && err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(code).send({ error: code === 500 ? '服务器出错了，稍后再试' : err.message });
  });

  /* 平台管理员：FE_ADMIN_NUMBERS（逗号分隔号码）优先；一个都没有就把最早注册的用户设为管理员，
     保证运营者第一次打开网页就有管理入口。 */
  try {
    const listed = String(process.env.FE_ADMIN_NUMBERS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const n of listed) db.prepare('UPDATE accounts SET is_admin = 1 WHERE number = ?').run(n);
    const anyAdmin = db.prepare('SELECT 1 FROM accounts WHERE is_admin = 1 LIMIT 1').get();
    if (!anyAdmin) {
      const first = db
        .prepare("SELECT id FROM accounts WHERE type = 'user' ORDER BY created_at ASC LIMIT 1")
        .get();
      if (first) db.prepare('UPDATE accounts SET is_admin = 1 WHERE id = ?').run(first.id);
    }
  } catch (e) {
    console.warn('[startup] admin bootstrap skipped:', e.message);
  }

  // 历史数据修复：Bot 必须和它的主人互为好友，否则主人连自己的 Bot 都点不开
  try {
    const orphanBots = db
      .prepare("SELECT id, owner_id FROM accounts WHERE type = 'bot' AND owner_id IS NOT NULL")
      .all();
    for (const b of orphanBots) makeFriends(b.owner_id, b.id);
  } catch (e) {
    console.warn('[startup] bot friend repair skipped:', e.message);
  }

  // OneBot 11 协议端：AstrBot 之类的客户端连上来，就能把这里的 Bot 当成一个普通 QQ 账号
  const onebot = createOneBot({
    db,
    version: VERSION,
    uploadDir: UPLOAD_DIR,
    publicBase: 'http://127.0.0.1:' + PORT,
    log,
    // Bot 收到消息 → 界面显示「对方正在输入…」；Bot 回话 → 立刻消失
    onBotTyping: (bot, convId) => setTyping(convId, bot.id, 15000),
    onBotTypingStop: (bot, convId) => clearTyping(convId, bot.id),
    onBotSend: (bot, convId) => {
      if (convId) clearTyping(convId, bot.id);
    },
    onBotOffline: (bot) => {
      for (const key of [...typingMap.keys()]) if (key.endsWith(':' + bot.id)) typingMap.delete(key);
    },
  });
  onebot.attach(app);
  app.decorate('onebot', onebot);

  // 不管是 node 直接起、还是桌面端用子进程托管，监听成功后都要把「主动连出去」的 Bot 恢复
  // （以前只在直接启动那条分支里调用，子进程托管时永远不连，Bot 那头就一直是离线的）
  app.addHook('onListen', async () => {
    try {
      fed.start();
    } catch (e) {
      log.warn('[fed] 启动失败', (e && e.message) || e);
    }
    try {
      relay.start();
    } catch (e) {
      log.warn('[relay] 启动失败', (e && e.message) || e);
    }
    try {
      const hostRow = db.prepare("SELECT value FROM instance_meta WHERE key = 'host_relay'").get();
      if (hostRow && hostRow.value === '1') relayHost.start().catch(() => {});
    } catch (e) {
      log.warn('[relay-host] 启动失败', (e && e.message) || e);
    }
    try {
      onebot.startOutLinks();
    } catch (e) {
      log.warn('[onebot] 启动后恢复反向连接失败', (e && e.message) || e);
    }
  });

  /** 局域网地址候选：虚拟网卡（WSL/Hyper-V/VMware…）手机根本连不到，先剔掉 */
  function lanCandidates() {
    const VIRTUAL_NIC = /vEthernet|WSL|Hyper-V|VirtualBox|VMware|Loopback|TAP-|Tailscale|ZeroTier|Docker|Bluetooth/i;
    const REAL_NIC = /WLAN|Wi-?Fi|以太网|Ethernet|无线|Local Area Connection/i;
    const out = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const net of list || []) {
        if (net.family !== 'IPv4' || net.internal) continue;
        if (net.address.startsWith('169.254.')) continue;
        if (VIRTUAL_NIC.test(name)) continue;
        out.push({ name, address: net.address, real: REAL_NIC.test(name) ? 0 : 1 });
      }
    }
    return out.sort((a, b) => a.real - b.real);
  }

  /**
   * 公网 IPv6 候选：家用宽带（中国移动/电信/联通）和手机流量普遍都有公网 IPv6，
   * 有了它两个实例即使不在同一个 Wi-Fi 也能直连，不需要任何中转服务器。
   * 这里只挑全局单播地址：链路本地 fe80:: 和唯一本地 fc00::/7 出了这个网段就不可达，直接剔掉。
   */
  function publicV6Candidates() {
    const out = [];
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const net of list || []) {
        const family = typeof net.family === 'string' ? net.family : net.family === 6 ? 'IPv6' : 'IPv4';
        if (family !== 'IPv6' || net.internal) continue;
        const address = String(net.address || '');
        if (!address || address.includes('%')) continue;
        if (/^fe80:/i.test(address) || /^f[cd][0-9a-f]{2}:/i.test(address) || address === '::1') continue;
        out.push({ name, address });
      }
    }
    // 临时地址（隐私扩展）会变，稳定的放前面，让邀请码里第一个地址尽量长期有效
    return out;
  }

  /* ---------- 实例互联：两个实例之间直接加好友、直接投递消息（不经过中心服务器） ---------- */
  const fed = createFederation({
    db,
    log,
    port: PORT,
    version: VERSION,
    lanUrls: () => lanCandidates().map((item) => `http://${item.address}:${PORT}`),
    publicV6: () => publicV6Candidates().map((item) => '[' + item.address + ']:' + PORT),
  });
  app.decorate('federation', fed);

  /* 中继：只用来「兜底跨网络」。两边能直连时走直连，直连不上才排队到中继，
     对方上线后自己拉。不配中继地址就完全空转，行为和以前一样。 */
  const relay = createRelayClient({ db, log, fed, version: VERSION });
  fed.setRelay(relay);
  app.decorate('relay', relay);

  /* 本机当中转站：家用宽带在多层 NAT 后面，端口映射走不通，
     所以用「本地中继 + 免费出站隧道」把中继暴露成公网 https 地址，手机扫一下二维码就配好。 */
  const relayHost = createRelayHost({
    db,
    log,
    version: VERSION,
    dataDir: DATA_DIR,
    onUrl: (u) => relay.setPublicUrl(u),
  });
  app.decorate('relayHost', relayHost);

  app.addHook('onClose', async () => {
    try {
      await relayHost.stop();
    } catch {
      /* 已经停了 */
    }
    try {
      relay.stop();
    } catch {
      /* 已经停了 */
    }
    try {
      fed.stop();
    } catch {
      /* 已经停了 */
    }
  });

  // Bot 内置模型：配了接口地址和密钥，即使不接 AstrBot 也能自己回话
  const ai = createAi({ db });
  app.decorate('ai', ai);

  /** 用户发出的消息，如果对面是 Bot，就推给它连着的 OneBot 客户端 */
  function notifyPeerIfBot(convId, sender, messageId, body) {
    const peer = db
      .prepare(
        `SELECT a.* FROM conversation_members m JOIN accounts a ON a.id = m.account_id
         WHERE m.conversation_id = ? AND m.account_id != ? LIMIT 1`,
      )
      .get(convId, sender.id);
    if (peer && peer.type === 'bot') {
      onebot.pushPrivateMessage(peer, sender, { id: messageId, body });
      ai.maybeReply({
        convId,
        bot: peer,
        sender,
        sourceMessageId: messageId,
        // 模型生成期间不断续期「正在输入」，提示要一直挂到回复落库为止
        onProgress: () => setTyping(convId, peer.id, 15000),
        // 报错/超时也要有收尾，不能静默卡住
        onError: () => botReplyFailed(peer, convId),
      })
        // 回复已经落库，提示必须马上收掉（不然气泡下面还挂着「正在思考…」）；
        // 返回 null 表示这次没让内置模型接（没配置/对面也是 Bot），不能动 OneBot 那条「正在输入」
        .then((out) => {
          if (out) clearTyping(convId, peer.id);
        })
        .catch(() => {});
    }
  }

  // 允许空 body 的 JSON 请求（例如「标记已读」），否则 Fastify 会直接 400
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    if (!body || !String(body).trim()) return done(null, {});
    try {
      done(null, JSON.parse(body));
    } catch (err) {
      done(err, undefined);
    }
  });

  // 文件上传：原样收二进制，不做 JSON 包装
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  /* ---------- 密码 ---------- */
  function hashPassword(plain) {
    const salt = randomBytes(16);
    const key = scryptSync(plain, salt, 64);
    return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
  }

  function verifyPassword(plain, stored) {
    if (!stored) return false;
    const [scheme, saltHex, keyHex] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const key = scryptSync(plain, Buffer.from(saltHex, 'hex'), 64);
    const expected = Buffer.from(keyHex, 'hex');
    return key.length === expected.length && timingSafeEqual(key, expected);
  }

  /* ---------- 请求来源与设备识别 ---------- */
  function clientIp(req) {
    const xff = String((req && req.headers && req.headers['x-forwarded-for']) || '').split(',')[0].trim();
    const raw = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '';
    return String(xff || raw).replace(/^::ffff:/, '') || 'local';
  }

  /* 把 UA 翻成人话：Windows · Edge / Android · Chrome / iOS · Safari … */
  function deviceOf(ua) {
    const s2 = String(ua || '');
    const os = /Windows/.test(s2)
      ? 'Windows'
      : /Android/.test(s2)
        ? 'Android'
        : /iPhone|iPad|iPod/.test(s2)
          ? 'iOS'
          : /Mac OS X|Macintosh/.test(s2)
            ? 'macOS'
            : /Linux/.test(s2)
              ? 'Linux'
              : '未知系统';
    const browser = /Electron/.test(s2)
      ? '桌面客户端'
      : /Edg\//.test(s2)
        ? 'Edge'
        : /OPR\/|Opera/.test(s2)
          ? 'Opera'
          : /Chrome\//.test(s2)
            ? 'Chrome'
            : /Firefox\//.test(s2)
              ? 'Firefox'
              : /Safari\//.test(s2)
                ? 'Safari'
                : '未知浏览器';
    return os + ' · ' + browser;
  }

  function requestMeta(req) {
    const ua = String((req && req.headers && req.headers['user-agent']) || '').slice(0, 300);
    return { ip: clientIp(req), ua, device: deviceOf(ua) };
  }

  /* ---------- 站点设置 ---------- */
  const getSetting = (key, fallback = '') => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  };
  const setSetting = (key, value) => {
    db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value));
  };
  /* 支持这个站：多张收款图（JSON 数组），兼容旧的单图字段 */
  const donationImages = () => {
    try {
      const raw = getSetting('donationImages', '');
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) return arr.filter((x) => typeof x === 'string' && x).slice(0, 6);
      }
    } catch { /* 坏数据忽略 */ }
    const one = getSetting('donationImage', '');
    return one ? [one] : [];
  };
  /* 注册模式：open 谁都能注册 / approval 站长审核（默认）/ closed 关闭注册 */
  const registerMode = () => {
    const m = getSetting('registerMode', 'approval');
    return ['open', 'approval', 'closed'].includes(m) ? m : 'approval';
  };

  /* 注册门禁：both 邮箱码或邀请码都行 / invite 只认邀请码 / email 只认邮箱码 / none 只图形码 */
  const registerGate = () => {
    const g = getSetting('registerGate', 'both');
    return ['none', 'invite', 'email', 'both'].includes(g) ? g : 'both';
  };

  const smtpConfig = () => ({
    host: getSetting('smtpHost', '').trim(),
    port: Number(getSetting('smtpPort', '587')) || 587,
    secure: getSetting('smtpSecure', '0') === '1',
    user: getSetting('smtpUser', '').trim(),
    pass: getSetting('smtpPass', ''),
    from: getSetting('smtpFrom', '').trim(),
    fromName: getSetting('smtpFromName', 'Everony').trim() || 'Everony',
  });
  const smtpReady = () => Boolean(smtpConfig().host);

  /* 数据保留天数：默认 14 天，1–365 可调，0 = 永久保留 */
  const retentionDays = () => {
    const n = Number(getSetting('retentionDays', '14'));
    if (!Number.isFinite(n)) return 14;
    return Math.max(0, Math.min(365, Math.trunc(n)));
  };

  /* 邀请码：去掉容易看错的 0/O/1/I，8 位，人念得出来 */
  const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  function newInviteCode() {
    let out = '';
    const bytes = randomBytes(8);
    for (let i = 0; i < 8; i += 1) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
    return out;
  }
  function findInvite(code) {
    const c = String(code || '').trim().toUpperCase();
    if (!c) return null;
    const row = db.prepare('SELECT * FROM invite_codes WHERE code = ?').get(c);
    if (!row) return null;
    if (Number(row.expires_at) > 0 && Number(row.expires_at) < Date.now()) return null;
    if (Number(row.used) >= Number(row.max_uses)) return null;
    return row;
  }
  /* 核销一次邀请码：返回 null = 通过，返回字符串 = 给用户看的错误 */
  function consumeInvite(code) {
    const row = findInvite(code);
    if (!row) return '邀请码不对，或者已经用过了';
    db.prepare('UPDATE invite_codes SET used = used + 1 WHERE code = ?').run(row.code);
    return null;
  }
  function consumeEmailCode(email, code) {
    const row = db.prepare('SELECT * FROM email_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
    if (!row) return '请先点「发送验证码」';
    if (Number(row.expires_at) < Date.now()) return '验证码过期了，重新发一次';
    if (Number(row.tries) >= 5) return '验证码错太多次了，重新发一次';
    if (String(row.code) !== String(code || '').trim()) {
      db.prepare('UPDATE email_codes SET tries = tries + 1 WHERE id = ?').run(row.id);
      return '验证码不对';
    }
    db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
    return null;
  }

  /* 真删账号：外键全是 ON DELETE CASCADE，删主表就连带清干净 */
  function hardDeleteAccount(accountId) {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(accountId);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
    });
    tx();
  }

  /* ---------- IP 封禁（30 秒缓存，别每个请求都查库） ---------- */
  let banCache = { at: 0, set: new Set() };
  function bannedIpSet() {
    if (Date.now() - banCache.at > 30 * 1000) {
      const rows = db.prepare('SELECT ip FROM ip_bans').all();
      banCache = { at: Date.now(), set: new Set(rows.map((r) => String(r.ip))) };
    }
    return banCache.set;
  }
  function isIpBanned(ip) {
    return bannedIpSet().has(String(ip));
  }
  function resetBanCache() {
    banCache = { at: 0, set: new Set() };
  }

  /* ---------- 登录流水（成功与失败都记） ---------- */
  function logLogin({ accountId = null, number = '', ip = '', ua = '', device = '', ok = 0, reason = '' }) {
    db.prepare(
      'INSERT INTO login_logs (account_id, number, ip, ua, device, ok, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(accountId, String(number || ''), String(ip || ''), String(ua || ''), String(device || ''), ok ? 1 : 0, String(reason || ''), Date.now());
  }

  /* ---------- 会话 ---------- */
  function issueSession(accountId, req) {
    const token = randomBytes(32).toString('hex');
    const now = Date.now();
    const meta = requestMeta(req);
    db.prepare(
      'INSERT INTO sessions (token, account_id, created_at, last_seen, ip, ua, device) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(token, accountId, now, now, meta.ip, meta.ua, meta.device);
    /* 登录设备只会越堆越多：同账号只保留最近 20 条会话，更早的直接清掉 */
    db.prepare(
      'DELETE FROM sessions WHERE account_id = ? AND token NOT IN (SELECT token FROM sessions WHERE account_id = ? ORDER BY last_seen DESC LIMIT 20)',
    ).run(accountId, accountId);
    return token;
  }

  function auth(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) return null;
    const row = db
      .prepare(
        `SELECT a.id, a.number, a.type, a.nickname, a.bio, a.avatar, a.status, a.is_admin, a.banned
           FROM sessions s JOIN accounts a ON a.id = s.account_id
          WHERE s.token = ?`,
      )
      .get(token);
    if (!row) return null;
    // 被封禁的账号当作未登录，所有接口一律 401
    if (Number(row.banned) === 1) return null;
    db.prepare('UPDATE sessions SET last_seen = ? WHERE token = ?').run(Date.now(), token);
    return row;
  }

  function requireAuth(req, reply) {
    const me = auth(req);
    if (!me) {
      reply.code(401).send({ error: '未登录' });
      return null;
    }
    return me;
  }

  /* ---------- 关系工具 ---------- */
  function findAccountByNumber(number) {
    return db
      .prepare(
        'SELECT id, number, type, nickname, bio, avatar, card_bg, photos, owner_id, is_public, tags, email, is_admin, banned, ban_reason FROM accounts WHERE number = ?',
      )
      .get(number);
  }

  function areFriends(aId, bId) {
    return !!db
      .prepare('SELECT 1 FROM friendships WHERE a_id = ? AND b_id = ?')
      .get(aId, bId);
  }

  /* 谁能直接开私聊：好友，或者对方是公开 Bot（广场点进来就能聊，不用先加好友） */
  function canOpenDm(meId, target) {
    if (!target) return false;
    if (target.id === meId) return false;
    if (areFriends(meId, target.id)) return true;
    return target.type === 'bot' && Number(target.is_public) === 1;
  }

  function isBlocked(aId, bId) {
    return !!db.prepare('SELECT 1 FROM blocks WHERE a_id = ? AND b_id = ?').get(aId, bId);
  }

  function makeFriends(aId, bId) {
    const now = Date.now();
    const ins = db.prepare(
      'INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)',
    );
    const tx = db.transaction(() => {
      ins.run(aId, bId, now);
      ins.run(bId, aId, now);
    });
    tx();
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
      const info = db
        .prepare("INSERT INTO conversations (kind, created_at) VALUES ('dm', ?)")
        .run(Date.now());
      const id = Number(info.lastInsertRowid);
      const ins = db.prepare(
        'INSERT INTO conversation_members (conversation_id, account_id) VALUES (?, ?)',
      );
      ins.run(id, aId);
      ins.run(id, bId);
      return id;
    });
    return tx();
  }

  function memberOf(convId, accountId) {
    return db
      .prepare(
        'SELECT conversation_id, account_id, last_read_id FROM conversation_members WHERE conversation_id = ? AND account_id = ?',
      )
      .get(convId, accountId);
  }

  /* ---------- v0.10.0：交互升级工具 ---------- */
  const ONLINE_WINDOW = 90_000;
  const typingMap = new Map(); // `${convId}:${accountId}` → 时间戳
  const MESSAGE_KINDS = ['text', 'image', 'file', 'voice', 'forward', 'merge'];

  function accountById(id) {
    return db
      .prepare(
        'SELECT id, number, type, nickname, bio, avatar, status, owner_id, is_public FROM accounts WHERE id = ?',
      )
      .get(id);
  }

  /** 私聊会话里的对方 */
  function peerOf(convId, meId) {
    return db
      .prepare(
        `SELECT a.id, a.number, a.type, a.nickname, a.bio, a.avatar, a.status
           FROM conversation_members m JOIN accounts a ON a.id = m.account_id
          WHERE m.conversation_id = ? AND m.account_id != ? LIMIT 1`,
      )
      .get(convId, meId);
  }

  /** Bot 只要配了能用的模型（或接了 OneBot）就算在线：它随时能回话 */
  function botHasModel(accountId) {
    try {
      const m = db.prepare('SELECT enabled, model FROM bot_models WHERE account_id = ?').get(accountId);
      return Boolean(m && m.enabled && m.model);
    } catch {
      return false;
    }
  }

  function botOnline(accountId) {
    return onebot.isOnline(accountId) || botHasModel(accountId);
  }

  /** 在线状态：90 秒内有请求就是在线；隐身一律显示离线 */
  function presenceOf(accountId) {
    const row = db
      .prepare(
        `SELECT a.status, a.type, MAX(s.last_seen) AS seen
           FROM accounts a LEFT JOIN sessions s ON s.account_id = a.id
          WHERE a.id = ?`,
      )
      .get(accountId);
    if (!row) return { online: false, status: 'offline', last_seen: 0 };
    const seen = Number(row.seen || 0);
    if (row.type === 'bot') {
      const on = botOnline(accountId);
      return { online: on, status: on ? 'online' : 'offline', last_seen: seen };
    }
    const online = seen > Date.now() - ONLINE_WINDOW && row.status !== 'invisible';
    return { online, status: online ? row.status || 'online' : 'offline', last_seen: seen };
  }

  function convGroup(convId) {
    return db
      .prepare(
        'SELECT id, number, name, avatar, announcement, announcement_updated_at, mute_all, owner_id FROM groups WHERE conversation_id = ?',
      )
      .get(convId);
  }

  function groupNickMap(groupId) {
    const map = new Map();
    if (!groupId) return map;
    for (const r of db
      .prepare('SELECT account_id, nickname FROM group_members WHERE group_id = ?')
      .all(groupId)) {
      if (r.nickname) map.set(r.account_id, r.nickname);
    }
    return map;
  }

  function readMeta(raw) {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' ? v : {};
    } catch {
      return {};
    }
  }

  /** 资料卡照片：库里存 JSON 字符串，对外一律给数组 */
  function parsePhotos(raw) {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /** 标签存成 JSON 数组文本，读出来永远是数组 */
  function parseTags(raw) {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw);
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 5) : [];
    } catch {
      return [];
    }
  }

  /** 给 Bot / 列表看的文本摘要（图片和文件不能把 base64 直接甩过去） */
  function messageDisplay(kind, body, meta) {
    if (kind === 'image') return '[图片]';
    if (kind === 'file') return `[文件]${meta?.name ? ' ' + meta.name : ''}`;
    if (kind === 'voice') return '[语音]';
    if (kind === 'forward') return '[转发的消息]';
    if (kind === 'merge') return '[聊天记录]';
    return body;
  }

  function clearTyping(convId, accountId) {
    typingMap.delete(`${convId}:${accountId}`);
  }

  /** ttl 默认 6 秒（人打字），Bot 收到消息时给 15 秒，够它想完再回 */
  function setTyping(convId, accountId, ttl = 6000) {
    const now = Date.now();
    typingMap.set(`${convId}:${accountId}`, now + ttl);
    if (typingMap.size > 500) {
      for (const [k, exp] of typingMap) if (exp <= now) typingMap.delete(k);
    }
  }

  function typingList(convId, meId) {
    const now = Date.now();
    const out = [];
    for (const [key, exp] of typingMap) {
      if (exp <= now) continue;
      const [cid, aid] = key.split(':').map(Number);
      if (cid !== convId || aid === meId) continue;
      const a = accountById(aid);
      // type 给前端区分：Bot 在生成时显示「正在思考…」，真人显示「正在输入…」
      if (a) out.push({ number: a.number, nickname: a.nickname, avatar: a.avatar || '', type: a.type || 'user' });
    }
    return out;
  }

  /**
   * Bot 回复失败（模型报错、超时、返回空）时给用户一个可见收尾：
   * 清掉「正在输入」，再由 Bot 自己发一条提示。
   * 以前这里完全静默，用户看到的就是「发出去没反应、一直卡住」。
   */
  function botReplyFailed(bot, convId) {
    clearTyping(convId, bot.id);
    try {
      const body = '（我这边没接上话，等下再聊？）';
      const now = Date.now();
      const tx = db.transaction(() => {
        const info = db
          .prepare(
            'INSERT INTO messages (conversation_id, sender_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?)',
          )
          .run(convId, bot.id, body, now, 'text');
        db.prepare(
          'UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND account_id = ?',
        ).run(Number(info.lastInsertRowid), convId, bot.id);
      });
      tx();
    } catch (e) {
      log.warn('[ai] 失败提示落库失败', (e && e.message) || e);
    }
  }

  function reactionsFor(messageId, meId) {
    return db
      .prepare(
        `SELECT emoji, COUNT(*) AS count,
                MAX(CASE WHEN account_id = ? THEN 1 ELSE 0 END) AS mine
           FROM message_reactions WHERE message_id = ?
          GROUP BY emoji ORDER BY count DESC, emoji`,
      )
      .all(meId, messageId)
      .map((r) => ({ emoji: r.emoji, count: r.count, mine: !!r.mine }));
  }

  function messageRow(id) {
    return db
      .prepare(
        `SELECT m.id, m.sender_id, m.body, m.kind, m.recalled, m.created_at, m.reply_to_id, m.meta,
                a.number AS sender_number, a.nickname AS sender_nickname, a.avatar AS sender_avatar
           FROM messages m JOIN accounts a ON a.id = m.sender_id
          WHERE m.id = ?`,
      )
      .get(id);
  }

  /**
   * 把数据库行转成前端要的消息结构：引用、表情、群名片、隐藏（仅自己删除）。
   */
  function serializeMessages(rows, meId, opts = {}) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const holes = ids.map(() => '?').join(',');
    const isGroup = !!opts.isGroup;
    const nickMap = opts.nickMap || new Map();

    const reactMap = new Map();
    for (const r of db
      .prepare(`SELECT message_id, emoji, account_id FROM message_reactions WHERE message_id IN (${holes})`)
      .all(...ids)) {
      let per = reactMap.get(r.message_id);
      if (!per) {
        per = new Map();
        reactMap.set(r.message_id, per);
      }
      let item = per.get(r.emoji);
      if (!item) {
        item = { emoji: r.emoji, count: 0, mine: false };
        per.set(r.emoji, item);
      }
      item.count += 1;
      if (r.account_id === meId) item.mine = true;
    }

    const replyIds = [...new Set(rows.map((r) => r.reply_to_id).filter(Boolean))];
    const replyMap = new Map();
    if (replyIds.length) {
      const sql = `SELECT m.id, m.kind, m.body, m.recalled, a.number AS number, a.nickname AS nickname
                     FROM messages m JOIN accounts a ON a.id = m.sender_id
                    WHERE m.id IN (${replyIds.map(() => '?').join(',')})`;
      for (const r of db.prepare(sql).all(...replyIds)) replyMap.set(r.id, r);
    }

    const hiddenSet = new Set(
      db
        .prepare(`SELECT message_id FROM message_deletions WHERE account_id = ? AND message_id IN (${holes})`)
        .all(meId, ...ids)
        .map((r) => r.message_id),
    );

    return rows
      .filter((m) => !hiddenSet.has(m.id))
      .map((m) => {
        const meta = readMeta(m.meta);
        const replyRow = m.reply_to_id ? replyMap.get(m.reply_to_id) : null;
        const out = {
          id: m.id,
          mine: m.sender_id === meId,
          body: m.recalled ? '' : m.body,
          kind: m.kind || 'text',
          recalled: !!m.recalled,
          created_at: m.created_at,
          reply: replyRow
            ? {
                id: replyRow.id,
                number: replyRow.number,
                nickname: replyRow.nickname,
                kind: replyRow.kind || 'text',
                body: replyRow.recalled ? '' : String(replyRow.body || '').slice(0, 120),
              }
            : null,
          reactions: [...(reactMap.get(m.id)?.values() || [])],
        };
        if (!m.recalled && Object.keys(meta).length) out.meta = meta;
        if (isGroup) {
          out.sender = {
            number: m.sender_number,
            nickname: nickMap.get(m.sender_id) || m.sender_nickname,
            avatar: m.sender_avatar || '',
          };
        }
        return out;
      });
  }

  /** 校验并整理消息入参，返回 {kind, body, replyTo, mentionAll, meta} 或 {error} */
  function parseMessageInput(input) {
    const parsed = z
      .object({
        body: z.string().min(1).max(2_500_000),
        kind: z.enum(MESSAGE_KINDS).optional(),
        // 前端不引用时可能传 null，这里一并接受，后面归一成 null
        replyTo: z.number().int().positive().nullable().optional(),
        mentionAll: z.boolean().optional(),
        meta: z.any().optional(),
      })
      .safeParse(input || {});
    if (!parsed.success) return { error: '消息不能为空' };
    const kind = parsed.data.kind || 'text';
    if (kind === 'text' && parsed.data.body.length > 4000) return { error: '消息最多 4000 字' };
    if ((kind === 'file' || kind === 'voice') && !/^\/uploads\//.test(parsed.data.body)) {
      return { error: '先把文件上传到服务器再发' };
    }
    let meta = '';
    if (parsed.data.meta !== undefined && parsed.data.meta !== null) {
      try {
        meta = JSON.stringify(parsed.data.meta);
      } catch {
        return { error: '附加信息不对' };
      }
      if (meta.length > 100_000) return { error: '附加信息太大' };
    }
    return {
      kind,
      body: parsed.data.body,
      replyTo: parsed.data.replyTo || null,
      mentionAll: !!parsed.data.mentionAll,
      meta,
    };
  }

  /**
   * 插一条消息：统一处理引用、@所有人权限、群禁言、私聊拉黑、已读位置。
   * 返回 {id, created_at} 或 {code, error}。
   */
  function insertMessage(me, convId, data, opts = {}) {
    const group = opts.group || null;
    if (!memberOf(convId, me.id)) return { code: 403, error: '不在这个会话里' };
    if (group) {
      const gm = db
        .prepare('SELECT role, mute_until FROM group_members WHERE group_id = ? AND account_id = ?')
        .get(group.id, me.id);
      if (!gm) return { code: 403, error: '你不在这个群里' };
      if (group.mute_all && gm.role !== 'owner' && gm.role !== 'admin') {
        return { code: 403, error: '全员禁言中，只有群主和管理员能发言' };
      }
      if (gm.mute_until && gm.mute_until > Date.now()) {
        return { code: 403, error: '你被禁言了，暂时不能发言' };
      }
    } else {
      const peer = peerOf(convId, me.id);
      if (peer && isBlocked(peer.id, me.id)) return { code: 403, error: '对方已把你拉黑' };
    }
    if (data.replyTo) {
      const src = db
        .prepare('SELECT id FROM messages WHERE id = ? AND conversation_id = ?')
        .get(data.replyTo, convId);
      if (!src) return { code: 400, error: '引用的消息不存在' };
    }
    if (data.mentionAll) {
      if (!group) return { code: 400, error: '@所有人只能在群里用' };
      const role = groupRole(group.id, me.id);
      if (role !== 'owner' && role !== 'admin') {
        return { code: 403, error: '只有群主和管理员能 @所有人' };
      }
    }
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO messages (conversation_id, sender_id, body, created_at, kind, reply_to_id, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(convId, me.id, data.body, now, data.kind, data.replyTo, data.meta || '');
    const id = Number(info.lastInsertRowid);
    db.prepare(
      'UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND account_id = ?',
    ).run(id, convId, me.id);
    clearTyping(convId, me.id);
    // 对方在别的实例上：先落本地库（界面立刻可见），再进投递队列，由后台重试补投
    if (!group) {
      const peer = db
        .prepare(
          `SELECT a.id, a.number, a.type, a.remote_addr, a.remote_secret
             FROM conversation_members m JOIN accounts a ON a.id = m.account_id
            WHERE m.conversation_id = ? AND m.account_id != ? LIMIT 1`,
        )
        .get(convId, me.id);
      if (peer && peer.type === 'remote') {
        fed.enqueue(convId, me, peer, {
          kind: data.kind,
          body: data.body,
          meta: data.meta || '',
          created_at: now,
        });
      }
    }
    return { id, created_at: now };
  }

  /** 拉黑/权限/成员校验：读一条消息前的统一入口 */
  function messageAccess(req, reply, id) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const row = db
      .prepare('SELECT id, conversation_id, sender_id FROM messages WHERE id = ?')
      .get(id);
    if (!row) {
      reply.code(404).send({ error: '没有这条消息' });
      return null;
    }
    if (!memberOf(row.conversation_id, me.id)) {
      reply.code(403).send({ error: '不在这个会话里' });
      return null;
    }
    return { me, row };
  }

  function notificationsFor(me) {
    const friendReq = db
      .prepare(
        `SELECT r.id, r.message, r.created_at, a.number, a.nickname, a.avatar, a.type
           FROM friend_requests r JOIN accounts a ON a.id = r.from_id
          WHERE r.to_id = ? AND r.status = 'pending' ORDER BY r.id DESC`,
      )
      .all(me.id)
      .map((r) => ({
        type: 'friend_request',
        requestId: r.id,
        created_at: r.created_at,
        message: r.message,
        from: { number: r.number, nickname: r.nickname, avatar: r.avatar || '', type: r.type },
      }));

    const botReq = db
      .prepare(
        `SELECT r.id, r.message, r.created_at,
                f.number AS from_number, f.nickname AS from_nickname, f.avatar AS from_avatar,
                b.number AS bot_number, b.nickname AS bot_nickname
           FROM friend_requests r
           JOIN accounts f ON f.id = r.from_id
           JOIN accounts b ON b.id = r.to_id
          WHERE b.owner_id = ? AND b.type = 'bot' AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id)
      .map((r) => ({
        type: 'bot_request',
        requestId: r.id,
        created_at: r.created_at,
        message: r.message,
        from: { number: r.from_number, nickname: r.from_nickname, avatar: r.from_avatar || '' },
        bot: { number: r.bot_number, nickname: r.bot_nickname },
      }));

    const groupInvites = db
      .prepare(
        `SELECT r.id, r.created_at, g.number, g.name,
                a.number AS from_number, a.nickname AS from_nickname, a.avatar AS from_avatar
           FROM group_requests r
           JOIN groups g ON g.id = r.group_id
           JOIN accounts a ON a.id = r.from_id
          WHERE r.to_id = ? AND r.kind = 'invite' AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id)
      .map((r) => ({
        type: 'group_invite',
        requestId: r.id,
        created_at: r.created_at,
        group: { number: r.number, name: r.name },
        from: { number: r.from_number, nickname: r.from_nickname, avatar: r.from_avatar || '' },
      }));

    const announcements = db
      .prepare(
        `SELECT g.number, g.name, g.announcement, g.announcement_updated_at
           FROM groups g JOIN group_members gm ON gm.group_id = g.id
          WHERE gm.account_id = ? AND g.announcement != ''
            AND g.announcement_updated_at > gm.announcement_read_at
          ORDER BY g.announcement_updated_at DESC`,
      )
      .all(me.id)
      .map((g) => ({
        type: 'announcement',
        created_at: g.announcement_updated_at,
        group: { number: g.number, name: g.name },
        announcement: g.announcement,
      }));

    const items = [...friendReq, ...botReq, ...groupInvites, ...announcements].sort(
      (a, b) => b.created_at - a.created_at,
    );
    return { items, count: items.length };
  }

  /* ---------- 健康检查 ---------- */
  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  /* ---------- 号码可用性 ---------- */
  app.get('/api/number/:number/available', async (req, reply) => {
    const parsed = numberSchema.safeParse(req.params.number);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const taken = db.prepare('SELECT 1 FROM accounts WHERE number = ?').get(parsed.data);
    return { number: parsed.data, available: !taken };
  });

  /* ---------- 图形验证码（注册防机器人，纯本地生成，不依赖第三方） ---------- */
const CAPTCHA_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const CAPTCHA_TTL_MS = 5 * 60 * 1000;
const CAPTCHA_MAX_TRIES = 5;
const captchaStore = new Map();
const captchaHits = new Map();
const registerHits = new Map();
const globalHits = new Map();
const loginFailHits = new Map();
const loginAccountFail = new Map();
const emailCodeIpHits = new Map();
const emailCodeAddrHits = new Map();

const sweepMap = (map, ttl) => {
  const now = Date.now();
  for (const [k, v] of map) {
    const at2 = Array.isArray(v) ? v[v.length - 1] : v.expires;
    if (!at2 || now - at2 > ttl) map.delete(k);
  }
};
const hitAllowed = (map, key, max, windowMs) => {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < windowMs);
  if (list.length >= max) {
    map.set(key, list);
    return false;
  }
  list.push(now);
  map.set(key, list);
  return true;
};
const randomCode = (len = 4) => {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += CAPTCHA_CHARS[bytes[i] % CAPTCHA_CHARS.length];
  return out;
};
const captchaSvg = (code) => {
  const w = 132;
  const h = 44;
  const pick = (arr) => arr[randomBytes(1)[0] % arr.length];
  const colors = ['#7fe6ff', '#b79bff', '#8ef0c0', '#ffd479', '#ff9ecb'];
  let chars = '';
  for (let i = 0; i < code.length; i += 1) {
    const x = 16 + i * 28 + (randomBytes(1)[0] % 5);
    const y = 30 + (randomBytes(1)[0] % 7) - 3;
    const rot = (randomBytes(1)[0] % 26) - 13;
    chars += `<text x="${x}" y="${y}" fill="${pick(colors)}" font-size="25" font-family="Segoe UI, Arial, sans-serif" font-weight="700" transform="rotate(${rot} ${x} ${y})">${code[i]}</text>`;
  }
  let noise = '';
  for (let i = 0; i < 3; i += 1) {
    const y1 = randomBytes(1)[0] % h;
    const y2 = randomBytes(1)[0] % h;
    noise += `<path d="M0 ${y1} Q ${w / 2} ${randomBytes(1)[0] % h} ${w} ${y2}" stroke="${pick(colors)}" stroke-opacity="0.35" stroke-width="1.2" fill="none"/>`;
  }
  for (let i = 0; i < 26; i += 1) {
    noise += `<circle cx="${randomBytes(1)[0] % w}" cy="${randomBytes(1)[0] % h}" r="1" fill="${pick(colors)}" fill-opacity="0.4"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" rx="8" fill="#0f1420"/>${noise}${chars}</svg>`;
};

app.get('/api/captcha', async (req, reply) => {
  sweepMap(captchaStore, CAPTCHA_TTL_MS);
  if (!hitAllowed(captchaHits, req.ip || 'local', 40, 10 * 60 * 1000)) {
    return reply.code(429).send({ error: '刷新太频繁了，过一会儿再试' });
  }
  const id = randomBytes(12).toString('hex');
  const code = randomCode();
  captchaStore.set(id, { code, expires: Date.now() + CAPTCHA_TTL_MS, tries: 0 });
  return { id, svg: captchaSvg(code), expiresIn: Math.round(CAPTCHA_TTL_MS / 1000) };
});

/* ---------- 注册 ---------- */
  app.post('/api/register', async (req, reply) => {
    const schema = z.object({
      email: emailSchema,
      number: numberSchema,
      password: z.string().min(8, '密码至少 8 位').max(128),
      nickname: z.string().trim().min(1, '昵称不能为空').max(24, '昵称最多 24 个字'),
      captchaId: z.string({ error: '验证码过期了，点图片换一张' }).trim().min(1, '验证码过期了，点图片换一张'),
      captcha: z.string({ error: '请输入图片里的验证码' }).trim().min(1, '请输入图片里的验证码'),
      invite: z.string().trim().max(64).optional(),
      emailCode: z.string().trim().max(8).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const { email, number, password, nickname, captchaId, captcha, invite, emailCode } = parsed.data;

    /* 同一 IP 10 分钟最多 5 次注册，挡住脚本批量刷号 */
    if (!hitAllowed(registerHits, req.ip || 'local', 20, 10 * 60 * 1000)) {
      return reply.code(429).send({ error: '注册太频繁了，10 分钟后再试' });
    }

    /* 校验图形验证码：一次性，错 5 次作废 */
    const captchaEntry = captchaStore.get(captchaId);
    if (!captchaEntry || captchaEntry.expires < Date.now()) {
      captchaStore.delete(captchaId);
      return reply.code(400).send({ error: '验证码过期了，点图片换一张' });
    }
    captchaEntry.tries += 1;
    if (captchaEntry.tries > CAPTCHA_MAX_TRIES) {
      captchaStore.delete(captchaId);
      return reply.code(400).send({ error: '验证码试太多次了，换一张新的' });
    }
    if (captchaEntry.code !== captcha.toUpperCase()) {
      return reply.code(400).send({ error: '验证码不对，再试一次' });
    }
    captchaStore.delete(captchaId);

    if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) {
      return reply.code(409).send({ error: '这个邮箱已经注册过了' });
    }
    if (findAccountByNumber(number)) {
      return reply.code(409).send({ error: '这个号码已经被用了' });
    }

    /* 站点注册模式：closed 关站；其余注册即通过（不再有「等站长审核」这一步）。
       空库第一人不走这套 —— 新部署必须有人能进去当站长。 */
    const isEmptySite = !db.prepare('SELECT 1 FROM accounts LIMIT 1').get();
    if (!isEmptySite && registerMode() === 'closed') {
      return reply.code(403).send({ error: '本站已关闭注册' });
    }

    /* 注册门禁：邮箱验证码 / 邀请码，至少要过一道（站长可在管理台关掉） */
    if (!isEmptySite) {
      const gate = registerGate();
      if (gate !== 'none') {
        const wantEmail = gate === 'email' || gate === 'both';
        const wantInvite = gate === 'invite' || gate === 'both';
        let passed = false;
        let emailErr = '';
        if (wantEmail && emailCode) {
          if (!smtpReady()) emailErr = '本站没配发信服务，请用邀请码注册';
          else {
            const err = consumeEmailCode(email, emailCode);
            if (!err) passed = true;
            else emailErr = err;
          }
        }
        let inviteErr = '';
        if (!passed && wantInvite && invite) {
          const err = consumeInvite(invite);
          if (!err) passed = true;
          else inviteErr = err;
        }
        if (!passed) {
          if (gate === 'email') return reply.code(400).send({ error: emailErr || '请输入邮箱验证码' });
          if (gate === 'invite') return reply.code(400).send({ error: inviteErr || '请输入邀请码' });
          return reply.code(400).send({
            error: inviteErr || emailErr || (smtpReady() ? '请填邮箱验证码或邀请码' : '请输入邀请码'),
          });
        }
      }
    }

    const info = db
      .prepare(
        `INSERT INTO accounts (number, type, nickname, password_hash, created_at, email, tags, approved)
         VALUES (?, 'user', ?, ?, ?, ?, '[]', 1)`,
      )
      .run(number, nickname, hashPassword(password), Date.now(), email);

    const accountId = Number(info.lastInsertRowid);
    /* 空库第一个注册的人就是站长：不然新部署永远进不了管理台 */
    const hasAdmin = db.prepare('SELECT 1 FROM accounts WHERE is_admin = 1 LIMIT 1').get();
    const becomesAdmin = !hasAdmin;
    if (becomesAdmin) db.prepare('UPDATE accounts SET is_admin = 1 WHERE id = ?').run(accountId);
    return {
      token: issueSession(accountId, req),
      account: { id: accountId, number, nickname, type: 'user', bio: '', avatar: '', email, tags: [], is_admin: becomesAdmin },
    };
  });

  /* ---------- 登录 ---------- */
  app.post('/api/login', async (req, reply) => {
    const parsed = z
      .object({
        identifier: z.string().trim().min(1).optional(),
        number: z.string().trim().min(1).optional(),
        email: z.string().trim().min(1).optional(),
        password: z.string().min(1, '请填写密码'),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '请填写邮箱（或号码）和密码' });

    const raw = (parsed.data.identifier || parsed.data.number || parsed.data.email || '').trim();
    if (!raw) return reply.code(400).send({ error: '请填写邮箱或号码' });
    const byEmail = raw.includes('@');

    const row = db
      .prepare(
        byEmail
          ? 'SELECT id, number, type, nickname, bio, avatar, email, tags, password_hash, is_admin, banned, ban_reason, approved, deleted_at FROM accounts WHERE email = ?'
          : 'SELECT id, number, type, nickname, bio, avatar, email, tags, password_hash, is_admin, banned, ban_reason, approved, deleted_at FROM accounts WHERE number = ?',
      )
      .get(byEmail ? raw.toLowerCase() : raw);

    const meta = requestMeta(req);
    /* 撞库防护：同一 IP 10 分钟错 20 次、同一账号 10 分钟错 5 次就锁一会儿 */
    if (!hitAllowed(loginFailHits, meta.ip, 20, 10 * 60 * 1000) || !hitAllowed(loginAccountFail, raw.toLowerCase(), 5, 10 * 60 * 1000)) {
      logLogin({ number: raw, ...meta, ok: 0, reason: '尝试太频繁' });
      return reply.code(429).send({ error: '密码错太多次了，10 分钟后再试' });
    }
    if (!row || !verifyPassword(parsed.data.password, row.password_hash)) {
      logLogin({ accountId: row ? row.id : null, number: raw, ...meta, ok: 0, reason: '密码错误' });
      return reply.code(401).send({ error: byEmail ? '邮箱或密码不对' : '号码或密码不对' });
    }
    if (Number(row.banned) === 1) {
      logLogin({ accountId: row.id, number: row.number, ...meta, ok: 0, reason: '已封禁' });
      return reply.code(403).send({ error: '这个账号已被封禁' + (row.ban_reason ? '：' + row.ban_reason : '') });
    }
    if (Number(row.approved ?? 1) === 0) {
      logLogin({ accountId: row.id, number: row.number, ...meta, ok: 0, reason: '待审核' });
      return reply.code(403).send({ error: '账号还在等站长审核' });
    }
    /* 注销冷静期：到期就真删；没到期允许登录，让本人还能撤销 */
    const delAt = Number(row.deleted_at || 0);
    if (delAt > 0 && delAt <= Date.now()) {
      hardDeleteAccount(row.id);
      logLogin({ number: raw, ...meta, ok: 0, reason: '账号已注销' });
      return reply.code(410).send({ error: '这个账号已经注销了' });
    }
    logLogin({ accountId: row.id, number: row.number, ...meta, ok: 1, reason: '登录成功' });
    db.prepare('UPDATE accounts SET last_login_ip = ?, last_login_at = ? WHERE id = ?').run(meta.ip, Date.now(), row.id);

    return {
      token: issueSession(row.id, req),
      account: {
        id: row.id,
        number: row.number,
        nickname: row.nickname,
        type: row.type,
        bio: row.bio,
        avatar: row.avatar || '',
        email: row.email || '',
        tags: parseTags(row.tags),
        is_admin: Number(row.is_admin) === 1,
        pendingDelete: delAt > 0 ? delAt : 0,
      },
    };
  });

  /* ---------- 当前账号 ---------- */
  app.get('/api/me', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const row = db
      .prepare(
        'SELECT id, number, type, nickname, bio, avatar, card_bg, photos, status, owner_id, created_at, email, tags, is_admin, banned, deleted_at FROM accounts WHERE id = ?',
      )
      .get(me.id);
    return {
      account: {
        ...row,
        photos: parsePhotos(row.photos),
        tags: parseTags(row.tags),
        is_admin: Number(row.is_admin) === 1,
        pendingDelete: Number(row.deleted_at || 0),
        ...presenceOf(me.id),
      },
    };
  });

  /* ---------- 我的登录设备 ---------- */
  app.get('/api/me/sessions', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const current = String(req.headers.authorization || '').slice(7);
    const rows = db
      .prepare(
        'SELECT token, ip, device, ua, created_at, last_seen FROM sessions WHERE account_id = ? ORDER BY last_seen DESC LIMIT 50',
      )
      .all(me.id);
    return {
      sessions: rows.map((r) => ({
        id: r.token.slice(0, 12),
        ip: r.ip || '',
        device: r.device || '未知设备',
        created_at: r.created_at,
        last_seen: r.last_seen,
        current: r.token === current,
      })),
    };
  });

  app.delete('/api/me/sessions/:id', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const prefix = String(req.params.id || '').replace(/[^0-9a-f]/gi, '');
    if (prefix.length < 8) return reply.code(400).send({ error: '设备标识不对' });
    const info = db.prepare("DELETE FROM sessions WHERE account_id = ? AND token LIKE ? || '%'").run(me.id, prefix);
    return { ok: true, removed: Number(info.changes || 0) };
  });

  /* ---------- 访问入口信息（不需要登录：设置页和扫码都要用） ---------- */
  function lanAddresses() {
    const out = [];
    const ifaces = networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const info of ifaces[name] || []) {
        if (info.family === 'IPv4' && !info.internal) out.push({ iface: name, address: info.address });
      }
    }
    return out;
  }

  /* ---------- 平台管理（只有 is_admin 能进） ---------- */
  function requireAdmin(req, reply) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    if (Number(me.is_admin) !== 1) {
      reply.code(403).send({ error: '只有管理员能进这里' });
      return null;
    }
    return me;
  }

  function startOfToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  app.get('/api/admin/overview', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const one = (sql, ...args) => db.prepare(sql).get(...args) || {};
    const today = startOfToday();
    let dbBytes = 0;
    try {
      dbBytes = statSync(process.env.FE_DB || join(DATA_DIR, 'everpony.db')).size;
    } catch {
      /* 统计不到就算了 */
    }
    return {
      version: VERSION,
      counts: {
        accounts: one('SELECT COUNT(*) AS n FROM accounts').n || 0,
        users: one("SELECT COUNT(*) AS n FROM accounts WHERE type = 'user'").n || 0,
        bots: one("SELECT COUNT(*) AS n FROM accounts WHERE type = 'bot'").n || 0,
        publicBots: one("SELECT COUNT(*) AS n FROM accounts WHERE type = 'bot' AND is_public = 1").n || 0,
        messages: one('SELECT COUNT(*) AS n FROM messages').n || 0,
        groups: one('SELECT COUNT(*) AS n FROM groups').n || 0,
        admins: one('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1').n || 0,
        banned: one('SELECT COUNT(*) AS n FROM accounts WHERE banned = 1').n || 0,
        newAccountsToday: one('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?', today).n || 0,
        messagesToday: one('SELECT COUNT(*) AS n FROM messages WHERE created_at >= ?', today).n || 0,
        onlineNow: one('SELECT COUNT(DISTINCT account_id) AS n FROM sessions WHERE last_seen >= ?', Date.now() - ONLINE_WINDOW).n || 0,
        pending: one('SELECT COUNT(*) AS n FROM accounts WHERE approved = 0').n || 0,
        loginsToday: one('SELECT COUNT(*) AS n FROM login_logs WHERE ok = 1 AND created_at >= ?', today).n || 0,
        failedLoginsToday: one('SELECT COUNT(*) AS n FROM login_logs WHERE ok = 0 AND created_at >= ?', today).n || 0,
        bannedIps: one('SELECT COUNT(*) AS n FROM ip_bans').n || 0,
        registerMode: registerMode(),
      },
      dbBytes,
      uptimeSec: Math.round(process.uptime()),
    };
  });

  /* ---------- 注册模式（站点设置） ---------- */
  app.get('/api/admin/settings', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const one = (sql) => db.prepare(sql).get() || {};
    return {
      registerMode: registerMode(),
      pending: one('SELECT COUNT(*) AS n FROM accounts WHERE approved = 0').n || 0,
      bannedIps: one('SELECT COUNT(*) AS n FROM ip_bans').n || 0,
      donationLink: getSetting('donationLink', ''),
      donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
    };
  });

  app.patch('/api/admin/settings', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        registerMode: z.enum(['open', 'approval', 'closed']).optional(),
        donationLink: z.string().max(500).optional(),
        donationImage: z.string().max(400000).optional(),
        donationImages: z.array(z.string().max(400000)).max(6).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' });
    if (parsed.data.registerMode !== undefined) setSetting('registerMode', parsed.data.registerMode);
    if (parsed.data.donationLink !== undefined) setSetting('donationLink', parsed.data.donationLink);
    if (parsed.data.donationImage !== undefined) setSetting('donationImage', parsed.data.donationImage);
    if (parsed.data.donationImages !== undefined) setSetting('donationImages', JSON.stringify(parsed.data.donationImages));
    return {
      ok: true,
      registerMode: parsed.data.registerMode !== undefined ? parsed.data.registerMode : registerMode(),
      donationLink: getSetting('donationLink', ''),
      donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
    };
  });

  /* ---------- 站点公开信息（登录页要知道要不要邀请码） ---------- */
  app.get('/api/site', async () => ({
    version: VERSION,
    siteName: getSetting('siteName', 'Everony'),
    registerMode: registerMode(),
    registerGate: registerGate(),
    smtpReady: smtpReady(),
    retentionDays: retentionDays(),
    donationLink: getSetting('donationLink', ''),
    donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
  }));

  /* ---------- 邮箱验证码（注册前先发码） ---------- */
  app.post('/api/email-code', async (req, reply) => {
    const parsed = z.object({ email: emailSchema }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const email = parsed.data.email;
    const meta = requestMeta(req);
    if (!smtpReady()) return reply.code(400).send({ error: '本站没配发信服务，请用邀请码注册' });
    if (!hitAllowed(emailCodeIpHits, meta.ip, 5, 10 * 60 * 1000) || !hitAllowed(emailCodeAddrHits, email, 3, 10 * 60 * 1000)) {
      return reply.code(429).send({ error: '发太频繁了，10 分钟后再试' });
    }
    if (db.prepare('SELECT 1 FROM accounts WHERE email = ?').get(email)) {
      return reply.code(409).send({ error: '这个邮箱已经注册过了，直接登录吧' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const now = Date.now();
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
      db.prepare(
        'INSERT INTO email_codes (email, code, purpose, tries, expires_at, created_at) VALUES (?, ?, ?, 0, ?, ?)',
      ).run(email, code, 'register', now + 10 * 60 * 1000, now);
    });
    tx();
    try {
      await sendMail(smtpConfig(), {
        to: email,
        subject: 'Everony 注册验证码',
        text: '你的验证码是 ' + code + '，10 分钟内有效。\n如果不是你本人在注册，忽略这封邮件就行。',
      });
    } catch (err) {
      db.prepare('DELETE FROM email_codes WHERE email = ?').run(email);
      return reply.code(502).send({ error: '邮件没发出去：' + (err && err.message ? err.message : '发信配置有问题') });
    }
    return { ok: true, expiresIn: 600 };
  });

  /* ---------- 管理台：站点设置（发信 / 注册门禁 / 数据保留） ---------- */
  app.get('/api/admin/site', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const cfg = smtpConfig();
    return {
      registerMode: registerMode(),
      registerGate: registerGate(),
      retentionDays: retentionDays(),
      smtpReady: smtpReady(),
      smtp: {
        host: cfg.host,
        port: cfg.port,
        secure: cfg.secure,
        user: cfg.user,
        hasPass: Boolean(cfg.pass),
        from: cfg.from,
        fromName: cfg.fromName,
      },
      donationLink: getSetting('donationLink', ''),
      donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
    };
  });

  app.patch('/api/admin/site', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        registerMode: z.enum(['open', 'approval', 'closed']).optional(),
        registerGate: z.enum(['none', 'invite', 'email', 'both']).optional(),
        retentionDays: z.coerce.number().int().min(0).max(365).optional(),
        smtpHost: z.string().trim().max(120).optional(),
        smtpPort: z.coerce.number().int().min(1).max(65535).optional(),
        smtpSecure: z.boolean().optional(),
        smtpUser: z.string().trim().max(120).optional(),
        smtpPass: z.string().max(200).optional(),
        smtpFrom: z.string().trim().max(120).optional(),
        smtpFromName: z.string().trim().max(40).optional(),
        donationLink: z.string().max(500).optional(),
        donationImage: z.string().max(400000).optional(),
        donationImages: z.array(z.string().max(400000)).max(6).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const p = parsed.data;
    if (p.registerMode !== undefined) setSetting('registerMode', p.registerMode);
    if (p.registerGate !== undefined) setSetting('registerGate', p.registerGate);
    if (p.retentionDays !== undefined) setSetting('retentionDays', String(p.retentionDays));
    if (p.smtpHost !== undefined) setSetting('smtpHost', p.smtpHost);
    if (p.smtpPort !== undefined) setSetting('smtpPort', String(p.smtpPort));
    if (p.smtpSecure !== undefined) setSetting('smtpSecure', p.smtpSecure ? '1' : '0');
    if (p.smtpUser !== undefined) setSetting('smtpUser', p.smtpUser);
    /* 密码留空 = 不改，避免前端回显打码值把真密码覆盖掉 */
    if (p.smtpPass !== undefined && p.smtpPass !== '') setSetting('smtpPass', p.smtpPass);
    if (p.smtpFrom !== undefined) setSetting('smtpFrom', p.smtpFrom);
    if (p.smtpFromName !== undefined) setSetting('smtpFromName', p.smtpFromName);
    if (p.donationLink !== undefined) setSetting('donationLink', p.donationLink);
    if (p.donationImage !== undefined) setSetting('donationImage', p.donationImage);
    if (p.donationImages !== undefined) setSetting('donationImages', JSON.stringify(p.donationImages));
    return {
      ok: true,
      registerGate: registerGate(),
      retentionDays: retentionDays(),
      smtpReady: smtpReady(),
      donationLink: getSetting('donationLink', ''),
      donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
    };
  });

  app.post('/api/admin/site/test-mail', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z.object({ to: emailSchema.optional() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '收件邮箱格式不对' });
    const to = parsed.data.to || me.email || '';
    if (!to) return reply.code(400).send({ error: '填个收件邮箱' });
    try {
      await sendMail(smtpConfig(), { to, subject: 'Everony 发信测试', text: '收到这封就说明发信配置没问题。' });
    } catch (err) {
      return reply.code(502).send({ error: '没发出去：' + (err && err.message ? err.message : '未知错误') });
    }
    return { ok: true, to };
  });

  /* ---------- 管理台：邀请码 ---------- */
  app.get('/api/admin/invites', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT i.code, i.max_uses, i.used, i.expires_at, i.note, i.created_at,
                a.number AS by_number, a.nickname AS by_nickname
           FROM invite_codes i LEFT JOIN accounts a ON a.id = i.created_by
          ORDER BY i.created_at DESC LIMIT 200`,
      )
      .all();
    return {
      invites: rows.map((r) => ({
        ...r,
        left: Math.max(0, Number(r.max_uses) - Number(r.used)),
      })),
    };
  });

  app.post('/api/admin/invites', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        count: z.coerce.number().int().min(1).max(50).optional(),
        maxUses: z.coerce.number().int().min(1).max(1000).optional(),
        expiresInDays: z.coerce.number().int().min(0).max(3650).optional(),
        note: z.string().trim().max(60).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const count = parsed.data.count || 1;
    const maxUses = parsed.data.maxUses || 1;
    const days = parsed.data.expiresInDays || 0;
    const expiresAt = days > 0 ? Date.now() + days * 86400000 : 0;
    const note = parsed.data.note || '';
    const codes = [];
    const now = Date.now();
    const tx = db.transaction(() => {
      for (let i = 0; i < count; i += 1) {
        let code = newInviteCode();
        while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code)) code = newInviteCode();
        db.prepare(
          'INSERT INTO invite_codes (code, created_by, max_uses, used, expires_at, note, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)',
        ).run(code, me.id, maxUses, expiresAt, note, now);
        codes.push(code);
      }
    });
    tx();
    return { ok: true, codes };
  });

  app.delete('/api/admin/invites/:code', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const code = String(req.params.code || '').trim().toUpperCase();
    const info = db.prepare('DELETE FROM invite_codes WHERE code = ?').run(code);
    if (!Number(info.changes)) return reply.code(404).send({ error: '没有这个邀请码' });
    return { ok: true };
  });

  /* ---------- 按号码 / 昵称找本站的人（加好友、扫码、搜索都走这里） ---------- */
  app.get('/api/search/users', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({ q: z.string().trim().max(64).optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
      .safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: '搜索词不对' });
    const q = (parsed.data.q || '').trim();
    if (!q) return { users: [] };
    const limit = parsed.data.limit || 20;
    const like = '%' + q + '%';
    const rows = db
      .prepare(
        `SELECT id, number, type, nickname, bio, avatar, tags, is_public FROM accounts
          WHERE id != ? AND banned = 0 AND deleted_at = 0
            AND (number LIKE ? OR nickname LIKE ? OR IFNULL(tags, '') LIKE ?)
          ORDER BY CASE WHEN number = ? THEN 0 WHEN number LIKE ? THEN 1 ELSE 2 END, nickname
          LIMIT ?`,
      )
      .all(me.id, like, like, like, q, q + '%', limit);
    const friendSet = new Set(
      db.prepare('SELECT b_id AS id FROM friendships WHERE a_id = ?').all(me.id).map((r) => Number(r.id)),
    );
    return {
      users: rows.map((r) => ({
        id: r.id,
        number: r.number,
        nickname: r.nickname,
        type: r.type,
        bio: r.bio || '',
        avatar: r.avatar || '',
        tags: parseTags(r.tags),
        isPublic: Number(r.is_public) === 1,
        isFriend: friendSet.has(Number(r.id)),
      })),
    };
  });

  /* ---------- 我的邀请码：每个账号都能拉人，注册时填它就行 ---------- */
  app.get('/api/me/invite', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const mine = db
      .prepare(
        `SELECT code, max_uses, used FROM invite_codes
          WHERE created_by = ? AND (expires_at = 0 OR expires_at > ?)
          ORDER BY created_at DESC LIMIT 1`,
      )
      .get(me.id, Date.now());
    if (mine) return { code: mine.code, used: Number(mine.used), maxUses: Number(mine.max_uses) };
    let code = newInviteCode();
    while (db.prepare('SELECT 1 FROM invite_codes WHERE code = ?').get(code)) code = newInviteCode();
    db.prepare(
      'INSERT INTO invite_codes (code, created_by, max_uses, used, expires_at, note, created_at) VALUES (?, ?, 5, 0, 0, ?, ?)',
    ).run(code, me.id, '个人邀请码', Date.now());
    return { code, used: 0, maxUses: 5 };
  });

  /* ---------- 注销账号：1–3 天冷静期，到期自动真删 ---------- */
  app.post('/api/me/delete', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        password: z.string().min(1, '请填密码确认'),
        days: z.coerce.number().int().min(1).max(3).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const row = db.prepare('SELECT password_hash, is_admin FROM accounts WHERE id = ?').get(me.id);
    if (!row || !verifyPassword(parsed.data.password, row.password_hash)) {
      return reply.code(401).send({ error: '密码不对' });
    }
    if (Number(row.is_admin) === 1) {
      const admins = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1 AND deleted_at = 0').get().n || 0;
      if (admins <= 1) return reply.code(400).send({ error: '你是唯一的站长，先把管理权限交给别人再注销' });
    }
    const days = parsed.data.days || 3;
    const at = Date.now() + days * 86400000;
    const tx = db.transaction(() => {
      db.prepare('UPDATE accounts SET deleted_at = ? WHERE id = ?').run(at, me.id);
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(me.id);
    });
    tx();
    return { ok: true, deleteAt: at, days };
  });

  app.post('/api/me/delete/cancel', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    db.prepare('UPDATE accounts SET deleted_at = 0 WHERE id = ?').run(me.id);
    return { ok: true };
  });

  /* ---------- 待审核账号 ---------- */
  app.get('/api/admin/pending', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.nickname, a.email, a.created_at,
                (SELECT l.ip FROM login_logs l WHERE l.account_id = a.id ORDER BY l.id DESC LIMIT 1) AS ip,
                (SELECT l.device FROM login_logs l WHERE l.account_id = a.id ORDER BY l.id DESC LIMIT 1) AS device
           FROM accounts a WHERE a.approved = 0 ORDER BY a.created_at DESC LIMIT 200`,
      )
      .all();
    return { pending: rows };
  });

  app.post('/api/admin/accounts/:number/approve', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z.object({ approve: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个账号' });
    if (parsed.data.approve) {
      db.prepare('UPDATE accounts SET approved = 1 WHERE id = ?').run(target.id);
      return { ok: true, number: target.number, approved: true };
    }
    /* 拒绝 = 直接删号，会话与关系跟着级联删掉 */
    db.transaction(() => {
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(target.id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(target.id);
    })();
    return { ok: true, number: target.number, approved: false, deleted: true };
  });

  /* ---------- 登录记录（成功与失败都列，用来抓撞库） ---------- */
  app.get('/api/admin/logins', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        limit: z.coerce.number().int().min(1).max(300).optional(),
        only: z.enum(['all', 'fail']).optional(),
        q: z.string().trim().max(64).optional(),
      })
      .safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: '查询参数不对' });
    const limit = parsed.data.limit || 100;
    const where = [];
    const args = [];
    if (parsed.data.only === 'fail') where.push('ok = 0');
    const kw = (parsed.data.q || '').trim();
    if (kw) {
      where.push('(number LIKE ? OR ip LIKE ? OR device LIKE ?)');
      const like = '%' + kw + '%';
      args.push(like, like, like);
    }
    const rows = db
      .prepare(
        `SELECT l.id, l.account_id, l.number, l.ip, l.device, l.ok, l.reason, l.created_at,
                (SELECT a.nickname FROM accounts a WHERE a.id = l.account_id) AS nickname
           FROM login_logs l
          ${where.length ? 'WHERE ' + where.map((w) => w.replace(/\b(ok|number|ip|device)\b/g, 'l.$1')).join(' AND ') : ''}
          ORDER BY l.id DESC LIMIT ?`,
      )
      .all(...args, limit);
    return { logins: rows.map((r) => ({ ...r, ok: Number(r.ok) === 1 })) };
  });

  /* ---------- IP 封禁 ---------- */
  app.get('/api/admin/ip-bans', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    return {
      bans: db.prepare('SELECT ip, reason, created_at FROM ip_bans ORDER BY created_at DESC LIMIT 300').all(),
    };
  });

  app.post('/api/admin/ip-bans', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({ ip: z.string().trim().min(3).max(64), reason: z.string().trim().max(120).optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'IP 格式不对' });
    const ip = parsed.data.ip.replace(/^::ffff:/, '');
    db.prepare(
      'INSERT INTO ip_bans (ip, reason, created_at) VALUES (?, ?, ?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason',
    ).run(ip, parsed.data.reason || '', Date.now());
    resetBanCache();
    /* 这个 IP 上已经登录的会话一起踢掉 */
    db.prepare('DELETE FROM sessions WHERE ip = ?').run(ip);
    return { ok: true, ip };
  });

  app.delete('/api/admin/ip-bans/:ip', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const ip = String(req.params.ip || '').replace(/^::ffff:/, '');
    db.prepare('DELETE FROM ip_bans WHERE ip = ?').run(ip);
    resetBanCache();
    return { ok: true, ip };
  });

  app.get('/api/admin/accounts', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        q: z.string().trim().max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).optional(),
        filter: z.enum(['all', 'user', 'bot', 'banned', 'admin']).optional(),
      })
      .safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: '查询参数不对' });
    const q = (parsed.data.q || '').trim();
    const limit = parsed.data.limit || 100;
    const filter = parsed.data.filter || 'all';
    const where = [];
    const args = [];
    if (q) {
      where.push('(a.number LIKE ? OR a.nickname LIKE ? OR IFNULL(a.email, \'\') LIKE ?)');
      const like = '%' + q + '%';
      args.push(like, like, like);
    }
    if (filter === 'user') where.push("a.type = 'user'");
    if (filter === 'bot') where.push("a.type = 'bot'");
    if (filter === 'banned') where.push('a.banned = 1');
    if (filter === 'admin') where.push('a.is_admin = 1');
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.nickname, a.type, a.email, a.bio, a.avatar, a.status,
                a.created_at, a.is_admin, a.banned, a.ban_reason, a.is_public, a.owner_id,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = a.id) AS msg_count
           FROM accounts a
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(...args, limit);
    return {
      accounts: rows.map((r) => ({
        ...r,
        is_admin: Number(r.is_admin) === 1,
        banned: Number(r.banned) === 1,
        is_public: Number(r.is_public) === 1,
      })),
    };
  });

  app.post('/api/admin/accounts/:number/ban', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({ banned: z.boolean(), reason: z.string().trim().max(120).optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个账号' });
    if (parsed.data.banned && target.id === me.id) return reply.code(400).send({ error: '不能封禁自己' });
    if (parsed.data.banned && Number(target.is_admin) === 1) {
      return reply.code(400).send({ error: '先取消对方的管理员身份' });
    }
    const banned = parsed.data.banned;
    const reason = banned ? parsed.data.reason || '' : '';
    const tx = db.transaction(() => {
      db.prepare('UPDATE accounts SET banned = ?, ban_reason = ? WHERE id = ?').run(banned ? 1 : 0, reason, target.id);
      // 封禁立刻踢下线，别等 token 自然过期
      if (banned) db.prepare('DELETE FROM sessions WHERE account_id = ?').run(target.id);
    });
    tx();
    return { ok: true, number: target.number, banned };
  });

  app.post('/api/admin/accounts/:number/delete', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个账号' });
    if (target.id === me.id) return reply.code(400).send({ error: '不能删除自己' });
    if (Number(target.is_admin) === 1) {
      const admins = db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE is_admin = 1').get().n || 0;
      if (admins <= 1) return reply.code(400).send({ error: '这是最后一个站长，不能删' });
    }
    /* 消息、会话、好友、群成员这些外键都带 CASCADE，删账号会连带清干净 */
    hardDeleteAccount(target.id);
    return { ok: true, number: target.number };
  });

  app.post('/api/admin/accounts/:number/admin', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z.object({ admin: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个账号' });
    if (target.id === me.id && !parsed.data.admin) {
      return reply.code(400).send({ error: '不能取消自己的管理员身份' });
    }
    db.prepare('UPDATE accounts SET is_admin = ? WHERE id = ?').run(parsed.data.admin ? 1 : 0, target.id);
    return { ok: true, number: target.number, admin: parsed.data.admin };
  });

  app.get('/api/admin/bots', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const includeHidden = String(req.query.includeHidden || '') === '1';
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.nickname, a.bio, a.avatar, a.is_public, a.owner_id, a.created_at,
                o.number AS owner_number, o.nickname AS owner_nickname,
                (SELECT COUNT(*) FROM messages m WHERE m.sender_id = a.id) AS msg_count
           FROM accounts a LEFT JOIN accounts o ON o.id = a.owner_id
          WHERE a.type = 'bot' AND (? = 1 OR a.is_public = 1) ORDER BY a.created_at DESC LIMIT 200`,
      )
      .all(includeHidden ? 1 : 0);
    return {
      bots: rows.map((r) => ({ ...r, is_public: Number(r.is_public) === 1, online: onebot.isOnline(r.id) })),
    };
  });

  app.post('/api/admin/bots/:number/public', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z.object({ isPublic: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(req.params.number);
    if (!target || target.type !== 'bot') return reply.code(404).send({ error: '没有这个 Bot' });
    db.prepare('UPDATE accounts SET is_public = ? WHERE id = ?').run(parsed.data.isPublic ? 1 : 0, target.id);
    return { ok: true, number: target.number, isPublic: parsed.data.isPublic };
  });

  app.get('/api/admin/messages', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const parsed = z
      .object({ limit: z.coerce.number().int().min(1).max(200).optional() })
      .safeParse(req.query || {});
    if (!parsed.success) return reply.code(400).send({ error: '查询参数不对' });
    const rows = db
      .prepare(
        `SELECT m.id, m.conversation_id, m.body, m.kind, m.created_at, m.sender_id,
                a.number AS sender_number, a.nickname AS sender_nickname, a.type AS sender_type
           FROM messages m JOIN accounts a ON a.id = m.sender_id
          WHERE m.recalled = 0 AND m.body <> '[已被管理员删除]'
          ORDER BY m.id DESC LIMIT ?`,
      )
      .all(parsed.data.limit || 100);
    return { messages: rows.map((r) => ({ ...r, body: String(r.body || '').slice(0, 300) })) };
  });

  app.delete('/api/admin/messages/:id', async (req, reply) => {
    const me = requireAdmin(req, reply);
    if (!me) return;
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: '消息编号不对' });
    const row = db.prepare('SELECT id FROM messages WHERE id = ?').get(id);
    if (!row) return reply.code(404).send({ error: '没有这条消息' });
    db.prepare('UPDATE messages SET body = \'[已被管理员删除]\', recalled = 1 WHERE id = ?').run(id);
    return { ok: true, id };
  });

  /* ---------- 改资料 ---------- */
  app.patch('/api/me', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const schema = z.object({
      nickname: z.string().trim().min(1).max(24).optional(),
      bio: z.string().max(60).optional(),
      status: z.enum(['online', 'away', 'busy', 'invisible']).optional(),
      avatar: z
        .string()
        .max(800000)
        .refine((v) => v === '' || /^data:image\/(png|jpeg|webp|gif);base64,/.test(v), '头像格式不对')
        .optional(),
      // 资料卡背景：空字符串=用主题默认；也允许引用本实例 /uploads 的图片
      cardBg: z
        .string()
        .max(800000)
        .refine(
          (v) => v === '' || /^data:image\/(png|jpeg|webp|gif);base64,/.test(v) || /^\/uploads\/[A-Za-z0-9._-]+$/.test(v),
          '背景图格式不对',
        )
        .optional(),
      // 公开照片墙：最多 9 张
      photos: z
        .array(
          z
            .string()
            .max(800000)
            .refine(
              (v) => /^data:image\/(png|jpeg|webp|gif);base64,/.test(v) || /^\/uploads\/[A-Za-z0-9._-]+$/.test(v),
              '照片格式不对',
            ),
        )
        .max(9)
        .optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '资料格式不对' });
    const p = parsed.data;
    if (p.nickname !== undefined) {
      db.prepare('UPDATE accounts SET nickname = ? WHERE id = ?').run(p.nickname, me.id);
    }
    if (p.bio !== undefined) {
      db.prepare('UPDATE accounts SET bio = ? WHERE id = ?').run(p.bio, me.id);
    }
    if (p.status !== undefined) {
      db.prepare('UPDATE accounts SET status = ? WHERE id = ?').run(p.status, me.id);
    }
    if (p.avatar !== undefined) {
      db.prepare('UPDATE accounts SET avatar = ? WHERE id = ?').run(p.avatar, me.id);
    }
    if (p.cardBg !== undefined) {
      db.prepare('UPDATE accounts SET card_bg = ? WHERE id = ?').run(p.cardBg, me.id);
    }
    if (p.photos !== undefined) {
      db.prepare('UPDATE accounts SET photos = ? WHERE id = ?').run(JSON.stringify(p.photos), me.id);
    }
    const row = db
      .prepare('SELECT id, number, type, nickname, bio, avatar, card_bg, photos, status FROM accounts WHERE id = ?')
      .get(me.id);
    return { ok: true, account: { ...row, photos: parsePhotos(row.photos) } };
  });

  /* ---------- 改密码 ---------- */
  app.post('/api/me/password', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({ oldPassword: z.string().min(1), newPassword: z.string().min(8).max(128) })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '新密码至少 8 位' });
    const row = db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(me.id);
    if (!row?.password_hash || !verifyPassword(parsed.data.oldPassword, row.password_hash)) {
      return reply.code(403).send({ error: '原密码不对' });
    }
    db.prepare('UPDATE accounts SET password_hash = ? WHERE id = ?').run(
      hashPassword(parsed.data.newPassword),
      me.id,
    );
    return { ok: true };
  });

  /* ---------- 账号搬迁：换设备不丢数据 ---------- */
  /* 导出：把本账号的资料、好友、会话、消息、群、收藏、Bot 配置打成一个加密包 */
  app.post('/api/account/export', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ password: z.string().min(1).max(128) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '要输入你的登录密码才能导出' });
    const row = db.prepare('SELECT password_hash FROM accounts WHERE id = ?').get(me.id);
    if (!row?.password_hash || !verifyPassword(parsed.data.password, row.password_hash)) {
      return reply.code(403).send({ error: '密码不对' });
    }
    let payload;
    try {
      payload = collectAccount(db, me.id);
    } catch (err) {
      return reply.code(500).send({ error: err.message || '导出失败' });
    }
    const pkg = sealPackage(payload, parsed.data.password);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return {
      ok: true,
      filename: `furry-everpony-${me.number}-${stamp}.feacct`,
      size: Buffer.byteLength(JSON.stringify(pkg), 'utf8'),
      package: pkg,
    };
  });

  /* 导入：在新设备 / 新实例上用备份包 + 密码恢复整个账号（这个接口不需要登录） */
  app.post('/api/account/import', { bodyLimit: 96 * 1024 * 1024 }, async (req, reply) => {
    const parsed = z
      .object({ password: z.string().min(1).max(128), package: z.record(z.any()) })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '要选择备份文件，并输入导出时用的密码' });
    let payload;
    try {
      payload = openPackage(parsed.data.package, parsed.data.password);
    } catch (err) {
      return reply.code(400).send({ error: err.message || '备份包打不开' });
    }
    let result;
    try {
      result = restoreAccount(db, payload);
    } catch (err) {
      return reply.code(err.code === 'NUMBER_TAKEN' ? 409 : 400).send({ error: err.message || '导入失败' });
    }
    const token = issueSession(result.accountId);
    const acc = db
      .prepare('SELECT id, number, type, nickname, bio, avatar, status FROM accounts WHERE id = ?')
      .get(result.accountId);
    return { ok: true, token, account: acc, counts: result.counts };
  });

  /* ---------- 退出 ---------- */
  app.post('/api/logout', async (req) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return { ok: true };
  });

  /* ---------- 查人 ---------- */
  app.get('/api/users/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = numberSchema.safeParse(req.params.number);
    if (!parsed.success) return reply.code(400).send({ error: '号码格式不对' });

    const target = findAccountByNumber(parsed.data);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });

    const reversePending = db
      .prepare(
        "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'",
      )
      .get(target.id, me.id);

    return {
      account: {
        ...target,
        photos: parsePhotos(target.photos),
        remote: target.type === 'remote',
        addr: target.remote_addr || '',
        ...presenceOf(target.id),
      },
      isSelf: target.id === me.id,
      isFriend: areFriends(me.id, target.id),
      isBlocked: isBlocked(me.id, target.id),
      hasPendingToMe: !!reversePending,
    };
  });

  /* ---------- 好友列表 ---------- */
  app.get('/api/friends', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.type, a.nickname, a.bio, a.avatar, a.status,
                a.remote_addr, f.remark, f.special, f.group_id
           FROM friendships f JOIN accounts a ON a.id = f.b_id
          WHERE f.a_id = ?
          ORDER BY f.special DESC, a.nickname`,
      )
      .all(me.id);
    return {
      friends: rows.map((f) => ({
        ...f,
        remote: f.type === 'remote',
        addr: f.remote_addr || '',
        special: !!f.special,
        ...presenceOf(f.id),
      })),
    };
  });

  /* ---------- 好友分组 ---------- */
  app.get('/api/friend-groups', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const groups = db
      .prepare(
        `SELECT g.id, g.name, g.sort_order,
                (SELECT COUNT(*) FROM friendships f WHERE f.a_id = ? AND f.group_id = g.id) AS count
           FROM friend_groups g WHERE g.account_id = ? ORDER BY g.sort_order, g.id`,
      )
      .all(me.id, me.id)
      .map((g) => ({ ...g, count: g.count }));
    return { groups };
  });

  app.post('/api/friend-groups', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ name: z.string().trim().min(1).max(16) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '分组名 1–16 个字' });
    const total = db.prepare('SELECT COUNT(*) AS c FROM friend_groups WHERE account_id = ?').get(me.id).c;
    if (total >= 20) return reply.code(400).send({ error: '分组最多 20 个' });
    const info = db
      .prepare('INSERT INTO friend_groups (account_id, name, sort_order, created_at) VALUES (?, ?, ?, ?)')
      .run(me.id, parsed.data.name, total, Date.now());
    return { ok: true, group: { id: Number(info.lastInsertRowid), name: parsed.data.name, count: 0 } };
  });

  app.patch('/api/friend-groups/:id', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ name: z.string().trim().min(1).max(16) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '分组名 1–16 个字' });
    const row = db
      .prepare('SELECT id FROM friend_groups WHERE id = ? AND account_id = ?')
      .get(Number(req.params.id), me.id);
    if (!row) return reply.code(404).send({ error: '没有这个分组' });
    db.prepare('UPDATE friend_groups SET name = ? WHERE id = ?').run(parsed.data.name, row.id);
    return { ok: true };
  });

  app.delete('/api/friend-groups/:id', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const row = db
      .prepare('SELECT id FROM friend_groups WHERE id = ? AND account_id = ?')
      .get(Number(req.params.id), me.id);
    if (!row) return reply.code(404).send({ error: '没有这个分组' });
    const tx = db.transaction(() => {
      db.prepare('UPDATE friendships SET group_id = NULL WHERE a_id = ? AND group_id = ?').run(me.id, row.id);
      db.prepare('DELETE FROM friend_groups WHERE id = ? AND account_id = ?').run(row.id, me.id);
    });
    tx();
    return { ok: true };
  });

  /* ---------- 好友申请 ---------- */
  app.get('/api/friends/requests', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const incoming = db
      .prepare(
        `SELECT r.id, r.message, r.created_at, a.number, a.nickname, a.bio
           FROM friend_requests r JOIN accounts a ON a.id = r.from_id
          WHERE r.to_id = ? AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id);
    const outgoing = db
      .prepare(
        `SELECT r.id, r.created_at, a.number, a.nickname
           FROM friend_requests r JOIN accounts a ON a.id = r.to_id
          WHERE r.from_id = ? AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id);
    // 别人想加我的 Bot：要我这个主人点头
    const botIncoming = db
      .prepare(
        `SELECT r.id, r.message, r.created_at,
                f.number AS from_number, f.nickname AS from_nickname, f.avatar AS from_avatar, f.bio AS from_bio,
                b.number AS bot_number, b.nickname AS bot_nickname
           FROM friend_requests r
           JOIN accounts f ON f.id = r.from_id
           JOIN accounts b ON b.id = r.to_id
          WHERE b.owner_id = ? AND b.type = 'bot' AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id)
      .map((r) => ({
        id: r.id,
        message: r.message,
        created_at: r.created_at,
        from: { number: r.from_number, nickname: r.from_nickname, avatar: r.from_avatar || '', bio: r.from_bio },
        bot: { number: r.bot_number, nickname: r.bot_nickname },
      }));
    return { incoming, outgoing, botIncoming };
  });

  app.post('/api/friends/request', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({ number: numberSchema, message: z.string().max(120).optional() })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === me.id) return reply.code(400).send({ error: '不能加自己' });
    if (areFriends(me.id, target.id)) return reply.code(409).send({ error: '你们已经是好友了' });
    if (isBlocked(target.id, me.id)) return reply.code(403).send({ error: '对方拒绝接收你的申请' });

    // 对方已经申请过我 → 直接成为好友
    const reverse = db
      .prepare(
        "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'",
      )
      .get(target.id, me.id);
    if (reverse) {
      makeFriends(me.id, target.id);
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(reverse.id);
      return { ok: true, status: 'accepted' };
    }

    const dup = db
      .prepare(
        "SELECT id FROM friend_requests WHERE from_id = ? AND to_id = ? AND status = 'pending'",
      )
      .get(me.id, target.id);
    if (dup) return reply.code(409).send({ error: '申请已经发过了，等对方处理' });

    // Bot 由主人代为审批：先挂起，主人在「新朋友」里点头后才生效
    if (target.type === 'bot' && target.owner_id !== me.id) {
      db.prepare(
        "INSERT INTO friend_requests (from_id, to_id, message, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
      ).run(me.id, target.id, parsed.data.message || '', Date.now());
      return { ok: true, status: 'pending', pendingApproval: true };
    }

    // 自己的 Bot：直接通过（正常情况建 Bot 时就已经是好友）
    if (target.type === 'bot') {
      db.prepare(
        "INSERT INTO friend_requests (from_id, to_id, message, status, created_at) VALUES (?, ?, ?, 'accepted', ?)",
      ).run(me.id, target.id, parsed.data.message || '', Date.now());
      makeFriends(me.id, target.id);
      return { ok: true, status: 'accepted' };
    }

    db.prepare(
      "INSERT INTO friend_requests (from_id, to_id, message, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
    ).run(me.id, target.id, parsed.data.message || '', Date.now());

    return { ok: true, status: 'pending' };
  });

  /**
   * 找到一条待处理的好友申请：支持 {requestId}，也支持 {number, bot}。
   * {number, bot} 表示「有人想加我的 Bot」，由 Bot 主人代审批。
   */
  function resolveFriendRequest(req, reply) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const body = req.body || {};

    if (body.requestId) {
      /* 按 id 找申请：接收方可能是我，也可能是我的 Bot（别人加我的 Bot 由我代审批）。
         以前只认 to_id === me.id，导致 Bot 申请点「拒绝/同意」一律报「没有这条申请」，但列表里还在显示。 */
      const row = db
        .prepare(
          `SELECT r.id, r.from_id, r.to_id, r.status, b.type AS to_type, b.owner_id AS to_owner
             FROM friend_requests r JOIN accounts b ON b.id = r.to_id
            WHERE r.id = ?`,
        )
        .get(Number(body.requestId));
      const mine = row && (row.to_id === me.id || (row.to_type === 'bot' && row.to_owner === me.id));
      if (!mine) {
        reply.code(404).send({ error: '没有这条申请' });
        return null;
      }
      return { me, row };
    }

    const parsed = z
      .object({ number: numberSchema, bot: numberSchema.optional() })
      .safeParse(body);
    if (!parsed.success) {
      reply.code(400).send({ error: '参数不对' });
      return null;
    }

    if (parsed.data.bot) {
      const bot = findAccountByNumber(parsed.data.bot);
      if (!bot || bot.type !== 'bot' || bot.owner_id !== me.id) {
        reply.code(403).send({ error: '这不是你的 Bot' });
        return null;
      }
      const row = db
        .prepare(
          `SELECT r.id, r.from_id, r.to_id, r.status FROM friend_requests r
             JOIN accounts f ON f.id = r.from_id
            WHERE r.to_id = ? AND f.number = ? AND r.status = 'pending'
            ORDER BY r.id DESC LIMIT 1`,
        )
        .get(bot.id, parsed.data.number);
      if (!row) {
        reply.code(404).send({ error: '没有这条申请' });
        return null;
      }
      return { me, row };
    }

    const row = db
      .prepare(
        `SELECT r.id, r.from_id, r.to_id, r.status FROM friend_requests r
           JOIN accounts f ON f.id = r.from_id
          WHERE r.to_id = ? AND f.number = ? AND r.status = 'pending'
          ORDER BY r.id DESC LIMIT 1`,
      )
      .get(me.id, parsed.data.number);
    if (!row) {
      reply.code(404).send({ error: '没有这条申请' });
      return null;
    }
    return { me, row };
  }

  /** 通过好友申请后，如果对方是 Bot，就推一条好友添加事件给 OneBot 端 */
  function announceFriendAccepted(row) {
    const target = accountById(row.to_id);
    const from = accountById(row.from_id);
    if (target && target.type === 'bot' && from) onebot.pushFriendAdd(target, from);
  }

  app.post('/api/friends/accept', async (req, reply) => {
    const ctx = resolveFriendRequest(req, reply);
    if (!ctx) return;
    const { row } = ctx;
    if (row.status !== 'pending') return reply.code(409).send({ error: '这条申请已经处理过了' });

    const from = accountById(row.from_id);
    if (from && from.type === 'remote') {
      // 跨实例：先让对方实例那边也建立好友，成功了再落本地，避免单边好友
      const mirror = db
        .prepare('SELECT id, number, remote_addr, remote_instance, remote_secret FROM accounts WHERE id = ?')
        .get(row.from_id);
      const out = await fed.notifyAccepted(mirror, accountById(row.to_id));
      if (!out.ok) return reply.code(502).send({ error: out.error || '对方实例没连上' });
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(row.id);
      return { ok: true, status: 'accepted', remote: true };
    }
    const tx = db.transaction(() => {
      makeFriends(row.from_id, row.to_id);
      db.prepare("UPDATE friend_requests SET status = 'accepted' WHERE id = ?").run(row.id);
    });
    tx();
    announceFriendAccepted(row);
    return { ok: true, status: 'accepted' };
  });

  app.post('/api/friends/reject', async (req, reply) => {
    const ctx = resolveFriendRequest(req, reply);
    if (!ctx) return;
    const { row } = ctx;
    if (row.status !== 'pending') return reply.code(409).send({ error: '这条申请已经处理过了' });
    db.prepare("UPDATE friend_requests SET status = 'rejected' WHERE id = ?").run(row.id);
    return { ok: true, status: 'rejected' };
  });

  app.delete('/api/friends/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });

    const del = db.prepare('DELETE FROM friendships WHERE a_id = ? AND b_id = ?');
    const tx = db.transaction(() => {
      del.run(me.id, target.id);
      del.run(target.id, me.id);
    });
    tx();
    return { ok: true };
  });

  /* ---------- 会话列表 ---------- */
  app.get('/api/conversations', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;

    const rows = db
      .prepare(
        `SELECT c.id, c.kind, c.created_at, m.last_read_id, m.pinned, m.muted
           FROM conversations c
           JOIN conversation_members m ON m.conversation_id = c.id
          WHERE m.account_id = ?
          ORDER BY c.id DESC`,
      )
      .all(me.id);

    const lastStmt = db.prepare(
      `SELECT id, sender_id, body, kind, meta, recalled, created_at FROM messages
        WHERE conversation_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM message_deletions d
             WHERE d.message_id = messages.id AND d.account_id = ?
          )
        ORDER BY id DESC LIMIT 1`,
    );
    const unreadStmt = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND sender_id != ?',
    );
    const peerReadStmt = db.prepare(
      'SELECT MAX(last_read_id) AS v FROM conversation_members WHERE conversation_id = ? AND account_id != ?',
    );

    const conversations = rows.map((c) => {
      const peer = c.kind === 'dm' ? peerOf(c.id, me.id) : null;
      const last = lastStmt.get(c.id, me.id);
      const group = c.kind === 'group' ? convGroup(c.id) : null;
      return {
        id: c.id,
        kind: c.kind,
        peer: peer ? { ...peer, ...presenceOf(peer.id) } : null,
        group,
        last: last
          ? {
              id: last.id,
              body: last.recalled ? '' : last.body,
              kind: last.kind || 'text',
              preview: messageDisplay(last.kind || 'text', last.body, readMeta(last.meta)),
              mine: last.sender_id === me.id,
              created_at: last.created_at,
            }
          : null,
        unread: unreadStmt.get(c.id, c.last_read_id, me.id).c,
        pinned: !!c.pinned,
        muted: !!c.muted,
        peerRead: peerReadStmt.get(c.id, me.id)?.v || 0,
      };
    });

    conversations.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.last?.id || 0) - (a.last?.id || 0);
    });

    return { conversations };
  });

  /* ---------- 免打扰 ---------- */
  app.post('/api/conversations/:id/mute', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });
    const parsed = z.object({ muted: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    db.prepare('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND account_id = ?').run(
      parsed.data.muted ? 1 : 0,
      convId,
      me.id,
    );
    return { ok: true };
  });

  /* ---------- 消息 ---------- */
  app.get('/api/conversations/:id/messages', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });

    const after = Number(req.query.after || 0);
    const conv = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(convId);
    const isGroup = conv?.kind === 'group';
    const group = isGroup ? convGroup(convId) : null;

    const rows = db
      .prepare(
        `SELECT m.id, m.sender_id, m.body, m.kind, m.recalled, m.created_at, m.reply_to_id, m.meta,
                a.number AS sender_number, a.nickname AS sender_nickname, a.avatar AS sender_avatar
           FROM messages m JOIN accounts a ON a.id = m.sender_id
          WHERE m.conversation_id = ? AND m.id > ?
          ORDER BY m.id ASC LIMIT 200`,
      )
      .all(convId, after);

    return {
      messages: serializeMessages(rows, me.id, {
        isGroup,
        groupId: group?.id || null,
        nickMap: group ? groupNickMap(group.id) : undefined,
      }),
      typing: typingList(convId, me.id),
      group: group || null,
      announcement: group?.announcement || '',
    };
  });

  app.post('/api/conversations/:id/messages', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });

    const data = parseMessageInput(req.body);
    if (data.error) return reply.code(400).send({ error: data.error });

    const group = convGroup(convId);
    const out = insertMessage(me, convId, data, { group });
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });

    const display = messageDisplay(data.kind, data.body, readMeta(data.meta));
    if (group) notifyGroupBots(group, me, out.id, display);
    else notifyPeerIfBot(convId, me, out.id, display);

    return {
      ok: true,
      message: serializeMessages([messageRow(out.id)], me.id, {
        isGroup: !!group,
        groupId: group?.id || null,
        nickMap: group ? groupNickMap(group.id) : undefined,
      })[0],
    };
  });

  app.post('/api/conversations/:id/read', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });

    const last = db
      .prepare('SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?')
      .get(convId);
    db.prepare(
      'UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND account_id = ?',
    ).run(last?.id || 0, convId, me.id);
    return { ok: true };
  });

  /* ---------- 撤回 ---------- */
  app.post('/api/messages/:id/recall', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const id = Number(req.params.id);
    const row = db
      .prepare('SELECT id, sender_id, conversation_id, created_at FROM messages WHERE id = ?')
      .get(id);
    if (!row) return reply.code(404).send({ error: '没有这条消息' });
    if (row.sender_id !== me.id) return reply.code(403).send({ error: '只能撤回自己的消息' });
    if (Date.now() - row.created_at > 120000) return reply.code(400).send({ error: '超过两分钟了，撤不回了' });
    db.prepare("UPDATE messages SET recalled = 1, body = '', meta = '', reply_to_id = NULL WHERE id = ?").run(id);
    return { ok: true };
  });

  /* ---------- 打开/创建一个私聊会话 ---------- */
  app.post('/api/dm', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ number: numberSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === me.id) return reply.code(400).send({ error: '不能和自己聊' });
    if (!canOpenDm(me.id, target)) return reply.code(403).send({ error: '还不是好友，先加好友' });

    return { conversationId: getOrCreateDm(me.id, target.id) };
  });

  /* ---------- 直接按号码发消息（自动建会话） ---------- */
  app.post('/api/messages', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ to: numberSchema }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const data = parseMessageInput(req.body);
    if (data.error) return reply.code(400).send({ error: data.error });

    const target = findAccountByNumber(parsed.data.to);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === me.id) return reply.code(400).send({ error: '不能给自己发' });
    if (!canOpenDm(me.id, target)) return reply.code(403).send({ error: '还不是好友，先加好友' });
    if (isBlocked(target.id, me.id)) return reply.code(403).send({ error: '对方已把你拉黑' });

    const convId = getOrCreateDm(me.id, target.id);
    const out = insertMessage(me, convId, data);
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });

    notifyPeerIfBot(convId, me, out.id, messageDisplay(data.kind, data.body, readMeta(data.meta)));

    return {
      ok: true,
      conversationId: convId,
      message: serializeMessages([messageRow(out.id)], me.id)[0],
    };
  });

  /* ---------- 正在输入 ---------- */
  app.post('/api/conversations/:id/typing', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });
    const parsed = z.object({ typing: z.boolean().optional() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    if (parsed.data.typing === false) clearTyping(convId, me.id);
    else setTyping(convId, me.id);
    return { ok: true };
  });

  /* ---------- 表情回应 ---------- */
  app.post('/api/messages/:id/reactions', async (req, reply) => {
    const id = Number(req.params.id);
    const ctx = messageAccess(req, reply, id);
    if (!ctx) return;
    const parsed = z.object({ emoji: z.string().min(1).max(8) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '表情不对' });
    const { me } = ctx;
    const emoji = parsed.data.emoji;
    const exists = db
      .prepare('SELECT 1 AS x FROM message_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?')
      .get(id, me.id, emoji);
    if (exists) {
      db.prepare('DELETE FROM message_reactions WHERE message_id = ? AND account_id = ? AND emoji = ?').run(
        id,
        me.id,
        emoji,
      );
    } else {
      const kinds = db
        .prepare('SELECT COUNT(DISTINCT emoji) AS c FROM message_reactions WHERE message_id = ?')
        .get(id).c;
      if (kinds >= 20) return reply.code(400).send({ error: '一条消息最多 20 种表情' });
      db.prepare(
        'INSERT INTO message_reactions (message_id, account_id, emoji, created_at) VALUES (?, ?, ?, ?)',
      ).run(id, me.id, emoji, Date.now());
    }
    return { ok: true, reactions: reactionsFor(id, me.id) };
  });

  /* ---------- 仅自己可见的删除 ---------- */
  app.post('/api/messages/:id/delete', async (req, reply) => {
    const id = Number(req.params.id);
    const ctx = messageAccess(req, reply, id);
    if (!ctx) return;
    db.prepare(
      'INSERT OR IGNORE INTO message_deletions (message_id, account_id, created_at) VALUES (?, ?, ?)',
    ).run(id, ctx.me.id, Date.now());
    return { ok: true };
  });

  /* ---------- 会话摘要（收藏列表用） ---------- */
  function conversationBrief(convId, meId) {
    const conv = db.prepare('SELECT kind FROM conversations WHERE id = ?').get(convId);
    if (!conv) return null;
    if (conv.kind === 'group') {
      const g = convGroup(convId);
      return { kind: 'group', group: g ? { number: g.number, name: g.name, avatar: g.avatar || '' } : null };
    }
    const peer = peerOf(convId, meId);
    return {
      kind: 'dm',
      peer: peer ? { number: peer.number, nickname: peer.nickname, avatar: peer.avatar || '' } : null,
    };
  }

  /* ---------- 收藏 ---------- */
  app.get('/api/favorites', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT f.created_at AS saved_at, m.id, m.conversation_id, m.sender_id, m.body, m.kind, m.recalled,
                m.created_at, m.reply_to_id, m.meta,
                a.number AS sender_number, a.nickname AS sender_nickname, a.avatar AS sender_avatar
           FROM favorites f
           JOIN messages m ON m.id = f.message_id
           JOIN accounts a ON a.id = m.sender_id
          WHERE f.account_id = ?
          ORDER BY f.id DESC LIMIT 200`,
      )
      .all(me.id);
    return {
      favorites: rows.map((m) => ({
        saved_at: m.saved_at,
        message: serializeMessages([m], me.id)[0],
        conversation: conversationBrief(m.conversation_id, me.id),
      })),
    };
  });

  app.post('/api/messages/:id/favorite', async (req, reply) => {
    const id = Number(req.params.id);
    const ctx = messageAccess(req, reply, id);
    if (!ctx) return;
    db.prepare(
      'INSERT OR IGNORE INTO favorites (account_id, message_id, created_at) VALUES (?, ?, ?)',
    ).run(ctx.me.id, id, Date.now());
    return { ok: true };
  });

  app.delete('/api/messages/:id/favorite', async (req, reply) => {
    const id = Number(req.params.id);
    const ctx = messageAccess(req, reply, id);
    if (!ctx) return;
    db.prepare('DELETE FROM favorites WHERE account_id = ? AND message_id = ?').run(ctx.me.id, id);
    return { ok: true };
  });

  /* ---------- 转发 ---------- */
  app.post('/api/messages/:id/forward', async (req, reply) => {
    const id = Number(req.params.id);
    const ctx = messageAccess(req, reply, id);
    if (!ctx) return;
    const parsed = z.object({ conversationId: z.number().int().positive() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const targetConv = parsed.data.conversationId;
    if (!memberOf(targetConv, ctx.me.id)) return reply.code(403).send({ error: '不在目标会话里' });

    const src = db
      .prepare(
        `SELECT m.id, m.kind, m.body, m.meta, m.recalled, m.created_at,
                a.number AS sender_number, a.nickname AS sender_nickname
           FROM messages m JOIN accounts a ON a.id = m.sender_id WHERE m.id = ?`,
      )
      .get(id);
    if (!src) return reply.code(404).send({ error: '没有这条消息' });
    if (src.recalled) return reply.code(400).send({ error: '这条消息已经撤回了' });

    const meta = {
      from: { number: src.sender_number, nickname: src.sender_nickname },
      source: {
        kind: src.kind || 'text',
        body: src.kind === 'text' ? String(src.body).slice(0, 500) : messageDisplay(src.kind, src.body, readMeta(src.meta)),
        created_at: src.created_at,
      },
    };
    const group = convGroup(targetConv);
    const out = insertMessage(
      ctx.me,
      targetConv,
      {
        kind: 'forward',
        body: meta.source.body,
        replyTo: null,
        mentionAll: false,
        meta: JSON.stringify(meta),
      },
      { group },
    );
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });

    if (group) notifyGroupBots(group, ctx.me, out.id, '[转发的消息]');
    else notifyPeerIfBot(targetConv, ctx.me, out.id, '[转发的消息]');

    return {
      ok: true,
      message: serializeMessages([messageRow(out.id)], ctx.me.id, {
        isGroup: !!group,
        groupId: group?.id || null,
        nickMap: group ? groupNickMap(group.id) : undefined,
      })[0],
    };
  });

  /* ---------- 合并转发（聊天记录） ---------- */
  app.post('/api/conversations/:id/forward-merge', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const srcConv = Number(req.params.id);
    if (!memberOf(srcConv, me.id)) return reply.code(403).send({ error: '不在这个会话里' });
    const parsed = z
      .object({
        messageIds: z.array(z.number().int().positive()).min(1).max(50),
        conversationId: z.number().int().positive(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const targetConv = parsed.data.conversationId;
    if (!memberOf(targetConv, me.id)) return reply.code(403).send({ error: '不在目标会话里' });

    const holes = parsed.data.messageIds.map(() => '?').join(',');
    const rows = db
      .prepare(
        `SELECT m.id, m.kind, m.body, m.recalled, m.created_at,
                a.number AS sender_number, a.nickname AS sender_nickname
           FROM messages m JOIN accounts a ON a.id = m.sender_id
          WHERE m.conversation_id = ? AND m.id IN (${holes})
          ORDER BY m.id ASC`,
      )
      .all(srcConv, ...parsed.data.messageIds);
    if (!rows.length) return reply.code(400).send({ error: '没有可转发的消息' });

    const items = rows.map((r) => ({
      number: r.sender_number,
      nickname: r.sender_nickname,
      kind: r.kind || 'text',
      body: r.recalled ? '' : String(r.body).slice(0, 500),
      created_at: r.created_at,
    }));
    const meta = { title: '聊天记录', count: items.length, items };
    const group = convGroup(targetConv);
    const out = insertMessage(
      me,
      targetConv,
      {
        kind: 'merge',
        body: `[聊天记录] ${items.length} 条`,
        replyTo: null,
        mentionAll: false,
        meta: JSON.stringify(meta),
      },
      { group },
    );
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });

    if (group) notifyGroupBots(group, me, out.id, '[聊天记录]');
    else notifyPeerIfBot(targetConv, me, out.id, '[聊天记录]');

    return {
      ok: true,
      message: serializeMessages([messageRow(out.id)], me.id, {
        isGroup: !!group,
        groupId: group?.id || null,
        nickMap: group ? groupNickMap(group.id) : undefined,
      })[0],
    };
  });

  /* ---------- 群 ---------- */
  function ensureGroupConversation(group) {
    if (group.conversation_id) return group.conversation_id;
    const info = db
      .prepare("INSERT INTO conversations (kind, created_at) VALUES ('group', ?)")
      .run(Date.now());
    const cid = Number(info.lastInsertRowid);
    db.prepare('UPDATE groups SET conversation_id = ? WHERE id = ?').run(cid, group.id);
    return cid;
  }

  function addGroupMember(groupId, accountId, role = 'member') {
    db.prepare(
      'INSERT OR IGNORE INTO group_members (group_id, account_id, role, joined_at) VALUES (?, ?, ?, ?)',
    ).run(groupId, accountId, role, Date.now());
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    const cid = ensureGroupConversation(group);
    db.prepare(
      'INSERT OR IGNORE INTO conversation_members (conversation_id, account_id, last_read_id) VALUES (?, ?, 0)',
    ).run(cid, accountId);
    return cid;
  }

  function findGroup(number) {
    return db.prepare('SELECT * FROM groups WHERE number = ?').get(String(number));
  }

  function isGroupMember(groupId, accountId) {
    return !!db
      .prepare('SELECT 1 AS x FROM group_members WHERE group_id = ? AND account_id = ?')
      .get(groupId, accountId);
  }

  function groupRole(groupId, accountId) {
    const row = db
      .prepare('SELECT role FROM group_members WHERE group_id = ? AND account_id = ?')
      .get(groupId, accountId);
    return row?.role || null;
  }

  /** 群里有人说话 → 推给群里的每个 Bot */
  function notifyGroupBots(group, sender, messageId, body) {
    const bots = db
      .prepare(
        `SELECT a.* FROM group_members gm JOIN accounts a ON a.id = gm.account_id
          WHERE gm.group_id = ? AND a.type = 'bot'`,
      )
      .all(group.id);
    for (const b of bots) onebot.pushGroupMessage(b, group, sender, { id: messageId, body });
  }

  app.post('/api/groups', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({ number: numberSchema, name: z.string().min(1).max(40) })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    if (findGroup(parsed.data.number)) return reply.code(409).send({ error: '这个群号已经被用了' });

    const info = db
      .prepare('INSERT INTO groups (number, name, owner_id, created_at) VALUES (?, ?, ?, ?)')
      .run(parsed.data.number, parsed.data.name, me.id, Date.now());
    const groupId = Number(info.lastInsertRowid);
    const cid = addGroupMember(groupId, me.id, 'owner');

    return { ok: true, group: { number: parsed.data.number, name: parsed.data.name }, conversationId: cid };
  });

  app.get('/api/groups', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const groups = db
      .prepare(
        `SELECT g.number, g.name, g.avatar, g.owner_id, g.conversation_id, g.announcement, g.announcement_updated_at,
                g.mute_all, gm.role, gm.nickname AS group_nickname, gm.mute_until,
                (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS members,
                (SELECT COUNT(*) FROM group_requests r
                  WHERE r.group_id = g.id AND r.kind = 'invite' AND r.status = 'pending') AS pending
           FROM groups g JOIN group_members gm ON gm.group_id = g.id
          WHERE gm.account_id = ?
          ORDER BY g.id DESC`,
      )
      .all(me.id)
      .map((g) => ({ ...g, mute_all: !!g.mute_all, mute_until: g.mute_until || 0 }));
    return { groups };
  });

  app.post('/api/groups/:number/join', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    addGroupMember(group.id, me.id);
    return { ok: true };
  });

  app.post('/api/groups/:number/invite', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ number: numberSchema }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });

    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (isGroupMember(group.id, target.id)) return reply.code(409).send({ error: '对方已经在群里了' });

    const dup = db
      .prepare(
        "SELECT id FROM group_requests WHERE group_id = ? AND to_id = ? AND kind = 'invite' AND status = 'pending'",
      )
      .get(group.id, target.id);
    if (dup) return reply.code(409).send({ error: '邀请已经发过了，等对方处理' });

    // 邀请制：对方（Bot 则是它的主人）同意后才进群
    db.prepare(
      "INSERT INTO group_requests (group_id, from_id, to_id, kind, status, created_at) VALUES (?, ?, ?, 'invite', 'pending', ?)",
    ).run(group.id, me.id, target.id, Date.now());
    return { ok: true, pending: true };
  });

  /* ---------- 入群邀请的收件箱 ---------- */
  app.get('/api/group-requests', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const select = `SELECT r.id, r.created_at, r.group_id, g.number, g.name,
                           a.number AS from_number, a.nickname AS from_nickname, a.avatar AS from_avatar,
                           t.number AS to_number, t.nickname AS to_nickname
                      FROM group_requests r
                      JOIN groups g ON g.id = r.group_id
                      JOIN accounts a ON a.id = r.from_id
                      JOIN accounts t ON t.id = r.to_id`;
    const incoming = db
      .prepare(
        `${select}
          WHERE (r.to_id = ? OR (t.type = 'bot' AND t.owner_id = ?))
            AND r.kind = 'invite' AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id, me.id);
    const outgoing = db
      .prepare(
        `${select}
          WHERE r.from_id = ? AND r.kind = 'invite' AND r.status = 'pending'
          ORDER BY r.id DESC`,
      )
      .all(me.id);
    return { incoming, outgoing };
  });

  /** 找到一条待处理入群邀请，并校验自己有权处理（本人，或 Bot 的主人） */
  function resolveGroupRequest(req, reply) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const row = db
      .prepare('SELECT id, group_id, from_id, to_id, kind, status FROM group_requests WHERE id = ?')
      .get(Number(req.params.id));
    if (!row) {
      reply.code(404).send({ error: '没有这条邀请' });
      return null;
    }
    const target = accountById(row.to_id);
    const allowed = row.to_id === me.id || (target && target.type === 'bot' && target.owner_id === me.id);
    if (!allowed) {
      reply.code(403).send({ error: '这条邀请不是给你的' });
      return null;
    }
    if (row.status !== 'pending') {
      reply.code(409).send({ error: '这条邀请已经处理过了' });
      return null;
    }
    return { me, row, target };
  }

  app.post('/api/group-requests/:id/accept', async (req, reply) => {
    const ctx = resolveGroupRequest(req, reply);
    if (!ctx) return;
    const group = db.prepare('SELECT * FROM groups WHERE id = ?').get(ctx.row.group_id);
    if (!group) return reply.code(404).send({ error: '群已经不存在了' });
    const tx = db.transaction(() => {
      addGroupMember(group.id, ctx.row.to_id);
      db.prepare("UPDATE group_requests SET status = 'accepted' WHERE id = ?").run(ctx.row.id);
    });
    tx();
    return { ok: true };
  });

  app.post('/api/group-requests/:id/reject', async (req, reply) => {
    const ctx = resolveGroupRequest(req, reply);
    if (!ctx) return;
    db.prepare("UPDATE group_requests SET status = 'rejected' WHERE id = ?").run(ctx.row.id);
    return { ok: true };
  });

  app.get('/api/groups/:number/members', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });

    const members = db
      .prepare(
        `SELECT a.number, a.nickname, a.bio, a.avatar, a.type, a.status, gm.role,
                gm.nickname AS group_nickname, gm.mute_until, gm.joined_at
           FROM group_members gm JOIN accounts a ON a.id = gm.account_id
          WHERE gm.group_id = ? ORDER BY gm.joined_at`,
      )
      .all(group.id);
    return {
      members: members.map((m) => ({
        ...m,
        nickname: m.group_nickname || m.nickname,
        group_nickname: m.group_nickname || '',
        mute_until: m.mute_until || 0,
        ...presenceOf(db.prepare('SELECT id FROM accounts WHERE number = ?').get(m.number).id),
      })),
    };
  });

  app.delete('/api/groups/:number/leave', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ?').run(group.id, me.id);
    if (group.conversation_id) {
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND account_id = ?').run(
        group.conversation_id, me.id,
      );
    }
    const left = db.prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?').get(group.id).c;
    if (left === 0) {
      if (group.conversation_id) db.prepare('DELETE FROM conversations WHERE id = ?').run(group.conversation_id);
      db.prepare('DELETE FROM groups WHERE id = ?').run(group.id);
    }
    return { ok: true };
  });

  app.post('/api/groups/:number/messages', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });

    const data = parseMessageInput(req.body);
    if (data.error) return reply.code(400).send({ error: data.error });

    const cid = ensureGroupConversation(group);
    const out = insertMessage(me, cid, data, { group });
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    notifyGroupBots(group, me, out.id, messageDisplay(data.kind, data.body, readMeta(data.meta)));

    return {
      ok: true,
      message: serializeMessages([messageRow(out.id)], me.id, {
        isGroup: true,
        groupId: group.id,
        nickMap: groupNickMap(group.id),
      })[0],
    };
  });

  /* ---------- Bot 发言排行 ---------- */
  /* ---------- 备注 / 拉黑 ---------- */
  app.patch('/api/friends/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        remark: z.string().trim().max(24).optional(),
        special: z.boolean().optional(),
        groupId: z.number().int().positive().nullable().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '备注最多 24 个字' });
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (!areFriends(me.id, target.id)) return reply.code(403).send({ error: '还不是好友' });

    if (parsed.data.groupId) {
      const g = db
        .prepare('SELECT id FROM friend_groups WHERE id = ? AND account_id = ?')
        .get(parsed.data.groupId, me.id);
      if (!g) return reply.code(404).send({ error: '没有这个分组' });
    }
    if (parsed.data.remark !== undefined) {
      db.prepare('UPDATE friendships SET remark = ? WHERE a_id = ? AND b_id = ?').run(
        parsed.data.remark, me.id, target.id,
      );
    }
    if (parsed.data.special !== undefined) {
      db.prepare('UPDATE friendships SET special = ? WHERE a_id = ? AND b_id = ?').run(
        parsed.data.special ? 1 : 0, me.id, target.id,
      );
    }
    if (parsed.data.groupId !== undefined) {
      db.prepare('UPDATE friendships SET group_id = ? WHERE a_id = ? AND b_id = ?').run(
        parsed.data.groupId || null, me.id, target.id,
      );
    }
    return { ok: true };
  });

  app.get('/api/blocks', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const rows = db
      .prepare(
        `SELECT a.number, a.nickname, a.avatar FROM blocks b
           JOIN accounts a ON a.id = b.b_id WHERE b.a_id = ? ORDER BY b.created_at DESC`,
      )
      .all(me.id);
    return { blocks: rows };
  });

  app.post('/api/blocks/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === me.id) return reply.code(400).send({ error: '不能拉黑自己' });
    db.prepare('INSERT OR IGNORE INTO blocks (a_id, b_id, created_at) VALUES (?, ?, ?)').run(
      me.id, target.id, Date.now(),
    );
    return { ok: true };
  });

  app.delete('/api/blocks/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const target = findAccountByNumber(req.params.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    db.prepare('DELETE FROM blocks WHERE a_id = ? AND b_id = ?').run(me.id, target.id);
    return { ok: true };
  });

  /* ---------- 会话置顶 ---------- */
  app.post('/api/conversations/:id/pin', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const convId = Number(req.params.id);
    if (!memberOf(convId, me.id)) return reply.code(403).send({ error: '不在这个会话里' });
    const parsed = z.object({ pinned: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    db.prepare('UPDATE conversation_members SET pinned = ? WHERE conversation_id = ? AND account_id = ?').run(
      parsed.data.pinned ? 1 : 0, convId, me.id,
    );
    return { ok: true };
  });

  /* ---------- 消息搜索 ---------- */
  app.get('/api/messages/search', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const q = String(req.query.q || '').trim();
    if (!q) return { messages: [] };
    const convId = Number(req.query.conversationId || 0);
    const like = `%${q}%`;
    const rows = convId
      ? db
          .prepare(
            `SELECT m.id, m.conversation_id, m.body, m.created_at, a.number AS sender_number, a.nickname AS sender_nickname
               FROM messages m JOIN accounts a ON a.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.account_id = ?
              WHERE m.conversation_id = ? AND m.recalled = 0 AND m.body LIKE ?
              ORDER BY m.id DESC LIMIT 50`,
          )
          .all(me.id, convId, like)
      : db
          .prepare(
            `SELECT m.id, m.conversation_id, m.body, m.created_at, a.number AS sender_number, a.nickname AS sender_nickname
               FROM messages m JOIN accounts a ON a.id = m.sender_id
               JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.account_id = ?
              WHERE m.recalled = 0 AND m.body LIKE ?
              ORDER BY m.id DESC LIMIT 50`,
          )
          .all(me.id, like);
    return { messages: rows };
  });

  /* ---------- 群资料 / 踢人 ---------- */
  app.patch('/api/groups/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    const role = groupRole(group.id, me.id);
    if (role !== 'owner' && role !== 'admin') return reply.code(403).send({ error: '只有群主和管理员能改' });
    const parsed = z
      .object({
        name: z.string().min(1).max(24).optional(),
        avatar: z.string().max(300).optional(),
        announcement: z.string().max(500).optional(),
        mute_all: z.boolean().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    if (parsed.data.name !== undefined) {
      db.prepare('UPDATE groups SET name = ? WHERE id = ?').run(parsed.data.name, group.id);
    }
    if (parsed.data.mute_all !== undefined) {
      db.prepare('UPDATE groups SET mute_all = ? WHERE id = ?').run(parsed.data.mute_all ? 1 : 0, group.id);
    }
    if (parsed.data.avatar !== undefined) {
      db.prepare('UPDATE groups SET avatar = ? WHERE id = ?').run(parsed.data.avatar, group.id);
    }
    if (parsed.data.announcement !== undefined) {
      db.prepare('UPDATE groups SET announcement = ?, announcement_updated_at = ? WHERE id = ?').run(
        parsed.data.announcement,
        Date.now(),
        group.id,
      );
    }
    return { ok: true };
  });

  app.post('/api/groups/:number/kick', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    const role = groupRole(group.id, me.id);
    if (role !== 'owner' && role !== 'admin') return reply.code(403).send({ error: '只有群主和管理员能踢人' });
    const parsed = z.object({ number: numberSchema }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === group.owner_id) return reply.code(400).send({ error: '不能踢群主' });
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND account_id = ?').run(group.id, target.id);
    if (group.conversation_id) {
      db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND account_id = ?').run(
        group.conversation_id, target.id,
      );
    }
    return { ok: true };
  });

  /* ---------- 群详情与群管理 ---------- */
  app.get('/api/groups/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    const role = groupRole(group.id, me.id);
    if (!role) return reply.code(403).send({ error: '你不在这个群里' });
    const mine = db
      .prepare('SELECT nickname, mute_until, announcement_read_at FROM group_members WHERE group_id = ? AND account_id = ?')
      .get(group.id, me.id);
    const members = db
      .prepare('SELECT COUNT(*) AS c FROM group_members WHERE group_id = ?')
      .get(group.id).c;
    return {
      group: {
        number: group.number,
        name: group.name,
        owner_id: group.owner_id,
        avatar: group.avatar || '',
        announcement: group.announcement || '',
        announcement_updated_at: group.announcement_updated_at || 0,
        mute_all: !!group.mute_all,
        conversationId: group.conversation_id || null,
        role,
        members,
        my_nickname: mine.nickname || '',
        my_mute_until: mine.mute_until || 0,
        announcement_read_at: mine.announcement_read_at || 0,
      },
    };
  });

  /** 群主/管理员校验，返回 {me, group, role} 或 null */
  function groupManageContext(req, reply, opts = {}) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const group = findGroup(req.params.number);
    if (!group) {
      reply.code(404).send({ error: '没有这个群' });
      return null;
    }
    const role = groupRole(group.id, me.id);
    const allowed = opts.ownerOnly ? role === 'owner' : role === 'owner' || role === 'admin';
    if (!allowed) {
      reply.code(403).send({ error: opts.ownerOnly ? '只有群主能做这个' : '只有群主和管理员能做这个' });
      return null;
    }
    return { me, group, role };
  }

  app.post('/api/groups/:number/admin', async (req, reply) => {
    const ctx = groupManageContext(req, reply, { ownerOnly: true });
    if (!ctx) return;
    const parsed = z.object({ number: numberSchema, admin: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === ctx.group.owner_id) return reply.code(400).send({ error: '群主不用设置管理员' });
    if (!isGroupMember(ctx.group.id, target.id)) return reply.code(400).send({ error: '对方不在群里' });
    db.prepare('UPDATE group_members SET role = ? WHERE group_id = ? AND account_id = ?').run(
      parsed.data.admin ? 'admin' : 'member',
      ctx.group.id,
      target.id,
    );
    return { ok: true };
  });

  app.post('/api/groups/:number/mute', async (req, reply) => {
    const ctx = groupManageContext(req, reply);
    if (!ctx) return;
    const parsed = z
      .object({ number: numberSchema, minutes: z.number().int().min(0).max(43200) })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '禁言分钟数选 0–43200' });
    const target = findAccountByNumber(parsed.data.number);
    if (!target) return reply.code(404).send({ error: '没有这个号码' });
    if (target.id === ctx.group.owner_id) return reply.code(400).send({ error: '不能禁言群主' });
    const targetRole = groupRole(ctx.group.id, target.id);
    if (!targetRole) return reply.code(400).send({ error: '对方不在群里' });
    if (targetRole === 'admin' && ctx.role !== 'owner') {
      return reply.code(403).send({ error: '只有群主能禁言管理员' });
    }
    const until = parsed.data.minutes > 0 ? Date.now() + parsed.data.minutes * 60000 : 0;
    db.prepare('UPDATE group_members SET mute_until = ? WHERE group_id = ? AND account_id = ?').run(
      until,
      ctx.group.id,
      target.id,
    );
    return { ok: true, mute_until: until };
  });

  app.post('/api/groups/:number/mute-all', async (req, reply) => {
    const ctx = groupManageContext(req, reply);
    if (!ctx) return;
    const parsed = z.object({ muteAll: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不对' });
    db.prepare('UPDATE groups SET mute_all = ? WHERE id = ?').run(parsed.data.muteAll ? 1 : 0, ctx.group.id);
    return { ok: true, mute_all: parsed.data.muteAll };
  });

  app.patch('/api/groups/:number/me', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });
    const parsed = z.object({ nickname: z.string().max(16) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '群名片最多 16 个字' });
    db.prepare('UPDATE group_members SET nickname = ? WHERE group_id = ? AND account_id = ?').run(
      parsed.data.nickname,
      group.id,
      me.id,
    );
    return { ok: true, nickname: parsed.data.nickname };
  });

  app.post('/api/groups/:number/announcement/read', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });
    db.prepare('UPDATE group_members SET announcement_read_at = ? WHERE group_id = ? AND account_id = ?').run(
      Date.now(),
      group.id,
      me.id,
    );
    return { ok: true };
  });

  /* ---------- 群文件 ---------- */
  app.get('/api/groups/:number/files', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });
    const rows = db
      .prepare(
        `SELECT f.id, f.name, f.url, f.size, f.created_at, a.number AS uploader_number, a.nickname AS uploader_nickname
           FROM group_files f JOIN accounts a ON a.id = f.uploader_id
          WHERE f.group_id = ? ORDER BY f.id DESC LIMIT 200`,
      )
      .all(group.id);
    return { files: rows };
  });

  app.post('/api/groups/:number/files', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    if (!isGroupMember(group.id, me.id)) return reply.code(403).send({ error: '你不在这个群里' });
    const parsed = z
      .object({
        name: z.string().min(1).max(80),
        url: z.string().regex(/^\/uploads\/[A-Za-z0-9._-]+$/),
        size: z.number().int().min(0).max(50 * 1024 * 1024),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '文件信息不对' });
    const info = db
      .prepare('INSERT INTO group_files (group_id, uploader_id, name, url, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(group.id, me.id, parsed.data.name, parsed.data.url, parsed.data.size, Date.now());
    return {
      ok: true,
      file: {
        id: Number(info.lastInsertRowid),
        ...parsed.data,
        uploader_number: me.number,
        uploader_nickname: me.nickname,
        created_at: Date.now(),
      },
    };
  });

  app.delete('/api/groups/:number/files/:id', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const group = findGroup(req.params.number);
    if (!group) return reply.code(404).send({ error: '没有这个群' });
    const role = groupRole(group.id, me.id);
    if (!role) return reply.code(403).send({ error: '你不在这个群里' });
    const row = db
      .prepare('SELECT id, uploader_id FROM group_files WHERE id = ? AND group_id = ?')
      .get(Number(req.params.id), group.id);
    if (!row) return reply.code(404).send({ error: '没有这个文件' });
    if (row.uploader_id !== me.id && role !== 'owner' && role !== 'admin') {
      return reply.code(403).send({ error: '只能删自己上传的，或让群主管理员删' });
    }
    db.prepare('DELETE FROM group_files WHERE id = ?').run(row.id);
    return { ok: true };
  });

  app.get('/api/bots/:number/stats', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const bot = findAccountByNumber(req.params.number);
    if (!bot || bot.type !== 'bot' || bot.owner_id !== me.id) {
      return reply.code(404).send({ error: '没有这个 Bot' });
    }

    // 和这个 Bot 的私聊里，每个人说了多少句
    const rows = db
      .prepare(
        `SELECT a.number, a.nickname, COUNT(*) AS total
           FROM messages m
           JOIN conversations c ON c.id = m.conversation_id
           JOIN conversation_members self ON self.conversation_id = c.id AND self.account_id = ?
           JOIN accounts a ON a.id = m.sender_id
          WHERE c.kind = 'dm' AND m.sender_id != ?
          GROUP BY m.sender_id
          ORDER BY total DESC
          LIMIT 10`,
      )
      .all(bot.id, bot.id);

    const total = rows.reduce((s, r) => s + r.total, 0);
    return { ranking: rows, total };
  });

  /* ---------- Bot 账号 ---------- */
  app.post('/api/bots', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        number: numberSchema,
        nickname: z.string().trim().min(1, '名字不能为空').max(24, '名字最多 24 个字'),
        bio: z.string().max(200).optional(),
        public: z.boolean().optional(),
        tags: tagsSchema.optional(),
        password: z.string().min(8, '密码至少 8 位').max(128).optional(),
      })
      .safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    if (findAccountByNumber(parsed.data.number)) {
      return reply.code(409).send({ error: '这个号码已经被用了' });
    }

    const token = onebot.newToken();
    const info = db
      .prepare(
        `INSERT INTO accounts (number, type, nickname, bio, password_hash, created_at, owner_id, access_token, is_public, tags)
         VALUES (?, 'bot', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.data.number,
        parsed.data.nickname,
        parsed.data.bio || '',
        parsed.data.password ? hashPassword(parsed.data.password) : null,
        Date.now(),
        me.id,
        token,
        parsed.data.public === false ? 0 : 1,
        JSON.stringify(parsed.data.tags || []),
      );
    const id = Number(info.lastInsertRowid);
    db.prepare('INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)').run(
      me.id, id, Date.now(),
    );
    db.prepare('INSERT OR IGNORE INTO friendships (a_id, b_id, created_at) VALUES (?, ?, ?)').run(
      id, me.id, Date.now(),
    );

    return {
      bot: {
        id,
        number: parsed.data.number,
        nickname: parsed.data.nickname,
        token,
        public: !!parsed.data.public,
        tags: parsed.data.tags || [],
        hasPassword: Boolean(parsed.data.password),
      },
      ws: `/onebot/v11/ws`,
    };
  });

  /* ---------- Bot 广场：把别人的 Bot 挂出来 ---------- */
  /* ---------- 反向 WS：让 Bot 主动连到 AstrBot 这类框架 ---------- */

  function myBot(req, reply) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const bot = findAccountByNumber(req.params.number);
    if (!bot || bot.type !== 'bot') {
      reply.code(404).send({ error: 'Bot 不存在' });
      return null;
    }
    if (bot.owner_id !== me.id) {
      reply.code(403).send({ error: '不是你的 Bot' });
      return null;
    }
    return bot;
  }

  app.get('/api/bots/:number/link', async (req, reply) => {
    const bot = myBot(req, reply);
    if (!bot) return;
    const row = db.prepare('SELECT * FROM bot_links WHERE account_id = ?').get(bot.id);
    const st = onebot.outStatus(bot.id);
    return {
      link: {
        url: row ? row.url : '',
        token: row ? row.token : '',
        enabled: row ? !!row.enabled : false,
        connected: !!st.connected,
      },
    };
  });

  app.put('/api/bots/:number/link', async (req, reply) => {
    const bot = myBot(req, reply);
    if (!bot) return;
    const parsed = z
      .object({
        url: z.string().max(300).optional(),
        token: z.string().max(200).optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const old = db.prepare('SELECT * FROM bot_links WHERE account_id = ?').get(bot.id);
    const url = parsed.data.url !== undefined ? parsed.data.url.trim() : old ? old.url : '';
    const token = parsed.data.token !== undefined ? parsed.data.token.trim() : old ? old.token : '';
    const enabled = parsed.data.enabled !== undefined ? (parsed.data.enabled ? 1 : 0) : old ? old.enabled : 0;

    db.prepare(
      `INSERT INTO bot_links (account_id, url, token, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET url = excluded.url, token = excluded.token,
         enabled = excluded.enabled, updated_at = excluded.updated_at`,
    ).run(bot.id, url, token, enabled, Date.now());

    if (enabled && url) onebot.connectOut(bot, url, token);
    else onebot.closeOut(bot.id);

    const st = onebot.outStatus(bot.id);
    return { ok: true, link: { url, token, enabled: !!enabled, connected: !!st.connected } };
  });

  app.post('/api/bots/:number/link/reconnect', async (req, reply) => {
    const bot = myBot(req, reply);
    if (!bot) return;
    const row = db.prepare('SELECT * FROM bot_links WHERE account_id = ?').get(bot.id);
    if (!row || !row.url) return reply.code(400).send({ error: '还没填地址' });
    onebot.connectOut(bot, row.url, row.token);
    return { ok: true };
  });

  app.get('/api/astrbot/platforms', async () => {
    try {
      const { readFileSync } = await import('node:fs');
      const home = process.env.USERPROFILE || process.env.HOME || '';
      const raw = readFileSync(home + '/.astrbot/data/cmd_config.json', 'utf8');
      const cfg = JSON.parse(raw.replace(/^\uFEFF/, ''));
      const list = (cfg.platform || [])
        .filter((x) => x && x.type === 'aiocqhttp')
        .map((x) => ({ id: x.id, port: x.ws_reverse_port, token: x.ws_reverse_token || '' }));
      return { platforms: list };
    } catch {
      return { platforms: [] };
    }
  });

  // 广场：游客也能看（不登录返回空 friendSet、isMine 全 false）
  app.get('/api/bots/public', async (req, reply) => {
    const me = auth(req);
    const q = String(req.query.q || '').trim();
    const limit = Math.min(Number(req.query.limit) || 50, 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const like = `%${q}%`;

    const rows = db
      .prepare(
        `SELECT a.id, a.number, a.nickname, a.bio, a.avatar, a.tags,
                (SELECT COUNT(*) FROM friendships f WHERE f.a_id = a.id OR f.b_id = a.id) AS added
           FROM accounts a
          WHERE a.type = 'bot' AND a.is_public = 1
            AND (? = '' OR a.number LIKE ? OR a.nickname LIKE ? OR a.tags LIKE ?)
          ORDER BY a.id DESC
          LIMIT 200`,
      )
      .all(q, like, like, like);

    const friendSet = new Set(
      me
        ? db
            .prepare(
              `SELECT CASE WHEN a_id = ? THEN b_id ELSE a_id END AS other
                 FROM friendships WHERE a_id = ? OR b_id = ?`,
            )
            .all(me.id, me.id, me.id)
            .map((r) => r.other)
        : [],
    );

    const localBots = rows.map((b) => ({
      number: b.number,
      nickname: b.nickname,
      bio: b.bio,
      avatar: b.avatar || '',
      tags: parseTags(b.tags),
      online: botOnline(b.id),
      added: b.added,
      isFriend: friendSet.has(b.id),
      isMine: me ? b.id === me.id : false,
      remote: false,
      addr: '',
      instance: '',
    }));

    // 别的实例上的公开 Bot：已加的远端好友所在实例 + 局域网里发现的实例
    const addrs = [];
    for (const r of db.prepare("SELECT remote_addr FROM accounts WHERE type = 'remote'").all()) {
      const a = normalizeAddr(r.remote_addr);
      if (a && !addrs.includes(a)) addrs.push(a);
    }
    try {
      for (const inst of fed.nearby().instances || []) {
        const a = normalizeAddr(inst.addr);
        if (a && !addrs.includes(a)) addrs.push(a);
      }
    } catch {
      /* 局域网发现没起来不影响本机列表 */
    }

    // 并行探测：串行会拖到 8 秒以上，广场是首页，首屏必须快
    const probes = await Promise.all(
      addrs.slice(0, 6).map(async (addr) => {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 1200);
          const resp = await fetch(`http://${addr}/api/federation/bots`, { signal: ctl.signal });
          clearTimeout(timer);
          if (!resp.ok) return null;
          return { addr, body: await resp.json() };
        } catch {
          /* 某个实例连不上就跳过，不能让整个广场失败 */
          return null;
        }
      }),
    );

    const remoteBots = [];
    for (const probe of probes) {
      if (!probe) continue;
      const { addr, body } = probe;
      for (const b of Array.isArray(body.bots) ? body.bots : []) {
        const number = String(b.number || '');
        if (!number) continue;
        const btags = Array.isArray(b.tags) ? b.tags.map(String) : [];
        if (
          q &&
          !number.includes(q) &&
          !String(b.nickname || '').includes(q) &&
          !btags.some((t) => t.includes(q))
        ) {
          continue;
        }
        const local = findAccountByNumber(number);
        remoteBots.push({
          number,
          nickname: String(b.nickname || ''),
          bio: String(b.bio || ''),
          avatar: String(b.avatar || ''),
          tags: btags,
          online: false,
          added: local ? 1 : 0,
          isFriend: local ? friendSet.has(local.id) : false,
          isMine: false,
          remote: true,
          addr,
          instance: String(body.instanceId || addr),
        });
      }
    }

    const merged = localBots.concat(remoteBots);
    return {
      total: merged.length,
      bots: merged.slice(offset, offset + limit),
      note: remoteBots.length
        ? ''
        : '暂时没发现别的实例上的 Bot：先和对方互加好友，或两台设备连同一个 Wi-Fi',
    };
  });
  app.patch('/api/bots/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const bot = findAccountByNumber(req.params.number);
    if (!bot || bot.type !== 'bot' || bot.owner_id !== me.id) {
      return reply.code(404).send({ error: '没有这个 Bot' });
    }
    const parsed = z
      .object({
        nickname: z.string().trim().min(1).max(24).optional(),
        bio: z.string().max(200).optional(),
        public: z.boolean().optional(),
        tags: tagsSchema.optional(),
        password: z.string().min(8, '密码至少 8 位').max(128).optional(),
      })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });

    const p = parsed.data;
    db.prepare(
      `UPDATE accounts SET
         nickname = COALESCE(?, nickname),
         bio      = COALESCE(?, bio),
         is_public = COALESCE(?, is_public),
         tags     = COALESCE(?, tags),
         password_hash = COALESCE(?, password_hash)
       WHERE id = ?`,
    ).run(
      p.nickname ?? null,
      p.bio ?? null,
      p.public === undefined ? null : p.public ? 1 : 0,
      p.tags === undefined ? null : JSON.stringify(p.tags),
      p.password ? hashPassword(p.password) : null,
      bot.id,
    );

    return { ok: true, hasPassword: Boolean(p.password) || Boolean(bot.password_hash) };
  });

  /* 主人删除自己的 Bot：真删，不留数据 */
  app.delete('/api/bots/:number', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const bot = findAccountByNumber(req.params.number);
    if (!bot || bot.type !== 'bot' || bot.owner_id !== me.id) {
      return reply.code(404).send({ error: '没有这个 Bot' });
    }
    const tx = db.transaction(() => {
      db.prepare(
        'DELETE FROM message_reactions WHERE message_id IN (SELECT id FROM messages WHERE sender_id = ?)',
      ).run(bot.id);
      db.prepare(
        'DELETE FROM message_deletions WHERE message_id IN (SELECT id FROM messages WHERE sender_id = ?)',
      ).run(bot.id);
      db.prepare('DELETE FROM messages WHERE sender_id = ?').run(bot.id);
      db.prepare('DELETE FROM conversation_members WHERE account_id = ?').run(bot.id);
      db.prepare('DELETE FROM friendships WHERE a_id = ? OR b_id = ?').run(bot.id, bot.id);
      db.prepare('DELETE FROM friend_requests WHERE from_id = ? OR to_id = ?').run(bot.id, bot.id);
      db.prepare('DELETE FROM blocks WHERE a_id = ? OR b_id = ?').run(bot.id, bot.id);
      db.prepare('DELETE FROM bot_links WHERE account_id = ?').run(bot.id);
      db.prepare('DELETE FROM bot_models WHERE account_id = ?').run(bot.id);
      db.prepare('DELETE FROM sessions WHERE account_id = ?').run(bot.id);
      db.prepare('DELETE FROM accounts WHERE id = ?').run(bot.id);
    });
    tx();
    return { ok: true, number: bot.number };
  });

  app.get('/api/bots', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const rows = db
      .prepare("SELECT * FROM accounts WHERE type = 'bot' AND owner_id = ? ORDER BY id")
      .all(me.id);
    return {
      bots: rows.map((b) => ({
        id: b.id,
        number: b.number,
        nickname: b.nickname,
        bio: b.bio,
        avatar: b.avatar || '',
        tags: parseTags(b.tags),
        public: !!b.is_public,
        token: b.access_token,
        online: botOnline(b.id),
      })),
    };
  });

  /* ---------- Bot 内置模型（BYOK） ---------- */
  function ownedBotOr404(req, reply) {
    const me = requireAuth(req, reply);
    if (!me) return null;
    const bot = db
      .prepare('SELECT id, number, type, nickname, owner_id FROM accounts WHERE number = ?')
      .get(req.params.number);
    if (!bot || bot.type !== 'bot') {
      reply.code(404).send({ error: '没有这个 Bot' });
      return null;
    }
    if (bot.owner_id !== me.id) {
      reply.code(403).send({ error: '这不是你的 Bot' });
      return null;
    }
    return bot;
  }

  app.get('/api/bots/:number/model', async (req, reply) => {
    const bot = ownedBotOr404(req, reply);
    if (!bot) return;
    return { config: ai.publicConfig(bot.id) };
  });

  app.put('/api/bots/:number/model', async (req, reply) => {
    const bot = ownedBotOr404(req, reply);
    if (!bot) return;
    const parsed = z
      .object({
        base_url: z.string().max(500).optional(),
        api_key: z.string().max(500).optional(),
        model: z.string().max(120).optional(),
        persona: z.string().max(4000).optional(),
        temperature: z.number().min(0).max(2).optional(),
        enabled: z.boolean().optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    return { ok: true, config: ai.saveConfig(bot.id, parsed.data) };
  });

  app.post('/api/bots/:number/model/test', async (req, reply) => {
    const bot = ownedBotOr404(req, reply);
    if (!bot) return;
    const cfg = ai.getConfig(bot.id);
    if (!cfg || !cfg.base_url || !cfg.api_key || !cfg.model) {
      return reply.code(400).send({ error: '先把接口地址、密钥、模型名填完再测试' });
    }
    try {
      const replyText = await ai.chat({
        baseUrl: cfg.base_url,
        apiKey: cfg.api_key,
        model: cfg.model,
        temperature: Number(cfg.temperature ?? 0.8),
        messages: [
          { role: 'system', content: '只回答两个字：通了' },
          { role: 'user', content: '在吗' },
        ],
      });
      return { ok: true, reply: replyText };
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }
  });

  /* 以我的 Bot 身份开一个会话（切换账号用） */
  app.post('/api/bots/:number/session', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const bot = db
      .prepare(
        'SELECT id, number, type, nickname, bio, avatar, owner_id FROM accounts WHERE number = ?',
      )
      .get(req.params.number);
    if (!bot || bot.type !== 'bot') return reply.code(404).send({ error: '没有这个 Bot' });
    if (bot.owner_id !== me.id) return reply.code(403).send({ error: '这不是你的 Bot' });
    return {
      token: issueSession(bot.id),
      account: {
        id: bot.id,
        number: bot.number,
        nickname: bot.nickname,
        type: 'bot',
        bio: bot.bio,
        avatar: bot.avatar || '',
      },
    };
  });

  app.post('/api/bots/:number/token', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const bot = findAccountByNumber(req.params.number);
    if (!bot || bot.type !== 'bot' || bot.owner_id !== me.id) {
      return reply.code(404).send({ error: '没有这个 Bot' });
    }
    const token = onebot.newToken();
    db.prepare('UPDATE accounts SET access_token = ? WHERE id = ?').run(token, bot.id);
    return { token };
  });

  /* ---------- 通知聚合 ---------- */
  app.get('/api/notifications', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const { items, count } = notificationsFor(me);
    return { count, items };
  });

  /* ---------- 实例互联（federation）：跨实例加好友 + 直连投递 ---------- */
  // 握手/投递是别的实例直接调过来的，没有本机登录态，靠共享密钥与号码校验；
  // 用令牌桶限一下握手，避免被随便刷。
  const handshakeHits = new Map();
  function handshakeAllowed(ip) {
    const now = Date.now();
    const item = handshakeHits.get(ip) || { n: 0, at: now };
    if (now - item.at > 60_000) {
      item.n = 0;
      item.at = now;
    }
    item.n++;
    handshakeHits.set(ip, item);
    return item.n <= 30;
  }

  app.get('/api/federation/info', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const info = fed.info(HOST === '0.0.0.0' || HOST === '::');
    return {
      ...info,
      relay: relay.status(),
      publicV6Urls: publicV6Candidates().map((item) => 'http://[' + item.address + ']:' + PORT),
    };
  });

  /** 生成邀请码：一段可以直接发微信/短信给朋友的文本，对方粘进「加好友 → 不同网络」就能连上 */
  app.get('/api/federation/invite', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const invite = fed.makeInvite(me);
    if (!invite) {
      return reply.code(409).send({
        error: '这台电脑还没有可以被外部连上的地址：需要公网 IPv6（家用宽带/手机流量大多有），或在设置里填好公网地址或 DDNS',
      });
    }
    return { ok: true, ...invite, publicV6: fed.v6Addresses(), boundToLan: HOST === '0.0.0.0' || HOST === '::' };
  });

  /** 接受邀请码：解析出对方的地址和号码，挨个地址试，谁通用谁 */
  app.post('/api/federation/invite/accept', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ code: z.string().min(8).max(4000) }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: '邀请码不能为空' });
    const invite = parseInvite(parsed.data.code);
    if (invite.error) return reply.code(400).send({ error: invite.error });
    if (invite.number === me.number) return reply.code(400).send({ error: '这是你自己的邀请码' });
    const opts = { instanceId: invite.instanceId || '' };
    /* 邀请码里带了中继地址：先把自己挂到中继上，再发握手。
       原因是「对方回执打回我的地址」这条路在手机/内网里基本不通（NAT、防火墙都拦入站），
       我先连上中继，对方连不上我时就能把回执丢进中继，我拉一下就到了。
       用户自己的中继优先级更高，已经配了就不动。 */
    let relayAuto = false;
    if (invite.relay && invite.instanceId && !relay.enabled()) {
      relay.setUrl(invite.relay);
      relay.setPublicUrl(invite.relay);
      relay.start();
      const reg = await relay.register();
      if (reg.ok) {
        relayAuto = true;
        log.info('[relay] 已按邀请码自动接入中继 ' + invite.relay);
      } else {
        log.warn('[relay] 用邀请码里的中继地址注册失败：' + (reg.error || ''));
      }
    }
    let last = null;
    for (const addr of invite.addrs) {
      const out = await fed.lookup(me, addr, invite.number);
      if (out.account) {
        // 一步到位：解析出账号就顺手把好友申请发过去，用户不用再点第二次
        const reqOut = await fed.sendRequest(me, addr, invite.number, '通过邀请码添加', opts);
        return {
          ...out,
          addr,
          tried: invite.addrs.length,
          requested: !reqOut.error,
          requestError: reqOut.error || '',
          friend: !!reqOut.friend,
          via: reqOut.via || 'direct',
          queued: !!reqOut.queued,
          relayAuto,
        };
      }
      last = out;
    }
    /* 一个地址都连不上（或者邀请码里压根没有地址，只有中继）：
       邀请码里带了中继地址就自动配上（用户不用自己去设置里抄一遍），再把申请排进中继队列。 */
    if (invite.instanceId && relay.enabled()) {
      const reqOut = await fed.sendRequest(me, '', invite.number, '通过邀请码添加', opts);
      if (!reqOut.error) {
        return {
          account: null,
          addr: '',
          tried: invite.addrs.length,
          requested: true,
          requestError: '',
          friend: !!reqOut.friend,
          via: 'relay',
          queued: true,
          relayAuto,
        };
      }
      return reply.code(reqOut.code || 502).send({ error: reqOut.error });
    }
    return reply.code(last?.code || 404).send({
      error:
        (last?.error || '连不上对方的实例') +
        '（试了 ' + invite.addrs.length + ' 个地址都不通：对方可能没有公网 IPv6，或者光猫/路由器把入站拦了）',
    });
  });

  app.patch('/api/federation/settings', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const body = req.body || {};
    let autoAccept = fed.autoAccept();
    if (body.autoAccept !== undefined) autoAccept = fed.setAutoAccept(!!body.autoAccept);
    if (body.publicAddr !== undefined) {
      const raw = String(body.publicAddr ?? '').trim();
      if (raw && !normalizeAddr(raw)) return reply.code(400).send({ error: '地址格式不对，示例：1.2.3.4:7788' });
      return { ok: true, publicAddr: fed.setPublicAddr(raw), autoAccept };
    }
    return { ok: true, publicAddr: fed.publicAddr(), autoAccept };
  });

  /* 登录页用：这台机器所在局域网里有哪些服务器可以连（不需要登录）。
     只回地址和版本，不暴露任何账号信息——目的就是让手机端不用手打 IP。 */
  app.get('/api/discover/lan', async () => {
    try {
      const list = (fed.nearby().instances || []).map((x) => ({
        addr: x.addr,
        version: x.version || '',
        lastSeen: x.lastSeen || 0,
        people: (x.numbers || []).length,
      }));
      return { instances: list };
    } catch {
      return { instances: [] };
    }
  });

  app.get('/api/federation/nearby', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    return fed.nearby();
  });

  app.post('/api/federation/lookup', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({ addr: z.string().max(200).optional(), number: numberSchema })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const out = await fed.lookup(me, parsed.data.addr || '', parsed.data.number);
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    return out;
  });

  app.post('/api/federation/request', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z
      .object({
        addr: z.string().max(200).optional(),
        instanceId: z.string().max(64).optional(),
        number: numberSchema,
        message: z.string().max(120).optional(),
      })
      .safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const addr = String(parsed.data.addr || '').trim();
    const instanceId = String(parsed.data.instanceId || '').trim();
    if (!addr && !instanceId) {
      return reply.code(400).send({ error: '跨实例加好友要填对方的实例地址' });
    }
    const out = await fed.sendRequest(me, addr, parsed.data.number, parsed.data.message, { instanceId });
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    return out;
  });

  /** 中继状态：设置页要看「连没连上中继、积压多少条」 */
  app.get('/api/relay/status', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    return { ok: true, ...relay.status() };
  });

  /** 设置中继地址：传空字符串就是关掉中继（回到纯直连） */
  app.patch('/api/relay/settings', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ url: z.string().max(300).optional() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.issues[0].message });
    const raw = String(parsed.data.url ?? '').trim();
    if (raw && !normalizeRelayUrl(raw)) {
      return reply.code(400).send({ error: '中继地址格式不对，示例：https://relay.example.com:7800' });
    }
    const next = relay.setUrl(raw);
    if (!next) {
      relay.stop();
      return { ok: true, ...relay.status(), registerError: '' };
    }
    relay.start();
    const reg = await relay.register();
    return { ok: true, ...relay.status(), registerError: reg.ok ? '' : reg.error || '' };
  });

  /** 本机当中转站：状态（开没开、当前公网地址、cloudflared 是否就绪） */
  app.get('/api/relay/host', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    return { ok: true, ...relayHost.status() };
  });

  /**
   * 开/关「本机当中转站」。
   * 第一次开启会下载 cloudflared（约 55MB，只需一次），再起隧道，可能要十几秒；
   * 开启成功后把本机中继填成自己的中继地址（用户还没配过中继时），本机顺带也有了兜底能力。
   */
  app.post('/api/relay/host', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const parsed = z.object({ enabled: z.boolean() }).safeParse(req.body || {});
    if (!parsed.success) return reply.code(400).send({ error: 'enabled 必须是 true 或 false' });
    const st = await relayHost.setEnabled(parsed.data.enabled);
    if (parsed.data.enabled && !relay.status().url) {
      relay.setUrl(st.localUrl);
      relay.start();
      relay.register().catch(() => {});
    }
    return { ok: true, ...st };
  });

  /* ----- 下面几个是「别的实例调过来」的接口 ----- */

  app.get('/api/federation/directory', async () => fed.directory());

  /** 别的实例来拉本机的公开 Bot（跨实例 Bot 广场用，契约要和手机端一致） */
  app.get('/api/federation/bots', async () => {
    const rows = db
      .prepare(
        "SELECT number, nickname, bio, avatar, tags FROM accounts WHERE type = 'bot' AND is_public = 1 ORDER BY id DESC LIMIT 200",
      )
      .all();
    return {
      instanceId: fed.instanceId(),
      version: VERSION,
      bots: rows.map((b) => ({
        number: b.number,
        nickname: b.nickname || '',
        bio: b.bio || '',
        avatar: b.avatar || '',
        tags: parseTags(b.tags),
        type: 'bot',
      })),
    };
  });

  app.get('/api/federation/profile', async (req, reply) => {
    const number = String((req.query || {}).number || '');
    if (!NUMBER_RE.test(number)) return reply.code(400).send({ error: '号码格式不对' });
    const acc = db
      .prepare(
        "SELECT number, nickname, avatar, bio, type FROM accounts WHERE number = ? AND (type = 'user' OR (type = 'bot' AND is_public = 1))",
      )
      .get(number);
    if (!acc) return reply.code(404).send({ error: '对方没有这个号码' });
    return { account: { ...acc, remote: false, addr: '' }, instanceId: fed.instanceId(), version: VERSION };
  });

  app.post('/api/federation/handshake', async (req, reply) => {
    if (!handshakeAllowed(String(req.ip || 'unknown'))) {
      return reply.code(429).send({ error: '太频繁了' });
    }
    const out = await fed.handleHandshake(req.body || {}, String(req.ip || ''));
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    return out;
  });

  app.post('/api/federation/accept', async (req, reply) => {
    const out = fed.handleAccept(req.body || {}, String(req.ip || ''));
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    return out;
  });

  app.post('/api/federation/deliver', async (req, reply) => {
    const out = fed.handleDeliver(req.headers || {}, req.body || {});
    if (out.error) return reply.code(out.code || 400).send({ error: out.error });
    return out;
  });

  /* ---------- 服务器信息（手机端扫码连电脑用） ---------- */
  app.get('/api/server-info', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    // 虚拟网卡（WSL/Hyper-V/VirtualBox/VMware/回环）手机根本连不到，
    // 以前按枚举顺序排在前面，用户点第一个必然打不开。
    const candidates = lanCandidates();
    const lanUrls = candidates.map((item) => `http://${item.address}:${PORT}`);
    const lanNames = candidates.map((item) => item.name);
    /* 隧道地址由 .tools/tunnel.mjs 写入 data/tunnel.json，没有就是空串 */
    let tunnel = '';
    try {
      const file = join(DATA_DIR, 'tunnel.json');
      if (existsSync(file)) tunnel = JSON.parse(readFileSync(file, 'utf8')).url || '';
    } catch {
      /* 隧道信息坏了不影响主流程 */
    }
    return {
      version: VERSION,
      port: PORT,
      host: HOST,
      boundToLan: HOST === '0.0.0.0' || HOST === '::',
      lan: candidates.map((item, i) => ({ name: item.name, url: lanUrls[i] })),
      lanUrls,
      lanNames,
      tunnel,
      webReady: existsSync(WEB_DIR),
      donationLink: getSetting('donationLink', ''),
      donationImage: getSetting('donationImage', ''),
      donationImages: donationImages(),
    };
  });

  /* ---------- 上传（图片/文件/语音统一走这里，不再把大图塞进消息体） ---------- */
  app.post('/api/upload', async (req, reply) => {
    const me = requireAuth(req, reply);
    if (!me) return;
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      return reply.code(400).send({ error: '没有收到文件内容' });
    }
    if (body.length > 25 * 1024 * 1024) return reply.code(413).send({ error: '文件最大 25MB' });
    const rawName = String(req.query?.name || '').trim();
    const baseName = rawName ? rawName.split(/[\\/]/).pop().slice(0, 80) : '文件';
    // UPLOAD_MIME 的键是带点的（'.png'），这里统一保留点，别再 slice 掉
    let ext = extname(baseName).toLowerCase();
    if (!UPLOAD_MIME[ext]) ext = '.bin';
    const filename = `${Date.now()}-${randomBytes(8).toString('hex')}${ext}`;
    writeFileSync(join(UPLOAD_DIR, filename), body);
    return {
      ok: true,
      url: `/uploads/${filename}`,
      name: baseName,
      size: body.length,
      mime: UPLOAD_MIME[ext] || 'application/octet-stream',
    };
  });

  /* ---------- 上传文件静态服务 ---------- */
  app.get('/uploads/*', async (req, reply) => {
    let rel = '';
    try {
      rel = decodeURIComponent(String(req.params['*'] || ''));
    } catch {
      return reply.code(400).send({ error: '文件名不对' });
    }
    const base = rel.split(/[\\/]/).pop();
    if (!base || base.startsWith('.')) return reply.code(404).send({ error: '没有这个文件' });
    const file = join(UPLOAD_DIR, base);
    if (!existsSync(file) || statSync(file).isDirectory()) {
      return reply.code(404).send({ error: '没有这个文件' });
    }
    return reply
      .type(UPLOAD_MIME[extname(base).toLowerCase()] || 'application/octet-stream')
      .header('Cache-Control', 'public, max-age=86400')
      .send(createReadStream(file));
  });

  /* ---------- 静态前端（打包后由服务端直接托管，桌面端就能用 http://127.0.0.1 打开） ---------- */
  if (existsSync(WEB_DIR)) {
    app.get('/*', async (req, reply) => {
      const url = req.raw.url.split('?')[0];
      if (url.startsWith('/api/') || url.startsWith('/onebot/')) {
        return reply.code(404).send({ error: '没有这个接口' });
      }
      const rel = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '');
      let file = join(WEB_DIR, rel);
      if (!file.startsWith(WEB_DIR)) return reply.code(403).send({ error: '不许出去' });
      if (!existsSync(file) || statSync(file).isDirectory()) file = join(WEB_DIR, 'index.html');
      return reply.type(MIME[extname(file).toLowerCase()] || 'application/octet-stream').send(createReadStream(file));
    });
  }

  /* ---------- 定时清理：注销到期 + 数据保留期 ---------- */
  function sweepOnce() {
    const now = Date.now();
    /* 1. 注销冷静期到了就真删 */
    try {
      const due = db.prepare('SELECT id FROM accounts WHERE deleted_at > 0 AND deleted_at <= ?').all(now);
      for (const row of due) {
        try {
          hardDeleteAccount(row.id);
          app.log2?.info('[sweep] 注销到期，已删除账号', row.id);
        } catch (err) {
          app.log2?.warn('[sweep] 删除账号失败', row.id, err && err.message);
        }
      }
    } catch {
      /* 数据库暂时不可用，下一轮再来 */
    }

    /* 2. 数据保留：超过 N 天的消息和没人引用的上传文件一起清掉 */
    const days = retentionDays();
    if (days <= 0) return;
    const before = now - days * 86400000;
    try {
      const info = db.prepare('DELETE FROM messages WHERE created_at < ?').run(before);
      if (Number(info.changes) > 0) app.log2?.info('[sweep] 清理过期消息', info.changes, '条（保留', days, '天）');
    } catch {
      /* 同上 */
    }
    try {
      for (const name of readdirSync(UPLOAD_DIR)) {
        const full = join(UPLOAD_DIR, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (!st.isFile()) continue;
        if (st.mtimeMs >= before) continue;
        /* 还被消息引用着就不动（历史消息里可能是 /uploads/xxx 链接） */
        const used = db.prepare('SELECT 1 FROM messages WHERE body LIKE ? LIMIT 1').get('%' + name + '%');
        if (used) continue;
        try {
          rmSync(full, { force: true });
        } catch {
          /* 文件被占用，下一轮再说 */
        }
      }
    } catch {
      /* 上传目录读不到就算了 */
    }
  }

  /* 每小时扫一次；unref 让进程该退出时能退出 */
  const sweepTimer = setInterval(sweepOnce, 60 * 60 * 1000);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
  app.decorate('sweepOnce', sweepOnce);

  return app;
}

// 直接运行：node server/index.js
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const bootLog = createLogger({ level: process.env.FE_LOG_LEVEL || 'info', name: 'boot', echo: true });
  const app = buildServer({ log: bootLog });
  const log = app.log2 || bootLog;

  // 兜底：别让一个漏掉的异常把整个服务带走，先写进日志
  process.on('uncaughtException', (err) => {
    log.error('[process] uncaughtException', (err && err.stack) || err);
  });
  process.on('unhandledRejection', (reason) => {
    log.error('[process] unhandledRejection', (reason && reason.stack) || reason);
  });
  process.on('warning', (warning) => {
    if (warning && warning.name === 'ExperimentalWarning') return;
    log.warn('[process] warning', warning && warning.message);
  });

  log.info('[boot] Furry Everpony 服务端启动，版本', VERSION);
  log.info('[boot] 监听', HOST + ':' + PORT, '上传目录', app.uploadDir || '');
  log.info('[boot] 日志文件', log.file ? log.file() : '(未启用)');

  // 0.0.0.0 只能收 IPv4；换 :: 才是双栈（IPv4 仍可访问，同时收 IPv6）。跨网络加好友靠的就是这条。
  const listenHost = HOST === '0.0.0.0' ? '::' : HOST;
  app
    .listen({ port: PORT, host: listenHost })
    .then(() => {
      log.info('[boot] 已就绪 http://' + HOST + ':' + PORT);
      // 反向连接由 buildServer 里的 onListen 钩子统一恢复，这里不再重复调用
    })
    .catch((err) => {
      log.error('[boot] 启动失败', (err && err.stack) || err);
      process.exit(1);
    });
}
