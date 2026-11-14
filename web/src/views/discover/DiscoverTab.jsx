import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Badge, Empty, Modal, SkeletonList, Spinner, Tabs, Toggle, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { fmtCount } from '../../lib/format.js';

export default function DiscoverTab({ token, me, initialView, onBotSession, onOpenConversation }) {
  const [view, setView] = useState(initialView || 'plaza');

  useEffect(() => {
    if (initialView) setView(initialView);
  }, [initialView]);
  const [q, setQ] = useState('');
  const [publicBots, setPublicBots] = useState(null);
  const [myBots, setMyBots] = useState(null);
  const [detail, setDetail] = useState(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState('');
  const debounceRef = useRef(null);

  const loadPublic = useCallback(async (keyword = '') => {
    setPublicBots(null);
    try {
      const data = await api('/api/bots/public?q=' + encodeURIComponent(keyword) + '&limit=60', { token });
      setPublicBots(data.bots || []);
    } catch (err) {
      setPublicBots([]);
      toast(err.message, 'error');
    }
  }, [token]);

  const loadMine = useCallback(async () => {
    try {
      const data = await api('/api/bots', { token });
      setMyBots(data.bots || []);
    } catch (err) {
      setMyBots([]);
      if (!String(err.message).includes('404')) toast(err.message, 'error');
    }
  }, [token]);

  useEffect(() => { loadPublic(''); loadMine(); }, [loadPublic, loadMine]);

  const onSearch = (value) => {
    setQ(value);
    window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(() => loadPublic(value.trim()), 320);
  };

  const dm = async (number) => {
    try {
      const data = await api('/api/dm', { method: 'POST', token, body: { number } });
      setDetail(null);
      onOpenConversation?.(data.conversationId);
    } catch (err) { toast(err.message, 'error'); }
  };

  const switchToBot = async (bot) => {
    setBusy('switch' + bot.number);
    try {
      const data = await api('/api/bots/' + bot.number + '/session', { method: 'POST', token });
      onBotSession?.({ token: data.token, account: data.account });
      setDetail(null);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  };

  const copy = async (text, label = '已复制') => {
    try { await navigator.clipboard.writeText(text); toast(label, 'success'); } catch { toast('复制失败，请手动复制', 'error'); }
  };

  const plazaList = publicBots || [];
  const mine = myBots || [];

  return (
    <div className="discover-tab">
      <header className="page-head">
        <div>
          <h2>发现</h2>
          <p className="page-sub">Bot 广场、我的 Bot、模型与接入配置</p>
        </div>
        <div className="page-head-actions">
          <div className="segmented">
            <button type="button" className={view === 'plaza' ? 'on' : ''} onClick={() => setView('plaza')}>Bot 广场</button>
            <button type="button" className={view === 'mine' ? 'on' : ''} onClick={() => setView('mine')}>我的 Bot</button>
          </div>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> 创建 Bot</button>
        </div>
      </header>

      <div className="discover-body">
        {view === 'plaza' ? (
          <>
            <div className="plaza-hero">
              <div className="plaza-hero-text">
                <h3>找到会聊天的 Bot</h3>
                <p>每个 Bot 都是某个人号创造的独立角色，可以加好友、私聊，也可以接入自己的模型或框架。</p>
              </div>
              <div className="input-wrap plaza-search">
                <Icon name="search" size={16} className="input-lead" />
                <input className="input" placeholder="搜索 Bot 名字或号码" value={q} onChange={(e) => onSearch(e.target.value)} />
                {q ? <button type="button" className="input-clear" aria-label="清空" onClick={() => onSearch('')}><Icon name="close" size={13} /></button> : null}
              </div>
            </div>
            {publicBots === null ? <SkeletonList rows={4} /> : plazaList.length === 0 ? (
              <Empty icon="bot" title={q ? '没有找到匹配的 Bot' : '广场还没有公开的 Bot'} sub={q ? '换个关键词试试' : '创建 Bot 后打开公开，就会出现在广场'} />
            ) : (
              <div className="bot-grid">
                {plazaList.map((bot) => (
                  <button type="button" key={bot.number} className="bot-card" onClick={() => setDetail(bot)}>
                    <span className="bot-card-avatar"><Avatar number={bot.number} nickname={bot.nickname} avatar={bot.avatar} size={46} square /></span>
                    <span className="bot-card-main">
                      <span className="bot-card-name">{bot.nickname || bot.number}<span className="bot-card-online"><i className={bot.online ? 'on' : ''} /></span></span>
                      <span className="bot-card-number">{bot.number}</span>
                      <span className="bot-card-bio">{bot.bio || '这个 Bot 还没有签名'}</span>
                    </span>
                    <span className="bot-card-tag"><Icon name="bot" size={12} /> Bot</span>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : (
          <>
            {myBots === null ? <SkeletonList rows={3} /> : mine.length === 0 ? (
              <Empty icon="bot" title="还没有 Bot" sub="用你的号码创建 Bot，让它替你回消息或者接入框架"
                action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" size={15} /> 创建 Bot</button>} />
            ) : (
              <div className="bot-grid">
                {mine.map((bot) => (
                  <div key={bot.number} className="bot-card bot-card-own">
                    <button type="button" className="bot-card-hit" onClick={() => setDetail(bot)}>
                      <span className="bot-card-avatar"><Avatar number={bot.number} nickname={bot.nickname} avatar={bot.avatar} size={46} square /></span>
                      <span className="bot-card-main">
                        <span className="bot-card-name">{bot.nickname || bot.number}<span className="bot-card-online"><i className={bot.online ? 'on' : ''} /></span></span>
                        <span className="bot-card-number">{bot.number}<span className="tag">{bot.public ? '公开' : '私有'}</span></span>
                        <span className="bot-card-bio">{bot.bio || '还没有签名'}</span>
                      </span>
                    </button>
                    <div className="bot-card-actions">
                      <button type="button" className="icon-btn" title="发消息" aria-label="发消息" onClick={() => dm(bot.number)}><Icon name="chat" size={17} /></button>
                      <button type="button" className="icon-btn" title="接入框架" aria-label="接入框架" onClick={() => setDetail({ ...bot, __tab: 'link' })}><Icon name="link" size={17} /></button>
                      <button type="button" className="icon-btn" title="切换为 Bot" aria-label="切换为 Bot" disabled={busy === 'switch' + bot.number} onClick={() => switchToBot(bot)}>
                        {busy === 'switch' + bot.number ? <Spinner size={15} /> : <Icon name="refresh" size={17} />}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="bot-tip">
              <Icon name="info" size={16} />
              <span>切换为 Bot 会以 Bot 的身份进入界面，方便看它收到了什么；随时可以在账号菜单切回个人号。</span>
            </div>
          </>
        )}
      </div>

      {detail ? (
        <BotDetail
          token={token}
          me={me}
          bot={detail}
          own={mine.some((b) => b.number === detail.number)}
          initialTab={detail.__tab || 'overview'}
          onClose={() => setDetail(null)}
          onChat={() => dm(detail.number)}
          onSwitch={() => switchToBot(detail)}
          onCopy={copy}
          onChanged={loadMine}
          busy={busy === 'switch' + detail.number}
        />
      ) : null}
      {creating ? <CreateBotModal token={token} onClose={() => setCreating(false)} onCreated={(bot) => { setCreating(false); loadMine(); setDetail(bot); }} /> : null}
    </div>
  );
}

function BotDetail({ token, me, bot, own, initialTab = 'overview', onClose, onChat, onSwitch, onCopy, onChanged, busy }) {
  const [tab, setTab] = useState(own ? initialTab : 'overview');
  const [link, setLink] = useState(null);
  const [stats, setStats] = useState(null);
  const [form, setForm] = useState({ nickname: bot.nickname || '', bio: bot.bio || '', public: !!bot.public });
  const [saving, setSaving] = useState(false);
  const [tokenOpen, setTokenOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    if (!own) { setStats(null); return () => { alive = false; }; }
    api('/api/bots/' + bot.number + '/link', { token }).then((r) => { if (alive) setLink(r.link); }).catch(() => {});
    api('/api/bots/' + bot.number + '/stats', { token }).then((r) => { if (alive) setStats(r); }).catch(() => {});
    return () => { alive = false; };
  }, [bot.number, own, token]);

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/bots/' + bot.number, { method: 'PATCH', token, body: { nickname: form.nickname.trim(), bio: form.bio, public: form.public } });
      toast('已保存', 'success');
      onChanged?.();
    } catch (err) { toast(err.message, 'error'); } finally { setSaving(false); }
  };

  const max = stats?.total || Math.max(1, ...(stats?.ranking || []).map((r) => r.total));

  return (
    <Modal title={bot.nickname || bot.number} icon="bot" width={720} onClose={onClose}
      headerExtra={<span className={'pill' + (bot.online ? ' on' : '')}>{bot.online ? '在线' : '离线'}</span>}>
      <div className="bot-detail-head">
        <Avatar number={bot.number} nickname={bot.nickname} avatar={bot.avatar} size={64} square />
        <div className="bot-detail-id">
          <h3>{bot.nickname || '未命名 Bot'}</h3>
          <p className="bot-detail-number">{bot.number}<span className="tag">{own ? '我的 Bot' : 'Bot'}</span>{bot.public ? <span className="tag tag-accent">公开</span> : null}</p>
          <p className="bot-detail-bio">{bot.bio || '这个 Bot 还没有签名'}</p>
        </div>
        <div className="bot-detail-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onChat}><Icon name="chat" size={15} /> 发消息</button>
          {own ? <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onSwitch}>{busy ? <Spinner size={14} /> : <Icon name="refresh" size={15} />} 切换为 Bot</button> : null}
        </div>
      </div>

      {own ? <Tabs value={tab} onChange={setTab} tabs={[
        { id: 'overview', label: '资料与排行' },
        { id: 'model', label: '模型' },
        { id: 'link', label: '接入与连接' },
      ]} /> : null}

      {tab === 'overview' ? (
        <div className="bot-detail-body">
          {own ? (
            <div className="bot-form">
              <div className="bot-form-row">
                <label className="field"><span className="field-label">昵称</span><input className="input" maxLength={24} value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} /></label>
                <label className="field"><span className="field-label">公开到广场</span><div className="field-toggle"><Toggle checked={form.public} onChange={(v) => setForm({ ...form, public: v })} label="公开" /></div></label>
              </div>
              <label className="field"><span className="field-label">签名</span><textarea className="input textarea" rows={2} maxLength={80} value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></label>
              <div className="bot-form-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={saving} onClick={save}>{saving ? <Spinner size={14} /> : <Icon name="check" size={15} />} 保存资料</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setTokenOpen(true)}><Icon name="lock" size={15} /> 查看 Bot 令牌</button>
              </div>
            </div>
          ) : null}

          <section className="bot-stats">
            <header className="bot-stats-head">
              <h4><Icon name="grid" size={16} /> 发言排行</h4>
              <span className="bot-stats-total">共 {fmtCount(stats?.total || 0)} 条发言</span>
            </header>
            {stats === null ? <SkeletonList rows={3} /> : (stats.ranking || []).length === 0 ? (
              <Empty icon="chat" title="还没有发言记录" sub="和它聊几句，这里就会出现排行" compact />
            ) : (
              <div className="ranking">
                {stats.ranking.map((row, i) => (
                  <div className="rank-row" key={row.number}>
                    <span className={'rank-no' + (i < 3 ? ' top' : '')}>{i + 1}</span>
                    <Avatar number={row.number} nickname={row.nickname} size={26} />
                    <span className="rank-name">{row.number === me?.number ? '我' : row.nickname || row.number}</span>
                    <span className="rank-bar"><i style={{ width: Math.max(4, Math.round((row.total / max) * 100)) + '%' }} /></span>
                    <span className="rank-count">{fmtCount(row.total)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : null}

      {tab === 'model' ? (
        <ModelPanel token={token} bot={bot} />
      ) : null}

      {tab === 'link' ? (
        <div className="bot-detail-body">
          <LinkPanel token={token} bot={bot} link={link} onChanged={setLink} onCopy={onCopy} />
        </div>
      ) : null}

      {tokenOpen ? (
        <Modal title="Bot 令牌" icon="lock" width={480} onClose={() => setTokenOpen(false)}>
          <p className="modal-hint">接入框架时作为 Token 使用，不要外传。重新生成后旧令牌立即失效。</p>
          <CopyRow label="令牌" value={bot.token || '（列表里没有返回，请重新生成）'} onCopy={onCopy} />
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setTokenOpen(false)}>关闭</button>
            <button type="button" className="btn btn-primary" onClick={async () => {
              try { const r = await api('/api/bots/' + bot.number + '/token', { method: 'POST', token }); onCopy(r.token); onChanged?.(); } catch (err) { toast(err.message, 'error'); }
            }}><Icon name="refresh" size={15} /> 重新生成并复制</button>
          </div>
        </Modal>
      ) : null}
    </Modal>
  );
}

function CopyRow({ label, value, onCopy, mono = true }) {
  return (
    <div className="copy-row">
      <span className="copy-label">{label}</span>
      <div className="copy-value-row">
        <code className={'copy-value' + (mono ? ' mono' : '')}>{value}</code>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => onCopy(value)}><Icon name="copy" size={14} /> 复制</button>
      </div>
    </div>
  );
}

function ModelPanel({ token, bot }) {
  const [config, setConfig] = useState(null);
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const load = useCallback(async () => {
    try {
      const r = await api('/api/bots/' + bot.number + '/model', { token });
      setConfig(r.config);
      setForm({ base_url: r.config.base_url || '', api_key: r.config.api_key || '', model: r.config.model || '', persona: r.config.persona || '', temperature: r.config.temperature ?? 0.7, enabled: !!r.config.enabled });
    } catch (err) { toast(err.message, 'error'); }
  }, [bot.number, token]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy('save'); setMsg('');
    try {
      const r = await api('/api/bots/' + bot.number + '/model', { method: 'PUT', token, body: form });
      setConfig(r.config);
      setMsg('已保存');
      setTimeout(() => setMsg(''), 1800);
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setMsg('');
    try { const r = await api('/api/bots/' + bot.number + '/model/test', { method: 'POST', token }); setMsg('连通：' + r.reply); }
    catch (err) { setMsg('失败：' + err.message); } finally { setBusy(''); }
  };

  if (!form) return <div className="bot-detail-body"><SkeletonList rows={4} /></div>;
  return (
    <div className="bot-detail-body">
      <p className="modal-hint">不接框架时，Bot 可以用这里的模型自己回话；接入 AstrBot 后由框架负责回复。</p>
      <div className="bot-form">
        <label className="field"><span className="field-label">接口地址</span><input className="input" placeholder="https://api.example.com/v1" value={form.base_url} onChange={(e) => setForm({ ...form, base_url: e.target.value })} /></label>
        <label className="field"><span className="field-label">API Key {config?.has_key ? <span className="tag tag-ok">已配置</span> : null}</span><input className="input" type="password" placeholder="sk-..." value={form.api_key} onChange={(e) => setForm({ ...form, api_key: e.target.value })} /></label>
        <div className="bot-form-row">
          <label className="field"><span className="field-label">模型</span><input className="input" placeholder="deepseek-chat" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
          <label className="field"><span className="field-label">温度 {Number(form.temperature).toFixed(1)}</span><input className="range" type="range" min="0" max="2" step="0.1" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: Number(e.target.value) })} /></label>
        </div>
        <label className="field"><span className="field-label">人格设定</span><textarea className="input textarea" rows={3} maxLength={1000} placeholder="你是一个……" value={form.persona} onChange={(e) => setForm({ ...form, persona: e.target.value })} /></label>
        <label className="field field-inline"><Toggle checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} label="启用自带模型" /><span className="field-hint">开启后未接框架时由模型自动回复</span></label>
        <div className="bot-form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={save}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="check" size={15} />} 保存</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={test}>{busy === 'test' ? <Spinner size={14} /> : <Icon name="wifi" size={15} />} 测试连接</button>
          {msg ? <span className="bot-test-msg">{msg}</span> : null}
        </div>
      </div>
    </div>
  );
}

function LinkPanel({ token, bot, link, onChanged, onCopy }) {
  const [url, setUrl] = useState(link?.url || '');
  const [secret, setSecret] = useState(link?.token || '');
  const [connected, setConnected] = useState(!!link?.connected);
  const [busy, setBusy] = useState('');
  const [found, setFound] = useState(null);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    setUrl(link?.url || '');
    setSecret(link?.token || '');
    setConnected(!!link?.connected);
  }, [link]);

  const proto = typeof location !== 'undefined' && location.protocol === 'https:' ? 'wss' : 'ws';
  const reverseUrl = proto + '://' + (typeof location !== 'undefined' ? location.host : '') + '/onebot/v11/ws';

  const save = async (enabled) => {
    setBusy('save'); setMsg('');
    try {
      const r = await api('/api/bots/' + bot.number + '/link', { method: 'PUT', token, body: { url: url.trim(), token: secret.trim(), enabled } });
      onChanged?.(r.link);
      setConnected(!!r.link.connected);
      setMsg(enabled ? (r.link.connected ? '已连上' : '正在连接…') : '已断开');
    } catch (err) { setMsg(err.message); } finally { setBusy(''); }
  };
  const reconnect = async () => {
    setBusy('re'); setMsg('');
    try { const r = await api('/api/bots/' + bot.number + '/link/reconnect', { method: 'POST', token }); onChanged?.(r.link); setMsg(r.link?.connected ? '已连上' : '正在重连…'); }
    catch (err) { setMsg(err.message); } finally { setBusy(''); }
  };
  const scan = async () => {
    setBusy('scan'); setMsg('');
    try {
      const r = await api('/api/astrbot/platforms', { token });
      setFound(r.platforms || []);
      if (!r.platforms || r.platforms.length === 0) setMsg('这台电脑上没找到 AstrBot 的平台配置');
    } catch (err) { setMsg(err.message); } finally { setBusy(''); }
  };
  const pick = (item) => {
    setUrl('ws://127.0.0.1:' + item.port + '/ws');
    setSecret(item.token || '');
    setMsg('已填入「' + item.id + '」');
  };

  return (
    <div className="bot-form">
      <section className="link-section">
        <h4><Icon name="link" size={16} /> 让框架连过来（反向 WS）</h4>
        <p className="modal-hint">在 AstrBot 等框架里新建一个 OneBot 11 / aiocqhttp 平台，把下面三样填进去。填完后框架负责模型、人格和插件，这边只负责传话。</p>
        <CopyRow label="反向 WS 地址" value={reverseUrl} onCopy={onCopy} />
        <CopyRow label="令牌" value={bot.token || '（令牌未返回）'} onCopy={onCopy} />
        <CopyRow label="号码" value={String(bot.number)} onCopy={onCopy} mono={false} />
      </section>

      <section className="link-section">
        <h4><Icon name="wifi" size={16} /> 让 Bot 主动连到 AstrBot</h4>
        <p className="modal-hint">框架只开端口等人连，所以也可以这边主动连过去。填一次，之后自动重连。</p>
        <div className="bot-form-row">
          <label className="field"><span className="field-label">框架 WS 地址</span><input className="input" placeholder="ws://127.0.0.1:6199/ws" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <label className="field"><span className="field-label">框架 Token</span><input className="input" placeholder="可留空" value={secret} onChange={(e) => setSecret(e.target.value)} /></label>
        </div>
        <div className="bot-form-actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => save(true)}>{busy === 'save' ? <Spinner size={14} /> : <Icon name="link" size={15} />} {connected ? '重新连接' : '连接'}</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={() => save(false)}>断开</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={reconnect}>立即重连</button>
          <button type="button" className="btn btn-ghost btn-sm" disabled={!!busy} onClick={scan}>{busy === 'scan' ? <Spinner size={14} /> : <Icon name="search" size={15} />} 读取本机 AstrBot 平台</button>
          <span className={'pill' + (connected ? ' on' : '')}>{connected ? '已连接' : '未连接'}</span>
        </div>
        {found && found.length > 0 ? (
          <div className="link-found">
            {found.map((item) => (
              <button type="button" key={item.id} className="link-found-item" onClick={() => pick(item)}>
                <span className="link-found-name">{item.id}</span>
                <span className="link-found-sub">端口 {item.port}</span>
                <Icon name="arrowRight" size={15} />
              </button>
            ))}
          </div>
        ) : null}
        {msg ? <p className="bot-test-msg">{msg}</p> : null}
      </section>
    </div>
  );
}

function CreateBotModal({ token, onClose, onCreated }) {
  const [form, setForm] = useState({ number: '', nickname: '', bio: '', public: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const valid = /^\d{5,12}$/.test(form.number) && form.nickname.trim().length > 0;
  const submit = async () => {
    if (!valid) return;
    setBusy(true); setError('');
    try {
      const r = await api('/api/bots', { method: 'POST', token, body: { number: form.number, nickname: form.nickname.trim(), bio: form.bio, public: form.public } });
      toast('Bot 创建成功', 'success');
      onCreated(r.bot);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <Modal title="创建 Bot" icon="bot" width={480} onClose={onClose}>
      {error ? <div className="auth-error">{error}</div> : null}
      <div className="bot-form">
        <label className="field"><span className="field-label">号码</span><input className="input input-number" inputMode="numeric" placeholder="5–12 位数字" value={form.number} onChange={(e) => setForm({ ...form, number: e.target.value.replace(/\D/g, '').slice(0, 12) })} /></label>
        <label className="field"><span className="field-label">昵称</span><input className="input" maxLength={24} placeholder="给它起个名字" value={form.nickname} onChange={(e) => setForm({ ...form, nickname: e.target.value })} /></label>
        <label className="field"><span className="field-label">签名</span><textarea className="input textarea" rows={2} maxLength={80} placeholder="一句话介绍" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} /></label>
        <label className="field field-inline"><Toggle checked={form.public} onChange={(v) => setForm({ ...form, public: v })} label="公开到 Bot 广场" /><span className="field-hint">公开后别人可以在广场找到它</span></label>
      </div>
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>{busy ? <Spinner size={15} /> : <Icon name="bot" size={16} />} 创建</button>
      </div>
    </Modal>
  );
}
