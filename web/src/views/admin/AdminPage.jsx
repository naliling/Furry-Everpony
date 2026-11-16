import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Empty, SkeletonList, Spinner, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { relTime } from '../../lib/format.js';

/* 管理后台：运营者看数据、管账号、管 Bot、审消息。只有 is_admin 能进。 */
const FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'user', label: '用户' },
  { id: 'bot', label: 'Bot' },
  { id: 'banned', label: '已封禁' },
  { id: 'admin', label: '管理员' },
];

const SECTIONS = [
  { id: 'accounts', label: '账号', icon: 'friend' },
  { id: 'bots', label: 'Bot', icon: 'bot' },
  { id: 'messages', label: '消息', icon: 'chat' },
];

function fmtBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function fmtUptime(sec) {
  if (!sec) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return d + ' 天 ' + h + ' 小时';
  if (h) return h + ' 小时 ' + m + ' 分';
  return m + ' 分钟';
}

export default function AdminPage({ token, me }) {
  const [overview, setOverview] = useState(null);
  const [section, setSection] = useState('accounts');
  const [filter, setFilter] = useState('all');
  const [q, setQ] = useState('');
  const [accounts, setAccounts] = useState(null);
  const [bots, setBots] = useState(null);
  const [messages, setMessages] = useState(null);
  const [busy, setBusy] = useState('');
  const debounceRef = useRef(null);

  const loadOverview = useCallback(async () => {
    try {
      setOverview(await api('/api/admin/overview', { token }));
    } catch (err) {
      toast(err.message, 'error');
      setOverview(false);
    }
  }, [token]);

  const loadAccounts = useCallback(
    async (nextQ, nextFilter) => {
      const params = new URLSearchParams();
      const kw = (nextQ ?? q).trim();
      if (kw) params.set('q', kw);
      const f = nextFilter ?? filter;
      if (f !== 'all') params.set('filter', f);
      params.set('limit', '100');
      try {
        const data = await api('/api/admin/accounts?' + params.toString(), { token });
        setAccounts(data.accounts || []);
      } catch (err) {
        toast(err.message, 'error');
        setAccounts([]);
      }
    },
    [token, q, filter],
  );

  const loadBots = useCallback(async () => {
    try {
      const data = await api('/api/admin/bots', { token });
      setBots(data.bots || []);
    } catch (err) {
      toast(err.message, 'error');
      setBots([]);
    }
  }, [token]);

  const loadMessages = useCallback(async () => {
    try {
      const data = await api('/api/admin/messages?limit=100', { token });
      setMessages(data.messages || []);
    } catch (err) {
      toast(err.message, 'error');
      setMessages([]);
    }
  }, [token]);

  useEffect(() => {
    loadOverview();
    loadAccounts('', 'all');
    loadBots();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const refreshAll = async () => {
    await Promise.all([loadOverview(), loadAccounts(), loadBots()]);
    if (section === 'messages') await loadMessages();
  };

  const post = async (path, body, okText) => {
    setBusy(path);
    try {
      await api(path, { token, method: 'POST', body });
      toast(okText, 'ok');
      await refreshAll();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const removeMessage = async (id) => {
    const path = '/api/admin/messages/' + id;
    setBusy(path);
    try {
      await api(path, { token, method: 'DELETE' });
      toast('已删除', 'ok');
      await loadMessages();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const onSearch = (value) => {
    setQ(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => loadAccounts(value, filter), 300);
  };

  const onFilter = (id) => {
    setFilter(id);
    loadAccounts(q, id);
  };

  const switchSection = (id) => {
    setSection(id);
    if (id === 'bots' && !bots) loadBots();
    if (id === 'messages' && !messages) loadMessages();
  };

  const c = overview?.counts || {};

  return (
    <div className="admin-page">
      <header className="admin-head">
        <div>
          <h2><Icon name="shield" size={20} /> 管理后台</h2>
          <p>你是这台服务器的管理员。这里的操作对所有用户立即生效。</p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={refreshAll}>
          <Icon name="refresh" size={15} /> 刷新
        </button>
      </header>

      {overview === null ? (
        <SkeletonList rows={2} />
      ) : overview === false ? (
        <p className="settings-hint">读取统计数据失败。</p>
      ) : (
        <div className="admin-stats">
          {[
            { k: '账号总数', v: c.accounts, sub: c.users + ' 用户 / ' + c.bots + ' Bot' },
            { k: '在线', v: c.onlineNow, sub: '最近 90 秒有活动' },
            { k: '消息总数', v: c.messages, sub: '今日 +' + c.messagesToday },
            { k: '公开 Bot', v: c.publicBots, sub: '共 ' + c.bots + ' 个' },
            { k: '群聊', v: c.groups, sub: '全部群组' },
            { k: '今日新账号', v: c.newAccountsToday, sub: '封禁 ' + c.banned + ' 个' },
            { k: '数据库', v: fmtBytes(overview.dbBytes), sub: 'SQLite 单文件' },
            { k: '运行时长', v: fmtUptime(overview.uptimeSec), sub: 'v' + overview.version },
          ].map((item) => (
            <div className="admin-stat" key={item.k}>
              <span>{item.k}</span>
              <b>{item.v}</b>
              <em>{item.sub}</em>
            </div>
          ))}
        </div>
      )}

      <div className="admin-tabs">
        {SECTIONS.map((s) => (
          <button
            type="button"
            key={s.id}
            className={'admin-tab' + (section === s.id ? ' on' : '')}
            onClick={() => switchSection(s.id)}
          >
            <Icon name={s.icon} size={15} /> {s.label}
          </button>
        ))}
      </div>

      {section === 'accounts' ? (
        <section className="settings-card">
          <div className="admin-toolbar">
            <label className="admin-search">
              <Icon name="search" size={15} />
              <input
                value={q}
                onChange={(e) => onSearch(e.target.value)}
                placeholder="搜号码、昵称、邮箱"
                aria-label="搜索账号"
              />
            </label>
            <div className="admin-filters">
              {FILTERS.map((f) => (
                <button
                  type="button"
                  key={f.id}
                  className={'admin-chip' + (filter === f.id ? ' on' : '')}
                  onClick={() => onFilter(f.id)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          {accounts === null ? (
            <SkeletonList rows={5} />
          ) : accounts.length === 0 ? (
            <Empty text="没有符合条件的账号" />
          ) : (
            <div className="admin-list">
              {accounts.map((a) => (
                <div className="admin-row" key={a.id}>
                  <Avatar number={a.number} nickname={a.nickname} avatar={a.avatar} size={38} />
                  <div className="admin-row-main">
                    <b>
                      {a.nickname}
                      {a.is_admin ? <em className="admin-tag">管理员</em> : null}
                      {a.type === 'bot' ? <em className="admin-tag bot">Bot</em> : null}
                      {a.banned ? <em className="admin-tag danger">已封禁</em> : null}
                    </b>
                    <span>
                      #{a.number}
                      {a.email ? ' · ' + a.email : ''} · {a.msg_count} 条消息 · {relTime(a.created_at)}加入
                      {a.banned && a.ban_reason ? ' · 原因：' + a.ban_reason : ''}
                    </span>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className={'btn btn-sm ' + (a.banned ? 'btn-ghost' : 'btn-danger')}
                      disabled={busy === '/api/admin/accounts/' + a.number + '/ban' || a.id === me?.id}
                      onClick={() => {
                        const reason = a.banned ? '' : window.prompt('封禁原因（可留空）', '') || '';
                        post(
                          '/api/admin/accounts/' + a.number + '/ban',
                          { banned: !a.banned, reason },
                          a.banned ? '已解封' : '已封禁',
                        );
                      }}
                    >
                      {a.banned ? '解封' : '封禁'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy === '/api/admin/accounts/' + a.number + '/admin' || a.id === me?.id}
                      onClick={() =>
                        post(
                          '/api/admin/accounts/' + a.number + '/admin',
                          { admin: !a.is_admin },
                          a.is_admin ? '已取消管理员' : '已设为管理员',
                        )
                      }
                    >
                      {a.is_admin ? '取消管理' : '设管理员'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {section === 'bots' ? (
        <section className="settings-card">
          {bots === null ? (
            <SkeletonList rows={4} />
          ) : bots.length === 0 ? (
            <Empty text="还没有 Bot" />
          ) : (
            <div className="admin-list">
              {bots.map((b) => (
                <div className="admin-row" key={b.id}>
                  <Avatar number={b.number} nickname={b.nickname} avatar={b.avatar} size={38} />
                  <div className="admin-row-main">
                    <b>
                      {b.nickname}
                      {b.online ? <em className="admin-tag ok">在线</em> : null}
                      {b.is_public ? <em className="admin-tag">公开</em> : null}
                    </b>
                    <span>
                      #{b.number} · 主人 {b.owner_nickname || '（无）'}
                      {b.owner_number ? ' #' + b.owner_number : ''} · {b.msg_count} 条消息
                    </span>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy === '/api/admin/bots/' + b.number + '/public'}
                      onClick={() =>
                        post(
                          '/api/admin/bots/' + b.number + '/public',
                          { isPublic: !b.is_public },
                          b.is_public ? '已从广场下架' : '已上架广场',
                        )
                      }
                    >
                      {b.is_public ? '下架' : '上架'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {section === 'messages' ? (
        <section className="settings-card">
          {messages === null ? (
            <SkeletonList rows={6} />
          ) : messages.length === 0 ? (
            <Empty text="还没有消息" />
          ) : (
            <div className="admin-list">
              {messages.map((m) => (
                <div className="admin-row" key={m.id}>
                  <div className="admin-row-main">
                    <b>
                      {m.sender_nickname} <em className="admin-tag">#{m.sender_number}</em>
                      <em className="admin-tag">会话 {m.conversation_id}</em>
                    </b>
                    <span>{m.body || '（空）'}</span>
                    <em className="admin-msg-time">{relTime(m.created_at)}</em>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === '/api/admin/messages/' + m.id}
                      onClick={() => removeMessage(m.id)}
                    >
                      <Icon name="trash" size={14} /> 删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {busy ? (
        <div className="admin-busy">
          <Spinner size={16} /> 处理中…
        </div>
      ) : null}
    </div>
  );
}
