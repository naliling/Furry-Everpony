import { useCallback, useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Badge, ContextMenu, Empty, Modal, Spinner, toast, useIsMobile, useLongPress, useSwipeBack, Spinner as Spin } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { previewFor, relTime, statusMeta } from '../../lib/format.js';
import ChatPanel from './ChatPanel.jsx';
import { AddFriendModal, CreateGroupModal, JoinGroupModal } from '../shared/Dialogs.jsx';

export default function ChatTab({ token, me, conversations, refreshConversations, openConvId, openMsgId, onConsumedOpen, onGoTab, newChatSignal, onOpenNotifications, notifCount = 0 }) {
  const isMobile = useIsMobile();
  const [activeId, setActiveId] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [menu, setMenu] = useState(null);
  const [newChat, setNewChat] = useState(false);
  const [dialog, setDialog] = useState(null);
  const [lastConv, setLastConv] = useState(null);
  /* 哪些会话里有人正在输入：key=convId，value={ list, at }，at 用于 6.5s 过期 */
  const [typingMap, setTypingMap] = useState({});
  const [typingNow, setTypingNow] = useState(() => Date.now());

  const onTypingChange = useCallback((convId, list) => {
    if (!convId) return;
    const items = Array.isArray(list) ? list : [];
    setTypingMap((prev) => {
      const cur = prev[convId];
      if (!items.length) {
        if (!cur) return prev;
        const next = { ...prev };
        delete next[convId];
        return next;
      }
      return { ...prev, [convId]: { list: items, at: Date.now() } };
    });
  }, []);

  /* 有会话在输入时才开 1s 心跳，用来把过期的输入状态自然收掉 */
  useEffect(() => {
    if (!Object.keys(typingMap).length) return undefined;
    const t = window.setInterval(() => setTypingNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [typingMap]);

  const list = useMemo(() => {
    const kw = search.trim().toLowerCase();
    return (conversations || []).filter((c) => {
      if (filter === 'unread' && !c.unread) return false;
      if (!kw) return true;
      const name = c.kind === 'group' ? c.group?.name : c.peer?.nickname || c.peer?.number;
      return String(name || '').toLowerCase().includes(kw);
    });
  }, [conversations, filter, search]);

  useEffect(() => {
    const active = (conversations || []).find((c) => c.id === activeId);
    if (active) setLastConv(active);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, activeId]);

  useEffect(() => {
    if (openConvId) {
      setActiveId(openConvId);
      onConsumedOpen?.();
    }
  }, [openConvId, onConsumedOpen]);

  useEffect(() => {
    if (newChatSignal > 0) setNewChat(true);
  }, [newChatSignal]);

  const activeConv = (conversations || []).find((c) => c.id === activeId) || (lastConv?.id === activeId ? lastConv : null);

  const openConv = (c) => {
    setActiveId(c.id);
  };

  const back = () => setActiveId(null);
  const swipe = useSwipeBack(isMobile && !!activeId, back);

  const convMenu = (e, conv) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [
      {
        label: conv.pinned ? '取消置顶' : '置顶会话',
        icon: 'pin',
        onClick: async () => {
          try { await api('/api/conversations/' + conv.id + '/pin', { method: 'POST', token }); refreshConversations?.(); } catch (err) { toast(err.message, 'error'); }
        },
      },
      {
        label: conv.muted ? '关闭免打扰' : '消息免打扰',
        icon: 'mute',
        checked: !!conv.muted,
        onClick: async () => {
          try { await api('/api/conversations/' + conv.id + '/mute', { method: 'POST', token, body: { muted: !conv.muted } }); refreshConversations?.(); } catch (err) { toast(err.message, 'error'); }
        },
      },
      {
        label: '标记已读',
        icon: 'check',
        onClick: async () => {
          try { await api('/api/conversations/' + conv.id + '/read', { method: 'POST', token }); refreshConversations?.(); } catch (err) { toast(err.message, 'error'); }
        },
      },
      { divider: true },
      {
        label: '复制名称',
        icon: 'copy',
        onClick: () => {
          const name = conv.kind === 'group' ? conv.group?.name : conv.peer?.nickname;
          navigator.clipboard?.writeText(String(name || '')).then(() => toast('已复制', 'success')).catch(() => {});
        },
      },
    ];
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const createChat = async (number) => {
    try {
      const data = await api('/api/dm', { method: 'POST', token, body: { number } });
      await refreshConversations?.();
      setActiveId(data.conversationId);
      setNewChat(false);
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const afterCreateGroup = async (data) => {
    await refreshConversations?.();
    if (data?.conversationId) setActiveId(data.conversationId);
  };

  const afterJoinGroup = async () => {
    await refreshConversations?.();
  };

  const unreadCount = (conversations || []).reduce((sum, c) => sum + (c.muted ? 0 : c.unread || 0), 0);

  return (
    <div className="chat-tab">
      <div className={'conv-column' + (isMobile && activeId ? ' conv-hidden-mobile' : '')}>
        <header className="conv-head">
          <div className="conv-title">
            <h2>消息</h2>
            {unreadCount > 0 ? <span className="conv-title-badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
          </div>
          <div className="conv-head-actions">
            {onOpenNotifications ? (
              <button type="button" className="icon-btn conv-bell" onClick={onOpenNotifications} title="通知中心" aria-label="通知中心">
                <Icon name="bell" size={19} />
                {notifCount > 0 ? <span className="icon-badge">{notifCount > 99 ? '99+' : notifCount}</span> : null}
              </button>
            ) : null}
            <button type="button" className="icon-btn" onClick={() => setNewChat(true)} title="发起会话" aria-label="发起会话">
              <Icon name="plus" size={19} />
            </button>
          </div>
        </header>

        <div className="conv-tools">
          <div className="input-wrap conv-search">
            <Icon name="search" size={15} className="input-lead" />
            <input className="input input-sm" placeholder="搜索会话" value={search} onChange={(e) => setSearch(e.target.value)} />
            {search ? <button type="button" className="input-clear" onClick={() => setSearch('')} aria-label="清空"><Icon name="close" size={13} /></button> : null}
          </div>
          <div className="conv-filter">
            <button type="button" className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>全部</button>
            <button type="button" className={filter === 'unread' ? 'on' : ''} onClick={() => setFilter('unread')}>未读</button>
          </div>
        </div>

        <div className="conv-list">
          {list.length === 0 ? (
            <Empty icon="chat" title={search ? '没有匹配的会话' : '还没有会话'} sub={search ? '换个关键词试试' : '添加好友后就能开始聊天'} compact />
          ) : (
            list.map((c) => {
              const name = c.kind === 'group' ? c.group?.name || '群聊' : c.peer?.nickname || c.peer?.number || '会话';
              const avatar = c.kind === 'group' ? null : c.peer?.avatar;
              const last = c.last;
              const preview = last ? last.preview || previewFor(last) : '还没有消息';
              const selected = c.id === activeId;
              const typingEntry = typingMap[c.id];
              const typingLive = !!typingEntry && typingEntry.list.length > 0 && typingNow - typingEntry.at < 6500;
              const typingText = typingLive
                ? (c.kind === 'group'
                    ? typingEntry.list.slice(0, 2).map((t) => t.nickname || t.number).join('、') + ' 正在输入…'
                    : '对方正在输入…')
                : '';
              return (
                <div
                  key={c.id}
                  role="button"
                  tabIndex={0}
                  className={'conv-item' + (selected ? ' on' : '') + (c.muted ? ' muted' : '') + (typingLive ? ' typing' : '')}
                  onClick={() => openConv(c)}
                  onKeyDown={(e) => { if (e.key === 'Enter') openConv(c); }}
                  onContextMenu={(e) => convMenu(e, c)}
                >
                  <span className="conv-avatar">
                    <Avatar number={c.kind === 'group' ? c.group?.number : c.peer?.number} nickname={name} avatar={avatar} size={44} square={c.kind === 'group'} status={c.kind === 'group' ? undefined : c.peer?.status || (c.peer?.online ? 'online' : 'offline')} />
                    {c.pinned ? <span className="conv-pin"><Icon name="pin" size={11} /></span> : null}
                  </span>
                  <span className="conv-main">
                    <span className="conv-line">
                      <span className="conv-name">
                        {c.muted ? <Icon name="mute" size={12} className="conv-mute-icon" /> : null}
                        {name}
                        {c.kind === 'group' ? <span className="conv-kind">群</span> : null}
                      </span>
                      <span className="conv-time">{last ? relTime(last.created_at) : ''}</span>
                    </span>
                    <span className="conv-line">
                      {typingLive ? (
                        <span className="conv-preview conv-typing">
                          <span className="conv-typing-dots" aria-hidden><i /><i /><i /></span>
                          <span className="conv-typing-text">{typingText}</span>
                        </span>
                      ) : (
                        <span className="conv-preview">{last?.mine ? '我：' : ''}{preview}</span>
                      )}
                      {c.unread > 0 ? (c.muted ? <span className="conv-dot" /> : <Badge count={c.unread} />) : null}
                    </span>
                  </span>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div
        className={'chat-column' + (isMobile && !activeId ? ' chat-hidden-mobile' : '')}
        style={isMobile && activeId ? { transform: 'translateX(' + swipe.offset + 'px)' } : undefined}
        {...(isMobile && activeId ? swipe.handlers : {})}
      >
        {activeConv ? (
          <ChatPanel
            token={token}
            me={me}
            conversation={activeConv}
            conversations={conversations}
            onBack={back}
            onActivity={() => refreshConversations?.()}
            onConversationGone={() => { setActiveId(null); refreshConversations?.(); }}
            onOpenConversation={(id) => setActiveId(id)}
            focusMessageId={openMsgId}
            onTypingChange={onTypingChange}
          />
        ) : (
          <div className="chat-welcome">
            <div className="chat-welcome-orb" aria-hidden><span /><span /><span /></div>
            <Icon name="chatBubble" size={44} className="chat-welcome-icon" />
            <h2>选一个会话开始聊天</h2>
            <p>或者通过下面的快捷入口认识新朋友、建个群。</p>
            <div className="chat-welcome-actions">
              <button type="button" className="btn btn-primary" onClick={() => setDialog('friend')}><Icon name="friend" size={17} /> 加好友</button>
              <button type="button" className="btn btn-ghost" onClick={() => setDialog('group')}><Icon name="group" size={17} /> 创建群聊</button>
              <button type="button" className="btn btn-ghost" onClick={() => setDialog('join')}><Icon name="plus" size={17} /> 加入群</button>
            </div>
            <div className="chat-welcome-hint">
              <Icon name="keyboard" size={14} /> Ctrl+F 搜索聊天记录 · Ctrl+N 发起会话
            </div>
          </div>
        )}
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}

      {newChat ? <NewChatModal token={token} onClose={() => setNewChat(false)} onCreate={createChat} /> : null}
      {dialog === 'friend' ? <AddFriendModal token={token} onClose={() => setDialog(null)} onChanged={() => { refreshConversations?.(); }} /> : null}
      {dialog === 'group' ? <CreateGroupModal token={token} onClose={() => setDialog(null)} onCreated={afterCreateGroup} /> : null}
      {dialog === 'join' ? <JoinGroupModal token={token} onClose={() => setDialog(null)} onJoined={afterJoinGroup} /> : null}
    </div>
  );
}

function NewChatModal({ token, onClose, onCreate }) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{5,12}$/.test(number);
  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try { await onCreate(number); } finally { setBusy(false); }
  };
  return (
    <Modal title="发起会话" icon="chat" onClose={onClose} width={400}>
      <label className="field">
        <span className="field-label">对方号码</span>
        <div className="input-wrap">
          <Icon name="hash" size={16} className="input-lead" />
          <input className="input input-number" autoFocus inputMode="numeric" placeholder="5–12 位数字" value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </div>
        <span className="field-hint">可以直接和任意号码聊天的前提是对方允许；也可以先加好友。</span>
      </label>
      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <Spinner size={15} /> : <Icon name="chat" size={16} />} 开始聊天
        </button>
      </div>
    </Modal>
  );
}
