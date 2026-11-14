import { useEffect, useMemo, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Drawer, Avatar, Empty, Spinner, Toggle, Confirm, Modal, ContextMenu, toast, Tabs, useIsMobile } from '../../ui/primitives.jsx';
import { api, uploadFile, mediaUrl } from '../../lib/api.js';
import { fmtDate, fmtSize, relTime, roleLabel } from '../../lib/format.js';
import { AnnouncementModal, GroupInviteModal } from '../shared/Dialogs.jsx';

const MUTE_OPTIONS = [
  { minutes: 10, label: '10 分钟' },
  { minutes: 60, label: '1 小时' },
  { minutes: 360, label: '6 小时' },
  { minutes: 1440, label: '1 天' },
  { minutes: 43200, label: '30 天' },
];

export default function GroupInfo({ token, me, group, onClose, onChanged, onMemberClick, onLeft, initialTab }) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState(initialTab || 'members');
  const [detail, setDetail] = useState(null);
  const [members, setMembers] = useState([]);
  const [files, setFiles] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [muteTarget, setMuteTarget] = useState(null);
  const [muteMinutes, setMuteMinutes] = useState(60);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [cardNick, setCardNick] = useState('');
  const [groupName, setGroupName] = useState('');
  const [editingName, setEditingName] = useState(false);
  const [announceDraft, setAnnounceDraft] = useState('');
  const [editingAnnounce, setEditingAnnounce] = useState(false);
  const fileInput = useRef(null);

  const number = group?.number;

  const load = async () => {
    if (!number) return;
    setLoading(true);
    try {
      const [g, m] = await Promise.all([
        api('/api/groups/' + number, { token }),
        api('/api/groups/' + number + '/members', { token }),
      ]);
      setDetail(g.group || null);
      setMembers(m.members || []);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setLoading(false);
    }
  };

  const loadFiles = async () => {
    if (!number) return;
    setFiles(null);
    try {
      const data = await api('/api/groups/' + number + '/files', { token });
      setFiles(data.files || []);
    } catch (err) {
      toast(err.message, 'error');
      setFiles([]);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [number]);

  useEffect(() => {
    if (tab === 'files' && files === null) loadFiles();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  useEffect(() => {
    if (!detail) return;
    setCardNick(detail.my_nickname || '');
    setGroupName(detail.name || '');
    setAnnounceDraft(detail.announcement || '');
  }, [detail]);

  const myRole = detail?.role || group?.role;
  const isOwner = myRole === 'owner';
  const isAdmin = isOwner || myRole === 'admin';
  const canManage = isAdmin;
  const info = detail || group || {};
  const mutedAll = !!(info.mute_all);
  const myMutedUntil = Number(info.my_mute_until || 0);
  const myMuted = myMutedUntil > Date.now();

  const refresh = () => { load(); onChanged?.(); };

  const act = async (key, fn, okMsg) => {
    if (busy) return;
    setBusy(key);
    try {
      await fn();
      if (okMsg) toast(okMsg, 'success');
      refresh();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const filtered = useMemo(() => {
    const kw = search.trim().toLowerCase();
    const list = [...members].sort((a, b) => {
      const rank = { owner: 0, admin: 1, member: 2 };
      const r = (rank[a.role] ?? 3) - (rank[b.role] ?? 3);
      return r !== 0 ? r : (b.online ? 1 : 0) - (a.online ? 1 : 0);
    });
    if (!kw) return list;
    return list.filter((m) => String(m.nickname || '').toLowerCase().includes(kw) || String(m.number).includes(kw));
  }, [members, search]);

  const setRole = (member, admin) => act('role-' + member.number, async () => {
    await api('/api/groups/' + number + '/admin', { method: 'POST', token, body: { number: member.number, admin } });
  }, admin ? '已设为管理员' : '已取消管理员');

  const kick = (member) => setConfirm({ type: 'kick', member });
  const muteMember = (member) => setMuteTarget(member);

  const doMute = async () => {
    if (!muteTarget) return;
    await act('mute', () => api('/api/groups/' + number + '/mute', { method: 'POST', token, body: { number: muteTarget.number, minutes: muteMinutes } }), '已禁言');
    setMuteTarget(null);
  };

  const toggleMuteAll = (value) => act('mute-all', () => api('/api/groups/' + number + '/mute-all', { method: 'POST', token, body: { muteAll: value } }), value ? '已开启全员禁言' : '已关闭全员禁言');

  const saveCard = () => act('card', () => api('/api/groups/' + number + '/me', { method: 'PATCH', token, body: { nickname: cardNick.trim() } }), '群名片已保存');

  const saveName = async () => {
    if (!groupName.trim()) return;
    await act('name', () => api('/api/groups/' + number, { method: 'PATCH', token, body: { name: groupName.trim() } }), '群名已修改');
    setEditingName(false);
  };

  const saveAnnounce = async () => {
    await act('announce', () => api('/api/groups/' + number, { method: 'PATCH', token, body: { announcement: announceDraft.trim() } }), '公告已发布');
    setEditingAnnounce(false);
  };

  const leave = () => setConfirm({ type: 'leave' });

  const uploadGroupFile = async (file) => {
    if (!file) return;
    setBusy('upload');
    try {
      const up = await uploadFile(file, token);
      await api('/api/groups/' + number + '/files', { method: 'POST', token, body: { name: up.name, url: up.url, size: up.size } });
      toast('文件已上传', 'success');
      loadFiles();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      setBusy('');
    }
  };

  const deleteFile = (file) => setConfirm({ type: 'file', file });

  const memberMenu = (e, member) => {
    e.preventDefault();
    e.stopPropagation();
    const items = [];
    if (member.number !== me?.number) {
      items.push({ label: '查看资料', icon: 'friend', onClick: () => onMemberClick?.(member.number) });
      items.push({ label: '提醒 TA', icon: 'at', onClick: () => onMemberClick?.(member.number, 'mention') });
    }
    if (canManage && member.role !== 'owner' && member.number !== me?.number) {
      items.push({ divider: true });
      if (isOwner) items.push({ label: member.role === 'admin' ? '取消管理员' : '设为管理员', icon: 'shield', onClick: () => setRole(member, member.role !== 'admin') });
      items.push({ label: '禁言', icon: 'mute', onClick: () => muteMember(member) });
      items.push({ label: '移出群聊', icon: 'logout', danger: true, onClick: () => kick(member) });
    }
    setMenu({ x: e.clientX, y: e.clientY, items });
  };

  const tabs = [
    { id: 'members', label: '成员', icon: 'users', badge: detail?.members || members.length },
    { id: 'files', label: '文件', icon: 'folder' },
    { id: 'announcement', label: '公告', icon: 'bell' },
    { id: 'settings', label: '设置', icon: 'gear' },
  ];

  return (
    <Drawer title={info.name || '群资料'} subtitle={'群号 ' + (number || '') + (members.length ? ' · ' + members.length + ' 人' : '')} icon="group" onClose={onClose} width={400}>
      <div className="group-info">
        <div className="group-hero">
          <Avatar number={number} nickname={info.name} square size={58} />
          <div className="group-hero-main">
            <h3>{info.name || '群聊'}</h3>
            <div className="group-hero-meta">
              <span>{number}</span>
              {info.mute_all ? <span className="tag tag-warn"><Icon name="mute" size={12} /> 全员禁言</span> : null}
              {isOwner ? <span className="tag tag-owner">群主</span> : isAdmin ? <span className="tag tag-admin">管理员</span> : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={() => setInviteOpen(true)} title="邀请成员"><Icon name="plus" size={18} /></button>
        </div>

        {myMuted ? (
          <div className="group-banner warn"><Icon name="mute" size={15} /> 你已被禁言，至 {fmtDate(myMutedUntil)} {''}</div>
        ) : null}

        <Tabs tabs={tabs} value={tab} onChange={setTab} />

        <div className="group-body">
          {tab === 'members' ? (
            <>
              <div className="input-wrap group-search">
                <Icon name="search" size={15} className="input-lead" />
                <input className="input input-sm" placeholder="搜索群成员" value={search} onChange={(e) => setSearch(e.target.value)} />
              </div>
              {canManage ? (
                <div className="group-row">
                  <span className="group-row-label"><Icon name="mute" size={15} /> 全员禁言</span>
                  <Toggle checked={mutedAll} onChange={toggleMuteAll} disabled={!!busy} />
                </div>
              ) : null}
              {loading ? (
                <div className="dialog-loading"><Spinner size={18} /> 加载成员</div>
              ) : filtered.length === 0 ? (
                <Empty icon="users" title="没有匹配的成员" compact />
              ) : (
                <div className="member-list">
                  {filtered.map((m) => (
                    <button type="button" key={m.number} className="member-row" onClick={() => onMemberClick?.(m.number)} onContextMenu={(e) => memberMenu(e, m)}>
                      <Avatar number={m.number} nickname={m.nickname} avatar={m.avatar} size={36} status={m.online ? 'online' : 'offline'} />
                      <span className="member-main">
                        <span className="member-name">
                          {m.nickname}
                          {m.role === 'owner' ? <span className="tag tag-owner">群主</span> : m.role === 'admin' ? <span className="tag tag-admin">管理员</span> : null}
                          {m.mute_until > 0 ? <span className="tag tag-warn"><Icon name="mute" size={11} /> 禁言中</span> : null}
                        </span>
                        <span className="member-sub">{m.group_nickname ? '群名片 · ' : ''}{m.number}{m.online ? ' · 在线' : ''}</span>
                      </span>
                      {canManage && m.number !== me?.number ? (
                        <span className="member-more" onClick={(e) => memberMenu(e, m)}><Icon name="more" size={16} /></span>
                      ) : null}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" className="btn btn-ghost btn-block group-invite" onClick={() => setInviteOpen(true)}>
                <Icon name="plus" size={16} /> 邀请成员
              </button>
            </>
          ) : null}

          {tab === 'files' ? (
            <>
              <div className="group-row">
                <span className="group-row-label"><Icon name="folder" size={15} /> 群文件</span>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => fileInput.current?.click()} disabled={busy === 'upload'}>
                  {busy === 'upload' ? <Spinner size={14} /> : <Icon name="plus" size={15} />} 上传
                </button>
                <input ref={fileInput} type="file" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) uploadGroupFile(f); }} />
              </div>
              {files === null ? (
                <div className="dialog-loading"><Spinner size={18} /> 加载文件</div>
              ) : files.length === 0 ? (
                <Empty icon="folder" title="群里还没有文件" sub="上传的文件所有成员都能下载" compact />
              ) : (
                <div className="file-list">
                  {files.map((f) => (
                    <div className="group-file" key={f.id}>
                      <span className="group-file-icon"><Icon name={fileIcon(f.name)} size={19} /></span>
                      <span className="group-file-main">
                        <b>{f.name}</b>
                        <span>{fmtSize(f.size)} · {f.uploader_nickname || f.uploader_number || ''} · {fmtDate(f.created_at)}</span>
                      </span>
                      <a className="icon-btn" href={mediaUrl(f.url)} download={f.name} title="下载"><Icon name="download" size={16} /></a>
                      {canManage || f.uploader_number === me?.number ? (
                        <button type="button" className="icon-btn danger" onClick={() => deleteFile(f)} title="删除"><Icon name="trash" size={16} /></button>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : null}

          {tab === 'announcement' ? (
            <>
              <div className="group-row">
                <span className="group-row-label"><Icon name="bell" size={15} /> 群公告</span>
                <div className="group-row-actions">
                  {canManage && !editingAnnounce ? (
                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingAnnounce(true)}><Icon name="edit" size={14} /> 编辑</button>
                  ) : null}
                  <button type="button" className="btn btn-sm btn-ghost" onClick={() => setAnnounceOpen(true)}>查看</button>
                </div>
              </div>
              {editingAnnounce ? (
                <>
                  <textarea className="textarea" rows={6} maxLength={500} value={announceDraft} onChange={(e) => setAnnounceDraft(e.target.value)} placeholder="写一条群公告" />
                  <div className="group-form-actions">
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setEditingAnnounce(false); setAnnounceDraft(detail?.announcement || ''); }}>取消</button>
                    <button type="button" className="btn btn-primary btn-sm" onClick={saveAnnounce} disabled={busy === 'announce'}>发布公告</button>
                  </div>
                </>
              ) : info.announcement ? (
                <button type="button" className="announce-preview" onClick={() => setAnnounceOpen(true)}>
                  <p>{info.announcement}</p>
                  <span><Icon name="clock" size={13} /> {info.announcement_updated_at ? relTime(info.announcement_updated_at) : '已发布'}</span>
                </button>
              ) : (
                <Empty icon="bell" title="还没有群公告" sub={canManage ? '点编辑发布第一条公告' : '等待群主或管理员发布'} compact />
              )}
            </>
          ) : null}

          {tab === 'settings' ? (
            <div className="group-settings">
              <div className="group-setting-block">
                <div className="group-setting-title"><Icon name="edit" size={15} /> 群名片</div>
                <div className="group-inline">
                  <input className="input input-sm" maxLength={24} value={cardNick} onChange={(e) => setCardNick(e.target.value)} placeholder="我在本群的昵称" />
                  <button type="button" className="btn btn-sm btn-ghost" onClick={saveCard} disabled={busy === 'card'}>保存</button>
                </div>
              </div>

              {canManage ? (
                <div className="group-setting-block">
                  <div className="group-setting-title"><Icon name="group" size={15} /> 群名称</div>
                  {editingName ? (
                    <div className="group-inline">
                      <input className="input input-sm" maxLength={24} value={groupName} onChange={(e) => setGroupName(e.target.value)} />
                      <button type="button" className="btn btn-sm btn-primary" onClick={saveName} disabled={busy === 'name'}>保存</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setEditingName(false); setGroupName(info.name || ''); }}>取消</button>
                    </div>
                  ) : (
                    <div className="group-inline">
                      <span className="group-inline-value">{info.name}</span>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditingName(true)}>修改</button>
                    </div>
                  )}
                </div>
              ) : null}

              <div className="group-setting-block">
                <div className="group-setting-title"><Icon name="bell" size={15} /> 消息提醒</div>
                <div className="group-row">
                  <span className="group-row-label">群公告未读提醒</span>
                  <span className="group-row-value">{info.announcement_read_at ? '已开启' : '已开启'}</span>
                </div>
              </div>

              <div className="group-setting-block danger">
                <div className="group-setting-title"><Icon name="logout" size={15} /> 退出群聊</div>
                <button type="button" className="btn btn-danger btn-block" onClick={leave}>退出这个群</button>
              </div>
            </div>
          ) : null}

          {/* 手机端抽屉是整屏，任何标签页底部都能直接退群，不用先切到设置 */}
          {isMobile ? (
            <div className="group-setting-block danger group-leave-mobile">
              <button type="button" className="btn btn-danger btn-block" onClick={leave}>
                <Icon name="logout" size={16} /> 退出这个群
              </button>
            </div>
          ) : null}
        </div>

        <div className="group-foot">
          <button type="button" className="btn btn-ghost" onClick={onClose}>关闭</button>
        </div>
      </div>

      {menu ? <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} /> : null}

      {muteTarget ? (
        <Modal title={'禁言 ' + muteTarget.nickname} icon="mute" onClose={() => setMuteTarget(null)} width={380}>
          <div className="segmented">
            {MUTE_OPTIONS.map((o) => (
              <button type="button" key={o.minutes} className={muteMinutes === o.minutes ? 'on' : ''} onClick={() => setMuteMinutes(o.minutes)}>{o.label}</button>
            ))}
          </div>
          <div className="modal-foot">
            <button type="button" className="btn btn-ghost" onClick={() => setMuteTarget(null)}>取消</button>
            <button type="button" className="btn btn-primary" onClick={doMute} disabled={!!busy}>确定禁言</button>
          </div>
        </Modal>
      ) : null}

      {announceOpen ? <AnnouncementModal token={token} group={info} canEdit={canManage} onClose={() => setAnnounceOpen(false)} onChanged={refresh} /> : null}
      {inviteOpen ? <GroupInviteModal token={token} group={{ number }} onClose={() => setInviteOpen(false)} onChanged={onChanged} /> : null}

      {confirm?.type === 'kick' ? (
        <Confirm title="移出群聊" message={'确定把 ' + confirm.member.nickname + ' 移出群聊吗？'} danger confirmText="移出"
          onConfirm={() => { const m = confirm.member; setConfirm(null); act('kick', () => api('/api/groups/' + number + '/kick', { method: 'POST', token, body: { number: m.number } }), '已移出群聊'); }}
          onClose={() => setConfirm(null)} />
      ) : null}
      {confirm?.type === 'file' ? (
        <Confirm title="删除群文件" message={'确定删除「' + confirm.file.name + '」吗？'} danger confirmText="删除"
          onConfirm={() => { const f = confirm.file; setConfirm(null); act('delfile', () => api('/api/groups/' + number + '/files/' + f.id, { method: 'DELETE', token }), '文件已删除').then(loadFiles); }}
          onClose={() => setConfirm(null)} />
      ) : null}
      {confirm?.type === 'leave' ? (
        <Confirm title="退出群聊" message="退群后聊天记录会保留，但你将不再是群成员。确定退出吗？" danger confirmText="退出"
          onConfirm={async () => { try { await api('/api/groups/' + number + '/leave', { method: 'DELETE', token }); toast('已退出群聊', 'success'); setConfirm(null); onLeft?.(); onClose(); } catch (err) { toast(err.message, 'error'); } }}
          onClose={() => setConfirm(null)} />
      ) : null}
    </Drawer>
  );
}

function fileIcon(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['mp3', 'wav', 'ogg', 'm4a', 'webm'].includes(ext)) return 'volume';
  if (['mp4', 'mov', 'mkv'].includes(ext)) return 'play';
  if (['zip', 'rar', '7z'].includes(ext)) return 'file';
  if (['pdf', 'txt', 'md', 'doc', 'docx'].includes(ext)) return 'fileText';
  return 'file';
}
