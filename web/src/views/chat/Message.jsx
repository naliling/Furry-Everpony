import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, ContextMenu, useIsMobile, toast } from '../../ui/primitives.jsx';
import { QUICK_REACTIONS, REACTION_CHOICES, mediaUrl } from '../../lib/api.js';
import { fmtClock, fmtSize, fmtDuration, previewFor, splitMentions } from '../../lib/format.js';

const KIND_LABEL = { image: '[图片]', file: '[文件]', voice: '[语音]', merge: '[聊天记录]', forward: '[聊天记录]' };

/** 把正文里的 http(s) 链接拆出来，其余保持纯文本 */
function linkifyParts(text) {
  const src = String(text || '');
  const out = [];
  const re = /(https?:\/\/[^\s<>"'）)】」』]+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(src)) !== null) {
    if (m.index > last) out.push({ text: src.slice(last, m.index) });
    out.push({ link: m[0].replace(/[.,;:!?]+$/, '') });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ text: src.slice(last) });
  return out;
}

function openLink(url) {
  try {
    if (typeof window !== 'undefined' && window.fe && typeof window.fe.openExternal === 'function') {
      window.fe.openExternal(url);
      return;
    }
  } catch {
    // 落到浏览器兜底
  }
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener,noreferrer');
}

function RichText({ text }) {
  const parts = linkifyParts(text);
  if (parts.length === 1 && parts[0].text !== undefined) return <>{parts[0].text}</>;
  return (
    <>
      {parts.map((p, i) =>
        p.link ? (
          <a
            key={i}
            className="msg-link"
            href={p.link}
            title={p.link}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); openLink(p.link); }}
          >
            {p.link}
          </a>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export default function Message(props) {
  const {
    message,
    me,
    group,
    peer,
    compact,
    showTime,
    selectionMode,
    selected,
    favorited,
    onReply,
    onForward,
    onMultiSelect,
    onReact,
    onToggleFavorite,
    onDelete,
    onRecall,
    onJumpTo,
    onOpenImage,
    onOpenMerge,
    onOpenUser,
    onToggleSelect,
  } = props;

  const isMine = !!message.mine;
  const isMobile = useIsMobile();
  const [reactOpen, setReactOpen] = useState(false);
  const [menu, setMenu] = useState(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [audioDur, setAudioDur] = useState(0);
  const audioRef = useRef(null);
  const bubbleRef = useRef(null);

  const sender = message.sender
    || (isMine
      ? { number: me?.number, nickname: me?.nickname, avatar: me?.avatar }
      : { number: peer?.number, nickname: peer?.nickname, avatar: peer?.avatar, online: peer?.online });
  const name = sender?.nickname || sender?.number || '未知';
  const canRecall = isMine && !message.recalled && Date.now() - Number(message.created_at || 0) < 2 * 60 * 1000;
  const canDelete = !message.recalled;
  const isImage = message.kind === 'image';
  const isFile = message.kind === 'file';
  const isVoice = message.kind === 'voice';
  const isMerge = message.kind === 'merge';
  const isForward = message.kind === 'forward';
  const isText = !message.kind || message.kind === 'text';
  const hasMentions = isText && /@[^\s@]{1,24}/.test(String(message.body || ''));

  useEffect(() => {
    return () => {
      if (audioRef.current) audioRef.current.pause();
    };
  }, []);

  useEffect(() => {
    if (!reactOpen) return undefined;
    const close = () => setReactOpen(false);
    const timer = setTimeout(() => document.addEventListener('pointerdown', close, { once: true }), 80);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', close);
    };
  }, [reactOpen]);

  const toggleVoice = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
      setPlaying(false);
      return;
    }
    el.play().then(() => setPlaying(true)).catch((err) => toast(err.message || '无法播放这段语音', 'error'));
  };

  const quickReact = (emoji) => {
    onReact?.(message, emoji);
    setReactOpen(false);
  };

  const copyText = async () => {
    const text = message.meta?.name ? message.meta.name : message.body;
    try {
      await navigator.clipboard.writeText(String(text || ''));
      toast('已复制', 'success');
    } catch {
      toast('复制失败，请手动选中', 'error');
    }
  };

  const openMenu = (e) => {
    if (selectionMode) return;
    e.preventDefault();
    setMenu({ x: e.clientX || (e.touches && e.touches[0]?.clientX) || 0, y: e.clientY || (e.touches && e.touches[0]?.clientY) || 0 });
  };

  const jump = () => {
    if (message.reply?.id) onJumpTo?.(message.reply.id);
  };

  const menuItems = useMemo(() => {
    const items = [];
    items.push({ label: '回复', icon: 'reply', onClick: () => onReply?.(message) });
    items.push({ label: '转发', icon: 'forward', onClick: () => onForward?.(message) });
    items.push({ label: '多选', icon: 'check', onClick: () => onMultiSelect?.(message) });
    if (favorited) items.push({ label: '取消收藏', icon: 'bookmarkFilled', onClick: () => onToggleFavorite?.(message) });
    else items.push({ label: '收藏', icon: 'bookmark', onClick: () => onToggleFavorite?.(message) });
    if (isText || isFile) items.push({ label: '复制', icon: 'copy', onClick: copyText });
    if (canRecall) items.push({ label: '撤回', icon: 'history', onClick: () => onRecall?.(message) });
    if (canDelete) items.push({ divider: true }, { label: '删除', icon: 'trash', danger: true, onClick: () => onDelete?.(message) });
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message, favorited, canRecall, canDelete, isText, isFile]);

  const bodyText = String(message.body || '');
  const mentionParts = hasMentions ? splitMentions(bodyText) : null;

  return (
    <div
      id={'msg-' + message.id}
      className={
        'msg ' +
        (isMine ? 'msg-mine ' : 'msg-theirs ') +
        (compact ? 'msg-compact ' : '') +
        (selectionMode ? 'msg-selectable ' : '') +
        (selected ? 'msg-selected ' : '') +
        (message.jumped ? 'msg-jumped ' : '')
      }
      onContextMenu={openMenu}
    >
      {selectionMode ? (
        <button type="button" className={'msg-check' + (selected ? ' on' : '')} onClick={() => onToggleSelect?.(message)} aria-label="选择消息">
          {selected ? <Icon name="check" size={14} /> : null}
        </button>
      ) : null}

      {!isMine && !compact ? (
        <button type="button" className="msg-avatar" onClick={() => onOpenUser?.(sender?.number)}>
          <Avatar number={sender?.number} nickname={name} avatar={sender?.avatar} size={38} online={sender?.online} />
        </button>
      ) : !isMine ? <span className="msg-avatar-spacer" /> : null}

      <div className="msg-main">
        {!compact && showTime !== false ? (
          <div className="msg-head">
            {!isMine ? <span className="msg-name">{name}</span> : null}
            {group && !isMine && sender?.role ? <span className="msg-role">{sender.role === 'owner' ? '群主' : '管理员'}</span> : null}
            <time className="msg-time">{fmtClock(message.created_at)}</time>
          </div>
        ) : null}

        <div className="msg-row">
          <div className={'msg-bubble-wrap' + (isImage ? ' is-image' : '')}>
            {message.reply ? (
              <button type="button" className="msg-reply" onClick={jump}>
                <span className="msg-reply-name">{message.reply.nickname || message.reply.number}</span>
                <span className="msg-reply-text">{KIND_LABEL[message.reply.kind] || previewFor(message.reply)}</span>
              </button>
            ) : null}

            {message.recalled ? (
              <div className="msg-recalled">
                <Icon name="history" size={14} /> {isMine ? '你撤回了一条消息' : name + ' 撤回了一条消息'}
              </div>
            ) : (
              <div className={'msg-bubble kind-' + (message.kind || 'text')} ref={bubbleRef}>
                {isImage ? (
                  <button type="button" className="msg-image" onClick={() => onOpenImage?.(message)}>
                    <img src={mediaUrl(message.body)} alt={message.meta?.name || '图片'} loading="lazy" />
                  </button>
                ) : isFile ? (
                  <div className="msg-file">
                    <span className="msg-file-icon"><Icon name="file" size={22} /></span>
                    <span className="msg-file-info">
                      <b className="msg-file-name" title={message.meta?.name}>{message.meta?.name || '文件'}</b>
                      <span className="msg-file-size">{fmtSize(message.meta?.size)}</span>
                    </span>
                    <a className="msg-file-dl" href={mediaUrl(message.body)} download={message.meta?.name || 'file'} aria-label="下载文件">
                      <Icon name="download" size={17} />
                    </a>
                  </div>
                ) : isVoice ? (
                  <div className="msg-voice">
                    <button type="button" className="msg-voice-btn" onClick={toggleVoice} aria-label={playing ? '暂停语音' : '播放语音'}>
                      <Icon name={playing ? 'pause' : 'play'} size={17} filled />
                    </button>
                    <span className="msg-wave" aria-hidden>
                      {waveBars(message.id).map((h, i) => (
                        <i key={i} style={{ height: h + 'px', opacity: playing ? 0.4 + progress / 100 : 0.7 }} />
                      ))}
                    </span>
                    <span className="msg-voice-time">{playing ? fmtDuration((progress / 100) * (audioDur || message.meta?.duration || 0)) : fmtDuration(message.meta?.duration)}</span>
                    <audio
                      ref={audioRef}
                      src={mediaUrl(message.body)}
                      preload="metadata"
                      onLoadedMetadata={(e) => setAudioDur(e.currentTarget.duration || 0)}
                      onTimeUpdate={(e) => {
                        const d = e.currentTarget.duration || 0;
                        setProgress(d ? (e.currentTarget.currentTime / d) * 100 : 0);
                      }}
                      onEnded={() => { setPlaying(false); setProgress(0); }}
                      onPause={() => setPlaying(false)}
                      onPlay={() => setPlaying(true)}
                    />
                  </div>
                ) : isMerge ? (
                  <button type="button" className="msg-merge" onClick={() => onOpenMerge?.(message.meta)}>
                    <span className="msg-merge-head">
                      <span className="msg-merge-icon"><Icon name="merge" size={16} /></span>
                      <span className="msg-merge-title">{message.meta?.title || '聊天记录'}</span>
                      <span className="msg-merge-count">共 {message.meta?.count || message.meta?.items?.length || 0} 条</span>
                    </span>
                    <span className="msg-merge-lines">
                      {(message.meta?.items || []).slice(0, 3).map((it, i) => (
                        <span className="msg-merge-line" key={i}>
                          <b>{it.nickname || it.number || '聊天记录'}</b>
                          <span className="msg-merge-line-text">{previewFor(it)}</span>
                        </span>
                      ))}
                    </span>
                    <span className="msg-merge-foot">
                      <span>查看聊天记录</span>
                      <Icon name="chevron" size={15} />
                    </span>
                  </button>
                ) : isForward ? (
                  <button type="button" className="msg-forward-card" onClick={() => onOpenMerge?.({ title: '转发的消息', items: [{ nickname: message.meta?.from?.nickname, number: message.meta?.from?.number, kind: message.meta?.source?.kind, body: message.meta?.source?.body, created_at: message.meta?.source?.created_at }] })}>
                    <span className="msg-forward-head"><Icon name="forward" size={16} /> 转发自 {message.meta?.from?.nickname || message.meta?.from?.number}</span>
                    <span className="msg-forward-body">{KIND_LABEL[message.meta?.source?.kind] || message.meta?.source?.body}</span>
                  </button>
                ) : (
                  <span className="msg-text">
                    {mentionParts
                      ? mentionParts.map((part, i) => (part.mention ? <mark className="msg-mention" key={i}>{part.text}</mark> : <RichText key={i} text={part.text} />))
                      : <RichText text={bodyText} />}
                  </span>
                )}
              </div>
            )}

            {message.edited ? <span className="msg-edited">已编辑</span> : null}
            {!message.recalled && isFile ? null : null}

            {message.reactions && message.reactions.length > 0 ? (
              <div className="msg-reactions">
                {message.reactions.map((r) => (
                  <button
                    type="button"
                    key={r.emoji}
                    className={'reaction' + (r.mine ? ' on' : '')}
                    onClick={() => onReact?.(message, r.emoji)}
                    title={r.mine ? '取消回应' : '回应'}
                  >
                    <span className="reaction-emoji">{r.emoji}</span>
                    <span className="reaction-count">{r.count}</span>
                  </button>
                ))}
              </div>
            ) : null}

            {!message.recalled && !selectionMode ? (
              <div className="msg-tools">
                <button type="button" className="msg-tool" onClick={() => setReactOpen((v) => !v)} aria-label="表情回应" title="表情回应">
                  <Icon name="emoji" size={15} />
                </button>
                <button type="button" className="msg-tool" onClick={() => onReply?.(message)} aria-label="回复" title="回复">
                  <Icon name="reply" size={15} />
                </button>
                <button type="button" className="msg-tool" onClick={() => onForward?.(message)} aria-label="转发" title="转发">
                  <Icon name="forward" size={15} />
                </button>
                <button type="button" className={'msg-tool' + (favorited ? ' on' : '')} onClick={() => onToggleFavorite?.(message)} aria-label="收藏" title={favorited ? '取消收藏' : '收藏'}>
                  <Icon name={favorited ? 'bookmarkFilled' : 'bookmark'} size={15} />
                </button>
                <button type="button" className="msg-tool" onClick={(e) => setMenu({ x: e.clientX, y: e.clientY })} aria-label="更多" title="更多">
                  <Icon name="more" size={15} />
                </button>
              </div>
            ) : null}

            {reactOpen ? (
              <div className={'reaction-pop' + (isMine ? ' left' : '')} onPointerDown={(e) => e.stopPropagation()}>
                {QUICK_REACTIONS.map((emoji) => (
                  <button type="button" key={emoji} className="reaction-choice" onClick={() => quickReact(emoji)}>{emoji}</button>
                ))}
                <span className="reaction-sep" />
                {REACTION_CHOICES.filter((e) => !QUICK_REACTIONS.includes(e)).map((emoji) => (
                  <button type="button" key={emoji} className="reaction-choice" onClick={() => quickReact(emoji)}>{emoji}</button>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        {message.pending ? <span className="msg-pending">发送中…</span> : null}
        {message.failed ? (
          <button
            type="button"
            className="msg-failed"
            title={message.failReason || '点一下重新发送'}
            onClick={() => props.onRetry?.(message)}
          >
            发送失败，点这里重发
          </button>
        ) : null}
      </div>

      {menu ? (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={() => setMenu(null)} />
      ) : null}
    </div>
  );
}

function waveBars(seed) {
  const out = [];
  let h = Math.abs(Number(seed) || 1);
  for (let i = 0; i < 14; i += 1) {
    h = (h * 1103515245 + 12345) % 2147483648;
    out.push(6 + (h % 14));
  }
  return out;
}
