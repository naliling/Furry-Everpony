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
  /* 注册成功但要等审核时的提示（此时还没有 token，不能直接进主界面） */
  const [notice, setNotice] = useState('');
  const [accountList, setAccountList] = useState(() => loadAccounts());
  /* 站点门禁：注册要不要邀请码 / 邮箱验证码，由站长在后台配 */
  const [site, setSite] = useState(null);
  const [emailCode, setEmailCode] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeSent, setCodeSent] = useState('');
  /* 注册验证码：后端生成 SVG，前端只负责显示、刷新与提交 */
  const [captcha, setCaptcha] = useState(null);
  const [captchaCode, setCaptchaCode] = useState('');
  const [captchaBusy, setCaptchaBusy] = useState(false);
  const emailRef = useRef(null);

  const loadCaptcha = async () => {
    setCaptchaBusy(true);
    try {
      const data = await api('/api/captcha');
      setCaptcha({ id: data.id, svg: data.svg });
      setCaptchaCode('');
    } catch {
      setCaptcha(null);
    } finally {
      setCaptchaBusy(false);
    }
  };

  useEffect(() => {
    loadCaptcha();
    api('/api/site').then(setSite).catch(() => setSite(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const gate = site && site.registerGate ? site.registerGate : 'email';
  const needEmailCode = gate === 'email' || gate === 'both';
  const canEmailCode = !!(site && site.smtpReady);

  const sendEmailCode = async () => {
    const mail = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) { setError('先填一个能收信的邮箱'); return; }
    setCodeBusy(true);
    setError('');
    try {
      await api('/api/email-code', { method: 'POST', body: { email: mail } });
      setCodeSent(mail);
      toast('验证码已发出，10 分钟内有效', 'success');
    } catch (err) {
      setError(err.message);
    } finally {
      setCodeBusy(false);
    }
  };

  useEffect(() => {
    setError('');
    setNotice('');
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
  }, [number, mode]);

  const onNumber = (v) => setNumber(v.replace(/\D/g, '').replace(/^0+/, '').slice(0, 11));

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (mode === 'login') {
      const id = identifier.trim();
      if (!id) {
        setError('请输入号码或邮箱');
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
    if (!captcha || !captchaCode.trim()) {
      setError('请输入图片里的验证码');
      return;
    }
    if (needEmailCode && !emailCode.trim()) {
      setError(canEmailCode ? '先填邮箱验证码' : '本站发信服务还没配好，联系站长');
      return;
    }
    setBusy(true);
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: {
          email: mail,
          number: n,
          nickname: nickname.trim(),
          password,
          captchaId: captcha.id,
          captcha: captchaCode.trim(),
          ...(emailCode.trim() ? { emailCode: emailCode.trim() } : {}),
        },
      });
      rememberAccount(data.account, data.token);
      onAuthed(data);
    } catch (err) {
      setError(err.message);
      if (/验证码/.test(err.message || '')) loadCaptcha();
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
        {/* 左侧：放大的小马 logo + 站点介绍，打开就看到 */}
        <div className="auth-logo-stage" aria-hidden="true">
          <span className="auth-logo-halo" />
          <img className="auth-logo-img" src="/assets/everony-logo.webp" alt="" />
        </div>

        <div className="auth-brand">
          <img className="auth-brand-logo" src="/assets/everony-logo-192.webp" alt="" />
          <div className="auth-brand-text">
            <strong>Everony</strong>
            <span>小马聊天 · 网页即开即聊</span>
          </div>
        </div>

        <div className="auth-hero-copy">
          <span className="auth-eyebrow">Everony · 小马与聊天</span>
          <h1>
            和喜欢的小马
            <br />
            <span className="grad-text">随时聊聊天</span>
          </h1>
          <p>一台服务器，一个地址，所有人打开就能聊。角色和 Bot 都摆在广场上，聊过的内容按号码替你记着。</p>
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
            <span className="auth-card-eyebrow">Everony · 登录 / 注册</span>
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
              {mode === 'login'
                ? '填号码或邮箱进来。号码可以填你常用的号，Bot 就能在这里认出你。'
                : site === false
                  ? '这个站暂时读不到注册配置，联系站长。'
                  : '填邮箱收验证码，再挑一个 8–11 位号码当公开身份。'} 
            </p>
          </header>

          <form className="auth-form" onSubmit={submit}>
            {mode === 'login' ? (
              <label className="field">
                <span className="field-label">号码 / 邮箱</span>
                <div className="input-wrap">
                  <Icon name="hash" size={17} className="input-icon" />
                  <input
                    ref={emailRef}
                    className="input"
                    autoComplete="username"
                    spellCheck={false}
                    placeholder="填你的号码（或注册邮箱）"
                    value={identifier}
                    onChange={(e) => setIdentifier(e.target.value)}
                  />
                </div>
                <span className="field-hint">号码可以填你常用的号，Bot 就能在这里认出你。</span>
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

            {mode === 'register' ? (
              <label className="field">
                <span className="field-label">
                  验证码 <span className="field-hint">防止机器人批量注册</span>
                </span>
                <div className="captcha-row">
                  <div className="input-wrap">
                    <Icon name="shield" size={17} className="input-icon" />
                    <input
                      className="input"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={6}
                      placeholder="输入右边 4 个字符"
                      value={captchaCode}
                      onChange={(e) => setCaptchaCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
                    />
                  </div>
                  <button type="button" className="captcha-img" onClick={loadCaptcha} title="看不清？点一下换一张" disabled={captchaBusy}>
                    {captcha ? (
                      <img src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(captcha.svg)} alt="验证码" />
                    ) : (
                      <Spinner size={16} />
                    )}
                  </button>
                </div>
              </label>
            ) : null}

            {mode === 'register' && needEmailCode && canEmailCode ? (
              <label className="field">
                <span className="field-label">邮箱验证码 <span className="field-hint">发到这个邮箱，10 分钟内有效</span></span>
                <div className="captcha-row">
                  <div className="input-wrap">
                    <Icon name="mail" size={17} className="input-icon" />
                    <input
                      className="input"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={6}
                      inputMode="numeric"
                      placeholder="6 位数字"
                      value={emailCode}
                      onChange={(e) => setEmailCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    />
                  </div>
                  <button type="button" className="btn btn-ghost btn-sm" onClick={sendEmailCode} disabled={codeBusy}>
                    {codeBusy ? <Spinner size={14} /> : <Icon name="send" size={14} />} {codeSent ? '重新发' : '发验证码'}
                  </button>
                </div>
                {codeSent ? <span className="field-hint">已经发到 {codeSent}，去邮箱里翻一下（也在垃圾箱看看）。</span> : null}
              </label>
            ) : null}

            {notice ? <p className="form-ok" role="status">{notice}</p> : null}
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
