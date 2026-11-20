import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Empty, Spinner, toast, useIsMobile, ContextMenu } from '../../ui/primitives.jsx';
import { api, toggleFavorite, mediaUrl } from '../../lib/api.js';
import { fmtClock, fmtDate, dayLabel, statusMeta } from '../../lib/format.js';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import GroupInfo from './GroupInfo.jsx';
import ImageViewer from '../../ui/ImageViewer.jsx';
import { ForwardPicker, MergeViewer, SearchModal, AnnouncementModal } from '../shared/Dialogs.jsx';
import ProfileModal from '../shared/ProfileModal.jsx';
import ChatBgPanel from './ChatBgPanel.jsx';
import { CHAT_BG_EVENT, currentChatBgUrl, readChatBg, readChatBgStyle } from '../../lib/chatBg.js';

export default function ChatPanel({ token, me, conversation, conversations = [], onBack, onActivity, onConversationGone, onOpenConversation, focusMessageId, onTypingChange }) {
  const isMobile = useIsMobile();
  const convId = conversation?.id;
  const isGroup = conversation?.kind === 'group';
  const groupNumber = conversation?.group?.number;

  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState(null);
  const [members, setMembers] = useState([]);
  const [typing, setTyping] = useState([]);
  const [reply, setReply] = useState(null);
  const [selection, setSelection] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newCount, setNewCount] = useState(0);
  const [dividerId, setDividerId] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [mergeMeta, setMergeMeta] = useState(null);
  const [forwardMsg, setForwardMsg] = useState(null);
  const [multiForward, setMultiForward] = useState(false);
  const [groupInfo, setGroupInfo] = useState(null);
  const [profile, setProfile] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [announceDismissed, setAnnounceDismissed] = useState(0);
  const [favIds, setFavIds] = useState(() => new Set());
  const [menu, setMenu] = useState(null);
  const [jumped, setJumped] = useState(0);
  const [chatBg, setChatBg] = useState('');
  const [bgStyle, setBgStyle] = useState(() => readChatBgStyle());
  const [chatBgOpen, setChatBgOpen] = useState(false);
  const [typingShown, setTypingShown] = useState([]);

  // 聊天背景：和设置页共用 lib/chatBg.js，任一处改完都派发 fe:chatbg，这里即时生效
  useEffect(() => {
    const read = () => { setChatBg(currentChatBgUrl(readChatBg())); setBgStyle(readChatBgStyle()); };
    read();
    window.addEventListener(CHAT_BG_EVENT, read);
    return () => window.removeEventListener(CHAT_BG_EVENT, read);
  }, []);

  // 正在输入：立刻亮，消失时延迟 300ms 再收，避免轮询抖动导致文字闪回「在线」
  useEffect(() => {
    if (typing.length) {
      setTypingShown(typing);
      return undefined;
    }
    const t = window.setTimeout(() => setTypingShown([]), 300);
    return () => window.clearTimeout(t);
  }, [typing]);

  // 上抬到会话列表：列表行也能显示「对方正在输入…」+ 呼吸点
  useEffect(() => {
    onTypingChange?.(convId, typingShown);
  }, [typingShown, convId, onTypingChange]);

  const listRef = useRef(null);
  const bottomRef = useRef(null);
  const lastIdRef = useRef(0);
  const typingRef = useRef(0);
  const pollDelayRef = useRef(2000);
  const atBottomRef = useRef(true);
  const initialLenRef = useRef(0);

  atBottomRef.current = atBottom;

  const groupMeta = detail || conversation?.group || {};
  const myRole = detail?.role || groupMeta.role;
  const mutedAll = !!groupMeta.mute_all;
  const myMuteUntil = Number(detail?.my_mute_until || 0);
  const canManageGroup = myRole === 'owner' || myRole === 'admin';
  const muted = !!conversation?.muted;
  const pinned = !!conversation?.pinned;
  const peerStatus = conversation?.peer?.status || (conversation?.peer?.online ? 'online' : 'offline');

  const disabledReason = (() => {
    if (!isGroup) return '';
    if (mutedAll && !canManageGroup) return '全员禁言中，仅群主和管理员可发言';
    if (myMuteUntil > Date.now() && !canManageGroup) return '你已被禁言，暂时不能发言';
    return '';
  })();

  const scrollToBottom = useCallback((smooth) => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    setNewCount(0);
    setDividerId(null);
  }, []);

  const loadDetail = useCallback(async () => {
    if (!isGroup || !groupNumber) { setDetail(null); return; }
    try {
      const [g, m] = await Promise.all([
        api('/api/groups/' + groupNumber, { token }),
        api('/api/groups/' + groupNumber + '/members', { token }),
      ]);
      setDetail(g.group || null);
      setMembers(m.members || []);
    } catch (err) {
      // 无权限/已退群时静默
    }
  }, [isGroup, groupNumber, token]);

  const initialLoad = useCallback(async () => {
    if (!convId) return;
    setLoading(true);
    setMessages([]);
    lastIdRef.current = 0;
    try {
      let collected = [];
      let after = 0;
      for (let i = 0; i < 6; i += 1) {
        const data = await api('/api/conversations/' + convId + '/messages?after=' + after, { token });
        const page = data.messages || [];
        collected = collected.concat(page);
        if (page.length < 200) break;
        after = page[page.length - 1].id;
      }
      if (collected.length > 400) collected = collected.slice(-400);
      setMessages(collected);
      lastIdRef.current = collected.length ? collected[collected.length - 1].id : 0;
      initialLenRef.current = collected.length;
      setLoading(false);
      requestAnimationFrame(() => scrollToBottom(false));
      api('/api/conversations/' + convId + '/read', { method: 'POST', token }).catch(() => {});
    } catch (err) {
      setLoading(false);
      if (err.message.includes('404')) {
        onConversationGone?.();
      } else {
        toast(err.message, 'error');
      }
    }
  }, [convId, token, scrollToBottom, onConversationGone]);

  const loadFavorites = useCallback(async () => {
    try {
      const data = await api('/api/favorites', { token });
      const list = (data.favorites || []).map((f) => f.message?.id).filter(Boolean);
      setFavIds(new Set(list));
    } catch {
      // 忽略
    }
  }, [token]);

  useEffect(() => {
    setReply(null);
    setSelection(null);
    setDividerId(null);
    setNewCount(0);
    setAnnounceDismissed(0);
    initialLoad();
    loadDetail();
    loadFavorites();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [convId]);

  const poll = useCallback(async () => {
    if (!convId) return;
    try {
      const data = await api('/api/conversations/' + convId + '/messages?after=' + lastIdRef.current, { token });
      const incoming = data.messages || [];
      if (incoming.length) {
        const first = incoming[0];
        setMessages((prev) => {
          const exists = new Set(prev.map((m) => m.id));
          const add = incoming.filter((m) => !exists.has(m.id));
          return prev.concat(add);
        });
        lastIdRef.current = incoming[incoming.length - 1].id;
        if (!atBottomRef.current) {
          setNewCount((c) => c + incoming.length);
          setDividerId((d) => d || first.id);
        } else {
          requestAnimationFrame(() => scrollToBottom(true));
          api('/api/conversations/' + convId + '/read', { method: 'POST', token }).catch(() => {});
        }
        onActivity?.();
      }
      setTyping(data.typing || []);
      if (data.announcement !== undefined) {
        setDetail((prev) => (prev ? { ...prev, announcement: data.announcement } : prev));
      }
      pollDelayRef.current = 2000;
      return true;
    } catch {
      // 失败按 2s→4s→8s→15s 退避，断线提示条由 api() 统一上报
      pollDelayRef.current = Math.min(Math.max(pollDelayRef.current, 2000) * 2, 15000);
      return false;
    }
  }, [convId, token, scrollToBottom, onActivity]);

  /* 轮询循环只跟 convId 绑：poll 每次渲染都可能是新函数，循环要是跟着重建，
     1.2 秒的定时器就会被每秒一次的重渲染反复清掉、永远等不到触发 ——
     表现就是「对方回了我这边一直卡住」。用 ref 拿最新 poll，循环本身保持稳定。 */
  const pollRef = useRef(poll);
  useEffect(() => {
    pollRef.current = poll;
  }, [poll]);
  const lastOkRef = useRef(Date.now());

  /* 消息轮询：成功 2s 一次，失败退避；窗口重新聚焦/切回页面立刻补一次 */
  useEffect(() => {
    if (!convId) return undefined;
    pollDelayRef.current = 2000;
    lastOkRef.current = Date.now();
    let stopped = false;
    let timer = null;
    let busy = false;
    const tick = async () => {
      if (stopped || busy) return;
      busy = true;
      try {
        const good = await pollRef.current();
        if (good !== false) lastOkRef.current = Date.now();
      } finally {
        busy = false;
      }
      if (stopped) return;
      timer = window.setTimeout(tick, Math.max(600, pollDelayRef.current));
    };
    timer = window.setTimeout(tick, 400);
    /* 看门狗：万一定时器被什么意外打断，超过 8 秒没成功刷新就强制补一次 */
    const guard = window.setInterval(() => {
      if (stopped || busy) return;
      if (Date.now() - lastOkRef.current < 8000) return;
      if (timer) window.clearTimeout(timer);
      tick();
    }, 4000);
    const onWake = () => {
      if (stopped || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
      if (timer) window.clearTimeout(timer);
      tick();
    };
    window.addEventListener('focus', onWake);
    document.addEventListener('visibilitychange', onWake);
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
      window.clearInterval(guard);
      window.removeEventListener('focus', onWake);
      document.removeEventListener('visibilitychange', onWake);
    };
  }, [convId]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        if (selection) { setSelection(null); return; }
        if (searchOpen) { setSearchOpen(false); return; }
        if (profile) { setProfile(null); return; }
        if (groupInfo) { setGroupInfo(null); return; }
        if (isMobile) onBack?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, searchOpen, profile, groupInfo, isMobile, onBack]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    setAtBottom(bottom);
    if (bottom) {
      setNewCount(0);
      setDividerId(null);
      if (isGroup && groupMeta.announcement) {
        // 触底不自动已读公告，交给公告弹窗
      }
      api('/api/conversations/' + convId + '/read', { method: 'POST', token }).catch(() => {});
    }
  };

  const send = async (payload) => {
    if (!convId) return;
    const now = Date.now();
    const optimistic = {
      id: 'tmp-' + now + '-' + Math.random().toString(16).slice(2, 6),
      mine: true,
      body: payload.body,
      kind: payload.kind || 'text',
      recalled: false,
      created_at: now,
      meta: payload.meta || null,
      mentionAll: !!payload.mentionAll,
      reply: reply ? { id: reply.id, number: reply.sender?.number || (reply.mine ? me?.number : ''), nickname: reply.mine ? me?.nickname : reply.sender?.nickname, body: reply.body, kind: reply.kind } : null,
      reactions: [],
      sender: { number: me?.number, nickname: me?.nickname, avatar: me?.avatar },
      pending: true,
    };
    setMessages((prev) => [...prev, optimistic]);
    requestAnimationFrame(() => scrollToBottom(true));
    const url = isGroup ? '/api/groups/' + groupNumber + '/messages' : '/api/conversations/' + convId + '/messages';
    try {
      const data = await api(url, { method: 'POST', token, body: payload });
      const created = data.message;
      setMessages((prev) => prev.map((m) => (m.id === optimistic.id ? { ...created, sender: created.sender || optimistic.sender } : m)));
      if (created?.id) lastIdRef.current = Math.max(lastIdRef.current, created.id);
      requestAnimationFrame(() => scrollToBottom(true));
    } catch (err) {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === optimistic.id
            ? { ...m, pending: false, failed: true, failReason: err.message || '发送失败', retryPayload: payload }
            : m,
        ),
      );
      toast(err.message, 'error');
      throw err;
    }
  };

  /** 失败重发：删掉这条占位，用原来的内容重新发一次 */
  const retrySend = async (message) => {
    const payload = message.retryPayload || { kind: message.kind, body: message.body, meta: message.meta };
    setMessages((prev) => prev.filter((m) => m.id !== message.id));
    try {
      await send(payload);
    } catch {
      // send 内部已经提示
    }
  };

  const typingPing = useCallback(() => {
    const now = Date.now();
    if (now - typingRef.current < 2200) return;
    typingRef.current = now;
    api('/api/conversations/' + convId + '/typing', { method: 'POST', token, body: { typing: true } }).catch(() => {});
  }, [convId, token]);

  const react = async (message, emoji) => {
    try {
      const data = await api('/api/messages/' + message.id + '/reactions', { method: 'POST', token, body: { emoji } });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, reactions: data.reactions || [] } : m)));
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const toggleFav = async (message) => {
    if (!message?.id) return;
    const on = !favIds.has(message.id);
    try {
      await toggleFavorite(message.id, on, token);
      setFavIds((prev) => {
        const next = new Set(prev);
        if (on) next.add(message.id); else next.delete(message.id);
        return next;
      });
      toast(on ? '已收藏' : '已取消收藏', 'success');
      onActivity?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const deleteMsg = async (message) => {
    try {
      await api('/api/messages/' + message.id + '/delete', { method: 'POST', token });
      setMessages((prev) => prev.filter((m) => m.id !== message.id));
      toast('已删除（仅自己可见）', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const recallMsg = async (message) => {
    try {
      await api('/api/messages/' + message.id + '/recall', { method: 'POST', token });
      setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, recalled: true, body: '', reactions: [], meta: null } : m)));
      toast('已撤回', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const jumpTo = (id) => {
    const el = document.getElementById('msg-' + id);
    if (!el) { toast('这条消息不在当前视图里', 'info'); return; }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setJumped(id);
    setTimeout(() => setJumped((v) => (v === id ? 0 : v)), 1800);
  };

  useEffect(() => {
    if (!focusMessageId || loading) return undefined;
    const timer = window.setTimeout(() => jumpTo(focusMessageId), 160);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusMessageId, loading]);

  const openImage = (message) => {
    const imgs = messages.filter((m) => m.kind === 'image' && !m.recalled).map((m) => ({ url: mediaUrl(m.body), name: m.meta?.name }));
    const index = imgs.findIndex((x) => x.url === mediaUrl(message.body));
    setViewer({ items: imgs, index: Math.max(0, index) });
  };

  const convLabel = (conv) => (conv?.kind === 'group' ? conv.group?.name : conv?.peer?.nickname || conv?.peer?.number) || '会话';

  const forwardOne = async (conv) => {
    if (!forwardMsg) return;
    await api('/api/messages/' + forwardMsg.id + '/forward', { method: 'POST', token, body: { conversationId: conv.id } });
    toast('已转发到 ' + convLabel(conv), 'success');
    onActivity?.();
  };

  const forwardMerge = async (conv) => {
    const ids = Array.from(selection || []);
    if (!ids.length) return;
    await api('/api/conversations/' + convId + '/forward-merge', { method: 'POST', token, body: { messageIds: ids, conversationId: conv.id } });
    toast('已合并转发 ' + ids.length + ' 条到 ' + convLabel(conv), 'success');
    setSelection(null);
    onActivity?.();
  };

  /* 合并记录查看器里的「逐条转发」：把单条记录做成一张转发卡发到目标会话 */
  const forwardMergedItem = async (conv, item) => {
    if (!item || !conv?.id) return;
    await api('/api/conversations/' + conv.id + '/messages', {
      method: 'POST',
      token,
      body: {
        kind: 'forward',
        body: '[转发的消息]',
        meta: {
          from: { number: item.number, nickname: item.nickname },
          source: { kind: item.kind || 'text', body: item.body, created_at: item.created_at },
        },
      },
    });
    toast('已转发到 ' + convLabel(conv), 'success');
    onActivity?.();
  };

  const toggleMute = async () => {
    try {
      await api('/api/conversations/' + convId + '/mute', { method: 'POST', token, body: { muted: !muted } });
      toast(muted ? '已关闭免打扰' : '已开启免打扰', 'success');
      onActivity?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const togglePin = async () => {
    try {
      await api('/api/conversations/' + convId + '/pin', { method: 'POST', token });
      toast(pinned ? '已取消置顶' : '已置顶', 'success');
      onActivity?.();
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const openGroupInfo = (tab) => setGroupInfo({ tab: tab || 'members' });
  const openMember = (num, mode) => {
    if (!num) return;
    if (mode === 'mention') {
      const m = members.find((x) => x.number === num);
      if (m && !disabledReason) toast('在输入框打 @' + (m.nickname || m.number) + ' 就能提醒 TA', 'info');
      return;
    }
    setProfile(num);
  };

  const title = isGroup ? groupMeta.name || '群聊' : conversation?.peer?.nickname || '会话';
  const typingNames = typingShown.map((t) => t.nickname || t.number).filter(Boolean);
  /* 用户 2026-11-17：Bot 和个人号一律显示「对方正在输入…」，不许出现「正在思考」；群聊里完全不显示 */
  const typingLabel = !isGroup && typingNames.length ? '对方正在输入…' : '';
  // 群详情里的 members 正常是人数；万一某个服务端回的是成员数组，这里也要算对，不能拼成 [object Object]
  const groupMemberCount = Array.isArray(detail?.members) ? detail.members.length : Number(detail?.members || 0);
  const subtitle = isGroup
    ? (groupMemberCount ? groupMemberCount + ' 人' : '群聊') + (mutedAll ? ' · 全员禁言' : '')
    : statusMeta(peerStatus).label + (conversation?.peer?.bio ? ' · ' + conversation.peer.bio : '');

  const announceUnread = isGroup && groupMeta.announcement && Number(groupMeta.announcement_updated_at || 0) > Number(detail?.announcement_read_at || 0) && announceDismissed === 0;

  /* 头部副标题：有人在输入时换成 3 个跳动点 + 昵称，和在线状态文字不打架 */
  const headSub = typingLabel ? (
    <>
      <span className="typing-dots" aria-hidden><i /><i /><i /></span>
      <span className="chat-head-sub-text">{typingLabel}</span>
    </>
  ) : subtitle;

  return (
    <section className="chat-panel">
      <header className="chat-head">
        {isMobile ? (
          <button type="button" className="icon-btn chat-back" onClick={onBack} aria-label="返回">
            <Icon name="back" size={20} />
          </button>
        ) : null}
        {isGroup ? (
          <button type="button" className="chat-head-main" onClick={() => openGroupInfo('members')}>
            <Avatar number={groupNumber} nickname={title} avatar={detail?.group?.avatar || detail?.avatar || conversation?.group?.avatar} square size={38} />
            <span className="chat-head-text">
              <b>{title}</b>
              <span className={'chat-head-sub' + (typingLabel ? ' typing' : '')}>{headSub}</span>
            </span>
          </button>
        ) : (
          <button type="button" className="chat-head-main" onClick={() => setProfile(conversation?.peer?.number)}>
            <Avatar number={conversation?.peer?.number} nickname={title} avatar={conversation?.peer?.avatar} size={38} status={peerStatus} />
            <span className="chat-head-text">
              <b>{title}</b>
              <span className={'chat-head-sub' + (typingLabel ? ' typing' : '')}>{headSub}</span>
            </span>
          </button>
        )}
        <div className="chat-head-actions">
          <button
            type="button"
            className={'icon-btn' + (selection ? ' on' : '')}
            onClick={() => setSelection(selection ? null : new Set())}
            title="多选消息"
            aria-label="多选消息"
          >
            <Icon name="list" size={19} />
          </button>
          {isGroup ? (
            <button type="button" className="icon-btn" onClick={() => openGroupInfo('members')} title="群资料" aria-label="群资料">
              <Icon name="users" size={19} />
            </button>
          ) : null}
          <button type="button" className={'icon-btn' + (muted ? ' on' : '')} onClick={toggleMute} title={muted ? '关闭免打扰' : '消息免打扰'} aria-label="免打扰">
            <Icon name={muted ? 'mute' : 'bell'} size={19} />
          </button>


        </div>
      </header>

      {announceUnread ? (
        <button type="button" className="chat-announce" onClick={() => { setAnnounceOpen(true); setAnnounceDismissed(1); }}>
          <span className="chat-announce-icon"><Icon name="bell" size={16} /></span>
          <span className="chat-announce-text"><b>群公告更新</b><span>{groupMeta.announcement}</span></span>
          <Icon name="chevron" size={16} />
        </button>
      ) : null}

      {selection ? (
        <div className="chat-selectbar">
          <button type="button" className="icon-btn" onClick={() => setSelection(null)} aria-label="取消多选"><Icon name="close" size={18} /></button>
          <span className="chat-selectbar-count">已选 {selection.size} 条</span>
          <div className="chat-selectbar-actions">
            <button type="button" className="btn btn-sm btn-primary" disabled={!selection.size} onClick={() => setMultiForward(true)}>
              <Icon name="merge" size={15} /> 合并转发
            </button>
          </div>
        </div>
      ) : null}

      <div
        className={'msg-list' + (chatBg ? ' has-chat-bg' : '')}
        ref={listRef}
        onScroll={onScroll}
        style={chatBg ? {
          backgroundImage: 'url("' + chatBg + '")',
          backgroundSize: bgStyle.fit === 'repeat' ? 'auto' : bgStyle.fit,
          backgroundPosition: bgStyle.pos,
          backgroundRepeat: bgStyle.fit === 'repeat' ? 'repeat' : 'no-repeat',
        } : undefined}
      >
        {loading ? (
          <div className="msg-loading"><Spinner size={20} /> 正在载入消息</div>
        ) : messages.length === 0 ? (
          <Empty icon={isGroup ? 'group' : 'chat'} title={isGroup ? '群聊刚刚开始' : '打个招呼吧'} sub="发第一条消息，开启这段对话" />
        ) : (
          <>
            {messages.map((m, i) => {
              const prev = messages[i - 1];
              const showDay = !prev || dayLabel(prev.created_at) !== dayLabel(m.created_at);
              const compact = !showDay && !!prev && prev.mine === m.mine && !isGroup && Number(m.created_at) - Number(prev.created_at) < 3 * 60 * 1000;
              return (
                <div key={m.id} className="msg-wrap">
                  {showDay ? <div className="msg-day"><span>{dayLabel(m.created_at)}</span></div> : null}
                  {dividerId === m.id ? <div className="msg-divider"><span>以下是新消息</span></div> : null}
                  <Message
                    message={{ ...m, jumped: jumped === m.id }}
                    me={me}
                    group={isGroup}
                    peer={conversation?.peer}
                    compact={compact}
                    selectionMode={!!selection}
                    selected={selection ? selection.has(m.id) : false}
                    favorited={favIds.has(m.id)}
                    onReply={(msg) => { setReply(msg); }}
                    onForward={(msg) => setForwardMsg(msg)}
                    onMultiSelect={(msg) => { setSelection(new Set([msg.id])); setReply(null); }}
                    onReact={react}
                    onToggleFavorite={toggleFav}
                    onDelete={deleteMsg}
                    onRecall={recallMsg}
                    onRetry={retrySend}
                    onJumpTo={jumpTo}
                    onOpenImage={openImage}
                    onOpenMerge={(meta) => setMergeMeta(meta)}
                    onOpenUser={(num) => openMember(num)}
                    onToggleSelect={(msg) => setSelection((prev) => {
                      const next = new Set(prev || []);
                      if (next.has(msg.id)) next.delete(msg.id); else next.add(msg.id);
                      return next;
                    })}
                  />
                </div>
              );
            })}
            <div ref={bottomRef} className="msg-bottom-anchor" />
          </>
        )}
      </div>

      {newCount > 0 ? (
        <button type="button" className="scroll-bottom" onClick={() => scrollToBottom(true)}>
          <Icon name="down" size={16} />
          <span>{newCount} 条新消息</span>
        </button>
      ) : !atBottom && !loading && messages.length > 0 ? (
        <button type="button" className="scroll-bottom quiet" onClick={() => scrollToBottom(true)} aria-label="回到底部">
          <Icon name="down" size={16} />
        </button>
      ) : null}

      {typingLabel && atBottom ? (
        <div className="typing-line" aria-live="polite">
          <span className="typing-dots" aria-hidden><i /><i /><i /></span>
          <span className="typing-line-text">{typingLabel}</span>
        </div>
      ) : null}

      <Composer
        token={token}
        conversationId={convId}
        isGroup={isGroup}
        group={detail || groupMeta}
        members={members}
        me={me}
        reply={reply}
        onCancelReply={() => setReply(null)}
        onSend={send}
        onTyping={typingPing}
        disabledReason={disabledReason}
      />

      {/* 聊天页右侧的浮动快捷菜单整块删除（用户 2026-11-17 两次明确要求：私聊和群聊都不要，不是修） */}

      {viewer ? <ImageViewer items={viewer.items} index={viewer.index} onIndex={(i) => setViewer((v) => ({ ...v, index: i }))} onClose={() => setViewer(null)} /> : null}
      {chatBgOpen ? <ChatBgPanel onClose={() => setChatBgOpen(false)} /> : null}
      {mergeMeta ? <MergeViewer meta={mergeMeta} token={token} onForward={forwardMergedItem} onClose={() => setMergeMeta(null)} /> : null}
      {forwardMsg ? (
        <ForwardPicker token={token} excludeId={convId} title="转发到" onClose={() => setForwardMsg(null)} onPick={(conv) => forwardOne(conv)} />
      ) : null}
      {multiForward ? (
        <ForwardPicker token={token} excludeId={convId} title={'合并转发 ' + (selection?.size || 0) + ' 条消息'} onClose={() => setMultiForward(false)} onPick={(conv) => forwardMerge(conv)} />
      ) : null}
      {groupInfo ? (
        <GroupInfo
          token={token}
          me={me}
          group={{ number: groupNumber, name: groupMeta.name }}
          initialTab={groupInfo.tab}
          onClose={() => setGroupInfo(null)}
          onChanged={() => { loadDetail(); onActivity?.(); }}
          onMemberClick={(num, mode) => openMember(num, mode)}
          onLeft={() => { onConversationGone?.(); }}
        />
      ) : null}
      {profile ? (
        <ProfileModal token={token} me={me} number={profile} onClose={() => setProfile(null)}
          onChat={(id) => { setProfile(null); onOpenConversation?.(id); }}
          onChanged={() => onActivity?.()} />
      ) : null}
      {announceOpen ? (
        <AnnouncementModal token={token} group={detail || groupMeta} canEdit={canManageGroup} onClose={() => setAnnounceOpen(false)} onChanged={() => { loadDetail(); onActivity?.(); }} />
      ) : null}
    </section>
  );
}
