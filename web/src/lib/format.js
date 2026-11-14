const pad2 = (n) => String(n).padStart(2, '0');

export function fmtClock(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function relTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const diff = now.getTime() - d.getTime();
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtClock(ts);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}/${d.getDate()}`;
  return fmtDate(ts);
}

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return '今天';
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return '昨天';
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return fmtDate(ts);
}

export function fmtSize(bytes) {
  const n = Number(bytes);
  if (!n || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const m = Math.floor(s / 60);
  return `${m}:${pad2(s % 60)}`;
}

export function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`;
  return String(v);
}

const PALETTE = ['#22d3ee', '#a855f7', '#3b82f6', '#34d399', '#fb7185', '#fbbf24', '#06b6d4', '#e879f9'];

export function colorFor(key) {
  const str = String(key ?? '?');
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 997;
  return PALETTE[h % PALETTE.length];
}

export const STATUS_META = {
  online: { label: '在线', tone: 'ok' },
  away: { label: '离开', tone: 'warn' },
  busy: { label: '忙碌', tone: 'danger' },
  offline: { label: '离线', tone: 'off' },
  invisible: { label: '隐身', tone: 'off' },
};

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.offline;
}

const PREVIEW = { image: '[图片]', file: '[文件]', voice: '[语音]', forward: '[聊天记录]', merge: '[聊天记录]' };

export function previewFor(msg) {
  if (!msg) return '';
  if (msg.recalled) return '[已撤回]';
  if (msg.kind && PREVIEW[msg.kind]) {
    if (msg.kind === 'file') return `[文件] ${msg.meta?.name || ''}`.trim();
    return PREVIEW[msg.kind];
  }
  return String(msg.body || '').replace(/\s+/g, ' ').slice(0, 60);
}

export function roleLabel(role) {
  if (role === 'owner') return '群主';
  if (role === 'admin') return '管理员';
  return '';
}

export function summarizeMessages(messages) {
  return (messages || []).slice(0, 4).map((m) => `${m.nickname || m.sender_nickname || ''}：${previewFor(m)}`).join('\n');
}

export function splitMentions(text) {
  const parts = [];
  const re = /@[^\s@]{1,24}/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index) });
    parts.push({ text: m[0], mention: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
