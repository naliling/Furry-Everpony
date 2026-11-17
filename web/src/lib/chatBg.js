import { shrinkImage } from './api.js';

/**
 * 聊天背景的共享数据层。
 * 设置页和聊天页的「聊天背景」面板都走这里，localStorage 只有一份 fe_chat_bg。
 * 存的结构：{ list: [dataURL...], current: number }，current=-1 表示用主题默认背景。
 */
export const CHAT_BG_KEY = 'fe_chat_bg';
export const CHAT_BG_EVENT = 'fe:chatbg';
export const CHAT_BG_MAX = 12;
export const OPEN_SETTINGS_EVENT = 'fe:open-settings';
const PENDING_ANCHOR_KEY = 'fe_settings_anchor';

let pendingAnchor = null;

/** 读当前背景配置，坏数据一律当默认处理 */
export function readChatBg() {
  try {
    const raw = localStorage.getItem(CHAT_BG_KEY);
    if (!raw) return { list: [], current: -1 };
    const data = JSON.parse(raw);
    const list = Array.isArray(data.list) ? data.list.filter((x) => typeof x === 'string' && x) : [];
    const rawIdx = Number(data.current);
    const current = Number.isFinite(rawIdx) && rawIdx >= 0 && rawIdx < list.length ? rawIdx : -1;
    return { list, current };
  } catch {
    return { list: [], current: -1 };
  }
}

/** 写配置并广播 fe:chatbg，聊天页监听后立即换成新背景 */
export function saveChatBg(next) {
  const safe = {
    list: Array.isArray(next?.list) ? next.list.slice(0, CHAT_BG_MAX) : [],
    current: Number(next?.current) || -1,
  };
  if (safe.current < 0 || safe.current >= safe.list.length) safe.current = safe.list.length ? 0 : -1;
  try {
    localStorage.setItem(CHAT_BG_KEY, JSON.stringify(safe));
  } catch {
    throw new Error('本地空间不够，背景没存下');
  }
  try { window.dispatchEvent(new Event(CHAT_BG_EVENT)); } catch { /* 忽略 */ }
  return safe;
}

/** 当前生效的背景图 URL，没有就返回空串 */
export function currentChatBgUrl(data = readChatBg()) {
  const idx = Number(data?.current);
  return Array.isArray(data?.list) && idx >= 0 && data.list[idx] ? data.list[idx] : '';
}

/** 把文件压缩后追加进背景列表，返回新的配置；一张都没成功时返回 null */
export async function addChatBgFiles(data, files) {
  const picked = Array.from(files || []);
  if (!picked.length) return null;
  const list = Array.isArray(data?.list) ? data.list.slice() : [];
  const room = CHAT_BG_MAX - list.length;
  if (room <= 0) throw new Error('最多 ' + CHAT_BG_MAX + ' 张背景');
  let added = 0;
  for (const file of picked.slice(0, room)) {
    try {
      list.push(await shrinkImage(file, 1600, 'image/jpeg', 0.85));
      added += 1;
    } catch {
      /* 单张失败就跳过，不打断整批 */
    }
  }
  if (!added) return null;
  const current = data?.current >= 0 ? data.current : list.length - 1;
  return saveChatBg({ list, current });
}

export function pickChatBg(data, index) {
  return saveChatBg({ list: data.list, current: index });
}

export function removeChatBgAt(data, index) {
  const list = data.list.filter((_, i) => i !== index);
  let current = data.current;
  if (current === index) current = list.length ? 0 : -1;
  else if (current > index) current -= 1;
  return saveChatBg({ list, current });
}

export function resetChatBg(data) {
  return saveChatBg({ list: data.list, current: -1 });
}

export function clearChatBg() {
  return saveChatBg({ list: [], current: -1 });
}

/**
 * 从聊天页跳到设置页的聊天背景卡片。
 * 先把锚点记在内存 + sessionStorage，跨页面挂载也能读到；再派发事件让 Shell 切到「我的」。
 */
export function requestOpenSettings(anchor) {
  pendingAnchor = anchor || null;
  try { sessionStorage.setItem(PENDING_ANCHOR_KEY, anchor || ''); } catch { /* 忽略 */ }
  try { window.dispatchEvent(new CustomEvent(OPEN_SETTINGS_EVENT, { detail: { anchor } })); } catch { /* 忽略 */ }
}

/** 设置页挂载时取一次待处理的锚点（取完清空，避免每次进设置都滚） */
export function consumePendingAnchor() {
  let anchor = pendingAnchor;
  pendingAnchor = null;
  if (!anchor) {
    try {
      anchor = sessionStorage.getItem(PENDING_ANCHOR_KEY) || null;
      sessionStorage.removeItem(PENDING_ANCHOR_KEY);
    } catch { anchor = null; }
  }
  return anchor;
}

/** 背景显示方式：铺满 / 完整 / 平铺，位置：上 / 中 / 下。单独一个 key，不动原来的背景列表结构 */
export const CHAT_BG_STYLE_KEY = 'fe_chat_bg_style';
export function readChatBgStyle() {
  try {
    const d = JSON.parse(localStorage.getItem(CHAT_BG_STYLE_KEY) || '{}');
    return {
      fit: ['cover', 'contain', 'repeat'].includes(d.fit) ? d.fit : 'cover',
      pos: ['top', 'center', 'bottom'].includes(d.pos) ? d.pos : 'center',
    };
  } catch {
    return { fit: 'cover', pos: 'center' };
  }
}
export function saveChatBgStyle(next) {
  const s = {
    fit: ['cover', 'contain', 'repeat'].includes(next?.fit) ? next.fit : 'cover',
    pos: ['top', 'center', 'bottom'].includes(next?.pos) ? next.pos : 'center',
  };
  try { localStorage.setItem(CHAT_BG_STYLE_KEY, JSON.stringify(s)); } catch { /* 忽略 */ }
  try { window.dispatchEvent(new Event(CHAT_BG_EVENT)); } catch { /* 忽略 */ }
  return s;
}

