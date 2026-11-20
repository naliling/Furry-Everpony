import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Modal, OverlayDismissButton, Avatar, Empty, Spinner, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { QrCode, QrScanner } from '../../ui/qr.jsx';
import { fmtClock, fmtDate, relTime } from '../../lib/format.js';

/* ---------------- 加好友（搜号码 / 昵称 / 扫码，我的二维码） ---------------- */

/** 手机上用 http 打开页面时没有 navigator.clipboard，得退回老办法，否则复制按钮点了没反应 */
async function copyText(text) {
  const value = String(text || '');
  if (!value) return false;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* 继续走兜底 */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function AddFriendModal({ token, onClose, onChanged }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [done, setDone] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [me, setMe] = useState(null);

  useEffect(() => {
    let alive = true;
    api('/api/me', { token })
      .then((out) => { if (alive) setMe(out.account || out); })
      .catch(() => {});
    return () => { alive = false; };
  }, [token]);

  /* 边打边找：停手 260ms 才发请求，省得每个字母都打一次后端 */
  useEffect(() => {
    const kw = q.trim();
    if (!kw) { setResults([]); setSearched(false); setSearching(false); return; }
    let alive = true;
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const out = await api('/api/search/users?q=' + encodeURIComponent(kw) + '&limit=20', { token });
        if (alive) { setResults(out.users || []); setErr(''); setSearched(true); }
      } catch (e) {
        if (alive) { setErr(e.message); setResults([]); }
      } finally {
        if (alive) setSearching(false);
      }
    }, 260);
    return () => { alive = false; clearTimeout(timer); };
  }, [q, token]);

  const myNumber = me?.number || '';

  const copy = async (text, label) => {
    const ok = await copyText(text);
    if (ok) toast(label + '已复制', 'success');
    else toast('复制失败，长按选中那串文字手动复制', 'error');
  };

  const addByNumber = async (number, name) => {
    const n = String(number || '').trim();
    if (!n || busy) return;
    setBusy(n);
    setErr('');
    try {
      await api('/api/friends/request', { method: 'POST', token, body: { number: n, message: message.trim() } });
      onChanged?.();
      setDone({ name: name || n, number: n, text: '好友申请已发出，等对方同意' });
    } catch (e) {
      if (/已经是好友|重复|申请过/.test(e.message)) {
        onChanged?.();
        setDone({ name: name || n, number: n, text: '你们已经是好友了' });
      } else {
        setErr(e.message);
      }
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal title="加好友" icon="friend" onClose={onClose} width={560}>
      <label className="field">
        <span className="field-label">
          找人
          <button type="button" className="af-scan-btn" onClick={() => setScanning(true)}>
            <Icon name="qr" size={14} /> 扫一扫
          </button>
        </span>
        <div className="input-wrap">
          <Icon name="search" size={17} className="input-icon" />
          <input
            className="input"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={q}
            onChange={(e) => { setQ(e.target.value); setErr(''); setDone(null); }}
            placeholder="号码、昵称、别名都行"
          />
        </div>
        <span className="field-hint">输入几个字就边打边找，点结果右边的「加」发出申请；对方把号码直接告诉你也行。</span>
      </label>

      {searching ? <div className="af-searching"><Spinner size={16} /> 正在找…</div> : null}

      {!searching && results.length ? (
        <div className="af-results">
          {results.map((u) => (
            <div className="af-result" key={u.id}>
              <Avatar number={u.number} nickname={u.nickname} avatar={u.avatar} size={38} />
              <div className="af-result-main">
                <b>{u.nickname || u.number}</b>
                <span>
                  {u.number}
                  {u.type === 'bot' ? ' · Bot' : ''}
                  {u.bio ? ' · ' + u.bio : ''}
                </span>
              </div>
              {u.isFriend ? (
                <span className="af-result-tag">已是好友</span>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => addByNumber(u.number, u.nickname)}>
                  {busy === u.number ? <Spinner size={14} /> : <Icon name="plus" size={14} />} 加
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {!searching && searched && !results.length ? (
        <Empty compact icon="search" title={'没找到「' + q.trim() + '」'} sub="换个号码或名字试试，号码一定要对得上。" />
      ) : null}

      <label className="field">
        <span className="field-label">验证消息（可选）</span>
        <input className="input" maxLength={120} placeholder="让对方知道你是谁" value={message} onChange={(e) => setMessage(e.target.value)} />
      </label>

      {err ? <div className="auth-error">{err}</div> : null}

      {done ? (
        <div className="af-done">
          <Icon name="check" size={18} />
          <div>
            <b>{done.text}</b>
            <span>{done.name} · {done.number}</span>
          </div>
        </div>
      ) : null}

      <div className="af-mine">
        <div className="af-qr">
          {myNumber ? <QrCode text={myNumber} size={132} /> : <div className="af-qr-ph"><Spinner size={18} /></div>}
          <div className="af-qr-main">
            <b>我的二维码</b>
            <span>里面就是我的号码 {myNumber || ''}，永久不变。让对方扫这张，或者直接把号码报给他。</span>
          </div>
        </div>
        {myNumber ? (
          <div className="af-mine-row">
            <div>
              <b>我的号码</b>
              <span>{myNumber}（换设备、换浏览器都是这个号，Bot 认的就是它）</span>
            </div>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(myNumber, '号码')}>
              <Icon name="copy" size={14} /> 复制
            </button>
          </div>
        ) : null}
      </div>

      <div className="modal-foot">
        <OverlayDismissButton className="btn btn-ghost">{done ? '关闭' : '取消'}</OverlayDismissButton>
      </div>

      {scanning ? (
        <QrScanner
          title="扫一扫加好友"
          onClose={() => setScanning(false)}
          onResult={(text) => {
            setScanning(false);
            const num = (String(text || '').match(/\d{5,12}/) || [])[0];
            if (!num) { setErr('这张码里没有号码，让对方在「加好友」里显示自己的二维码'); return; }
            setQ(num);
            addByNumber(num, '');
          }}
        />
      ) : null}
    </Modal>
  );
}

/* ---------------- 建群 ---------------- */
export function CreateGroupModal({ token, onClose, onCreated }) {
  const [number, setNumber] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{5,12}$/.test(number) && name.trim().length > 0;

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const data = await api('/api/groups', { method: 'POST', token, body: { number, name: name.trim() } });
      toast('群已创建', 'success');
      onCreated?.(data);
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="创建群聊" icon="group" onClose={onClose} width={420}>
      <label className="field">
        <span className="field-label">群名</span>
        <input className="input" maxLength={24} placeholder="给这个群起个名字" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">群号</span>
        <div className="input-wrap">
          <Icon name="hash" size={16} className="input-lead" />
          <input
            className="input input-number"
            inputMode="numeric"
            placeholder="自己定一个 5–12 位群号"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        <span className="field-hint">群号在本实例内唯一，好友可以靠它找到群。</span>
      </label>
      <div className="modal-foot">
        <OverlayDismissButton className="btn btn-ghost">取消</OverlayDismissButton>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <Spinner size={15} /> : <Icon name="group" size={16} />} 创建
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 加群 ---------------- */
export function JoinGroupModal({ token, onClose, onJoined }) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{5,12}$/.test(number);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api('/api/groups/' + number + '/join', { method: 'POST', token });
      toast('已加入群聊', 'success');
      onJoined?.(number);
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="加入群聊" icon="group" onClose={onClose} width={420}>
      <label className="field">
        <span className="field-label">群号</span>
        <div className="input-wrap">
          <Icon name="hash" size={16} className="input-lead" />
          <input
            className="input input-number"
            inputMode="numeric"
            autoFocus
            placeholder="输入群号"
            value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
            onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          />
        </div>
        <span className="field-hint">如果群主开了邀请制，可以让群内成员邀请你。</span>
      </label>
      <div className="modal-foot">
        <OverlayDismissButton className="btn btn-ghost">取消</OverlayDismissButton>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <Spinner size={15} /> : <Icon name="plus" size={16} />} 加入
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 转发选择器 ---------------- */
export function ForwardPicker({ token, onClose, onPick, excludeId, title }) {
  const [convs, setConvs] = useState(null);
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    api('/api/conversations', { token })
      .then((data) => setConvs(data.conversations || []))
      .catch((err) => { toast(err.message, 'error'); setConvs([]); });
  }, [token]);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return (convs || []).filter((c) => {
      if (c.id === excludeId) return false;
      if (!kw) return true;
      const name = c.kind === 'group' ? c.group?.name : c.peer?.nickname || c.peer?.number;
      return String(name || '').toLowerCase().includes(kw);
    });
  }, [convs, excludeId, q]);

  const pick = async (conv) => {
    if (busyId) return;
    setBusyId(conv.id);
    try {
      await onPick(conv);
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal title={title || '转发到'} icon="forward" onClose={onClose} width={440}>
      <div className="input-wrap picker-search">
        <Icon name="search" size={16} className="input-lead" />
        <input className="input" placeholder="搜索会话" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </div>
      <div className="picker-list">
        {convs === null ? (
          <div className="dialog-loading"><Spinner size={18} /> 正在加载会话</div>
        ) : list.length === 0 ? (
          <Empty icon="forward" title="没有可转发的会话" compact />
        ) : (
          list.map((c) => {
            const name = c.kind === 'group' ? c.group?.name : c.peer?.nickname || '会话';
            return (
              <button type="button" key={c.id} className="picker-item" onClick={() => pick(c)} disabled={!!busyId}>
                <Avatar number={c.kind === 'group' ? c.group?.number : c.peer?.number} nickname={name} avatar={c.peer?.avatar} size={36} square={c.kind === 'group'} />
                <span className="picker-name">{name}</span>
                {busyId === c.id ? <Spinner size={15} /> : <Icon name="chevron" size={16} />}
              </button>
            );
          })
        )}
      </div>
    </Modal>
  );
}

/* ---------------- 合并转发记录查看 ---------------- */
/* items 来自服务端 meta，只有 {number,nickname,kind,body,created_at}，没有头像字段，用号码生成 */
export function MergeViewer({ meta, onClose, token, onForward }) {
  const items = meta?.items || [];
  const [forwardItem, setForwardItem] = useState(null);
  const canForward = !!token && typeof onForward === 'function';
  return (
    <Modal title={meta?.title || '聊天记录'} icon="merge" onClose={onClose} width={520}>
      <div className="merge-view">
        <div className="merge-view-head">
          <Icon name="merge" size={18} />
          <span>{meta?.title || '聊天记录'}</span>
          <span className="merge-view-count">{items.length} 条</span>
        </div>
        <div className="merge-view-body">
          {items.length === 0 ? <Empty icon="fileText" title="没有记录" compact /> : items.map((it, i) => (
            <div className="merge-item" key={i}>
              <Avatar number={it.number} nickname={it.nickname} size={30} />
              <div className="merge-item-main">
                <div className="merge-item-meta">
                  <b>{it.nickname || it.number || '聊天记录'}</b>
                  <span>{it.created_at ? fmtClock(it.created_at) : ''}</span>
                </div>
                <div className="merge-item-body">
                  {it.kind === 'image' ? '[图片]' : it.kind === 'file' ? '[文件] ' + (it.body || '') : it.kind === 'voice' ? '[语音]' : it.body}
                </div>
              </div>
              {canForward ? (
                <button
                  type="button"
                  className="merge-item-forward"
                  title="逐条转发到其他会话"
                  aria-label="逐条转发到其他会话"
                  onClick={() => setForwardItem(it)}
                >
                  <Icon name="forward" size={14} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
        {canForward ? <p className="merge-view-tip"><Icon name="info" size={13} /> 点每条右侧的转发按钮，就能把它单独转发到别的会话。</p> : null}
      </div>
      {forwardItem ? (
        <ForwardPicker
          token={token}
          title="逐条转发到"
          onClose={() => setForwardItem(null)}
          onPick={async (conv) => {
            await onForward(conv, forwardItem);
            setForwardItem(null);
          }}
        />
      ) : null}
    </Modal>
  );
}

/* ---------------- 群公告 ---------------- */
export function AnnouncementModal({ token, group, canEdit, onClose, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(group?.announcement || '');
  const [saving, setSaving] = useState(false);
  const announcement = group?.announcement || '';

  useEffect(() => {
    if (!token || !group?.number) return;
    api('/api/groups/' + group.number + '/announcement/read', { method: 'POST', token }).catch(() => {});
  }, [token, group?.number]);

  const save = async () => {
    setSaving(true);
    try {
      await api('/api/groups/' + group.number, { method: 'PATCH', token, body: { announcement: draft.trim() } });
      toast('公告已更新', 'success');
      setEditing(false);
      onChanged?.();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="群公告" icon="bell" onClose={onClose} width={460}
      headerExtra={canEdit && !editing ? <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setDraft(announcement); setEditing(true); }}><Icon name="edit" size={14} /> 编辑</button> : null}>
      {editing ? (
        <>
          <textarea className="textarea" rows={7} maxLength={500} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="写点公告，群成员会看到未读提醒。" />
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={save} disabled={saving}>
              {saving ? <Spinner size={15} /> : <Icon name="check" size={16} />} 保存公告
            </button>
          </div>
        </>
      ) : announcement ? (
        <div className="announce-view">
          <p className="announce-text">{announcement}</p>
          <div className="announce-time">
            <Icon name="clock" size={14} /> {group?.announcement_updated_at ? '更新于 ' + relTime(group.announcement_updated_at) : '暂无更新时间'}
          </div>
        </div>
      ) : (
        <Empty icon="bell" title="还没有群公告" sub={canEdit ? '点右上角编辑写一条' : '等待群主或管理员发布'} compact />
      )}
    </Modal>
  );
}

/* ---------------- 邀请入群 ---------------- */
export function GroupInviteModal({ token, group, onClose, onChanged }) {
  const [number, setNumber] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{5,12}$/.test(number);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api('/api/groups/' + group.number + '/invite', { method: 'POST', token, body: { number } });
      toast('邀请已发出', 'success');
      onChanged?.();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="邀请加入群聊" icon="users" onClose={onClose} width={420}>
      <p className="modal-hint">把对方的号码填进来，邀请会出现在对方的通知里。</p>
      <label className="field">
        <span className="field-label">对方号码</span>
        <div className="input-wrap">
          <Icon name="hash" size={16} className="input-lead" />
          <input className="input input-number" inputMode="numeric" autoFocus placeholder="5–12 位数字" value={number}
            onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </div>
      </label>
      <div className="modal-foot">
        <OverlayDismissButton className="btn btn-ghost">取消</OverlayDismissButton>
        <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
          {busy ? <Spinner size={15} /> : <Icon name="send" size={16} />} 发送邀请
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- 消息搜索 ---------------- */
export function SearchModal({ token, conversations, onClose, onOpen, activeConversationId }) {
  const [q, setQ] = useState('');
  const [scope, setScope] = useState(activeConversationId ? 'conv' : 'all');
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef(null);

  const convName = (id) => {
    const c = (conversations || []).find((x) => x.id === id);
    if (!c) return '会话 ' + id;
    return c.kind === 'group' ? c.group?.name || '群聊' : c.peer?.nickname || c.peer?.number || '会话';
  };

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const kw = q.trim();
    if (!kw) {
      setResults(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    timer.current = setTimeout(async () => {
      try {
        const query = '/api/messages/search?q=' + encodeURIComponent(kw) + (scope === 'conv' && activeConversationId ? '&conversationId=' + activeConversationId : '');
        const data = await api(query, { token });
        setResults(data.messages || []);
      } catch (err) {
        toast(err.message, 'error');
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 320);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, scope, activeConversationId, token]);

  return (
    <Modal title="搜索消息" icon="search" onClose={onClose} width={520}>
      <div className="input-wrap picker-search">
        <Icon name="search" size={16} className="input-lead" />
        <input className="input" autoFocus placeholder="搜索聊天记录" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {activeConversationId ? (
        <div className="segmented segmented-sm search-scope">
          <button type="button" className={scope === 'all' ? 'on' : ''} onClick={() => setScope('all')}>全部会话</button>
          <button type="button" className={scope === 'conv' ? 'on' : ''} onClick={() => setScope('conv')}>当前会话</button>
        </div>
      ) : null}
      <div className="picker-list">
        {loading ? (
          <div className="dialog-loading"><Spinner size={18} /> 正在搜索</div>
        ) : results === null ? (
          <div className="dialog-hint"><Icon name="search" size={26} /><span>输入关键词开始搜索</span></div>
        ) : results.length === 0 ? (
          <Empty icon="search" title="没有找到相关消息" compact />
        ) : (
          results.map((m) => (
            <button type="button" key={m.id} className="search-result" onClick={() => { onOpen?.(m.conversation_id, m.id); onClose(); }}>
              <div className="search-result-head">
                <span className="search-result-conv">{scope === 'conv' ? '当前会话' : convName(m.conversation_id)}</span>
                <span className="search-result-time">{fmtDate(m.created_at)} {fmtClock(m.created_at)}</span>
              </div>
              <div className="search-result-body">{highlight(m.body, q.trim())}</div>
              <div className="search-result-sender">{m.sender_nickname}（{m.sender_number}）</div>
            </button>
          ))
        )}
      </div>
      <div className="modal-hint modal-foot-hint"><Icon name="keyboard" size={14} /> 搜索最多返回 50 条，Ctrl+F 随时打开</div>
    </Modal>
  );
}

function highlight(text, kw) {
  const raw = String(text || '');
  if (!kw) return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  const idx = raw.toLowerCase().indexOf(kw.toLowerCase());
  if (idx < 0) return raw.length > 120 ? raw.slice(0, 120) + '…' : raw;
  const start = Math.max(0, idx - 40);
  const end = Math.min(raw.length, idx + kw.length + 80);
  return (
    <>
      {start > 0 ? '…' : ''}
      {raw.slice(start, idx)}
      <mark>{raw.slice(idx, idx + kw.length)}</mark>
      {raw.slice(idx + kw.length, end)}
      {end < raw.length ? '…' : ''}
    </>
  );
}
