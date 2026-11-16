import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { toast, Avatar, useIsMobile } from '../../ui/primitives.jsx';
import {
  uploadFile,
  getDraft,
  setDraft,
  storageGet,
  storageSet,
  SEND_MODE_KEY,
} from '../../lib/api.js';

export default function Composer({ token, conversationId, isGroup, group, members, me, reply, onCancelReply, onSend, onTyping, disabledReason }) {
  const [text, setText] = useState('');
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [replyBox, setReplyBox] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendMode, setSendMode] = useState(() => storageGet(SEND_MODE_KEY, 'enter'));
  const textRef = useRef(null);
  const imageRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const recordTimer = useRef(null);
  const recordSecRef = useRef(0);
  const typeTimer = useRef(null);

  const isMobile = useIsMobile();

  useEffect(() => {
    setText(getDraft(conversationId) || '');
    setMentionOpen(false);
    setReplyBox(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    if (!conversationId) return;
    setDraft(conversationId, text);
  }, [text, conversationId]);

  useEffect(() => {
    setSendMode(storageGet(SEND_MODE_KEY, 'enter'));
  }, []);

  useEffect(() => {
    if (reply) {
      setReplyBox(true);
      textRef.current?.focus();
    } else {
      setReplyBox(false);
    }
  }, [reply]);

  const mentionables = useMemo(() => {
    if (!isGroup) return [];
    const kw = mentionQuery.trim().toLowerCase();
    const list = (members || []).filter((m) => m.number !== me?.number);
    return list
      .filter((m) => !kw || String(m.nickname || '').toLowerCase().includes(kw) || String(m.number).includes(kw))
      .slice(0, 8);
  }, [members, mentionQuery, isGroup, me?.number]);

  const myRole = group?.role || group?.my_role;
  const canMentionAll = isGroup && (myRole === 'owner' || myRole === 'admin');
  const mentionAllOption = mentionQuery.trim() === '' || '全体成员'.includes(mentionQuery.trim());

  const insertAtCaret = (insert, replaceLen = 0) => {
    const el = textRef.current;
    const start = el ? el.selectionStart : text.length;
    const end = el ? el.selectionEnd : text.length;
    const before = text.slice(0, replaceLen ? start - replaceLen : start);
    const after = text.slice(end);
    const next = before + insert + after;
    setText(next.slice(0, 4000));
    requestAnimationFrame(() => {
      if (!el) return;
      const pos = (before + insert).length;
      el.focus();
      el.setSelectionRange(pos, pos);
    });
  };

  const onChangeText = (e) => {
    const value = e.target.value;
    setText(value.slice(0, 4000));
    if (typeTimer.current) clearTimeout(typeTimer.current);
    typeTimer.current = setTimeout(() => {
      if (value.trim()) onTyping?.();
    }, 900);
    const caret = e.target.selectionStart;
    const before = value.slice(0, caret);
    const m = /@([^\s@]{0,24})$/.exec(before);
    if (isGroup && m) {
      setMentionOpen(true);
      setMentionQuery(m[1]);
      setMentionIndex(0);
    } else if (!m) {
      setMentionOpen(false);
    }
    const ta = e.target;
    requestAnimationFrame(() => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
    });
  };

  const pickMention = (member) => {
    const el = textRef.current;
    const caret = el ? el.selectionStart : text.length;
    const before = text.slice(0, caret);
    const m = /@([^\s@]{0,24})$/.exec(before);
    const start = m ? caret - m[0].length : caret;
    const name = member ? (member.nickname || member.number) : '全体成员';
    const next = text.slice(0, start) + '@' + name + ' ' + text.slice(caret);
    setText(next.slice(0, 4000));
    setMentionOpen(false);
    requestAnimationFrame(() => {
      const pos = start + name.length + 2;
      textRef.current?.focus();
      textRef.current?.setSelectionRange(pos, pos);
    });
  };

  const sendText = async () => {
    const value = text.trim();
    if (!value || sending) return;
    if (disabledReason) return;
    setSending(true);
    try {
      const mentionAll = /@全体成员(\s|$)/.test(value);
      await onSend({ body: value, kind: 'text', mentionAll, ...(reply?.id ? { replyTo: reply.id } : {}) });
      setText('');
      setDraft(conversationId, '');
      onCancelReply?.();
      requestAnimationFrame(() => {
        if (textRef.current) textRef.current.style.height = 'auto';
      });
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e) => {
    if (mentionOpen && mentionables.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionables.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionables.length) % mentionables.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(mentionables[mentionIndex]); return; }
      if (e.key === 'Escape') { setMentionOpen(false); return; }
    }
    if (e.key !== 'Enter') return;
    const mode = storageGet(SEND_MODE_KEY, 'enter');
    const withMod = e.ctrlKey || e.metaKey;
    const wantSend = mode === 'enter' ? !withMod && !e.shiftKey : withMod;
    if (wantSend) {
      e.preventDefault();
      sendText();
    }
  };

  const sendImage = async (file) => {
    if (!file || sending || disabledReason) return;
    if (!file.type.startsWith('image/')) { toast('只能发送图片', 'error'); return; }
    setSending(true);
    try {
      const up = await uploadFile(file, token);
      await onSend({ body: up.url, kind: 'image', meta: { name: up.name, size: up.size }, ...(reply?.id ? { replyTo: reply.id } : {}) });
      onCancelReply?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSending(false);
    }
  };

  const handlePaste = (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const img = items.find((it) => it.type.startsWith('image/'));
    if (img) {
      e.preventDefault();
      const file = img.getAsFile();
      if (file) sendImage(file);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    /* 站里不传文件，只认图片 */
    if (file.type.startsWith('image/')) sendImage(file);
    else toast('这里只收图片，不传其他文件', 'error');
  };

  const startRecord = async () => {
    if (disabledReason) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      chunksRef.current = [];
      rec.ondataavailable = (ev) => { if (ev.data.size) chunksRef.current.push(ev.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (recordTimer.current) clearInterval(recordTimer.current);
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' });
        const sec = recordSec;
        setRecording(false);
        setRecordSec(0);
        if (sec < 1 || blob.size < 800) { toast('录得太短了', 'error'); return; }
        setSending(true);
        try {
          const file = new File([blob], 'voice.webm', { type: blob.type || 'audio/webm' });
          const up = await uploadFile(file, token);
          await onSend({ body: up.url, kind: 'voice', meta: { name: up.name, size: up.size, duration: sec }, ...(reply?.id ? { replyTo: reply.id } : {}) });
          onCancelReply?.();
        } catch (err) {
          toast(err.message, 'error');
        } finally {
          setSending(false);
        }
      };
      rec.start();
      recorderRef.current = rec;
      setRecording(true);
      setRecordSec(0);
      recordSecRef.current = 0;
      recordTimer.current = setInterval(() => {
        setRecordSec((s) => {
          recordSecRef.current = s + 1;
          return s + 1;
        });
      }, 1000);
    } catch {
      toast('拿不到麦克风权限', 'error');
    }
  };

  const cancelRecord = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') {
      chunksRef.current = [];
      rec.onstop = () => {
        if (recordTimer.current) clearInterval(recordTimer.current);
        setRecording(false);
        setRecordSec(0);
        recordSecRef.current = 0;
      };
      rec.stop();
      rec.stream.getTracks().forEach((t) => t.stop());
    }
  };

  const stopRecord = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== 'inactive') rec.stop();
  };

  const mentionLeft = 4000 - text.length;

  return (
    <div
      className={'composer' + (dragging ? ' dragging' : '') + (disabledReason ? ' disabled' : '')}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      {dragging ? <div className="composer-drop"><Icon name="image" size={24} /> 松手发送图片</div> : null}

      {disabledReason ? (
        <div className="composer-blocked"><Icon name="mute" size={15} /> {disabledReason}</div>
      ) : null}

      {reply && replyBox ? (
        <div className="composer-reply">
          <span className="composer-reply-icon"><Icon name="reply" size={15} /></span>
          <div className="composer-reply-body">
            <b>{reply.sender?.nickname || reply.sender?.number || (reply.mine ? '你' : '对方')}</b>
            <span>{reply.body || reply.meta?.name || '消息'}</span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancelReply} aria-label="取消引用"><Icon name="close" size={15} /></button>
        </div>
      ) : null}

      <div className={'composer-dock' + (recording ? ' composer-dock-rec' : '')}>
      {!recording ? (
        <div className="composer-input">
          <textarea
            ref={textRef}
            className="composer-text"
            rows={1}
            maxLength={4000}
            placeholder={disabledReason ? '当前无法发言' : '说点什么…（Enter 发送，Shift+Enter 换行）'}
            value={text}
            disabled={!!disabledReason}
            onChange={onChangeText}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            onFocus={() => onTyping?.()}
          />

          {mentionOpen && isGroup ? (
            <div className="mention-panel">
              <div className="mention-head">选择要提醒的人</div>
              {canMentionAll && mentionAllOption ? (
                <button type="button" className="mention-item mention-all" onClick={() => pickMention(null)}>
                  <span className="mention-avatar"><Icon name="bell" size={16} /></span>
                  <span className="mention-name">全体成员</span>
                  <span className="mention-sub">所有人都会收到提醒</span>
                </button>
              ) : null}
              {mentionables.length === 0 && (!canMentionAll || !mentionAllOption) ? (
                <div className="mention-empty">没有匹配的成员</div>
              ) : null}
              {mentionables.map((m, i) => (
                <button type="button" key={m.number} className={'mention-item' + (i === mentionIndex ? ' on' : '')} onClick={() => pickMention(m)}>
                  <Avatar number={m.number} nickname={m.nickname} avatar={m.avatar} size={26} status={m.status} />
                  <span className="mention-name">{m.nickname}</span>
                  <span className="mention-sub">{m.number}</span>
                </button>
              ))}
            </div>
          ) : null}

          <button type="button" className="composer-send" onClick={sendText} disabled={!text.trim() || sending || !!disabledReason} title="发送" aria-label="发送">
            {sending ? <span className="spinner spinner-sm" /> : <Icon name="send" size={18} />}
          </button>
        </div>
      ) : (
        <div className="composer-recording">
          <span className="rec-dot" />
          <span className="rec-time">{fmtDuration(recordSec)}</span>
          <span className="rec-wave">{Array.from({ length: 20 }).map((_, i) => <i key={i} style={{ height: 6 + ((i * 7 + recordSec * 3) % 18) + 'px' }} />)}</span>
          <span className="rec-hint">正在录音</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={cancelRecord}><Icon name="close" size={14} /> 取消</button>
          <button type="button" className="btn btn-sm btn-primary" onClick={stopRecord}><Icon name="send" size={14} /> 发送</button>
        </div>
      )}

      <div className="composer-bar">
        <div className="composer-tools">
          <button type="button" className="icon-btn" onClick={() => imageRef.current?.click()} title="发送图片" aria-label="发送图片">
            <Icon name="image" size={19} />
          </button>
          <button type="button" className={'icon-btn' + (recording ? ' on' : '')} onClick={() => (recording ? stopRecord() : startRecord())} title="语音" aria-label="语音">
            <Icon name="mic" size={19} />
          </button>
          {isGroup ? (
            <button type="button" className="icon-btn" onClick={() => { setMentionOpen(true); textRef.current?.focus(); }} title="提醒某人" aria-label="提醒某人">
              <Icon name="at" size={19} />
            </button>
          ) : null}
          <input ref={imageRef} type="file" accept="image/*" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) sendImage(f); }} />
        </div>

        <div className="composer-actions">
          <span className={'composer-count' + (mentionLeft < 200 ? ' low' : '')}>{mentionLeft < 500 ? mentionLeft : ''}</span>
          <span className="composer-hint">Enter 发送 · Shift+Enter 换行</span>
        </div>
      </div>
      </div>

    </div>
  );
}

function fmtDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
