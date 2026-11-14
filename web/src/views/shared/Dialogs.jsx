import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Modal, Avatar, Empty, Spinner, toast } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { fmtClock, fmtDate, relTime } from '../../lib/format.js';

/* ---------------- 加好友（同实例号码 / 跨实例） ---------------- */
export function AddFriendModal({ token, onClose, onChanged }) {
  const [tab, setTab] = useState('local');
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const valid = /^\d{5,12}$/.test(number);

  const submit = async () => {
    if (!valid || busy) return;
    setBusy(true);
    try {
      await api('/api/friends/request', { method: 'POST', token, body: { number, message: message.trim() } });
      toast('好友申请已发出', 'success');
      onChanged?.();
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="加好友" icon="friend" onClose={onClose} width={460}>
      <div className="segmented af-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'local'} className={tab === 'local' ? 'on' : ''} onClick={() => setTab('local')}>同一台服务器</button>
        <button type="button" role="tab" aria-selected={tab === 'remote'} className={tab === 'remote' ? 'on' : ''} onClick={() => setTab('remote')}>别的服务器 / 别人的电脑</button>
      </div>

      {tab === 'local' ? (
        <>
          <label className="field">
            <span className="field-label">对方号码</span>
            <div className="input-wrap">
              <Icon name="hash" size={16} className="input-lead" />
              <input
                className="input input-number"
                inputMode="numeric"
                placeholder="5–12 位数字"
                value={number}
                onChange={(e) => setNumber(e.target.value.replace(/\D/g, '').slice(0, 12))}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
              />
            </div>
          </label>
          <label className="field">
            <span className="field-label">验证消息（可选）</span>
            <textarea className="textarea" rows={3} maxLength={120} placeholder="让对方知道你是谁" value={message} onChange={(e) => setMessage(e.target.value)} />
          </label>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
            <button type="button" className="btn btn-primary" disabled={!valid || busy} onClick={submit}>
              {busy ? <Spinner size={15} /> : <Icon name="send" size={16} />} 发送申请
            </button>
          </div>
        </>
      ) : (
        <CrossInstanceAdd token={token} onClose={onClose} onChanged={onChanged} />
      )}
    </Modal>
  );
}

/* 跨实例：先选一个附近实例或手填地址，查号码 → 看资料 → 发申请 */
function CrossInstanceAdd({ token, onClose, onChanged }) {
  const [info, setInfo] = useState(null);
  const [nearby, setNearby] = useState([]);
  const [addr, setAddr] = useState('');
  const [number, setNumber] = useState('');
  const [message, setMessage] = useState('');
  const [found, setFound] = useState(null);
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState('invite');
  const [myInvite, setMyInvite] = useState(null);
  const [inviteErr, setInviteErr] = useState('');
  const [inviteInput, setInviteInput] = useState('');
  const validNumber = /^\d{5,12}$/.test(number);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [i, n] = await Promise.all([
          api('/api/federation/info', { token }).catch(() => null),
          api('/api/federation/nearby', { token }).catch(() => ({ instances: [] })),
        ]);
        if (!alive) return;
        setInfo(i);
        const list = (n.instances || []).filter((x) => x.instanceId !== i?.instanceId);
        setNearby(list);
      } catch {
        /* 忽略 */
      }
    };
    load();
    loadInvite();
    /* 附近实例是 UDP 广播发现的，隔几秒刷新一次就能看到刚上线的电脑 */
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, [token]);

  const myAddr = info?.publicAddr || info?.myAddresses?.[0] || '';

  /* 我的邀请码：进弹窗就取一次，点了「换一个」再取（地址可能刚变） */
  const loadInvite = async () => {
    try {
      const out = await api('/api/federation/invite', { token });
      setMyInvite(out);
      setInviteErr('');
    } catch (e) {
      setMyInvite(null);
      setInviteErr(e.message);
    }
  };

  const copyInvite = async () => {
    if (!myInvite?.code) return;
    try {
      await navigator.clipboard.writeText(myInvite.code);
      toast('邀请码已复制，发给对方就行', 'success');
    } catch {
      toast('复制失败，手动全选这串文字', 'error');
    }
  };

  /* 粘贴对方邀请码 → 解析出地址和号码 → 直接查资料 */
  const acceptInvite = async () => {
    const code = inviteInput.trim();
    if (!code) return;
    setErr('');
    setFound(null);
    setBusy('invite');
    try {
      const data = await api('/api/federation/invite/accept', { method: 'POST', token, body: { code } });
      setFound({ ...data, addr: data.addr });
      setNumber(data.account?.number || '');
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const copyMy = async () => {
    if (!myAddr) return;
    try {
      await navigator.clipboard.writeText(myAddr);
      toast('已复制我的地址：' + myAddr, 'success');
    } catch {
      toast(myAddr, 'success');
    }
  };

  const lookup = async (target) => {
    const useAddr = target || addr;
    setErr('');
    setFound(null);
    setBusy('lookup');
    try {
      const data = await api('/api/federation/lookup', { method: 'POST', token, body: { addr: useAddr, number } });
      setFound({ ...data, addr: useAddr });
      if (!addr) setAddr(useAddr);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  const sendRequest = async () => {
    if (!found?.account) return;
    setBusy('send');
    setErr('');
    try {
      const out = await api('/api/federation/request', { method: 'POST', token, body: { addr: found.addr, number, message: message.trim() } });
      toast(out?.pendingApproval ? '申请已送到，等对方同意' : '申请已发出', 'success');
      onChanged?.();
      onClose();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="fed-add">
      <div className="fed-mode">
        <button type="button" className={'fed-mode-btn' + (mode === 'invite' ? ' on' : '')} onClick={() => { setMode('invite'); setFound(null); setErr(''); }}>
          <Icon name="qr" size={15} /> 不同网络（邀请码）
        </button>
        <button type="button" className={'fed-mode-btn' + (mode === 'addr' ? ' on' : '')} onClick={() => { setMode('addr'); setFound(null); setErr(''); }}>
          <Icon name="link" size={15} /> 填地址
        </button>
      </div>

      {mode === 'invite' ? (
        <>
          <div className="fed-mine fed-invite-mine">
            <div>
              <b>我的邀请码</b>
              <span>{myInvite?.code ? '复制发给对方（微信/短信都行），对方粘进去就能找到你' : inviteErr || '正在生成…'}</span>
            </div>
            {myInvite?.code ? (
              <div className="fed-invite-actions">
                <button type="button" className="btn btn-primary btn-sm" onClick={copyInvite}><Icon name="copy" size={14} /> 复制</button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={loadInvite}><Icon name="refresh" size={14} /> 换一个</button>
              </div>
            ) : null}
          </div>
          {myInvite?.code ? <div className="fed-invite-code" title="这里只显示前面一截，点上面的「复制」拿到完整邀请码">{myInvite.code.slice(0, 64)}…</div> : null}
          <label className="field">
            <span className="field-label">对方发来的邀请码</span>
            <textarea
              className="textarea fed-invite-input"
              rows={2}
              value={inviteInput}
              onChange={(e) => { setInviteInput(e.target.value.trim()); setFound(null); }}
              placeholder="粘贴 FEINV1. 开头的那一整串"
            />
          </label>
        </>
      ) : (
        <>
      <div className="fed-mine">
        <div>
          <b>我的实例地址</b>
          <span>{myAddr || '这台机器的地址还没探测出来，可以在「设置 → 实例互联」里手动填'}</span>
        </div>
        {myAddr ? <button type="button" className="btn btn-ghost btn-sm" onClick={copyMy}><Icon name="copy" size={14} /> 复制</button> : null}
      </div>

      {nearby.length ? (
        <div className="fed-nearby">
          <span className="field-label">同一个 Wi-Fi 下发现的实例</span>
          {nearby.map((item) => (
            <button type="button" key={item.instanceId} className="fed-nearby-item" onClick={() => { setAddr(item.addr); setFound(null); }}>
              <Icon name="wifi" size={15} />
              <span className="fed-nearby-addr">{item.addr}</span>
              <span className="fed-nearby-meta">{item.version || ''}</span>
            </button>
          ))}
        </div>
      ) : null}

      <div className="fed-row">
        <label className="field">
          <span className="field-label">对方实例地址</span>
          <div className="input-wrap">
            <Icon name="link" size={15} className="input-lead" />
            <input className="input" placeholder="例如 192.168.1.8:7788" value={addr} onChange={(e) => { setAddr(e.target.value.trim()); setFound(null); }} />
          </div>
        </label>
        <label className="field">
          <span className="field-label">对方号码</span>
          <div className="input-wrap">
            <Icon name="hash" size={15} className="input-lead" />
            <input className="input input-number" inputMode="numeric" placeholder="5–12 位数字" value={number}
              onChange={(e) => { setNumber(e.target.value.replace(/\D/g, '').slice(0, 12)); setFound(null); }} />
          </div>
        </label>
      </div>
        </>
      )}

      {err ? <div className="auth-error">{err}</div> : null}

      {found?.account ? (
        <div className="fed-found">
          <Avatar number={found.account.number} nickname={found.account.nickname} avatar={found.account.avatar} size={44} />
          <div className="fed-found-main">
            <b>{found.account.nickname || found.account.number}</b>
            <span>{found.account.number}{found.isFriend ? ' · 已经是好友' : found.hasPending ? ' · 已经申请过' : ' · ' + (found.account.bio || '这个人在另一个实例上')}</span>
          </div>
        </div>
      ) : null}

      {found?.account && !found.isFriend && !found.hasPending ? (
        <label className="field">
          <span className="field-label">验证消息（可选）</span>
          <textarea className="textarea" rows={2} maxLength={120} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="让对方知道你是谁" />
        </label>
      ) : null}

      <div className="modal-foot">
        <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
        {!found?.account ? (
          mode === 'invite' ? (
            <button type="button" className="btn btn-primary" disabled={!inviteInput.trim() || busy === 'invite'} onClick={acceptInvite}>
              {busy === 'invite' ? <Spinner size={15} /> : <Icon name="search" size={16} />} 用邀请码找他
            </button>
          ) : (
            <button type="button" className="btn btn-primary" disabled={!validNumber || !addr || busy === 'lookup'} onClick={() => lookup()}>
              {busy === 'lookup' ? <Spinner size={15} /> : <Icon name="search" size={16} />} 查这个号码
            </button>
          )
        ) : found.isFriend || found.hasPending ? (
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy === 'send'} onClick={sendRequest}>
            {busy === 'send' ? <Spinner size={15} /> : <Icon name="send" size={16} />} 发送申请
          </button>
        )}
      </div>
    </div>
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
