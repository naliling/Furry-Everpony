import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import { Avatar, Confirm, Empty, Modal, SkeletonList, Spinner, Toggle, toast } from '../ui/primitives.jsx';
import { api, shrinkImage, SEND_MODE_KEY, NOTIFY_KEY, TOKEN_KEY, storageGet, storageSet, requestNotifyPermission, normalizeServerInfo } from '../lib/api.js';
import { fmtSize, relTime, statusMeta } from '../lib/format.js';
import { QrCode, QrScanner } from '../ui/qr.jsx';
import {
  CHAT_BG_EVENT,
  addChatBgFiles,
  clearChatBg,
  consumePendingAnchor,
  pickChatBg,
  readChatBg,
  readChatBgStyle,
  removeChatBgAt,
  resetChatBg,
  saveChatBgStyle,
} from '../lib/chatBg.js';

const THEMES = [
  { id: 'deep', name: '深空', sub: '默认 · 青紫霓虹', swatch: ['#060910', '#101a2b', '#22d3ee', '#a855f7'] },
  { id: 'violet', name: '暗夜紫', sub: '更浓郁的紫调', swatch: ['#0a0714', '#1b1030', '#c084fc', '#f0abfc'] },
  { id: 'light', name: '晨雾', sub: '浅色 · 柔和通透', swatch: ['#eef3fb', '#ffffff', '#0e7490', '#7c3aed'] },
];

const FONTS = [
  { id: 's', name: '小', sample: '14' },
  { id: 'm', name: '中', sample: '15' },
  { id: 'l', name: '大', sample: '16' },
];

export default function Settings({ token, me, theme, onTheme, font, onFont, onOpenNotifications, onOpenFavorites, notifCount = 0, onSwitchAccount, onAddAccount, onLogout, onMeChange, onGoTab }) {
  const [profile, setProfile] = useState({ nickname: me?.nickname || '', bio: me?.bio || '', status: me?.status || 'online' });
  const [savingProfile, setSavingProfile] = useState(false);
  const [pwd, setPwd] = useState({ oldPassword: '', newPassword: '', confirm: '' });
  const [pwdBusy, setPwdBusy] = useState(false);
  const [pwdError, setPwdError] = useState('');
  const [sendMode, setSendMode] = useState(() => storageGet(SEND_MODE_KEY) || 'enter');
  const [notify, setNotify] = useState(() => storageGet(NOTIFY_KEY) !== '0');
  const [server, setServer] = useState(null);
  const [closeToTray, setCloseToTray] = useState(false);
  const [lanAccess, setLanAccess] = useState(false);
  const [firewall, setFirewall] = useState({ busy: false, ok: false, text: '' });
  const isDesktop = typeof window !== 'undefined' && !!window.feWin;
  const [confirm, setConfirm] = useState(null);
  const [donateOpen, setDonateOpen] = useState(false);
  const [saved, setSaved] = useState('');
  const fileRef = useRef(null);

  /* ---- 我的邀请码（站里注册要凭邀请码，这里给自己一个，可发 5 次） ---- */
  const [invite, setInvite] = useState(null);
  useEffect(() => {
    api('/api/me/invite', { token }).then(setInvite).catch(() => setInvite(false));
  }, [token]);

  /* ---- 注销账号：1–3 天冷静期，到期自动真删 ---- */
  const [delPwd, setDelPwd] = useState('');
  const [delDays, setDelDays] = useState(3);
  const [delBusy, setDelBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(Number(me?.pendingDelete) || 0);
  useEffect(() => { setPendingDelete(Number(me?.pendingDelete) || 0); }, [me]);

  const submitDelete = async () => {
    if (!delPwd) { toast('先输入密码确认是你本人', 'error'); return; }
    setDelBusy(true);
    try {
      const r = await api('/api/me/delete', { method: 'POST', token, body: { password: delPwd, days: delDays } });
      setDelPwd('');
      setPendingDelete(Number(r.deleteAt) || Date.now());
      toast('已提交注销，' + delDays + ' 天后生效', 'success');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setDelBusy(false);
    }
  };

  const cancelDelete = async () => {
    try {
      await api('/api/me/delete/cancel', { method: 'POST', token });
      setPendingDelete(0);
      toast('已撤销注销', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  /* ---- 聊天背景：和聊天页的背景面板共用 lib/chatBg.js，localStorage 只有一份 ---- */
  const [chatBg, setChatBg] = useState(() => readChatBg());
  const [bgStyle, setBgStyle] = useState(() => readChatBgStyle());
  const [bgFlash, setBgFlash] = useState(false);
  const bgFileRef = useRef(null);
  const chatBgSectionRef = useRef(null);

  useEffect(() => {
    const sync = () => setChatBg(readChatBg());
    window.addEventListener(CHAT_BG_EVENT, sync);
    return () => window.removeEventListener(CHAT_BG_EVENT, sync);
  }, []);

  /* 从聊天页「在设置里管理全部背景」跳过来：滚到卡片再闪一下，省得用户翻半天 */
  useEffect(() => {
    if (consumePendingAnchor() !== 'chat-bg') return undefined;
    const t1 = window.setTimeout(() => {
      chatBgSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setBgFlash(true);
    }, 220);
    const t2 = window.setTimeout(() => setBgFlash(false), 2200);
    return () => { window.clearTimeout(t1); window.clearTimeout(t2); };
  }, []);

  const addChatBg = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      const next = await addChatBgFiles(chatBg, files);
      if (!next) { toast('这些图片没能读取，换一张试试', 'error'); return; }
      setChatBg(next);
      toast('已添加背景', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const chooseChatBg = (index) => {
    try { setChatBg(pickChatBg(chatBg, index)); } catch (err) { toast(err.message, 'error'); }
  };
  const delChatBg = (index) => {
    try { setChatBg(removeChatBgAt(chatBg, index)); } catch (err) { toast(err.message, 'error'); }
  };
  const resetChatBgAt = () => {
    try { setChatBg(resetChatBg(chatBg)); } catch (err) { toast(err.message, 'error'); }
  };
  const clearAllChatBg = () => {
    try { setChatBg(clearChatBg()); toast('已全部删除', 'success'); } catch (err) { toast(err.message, 'error'); }
  };

  /* ---- 资料卡：自定义背景 + 公开照片墙 ---- */
  const [cardBg, setCardBg] = useState(me?.card_bg || '');
  const [photos, setPhotos] = useState(() => (Array.isArray(me?.photos) ? me.photos : []));
  const cardBgFileRef = useRef(null);
  const photoFileRef = useRef(null);

  useEffect(() => {
    setCardBg(me?.card_bg || '');
    setPhotos(Array.isArray(me?.photos) ? me.photos : []);
  }, [me]);

  const pickCardBg = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const dataUrl = await shrinkImage(file, 1200, 'image/jpeg', 0.82);
      setCardBg(dataUrl);
      await saveProfile({ cardBg: dataUrl });
      toast('资料卡背景已更新', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const clearCardBg = async () => {
    setCardBg('');
    await saveProfile({ cardBg: '' });
  };

  const addPhotos = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    const next = [...photos];
    for (const file of files) {
      if (next.length >= 9) { toast('最多 9 张照片', 'error'); break; }
      try {
        next.push(await shrinkImage(file, 720, 'image/jpeg', 0.78));
      } catch (err) {
        toast(err.message, 'error');
      }
    }
    setPhotos(next);
    await saveProfile({ photos: next });
    toast('照片已更新', 'success');
  };

  const removePhoto = async (index) => {
    const next = photos.filter((_, i) => i !== index);
    setPhotos(next);
    await saveProfile({ photos: next });
  };

  useEffect(() => {
    setProfile({ nickname: me?.nickname || '', bio: me?.bio || '', status: me?.status || 'online' });
  }, [me]);

  useEffect(() => {
    api('/api/server-info', { token }).then((data) => setServer(normalizeServerInfo(data))).catch(() => setServer(false));
  }, [token]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.fe?.getPrefs) return;
    window.fe.getPrefs().then((prefs) => { setCloseToTray(!!prefs?.closeToTray); setLanAccess(!!prefs?.lanAccess); }).catch(() => {});
  }, []);

  const changeCloseToTray = async (value) => {
    setCloseToTray(value);
    try {
      await window.fe?.setPrefs?.({ closeToTray: value });
      toast(value ? '点叉会隐藏到托盘，托盘菜单可退出' : '点叉会直接退出应用', 'success');
    } catch {
      toast('设置失败', 'error');
    }
  };

  const changeLanAccess = async (value) => {
    setLanAccess(value);
    try {
      await window.fe?.setPrefs?.({ lanAccess: value });
      toast(value ? '已开启，重启应用后手机就能连' : '已关闭，重启应用后只有本机能连', 'success');
    } catch {
      toast('设置失败', 'error');
    }
  };

  const checkFirewall = async () => {
    if (!window.fe?.ensureFirewall) {
      toast('当前桌面端版本不支持自动放行，请手动在 Windows 防火墙放行 7788 端口', 'error');
      return;
    }
    setFirewall({ busy: true, ok: false, text: '' });
    try {
      const result = await window.fe.ensureFirewall();
      if (result?.ok) {
        setFirewall({ busy: false, ok: true, text: result.added ? '已添加防火墙规则，7788 端口放行' : '防火墙已放行 7788 端口' });
        toast('防火墙已放行', 'success');
      } else if (result?.needAdmin) {
        setFirewall({ busy: false, ok: false, text: '需要管理员权限。手动执行：' + (result.manualCommand || 'netsh advfirewall firewall add rule ...') });
      } else {
        setFirewall({ busy: false, ok: false, text: '放行失败：' + (result?.error || '未知原因') });
      }
    } catch (err) {
      setFirewall({ busy: false, ok: false, text: '放行失败：' + err.message });
    }
  };

  const saveProfile = async (patch) => {
    setSavingProfile(true);
    try {
      const data = await api('/api/me', { method: 'PATCH', token, body: patch });
      if (data.account) {
        setProfile({ nickname: data.account.nickname || '', bio: data.account.bio || '', status: data.account.status || 'online' });
        onMeChange?.(data.account);
      }
      setSaved('资料已保存');
      window.setTimeout(() => setSaved(''), 1800);
    } catch (err) { toast(err.message, 'error'); } finally { setSavingProfile(false); }
  };

  const pickAvatar = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      // 头像只要小图：256px 的 JPEG，几十 KB，任何主题下都够清晰
      const dataUrl = await shrinkImage(file, 256, 'image/jpeg', 0.9);
      await saveProfile({ avatar: dataUrl });
    } catch (err) { toast(err.message, 'error'); } finally { e.target.value = ''; }
  };

  const savePassword = async () => {
    setPwdError('');
    if (pwd.newPassword.length < 6) { setPwdError('新密码至少 6 位'); return; }
    if (pwd.newPassword !== pwd.confirm) { setPwdError('两次输入的新密码不一致'); return; }
    setPwdBusy(true);
    try {
      await api('/api/me/password', { method: 'POST', token, body: { oldPassword: pwd.oldPassword, newPassword: pwd.newPassword } });
      setPwd({ oldPassword: '', newPassword: '', confirm: '' });
      setSaved('密码已修改');
      window.setTimeout(() => setSaved(''), 1800);
    } catch (err) { setPwdError(err.message); } finally { setPwdBusy(false); }
  };

  const changeSendMode = (mode) => {
    setSendMode(mode);
    storageSet(SEND_MODE_KEY, mode);
  };

  const changeNotify = async (value) => {
    if (value) {
      const ok = await requestNotifyPermission();
      if (!ok) toast('浏览器没有授予通知权限，界面内仍会提示', 'info');
    }
    setNotify(value);
    storageSet(NOTIFY_KEY, value ? '1' : '0');
  };

  const clearLocal = () => {
    const keys = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('fe_draft_') || k.startsWith('fe_recent_emoji') || k.startsWith('fe_fav_emoji') || k.startsWith('fe_notify'))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
    toast('已清空 ' + keys.length + ' 项本地数据', 'success');
  };

  const copy = async (text) => {
    try { await navigator.clipboard.writeText(text); toast('已复制', 'success'); } catch { toast('复制失败', 'error'); }
  };

  const isAdmin = Boolean(me?.is_admin);
  const [adminStats, setAdminStats] = useState(null);
  useEffect(() => {
    if (!isAdmin) return undefined;
    let alive = true;
    api('/api/admin/overview', { token })
      .then((d) => { if (alive) setAdminStats(d?.counts || null); })
      .catch(() => { /* 不是管理员或服务端没开就静默 */ });
    return () => { alive = false; };
  }, [isAdmin, token]);

  /* 登录设备：能看到自己账号在哪些 IP、什么设备上登录着，可疑的一键踢掉 */
  const [sessions, setSessions] = useState(null);
  const loadSessions = useCallback(async () => {
    try {
      const data = await api('/api/me/sessions', { token });
      setSessions(data.sessions || []);
    } catch {
      setSessions([]);
    }
  }, [token]);
  useEffect(() => {
    loadSessions();
  }, [loadSessions]);

  const dropSession = async (id) => {
    try {
      await api('/api/me/sessions/' + id, { token, method: 'DELETE' });
      toast('已踢掉那台设备', 'success');
      await loadSessions();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const isBot = me?.type === 'bot';
  const platform = typeof window !== 'undefined' && window.fe?.platform ? window.fe.platform : '浏览器';

  return (
    <div className="settings-page">
      <header className="page-head">
        <div>
          <h2>我的</h2>
          <p className="page-sub">资料、外观、通知与关于</p>
        </div>
      </header>

      <div className="settings-body">
        {isAdmin ? (
          <section className="settings-card admin-entry">
            <header className="settings-card-head">
              <h3><Icon name="shield" size={17} /> 管理台</h3>
              <span className="admin-entry-tag">站长</span>
            </header>
            <p className="admin-entry-sub">这是你自己的站点，下面这些数字是真实数据，随时可查。</p>
            <div className="admin-entry-stats">
              <div><b>{adminStats ? adminStats.accounts : '—'}</b><span>账号</span></div>
              <div><b>{adminStats ? adminStats.bots : '—'}</b><span>Bot</span></div>
              <div><b>{adminStats ? adminStats.messages : '—'}</b><span>消息</span></div>
              <div><b>{adminStats ? adminStats.onlineNow : '—'}</b><span>在线</span></div>
            </div>
            <div className="admin-entry-actions">
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onGoTab?.('admin')}><Icon name="shield" size={15} /> 进入管理台</button>
              <span className="admin-entry-hint">封禁账号、上架下架 Bot、删消息、看站点数据</span>
            </div>
          </section>
        ) : null}
        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="friend" size={17} /> 个人资料</h3>{saved ? <span className="settings-saved">{saved}</span> : null}</header>
          <div className="settings-profile">
            <button type="button" className="avatar-edit" onClick={() => fileRef.current?.click()} title="更换头像">
              <Avatar number={me?.number} nickname={me?.nickname} avatar={me?.avatar} size={64} status={profile.status} />
              <span className="avatar-edit-hint" aria-hidden><Icon name="camera" size={13} /></span>
            </button>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={pickAvatar} />
            <div className="settings-profile-main">
              <div className="settings-profile-name">{me?.nickname || me?.number}<span className={'tag' + (isBot ? ' tag-accent' : '')}>{isBot ? 'Bot 号' : '个人号'}</span></div>
              <div className="settings-profile-number">{me?.number}{me?.fingerprint ? <span className="settings-fqid" title="完整地址">{me.fingerprint + '.' + me.number}</span> : null}</div>
              <div className="settings-profile-status"><span className={'status-dot tone-' + statusMeta(profile.status).tone} />{statusMeta(profile.status).label}</div>
            </div>
          </div>
          <div className="settings-grid2">
            <label className="field"><span className="field-label">昵称</span><input className="input" maxLength={24} value={profile.nickname} onChange={(e) => setProfile({ ...profile, nickname: e.target.value })} onBlur={() => { if (profile.nickname.trim() && profile.nickname !== me?.nickname) saveProfile({ nickname: profile.nickname.trim() }); }} /></label>
            <label className="field"><span className="field-label">在线状态</span>
              <select className="input select" value={profile.status} onChange={(e) => { setProfile({ ...profile, status: e.target.value }); saveProfile({ status: e.target.value }); }}>
                <option value="online">在线</option>
                <option value="away">离开</option>
                <option value="busy">忙碌</option>
                <option value="offline">离线</option>
                <option value="invisible">隐身（别人看到离线）</option>
              </select>
            </label>
          </div>
          <label className="field"><span className="field-label">个性签名</span><input className="input" maxLength={60} value={profile.bio} onChange={(e) => setProfile({ ...profile, bio: e.target.value })} onBlur={() => { if (profile.bio !== (me?.bio || '')) saveProfile({ bio: profile.bio }); }} placeholder="写一句介绍自己" /></label>
          <div className="settings-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={savingProfile} onClick={() => saveProfile({ nickname: profile.nickname.trim(), bio: profile.bio, status: profile.status })}>{savingProfile ? <Spinner size={14} /> : <Icon name="check" size={15} />} 保存资料</button>
            {isBot ? <span className="settings-hint"><Icon name="bot" size={14} /> 当前用 Bot 身份登录，切换账号可回到个人号</span> : null}
          </div>
        </section>

        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="palette" size={17} /> 外观</h3></header>
          <div className="theme-grid">
            {THEMES.map((t) => (
              <button type="button" key={t.id} className={'theme-card' + (theme === t.id ? ' on' : '')} onClick={() => onTheme?.(t.id)}>
                <span className="theme-preview" aria-hidden>
                  {t.swatch.map((color, i) => <i key={i} style={{ background: color }} />)}
                </span>
                <span className="theme-meta"><b>{t.name}</b><em>{t.sub}</em></span>
                {theme === t.id ? <Icon name="check" size={16} className="theme-check" /> : null}
              </button>
            ))}
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="font" size={16} /> 字号</b><span>影响整个界面的文字大小</span></div>
            <div className="segmented">
              {FONTS.map((f) => (
                <button type="button" key={f.id} className={font === f.id ? 'on' : ''} onClick={() => onFont?.(f.id)}>{f.name}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="keyboard" size={16} /> 发送方式</b><span>{sendMode === 'enter' ? 'Enter 发送，Shift+Enter 换行' : 'Ctrl+Enter 发送，Enter 换行'}</span></div>
            <div className="segmented">
              <button type="button" className={sendMode === 'enter' ? 'on' : ''} onClick={() => changeSendMode('enter')}>Enter 发送</button>
              <button type="button" className={sendMode === 'ctrl' ? 'on' : ''} onClick={() => changeSendMode('ctrl')}>Ctrl+Enter</button>
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="bell" size={16} /> 新消息通知</b><span>桌面通知与角标（浏览器需要授权）</span></div>
            <Toggle checked={notify} onChange={changeNotify} label="通知" />
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenNotifications}><Icon name="bell" size={15} /> 通知中心{notifCount > 0 ? '（' + notifCount + '）' : ''}</button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onOpenFavorites}><Icon name="bookmark" size={15} /> 我的收藏</button>
          </div>
        </section>

        <section className={'settings-card' + (bgFlash ? ' flash' : '')} id="settings-chat-bg" ref={chatBgSectionRef}>
          <header className="settings-card-head">
            <h3><Icon name="image" size={17} /> 聊天背景</h3>
            <span className="settings-hint">可以多选添加，最多 12 张</span>
          </header>
          <div className="bg-style-row">
            <label className="bg-style-field">
              <span>显示方式</span>
              <select className="input input-sm" value={bgStyle.fit} onChange={(e) => setBgStyle(saveChatBgStyle({ ...bgStyle, fit: e.target.value }))}>
                <option value="contain">完整显示（推荐）</option>
                <option value="cover">铺满裁切</option>
                <option value="repeat">平铺</option>
              </select>
            </label>
            <label className="bg-style-field">
              <span>对齐</span>
              <select className="input input-sm" value={bgStyle.pos} onChange={(e) => setBgStyle(saveChatBgStyle({ ...bgStyle, pos: e.target.value }))}>
                <option value="top">靠上</option>
                <option value="center">居中</option>
                <option value="bottom">靠下</option>
                <option value="left">靠左</option>
                <option value="right">靠右</option>
                <option value="top left">左上</option>
                <option value="top right">右上</option>
                <option value="bottom left">左下</option>
                <option value="bottom right">右下</option>
              </select>
            </label>
          </div>
          <div className="bg-grid">
            <button
              type="button"
              className={'bg-cell bg-none' + (chatBg.current < 0 ? ' on' : '')}
              onClick={resetChatBgAt}
              title="用主题默认背景"
            >
              <Icon name="palette" size={20} />
              <span>默认</span>
            </button>
            {chatBg.list.map((src, i) => (
              <div key={i} className={'bg-cell' + (chatBg.current === i ? ' on' : '')}>
                <button type="button" className="bg-pick" onClick={() => chooseChatBg(i)} title={'使用第 ' + (i + 1) + ' 张背景'}>
                  <img src={src} alt={'背景 ' + (i + 1)} />
                </button>
                <button type="button" className="bg-del" onClick={() => delChatBg(i)} title="删除这张背景" aria-label="删除这张背景">
                  <Icon name="close" size={12} />
                </button>
              </div>
            ))}
            <button type="button" className="bg-cell bg-add" onClick={() => bgFileRef.current?.click()} title="添加背景图">
              <Icon name="plus" size={20} />
              <span>添加</span>
            </button>
          </div>
          <input ref={bgFileRef} type="file" accept="image/*" multiple hidden onChange={addChatBg} />
          <div className="settings-actions">
            <span className="settings-hint">当前：{chatBg.current < 0 ? '默认背景' : '第 ' + (chatBg.current + 1) + ' 张'}</span>
            {chatBg.list.length ? <button type="button" className="btn btn-ghost btn-sm" onClick={clearAllChatBg}><Icon name="trash" size={15} /> 全部删除</button> : null}
          </div>
        </section>

        <section className="settings-card">
          <header className="settings-card-head">
            <h3><Icon name="heart" size={17} /> 资料卡</h3>
            <span className="settings-hint">别人点开你的资料时能看到</span>
          </header>
          <div className="card-bg-preview" style={cardBg ? { backgroundImage: 'url("' + cardBg + '")' } : undefined}>
            {!cardBg ? <span>还没有资料卡背景</span> : null}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => cardBgFileRef.current?.click()}><Icon name="image" size={15} /> {cardBg ? '换一张背景' : '上传背景'}</button>
            {cardBg ? <button type="button" className="btn btn-ghost btn-sm" onClick={clearCardBg}><Icon name="trash" size={15} /> 去掉背景</button> : null}
          </div>
          <input ref={cardBgFileRef} type="file" accept="image/*" hidden onChange={pickCardBg} />

          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="image" size={16} /> 公开照片</b><span>最多 9 张，好友点开资料卡可以翻看</span></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => photoFileRef.current?.click()}><Icon name="plus" size={15} /> 添加照片</button>
          </div>
          <input ref={photoFileRef} type="file" accept="image/*" multiple hidden onChange={addPhotos} />
          {photos.length ? (
            <div className="photo-grid">
              {photos.map((src, i) => (
                <div key={i} className="photo-cell">
                  <img src={src} alt={'照片 ' + (i + 1)} />
                  <button type="button" className="photo-del" onClick={() => removePhoto(i)} title="删除这张照片"><Icon name="close" size={12} /></button>
                </div>
              ))}
            </div>
          ) : (
            <div className="settings-hint">还没有公开照片</div>
          )}
        </section>

        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="lock" size={17} /> 账号与安全</h3></header>
          <div className="settings-grid3">
            <label className="field"><span className="field-label">当前密码</span><input className="input" type="password" autoComplete="current-password" value={pwd.oldPassword} onChange={(e) => setPwd({ ...pwd, oldPassword: e.target.value })} /></label>
            <label className="field"><span className="field-label">新密码</span><input className="input" type="password" autoComplete="new-password" value={pwd.newPassword} onChange={(e) => setPwd({ ...pwd, newPassword: e.target.value })} /></label>
            <label className="field"><span className="field-label">确认新密码</span><input className="input" type="password" autoComplete="new-password" value={pwd.confirm} onChange={(e) => setPwd({ ...pwd, confirm: e.target.value })} /></label>
          </div>
          {pwdError ? <div className="auth-error">{pwdError}</div> : null}
          <div className="settings-actions">
            <button type="button" className="btn btn-primary btn-sm" disabled={pwdBusy || !pwd.oldPassword || !pwd.newPassword} onClick={savePassword}>{pwdBusy ? <Spinner size={14} /> : <Icon name="lock" size={15} />} 修改密码</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="refresh" size={16} /> 切换账号</b><span>本地记住的账号可以一键切换</span></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onSwitchAccount}>切换账号</button>
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="plus" size={16} /> 添加账号</b><span>用另一个号码登录，当前账号会被记住</span></div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onAddAccount}>添加账号</button>
          </div>
          <div className="settings-devices">
            <div className="settings-devices-head">
              <b><Icon name="monitor" size={16} /> 登录设备</b>
              <button type="button" className="btn btn-ghost btn-sm" onClick={loadSessions}><Icon name="refresh" size={14} /> 刷新</button>
            </div>
            <p className="settings-devices-sub">这是你的账号最近登录过的设备和 IP。看到不认识的就踢掉，然后改密码。</p>
            {sessions === null ? (
              <div className="settings-devices-empty"><Spinner size={14} /> 读取中…</div>
            ) : sessions.length === 0 ? (
              <div className="settings-devices-empty">还没有记录</div>
            ) : (
              <div className="settings-devices-list">
                {sessions.map((d) => (
                  <div className="settings-device" key={d.id}>
                    <div className="settings-device-main">
                      <b>{d.device || '未知设备'}{d.current ? <em className="settings-device-now">本机</em> : null}</b>
                      <span>IP {d.ip || '未知'} · {relTime(d.last_seen || d.created_at)}活跃</span>
                    </div>
                    {d.current ? null : (
                      <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => dropSession(d.id)}>踢掉</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="settings-actions">
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setConfirm({ title: '退出登录', message: '退出后需要重新输入号码和密码，本地账号记录会保留。', danger: true, onConfirm: () => onLogout?.() })}><Icon name="logout" size={15} /> 退出登录</button>
          </div>
        </section>

        <section className="settings-card">
          <header className="settings-card-head">
            <h3><Icon name="mail" size={17} /> 我的邀请码</h3>
            {invite && invite.maxUses ? <span className="settings-hint">已用 {invite.used || 0}/{invite.maxUses}</span> : null}
          </header>
          {invite === null ? <SkeletonList rows={1} /> : invite === false ? (
            <p className="settings-hint">没读到邀请码，刷新一下再试。</p>
          ) : (
            <>
              <p className="settings-hint">站里注册要凭邀请码。把下面这串发给朋友，他们就能注册进来，一共 5 个名额。</p>
              <div className="invite-box">
                <code>{invite.code}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(invite.code)}><Icon name="copy" size={14} /> 复制</button>
              </div>
            </>
          )}
        </section>

        {isDesktop ? (
          <section className="settings-card">
            <header className="settings-card-head"><h3><Icon name="monitor" size={17} /> 桌面窗口</h3></header>
            <div className="settings-row">
              <div className="settings-row-main"><b><Icon name="close" size={16} /> 点叉时最小化到托盘</b><span>{closeToTray ? '点右上角叉号会隐藏到托盘，程序继续后台运行' : '默认：点右上角叉号直接退出程序'}</span></div>
              <Toggle checked={closeToTray} onChange={changeCloseToTray} label="关闭到托盘" />
            </div>
            <div className="settings-row">
              <div className="settings-row-main"><b><Icon name="maximize" size={16} /> 全屏</b><span>也可以随时按 F11 切换全屏</span></div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.feWin?.toggleFullscreen?.()}>切换全屏 (F11)</button>
            </div>
            <div className="settings-row">
              <div className="settings-row-main"><b><Icon name="logout" size={16} /> 退出应用</b><span>完全关闭程序（不只是最小化到托盘）</span></div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => window.fe?.quitApp?.()}>退出应用</button>
            </div>
          </section>
        ) : null}

        {/* 访问入口是站长自己的运维信息，别人看不到，也不需要看到 */}
        {isAdmin ? (
        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="wifi" size={17} /> 访问入口</h3></header>
          {server && (server.lan?.length || server.lanUrls?.length) ? (
            <div className="access-block">
              <div className="access-main">
                <b><Icon name="wifi" size={16} /> 同一个 Wi-Fi 下</b>
                <span>手机连同一个 Wi-Fi，用浏览器打开下面的地址就能进，不需要装任何东西</span>
                <div className="access-urls">
                  {(server.lan?.length ? server.lan : (server.lanUrls || []).map((url, i) => ({ url, name: server.lanNames?.[i] || '' }))).map((item) => (
                    <button type="button" key={item.url} className="about-url" onClick={() => copy(item.url)} title="点击复制">
                      <code>{item.url}</code>
                      {item.name ? <em className="about-url-nic">{item.name}</em> : null}
                      <Icon name="copy" size={14} />
                    </button>
                  ))}
                </div>
              </div>
              <div className="access-qr">
                <QrCode text={(server.lan?.[0]?.url) || server.lanUrls?.[0] || ''} size={124} />
                <span>手机扫码直接打开</span>
              </div>
            </div>
          ) : server === null ? (
            <SkeletonList rows={2} />
          ) : (
            <p className="settings-hint">没读到局域网地址。电脑和手机要在同一个 Wi-Fi 下，或者直接用外网地址。</p>
          )}

          <div className="settings-row">
            <div className="settings-row-main">
              <b><Icon name="globe" size={16} /> 外网地址</b>
              <span>{server && server.tunnel ? '不在同一个 Wi-Fi 也能用，别人在任何网络下都能打开' : '外网地址由服务端自动建立，就绪后会自动出现在这里，不需要你操作'}</span>
            </div>
            {server && server.tunnel ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(server.tunnel)}><Icon name="copy" size={15} /> 复制</button>
            ) : <span className="settings-hint">准备中</span>}
          </div>
          {server && server.tunnel ? (
            <div className="access-urls">
              <button type="button" className="about-url" onClick={() => copy(server.tunnel)} title="点击复制">
                <code>{server.tunnel}</code>
                <Icon name="copy" size={14} />
              </button>
            </div>
          ) : null}

          <div className="settings-row">
            <div className="settings-row-main">
              <b><Icon name="shield" size={16} /> 端口与防火墙</b>
              <span>服务端监听 {server?.port || 7788} 端口；手机连不上时先在 Windows 防火墙放行这个端口</span>
            </div>
            <code className="settings-code">netsh advfirewall firewall add rule name="Everony 7788" dir=in action=allow protocol=TCP localport=7788</code>
          </div>

          {me?.is_admin ? (
            <div className="settings-row">
              <div className="settings-row-main">
                <b><Icon name="shield" size={16} /> 管理后台</b>
                <span>账号封禁、Bot 上架、消息管理、站点统计</span>
              </div>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => onGoTab?.('admin')}><Icon name="shield" size={15} /> 打开管理</button>
            </div>
          ) : null}
        </section>
        ) : null}

        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="info" size={17} /> 关于</h3></header>
          {server === null ? <SkeletonList rows={2} /> : (
            <>
              <div className="about-list">
                <div className="about-row"><span>版本</span><b>{server === false ? '—' : server.version || '—'}</b></div>
                <div className="about-row"><span>平台</span><b>{platform}</b></div>
                <div className="about-row"><span>我的号码</span><b>{me?.number || '—'}</b></div>
              </div>

              <div className="about-block">
                <b>Everony 是什么</b>
                <p>一个自己开的聊天站。账号、消息、Bot 全都跑在一台机器上，数据只留在那台机器里，不经过任何第三方服务器。打开浏览器就能用，手机电脑都行。</p>
              </div>

              <div className="about-block">
                <b>为什么做它</b>
                <p>主流聊天软件把你的账号、好友关系、聊天记录都放在别人的服务器上；想换个地方说话，就得把整个社交圈一起搬走。Everony 反过来：站是你的，数据是你的，号码是你的。你可以在自己的电脑上开一个站，喊朋友进来；也可以随时关掉它，什么都不留。</p>
              </div>

              <div className="about-block">
                <b>它能干什么</b>
                <ul className="about-points">
                  <li><b>用号码找到人</b><span>每个人一个固定号码，像门牌号，加好友、开群聊都靠它。</span></li>
                  <li><b>Bot 就住在站里</b><span>你建的 Bot 有自己的号码和密码，登录进去就是它的身份，资料由你改。</span></li>
                  <li><b>数据有期限</b><span>消息默认只留 14 天，站长可调，过期自动清掉，不占硬盘。</span></li>
                  <li><b>不装软件也能用</b><span>手机扫个码就在浏览器里聊，电脑上可以直接钉在桌面。</span></li>
                </ul>
              </div>

              <p className="settings-hint">这一版还在改，看到不顺眼的地方直接跟站长说。</p>
            </>
          )}
        </section>

        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="heart" size={17} /> 支持这个站</h3></header>
          <p className="settings-hint">
            这个站没有广告、没有会员、不卖数据。域名、服务器、电费都是站长自己出，Bot 也是站长自己在养。
            想让它活得久一点，可以跟站长说一声，或者把你的 Bot 挂到广场上，多一个人聊它就多一分意义。
          </p>
          <div className="settings-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDonateOpen(true)}>
              我想支持
            </button>
          </div>
          {donateOpen ? (
            <Modal title="支持这个站" icon="heart" onClose={() => setDonateOpen(false)} width={420}>
              <div className="donate-box">
                {Array.isArray(server?.donationImages) && server.donationImages.length ? (
                  <div className="donate-img-grid">
                    {server.donationImages.map((src, i) => <img className="donate-img" key={i} src={src} alt={'收款码 ' + (i + 1)} />)}
                  </div>
                ) : server?.donationImage ? (
                  <img className="donate-img" src={server.donationImage} alt="转账" />
                ) : server?.donationLink ? (
                  <div className="donate-empty"><Icon name="link" size={22} /> 扫码或点下方链接支持</div>
                ) : (
                  <div className="donate-empty"><Icon name="heart" size={22} /> 站长还没配置转账方式，跟站长说一声就行</div>
                )}
                {server?.donationLink ? (
                  <a className="btn btn-primary btn-sm donate-link" href={server.donationLink} target="_blank" rel="noopener noreferrer">
                    <Icon name="link" size={15} /> 打开转账链接
                  </a>
                ) : null}
              </div>
            </Modal>
          ) : null}
        </section>

        <section className="settings-card settings-danger">
          <header className="settings-card-head"><h3><Icon name="warning" size={17} /> 危险操作</h3></header>
          <div className="settings-row">
            <div className="settings-row-main">
              <b>清空本地数据</b>
              <span className="danger-note">会清空草稿、最近表情、通知设置、聊天背景等本地缓存；本地保存的账号和登录状态会保留。清空后无法恢复。</span>
            </div>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              onClick={() =>
                setConfirm({
                  title: '清空本地数据？',
                  message: '草稿、最近表情、通知设置、聊天背景都会被删掉，无法恢复。账号与登录状态不受影响。',
                  danger: true,
                  confirmText: '确定清空',
                  onConfirm: clearLocal,
                })
              }
            >
              <Icon name="trash" size={15} /> 清空本地数据
            </button>
          </div>

          <div className="settings-row settings-row-col">
            <div className="settings-row-main">
              <b>注销账号</b>
              <span className="danger-note">
                {pendingDelete > 0
                  ? '已申请注销，' + new Date(pendingDelete).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' 生效。这期间登录回来点下面的按钮就能撤销。'
                  : '提交后进入冷静期，1–3 天里随时可以撤销；到期后账号和它的消息会被真的删掉，找不回来。'}
              </span>
            </div>
            {pendingDelete > 0 ? (
              <button type="button" className="btn btn-ghost btn-sm" onClick={cancelDelete}><Icon name="refresh" size={15} /> 撤销注销</button>
            ) : (
              <div className="danger-inline">
                <input className="input" type="password" placeholder="输入密码确认" value={delPwd} onChange={(e) => setDelPwd(e.target.value)} />
                <div className="segmented">
                  {[1, 2, 3].map((d) => (
                    <button type="button" key={d} className={delDays === d ? 'on' : ''} onClick={() => setDelDays(d)}>{d} 天</button>
                  ))}
                </div>
                <button type="button" className="btn btn-danger btn-sm" disabled={delBusy || !delPwd} onClick={() => setConfirm({ title: '注销账号？', message: '提交后 ' + delDays + ' 天内可以撤销，到期后账号、好友关系、消息全部删除，无法恢复。', danger: true, confirmText: '确定注销', onConfirm: submitDelete })}>
                  {delBusy ? <Spinner size={14} /> : <Icon name="trash" size={15} />} 注销
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {confirm ? <Confirm title={confirm.title} message={confirm.message} danger={confirm.danger} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}
