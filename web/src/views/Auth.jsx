import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import { Segmented, Spinner, Avatar, toast } from '../ui/primitives.jsx';
import { api, apiUrl, loadAccounts, rememberAccount, forgetAccount, serverBase, setServerBase } from '../lib/api.js';

const THEMES = [
  { value: 'deep', label: '深空' },
  { value: 'violet', label: '暗夜紫' },
  { value: 'light', label: '晨雾' },
];

const FONTS = [
  { value: 's', label: '小' },
  { value: 'm', label: '中' },
  { value: 'l', label: '大' },
];

const FEATURES = [
  { icon: 'grid', title: 'Bot 广场', text: '不用登录也能逛，看中就聊' },
  { icon: 'bot', title: '自己的 Bot', text: '接上 AstrBot / Koishi / NoneBot2，人设记忆都在你自己那边' },
  { icon: 'hash', title: '号码认人', text: '8–11 位自选号码，Bot 靠号码记住你' },
  { icon: 'phone', title: '手机即用', text: '浏览器打开就能聊，还能加到桌面当应用' },
];

export default function Auth({ onAuthed, theme, onTheme, font, onFont }) {
  const [mode, setMode] = useState('login');
  /* 登录：一个输入框吃「邮箱 或 号码」；注册：邮箱 + 自选号码 */
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [number, setNumber] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [nickname, setNickname] = useState('');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accountList, setAccountList] = useState(() => loadAccounts());
  /* 中心服务器模式：留空连本机，填地址连那台公共服务器 */
  const [serverInput, setServerInput] = useState(() => serverBase());
  const [serverBusy, setServerBusy] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const [lanServers, setLanServers] = useState([]);
  const emailRef = useRef(null);

  const probeServer = async (base) => {
    setServerBusy(true);
    try {
      const res = await fetch((base || '') + '/api/health');
      const data = await res.json();
      if (!res.ok) throw new Error('bad');
      setServerInfo({ ok: true, version: data.version || '', role: data.role || '' });
    } catch {
      setServerInfo({ ok: false, version: '' });
    } finally {
      setServerBusy(false);
    }
  };

  useEffect(() => {
    probeServer(serverBase());
    /* 没配服务器时自动找一下局域网里的服务器（手机不用手打 IP） */
    if (!serverBase()) {
      fetch(apiUrl('/api/discover/lan'))
        .then((r) => (r.ok ? r.json() : { instances: [] }))
        .then((d) => setLanServers(Array.isArray(d.instances) ? d.instances.filter((x) => x && x.addr) : []))
        .catch(() => setLanServers([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyServer = async () => {
    const saved = setServerBase(serverInput);
    setServerInput(saved);
    setError('');
    setCheck(null);
    await probeServer(saved);
  };

  useEffect(() => {
    setError('');
  }, [mode]);

  /* 注册模式下自动检查号码可用性 */
  useEffect(() => {
    if (mode !== 'register') return undefined;
    const n = number.trim();
    if (!/^[1-9]\d{7,10}$/.test(n)) {
      setCheck(null);
      return undefined;
    }
    let alive = true;
    setChecking(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api('/api/number/' + n + '/available');
        if (alive) setCheck({ number: n, available: !!data.available });
      } catch {
        if (alive) setCheck(null);
      } finally {
        if (alive) setChecking(false);
      }
    }, 380);
    return () => {
      alive = false;
      clearTimeout(timer);
      setChecking(false);
    };
  }, [number, mode, serverInfo]);

  const onNumber = (v) => setNumber(v.replace(/\D/g, '').replace(/^0+/, '').slice(0, 11));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'login') {
      const id = identifier.trim();
      if (!id) {
        setError('请输入邮箱');
        return;
      }
      if (!password) {
        setError('请输入密码');
        return;
      }
      setBusy(true);
      try {
        const data = await api('/api/login', { method: 'POST', body: { identifier: id, password } });
        rememberAccount(data.account, data.token);
        onAuthed(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
      return;
    }
    const mail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
      setError('邮箱格式不对');
      return;
    }
    const n = number.trim();
    if (!/^[1-9]\d{7,10}$/.test(n)) {
      setError('号码是 8–11 位数字，不能以 0 开头');
      return;
    }
    if (nickname.trim().length < 1) {
      setError('给自己起个昵称吧');
      return;
    }
    if (password.length < 8) {
      setError('密码至少 8 位');
      return;
    }
    if (password !== password2) {
      setError('两次输入的密码不一样');
      return;
    }
    if (check && check.number === n && !check.available) {
      setError('这个号码已经被用了');
      return;
    }
    setBusy(true);
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: { email: mail, number: n, nickname: nickname.trim(), password },
      });
      rememberAccount(data.account, data.token);
      onAuthed(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const quickLogin = async (item) => {
    try {
      const data = await api('/api/me', { token: item.token });
      onAuthed({ token: item.token, account: data.account });
    } catch {
      forgetAccount(item.number);
      setAccountList(loadAccounts());
      toast('这个登录记录过期了，用密码重新登录一次', 'error');
    }
  };

  return (
    <div className="auth-wrap">
      <section className="auth-hero">
        <div className="auth-orbit" aria-hidden="true">
          <span className="ring ring-1" />
          <span className="ring ring-2" />
          <span className="ring ring-3" />
          <span className="orbit-dot dot-1" />
          <span className="orbit-dot dot-2" />
          <span className="orbit-core" />
        </div>

        <div className="auth-brand">
          <span className="brand-mark">
            <Icon name="chat" size={22} />
          </span>
          <div className="auth-brand-text">
            <strong>Everony</strong>
            <span>Bot 广场 · 网页即开即聊</span>
          </div>
        </div>

        <div className="auth-hero-copy">
          <span className="auth-eyebrow">NapChat聊天社交~</span>
          <h1>
            把聊天
            <br />
            放回<span className="grad-text">你自己的电脑</span>
          </h1>
          <p>一台服务器，一个地址，所有人打开就能聊。角色和 Bot 都摆在广场上。</p>
        </div>

        <ul className="auth-features">
          {FEATURES.map((f) => (
            <li key={f.title}>
              <span className="feature-icon">
                <Icon name={f.icon} size={17} />
              </span>
              <div>
                <strong>{f.title}</strong>
                <span>{f.text}</span>
              </div>
            </li>
          ))}
        </ul>

        <div className="auth-hero-foot">
          <div className="auth-pref">
            <span className="auth-pref-label">主题</span>
            <Segmented small value={theme} options={THEMES} onChange={onTheme} />
          </div>
          <div className="auth-pref">
            <span className="auth-pref-label">字号</span>
            <Segmented small value={font} options={FONTS} onChange={onFont} />
          </div>
        </div>
      </section>

      <main className="auth-main">
        <div className="auth-card glass">
          <header className="auth-card-head">
            <span className="auth-card-eyebrow">NapChat聊天社交~</span>
            <div className="auth-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
                登录
              </button>
              <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
                注册
              </button>
              <span className="auth-tab-glider" data-mode={mode} />
            </div>
            <p className="auth-card-sub">
              {mode === 'login' ? '欢迎回来，用注册时的邮箱继续。' : '邮箱注册，再挑一个 8–11 位号码当公开身份。'}
            </p>
          </header>

          <div className="auth-server">
            <span className="auth-server-label">
              <Icon name="wifi" size={14} />
              服务器
            </span>
            <input
              className="auth-server-input"
              spellCheck={false}
              autoComplete="off"
              placeholder="留空 = 本机；自建服务器填 http://IP:7788"
              value={serverInput}
              onChange={(e) => setServerInput(e.target.value)}
              onBlur={applyServer}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyServer();
                }
              }}
            />
            <button type="button" className="btn btn-ghost btn-sm auth-server-go" onClick={applyServer} disabled={serverBusy}>
              {serverBusy ? <Spinner size={13} /> : '连接'}
            </button>
          </div>
          <p className={'auth-server-note' + (serverInfo && !serverInfo.ok ? ' is-bad' : '')}>
            {serverInfo
              ? serverInfo.ok
                ? '已连上 ' + (serverBase() || '本机') + (serverInfo.version ? ' · 版本 ' + serverInfo.version : '')
                : '连不上 ' + (serverBase() || '本机') + '，检查地址或网络'
              : '正在检查服务器…'}
          </p>

          {!serverBase() && lanServers.length ? (
            <div className="auth-lan">
              <span className="auth-lan-label">
                <Icon name="wifi" size={13} />
                局域网里发现 {lanServers.length} 台服务器，点一下就用手边的
              </span>
              <div className="auth-lan-list">
                {lanServers.slice(0, 3).map((item) => (
                  <button
                    key={item.addr}
                    type="button"
                    className="auth-lan-item"
                    onClick={async () => {
                      setServerInput(item.addr);
                      const saved = setServerBase(item.addr);
                      setServerInput(saved);
                      await probeServer(saved);
                    }}
                  >
                    <b>{item.addr}</b>
                    <span>{item.version || ''}{item.people ? ' · ' + item.people + ' 人' : ''}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <form className="auth-form" onSubmit={submit}>
            {mode === 'login' ? (
              <label className="field">
                <span className="field-label">邮箱</span>
                <div className="input-wrap">
                  <Icon name="mail" size={17} className="input-icon" />
                  <input
                    ref={emailRef}
                    className="input"
                    autoComplete="username"
                    spellCheck={false}
                    placeholder="注册时填的邮箱（老账号也可以直接填号码）"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </div>
              </label>
            ) : (
              <label className="field">
                <span className="field-label">邮箱</span>
                <div className="input-wrap">
                  <Icon name="mail" size={17} className="input-icon" />
                  <input
                    ref={emailRef}
                    className="input"
                    type="email"
                    autoComplete="username"
                    spellCheck={false}
                    placeholder="用来登录，不会公开给别人看"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </label>
            )}

            {mode === 'register' ? (
              <label className="field">
                <span className="field-label">号码 <span className="field-hint">8–11 位，注册后固定不变，别人和 Bot 都靠它认你</span></span>
                <div className={'input-wrap' + (check ? (check.available ? ' ok' : ' bad') : '')}>
                  <Icon name="hash" size={17} className="input-icon" />
                  <input
                    className="input input-number"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="例如 3881756548"
                    value={number}
                    onChange={(e) => onNumber(e.target.value)}
                    maxLength={11}
                  />
                  {number.length >= 8 ? (
                    <span className="input-tail">
                      {checking ? <Spinner size={14} /> : check ? <span className={check.available ? 'ok-text' : 'bad-text'}>{check.available ? '可用' : '已占用'}</span> : null}
                    </span>
                  ) : null}
                </div>
              </label>
            ) : null}

            {mode === 'register' ? (
              <label className="field">
                <span className="field-label">昵称</span>
                <div className="input-wrap">
                  <Icon name="smile" size={17} className="input-icon" />
                  <input className="input" placeholder="别人看到的名字" value={nickname} maxLength={24} onChange={(e) => setNickname(e.target.value)} />
                </div>
              </label>
            ) : null}

            <label className="field">
              <span className="field-label">密码</span>
              <div className="input-wrap">
                <Icon name="lock" size={17} className="input-icon" />
                <input
                  className="input"
                  type="password"
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                  placeholder={mode === 'login' ? '输入密码' : '至少 8 位'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
            </label>

            {mode === 'register' ? (
              <label className="field">
                <span className="field-label">确认密码</span>
                <div className="input-wrap">
                  <Icon name="lock" size={17} className="input-icon" />
                  <input className="input" type="password" autoComplete="new-password" placeholder="再输一次" value={password2} onChange={(e) => setPassword2(e.target.value)} />
                </div>
              </label>
            ) : null}

            {error ? <p className="form-error" role="alert">{error}</p> : null}

            <button type="submit" className="btn btn-primary btn-block btn-lg" disabled={busy}>
              {busy ? <Spinner size={16} /> : <Icon name={mode === 'login' ? 'arrowRight' : 'plus'} size={18} />}
              {mode === 'login' ? '进入 Everony' : '创建我的账号'}
            </button>
          </form>

          {accountList.length ? (
            <div className="auth-saved">
              <div className="auth-saved-head">
                <span>这台电脑上登录过的账号</span>
              </div>
              <div className="auth-saved-list">
                {accountList.map((item) => (
                  <div className="saved-account" key={item.number}>
                    <button type="button" className="saved-main" onClick={() => quickLogin(item)}>
                      <Avatar number={item.number} nickname={item.nickname} size={34} />
                      <span className="saved-text">
                        <strong>{item.nickname || item.number}</strong>
                        <em>{item.number}{item.type === 'bot' ? ' · Bot' : ''}</em>
                      </span>
                      <Icon name="chevron" size={16} className="saved-go" />
                    </button>
                    <button
                      type="button"
                      className="icon-btn saved-del"
                      aria-label="忘记这个账号"
                      onClick={() => {
                        forgetAccount(item.number);
                        setAccountList(loadAccounts());
                      }}
                    >
                      <Icon name="close" size={14} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <footer className="auth-card-foot">
            <span className="dot-sep" />
            <span>所有数据仅保存在此实例</span>
            <span className="dot-sep" />
          </footer>
        </div>
      </main>
    </div>
  );
}
