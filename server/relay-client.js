import { randomBytes } from 'node:crypto';

/**
 * 中继客户端：装在每个实例里，主动去连中继服务器（出站，不需要任何入站端口）。
 *
 * 它负责三件事：
 *   1. 登记自己（instanceId + 本机生成的密钥），定期心跳，让中继知道这个实例还活着
 *   2. 发不出去的投递丢给中继排队（好友申请、好友回执、私聊消息）
 *   3. 定期拉取别人留给我的事件，交给联邦层处理，处理完回执删除
 *
 * 不配中继地址时这一层完全不工作，行为和以前一模一样（局域网直连照样能用）。
 */

const DEFAULT_PULL_MS = 8000;
const HEARTBEAT_MS = 60_000;

/** 把 "1.2.3.4:7800" / "relay.example.com" / "https://relay.example.com/" 统一成不带尾斜杠的 URL */
export function normalizeRelayUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname) return '';
    const path = u.pathname.replace(/\/+$/, '');
    return u.protocol + '//' + u.host + path;
  } catch {
    return '';
  }
}

export function createRelayClient({ db, log, fed, version = '' }) {
  const pullMs = Math.max(200, Number(process.env.FE_RELAY_PULL_MS || DEFAULT_PULL_MS));
  let pullTimer = null;
  let beatTimer = null;
  let running = false;
  let busy = false;
  let registered = false;
  let lastError = '';
  let lastOkAt = 0;
  let cursor = 0;

  function meta(key) {
    const row = db.prepare('SELECT value FROM instance_meta WHERE key = ?').get(key);
    return row ? row.value : '';
  }

  function setMeta(key, value) {
    db.prepare(
      'INSERT INTO instance_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, String(value ?? ''));
  }

  /* 对外地址：本机开了「中转站」时，别人能连到的是隧道地址而不是 127.0.0.1 */
  let publicUrl = '';

  function setPublicUrl(raw) {
    publicUrl = normalizeRelayUrl(raw) || '';
    return publicUrl;
  }

  function inviteAddr() {
    return publicUrl || url();
  }

  function url() {
    return normalizeRelayUrl(meta('relay_url'));
  }

  function secret() {
    let s = meta('relay_secret');
    if (!s) {
      s = randomBytes(24).toString('hex');
      setMeta('relay_secret', s);
    }
    return s;
  }

  function enabled() {
    return !!url();
  }

  function loadCursor() {
    cursor = Number(meta('relay_cursor')) || 0;
    return cursor;
  }

  function setUrl(raw) {
    const clean = normalizeRelayUrl(raw);
    const prev = url();
    setMeta('relay_url', clean);
    if (clean !== prev) {
      /* 换了一台中继，队列 id 体系不同，游标必须归零，否则会漏掉新中继上的积压 */
      cursor = 0;
      setMeta('relay_cursor', 0);
      registered = false;
      lastError = '';
    }
    return clean;
  }

  async function call(path, { method = 'GET', body, timeout = 8000 } = {}) {
    const base = url();
    if (!base) return { ok: false, status: 0, error: '没配中继地址' };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      const res = await fetch(base + path, {
        method,
        headers: { 'content-type': 'application/json' },
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
      if (!res.ok) {
        return { ok: false, status: res.status, error: json?.error || '中继返回 ' + res.status };
      }
      lastOkAt = Date.now();
      lastError = '';
      return { ok: true, status: res.status, body: json };
    } catch (err) {
      const msg = err?.name === 'AbortError' ? '中继超时' : err?.message || '连不上中继';
      lastError = msg;
      return { ok: false, status: 0, error: msg };
    } finally {
      clearTimeout(timer);
    }
  }

  async function register() {
    if (!enabled()) return { ok: false, error: '没配中继地址' };
    const out = await call('/api/relay/register', {
      method: 'POST',
      body: {
        instanceId: fed.instanceId(),
        secret: secret(),
        addr: fed.publicAddr() || fed.myAddresses()[0] || '',
        version,
      },
    });
    if (out.ok) {
      registered = true;
      log?.info?.('[relay] 已登记到 ' + url() + '（排队中 ' + (out.body?.queued ?? 0) + ' 条）');
    } else {
      registered = false;
      log?.warn?.('[relay] 登记失败：' + (out.error || ''));
    }
    return out;
  }

  async function heartbeat() {
    if (!enabled()) return { ok: false };
    const out = await call('/api/relay/heartbeat', {
      method: 'POST',
      body: { instanceId: fed.instanceId(), secret: secret() },
    });
    if (!out.ok && (out.status === 404 || out.status === 403)) {
      registered = false;
      /* 中继那边丢了登记（换库/清库），重新登记一次 */
      await register();
    }
    return out;
  }

  /** 把一件事交给中继排队，返回 { ok, queued, online } */
  async function send(toInstance, kind, payload) {
    if (!enabled()) return { ok: false, error: '没配中继地址' };
    if (!toInstance) return { ok: false, error: '不知道对方实例 ID' };
    if (!registered) await register();
    const out = await call('/api/relay/send', {
      method: 'POST',
      body: { from: fed.instanceId(), secret: secret(), to: toInstance, kind, payload },
    });
    if (!out.ok) {
      if (out.status === 404) return { ok: false, error: '对方的实例还没连上中继' };
      return { ok: false, error: out.error || '中继投递失败' };
    }
    return { ok: true, id: out.body?.id, online: !!out.body?.online };
  }

  /** 拉一轮：按 id 升序处理，处理成功才回执并推进游标，失败留到下一轮重试 */
  async function pullOnce() {
    if (!enabled() || busy) return { ok: false, events: 0 };
    busy = true;
    try {
      if (!registered) {
        const reg = await register();
        if (!reg.ok) return { ok: false, events: 0, error: reg.error };
      }
      if (!cursor) loadCursor();
      const qs =
        '?instanceId=' + encodeURIComponent(fed.instanceId()) +
        '&secret=' + encodeURIComponent(secret()) +
        '&since=' + cursor +
        '&limit=50';
      const out = await call('/api/relay/pull' + qs, { method: 'GET' });
      if (!out.ok) {
        if (out.status === 404 || out.status === 403) registered = false;
        return { ok: false, events: 0, error: out.error };
      }
      const events = out.body?.events || [];
      if (!events.length) return { ok: true, events: 0 };
      const handled = [];
      for (const ev of events) {
        let result = null;
        try {
          result = await fed.handleRelayEvent(ev.kind, ev.payload, ev.from);
        } catch (err) {
          result = { error: err?.message || '处理失败' };
        }
        if (result && result.error) {
          lastError = '处理中继事件失败：' + result.error;
          log?.warn?.('[relay] ' + ev.kind + ' 处理失败，留到下一轮：' + result.error);
          break;
        }
        handled.push(ev.id);
      }
      if (handled.length) {
        await call('/api/relay/ack', {
          method: 'POST',
          body: { instanceId: fed.instanceId(), secret: secret(), ids: handled },
        });
        cursor = handled[handled.length - 1];
        setMeta('relay_cursor', cursor);
        log?.info?.('[relay] 收到 ' + handled.length + ' 条离线事件');
      }
      return { ok: true, events: handled.length, more: !!out.body?.more };
    } finally {
      busy = false;
    }
  }

  function start() {
    /* 可能先启动（没配中继）、之后在设置里填地址，所以这里判断的是「定时器是否已在跑」 */
    if (pullTimer || beatTimer) return;
    if (!enabled()) {
      log?.info?.('[relay] 没配中继地址，只走局域网直连');
      return;
    }
    running = true;
    loadCursor();
    register().catch(() => {});
    pullOnce().catch(() => {});
    pullTimer = setInterval(() => {
      pullOnce().catch((err) => log?.warn?.('[relay] 拉取失败：' + err.message));
    }, pullMs);
    beatTimer = setInterval(() => {
      heartbeat().catch(() => {});
    }, HEARTBEAT_MS);
    pullTimer.unref?.();
    beatTimer.unref?.();
  }

  function stop() {
    running = false;
    if (pullTimer) clearInterval(pullTimer);
    if (beatTimer) clearInterval(beatTimer);
    pullTimer = null;
    beatTimer = null;
  }

  function status() {
    return {
      running,
      enabled: enabled(),
      url: url(),
      instanceId: fed.instanceId(),
      registered,
      lastOkAt,
      lastError,
      cursor,
      pullMs,
    };
  }

  return { url, setUrl, enabled, secret, register, heartbeat, send, pullOnce, start, stop, status, setPublicUrl, inviteAddr };
}
