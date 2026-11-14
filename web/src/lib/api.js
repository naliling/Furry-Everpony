export const TOKEN_KEY = 'fe_token';
export const ACCOUNTS_KEY = 'fe_accounts';

/* ---------- 网络 ---------- */
/* ---------- 网络健康：全站统一的断线提示 ---------- */
/* 只有「真的连不上」才提示：fetch 抛错、超时、5xx；4xx 是业务错误，不弹断线条 */
const netSubs = new Set();
let netState = { offline: false, recovering: false, reason: '', at: 0 };
let netRecoverTimer = null;

function emitNet() {
  netSubs.forEach((fn) => {
    try { fn(netState); } catch { /* 订阅方自己的锅，不牵连别人 */ }
  });
}

/** 订阅网络状态，返回取消订阅函数；订阅时立刻回调一次当前状态 */
export function subscribeNet(fn) {
  netSubs.add(fn);
  try { fn(netState); } catch { /* 忽略 */ }
  return () => netSubs.delete(fn);
}

export function netIsOffline() {
  return !!netState.offline;
}

function netFail(reason) {
  if (netRecoverTimer) { window.clearTimeout(netRecoverTimer); netRecoverTimer = null; }
  if (netState.offline && netState.reason === reason) return;
  netState = { offline: true, recovering: false, reason: reason || '网络连接失败', at: Date.now() };
  emitNet();
}

function netOk() {
  if (!netState.offline) return;
  /* 恢复后先显示 2 秒「已恢复」，再自动收起，给用户一个明确反馈 */
  netState = { offline: false, recovering: true, reason: '', at: Date.now() };
  emitNet();
  if (netRecoverTimer) window.clearTimeout(netRecoverTimer);
  netRecoverTimer = window.setTimeout(() => {
    netRecoverTimer = null;
    if (!netState.offline) {
      netState = { offline: false, recovering: false, reason: '', at: Date.now() };
      emitNet();
    }
  }, 2000);
}

/* ---------- 网络 ---------- */
export async function api(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) {
    payload = body;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload });
  } catch {
    netFail('连不上服务器，正在重试');
    throw new Error('网络连接失败，请稍后重试');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status >= 500) netFail(data.error || `服务器开小差（${res.status}）`);
    else netOk();
    throw new Error(data.error || `请求失败（${res.status}）`);
  }
  netOk();
  return data;
}

/* 上传原始二进制，返回 { ok, url, name, size, mime } */
export async function uploadFile(file, token, { timeout = 60000 } = {}) {
  const name = file.name || `file-${Date.now()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(`/api/upload?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: file,
      signal: ctrl.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `上传失败（${res.status}）`);
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- 本地存储 ---------- */
export function storageGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式忽略 */
  }
}

export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* 忽略 */
  }
}

export function loadAccounts() {
  const list = storageGet(ACCOUNTS_KEY, []);
  return Array.isArray(list) ? list : [];
}

export function rememberAccount(acc, token) {
  const list = loadAccounts().filter((a) => a.number !== acc.number);
  list.unshift({ number: acc.number, nickname: acc.nickname, type: acc.type || 'user', token });
  storageSet(ACCOUNTS_KEY, list);
  return list;
}

export function forgetAccount(number) {
  const list = loadAccounts().filter((a) => a.number !== number);
  storageSet(ACCOUNTS_KEY, list);
  return list;
}

/* ---------- 草稿 ---------- */
export const DRAFT_PREFIX = 'fe_draft_';
export function getDraft(convId) {
  if (!convId) return '';
  try {
    return localStorage.getItem(DRAFT_PREFIX + convId) || '';
  } catch {
    return '';
  }
}
export function setDraft(convId, text) {
  if (!convId) return;
  try {
    if (text) localStorage.setItem(DRAFT_PREFIX + convId, text);
    else localStorage.removeItem(DRAFT_PREFIX + convId);
  } catch {
    /* 忽略 */
  }
}

/* ---------- 表情 ---------- */
export const EMOJI_GROUPS = [
  {
    name: '常用',
    list: ['😀', '😄', '😁', '😂', '🤣', '😊', '😍', '😘', '😜', '🤔', '😐', '😴', '😭', '😡', '🥺', '😎', '🤗', '🙃', '😅', '😳'],
  },
  {
    name: '手势',
    list: ['👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '👌', '🤞', '👋', '🙌', '👐', '🫶', '🤙', '👀', '💅'],
  },
  {
    name: '心情',
    list: ['❤️', '🧡', '💛', '💚', '💙', '💜', '🔥', '✨', '🌙', '⭐', '🎉', '🎊', '💯', '💤', '💥', '🌈'],
  },
  {
    name: '萌物',
    list: ['🐱', '🐶', '🦊', '🐰', '🐼', '🦄', '🐧', '🐸', '🐢', '🦋', '🌸', '🍀', '🌙', '☀️', '☁️', '🍎'],
  },
];

export const ALL_EMOJIS = EMOJI_GROUPS.flatMap((g) => g.list);
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🎉'];
export const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🎉', '🔥', '👀', '💯', '🙏', '👏', '✨'];

export const RECENT_EMOJI_KEY = 'fe_emoji_recent';
export const FAV_EMOJI_KEY = 'fe_emoji_fav';
export function pushRecentEmoji(emoji) {
  const list = storageGet(RECENT_EMOJI_KEY, []).filter((e) => e !== emoji);
  list.unshift(emoji);
  storageSet(RECENT_EMOJI_KEY, list.slice(0, 24));
}
export function toggleFavEmoji(emoji) {
  const list = storageGet(FAV_EMOJI_KEY, []);
  const next = list.includes(emoji) ? list.filter((e) => e !== emoji) : [...list, emoji];
  storageSet(FAV_EMOJI_KEY, next);
  return next;
}

/* ---------- 本地偏好 ---------- */
export const SEND_MODE_KEY = 'fe_send_mode'; // enter | ctrl
export const NOTIFY_KEY = 'fe_notify';
export const NOTIFY_PREVIEW_KEY = 'fe_notify_preview';

/* 把用户选的图片压成 data URL（头像 / 预览都够用） */
export function shrinkImage(file, max = 1280, type = 'image/png', quality = 0.92) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('读不了这个文件'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('这不是一张能打开的图片'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL(type, quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
/* ---------- 兼容旧/新路径的领域封装 ---------- */
/* 收藏：当前服务端是 /api/messages/:id/favorite，文档写作 /api/favorites/:id，两边都试 */
export async function toggleFavorite(messageId, on, token) {
  try {
    return await api(`/api/messages/${messageId}/favorite`, { method: on ? 'POST' : 'DELETE', token });
  } catch (err) {
    if (!/404|请求失败/.test(err.message)) throw err;
    return api(`/api/favorites/${messageId}`, { method: on ? 'POST' : 'DELETE', token });
  }
}

export function normalizeFavorites(data) {
  const list = Array.isArray(data?.favorites) ? data.favorites : [];
  return list.map((f) => ({
    ...f,
    favorited_at: f.favorited_at || f.saved_at || 0,
    message: f.message || f,
  }));
}

export function normalizeNotifications(data) {
  const raw = data?.items || data?.notifications?.items || (Array.isArray(data?.notifications) ? data.notifications : []) || [];
  const items = raw.map((item, index) => ({
    ...item,
    key: item.requestId ? item.type + '-' + item.requestId : item.type + '-' + (item.group?.number || '') + '-' + (item.created_at || index),
  }));
  return { count: data?.count ?? items.length, items };
}

export function normalizeServerInfo(data) {
  return {
    ...data,
    lan: data?.lan || data?.lanUrls || [],
    boundToLan: !!data?.boundToLan,
  };
}

/* 后端返回的消息预览字段名不完全统一，统一取可读文本 */
export function messagePreviewText(last) {
  if (!last) return '';
  if (last.preview) return last.preview;
  if (last.recalled) return '[已撤回]';
  const kind = last.kind;
  if (kind === 'image') return '[图片]';
  if (kind === 'voice') return '[语音]';
  if (kind === 'file') return '[文件]' + (last.meta?.name ? ' ' + last.meta.name : '');
  if (kind === 'merge' || kind === 'forward') return '[聊天记录]';
  return last.body || '';
}

/* window.fe 桌面通知钩子：网页端静默降级 */
export function desktopNotify({ title, body, conversationId }) {
  try {
    const fe = typeof window !== 'undefined' ? window.fe : null;
    if (fe && typeof fe.notify === 'function') fe.notify({ title, body, conversationId });
    else if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      const n = new Notification(title, { body, silent: true });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    }
  } catch {
    /* 通知失败不影响主流程 */
  }
}

export function desktopBadge(n) {
  try {
    if (window.fe && typeof window.fe.setBadge === 'function') window.fe.setBadge(n);
  } catch {
    /* 忽略 */
  }
}

export function requestNotifyPermission() {
  try {
    const fe = typeof window !== 'undefined' ? window.fe : null;
    if (fe && typeof fe.notify === 'function') return Promise.resolve('granted');
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') return Notification.requestPermission();
  } catch {
    /* 忽略 */
  }
  return Promise.resolve('unsupported');
}

export function mediaUrl(body) {
  if (!body) return '';
  if (body.startsWith('data:') || body.startsWith('blob:')) return body;
  if (body.startsWith('/uploads/')) return body;
  return '';
}

/* ---------- 实例互联：跨实例找人 / 加好友 ---------- */
export function federationInfo(token) {
  return api('/api/federation/info', { token });
}
export function federationNearby(token) {
  return api('/api/federation/nearby', { token });
}
export function federationLookup(addr, number, token) {
  return api('/api/federation/lookup', { method: 'POST', token, body: { addr: addr || '', number } });
}
export function federationRequest(addr, number, message, token) {
  return api('/api/federation/request', { method: 'POST', token, body: { addr, number, message: message || '' } });
}
export function savePublicAddr(publicAddr, token) {
  return api('/api/federation/settings', { method: 'PATCH', token, body: { publicAddr } });
}
/* 邀请码：不同网络（甚至不同城市）加好友用，不需要任何中转服务器 */
export function federationInvite(token) {
  return api('/api/federation/invite', { token });
}
export function federationInviteAccept(code, token) {
  return api('/api/federation/invite/accept', { method: 'POST', token, body: { code } });
}

/* 手机端：把登录态同步给本机服务端，杀后台重开后由服务端带回登录
   桌面端没有这个接口，失败静默忽略，不影响任何流程 */
export function syncNativeToken(token) {
  try {
    fetch('/api/native/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token || '' }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* 忽略 */
  }
}
