import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Empty, SkeletonList, Spinner, toast } from '../../ui/primitives.jsx';
import { api, shrinkImage } from '../../lib/api.js';
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
  { id: 'site', label: '站点', icon: 'gear' },
  { id: 'pending', label: '审核', icon: 'check' },
  { id: 'logins', label: '登录记录', icon: 'key' },
  { id: 'guard', label: '防护', icon: 'shield' },
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

const MODES = [
  { id: 'open', label: '开放注册', hint: '谁都能注册，注册完就能用' },
  { id: 'approval', label: '需要审核', hint: '新号注册后要你在「审核」里放行' },
  { id: 'closed', label: '关闭注册', hint: '只保留已有账号，不再接受新注册' },
];

const GATES = [
  { id: 'both', label: '邮箱码或邀请码', hint: '配了发信就发验证码，没配就走邀请码' },
  { id: 'invite', label: '只认邀请码', hint: '只有拿到邀请码的人能注册' },
  { id: 'email', label: '只认邮箱码', hint: '必须填自己邮箱收到的验证码' },
  { id: 'none', label: '都不要', hint: '谁都能注册（不推荐，容易被刷）' },
];

function modeLabel(id) {
  const m = MODES.find((x) => x.id === id);
  return m ? m.label : id;
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
  const [showHiddenBots, setShowHiddenBots] = useState(false);
  const [messages, setMessages] = useState(null);
  const [pendingList, setPendingList] = useState(null);
  const [logins, setLogins] = useState(null);
  const [onlyFail, setOnlyFail] = useState(false);
  const [ipBans, setIpBans] = useState(null);
  const [regMode, setRegMode] = useState('approval');
  const [newIp, setNewIp] = useState('');
  const [newReason, setNewReason] = useState('');
  const [busy, setBusy] = useState('');
  const [siteCfg, setSiteCfg] = useState(null);
  const [gate, setGate] = useState('both');
  const [retention, setRetention] = useState(14);
  const [smtp, setSmtp] = useState({ host: '', port: 465, secure: true, user: '', pass: '', from: '', fromName: '' });
  const [donation, setDonation] = useState({ link: '', images: [] });
  const donationFileRef = useRef(null);
  const [testTo, setTestTo] = useState('');
  const [invites, setInvites] = useState(null);
  const [invCount, setInvCount] = useState(3);
  const [invUses, setInvUses] = useState(1);
  const [invDays, setInvDays] = useState(30);
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
      const data = await api('/api/admin/bots' + (showHiddenBots ? '?includeHidden=1' : ''), { token });
      setBots(data.bots || []);
    } catch (err) {
      toast(err.message, 'error');
      setBots([]);
    }
  }, [token, showHiddenBots]);

  const loadMessages = useCallback(async () => {
    try {
      const data = await api('/api/admin/messages?limit=100', { token });
      setMessages(data.messages || []);
    } catch (err) {
      toast(err.message, 'error');
      setMessages([]);
    }
  }, [token]);

  const loadPending = useCallback(async () => {
    try {
      const data = await api('/api/admin/pending', { token });
      setPendingList(data.pending || []);
    } catch (err) {
      toast(err.message, 'error');
      setPendingList([]);
    }
  }, [token]);

  const loadLogins = useCallback(
    async (failsOnly) => {
      const params = new URLSearchParams({ limit: '120' });
      if (failsOnly) params.set('only', 'fail');
      try {
        const data = await api('/api/admin/logins?' + params.toString(), { token });
        setLogins(data.logins || []);
      } catch (err) {
        toast(err.message, 'error');
        setLogins([]);
      }
    },
    [token],
  );

  const loadSite = useCallback(async () => {
    try {
      const [cfg, inv] = await Promise.all([api('/api/admin/site', { token }), api('/api/admin/invites', { token })]);
      setSiteCfg(cfg);
      setGate(cfg.registerGate || 'both');
      setRetention(cfg.retentionDays ?? 14);
      const s = cfg.smtp || {};
      setSmtp({
        host: s.host || '',
        port: s.port || 465,
        secure: s.secure === undefined ? true : !!s.secure,
        user: s.user || '',
        pass: '',
        from: s.from || '',
        fromName: s.fromName || '',
      });
      setInvites(inv.invites || []);
      setDonation({ link: cfg.donationLink || '', images: cfg.donationImages || (cfg.donationImage ? [cfg.donationImage] : []) });
    } catch (err) {
      toast(err.message, 'error');
      setSiteCfg(false);
    }
  }, [token]);

  const saveSite = async (patch, okText) => {
    setBusy('/api/admin/site');
    try {
      const out = await api('/api/admin/site', { token, method: 'PATCH', body: patch });
      toast(okText, 'ok');
      setGate(out.registerGate || gate);
      setRetention(out.retentionDays ?? retention);
      await loadSite();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const sendTestMail = async () => {
    setBusy('/api/admin/site/test-mail');
    try {
      const out = await api('/api/admin/site/test-mail', { token, method: 'POST', body: { to: testTo.trim() || undefined } });
      toast('测试邮件已发出，收件箱看看有没有', 'ok');
      if (out && out.to) setTestTo(out.to);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const makeInvites = async () => {
    setBusy('/api/admin/invites');
    try {
      const out = await api('/api/admin/invites', {
        token,
        method: 'POST',
        body: { count: Number(invCount) || 1, maxUses: Number(invUses) || 1, expiresInDays: Number(invDays) || 0 },
      });
      toast('生成了 ' + (out.codes || []).length + ' 个邀请码', 'ok');
      await loadSite();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const dropInvite = async (code) => {
    setBusy('/api/admin/invites/' + code);
    try {
      await api('/api/admin/invites/' + encodeURIComponent(code), { token, method: 'DELETE' });
      toast('已删除该邀请码', 'ok');
      await loadSite();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const deleteAccount = async (a) => {
    const ok = window.confirm('把 ' + (a.nickname || a.number) + ' #' + a.number + ' 彻底删掉？\n它的消息、会话、好友关系都会一起消失，删了不能恢复。');
    if (!ok) return;
    setBusy('/api/admin/accounts/' + a.number + '/delete');
    try {
      await api('/api/admin/accounts/' + a.number + '/delete', { token, method: 'POST' });
      toast('账号已删除', 'ok');
      await Promise.all([loadOverview(), loadAccounts(), loadBots()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const loadBans = useCallback(async () => {
    try {
      const [bans, cfg] = await Promise.all([
        api('/api/admin/ip-bans', { token }),
        api('/api/admin/settings', { token }),
      ]);
      setIpBans(bans.bans || []);
      if (cfg.registerMode) setRegMode(cfg.registerMode);
    } catch (err) {
      toast(err.message, 'error');
      setIpBans([]);
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

  const send = async (path, method, body, okText) => {
    setBusy(path);
    try {
      await api(path, { token, method, body });
      toast(okText, 'ok');
      await loadOverview();
      if (section === 'pending') await loadPending();
      if (section === 'logins') await loadLogins(onlyFail);
      if (section === 'guard') await loadBans();
      if (section === 'accounts') await loadAccounts();
      if (section === 'bots') await loadBots();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const post = (path, body, okText) => send(path, 'POST', body, okText);

  const approve = async (number, approveIt) => {
    if (!approveIt && !window.confirm('拒绝会把这个账号连同它的会话一起删掉，确定？')) return;
    await send('/api/admin/accounts/' + number + '/approve', 'POST', { approve: approveIt }, approveIt ? '已通过' : '已拒绝并删除');
  };

  const setMode = async (mode) => {
    setRegMode(mode);
    await send('/api/admin/settings', 'PATCH', { registerMode: mode }, '注册模式已改');
  };

  const banIp = async () => {
    const ip = (newIp || '').trim();
    if (!ip) {
      toast('先填 IP', 'error');
      return;
    }
    await send('/api/admin/ip-bans', 'POST', { ip, reason: (newReason || '').trim() }, '已封禁该 IP');
    setNewIp('');
    setNewReason('');
  };

  const unbanIp = (ip) => send('/api/admin/ip-bans/' + encodeURIComponent(ip), 'DELETE', null, '已解封该 IP');

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
    if (id === 'pending') loadPending();
    if (id === 'logins') loadLogins(onlyFail);
    if (id === 'guard') loadBans();
    if (id === 'site' && !siteCfg) loadSite();
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
            { k: '待审核', v: c.pending ?? 0, sub: '等站长放行' },
            { k: '今日登录', v: c.loginsToday ?? 0, sub: '失败 ' + (c.failedLoginsToday ?? 0) + ' 次' },
            { k: '封禁 IP', v: c.bannedIps ?? 0, sub: '挡在门口' },
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
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === '/api/admin/accounts/' + a.number + '/delete' || a.id === me?.id}
                      onClick={() => deleteAccount(a)}
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

      {section === 'site' ? (
        <section className="settings-card">
          <div className="admin-card-head">
            <div>
              <h3>注册门禁</h3>
              <p>新号进来要过哪一关。改完立刻生效，注册页会跟着变。</p>
            </div>
          </div>
          <div className="admin-modes">
            {GATES.map((g) => (
              <button
                type="button"
                key={g.id}
                className={'admin-mode' + (gate === g.id ? ' on' : '')}
                disabled={busy === '/api/admin/site'}
                onClick={() => saveSite({ registerGate: g.id }, '注册门禁已改为「' + g.label + '」')}
              >
                <b>{g.label}</b>
                <span>{g.hint}</span>
              </button>
            ))}
          </div>

          <div className="admin-card-head admin-card-head-gap">
            <div>
              <h3>数据保留</h3>
              <p>超过这个天数的消息会被自动清掉（连图片一起），给设备省空间。填 0 = 永久保留。</p>
            </div>
          </div>
          <div className="admin-toolbar">
            <label className="admin-search">
              <Icon name="clock" size={15} />
              <input
                type="number"
                min="0"
                max="365"
                value={retention}
                onChange={(e) => setRetention(e.target.value)}
                aria-label="数据保留天数"
              />
            </label>
            <span className="admin-inline-hint">天（0 = 永久）</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === '/api/admin/site'}
              onClick={() => saveSite({ retentionDays: Number(retention) || 0 }, '保留天数已保存')}
            >
              保存
            </button>
          </div>

          <div className="admin-card-head admin-card-head-gap">
            <div>
              <h3>发信服务（SMTP）</h3>
              <p>配好才能发邮箱验证码。以 QQ 邮箱为例：设置 → 账户 → 开启 IMAP/SMTP，拿到 16 位「授权码」当密码；服务器填 smtp.qq.com，端口 465 选 SSL（或 587 选 STARTTLS），登录账号和发件人都填你的 QQ 邮箱。填完点「试发一封」验证，收到就是成功；收不到先检查授权码有没有填成登录密码。不配也能用，只是注册只能走邀请码。</p>
            </div>
            <span className={'admin-tag ' + (siteCfg && siteCfg.smtpReady ? 'ok' : 'danger')}>
              {siteCfg && siteCfg.smtpReady ? '已就绪' : '未配置'}
            </span>
          </div>
          <div className="admin-form">
            <label className="field">
              <span className="field-label">服务器地址</span>
              <input
                className="input"
                value={smtp.host}
                placeholder="smtp.example.com"
                onChange={(e) => setSmtp({ ...smtp, host: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">端口</span>
              <input
                className="input"
                type="number"
                value={smtp.port}
                placeholder="465"
                onChange={(e) => setSmtp({ ...smtp, port: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">加密方式</span>
              <select
                className="input"
                value={smtp.secure ? 'ssl' : 'starttls'}
                onChange={(e) => setSmtp({ ...smtp, secure: e.target.value === 'ssl' })}
              >
                <option value="ssl">SSL 直连（一般 465）</option>
                <option value="starttls">STARTTLS（一般 587）</option>
              </select>
            </label>
            <label className="field">
              <span className="field-label">登录账号</span>
              <input
                className="input"
                value={smtp.user}
                placeholder="通常就是邮箱地址"
                onChange={(e) => setSmtp({ ...smtp, user: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">密码 / 授权码</span>
              <input
                className="input"
                type="password"
                value={smtp.pass}
                placeholder={siteCfg && siteCfg.smtp && siteCfg.smtp.hasPass ? '已保存，留空不改' : '邮箱的授权码'}
                onChange={(e) => setSmtp({ ...smtp, pass: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">发件人地址</span>
              <input
                className="input"
                value={smtp.from}
                placeholder="不填就用登录账号"
                onChange={(e) => setSmtp({ ...smtp, from: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">发件人名字</span>
              <input
                className="input"
                value={smtp.fromName}
                placeholder="Everony"
                onChange={(e) => setSmtp({ ...smtp, fromName: e.target.value })}
              />
            </label>
            <label className="field">
              <span className="field-label">试发到</span>
              <input
                className="input"
                value={testTo}
                placeholder="留空发到自己账号邮箱"
                onChange={(e) => setTestTo(e.target.value)}
              />
            </label>
          </div>
          <div className="admin-toolbar">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === '/api/admin/site'}
              onClick={() =>
                saveSite(
                  {
                    smtpHost: smtp.host.trim(),
                    smtpPort: Number(smtp.port) || 465,
                    smtpSecure: !!smtp.secure,
                    smtpUser: smtp.user.trim(),
                    smtpPass: smtp.pass,
                    smtpFrom: smtp.from.trim(),
                    smtpFromName: smtp.fromName.trim(),
                  },
                  '发信设置已保存',
                )
              }
            >
              保存发信设置
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={busy === '/api/admin/site/test-mail'}
              onClick={sendTestMail}
            >
              <Icon name="mail" size={14} /> 试发一封
            </button>
          </div>

          <div className="admin-card-head admin-card-head-gap">
            <div>
              <h3>邀请码</h3>
              <p>注册时填它就能过门禁。每个码能用几次、多久过期都由你定。</p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadSite()}>
              <Icon name="refresh" size={15} /> 刷新
            </button>
          </div>
          <div className="admin-toolbar">
            <label className="admin-search admin-search-narrow">
              <Icon name="hash" size={15} />
              <input type="number" min="1" max="50" value={invCount} onChange={(e) => setInvCount(e.target.value)} aria-label="生成个数" />
            </label>
            <label className="admin-search admin-search-narrow">
              <Icon name="users" size={15} />
              <input type="number" min="1" max="1000" value={invUses} onChange={(e) => setInvUses(e.target.value)} aria-label="每个可用次数" />
            </label>
            <label className="admin-search admin-search-narrow">
              <Icon name="clock" size={15} />
              <input type="number" min="0" max="3650" value={invDays} onChange={(e) => setInvDays(e.target.value)} aria-label="有效天数" />
            </label>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy === '/api/admin/invites'} onClick={makeInvites}>
              <Icon name="plus" size={14} /> 生成
            </button>
          </div>
          <span className="admin-inline-hint">依次是：生成几个 / 每个能用几次 / 多少天后过期（0 = 不过期）</span>
          {invites === null ? (
            <SkeletonList rows={3} />
          ) : invites.length === 0 ? (
            <Empty compact icon="star" title="还没有邀请码" sub="上面填好数量点「生成」，把码发给要拉进来的人。" />
          ) : (
            <div className="admin-list">
              {invites.map((it) => (
                <div className="admin-row" key={it.code}>
                  <div className="admin-row-main">
                    <b>
                      {it.code}
                      {it.left > 0 ? <em className="admin-tag ok">可用 {it.left}</em> : <em className="admin-tag danger">已用完</em>}
                      {it.expires_at && it.expires_at < Date.now() ? <em className="admin-tag danger">已过期</em> : null}
                    </b>
                    <span>
                      已用 {it.used}/{it.max_uses}
                      {it.expires_at ? ' · ' + new Date(it.expires_at).toLocaleDateString() + ' 到期' : ' · 不过期'}
                      {it.by_nickname ? ' · ' + it.by_nickname : ''}
                      {it.note ? ' · ' + it.note : ''}
                    </span>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        navigator.clipboard?.writeText(it.code).then(
                          () => toast('邀请码已复制', 'ok'),
                          () => toast('复制失败，长按选中手动复制', 'error'),
                        );
                      }}
                    >
                      <Icon name="copy" size={14} /> 复制
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === '/api/admin/invites/' + it.code}
                      onClick={() => dropInvite(it.code)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="admin-card-head admin-card-head-gap">
            <div>
              <h3>支持这个站</h3>
              <p>用户点「我想支持」时展示的转账方式：贴一个转账链接，或上传一张收款码图片（微信 / 支付宝都行）。都不填就只显示提示。</p>
            </div>
          </div>
          <div className="admin-form">
            <label className="field">
              <span className="field-label">转账链接</span>
              <input
                className="input"
                value={donation.link}
                placeholder="https://… 收款码页或转账页"
                onChange={(e) => setDonation((d) => ({ ...d, link: e.target.value }))}
              />
            </label>
            <label className="field">
              <span className="field-label">收款码图片（最多 6 张，可放微信/支付宝等多张）</span>
              <div className="donation-images-grid">
                {donation.images.map((src, i) => (
                  <div className="donation-img-cell" key={i}>
                    <img src={src} alt={'收款码 ' + (i + 1)} />
                    <button type="button" className="donation-img-del" aria-label="移除" onClick={() => setDonation((d) => ({ ...d, images: d.images.filter((_, j) => j !== i) }))}>×</button>
                  </div>
                ))}
                {donation.images.length < 6 ? (
                  <button type="button" className="donation-img-add" onClick={() => donationFileRef.current?.click()}><Icon name="plus" size={20} /> 加图片</button>
                ) : null}
                <input
                  ref={donationFileRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []).slice(0, 6 - donation.images.length);
                    Promise.all(files.map((f) => shrinkImage(f, 600, 'image/jpeg', 0.85)))
                      .then((urls) => setDonation((d) => ({ ...d, images: [...d.images, ...urls].slice(0, 6) })))
                      .catch((err) => toast('图片处理失败：' + err.message, 'error'));
                    e.target.value = '';
                  }}
                />
              </div>
            </label>
          </div>
          <div className="admin-toolbar">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === '/api/admin/site'}
              onClick={() => saveSite({ donationLink: donation.link.trim(), donationImages: donation.images }, '支持配置已保存')}
            >
              保存支持配置
            </button>
          </div>
        </section>
      ) : null}

      {section === 'pending' ? (
        <section className="settings-card">
          <div className="admin-card-head">
            <div>
              <h3>注册审核</h3>
              <p>
                当前模式：<b>{modeLabel(regMode)}</b>。待审核 {pendingList ? pendingList.length : 0} 个。
                拒绝会连账号一起删掉。
              </p>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => loadPending()}>
              <Icon name="refresh" size={15} /> 刷新
            </button>
          </div>
          {pendingList === null ? (
            <SkeletonList rows={3} />
          ) : pendingList.length === 0 ? (
            <Empty text="没有待审核的注册" />
          ) : (
            <div className="admin-list">
              {pendingList.map((a) => (
                <div className="admin-row" key={a.id}>
                  <Avatar number={a.number} nickname={a.nickname} avatar={a.avatar} size={38} />
                  <div className="admin-row-main">
                    <b>
                      {a.nickname}
                      <em className="admin-tag">{'#' + a.number}</em>
                    </b>
                    <span>
                      {a.email || '无邮箱'} · {relTime(a.created_at)}申请
                      {a.ip ? ' · IP ' + a.ip : ''}
                      {a.device ? ' · ' + a.device : ''}
                    </span>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy === '/api/admin/accounts/' + a.number + '/approve'}
                      onClick={() => approve(a.number, true)}
                    >
                      通过
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy === '/api/admin/accounts/' + a.number + '/approve'}
                      onClick={() => approve(a.number, false)}
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {section === 'logins' ? (
        <section className="settings-card">
          <div className="admin-card-head">
            <div>
              <h3>登录记录</h3>
              <p>谁在什么 IP、什么设备上登录过，失败的也记下来。</p>
            </div>
            <div className="admin-filters">
              <button
                type="button"
                className={'admin-chip' + (onlyFail ? '' : ' on')}
                onClick={() => {
                  setOnlyFail(false);
                  loadLogins(false);
                }}
              >
                全部
              </button>
              <button
                type="button"
                className={'admin-chip' + (onlyFail ? ' on' : '')}
                onClick={() => {
                  setOnlyFail(true);
                  loadLogins(true);
                }}
              >
                只看失败
              </button>
            </div>
          </div>
          {logins === null ? (
            <SkeletonList rows={6} />
          ) : logins.length === 0 ? (
            <Empty text="还没有登录记录" />
          ) : (
            <div className="admin-list">
              {logins.map((l) => (
                <div className="admin-row" key={l.id}>
                  <div className="admin-row-main">
                    <b>
                      {l.nickname || '（未知）'}
                      <em className="admin-tag">{'#' + l.number}</em>
                      <em className={'admin-tag ' + (l.ok ? 'ok' : 'danger')}>{l.ok ? '成功' : '失败'}</em>
                    </b>
                    <span>
                      {relTime(l.created_at)} · IP {l.ip || '未知'} · {l.device || '未知设备'}
                      {l.reason ? ' · ' + l.reason : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {section === 'guard' ? (
        <section className="settings-card">
          <div className="admin-card-head">
            <div>
              <h3>注册模式</h3>
              <p>决定新用户能不能自己注册进来。</p>
            </div>
          </div>
          <div className="admin-modes">
            {MODES.map((m) => (
              <button
                type="button"
                key={m.id}
                className={'admin-mode' + (regMode === m.id ? ' on' : '')}
                disabled={busy === '/api/admin/settings'}
                onClick={() => setMode(m.id)}
              >
                <b>{m.label}</b>
                <span>{m.hint}</span>
              </button>
            ))}
          </div>

          <div className="admin-card-head admin-card-head-gap">
            <div>
              <h3>IP 封禁</h3>
              <p>被封的 IP 直接挡在门口，连页面都打不开。</p>
            </div>
          </div>
          <div className="admin-toolbar">
            <label className="admin-search">
              <Icon name="shield" size={15} />
              <input value={newIp} onChange={(e) => setNewIp(e.target.value)} placeholder="要封的 IP，例如 203.0.113.7" aria-label="IP" />
            </label>
            <label className="admin-search">
              <Icon name="chat" size={15} />
              <input value={newReason} onChange={(e) => setNewReason(e.target.value)} placeholder="原因（可留空）" aria-label="原因" />
            </label>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy === '/api/admin/ip-bans'} onClick={banIp}>
              封禁
            </button>
          </div>
          {ipBans === null ? (
            <SkeletonList rows={3} />
          ) : ipBans.length === 0 ? (
            <Empty text="还没有封禁任何 IP" />
          ) : (
            <div className="admin-list">
              {ipBans.map((b) => (
                <div className="admin-row" key={b.ip}>
                  <div className="admin-row-main">
                    <b>
                      {b.ip}
                      <em className="admin-tag danger">已封禁</em>
                    </b>
                    <span>
                      {relTime(b.created_at)}封禁{b.reason ? ' · ' + b.reason : ''}
                    </span>
                  </div>
                  <div className="admin-row-actions">
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      disabled={busy === '/api/admin/ip-bans/' + b.ip}
                      onClick={() => unbanIp(b.ip)}
                    >
                      解封
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
          <div className="admin-filter-row">
            <span className="admin-hint">默认只列已上架的 Bot，下架的不占地方</span>
            <button
              type="button"
              className={'btn btn-sm ' + (showHiddenBots ? 'btn-primary' : 'btn-ghost')}
              onClick={() => setShowHiddenBots((v) => !v)}
            >
              {showHiddenBots ? '只看已上架' : '显示已下架'}
            </button>
          </div>
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
          <div className="admin-terminal">
            <div className="admin-terminal-head"><span className="term-dot red" /><span className="term-dot yellow" /><span className="term-dot green" /> 消息终端 · 只读</div>
            <div className="admin-terminal-body">
              {messages === null ? (
                <div className="term-line">正在读取消息…</div>
              ) : messages.length === 0 ? (
                <div className="term-line">— 暂无消息 —</div>
              ) : messages.map((m) => (
                <div className="term-line" key={m.id}>
                  <span className="term-time">[{new Date(m.created_at).toLocaleString()}]</span>
                  <span className="term-user">{m.sender_nickname}#{m.sender_number}</span>
                  <span className="term-sep">›</span>
                  <span className="term-body">{m.body || '（空）'}</span>
                </div>
              ))}
            </div>
          </div>
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
