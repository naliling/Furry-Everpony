import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import { Avatar, Confirm, Empty, SkeletonList, Spinner, Toggle, toast } from '../ui/primitives.jsx';
import { api, shrinkImage, SEND_MODE_KEY, NOTIFY_KEY, TOKEN_KEY, storageGet, storageSet, requestNotifyPermission, normalizeServerInfo } from '../lib/api.js';
import { fmtSize, statusMeta } from '../lib/format.js';
import { QrCode, QrScanner } from '../ui/qr.jsx';
import {
  CHAT_BG_EVENT,
  addChatBgFiles,
  clearChatBg,
  consumePendingAnchor,
  pickChatBg,
  readChatBg,
  removeChatBgAt,
  resetChatBg,
} from '../lib/chatBg.js';

const THEMES = [
  { id: 'deep', name: '深空', sub: '默认 · 青紫霓虹', swatch: ['#060910', '#101a2b', '#22d3ee', '#a855f7'] },
  { id: 'violet', name: '暗夜紫', sub: '更浓郁的紫调', swatch: ['#0a0714', '#1b1030', '#c084fc', '#f0abfc'] },
  { id: 'light', name: '晨雾', sub: '浅色 · 柔和通透', swatch: ['#eef3fb', '#ffffff', '#0e7490', '#7c3aed'] },
];

const AVATAR_FRAMES = [
  { id: 'none', name: '无' },
  { id: 'neon', name: '霓虹' },
  { id: 'gold', name: '鎏金' },
  { id: 'candy', name: '糖果' },
  { id: 'pixel', name: '像素' },
  { id: 'orbit', name: '星环' },
];

const NAME_FONTS = [
  { id: 'default', name: '默认' },
  { id: 'round', name: '圆润' },
  { id: 'serif', name: '衬线' },
  { id: 'mono', name: '等宽' },
  { id: 'bold', name: '加粗' },
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
  const [saved, setSaved] = useState('');
  const fileRef = useRef(null);

  /* ---- 头像框 / 昵称字体（本地偏好，套在 html 上让全局 CSS 生效） ---- */
  const [frame, setFrame] = useState(() => storageGet('fe_avatar_frame') || 'none');
  const [nameFont, setNameFont] = useState(() => storageGet('fe_name_font') || 'default');

  useEffect(() => {
    document.documentElement.dataset.avatarFrame = frame;
    storageSet('fe_avatar_frame', frame);
  }, [frame]);

  useEffect(() => {
    document.documentElement.dataset.nameFont = nameFont;
    storageSet('fe_name_font', nameFont);
  }, [nameFont]);

  /* ---- 聊天背景：和聊天页的背景面板共用 lib/chatBg.js，localStorage 只有一份 ---- */
  const [chatBg, setChatBg] = useState(() => readChatBg());
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
            <div className="settings-row-main"><b><Icon name="smile" size={16} /> 头像框</b><span>给头像套一圈内置边框，本机生效</span></div>
            <div className="segmented">
              {AVATAR_FRAMES.map((item) => (
                <button type="button" key={item.id} className={frame === item.id ? 'on' : ''} onClick={() => setFrame(item.id)}>{item.name}</button>
              ))}
            </div>
          </div>
          <div className="settings-row">
            <div className="settings-row-main"><b><Icon name="font" size={16} /> 昵称字体</b><span>只改昵称的字体，不动正文</span></div>
            <div className="segmented">
              {NAME_FONTS.map((item) => (
                <button type="button" key={item.id} className={nameFont === item.id ? 'on' : ''} onClick={() => setNameFont(item.id)}>{item.name}</button>
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
          <div className="settings-actions">
            <button type="button" className="btn btn-danger-ghost btn-sm" onClick={() => setConfirm({ title: '退出登录', message: '退出后需要重新输入号码和密码，本地账号记录会保留。', danger: true, onConfirm: () => onLogout?.() })}><Icon name="logout" size={15} /> 退出登录</button>
          </div>
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

        <FederationCard token={token} />

        <BackupCard token={token} />

        <section className="settings-card">
          <header className="settings-card-head"><h3><Icon name="info" size={17} /> 关于</h3></header>
          {server === null ? <SkeletonList rows={2} /> : server === false ? <p className="settings-hint">读取实例信息失败，可能服务端版本较旧。</p> : (
            <div className="about-list">
              <div className="about-row"><span>版本</span><b>{server.version || '—'}</b></div>
              <div className="about-row"><span>平台</span><b>{platform}</b></div>
              <div className="about-row"><span>监听地址</span><b>{server.host === '::' ? '全部网卡（IPv4 + IPv6）' : server.host || '0.0.0.0'}:{server.port || '—'}</b></div>
              <div className="about-row"><span>局域网可访问</span><b>{server.boundToLan ? '是' : '否'}</b></div>
              {server.lanUrls?.length ? (
                <div className="about-lan">
                  <span>手机访问地址</span>
                  {server.lanUrls.map((url) => (
                    <button type="button" key={url} className="about-url" onClick={() => copy(url)} title="点击复制">
                      <code>{url}</code><Icon name="copy" size={14} />
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="about-row"><span>我的号码</span><b>{me?.number || '—'}</b></div>
              <p className="settings-hint">Everony 是自托管、去中心化的聊天软件：每个实例有自己的数据库和用户，实例之间可以互加好友。<br />数据都在你自己的电脑上，换台机器请备份 data 目录。</p>
            </div>
          )}
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
        </section>
      </div>

      {confirm ? <Confirm title={confirm.title} message={confirm.message} danger={confirm.danger} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}

/* ---------------- 实例互联：我的地址 + 附近的实例 ---------------- */
function FederationCard({ token }) {
  const [info, setInfo] = useState(null);
  const [nearby, setNearby] = useState([]);
  const [addr, setAddr] = useState('');
  const [relayUrl, setRelayUrl] = useState('');
  const [relayBusy, setRelayBusy] = useState(false);
  const [host, setHost] = useState(null);
  const [scanRelay, setScanRelay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const [i, n, h] = await Promise.all([
        api('/api/federation/info', { token }).catch(() => null),
        api('/api/federation/nearby', { token }).catch(() => ({ instances: [] })),
        api('/api/relay/host', { token }).catch(() => null),
      ]);
      setInfo(i);
      if (h) setHost(h);
      if (i?.publicAddr) setAddr(i.publicAddr);
      /* 只在第一次填进来，别把用户正在输入的内容每 6 秒覆盖掉 */
      setRelayUrl((old) => old || i?.relay?.url || '');
      setNearby((n.instances || []).filter((x) => x.instanceId !== i?.instanceId));
    } catch {
      /* 忽略 */
    }
  }, [token]);

  useEffect(() => {
    load();
    /* 附近实例靠 UDP 广播发现，定时刷新即可看到刚上线的设备 */
    const timer = setInterval(load, 6000);
    return () => clearInterval(timer);
  }, [load]);

  const save = async () => {
    setBusy(true);
    setErr('');
    try {
      const out = await api('/api/federation/settings', { method: 'PATCH', token, body: { publicAddr: addr.trim(), autoAccept: info?.autoAccept } });
      setInfo((old) => ({ ...(old || {}), publicAddr: out.publicAddr }));
      toast(addr.trim() ? '已保存对外地址' : '已清空对外地址', 'success');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const saveRelay = async () => {
    setRelayBusy(true);
    setErr('');
    try {
      const out = await api('/api/relay/settings', { method: 'PATCH', token, body: { url: relayUrl.trim() } });
      setInfo((old) => ({ ...(old || {}), relay: { ...(old?.relay || {}), enabled: out.enabled, url: out.url, registered: out.registered, lastError: out.lastError } }));
      if (!out.enabled) toast('已关闭中继，只走直连', 'success');
      else if (out.registered) toast('中继已连上：' + out.url, 'success');
      else toast('中继地址已保存，但还没连上' + (out.registerError ? '：' + out.registerError : ''), 'error');
    } catch (e) {
      setErr(e.message);
    } finally {
      setRelayBusy(false);
    }
  };

  const toggleHost = async (next) => {
    setHost((old) => ({ ...(old || {}), enabled: next, state: next ? 'starting' : 'off' }));
    try {
      const out = await api('/api/relay/host', { method: 'POST', token, body: { enabled: next } });
      setHost(out);
      if (!next) toast('已关闭本机中转站', 'success');
      else if (out.state === 'error') toast(out.error || '开启失败', 'error');
      else if (out.url) toast('中转站已开：' + out.url, 'success');
      else toast('正在启动隧道，十几秒后再看这里', 'success');
    } catch (e) {
      setHost((old) => ({ ...(old || {}), enabled: !next }));
      toast(e.message, 'error');
    }
  };

  const copyText = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      toast('已复制：' + text, 'success');
    } catch {
      toast(text, 'success');
    }
  };

  const mine = info?.publicAddr || info?.myAddresses?.[0] || '';

  return (
    <section className="settings-card">
      <header className="settings-card-head"><h3><Icon name="link" size={17} /> 实例互联</h3></header>
      <p className="settings-hint">每个实例就是一台电脑上的独立服务。把自己的地址给对方、把对方的地址填进来，就能跨实例加好友、聊天，不需要任何中心服务器。</p>

      {/* 中心服务器模式：手机/别的电脑在登录页填这里显示的地址，就都连到这台服务器 */}
      <div className="settings-row settings-row-server">
        <div className="settings-row-main">
          <b><Icon name="wifi" size={16} /> 手机/别的电脑连我这台服务器</b>
          <span>
            登录页的「服务器」里填下面这条，然后用自己的号码登录：同一个 Wi-Fi 填局域网地址，不同网络填公网地址。
          </span>
          <div className="settings-server-list">
            {info?.myAddresses?.[0] ? (
              <div className="settings-server-item">
                <em>局域网</em>
                <code>{info.myAddresses[0]}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(info.myAddresses[0])}>
                  <Icon name="copy" size={13} /> 复制
                </button>
              </div>
            ) : null}
            {host?.url || info?.relay?.publicUrl ? (
              <div className="settings-server-item">
                <em>公网</em>
                <code>{host?.url || info?.relay?.publicUrl}</code>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(host?.url || info?.relay?.publicUrl)}>
                  <Icon name="copy" size={13} /> 复制
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="link" size={16} /> 我的实例地址</b>
          <span>{mine ? mine : '还没探测到可用地址，可以在下面手动填写（例如 1.2.3.4:7788）'}</span>
        </div>
        {mine ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(mine)}><Icon name="copy" size={14} /> 复制</button> : null}
      </div>

      {info?.publicV6?.length ? (
        <div className="settings-row">
          <div className="settings-row-main">
            <b><Icon name="qr" size={16} /> 公网 IPv6（不在同一个 Wi-Fi 也能被连上）</b>
            <span>{info.publicV6.join('   ')}</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(info.publicV6[0])}><Icon name="copy" size={14} /> 复制</button>
        </div>
      ) : (
        <p className="settings-hint">这台电脑没有探测到公网 IPv6。没有 IPv6 时，跨网络只能靠下面手填公网 IP 或 DDNS。</p>
      )}

      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="check" size={16} /> 自动通过好友</b>
          <span>{info?.autoAccept ? '开着：别人拿我的邀请码/二维码加我，直接成为好友，我不用点同意' : '关着：别人加我，我要在「新朋友」里点同意'}</span>
        </div>
        <Toggle
          label="自动通过好友"
          checked={!!info?.autoAccept}
          onChange={async (next) => {
            setInfo((old) => ({ ...(old || {}), autoAccept: next }));
            try {
              const out = await api('/api/federation/settings', { method: 'PATCH', token, body: { autoAccept: next } });
              setInfo((old) => ({ ...(old || {}), autoAccept: out.autoAccept }));
              toast(next ? '已开启自动通过' : '已关闭自动通过', 'success');
            } catch (e) {
              setInfo((old) => ({ ...(old || {}), autoAccept: !next }));
              toast(e.message, 'error');
            }
          }}
        />
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="shield" size={16} /> 中继服务器（跨网络兜底）</b>
          <span>
            {info?.relay?.enabled
              ? info.relay.registered
                ? '已连上 ' + info.relay.url + '：两边直连不通时，好友申请和消息会经中继排队，对方上线后自动收到'
                : '地址已保存，但还没连上' + (info.relay.lastError ? '：' + info.relay.lastError : '')
              : '没配：只能靠直连（同一个 Wi-Fi，或对方有公网地址）。配一台中继后，两边不同网络也能加好友、发消息'}
          </span>
        </div>
      </div>

      <div className="fed-row">
        <label className="field">
          <span className="field-label">中继地址（留空 = 只用直连）</span>
          <div className="input-wrap">
            <Icon name="shield" size={15} className="input-lead" />
            <input className="input" placeholder="例如 relay.example.com:7800" value={relayUrl} onChange={(e) => setRelayUrl(e.target.value.trim())} />
          </div>
        </label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setScanRelay(true)}><Icon name="qr" size={14} /> 扫码</button>
        <button type="button" className="btn btn-primary btn-sm" disabled={relayBusy} onClick={saveRelay}>{relayBusy ? <Spinner size={14} /> : null} 保存</button>
      </div>

      {host ? (
      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="link" size={16} /> 把这台电脑做成中转站</b>
          <span>
            {host?.state === 'running' && host?.url
              ? '公网地址：' + host.url + '（手机扫下面的二维码就能填好）'
              : host?.enabled
                ? host.state === 'error'
                  ? '开启失败：' + (host.error || '未知原因')
                  : '正在启动隧道…第一次要下载约 55MB，稍等十几秒'
                : '开着它，这台电脑就是一台公网中继：别的设备不在同一个网络也能加好友、发消息（电脑要一直开着）'}
          </span>
        </div>
        <Toggle label="本机做中转站" checked={!!host?.enabled} onChange={toggleHost} />
      </div>
      ) : null}

      {host?.url ? (
        <div className="fed-host">
          <div className="fed-host-main">
            <b>手机扫这个码</b>
            <span>扫完自动填好中继地址，不用手打</span>
          </div>
          <QrCode text={host.url} size={150} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => copyText(host.url)}><Icon name="copy" size={14} /> 复制地址</button>
        </div>
      ) : null}

      {scanRelay ? (
        <QrScanner
          title="扫电脑上的中转地址"
          onClose={() => setScanRelay(false)}
          onResult={(text) => {
            setScanRelay(false);
            setRelayUrl(String(text || '').trim());
            toast('已扫到：' + text, 'success');
          }}
        />
      ) : null}

      <div className="fed-row">
        <label className="field">
          <span className="field-label">对外地址（跨网络时填公网 IP / DDNS）</span>
          <div className="input-wrap">
            <Icon name="link" size={15} className="input-lead" />
            <input className="input" placeholder="例如 fe.example.com:7788" value={addr} onChange={(e) => setAddr(e.target.value.trim())} />
          </div>
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={save}>{busy ? <Spinner size={14} /> : null} 保存</button>
      </div>
      {err ? <div className="auth-error">{err}</div> : null}

      {nearby.length ? (
        <div className="fed-nearby">
          <span className="field-label">同一个 Wi-Fi 下发现 {nearby.length} 个实例</span>
          {nearby.map((item) => (
            <button type="button" key={item.instanceId} className="fed-nearby-item" onClick={() => copyText(item.addr)}>
              <Icon name="wifi" size={15} />
              <span className="fed-nearby-addr">{item.addr}</span>
              <span className="fed-nearby-meta">{item.version || ''}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="settings-hint">还没发现同一个 Wi-Fi 下的其它实例。对方也要装本应用并打开着，才会互相看到。</p>
      )}
    </section>
  );
}

/* ---------------- 账号搬迁：导出 / 导入加密包 ---------------- */
function BackupCard({ token }) {
  const [pwd, setPwd] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [importPwd, setImportPwd] = useState('');
  const [importFile, setImportFile] = useState(null);
  const fileRef = useRef(null);

  const doExport = async () => {
    if (pwd.length < 6) { setErr('密码至少 6 位'); return; }
    setBusy('export');
    setErr('');
    try {
      const out = await api('/api/account/export', { method: 'POST', token, body: { password: pwd } });
      const blob = new Blob([JSON.stringify(out.package)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = out.filename || 'furry-everpony.feacct';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      toast('已导出账号包，请连同密码一起收好', 'success');
      setPwd('');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  const pickFile = async (file) => {
    if (!file) return;
    setErr('');
    try {
      const text = await file.text();
      setImportFile({ name: file.name, pkg: JSON.parse(text) });
    } catch {
      setErr('这个文件不是账号备份（应该是 .feacct / .json）');
    }
  };

  const doImport = async () => {
    if (!importFile) { setErr('先选一个账号包文件'); return; }
    setBusy('import');
    setErr('');
    try {
      const out = await api('/api/account/import', { method: 'POST', body: { password: importPwd, package: importFile.pkg } });
      try { localStorage.setItem(TOKEN_KEY, out.token); } catch { /* 忽略 */ }
      toast('账号已搬过来，正在重新载入', 'success');
      setTimeout(() => location.reload(), 600);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <section className="settings-card">
      <header className="settings-card-head"><h3><Icon name="download" size={17} /> 账号搬迁</h3></header>
      <p className="settings-hint">换电脑、换手机时用这个：导出成加密包，在新设备上导入，好友、会话、消息、群、收藏都会回来，原密码照样能登录。包是加密的，只有密码能打开，请把密码另外记住。</p>

      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="download" size={16} /> 导出这台设备上的账号</b>
          <span>导出时设一个打开密码（至少 6 位），文件后缀 .feacct</span>
        </div>
      </div>
      <div className="fed-row">
        <label className="field">
          <span className="field-label">打开密码</span>
          <input className="input" type="password" autoComplete="new-password" placeholder="至少 6 位" value={pwd} onChange={(e) => setPwd(e.target.value)} />
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'export'} onClick={doExport}>
          {busy === 'export' ? <Spinner size={14} /> : <Icon name="download" size={14} />} 导出
        </button>
      </div>

      <div className="settings-row">
        <div className="settings-row-main">
          <b><Icon name="arrowUp" size={16} /> 在这台设备导入账号</b>
          <span>{importFile ? '已选：' + importFile.name : '选择之前导出的 .feacct 文件，再输入那个打开密码'}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
          <Icon name="arrowUp" size={14} /> 选择文件
        </button>
        <input ref={fileRef} type="file" accept=".feacct,.json,application/json" hidden onChange={(e) => pickFile(e.target.files?.[0])} />
      </div>
      {importFile ? (
        <div className="fed-row">
          <label className="field">
            <span className="field-label">备份的打开密码</span>
            <input className="input" type="password" placeholder="导出时设的密码" value={importPwd} onChange={(e) => setImportPwd(e.target.value)} />
          </label>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'import' || !importPwd} onClick={doImport}>
            {busy === 'import' ? <Spinner size={14} /> : null} 导入并登录
          </button>
        </div>
      ) : null}
      {err ? <div className="auth-error">{err}</div> : null}
    </section>
  );
}
