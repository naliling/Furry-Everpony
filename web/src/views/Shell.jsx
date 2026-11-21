import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import RailIcon from '../ui/rail-icons.jsx';
import { Avatar, Badge, Confirm, ContextMenu, Drawer, Empty, SkeletonList, Spinner, toast, useIsMobile } from '../ui/primitives.jsx';
import { api, loadAccounts, forgetAccount, getDraft, messagePreviewText, normalizeFavorites, normalizeNotifications, toggleFavorite } from '../lib/api.js';
import { relTime } from '../lib/format.js';

const ChatTab = lazy(() => import('./chat/ChatTab.jsx'));
const ContactsTab = lazy(() => import('./contacts/ContactsTab.jsx'));
const DiscoverTab = lazy(() => import('./discover/DiscoverTab.jsx'));
const Settings = lazy(() => import('./Settings.jsx'));
const AdminPage = lazy(() => import('./admin/AdminPage.jsx'));

/* 广场是首页：打开就看见有哪些 Bot，再进消息 */
/* 侧栏顺序参照主流桌面端：消息 → 联系人 → 广场 → 收藏 → 我的，收藏是新增的独立入口 */
const NAV = [
  { id: 'chat', icon: 'chat', label: '消息' },
  { id: 'contacts', icon: 'contacts', label: '联系人' },
  { id: 'plaza', icon: 'plaza', label: '广场' },
  { id: 'favorites', icon: 'favorites', label: '收藏', action: 'favorites' },
  { id: 'me', icon: 'me', label: '我的' },
];

const NOTICE_META = {
  friend_request: { icon: 'friend', label: '好友申请' },
  bot_request: { icon: 'bot', label: 'Bot 好友申请' },
  group_invite: { icon: 'group', label: '群邀请' },
  announcement: { icon: 'bell', label: '群公告' },
};

export default function Shell({ token, me, accounts, theme, onTheme, font, onFont, onSwitchAccount, onAddAccount, onLogout, onBotSession }) {
  const isMobile = useIsMobile();
  const [meLive, setMeLive] = useState(me);
  /* Bot 身份登录时只有「消息」和「我的」两件事可做，开局直接落到消息 */
  const [tab, setTab] = useState(me?.type === 'bot' ? 'chat' : 'plaza');
  const [discoverView, setDiscoverView] = useState('plaza');
  const [convs, setConvs] = useState(null);
  const [notifs, setNotifs] = useState({ count: 0, items: [] });
  const [notifOpen, setNotifOpen] = useState(false);
  const [favOpen, setFavOpen] = useState(false);
  const [favorites, setFavorites] = useState(null);
  const [accountOpen, setAccountOpen] = useState(false);
  const [accountMenu, setAccountMenu] = useState(null);
  /* 退出登录要问一句：以前点一下就退，回来还得重登，太容易误触 */
  const [logoutAsk, setLogoutAsk] = useState(false);
  const [openConv, setOpenConv] = useState(null);
  const [newChatSignal, setNewChatSignal] = useState(0);
  const [busyItem, setBusyItem] = useState(null);
  const prevUnread = useRef(null);
  /* 会话列表轮询间隔：失败就退避，最长 15s，成功立刻回到 4s */
  const convDelayRef = useRef(4000);

  const refreshConversations = useCallback(async (silent = true) => {
    try {
      const data = await api('/api/conversations', { token, silent });
      const list = (data.conversations || []).slice();
      setConvs(list);
      convDelayRef.current = 8000;
      return list;
    } catch (err) {
      if (!silent) toast(err.message, 'error');
      setConvs((prev) => prev || []);
      convDelayRef.current = Math.min(Math.max(convDelayRef.current, 8000) * 2, 30000);
      return [];
    }
  }, [token]);

  const refreshNotifications = useCallback(async () => {
    try {
      const data = await api('/api/notifications', { token, silent: true });
      setNotifs(normalizeNotifications(data));
    } catch {
      /* 通知接口不可用时静默 */
    }
  }, [token]);

  useEffect(() => {
    setMeLive(me);
  }, [me]);

  useEffect(() => {
    refreshConversations();
    refreshNotifications();
  }, [refreshConversations, refreshNotifications]);

  /* 会话列表轮询：setTimeout 链式退避（4s→8s→15s），窗口重新聚焦立刻补一次 */
  useEffect(() => {
    let stopped = false;
    let timer = null;
    let busy = false;
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      await refreshConversations();
      busy = false;
      if (stopped) return;
      timer = window.setTimeout(tick, convDelayRef.current);
    };
    timer = window.setTimeout(tick, 8000);
    const t2 = window.setInterval(() => refreshNotifications(), 30000);
    const onWake = () => {
      if (stopped || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      if (timer) window.clearTimeout(timer);
      tick();
      refreshNotifications();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(t2);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [refreshConversations, refreshNotifications]);

  const totalUnread = useMemo(() => (convs || []).reduce((sum, c) => sum + (c.muted ? 0 : c.unread || 0), 0), [convs]);

  /* 桌面外壳：未读角标 / 新消息通知 / 导航回调 */
  useEffect(() => {
    const fe = typeof window !== 'undefined' ? window.fe : null;
    if (fe?.setBadge) { try { fe.setBadge(totalUnread); } catch { /* 忽略 */ } }
    document.title = totalUnread > 0 ? '(' + totalUnread + ') Everony' : 'Everony';
  }, [totalUnread]);

  useEffect(() => {
    if (!convs) return;
    const prev = prevUnread.current;
    const next = new Map();
    convs.forEach((c) => next.set(c.id, { unread: c.unread || 0, name: c.kind === 'group' ? c.group?.name : c.peer?.nickname, preview: c.last?.preview }));
    if (prev) {
      const fe = typeof window !== 'undefined' ? window.fe : null;
      convs.forEach((c) => {
        if (!c.unread || c.muted) return;
        const before = prev.get(c.id);
        if (before && c.unread > before.unread && (openConv?.id !== c.id || tab !== 'chat')) {
          const name = c.kind === 'group' ? c.group?.name || '群聊' : c.peer?.nickname || c.peer?.number || '新消息';
          if (fe?.notify) { try { fe.notify({ title: name, body: c.last?.preview || '你有一条新消息', conversationId: c.id }); } catch { /* 忽略 */ } }
        }
      });
    }
    prevUnread.current = next;
  }, [convs, openConv, tab]);

  useEffect(() => {
    const fe = typeof window !== 'undefined' ? window.fe : null;
    if (!fe?.onNavigate) return undefined;
    const off = fe.onNavigate((payload) => {
      const convId = typeof payload === 'string' ? payload : payload?.conversationId;
      if (convId) { setTab('chat'); setOpenConv({ id: convId }); }
    });
    return () => { if (typeof off === 'function') off(); };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n' && !e.altKey) {
        e.preventDefault();
        setTab('chat');
        setNewChatSignal((n) => n + 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  /* 聊天页「更多 → 聊天背景 → 在设置里管理」跳过来时，切到「我的」由 Settings 自己滚到卡片 */
  useEffect(() => {
    const onOpenSettings = () => setTab('me');
    window.addEventListener('fe:open-settings', onOpenSettings);
    return () => window.removeEventListener('fe:open-settings', onOpenSettings);
  }, []);

  /* 页面切换用浏览器原生视图过渡：旧页淡出、新页淡入，各 0.62 秒，有头有尾。 */
  const switchTab = useCallback((id) => {
    const change = () => setTab(id);
    if (typeof document !== 'undefined' && typeof document.startViewTransition === 'function'
        && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      document.startViewTransition(change);
    } else {
      change();
    }
  }, []);

  const openConversation = (id, messageId) => {
    switchTab('chat');
    setOpenConv(messageId ? { id, messageId } : { id });
  };

  const goTab = (id) => {
    switchTab(id);
    if (id === 'chat') setNewChatSignal((n) => n + 0);
  };

  const openNotifications = () => {
    setNotifOpen(true);
    refreshNotifications();
  };

  const openFavorites = async () => {
    setFavOpen(true);
    setFavorites(null);
    try {
      const data = await api('/api/favorites', { token });
      setFavorites(normalizeFavorites(data));
    } catch (err) {
      setFavorites([]);
      toast(err.message, 'error');
    }
  };

  const acceptFriend = async (item, accept) => {
    setBusyItem(item.key);
    try {
      const body = accept
        ? { requestId: item.requestId, number: item.from?.number, bot: item.bot?.number }
        : { requestId: item.requestId, number: item.from?.number, bot: item.bot?.number };
      await api('/api/friends/' + (accept ? 'accept' : 'reject'), { method: 'POST', token, body });
      toast(accept ? '已同意好友申请' : '已拒绝', 'success');
      await Promise.all([refreshNotifications(), refreshConversations()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyItem(null);
    }
  };

  const handleInvite = async (item, accept) => {
    setBusyItem(item.key);
    try {
      await api('/api/group-requests/' + item.requestId + '/' + (accept ? 'accept' : 'reject'), { method: 'POST', token });
      toast(accept ? '已加入群聊' : '已拒绝邀请', 'success');
      await Promise.all([refreshNotifications(), refreshConversations()]);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyItem(null);
    }
  };

  const openAnnouncementNotice = (item) => {
    const number = item.group?.number;
    if (number) api('/api/groups/' + number + '/announcement/read', { method: 'POST', token }).then(() => refreshNotifications()).catch(() => {});
    const conv = (convs || []).find((c) => c.kind === 'group' && c.group?.number === number);
    setNotifOpen(false);
    if (conv) openConversation(conv.id);
    else { setTab('contacts'); toast('该群的会话还没出现，请刷新后再试', 'info'); }
  };

  /* 收藏只带会话摘要（dm 的 peer / group 的 group），没有 conversation.id，按号码反查或现建 */
  const openFavorite = async (fav) => {
    const conv = fav.conversation || {};
    setFavOpen(false);
    let target = (convs || []).find((c) => (conv.kind === 'group'
      ? c.kind === 'group' && c.group?.number === conv.group?.number
      : c.kind === 'dm' && c.peer?.number === conv.peer?.number));
    try {
      if (!target && conv.kind === 'dm' && conv.peer?.number) {
        const data = await api('/api/dm', { method: 'POST', token, body: { number: conv.peer.number } });
        if (data?.conversationId) target = { id: data.conversationId };
      }
      if (!target && conv.kind === 'group' && conv.group?.number) {
        const list = await refreshConversations(false);
        target = (list || []).find((c) => c.kind === 'group' && c.group?.number === conv.group.number);
      }
    } catch (err) {
      toast(err.message, 'error');
    }
    if (target?.id) openConversation(target.id, fav.message?.id);
    else toast('找不到这条收藏所在的会话，请稍后重试', 'error');
  };

  const removeFavorite = async (fav) => {
    try {
      await toggleFavorite(fav.message.id, false, token);
      setFavorites((prev) => (prev || []).filter((x) => x.message.id !== fav.message.id));
      toast('已取消收藏', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const navBadge = (id) => {
    if (id !== 'chat') return 0;
    return totalUnread;
  };

  /* 管理入口只给管理员看，普通用户不会知道它存在 */
  const isBotAccount = meLive?.type === 'bot';
  const navItems = useMemo(() => {
    const base = isBotAccount ? NAV.filter((n) => n.id === 'chat' || n.id === 'me') : NAV;
    return meLive?.is_admin ? [...base, { id: 'admin', icon: 'admin', label: '管理' }] : base;
  }, [meLive?.is_admin, isBotAccount]);

  /* 侧栏点击：收藏是抽屉不是页面，走单独动作 */
  const handleNav = (item) => {
    if (item.action === 'favorites') {
      openFavorites();
      return;
    }
    goTab(item.id);
  };

  const switchAccount = async (acc) => {
    try {
      const data = await api('/api/me', { token: acc.token });
      onSwitchAccount?.({ token: acc.token, account: data.account });
      setAccountOpen(false);
      setAccountMenu(null);
    } catch {
      forgetAccount?.(acc.number);
      toast('该账号登录已失效，已从本地移除', 'error');
      setAccountOpen(false);
      setAccountMenu(null);
    }
  };

  const accountList = accounts || [];

  return (
    <div className={'app-shell' + (isMobile ? ' is-mobile' : '')}>
      <aside className="rail" aria-label="主导航">
        <div
          className="rail-logo"
          title="Everony"
          aria-hidden="true"
        >
          <RailIcon name="logo" size={24} />
          <span className="rail-logo-glow" aria-hidden />
        </div>
        <nav className="rail-nav">
          <div className="rail-group">
            {navItems.map((item) => (
              <button
                type="button"
                key={item.id}
                className={'rail-btn' + (tab === item.id && item.id !== 'favorites' ? ' on' : '')}
                onClick={() => handleNav(item)}
                title={item.label}
                aria-label={item.label}
                data-label={item.label}
                aria-current={tab === item.id ? 'page' : undefined}
              >
                <RailIcon name={item.icon} size={21} />
                {navBadge(item.id) > 0 ? <span className="rail-badge">{navBadge(item.id) > 99 ? '99+' : navBadge(item.id)}</span> : null}
              </button>
            ))}
          </div>
          <span className="rail-sep" aria-hidden />
          <div className="rail-group">
            {isBotAccount ? null : (
            <button
              type="button"
              className={'rail-btn rail-bot' + (tab === 'plaza' && discoverView === 'mine' ? ' on' : '')}
              title="我的 Bot"
              aria-label="我的 Bot"
              data-label="我的 Bot"
              onClick={() => { setDiscoverView('mine'); setTab('plaza'); }}
            >
              <RailIcon name="bot" size={21} />
            </button>
            )}
            {isBotAccount ? null : (
            <button type="button" className="rail-btn rail-bell" title="通知中心" aria-label="通知中心" data-label="通知中心" onClick={openNotifications}>
              <RailIcon name="bell" size={21} />
              {notifs.count > 0 ? <span className="rail-badge" >{notifs.count > 99 ? '99+' : notifs.count}</span> : null}
            </button>
            )}
          </div>
        </nav>
        <div className="rail-foot">
          <button
            type="button"
            className="rail-avatar"
            title={meLive?.nickname || meLive?.number}
            aria-label="账号"
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setAccountMenu({ x: r.right + 8, y: Math.max(10, r.bottom - 120), items: [
                { label: '设置', icon: 'gear', onClick: () => setTab('me') },
                { label: '切换账号', icon: 'refresh', onClick: () => setAccountOpen(true) },
                { divider: true },
                { label: '退出登录', icon: 'logout', danger: true, onClick: () => setLogoutAsk(true) },
              ] });
            }}
          >
            <Avatar number={meLive?.number} nickname={meLive?.nickname} avatar={meLive?.avatar} size={34} status={meLive?.status || 'online'} />
          </button>
        </div>
      </aside>

      <main className="app-main">
        <Suspense fallback={<div className="fe-route-state" role="status"><Spinner size={18} /> 正在打开页面</div>}>
          {tab === 'chat' ? (
            <ChatTab
              token={token}
              me={meLive}
              conversations={convs}
              refreshConversations={refreshConversations}
              openConvId={openConv?.id}
              openMsgId={openConv?.messageId}
              onConsumedOpen={() => setOpenConv(null)}
              onGoTab={setTab}
              newChatSignal={newChatSignal}
              onOpenNotifications={openNotifications}
              notifCount={notifs.count}
            />
          ) : null}
          {tab === 'contacts' ? (
            <ContactsTab token={token} me={meLive} conversations={convs} onOpenConversation={openConversation} refreshConversations={refreshConversations} notifications={notifs} onOpenNotifications={openNotifications} />
          ) : null}
          {tab === 'plaza' ? (
            <DiscoverTab
              token={token}
              me={meLive}
              initialView={discoverView}
              onBotSession={onBotSession}
              onOpenConversation={openConversation}
              onGoTab={setTab}
            />
          ) : null}
          {tab === 'me' ? (
            <Settings
              token={token}
              me={meLive}
              theme={theme}
              onTheme={onTheme}
              font={font}
              onFont={onFont}
              onOpenNotifications={openNotifications}
              onOpenFavorites={openFavorites}
              notifCount={notifs.count}
              onSwitchAccount={() => setAccountOpen(true)}
              onAddAccount={onAddAccount}
              onLogout={onLogout}
              onMeChange={setMeLive}
              onGoTab={setTab}
            />
          ) : null}
          {tab === 'admin' && meLive?.is_admin ? <AdminPage token={token} me={meLive} /> : null}
        </Suspense>
      </main>

      {isMobile ? (
        <nav className="mobile-tabbar" aria-label="底部导航">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={'mobile-tab' + (tab === item.id ? ' on' : '')}
              onClick={() => handleNav(item)}
              aria-current={tab === item.id ? 'page' : undefined}
            >
              <span className="mobile-tab-icon">
                <RailIcon name={item.icon} size={21} />
                {navBadge(item.id) > 0 ? <span className="mobile-tab-badge">{navBadge(item.id) > 99 ? '99+' : navBadge(item.id)}</span> : null}
                {item.id === 'chat' && notifs.count > 0 && !(navBadge(item.id) > 0) ? <span className="mobile-tab-dot" /> : null}
              </span>
              <span className="mobile-tab-label">{item.label}</span>
            </button>
          ))}
        </nav>
      ) : null}

      {accountMenu ? <ContextMenu x={accountMenu.x} y={accountMenu.y} items={accountMenu.items} onClose={() => setAccountMenu(null)} title={me?.nickname || me?.number} /> : null}

      {notifOpen ? (
        <Drawer title="通知中心" icon="bell" width={420} onClose={() => setNotifOpen(false)}>
          {notifs.items.length === 0 ? (
            <Empty icon="bell" title="没有新通知" sub="好友申请、群邀请和群公告都会出现在这里" compact />
          ) : (
            <div className="notice-list">
              {notifs.items.map((item) => {
                const meta = NOTICE_META[item.type] || { icon: 'info', label: '通知' };
                return (
                  <div className="notice-item" key={item.key}>
                    <span className={'notice-icon notice-' + item.type}><Icon name={meta.icon} size={18} /></span>
                    <div className="notice-body">
                      <div className="notice-title">
                        <span>{meta.label}</span>
                        <span className="notice-time">{item.created_at ? relTime(item.created_at) : ''}</span>
                      </div>
                      {item.type === 'friend_request' ? (
                        <>
                          <p className="notice-text"><b>{item.from?.nickname || item.from?.number}</b> 请求加你为好友</p>
                          {item.message ? <p className="notice-sub">“{item.message}”</p> : null}
                          <div className="notice-actions">
                            <button type="button" className="btn btn-primary btn-sm" disabled={busyItem === item.key} onClick={() => acceptFriend(item, true)}>同意</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busyItem === item.key} onClick={() => acceptFriend(item, false)}>拒绝</button>
                          </div>
                        </>
                      ) : null}
                      {item.type === 'bot_request' ? (
                        <>
                          <p className="notice-text"><b>{item.from?.nickname || item.from?.number}</b> 请求让 Bot「{item.bot?.nickname || item.bot?.number}」加你为好友</p>
                          <div className="notice-actions">
                            <button type="button" className="btn btn-primary btn-sm" disabled={busyItem === item.key} onClick={() => acceptFriend(item, true)}>同意</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busyItem === item.key} onClick={() => acceptFriend(item, false)}>拒绝</button>
                          </div>
                        </>
                      ) : null}
                      {item.type === 'group_invite' ? (
                        <>
                          <p className="notice-text"><b>{item.from?.nickname || item.from?.number}</b> 邀请你加入「{item.group?.name || item.group?.number}」</p>
                          <div className="notice-actions">
                            <button type="button" className="btn btn-primary btn-sm" disabled={busyItem === item.key} onClick={() => handleInvite(item, true)}>加入</button>
                            <button type="button" className="btn btn-ghost btn-sm" disabled={busyItem === item.key} onClick={() => handleInvite(item, false)}>拒绝</button>
                          </div>
                        </>
                      ) : null}
                      {item.type === 'announcement' ? (
                        <>
                          <p className="notice-text">「{item.group?.name || item.group?.number}」发布了新公告</p>
                          <p className="notice-sub">{item.announcement}</p>
                          <div className="notice-actions">
                            <button type="button" className="btn btn-primary btn-sm" onClick={() => openAnnouncementNotice(item)}>查看</button>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Drawer>
      ) : null}

      {favOpen ? (
        <Drawer title="我的收藏" icon="bookmark" width={440} onClose={() => setFavOpen(false)}>
          {favorites === null ? (
            <SkeletonList rows={4} />
          ) : favorites.length === 0 ? (
            <Empty icon="bookmark" title="还没有收藏" sub="在消息上点收藏，就能在这里找到" compact />
          ) : (
            <div className="fav-list">
              {favorites.map((fav) => {
                const conv = fav.conversation || {};
                const name = conv.kind === 'group' ? conv.group?.name || '群聊' : conv.peer?.nickname || conv.peer?.number || '会话';
                return (
                  <div className="fav-item" key={fav.message.id}>
                    <button type="button" className="fav-main" onClick={() => openFavorite(fav)}>
                      <span className="fav-head"><b>{name}</b><span className="fav-time">{relTime(fav.message.created_at)}</span></span>
                      <span className="fav-text">{messagePreviewText(fav.message)}</span>
                    </button>
                    <button type="button" className="icon-btn" title="取消收藏" aria-label="取消收藏" onClick={() => removeFavorite(fav)}>
                      <Icon name="bookmarkFilled" size={16} />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </Drawer>
      ) : null}

      {accountOpen ? (
        <Drawer title="切换账号" icon="refresh" width={400} onClose={() => setAccountOpen(false)}>
          <div className="account-list">
            {accountList.map((acc) => {
              const current = acc.number === me?.number;
              return (
                <button type="button" key={acc.number} className={'account-item' + (current ? ' on' : '')} onClick={() => { if (!current) switchAccount(acc); }}>
                  <Avatar number={acc.number} nickname={acc.nickname} avatar={acc.avatar} size={40} />
                  <span className="account-main">
                    <span className="account-name">{acc.nickname || acc.number}</span>
                    <span className="account-number">{acc.number}</span>
                  </span>
                  {current ? <span className="account-current">当前</span> : <Icon name="arrowRight" size={16} />}
                </button>
              );
            })}
            {accountList.length === 0 ? <Empty icon="users" title="本地没有其他账号" sub="添加账号会用新号码登录，并记住当前账号" compact /> : null}
          </div>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => { setAccountOpen(false); onAddAccount?.(); }}>
            <Icon name="plus" size={17} /> 添加账号
          </button>
          <button type="button" className="btn btn-danger-ghost btn-block" onClick={() => setLogoutAsk(true)}>
            <Icon name="logout" size={17} /> 退出当前账号
          </button>
        </Drawer>
      ) : null}

      {logoutAsk ? (
        <Confirm
          title="退出登录？"
          message="退出后要重新输入号码和密码才能进来，聊天记录不会丢。"
          danger
          confirmText="退出登录"
          onConfirm={() => { setLogoutAsk(false); onLogout?.(); }}
          onClose={() => setLogoutAsk(false)}
        />
      ) : null}
    </div>
  );
}
