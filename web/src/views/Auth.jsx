import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import { Segmented, Spinner, Avatar, toast } from '../ui/primitives.jsx';
import { api, loadAccounts, rememberAccount, forgetAccount } from '../lib/api.js';

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
  { icon: 'monitor', title: '本地优先', text: '账号和数据都在你自己的电脑里' },
  { icon: 'wifi', title: '实例互联', text: '每个实例都能互相加好友、互相加 Bot' },
  { icon: 'bot', title: 'Bot 与 OneBot', text: '接上 AstrBot，让 Bot 也来聊天' },
  { icon: 'phone', title: '多端可用', text: '桌面窗口，手机浏览器扫码即用' },
];

export default function Auth({ onAuthed, theme, onTheme, font, onFont }) {
  const [mode, setMode] = useState('login');
  const [number, setNumber] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [nickname, setNickname] = useState('');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [accountList, setAccountList] = useState(() => loadAccounts());
  const numberRef = useRef(null);

  useEffect(() => {
    setError('');
  }, [mode]);

  /* 注册模式下自动检查号码可用性 */
  useEffect(() => {
    if (mode !== 'register') return undefined;
    const n = number.trim();
    if (n.length < 5 || n.length > 12) {
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
  }, [number, mode]);

  const onNumber = (v) => setNumber(v.replace(/\D/g, '').slice(0, 12));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    const n = number.trim();
    if (!/^\d{5,12}$/.test(n)) {
      setError('号码是 5–12 位数字');
      return;
    }
    if (mode === 'login') {
      if (!password) {
        setError('请输入密码');
        return;
      }
      setBusy(true);
      try {
        const data = await api('/api/login', { method: 'POST', body: { number: n, password } });
        rememberAccount(data.account, data.token);
        onAuthed(data);
      } catch (err) {
        setError(err.message);
      } finally {
        setBusy(false);
      }
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
        body: { number: n, nickname: nickname.trim(), password },
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
            <strong>Furry Everpony</strong>
            <span>自托管 · 去中心化即时通讯</span>
          </div>
        </div>

        <div className="auth-hero-copy">
          <span className="auth-eyebrow">NapChat聊天社交~</span>
          <h1>
            把聊天
            <br />
            放回<span className="grad-text">你自己的电脑</span>
          </h1>
          <p>一个实例就是一个世界。数据不经过别人的服务器，朋友之间直接互联。</p>
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
              {mode === 'login' ? '欢迎回来，用你的号码继续。' : '选一个 5–12 位号码，这就是你的身份。'}
            </p>
          </header>

          <form className="auth-form" onSubmit={submit}>
            <label className="field">
              <span className="field-label">号码</span>
              <div className={'input-wrap' + (check && mode === 'register' ? (check.available ? ' ok' : ' bad') : '')}>
                <Icon name="hash" size={17} className="input-icon" />
                <input
                  ref={numberRef}
                  className="input input-number"
                  inputMode="numeric"
                  autoComplete="username"
                  placeholder="例如 10001"
                  value={number}
                  onChange={(e) => onNumber(e.target.value)}
                  maxLength={12}
                />
                {mode === 'register' && number.length >= 5 ? (
                  <span className="input-tail">
                    {checking ? <Spinner size={14} /> : check ? <span className={check.available ? 'ok-text' : 'bad-text'}>{check.available ? '可用' : '已占用'}</span> : null}
                  </span>
                ) : null}
              </div>
            </label>

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
              {mode === 'login' ? '进入 Everpony' : '创建我的号码'}
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
