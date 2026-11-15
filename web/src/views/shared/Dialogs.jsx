import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Modal, Avatar, Empty, Spinner, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { fmtClock, fmtDate, relTime } from '../../lib/format.js';

/* ---------------- 加好友（一个输入框：邀请码 / 地址+号码 / 号码） ---------------- */

const FED_PREFIX = 'FEINV1.';

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

/** 把粘进来的一段话拆成「邀请码」「地址 + 号码」「号码」三种之一 */
function parseTarget(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const compact = text.replace(/\s+/g, '');
  if (compact.toUpperCase().startsWith(FED_PREFIX)) return { kind: 'invite', code: compact };
  const tokens = text.split(/[\s,，;；|]+/).filter(Boolean);
  let addr = '';
  let number = '';
  for (const tk of tokens) {
    if (/^[1-9]\d{4,11}$/.test(tk)) number = tk;
    else if (/^(https?:\/\/)?([A-Za-z0-9.\-]+|\[[0-9a-fA-F:]+\])(:\d{1,5})?\/?$/.test(tk)) addr = tk;
  }
  if (!number) return null;
  return addr ? { kind: 'remote', addr, number } : { kind: 'local', number };
}

export function AddFriendModal({ token, onClose, onChanged }) {
  const [input, setInput] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [found, setFound] = useState(null);
  const [done, setDone] = useState(null);
  const [info, setInfo] = useState(null);
  const [nearby, setNearby] = useState([]);
  const [invite, setInvite] = useState(null);
  const [inviteErr, setInviteErr] = useState('');

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [i2, n] = await Promise.all([
        api('/api/federation/info', { token }).catch(() => null),
        api('/api/federation/nearby', { token }).catch(() => ({ instances: [] })),
      ]);
      if (!alive) return;
      setInfo(i2);
      setNearby(((n && n.instances) || []).filter((x) => x.instanceId !== i2?.instanceId && x.addr));
    };
    load();
    api('/api/federation/invite', { token })
      .then((out) => { if (alive) { setInvite(out); setInviteErr(''); } })
      .catch((e) => { if (alive) { setInvite(null); setInviteErr(e.message); } });
    const timer = setInterval(load, 6000);
    return () => { alive = false; clearInterval(timer); };
  }, [token]);

  const myAddr = info?.publicAddr || info?.myAddresses?.[0] || info?.lanUrls?.[0] || '';
  const target = parseTarget(input);

  const addNearby = async (inst, person) => {
    if (busy) return;
    setBusy(true);
    setErr('');
    setDone(null);
    try {
      const out = await api('/api/federation/request', {
        method: 'POST',
        token,
        body: { addr: inst.addr, number: person.number, message: message.trim() || '在同一个 Wi-Fi 下发现你' },
      });
      onChanged?.();
      setDone({
        name: person.nickname || person.number,
        number: person.number,
        text: out.friend ? '已加为好友，现在就能聊天了' : '好友申请已发出，等对方同意',
      });
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text, label) => {
    const ok = await copyText(text);
    if (ok) toast(label + '已复制', 'success');
    else toast('复制失败，长按选中那串文字手动复制', 'error');
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { setInput(text.trim()); setDone(null); setErr(''); return; }
    } catch {
      /* http 页面读不了剪贴板 */
    }
    toast('长按输入框粘贴，或者手动输入', 'info');
  };

  const submit = async () => {
    if (!target || busy) return;
    setBusy(true);
    setErr('');
    setFound(null);
    setDone(null);
    try {
      if (target.kind === 'invite') {
        const data = await api('/api/federation/invite/accept', { method: 'POST', token, body: { code: target.code } });
        const acc = data.account || {};
        onChanged?.();
        if (data.friend) {
          setDone({ name: acc.nickname || acc.number, number: acc.number, text: '已加为好友，现在就能聊天了' });
        } else if (data.requested) {
          setDone({ name: acc.nickname || acc.number, number: acc.number, text: '已向对方发出好友申请，同意后就能聊天' });
        } else {
          setFound({ ...data, addr: data.addr });
          setErr(data.requestError || '找到对方了，但好友申请没发出去，再点一次「发送好友申请」');
        }
        return;
      }

      if (target.kind === 'remote') {
        const data = await api('/api/federation/lookup', { method: 'POST', token, body: { addr: target.addr, number: target.number } });
        const acc = data.account || {};
        setFound({ ...data, addr: target.addr });
        if (data.isFriend) { setDone({ name: acc.nickname || acc.number, number: acc.number, text: '你们已经是好友了' }); return; }
        if (data.hasPending) { setDone({ name: acc.nickname || acc.number, number: acc.number, text: '之前已经申请过了，等对方同意' }); return; }
        await api('/api/federation/request', { method: 'POST', token, body: { addr: target.addr, number: target.number, message: message.trim() } });
        onChanged?.();
        setDone({ name: acc.nickname || acc.number, number: acc.number, text: '已发出好友申请，对方在 ' + target.addr + ' 上' });
        return;
      }

      /* 只填了号码：先当本机号码加；本机没有就去同一个 Wi-Fi 下发现的实例里找 */
      try {
        await api('/api/friends/request', { method: 'POST', token, body: { number: target.number, message: message.trim() } });
        onChanged?.();
        setDone({ name: target.number, number: target.number, text: '好友申请已发出，等对方同意' });
        return;
      } catch (e) {
        if (!/没有这个号码/.test(e.message) || !nearby.length) throw e;
        let hit = null;
        for (const item of nearby) {
          try {
            const out = await api('/api/federation/lookup', { method: 'POST', token, body: { addr: item.addr, number: target.number } });
            if (out.account) { hit = { addr: item.addr, out }; break; }
          } catch {
            /* 这个实例没有就试下一个 */
          }
        }
        if (!hit) throw e;
        const acc = hit.out.account || {};
        setFound({ ...hit.out, addr: hit.addr });
        await api('/api/federation/request', { method: 'POST', token, body: { addr: hit.addr, number: target.number, message: message.trim() } });
        onChanged?.();
        setDone({ name: acc.nickname || acc.number, number: acc.number, text: '在同一个 Wi-Fi 的 ' + hit.addr + ' 上找到对方，好友申请已发出' });
      }
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="加好友" icon="friend" onClose={onClose} width={520}>
      <div className="af-mine">
        <div className="af-mine-row">
          <div>
            <b>我的实例地址</b>
            <span>{myAddr || '还没探测到，可以在「设置 → 实例互联」里手动填公网地址'}</span>
          </div>
          {myAddr ? <button type="button" className="btn btn-ghost btn-sm" onClick={() => copy(myAddr, '地址')}><Icon name="copy" size={14} /> 复制</button> : null}
        </div>
        <div className="af-mine-row">
          <div>
            <b>我的邀请码</b>
            <span>{invite?.code ? '复制发给对方（短信、聊天软件都行），对方粘进去一步就能加你' : inviteErr || '正在生成…'}</span>
          </div>
          {invite?.code ? <button type="button" className="btn btn-primary btn-sm" onClick={() => copy(invite.code, '邀请码')}><Icon name="copy" size={14} /> 复制</button> : null}
        </div>
        {invite?.code ? <textarea className="af-invite-code" readOnly rows={2} value={invite.code} onFocus={(e) => e.target.select()} /> : null}
        <div className={'af-auto ' + (info?.autoAccept ? 'on' : '')}>
          <Icon name={info?.autoAccept ? 'check' : 'info'} size={14} />
          <span>{info?.autoAccept ? '已开启自动通过：拿我的邀请码/二维码加我的人直接成为好友，不用我点同意' : '自动通过已关闭：别人加我要我在「新朋友」里点同意'}</span>
        </div>
      </div>

      <label className="field">
        <span className="field-label">对方的邀请码 / 地址 + 号码 / 号码</span>
        <textarea
          className="textarea af-input"
          rows={2}
          value={input}
          onChange={(e) => { setInput(e.target.value); setErr(''); setDone(null); setFound(null); }}
          placeholder={'三种都行：\nFEINV1.xxx 邀请码\n192.168.1.8:7788 700123\n700123（同一个实例）'}
        />
        <span className="field-hint">
          {target?.kind === 'invite' ? '识别为邀请码，一步就能加'
            : target?.kind === 'remote' ? '识别为跨实例：地址 ' + target.addr + '，号码 ' + target.number
            : target?.kind === 'local' ? '识别为本实例号码 ' + target.number
            : '粘贴对方发来的一整段也行，会自动认出来'}
        </span>
      </label>

      {nearby.length ? (
        <div className="fed-nearby">
          <span className="field-label">同一个 Wi-Fi 下的 {nearby.length} 个实例，点「加」直接加好友</span>
          {nearby.map((item) => (
            <div className="fed-nearby-card" key={item.instanceId}>
              <div className="fed-nearby-head">
                <Icon name="wifi" size={15} />
                <span className="fed-nearby-addr">{item.addr}</span>
                <span className="fed-nearby-meta">{item.version || ''}</span>
              </div>
              {(item.numbers || []).length ? (
                (item.numbers || []).map((person) => (
                  <div className="fed-nearby-person" key={person.number}>
                    <Avatar number={person.number} nickname={person.nickname} avatar={person.avatar} size={30} />
                    <div className="fed-nearby-person-main">
                      <b>{person.nickname || person.number}</b>
                      <span>{person.number}{person.type === 'bot' ? ' · Bot' : ''}</span>
                    </div>
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => addNearby(item, person)}>
                      加
                    </button>
                  </div>
                ))
              ) : (
                <button type="button" className="fed-nearby-empty" onClick={() => { setInput(item.addr + ' '); setErr(''); setDone(null); }}>
                  这个实例还没公布名单，点一下把地址填进去
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}

      {target && target.kind !== 'invite' ? (
        <label className="field">
          <span className="field-label">验证消息（可选）</span>
          <input className="input" maxLength={120} placeholder="让对方知道你是谁" value={message} onChange={(e) => setMessage(e.target.value)} />
        </label>
      ) : null}

      {err ? <div className="auth-error">{err}</div> : null}

      {found?.account ? (
        <div className="fed-found">
          <Avatar number={found.account.number} nickname={found.account.nickname} avatar={found.account.avatar} size={44} />
          <div className="fed-found-main">
            <b>{found.account.nickname || found.account.number}</b>
            <span>{found.account.number}{found.isFriend ? ' · 已经是好友' : found.hasPending ? ' · 已经申请过' : found.addr ? ' · 来自 ' + found.addr : ''}</span>
          </div>
        </div>
      ) : null}

      {done ? (
        <div className="af-done">
          <Icon name="check" size={18} />
          <div>
            <b>{done.text}</b>
            <span>{done.name} · {done.number}</span>
          </div>
        </div>
      ) : null}

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>{done ? '关闭' : '取消'}</button>
        <button type="button" className="btn btn-ghost" onClick={paste}><Icon name="copy" size={15} /> 粘贴</button>
        <button type="button" className="btn btn-primary" disabled={!target || busy || !!done} onClick={submit}>
          {busy ? <Spinner size={15} /> : <Icon name="send" size={16} />} {target?.kind === 'invite' ? '用邀请码加好友' : '发送好友申请'}
        </button>
      </div>
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
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
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
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
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
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
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
