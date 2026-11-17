import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Badge, Confirm, ContextMenu, Empty, Modal, SkeletonList, Spinner, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { relTime, statusMeta } from '../../lib/format.js';
import ProfileModal from '../shared/ProfileModal.jsx';
import { AddFriendModal, CreateGroupModal, JoinGroupModal } from '../shared/Dialogs.jsx';
import GroupInfo from '../chat/GroupInfo.jsx';
import { QrCode } from '../../ui/qr.jsx';

export default function ContactsTab({ token, me, conversations = [], onOpenConversation, refreshConversations }) {
  const [view, setView] = useState('friends');
  const [friends, setFriends] = useState(null);
  const [groups, setGroups] = useState(null);
  const [friendGroups, setFriendGroups] = useState([]);
  const [requests, setRequests] = useState(null);
  const [groupRequests, setGroupRequests] = useState(null);
  const [search, setSearch] = useState('');
  const [globalUsers, setGlobalUsers] = useState([]);
  const [globalBusy, setGlobalBusy] = useState(null);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [profile, setProfile] = useState(null);
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [busy, setBusy] = useState(null);
  const [groupInfo, setGroupInfo] = useState(null);
  const [newGroupName, setNewGroupName] = useState(null);
  const [renameGroup, setRenameGroup] = useState(null);

  const loadFriends = useCallback(async () => {
    try {
      const [f, fg] = await Promise.all([
        api('/api/friends', { token }),
        api('/api/friend-groups', { token }).catch(() => ({ groups: [], ungrouped: 0 })),
      ]);
      setFriends(f.friends || []);
      setFriendGroups(fg.groups || []);
    } catch (err) {
      setFriends([]);
      toast(err.message, 'error');
    }
  }, [token]);

  const loadGroups = useCallback(async () => {
    try {
      const data = await api('/api/groups', { token });
      setGroups(data.groups || []);
    } catch {
      setGroups([]);
    }
  }, [token]);

  const loadRequests = useCallback(async () => {
    try {
      const [r, gr] = await Promise.all([
        api('/api/friends/requests', { token }),
        api('/api/group-requests', { token }).catch(() => ({ incoming: [], outgoing: [] })),
      ]);
      setRequests(r);
      setGroupRequests(gr);
    } catch {
      setRequests({ incoming: [], outgoing: [], botIncoming: [] });
      setGroupRequests({ incoming: [], outgoing: [] });
    }
  }, [token]);

  const loadAll = useCallback(() => {
    loadFriends();
    loadGroups();
    loadRequests();
  }, [loadFriends, loadGroups, loadRequests]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const pendingCount = (requests?.incoming?.length || 0) + (requests?.botIncoming?.length || 0) + (groupRequests?.incoming?.length || 0);

  const kw = search.trim().toLowerCase();

  const filteredFriends = useMemo(() => (friends || []).filter((f) => {
    if (!kw) return true;
    return [f.nickname, f.remark, f.number, f.bio].some((v) => String(v || '').toLowerCase().includes(kw));
  }), [friends, kw]);

  const filteredGroups = useMemo(() => (groups || []).filter((g) => {
    if (!kw) return true;
    return [g.name, g.number].some((v) => String(v || '').toLowerCase().includes(kw));
  }), [groups, kw]);

  useEffect(() => {
    if (view !== 'friends' || !kw) { setGlobalUsers([]); return; }
    let alive = true;
    const timer = setTimeout(async () => {
      try {
        const res = await api('/api/search/users?q=' + encodeURIComponent(kw), { token });
        if (alive) setGlobalUsers((res.users || []).filter((u) => !u.isFriend));
      } catch { if (alive) setGlobalUsers([]); }
    }, 220);
    return () => { alive = false; clearTimeout(timer); };
  }, [kw, view, token]);

  const addByNumber = async (number) => {
    setGlobalBusy(number);
    try {
      const res = await api('/api/friends/request', { method: 'POST', token, body: { number } });
      toast(res.status === 'accepted' ? '你们已经是好友了' : '好友申请已发出', 'success');
      loadFriends();
      loadRequests();
      setGlobalUsers((prev) => prev.filter((u) => u.number !== number));
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setGlobalBusy(null);
    }
  };

  const special = filteredFriends.filter((f) => f.special);
  const normal = filteredFriends.filter((f) => !f.special);

  const grouped = useMemo(() => {
    const map = new Map();
    (friendGroups || []).forEach((g) => map.set(g.id, []));
    const ungrouped = [];
    normal.forEach((f) => {
      if (f.group_id != null && map.has(f.group_id)) map.get(f.group_id).push(f);
      else ungrouped.push(f);
    });
    const sections = [];
    (friendGroups || []).forEach((g) => sections.push({ id: 'g' + g.id, group: g, items: map.get(g.id) }));
    sections.push({ id: 'ungrouped', group: { id: null, name: '未分组' }, items: ungrouped });
    return sections.filter((s) => s.items.length > 0 || (!kw && s.group.id == null && normal.length === 0) || (!kw && s.group.id != null));
  }, [friendGroups, normal, kw]);

  const toggleCollapse = (id) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const dm = async (number) => {
    try {
      const data = await api('/api/dm', { method: 'POST', token, body: { number } });
      onOpenConversation?.(data.conversationId);
    } catch (err) { toast(err.message, 'error'); }
  };

  const friendMenu = (e, f) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: '发消息', icon: 'chat', onClick: () => dm(f.number) },
      { label: '查看资料', icon: 'friend', onClick: () => setProfile(f.number) },
      { label: f.special ? '取消特别关心' : '设为特别关心', icon: 'star', checked: !!f.special, onClick: async () => {
        try { await api('/api/friends/' + f.number, { method: 'PATCH', token, body: { special: !f.special } }); loadFriends(); } catch (err) { toast(err.message, 'error'); }
      } },
      { divider: true },
      { label: '删除好友', icon: 'trash', danger: true, onClick: () => setConfirm({ title: '删除好友', message: '确定删除 ' + (f.remark || f.nickname || f.number) + ' 吗？聊天记录会保留。', danger: true, onConfirm: async () => {
        try { await api('/api/friends/' + f.number, { method: 'DELETE', token }); toast('已删除', 'success'); loadFriends(); } catch (err) { toast(err.message, 'error'); }
      } }) },
    ] });
  };

  const groupMenu = (e, g) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, items: [
      { label: '打开聊天', icon: 'chat', onClick: () => onOpenConversation?.(g.conversation_id) },
      { label: '群资料与设置', icon: 'group', onClick: () => setGroupInfo(g) },
      { divider: true },
      { label: '退出群聊', icon: 'logout', danger: true, onClick: () => setConfirm({ title: '退出群聊', message: '确定退出「' + g.name + '」吗？', danger: true, onConfirm: async () => {
        try { await api('/api/groups/' + g.number + '/leave', { method: 'DELETE', token }); toast('已退出群聊', 'success'); loadGroups(); refreshConversations?.(); } catch (err) { toast(err.message, 'error'); }
      } }) },
    ] });
  };

  const acceptFriend = async (item, accept) => {
    setBusy(accept ? 'a' + item.id : 'r' + item.id);
    try {
      await api('/api/friends/' + (accept ? 'accept' : 'reject'), { method: 'POST', token, body: { number: item.from?.number || item.number, bot: item.bot?.number, requestId: item.id } });
      toast(accept ? '已添加好友' : '已拒绝', 'success');
      loadRequests();
      loadFriends();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  };

  const acceptGroup = async (item, accept) => {
    setBusy((accept ? 'a' : 'r') + item.id);
    try {
      await api('/api/group-requests/' + item.id + '/' + (accept ? 'accept' : 'reject'), { method: 'POST', token });
      toast(accept ? '已加入群聊' : '已拒绝邀请', 'success');
      loadRequests();
      loadGroups();
      refreshConversations?.();
    } catch (err) { toast(err.message, 'error'); } finally { setBusy(null); }
  };

  const createGroup = async () => {
    if (!newGroupName?.trim()) return;
    try {
      await api('/api/friend-groups', { method: 'POST', token, body: { name: newGroupName.trim() } });
      setNewGroupName(null);
      loadFriends();
      toast('分组已创建', 'success');
    } catch (err) { toast(err.message, 'error'); }
  };

  const renameFriendGroup = async () => {
    if (!renameGroup?.name?.trim()) return;
    try {
      await api('/api/friend-groups/' + renameGroup.id, { method: 'PATCH', token, body: { name: renameGroup.name.trim() } });
      setRenameGroup(null);
      loadFriends();
    } catch (err) { toast(err.message, 'error'); }
  };

  const deleteFriendGroup = async (g) => {
    try {
      await api('/api/friend-groups/' + g.id, { method: 'DELETE', token });
      toast('分组已删除', 'success');
      loadFriends();
    } catch (err) { toast(err.message, 'error'); }
  };

  const incoming = requests?.incoming || [];
  const outgoing = requests?.outgoing || [];
  const botIncoming = requests?.botIncoming || [];
  const gin = groupRequests?.incoming || [];
  const gout = groupRequests?.outgoing || [];

  return (
    <div className="contacts-tab">
      <header className="page-head">
        <div>
          <h2>联系人</h2>
          <p className="page-sub">好友、群聊与各种申请都收在这里</p>
        </div>
        <div className="page-head-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('friend')}><Icon name="plus" size={15} /> 加好友</button>
          <button type="button" className="icon-btn" onClick={() => setNewGroupName('')} title="新建分组" aria-label="新建分组"><Icon name="folder" size={18} /></button>
        </div>
      </header>

      <div className="contacts-toolbar">
        <div className="segmented contacts-seg" role="tablist">
          <button type="button" role="tab" aria-selected={view === 'friends'} className={view === 'friends' ? 'on' : ''} onClick={() => setView('friends')}>
            好友 <span className="seg-count">{friends?.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === 'groups'} className={view === 'groups' ? 'on' : ''} onClick={() => setView('groups')}>
            群聊 <span className="seg-count">{groups?.length ?? 0}</span>
          </button>
          <button type="button" role="tab" aria-selected={view === 'requests'} className={view === 'requests' ? 'on' : ''} onClick={() => setView('requests')}>
            申请 {pendingCount > 0 ? <span className="seg-badge">{pendingCount}</span> : null}
          </button>
        </div>
        {view !== 'requests' ? (
          <div className="contacts-search-row">
            <div className="input-wrap contacts-search">
              <Icon name="search" size={15} className="input-lead" />
              <input className="input input-sm" placeholder={view === 'friends' ? '搜号码、昵称、标签' : '搜索群聊'} value={search} onChange={(e) => setSearch(e.target.value)} />
              {search ? <button type="button" className="input-clear" aria-label="清空" onClick={() => setSearch('')}><Icon name="close" size={13} /></button> : null}
            </div>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="我的二维码" title="我的二维码" onClick={() => setDialog('qr')}><Icon name="qr" size={16} /></button>
            <button type="button" className="icon-btn icon-btn-sm" aria-label="扫一扫" title="扫一扫" onClick={() => setDialog('scan')}><Icon name="camera" size={16} /></button>
          </div>
        ) : null}
      </div>

      <div className="contacts-body">
        {view === 'friends' && kw && globalUsers.length > 0 ? (
          <section className="friend-section global-section">
            <header className="friend-section-head">
              <Icon name="search" size={15} className="friend-caret" />
              <h3>全站用户</h3>
              <span className="friend-section-count">{globalUsers.length}</span>
            </header>
            <div className="global-user-list">
              {globalUsers.map((u) => (
                <div className="global-user-row" key={u.number}>
                  <Avatar number={u.number} nickname={u.nickname} size={36} square={u.type === 'bot'} />
                  <div className="global-user-main">
                    <b>{u.nickname || u.number}{u.type === 'bot' ? <span className="tag tag-accent">Bot</span> : null}</b>
                    <span>#{u.number}{u.bio ? ' · ' + u.bio : ''}</span>
                  </div>
                  <button type="button" className="btn btn-primary btn-sm" disabled={globalBusy === u.number} onClick={() => addByNumber(u.number)}>
                    {globalBusy === u.number ? '发送中' : '加好友'}
                  </button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {view === 'friends' ? (
          friends === null ? <SkeletonList rows={6} /> : filteredFriends.length === 0 ? (
            <Empty icon="friend" title={kw ? '没有匹配的好友' : '还没有好友'} sub={kw ? '换个关键词试试' : '用号码添加第一个好友吧'}
              action={<button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('friend')}><Icon name="plus" size={15} /> 加好友</button>} />
          ) : (
            <>
              {special.length > 0 ? (
                <section className="friend-section special-section">
                  <header className="friend-section-head">
                    <Icon name="starFilled" size={15} className="special-star" />
                    <h3>特别关心</h3>
                    <span className="friend-section-count">{special.length}</span>
                  </header>
                  <div className="friend-grid">
                    {special.map((f) => <FriendCard key={f.number} friend={f} onOpen={() => setProfile(f.number)} onMenu={(e) => friendMenu(e, f)} />)}
                  </div>
                </section>
              ) : null}
              {grouped.map((section) => (
                <section className="friend-section" key={section.id}>
                  <header className="friend-section-head" onClick={() => section.group.id != null && toggleCollapse(section.group.id)}>
                    {section.group.id != null ? <Icon name={collapsed.has(section.group.id) ? 'chevronDown' : 'chevron'} size={15} className="friend-caret" /> : <span className="friend-caret-dot" />}
                    <h3>{section.group.name}</h3>
                    <span className="friend-section-count">{section.items.length}</span>
                    {section.group.id != null ? (
                      <button type="button" className="icon-btn icon-btn-sm" aria-label="分组操作" onClick={(e) => {
                        e.stopPropagation();
                        setMenu({ x: e.clientX, y: e.clientY, items: [
                          { label: '重命名分组', icon: 'edit', onClick: () => setRenameGroup({ id: section.group.id, name: section.group.name }) },
                          { label: '删除分组', icon: 'trash', danger: true, onClick: () => setConfirm({ title: '删除分组', message: '删除分组不会删除好友，好友会回到未分组。', danger: true, onConfirm: () => deleteFriendGroup(section.group) }) },
                        ] });
                      }}><Icon name="more" size={15} /></button>
                    ) : null}
                  </header>
                  {!collapsed.has(section.group.id) ? (
                    <div className="friend-grid">
                      {section.items.map((f) => <FriendCard key={f.number} friend={f} onOpen={() => setProfile(f.number)} onMenu={(e) => friendMenu(e, f)} />)}
                    </div>
                  ) : null}
                </section>
              ))}
              <button type="button" className="friend-add-row" onClick={() => setDialog('friend')}>
                <Icon name="plus" size={16} /> 添加好友
              </button>
            </>
          )
        ) : null}

        {view === 'groups' ? (
          groups === null ? <SkeletonList rows={5} /> : filteredGroups.length === 0 ? (
            <Empty icon="group" title={kw ? '没有匹配的群聊' : '还没有群聊'} sub="创建一个群，或者用群号加入"
              action={<div className="empty-action-row"><button type="button" className="btn btn-primary btn-sm" onClick={() => setDialog('group')}>创建群聊</button><button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog('join')}>加入群</button></div>} />
          ) : (
            <div className="group-cards">
              {filteredGroups.map((g) => (
                <button type="button" key={g.number} className="group-card" onClick={() => onOpenConversation?.(g.conversation_id)} onContextMenu={(e) => groupMenu(e, g)}>
                  <span className="group-card-avatar">{g.avatar ? <img src={g.avatar} alt="" loading="lazy" /> : <Icon name="group" size={24} />}</span>
                  <span className="group-card-main">
                    <span className="group-card-name">{g.name}<span className="group-card-number">{g.number}</span></span>
                    <span className="group-card-meta">
                      {g.members != null ? g.members + ' 人' : ''}
                      {g.mute_all ? <span className="tag tag-warn"><Icon name="mute" size={11} /> 全员禁言</span> : null}
                      {g.pending ? <span className="tag">邀请待处理</span> : null}
                      {g.role === 'owner' ? <span className="tag tag-accent">群主</span> : g.role === 'admin' ? <span className="tag tag-accent">管理员</span> : null}
                    </span>
                    {g.announcement ? <span className="group-card-announce"><Icon name="bell" size={12} /> {g.announcement}</span> : null}
                  </span>
                  <Icon name="chevron" size={16} className="group-card-arrow" />
                </button>
              ))}
            </div>
          )
        ) : null}

        {view === 'requests' ? (
          <div className="request-panels">
            <section className="request-panel">
              <h3>好友申请 <span className="request-count">{incoming.length}</span></h3>
              {incoming.length === 0 ? <p className="request-empty">暂时没有新的好友申请</p> : incoming.map((item) => (
                <div className="request-item" key={item.id}>
                  <Avatar number={item.number} nickname={item.nickname} size={40} />
                  <div className="request-main">
                    <div className="request-title">{item.nickname || item.number} <span className="request-number">{item.number}</span></div>
                    {item.message ? <p className="request-message">{item.message}</p> : <p className="request-message request-muted">请求加你为好友</p>}
                    <span className="request-time">{item.created_at ? relTime(item.created_at) : ''}</span>
                  </div>
                  <div className="request-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'a' + item.id} onClick={() => acceptFriend(item, true)}>同意</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'r' + item.id} onClick={() => acceptFriend(item, false)}>拒绝</button>
                  </div>
                </div>
              ))}
            </section>

            <section className="request-panel">
              <h3>Bot 好友申请 <span className="request-count">{botIncoming.length}</span></h3>
              {botIncoming.length === 0 ? <p className="request-empty">暂时没有 Bot 申请</p> : botIncoming.map((item) => (
                <div className="request-item" key={item.id}>
                  <Avatar number={item.bot?.number} nickname={item.bot?.nickname || item.bot?.number} size={40} square />
                  <div className="request-main">
                    <div className="request-title">Bot「{item.bot?.nickname || item.bot?.number}」</div>
                    <p className="request-message">申请人 {item.from?.nickname || item.from?.number}：{item.message || '想让这个 Bot 加你为好友'}</p>
                    <span className="request-time">{item.created_at ? relTime(item.created_at) : ''}</span>
                  </div>
                  <div className="request-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'a' + item.id} onClick={() => acceptFriend(item, true)}>同意</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'r' + item.id} onClick={() => acceptFriend(item, false)}>拒绝</button>
                  </div>
                </div>
              ))}
            </section>

            <section className="request-panel">
              <h3>群邀请 <span className="request-count">{gin.length}</span></h3>
              {gin.length === 0 ? <p className="request-empty">暂时没有群邀请</p> : gin.map((item) => (
                <div className="request-item" key={item.id}>
                  <span className="request-icon"><Icon name="group" size={20} /></span>
                  <div className="request-main">
                    <div className="request-title">{item.group?.name || item.name || item.number}</div>
                    <p className="request-message">{(item.from?.nickname || item.from_nickname) ? (item.from?.nickname || item.from_nickname) + ' 邀请你加入' : '你被邀请加入这个群'}</p>
                    <span className="request-time">{item.created_at ? relTime(item.created_at) : ''}</span>
                  </div>
                  <div className="request-actions">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === 'a' + item.id} onClick={() => acceptGroup(item, true)}>加入</button>
                    <button type="button" className="btn btn-ghost btn-sm" disabled={busy === 'r' + item.id} onClick={() => acceptGroup(item, false)}>拒绝</button>
                  </div>
                </div>
              ))}
            </section>

            {outgoing.length + gout.length > 0 ? (
              <section className="request-panel request-panel-muted">
                <h3>我发出的申请 <span className="request-count">{outgoing.length + gout.length}</span></h3>
                {outgoing.map((item) => (
                  <div className="request-item request-outgoing" key={'f' + item.id}>
                    <span className="request-icon"><Icon name="clock" size={18} /></span>
                    <div className="request-main">
                      <div className="request-title">{item.nickname || item.number}</div>
                      <p className="request-message">等待对方同意</p>
                    </div>
                  </div>
                ))}
                {gout.map((item) => (
                  <div className="request-item request-outgoing" key={'g' + item.id}>
                    <span className="request-icon"><Icon name="clock" size={18} /></span>
                    <div className="request-main">
                      <div className="request-title">{item.name || item.number}</div>
                      <p className="request-message">等待管理员处理</p>
                    </div>
                  </div>
                ))}
              </section>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="contacts-fab">
        <button type="button" className="fab" title="创建群聊" aria-label="创建群聊" onClick={() => setDialog('group')}><Icon name="plus" size={20} /></button>
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}
      {profile ? <ProfileModal token={token} me={me} number={profile} onClose={() => setProfile(null)} onChat={(id) => { setProfile(null); onOpenConversation?.(id); }} onChanged={loadFriends} /> : null}
      {dialog === 'friend' ? <AddFriendModal token={token} onClose={() => setDialog(null)} onChanged={() => { loadFriends(); loadRequests(); }} /> : null}
      {dialog === 'group' ? <CreateGroupModal token={token} onClose={() => setDialog(null)} onCreated={(data) => { loadGroups(); loadFriends(); refreshConversations?.(); if (data?.conversationId) onOpenConversation?.(data.conversationId); }} /> : null}
      {dialog === 'join' ? <JoinGroupModal token={token} onClose={() => setDialog(null)} onJoined={() => { loadGroups(); refreshConversations?.(); }} /> : null}
      {confirm ? <Confirm title={confirm.title} message={confirm.message} danger={confirm.danger} onConfirm={confirm.onConfirm} onClose={() => setConfirm(null)} /> : null}
              {dialog === 'qr' ? (
          <Modal title="我的二维码" icon="qr" width={360} onClose={() => setDialog(null)}>
            <div className="my-qr">
              <QrCode text={String(me?.number || '')} size={190} />
              <b>{me?.nickname || me?.number}</b>
              <span className="my-qr-number">#{me?.number}</span>
              <p className="settings-hint">号码是永久的，别人搜这个号码、或者扫这张码都能加到你。</p>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard?.writeText(String(me?.number || '')); toast('号码已复制', 'success'); }}>
                <Icon name="copy" size={14} /> 复制号码
              </button>
            </div>
          </Modal>
        ) : null}

        {dialog === 'scan' ? (
          <ScanModal onClose={() => setDialog(null)} onFound={(num) => { setDialog(null); setSearch(num); addByNumber(num); }} />
        ) : null}

        {groupInfo ? <GroupInfo token={token} me={me} group={groupInfo} onClose={() => setGroupInfo(null)} onChanged={loadGroups} onLeft={() => { setGroupInfo(null); loadGroups(); refreshConversations?.(); }} /> : null}
      {newGroupName !== null ? (
<Modal title="新建好友分组" icon="folder" width={400} onClose={() => setNewGroupName(null)}>
          <label className="field">
            <span className="field-label">分组名称</span>
            <input className="input" autoFocus maxLength={20} value={newGroupName} onChange={(e) => setNewGroupName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createGroup(); }} placeholder="例如：一起玩的朋友" />
          </label>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setNewGroupName(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={!newGroupName.trim()} onClick={createGroup}>创建</button>
          </div>
        </Modal>
      ) : null}
      {renameGroup ? (
        <Modal title="重命名分组" icon="edit" width={400} onClose={() => setRenameGroup(null)}>
          <label className="field">
            <span className="field-label">分组名称</span>
            <input className="input" autoFocus maxLength={20} value={renameGroup.name} onChange={(e) => setRenameGroup({ ...renameGroup, name: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') renameFriendGroup(); }} />
          </label>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setRenameGroup(null)}>取消</button>
            <button type="button" className="btn btn-primary" disabled={!renameGroup.name.trim()} onClick={renameFriendGroup}>保存</button>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function FriendCard({ friend, onOpen, onMenu }) {
  const status = friend.status || (friend.online ? 'online' : 'offline');
  const meta = statusMeta(status);
  return (
    <button type="button" className={'friend-card' + (friend.special ? ' is-special' : '')} onClick={onOpen} onContextMenu={onMenu}>
      <span className="friend-card-avatar">
        <Avatar number={friend.number} nickname={friend.remark || friend.nickname} avatar={friend.avatar} size={44} status={status} />
      </span>
      <span className="friend-card-main">
        <span className="friend-card-name">{friend.remark || friend.nickname || friend.number}</span>
        <span className="friend-card-sub">
          {meta.label}
          {friend.last_seen && status === 'offline' ? ' · ' + relTime(friend.last_seen) : ''}
        </span>
      </span>
      {friend.special ? <Icon name="starFilled" size={14} className="friend-card-star" /> : null}
    </button>
  );
}

function ScanModal({ onClose, onFound }) {
  const videoRef = useRef(null);
  const [err, setErr] = useState('');
  const [manual, setManual] = useState('');

  useEffect(() => {
    let stream = null;
    let timer = null;
    let stopped = false;
    const start = async () => {
      if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
        setErr('这个浏览器不支持直接扫码，用手机相机扫对方的码，再把号码填进下面。');
        return;
      }
      try {
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        timer = setInterval(async () => {
          if (stopped || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            for (const c of codes) {
              const hit = String(c.rawValue || '').match(/\d{6,12}/);
              if (hit) { stopped = true; onFound(hit[0]); return; }
            }
          } catch { /* 单帧识别失败忽略 */ }
        }, 420);
      } catch (e) {
        setErr('打不开摄像头：' + (e && e.message ? e.message : '权限被拒绝') + '。可以直接填号码。');
      }
    };
    start();
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      if (stream) stream.getTracks().forEach((t) => t.stop());
    };
  }, [onFound]);

  return (
    <Modal title="扫一扫" icon="camera" width={420} onClose={onClose}>
      <div className="scan-body">
        <video ref={videoRef} className="scan-video" muted playsInline />
        <p className="settings-hint">{err || '把对方的二维码放进取景框，识别到就自动加好友。'}</p>
        <label className="field">
          <span className="field-label">或者直接填号码</span>
          <input className="input" inputMode="numeric" placeholder="8-11 位号码" value={manual} onChange={(e) => setManual(e.target.value.replace(/\D/g, '').slice(0, 11))} />
        </label>
        <button type="button" className="btn btn-primary btn-sm" disabled={manual.length < 6} onClick={() => onFound(manual)}>按号码加好友</button>
      </div>
    </Modal>
  );
}
