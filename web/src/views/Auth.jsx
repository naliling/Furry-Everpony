import { useEffect, useRef, useState } from 'react';
import Icon from '../ui/icons.jsx';
import { Segmented, Spinner, Avatar, toast } from '../ui/primitives.jsx';
import { api, loadAccounts, rememberAccount, forgetAccount } from '../lib/api.js';
import { observeAuthKeyboard, revealAuthField } from '../ui/auth-scroll.js';
import '../auth-layout.css';

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

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const NUMBER = /^[1-9]\d{7,10}$/;
const validSite = (data) => ['none', 'invite', 'email', 'both'].includes(data?.registerGate);
const validCaptcha = (data) => typeof data?.id === 'string' && !!data.id && typeof data.svg === 'string' && !!data.svg;
const AUTH_MODES = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
];
const LOADING_RESOURCE = { data: null, error: '' };

function useRegistrationResource(path, validate, enabled) {
  const [resource, setResource] = useState(LOADING_RESOURCE);
  const [retry, setRetry] = useState(0);
  const reload = () => {
    setResource(LOADING_RESOURCE);
    setRetry((n) => n + 1);
  };

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const run = async () => {
      if (signal.aborted) return;
      try {
        const data = await api(path, { signal, timeoutMs: 10000 });
        if (!validate(data)) throw new Error('服务器没有返回有效内容');
        if (!signal.aborted) setResource({ data, error: '' });
      } catch (err) {
        if (!signal.aborted) setResource({ data: null, error: err.message });
      }
    };
    queueMicrotask(run);
    return () => controller.abort();
  }, [enabled, path, retry, validate]);

  return [resource, reload];
}

function AuthField({ id, label, hint, icon, inputClass = '', state = '', status, action, error, children, ...input }) {
  const describedBy = [hint && id + '-hint', error && id + '-error'].filter(Boolean).join(' ');
  const control = (
    <div className={'input-wrap ' + state}>
      <Icon name={icon} size={17} className="input-icon" />
      <input id={id} className={'input ' + inputClass} aria-invalid={error ? true : undefined} aria-describedby={describedBy || undefined} {...input} />
      {status ? <span className="input-tail" aria-live="polite">{status}</span> : null}
    </div>
  );
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>{label}</label>
      {hint ? <span className="field-hint auth-field-hint" id={id + '-hint'}>{hint}</span> : null}
      {action ? <div className="captcha-row auth-code-row">{control}{action}</div> : control}
      {error ? <p className="auth-field-error" id={id + '-error'} role="alert">{error}</p> : null}
      {children}
    </div>
  );
}

export default function Auth({ onAuthed, theme, onTheme, font, onFont, initialMode = 'login', onBack, backLabel = '回广场逛逛' }) {
  const [mode, setMode] = useState(initialMode === 'register' ? 'register' : 'login');
  const registering = mode === 'register';
  const [identifier, setIdentifier] = useState('');
  const [email, setEmail] = useState('');
  const [number, setNumber] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [registerPassword, setRegisterPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [nickname, setNickname] = useState('');
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState('');
  const [accountList, setAccountList] = useState(() => loadAccounts());
  const [emailCode, setEmailCode] = useState('');
  const [invite, setInvite] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeSent, setCodeSent] = useState(null);
  const [codeError, setCodeError] = useState(null);
  const [clock, setClock] = useState(0);
  const [captchaCode, setCaptchaCode] = useState('');
  const scrollerRef = useRef(null);
  const [siteResource, reloadSite] = useRegistrationResource('/api/site', validSite, registering);
  const [captchaResource, reloadCaptcha] = useRegistrationResource('/api/captcha', validCaptcha, registering);
  const site = siteResource.data;
  const captcha = captchaResource.data;
  const bootstrap = site?.registerBootstrap === true;
  const gate = bootstrap ? 'none' : site?.registerGate;
  const closed = site?.registerMode === 'closed' && !bootstrap;
  const allowEmail = gate === 'email' || gate === 'both';
  const allowInvite = gate === 'invite' || gate === 'both';
  const canSendEmail = !closed && (site?.emailCodeAvailable ?? site?.smtpReady) === true;
  const currentEmail = email.trim().toLowerCase();
  const sentToCurrent = codeSent?.email === currentEmail;
  const currentCodeError = codeError?.email === currentEmail ? codeError : null;
  const nextSendAt = Math.max(sentToCurrent ? codeSent.nextSendAt : 0, currentCodeError?.nextSendAt || 0);
  const cooldown = Math.max(0, Math.ceil((nextSendAt - clock) / 1000));
  const coolingDown = cooldown > 0;
  const currentCheck = check?.number === number ? check : null;

  useEffect(() => observeAuthKeyboard(scrollerRef.current), []);
  useEffect(() => {
    if (!coolingDown) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);

  const refreshCaptcha = () => {
    setCaptchaCode('');
    reloadCaptcha();
  };

  const switchMode = (next) => {
    if (busy || next === mode) return;
    setError(null);
    setNotice('');
    if (next === 'register') {
      reloadSite();
      refreshCaptcha();
    }
    setMode(next);
  };

  const onTabKeyDown = (event) => {
    if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'login' : event.key === 'End' ? 'register' : registering ? 'login' : 'register';
    switchMode(next);
    document.getElementById('auth-tab-' + next)?.focus({ preventScroll: true });
  };

  const fieldError = (id) => error?.field === id ? error.message : undefined;
  const clearFieldError = (id) => {
    if (error?.field === id) setError(null);
  };
  const reportFieldError = (field, message) => {
    setError({ field, message });
    const input = document.getElementById(field);
    if (!input) return;
    input.focus({ preventScroll: true });
    window.requestAnimationFrame(() => revealAuthField(scrollerRef.current, input.closest('.field'), true));
  };

  const sendEmailCode = async () => {
    if (codeBusy || coolingDown || !canSendEmail) return;
    const mail = email.trim();
    if (!EMAIL.test(mail)) {
      reportFieldError('auth-email', '先填一个能收信的邮箱');
      return;
    }
    setCodeBusy(true);
    setCodeError(null);
    clearFieldError('auth-email-code');
    try {
      const data = await api('/api/email-code', { method: 'POST', body: { email: mail }, timeoutMs: 20000 });
      const now = Date.now();
      setClock(now);
      setCodeSent({
        email: currentEmail,
        nextSendAt: now + Math.max(0, Number(data.cooldownSeconds) || 0) * 1000,
        expiresIn: Number(data.expiresIn) || 600,
      });
    } catch (err) {
      const now = Date.now();
      setClock(now);
      setCodeError({ email: currentEmail, message: err.message, nextSendAt: now + Math.max(0, Number(err.retryAfter) || 0) * 1000 });
    } finally {
      setCodeBusy(false);
    }
  };

  /* 号码改变后，旧请求的结果不能盖到新号码上。 */
  useEffect(() => {
    if (!registering || !NUMBER.test(number)) {
      setChecking(false);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setChecking(true);
    const timer = window.setTimeout(async () => {
      try {
        const data = await api('/api/number/' + number + '/available', { signal, timeoutMs: 6000 });
        if (!signal.aborted) setCheck({ number, available: !!data.available });
      } catch {
        if (!signal.aborted) setCheck(null);
      } finally {
        if (!signal.aborted) setChecking(false);
      }
    }, 380);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [number, registering]);

  const submit = async (event) => {
    event.preventDefault();
    if (busy) return;
    setError(null);
    setNotice('');
    if (!registering) {
      const id = identifier.trim();
      if (!id) return reportFieldError('auth-identifier', '请输入号码或邮箱');
      if (!loginPassword) return reportFieldError('auth-password', '请输入密码');
      setBusy(true);
      try {
        const data = await api('/api/login', { method: 'POST', body: { identifier: id, password: loginPassword } });
        rememberAccount(data.account, data.token);
        onAuthed(data);
      } catch (err) {
        setError({ message: err.message });
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!site || closed || !captcha) return;
    const mail = email.trim();
    if (!EMAIL.test(mail)) return reportFieldError('auth-email', '请输入有效的邮箱');
    if (!NUMBER.test(number)) return reportFieldError('auth-number', '号码是 8–11 位数字，不能以 0 开头');
    if (currentCheck && !currentCheck.available) return reportFieldError('auth-number', '这个号码已经被用了');
    if (!nickname.trim()) return reportFieldError('auth-nickname', '给自己起个昵称吧');
    if (registerPassword.length < 8) return reportFieldError('auth-password', '密码至少 8 位');
    if (registerPassword !== password2) return reportFieldError('auth-confirm-password', '两次输入的密码不一样');
    if (captchaCode.length !== 4) return reportFieldError('auth-captcha', '请输入图片里的 4 位验证码');
    const enteredInvite = allowInvite ? invite.trim() : '';
    const enteredCode = allowEmail && emailCode.length === 6 ? emailCode : '';
    if (!enteredCode && !enteredInvite && (allowEmail || allowInvite)) {
      if (allowInvite && (!allowEmail || !canSendEmail)) return reportFieldError('auth-invite', '请输入邀请码');
      return reportFieldError('auth-email-code', allowInvite ? '请输入 6 位邮箱验证码或填写邀请码' : '请输入 6 位邮箱验证码');
    }

    setBusy(true);
    try {
      const data = await api('/api/register', {
        method: 'POST',
        body: {
          email: mail,
          number,
          nickname: nickname.trim(),
          password: registerPassword,
          captchaId: captcha.id,
          captcha: captchaCode,
          ...(enteredCode ? { emailCode: enteredCode } : {}),
          ...(enteredInvite ? { invite: enteredInvite } : {}),
        },
      });
      if (data.pending && !data.token) {
        setNotice(data.message || '注册申请已提交，请等待站长审核。');
        refreshCaptcha();
        return;
      }
      if (!data.token || !data.account) throw new Error('没有收到登录信息，请尝试直接登录');
      rememberAccount(data.account, data.token);
      onAuthed(data);
    } catch (err) {
      setError({ message: err.message });
      // 后端可能已消费一次性图形码，即使最终卡在后面的校验也要换图。
      refreshCaptcha();
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
    <div className="auth-wrap auth-screen" ref={scrollerRef}>
      <div className="auth-scroll-layout">
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
              <div className="auth-card-top">
                <span className="auth-card-eyebrow">
                  <img src="/assets/everony-logo-192.webp" alt="" width={28} height={28} /> Everony
                </span>
                {onBack ? (
                  <button type="button" className="auth-back-plaza auth-back-inline" onClick={onBack}>
                    <Icon name="back" size={15} /> {backLabel}
                  </button>
                ) : null}
              </div>
              <div className="auth-tabs" role="tablist" aria-label="账号访问方式" onKeyDown={onTabKeyDown}>
                {AUTH_MODES.map(({ value, label }) => (
                  <button
                    key={value}
                    type="button"
                    id={'auth-tab-' + value}
                    role="tab"
                    aria-controls="auth-panel"
                    aria-selected={mode === value}
                    tabIndex={mode === value ? 0 : -1}
                    aria-disabled={busy || undefined}
                    className={mode === value ? 'active' : ''}
                    onClick={() => switchMode(value)}
                  >
                    {label}
                  </button>
                ))}
                <span className="auth-tab-glider" data-mode={mode} aria-hidden="true" />
              </div>
              <p className="auth-card-sub">
                {registering ? '用邮箱登录，再挑一个 8–11 位号码作为公开身份。' : '用号码或邮箱登录。Bot 会通过你的号码认出你。'}
              </p>
            </header>

            <div id="auth-panel" role="tabpanel" aria-labelledby={'auth-tab-' + mode}>
              <form key={mode} className="auth-form auth-mode-form" onSubmit={submit} noValidate>
                {registering ? (
                  <>
                    <AuthField
                      id="auth-email"
                      label="邮箱"
                      icon="mail"
                      type="email"
                      autoComplete="email"
                      autoCapitalize="none"
                      spellCheck={false}
                      placeholder="只用于登录，不会公开"
                      value={email}
                      error={fieldError('auth-email')}
                      onChange={(event) => {
                        setEmail(event.target.value);
                        if (event.target.value.trim().toLowerCase() !== currentEmail) {
                          setEmailCode('');
                          setCodeError(null);
                        }
                        clearFieldError('auth-email');
                      }}
                    />
                    <AuthField
                      id="auth-number"
                      label="号码"
                      hint="8–11 位，不以 0 开头，注册后不能改"
                      icon="hash"
                      inputClass="input-number"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="例如 3881756548"
                      value={number}
                      maxLength={11}
                      onChange={(event) => {
                        setNumber(event.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 11));
                        clearFieldError('auth-number');
                      }}
                      state={currentCheck && !checking ? (currentCheck.available ? 'ok' : 'bad') : ''}
                      status={checking ? <Spinner size={14} /> : currentCheck ? <span className={currentCheck.available ? 'ok-text' : 'bad-text'}>{currentCheck.available ? '可用' : '已占用'}</span> : null}
                      error={fieldError('auth-number')}
                    />
                    <AuthField
                      id="auth-nickname"
                      label="昵称"
                      icon="smile"
                      autoComplete="nickname"
                      placeholder="别人看到的名字"
                      value={nickname}
                      maxLength={24}
                      error={fieldError('auth-nickname')}
                      onChange={(event) => { setNickname(event.target.value); clearFieldError('auth-nickname'); }}
                    />
                  </>
                ) : (
                  <AuthField
                    id="auth-identifier"
                    label="号码 / 邮箱"
                    icon="hash"
                    autoComplete="username"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="填号码或注册邮箱"
                    value={identifier}
                    error={fieldError('auth-identifier')}
                    onChange={(event) => { setIdentifier(event.target.value); clearFieldError('auth-identifier'); }}
                  />
                )}
                <AuthField
                  id="auth-password"
                  label="密码"
                  icon="lock"
                  type="password"
                  autoComplete={registering ? 'new-password' : 'current-password'}
                  placeholder={registering ? '至少 8 位' : '输入密码'}
                  value={registering ? registerPassword : loginPassword}
                  error={fieldError('auth-password')}
                  onChange={(event) => {
                    (registering ? setRegisterPassword : setLoginPassword)(event.target.value);
                    clearFieldError('auth-password');
                  }}
                />
                {registering ? (
                  <>
                    <AuthField
                      id="auth-confirm-password"
                      label="确认密码"
                      icon="lock"
                      type="password"
                      autoComplete="new-password"
                      placeholder="再输一次"
                      value={password2}
                      error={fieldError('auth-confirm-password')}
                      onChange={(event) => { setPassword2(event.target.value); clearFieldError('auth-confirm-password'); }}
                    />
                    <AuthField
                      id="auth-captcha"
                      label="图片验证码"
                      hint="看不清时可点图片换一张"
                      icon="shield"
                      autoComplete="off"
                      autoCapitalize="characters"
                      spellCheck={false}
                      maxLength={4}
                      placeholder="图中 4 个字符"
                      value={captchaCode}
                      error={fieldError('auth-captcha')}
                      onChange={(event) => {
                        setCaptchaCode(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
                        clearFieldError('auth-captcha');
                      }}
                      action={(
                        <button
                          type="button"
                          className="captcha-img auth-captcha-button"
                          onClick={refreshCaptcha}
                          aria-label={captcha ? '更换图片验证码' : captchaResource.error ? '重新加载图片验证码' : '正在加载图片验证码'}
                          aria-busy={!captcha && !captchaResource.error}
                          disabled={busy || (!captcha && !captchaResource.error)}
                        >
                          {captcha ? (
                            <img src={'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(captcha.svg)} alt="图片验证码" />
                          ) : captchaResource.error ? (
                            <span>重试</span>
                          ) : (
                            <span className="auth-captcha-progress"><Spinner size={14} /> 加载中</span>
                          )}
                        </button>
                      )}
                    >
                      {captchaResource.error ? <p className="auth-field-error" role="alert">图片验证码未加载：{captchaResource.error}</p> : null}
                    </AuthField>
                    {gate === 'both' ? <p className="auth-gate-note">邮箱验证码或邀请码，填写其中一项即可。</p> : null}
                    {allowEmail && !closed ? (
                      <AuthField
                        id="auth-email-code"
                        label="邮箱验证码"
                        hint="发到你填写的邮箱"
                        icon="mail"
                        autoComplete="one-time-code"
                        spellCheck={false}
                        maxLength={6}
                        inputMode="numeric"
                        placeholder="6 位数字"
                        value={emailCode}
                        error={fieldError('auth-email-code')}
                        onChange={(event) => {
                          setEmailCode(event.target.value.replace(/\D/g, '').slice(0, 6));
                          clearFieldError('auth-email-code');
                        }}
                        action={(
                          <button
                            type="button"
                            className="btn btn-ghost btn-sm auth-email-action"
                            onClick={sendEmailCode}
                            disabled={codeBusy || coolingDown || !canSendEmail}
                            aria-busy={codeBusy}
                          >
                            {codeBusy ? <Spinner size={14} /> : <Icon name="send" size={14} />}
                            {codeBusy ? '发送中' : coolingDown ? cooldown + ' 秒后重发' : sentToCurrent ? '重新发送' : '发送验证码'}
                          </button>
                        )}
                      >
                        {!canSendEmail ? <p className="auth-gate-note">{site.emailCodeUnavailableReason || '暂时无法发送邮件。已有未过期的邮箱验证码仍可使用。'}</p> : null}
                        {currentCodeError ? <p className="auth-field-error" role="alert">{currentCodeError.message}</p> : null}
                        {sentToCurrent && !currentCodeError ? (
                          <p className="field-hint auth-mail-sent" role="status">验证码已发到 {codeSent.email}，{Math.ceil(codeSent.expiresIn / 60)} 分钟内有效。没看到时可检查垃圾邮件。</p>
                        ) : null}
                      </AuthField>
                    ) : null}
                    {allowInvite && !closed ? (
                      <AuthField
                        id="auth-invite"
                        label="邀请码"
                        icon="link"
                        autoComplete="off"
                        autoCapitalize="none"
                        spellCheck={false}
                        maxLength={64}
                        placeholder="填站长给你的邀请码"
                        value={invite}
                        error={fieldError('auth-invite')}
                        onChange={(event) => { setInvite(event.target.value); clearFieldError('auth-invite'); }}
                      />
                    ) : null}
                    {!site && siteResource.error ? (
                      <div className="auth-resource-error">
                        <p className="auth-field-error" role="alert">注册设置未加载：{siteResource.error}</p>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={reloadSite}>重试</button>
                      </div>
                    ) : !site ? (
                      <p className="auth-gate-note" role="status">正在读取注册设置，你可以先填写表单。</p>
                    ) : closed ? (
                      <p className="form-error" role="status">本站已关闭注册。</p>
                    ) : null}
                  </>
                ) : null}

                {notice ? <p className="form-ok" role="status">{notice}</p> : null}
                {error && !error.field ? <p className="form-error" role="alert">{error.message}</p> : null}
                <button
                  type="submit"
                  className="btn btn-primary btn-block btn-lg auth-submit"
                  disabled={busy || (registering && (!site || closed || !captcha))}
                  aria-busy={busy}
                >
                  {busy ? <Spinner size={16} /> : <Icon name={registering ? 'plus' : 'arrowRight'} size={18} />}
                  {busy ? (registering ? '正在创建…' : '正在登录…') : registering ? '创建我的账号' : '进入 Everony'}
                </button>
              </form>
            </div>

            {accountList.length ? (
              <div className="auth-saved">
                <div className="auth-saved-head">
                  <span>这台设备上登录过的账号</span>
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
    </div>
  );
}
