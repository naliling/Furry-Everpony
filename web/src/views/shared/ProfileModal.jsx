import { useEffect, useMemo, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Modal, Confirm, Spinner, Empty, toast, Avatar, StatusDot } from '../../ui/primitives.jsx';
import { api } from '../../lib/api.js';
import { statusMeta } from '../../lib/format.js';
import ImageViewer from '../../ui/ImageViewer.jsx';

export default function ProfileModal({ token, me, number, onClose, onChat, onChanged }) {
  const [user, setUser] = useState(null);
  const [friend, setFriend] = useState(null);
  const [groups, setGroups] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [remarkDraft, setRemarkDraft] = useState(null);
  const [requestMsg, setRequestMsg] = useState('');
  const [confirm, setConfirm] = useState(null);
  const [photoView, setPhotoView] = useState('');

  const isSelf = user?.isSelf;
  const isFriend = user?.isFriend;
  const blocked = user?.isBlocked;

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await api('/api/users/' + number, { token });
      setUser(data);
      if (data.isFriend) {
        const [fl, gl] = await Promise.all([
          api('/api/friends', { token }).catch(() => ({ friends: [] })),
          api('/api/friend-groups', { token }).catch(() => ({ groups: [] })),
        ]);
        setFriend((fl.friends || []).find((f) => f.number === number) || null);
        setGroups(gl.groups || []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  const refreshed = () => {
    onChanged?.();
    load();
  };

  const act = async (key, fn, successMsg) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (successMsg) toast(successMsg, 'success');
      refreshed();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const startChat = async () => {
    if (busy) return;
    setBusy('chat');
    try {
      const data = await api('/api/dm', { method: 'POST', token, body: { number } });
      onChat?.(data.conversationId);
      onClose();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const addFriend = () =>
    act(
      'request',
      () => api('/api/friends/request', { method: 'POST', token, body: { number, message: requestMsg.trim() } }),
      '好友申请已发出'
    );

  const acceptFriend = () => act('accept', () => api('/api/friends/accept', { method: 'POST', token, body: { number } }), '已添加为好友');

  const saveRemark = () => {
    const value = (remarkDraft ?? '').trim();
    act('remark', () => api('/api/friends/' + number, { method: 'PATCH', token, body: { remark: value } }), '备注已保存').then(() => setRemarkDraft(null));
  };

  const setGroup = (value) =>
    act('group', () => api('/api/friends/' + number, { method: 'PATCH', token, body: { groupId: value ? Number(value) : null } }), '分组已更新');

  const toggleSpecial = () =>
    act(
      'special',
      () => api('/api/friends/' + number, { method: 'PATCH', token, body: { special: !friend?.special } }),
      friend?.special ? '已取消特别关心' : '已设为特别关心'
    );

  const toggleBlock = () =>
    act(
      'block',
      () => (blocked ? api('/api/blocks/' + number, { method: 'DELETE', token }) : api('/api/blocks/' + number, { method: 'POST', token })),
      blocked ? '已解除拉黑' : '已拉黑'
    );

  const removeFriend = () =>
    act('delete', () => api('/api/friends/' + number, { method: 'DELETE', token }), '好友已删除');

  const status = user ? statusMeta(user.account?.status) : null;

  return (
    <>
    {/* 大图改用 ImageViewer（portal 到 body，层级在最上面）；之前是页面内的 div，
        嵌在资料卡的层叠上下文里，点开后被资料卡盖住 */}
    {photoView ? (
      <ImageViewer items={[{ url: photoView, name: '照片' }]} index={0} onClose={() => setPhotoView('')} />
    ) : null}
    <Modal title="资料卡" icon="friend" onClose={onClose} width={460}>
      {loading ? (
        <div className="profile-loading"><Spinner size={20} /> 正在读取资料</div>
      ) : error ? (
        <Empty icon="warning" title="读取失败" sub={error} action={<button type="button" className="btn btn-ghost" onClick={load}>重试</button>} />
      ) : user ? (
        <div className="profile-card">
          <div
            className={'profile-banner' + (user.account.card_bg ? ' has-bg' : '')}
            style={user.account.card_bg ? { backgroundImage: 'url("' + user.account.card_bg + '")' } : undefined}
          >
            <span className="profile-glow" />
            <Avatar
              number={user.account.number}
              nickname={user.account.nickname}
              avatar={user.account.avatar}
              size={76}
              status={user.account.status}
              className="profile-avatar"
            />
          </div>
          <div className="profile-id">
            <h3>{friend?.remark || user.account.nickname}</h3>
            <div className="profile-number">
              <span>#{user.account.number}</span>
              {user.account.type === 'bot' ? <span className="tag tag-bot">Bot</span> : null}
              {isFriend && friend?.special ? (
                <span className="tag tag-special">
                  <Icon name="starFilled" size={12} /> 特别关心
                </span>
              ) : null}
            </div>
            {status ? (
              <span className={'profile-status tone-' + status.tone}>
                <StatusDot status={user.account.status} />
                {status.label}
              </span>
            ) : null}
          </div>

          <p className="profile-bio">{user.account.bio || '这个人很神秘，什么都没写。'}</p>

          {Array.isArray(user.account.photos) && user.account.photos.length ? (
            <div className="profile-photos">
              <div className="profile-photos-head"><Icon name="image" size={14} /> 照片 · {user.account.photos.length}</div>
              <div className="photo-grid">
                {user.account.photos.map((src, i) => (
                  <button type="button" key={i} className="photo-cell" onClick={() => setPhotoView(src)} title="查看大图">
                    <img src={src} alt={'照片 ' + (i + 1)} loading="lazy" />
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {!isSelf ? (
            <div className="profile-actions">
              {isFriend ? (
                <button type="button" className="btn btn-primary" onClick={startChat} disabled={!!busy}>
                  {busy === 'chat' ? <Spinner size={15} /> : <Icon name="chat" size={17} />} 发消息
                </button>
              ) : user.hasPendingToMe ? (
                <button type="button" className="btn btn-primary" onClick={acceptFriend} disabled={!!busy}>
                  <Icon name="check" size={17} /> 同意好友申请
                </button>
              ) : (
                <button type="button" className="btn btn-primary" onClick={addFriend} disabled={!!busy || !!user.pendingToThem}>
                  <Icon name="plus" size={17} /> {user.pendingToThem ? '申请已发出' : '加为好友'}
                </button>
              )}
              <button type="button" className={'btn btn-ghost' + (friend?.special ? ' btn-special' : '')} onClick={toggleSpecial} disabled={!isFriend || !!busy}>
                <Icon name={friend?.special ? 'starFilled' : 'star'} size={17} /> {friend?.special ? '已特别关心' : '特别关心'}
              </button>
            </div>
          ) : (
            <p className="profile-self-note">这就是你自己。</p>
          )}

          {!isFriend && !isSelf && !user.hasPendingToMe ? (
            <label className="field">
              <span className="field-label">申请附言（可选）</span>
              <input className="input" placeholder="说一句话让对方知道你是谁" maxLength={120} value={requestMsg} onChange={(e) => setRequestMsg(e.target.value)} />
            </label>
          ) : null}

          {isFriend ? (
            <div className="profile-rows">
              <div className="profile-row">
                <span className="profile-row-label">备注</span>
                {remarkDraft === null ? (
                  <button type="button" className="profile-row-value link" onClick={() => setRemarkDraft(friend?.remark || '')}>
                    {friend?.remark || '未设置'} <Icon name="edit" size={14} />
                  </button>
                ) : (
                  <span className="profile-inline-edit">
                    <input className="input input-sm" maxLength={24} autoFocus value={remarkDraft} onChange={(e) => setRemarkDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') saveRemark(); if (e.key === 'Escape') setRemarkDraft(null); }} />
                    <button type="button" className="btn btn-sm btn-primary" onClick={saveRemark}>保存</button>
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemarkDraft(null)}>取消</button>
                  </span>
                )}
              </div>
              <div className="profile-row">
                <span className="profile-row-label">好友分组</span>
                <select className="select select-sm" value={friend?.group_id || ''} onChange={(e) => setGroup(e.target.value)}>
                  <option value="">未分组</option>
                  {groups.map((g) => (
                    <option key={g.id} value={g.id}>{g.name}（{g.count}）</option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          {!isSelf ? (
            <div className="profile-danger">
              <button type="button" className="text-btn" onClick={() => setConfirm(blocked ? 'unblock' : 'block')}>
                <Icon name="lock" size={15} /> {blocked ? '解除拉黑' : '拉黑'}
              </button>
              {isFriend ? (
                <button type="button" className="text-btn danger" onClick={() => setConfirm('delete')}>
                  <Icon name="trash" size={15} /> 删除好友
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {confirm === 'delete' ? (
        <Confirm
          title="删除好友"
          message={'确定删除 ' + number + ' 吗？聊天记录不会被删除，但你们将不再是好友。'}
          danger
          confirmText="删除"
          onConfirm={removeFriend}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'block' ? (
        <Confirm
          title="拉黑"
          message="拉黑后对方不能再给你发消息、发好友申请。"
          danger
          confirmText="拉黑"
          onConfirm={toggleBlock}
          onClose={() => setConfirm(null)}
        />
      ) : null}
      {confirm === 'unblock' ? (
        <Confirm title="解除拉黑" message="解除后对方可以重新联系你。" confirmText="解除" onConfirm={toggleBlock} onClose={() => setConfirm(null)} />
      ) : null}
    </Modal>
    </>
  );
}
