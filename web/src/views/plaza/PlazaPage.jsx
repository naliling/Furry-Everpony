import { useCallback, useEffect, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Avatar, Empty, SkeletonList, toast } from '../../ui/primitives.jsx';
import { api, serverBase } from '../../lib/api.js';

/**
 * 未登录时的首页：Bot 广场。
 * 不做鉴权请求（/api/bots/public 允许匿名），点任何卡片都引导去登录/注册。
 */
export default function PlazaPage({ onLogin }) {
  const [q, setQ] = useState('');
  const [bots, setBots] = useState(null);
  const [note, setNote] = useState('');
  const [online, setOnline] = useState(0);
  const timerRef = useRef(null);

  const load = useCallback(async (keyword = '') => {
    try {
      const data = await api('/api/bots/public?q=' + encodeURIComponent(keyword) + '&limit=60');
      const list = data.bots || [];
      setBots(list);
      setNote(data.note || '');
      setOnline(list.filter((b) => b.online).length);
    } catch (err) {
      setBots([]);
      toast(err.message, 'error');
    }
  }, []);

  useEffect(() => {
    load('');
    /* 在线状态 20 秒刷一次，首页不用手动刷新 */
    const id = window.setInterval(() => load(q.trim()), 20000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  const onSearch = (value) => {
    setQ(value);
    window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => load(value.trim()), 300);
  };

  const list = bots || [];

  return (
    <div className="plaza-page">
      <div className="plaza-glow" aria-hidden />
      <header className="plaza-top">
        <div className="plaza-brand">
          <span className="plaza-brand-mark"><Icon name="starFilled" size={19} /></span>
          <div>
            <strong>Everony</strong>
            <span>{serverBase() || '本站'} · Bot 广场</span>
          </div>
        </div>
        <div className="plaza-top-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onLogin}>登录</button>
          <button type="button" className="btn btn-primary btn-sm" onClick={onLogin}><Icon name="plus" size={15} /> 注册</button>
        </div>
      </header>

      <section className="plaza-hero-lg">
        <h1>挑一个 Bot，<span className="grad-text">现在就开聊</span></h1>
        <p>不用加好友，不用装软件。打开网页就能和广场上的角色说话，聊过的内容按你的号码记着。</p>
        <div className="plaza-hero-stats">
          <span><b>{list.length}</b> 个公开 Bot</span>
          <span><b>{online}</b> 个在线</span>
          <span>注册后可自选 8–11 位号码</span>
        </div>
        <div className="input-wrap plaza-search-lg">
          <Icon name="search" size={18} className="input-lead" />
          <input className="input" placeholder="搜索 Bot 名字、号码或标签" value={q} onChange={(e) => onSearch(e.target.value)} />
          {q ? <button type="button" className="input-clear" aria-label="清空" onClick={() => onSearch('')}><Icon name="close" size={13} /></button> : null}
        </div>
      </section>

      <section className="plaza-list-wrap">
        {bots === null ? <SkeletonList rows={6} /> : list.length === 0 ? (
          <Empty icon="bot" title={q ? '没有找到匹配的 Bot' : '广场还空着'} sub={q ? '换个关键词试试' : (note || '等运营者把 Bot 公开出来，这里就会出现')} />
        ) : (
          <div className="bot-grid plaza-grid">
            {list.map((bot) => (
              <button type="button" key={bot.number} className="bot-card plaza-card" onClick={onLogin}>
                <span className="bot-card-avatar"><Avatar number={bot.number} nickname={bot.nickname} avatar={bot.avatar} size={54} square /></span>
                <span className="bot-card-main">
                  <span className="bot-card-name">
                    {bot.nickname || bot.number}
                    <span className="bot-card-online"><i className={bot.online ? 'on' : ''} /></span>
                  </span>
                  <span className="bot-card-number">#{bot.number}</span>
                  {(bot.tags || []).length ? (
                    <span className="bot-card-tags">
                      {(bot.tags || []).slice(0, 4).map((t) => <span className="tag-chip" key={t}>{t}</span>)}
                    </span>
                  ) : null}
                  <span className="bot-card-bio">{bot.bio || '这个 Bot 还没有签名'}</span>
                </span>
                <span className="plaza-card-go"><Icon name="arrowRight" size={16} /></span>
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="plaza-how" aria-label="怎么玩">
        <div className="plaza-how-item">
          <span className="plaza-how-icon"><Icon name="bot" size={17} /></span>
          <div>
            <strong>挑一个就开聊</strong>
            <span>广场上都是本站运营者挂的 Bot，点开直接说话，不用加好友、不用装软件。</span>
          </div>
        </div>
        <div className="plaza-how-item">
          <span className="plaza-how-icon"><Icon name="hash" size={17} /></span>
          <div>
            <strong>号码记住你</strong>
            <span>注册时自选 8–11 位号码，Bot 按号码认人，换设备聊天记录也跟着走。</span>
          </div>
        </div>
        <div className="plaza-how-item">
          <span className="plaza-how-icon"><Icon name="link" size={17} /></span>
          <div>
            <strong>自己的 Bot 也能挂</strong>
            <span>接上 AstrBot / Koishi / NoneBot2，人设与记忆都在你自己那边。</span>
          </div>
        </div>
      </section>

      <footer className="plaza-foot">
        <span>登录后即可开聊 · 数据保存在本站</span>
        <button type="button" className="btn btn-primary btn-sm" onClick={onLogin}>用邮箱登录 / 注册</button>
      </footer>
    </div>
  );
}
