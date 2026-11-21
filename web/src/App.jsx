import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import PlazaPage from './views/plaza/PlazaPage.jsx';
import Icon from './ui/icons.jsx';
import { Spinner, Toaster, toast } from './ui/primitives.jsx';
import NetBanner from './ui/NetBanner.jsx';
import { TOKEN_KEY, api, loadAccounts, rememberAccount, syncNativeToken } from './lib/api.js';
import './entry.css';

const Auth = lazy(() => import('./views/Auth.jsx'));
const Shell = lazy(() => import('./views/Shell.jsx'));

/* 外观偏好：三套主题、三档字号，全部落在 :root 的 data-* 上 */
const THEME_KEY = 'fe_theme';
const FONT_KEY = 'fe_font';
const LEGACY_THEME = { dark: 'deep', light: 'light', deep: 'deep', violet: 'violet' };
const FONT_SIZES = ['s', 'm', 'l'];

function readTheme() {
  try {
    const raw = localStorage.getItem(THEME_KEY) || localStorage.getItem('fe_theme') || 'deep';
    return LEGACY_THEME[raw] || 'deep';
  } catch {
    return 'deep';
  }
}

function readFont() {
  try {
    const raw = localStorage.getItem(FONT_KEY) || 'm';
    return FONT_SIZES.includes(raw) ? raw : 'm';
  } catch {
    return 'm';
  }
}

/* 仅开发模式：允许 ?token=xxx 直接进入，方便联调；生产构建会被 tree-shake */
const DEV_TOKEN = import.meta.env.DEV ? new URLSearchParams(location.search).get('token') : null;
const IS_DESKTOP = typeof window !== 'undefined' && !!window.feWin;

/* ---------- 自绘标题栏按钮（Electron 无边框窗口用） ---------- */
function WinControls() {
  const w = typeof window !== 'undefined' ? window.feWin : null;
  if (!w) return null;
  return (
    <div className="win-controls">
      <button type="button" className="win-btn" onClick={() => w.minimize()} title="最小化" aria-label="最小化">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="win-btn" onClick={() => w.toggleMax()} title="最大化" aria-label="最大化">
        <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="win-btn win-close" onClick={() => w.close()} title="关闭" aria-label="关闭">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  );
}

function BootSplash({ title = '正在连接', error, onRetry }) {
  return (
    <div className="boot-splash fe-entry-state">
      <span className="brand-mark brand-mark-lg"><Icon name="chat" size={26} /></span>
      <div className="boot-title">Everony</div>
      <div className="boot-sub" role={error ? 'alert' : 'status'}>{error || title}</div>
      {error ? <button type="button" className="btn btn-primary btn-sm" onClick={onRetry}>重试连接</button> : <Spinner size={20} />}
    </div>
  );
}

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  const [font, setFont] = useState(readFont);
  const [token, setToken] = useState(() => {
    try { return DEV_TOKEN || localStorage.getItem(TOKEN_KEY) || null; } catch { return DEV_TOKEN; }
  });
  const [session, setSession] = useState(null);
  const [adding, setAdding] = useState(false);
  /* 未登录时先看广场，点了登录/注册才下载表单界面 */
  const [guestAuth, setGuestAuth] = useState(null);
  const account = session?.token === token ? session.account : null;
  const [accounts, setAccounts] = useState(loadAccounts);

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = theme;
    root.dataset.font = font;
    if (IS_DESKTOP) root.dataset.desktop = '1';
    try {
      localStorage.setItem(THEME_KEY, theme);
      // 兼容旧版本键名，老用户升级后主题不丢
      localStorage.setItem('fe_theme', theme);
      localStorage.setItem(FONT_KEY, font);
    } catch {
      /* 隐私模式下写不进去就算了 */
    }
  }, [theme, font]);

  useEffect(() => {
    if (!token || session?.token === token) return undefined;
    const controller = new AbortController();
    api('/api/me', { token, signal: controller.signal, timeoutMs: 15000 })
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!data?.account) throw new Error('会话信息读取失败，请重试');
        setSession({ token, account: data.account });
        setAccounts(loadAccounts());
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        if (err.status === 401) {
          try { if (localStorage.getItem(TOKEN_KEY) === token) localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
          syncNativeToken('');
          setToken(null);
          setSession(null);
        } else {
          setSession({ token, error: err.message });
        }
      });
    return () => controller.abort();
  }, [token, session]);

  const onAuthed = useCallback((data) => {
    try { localStorage.setItem(TOKEN_KEY, data.token); } catch { /* 忽略 */ }
    setAccounts(loadAccounts());
    setToken(data.token);
    setSession({ token: data.token, account: data.account });
    setGuestAuth(null);
    setAdding(false);
    syncNativeToken(data.token);
  }, []);

  const switchAccount = useCallback(({ token: nextToken, account: nextAccount }) => {
    try { localStorage.setItem(TOKEN_KEY, nextToken); } catch { /* 忽略 */ }
    setToken(nextToken);
    setSession({ token: nextToken, account: nextAccount });
    syncNativeToken(nextToken);
    toast('已切换账号', 'success');
  }, []);

  const onBotSession = useCallback(({ token: nextToken, account: nextAccount }) => {
    try {
      localStorage.setItem(TOKEN_KEY, nextToken);
      rememberAccount(nextAccount, nextToken);
    } catch { /* 忽略 */ }
    setAccounts(loadAccounts());
    setToken(nextToken);
    setSession({ token: nextToken, account: nextAccount });
    syncNativeToken(nextToken);
    toast('已切换为 ' + (nextAccount?.nickname || 'Bot'), 'success');
  }, []);

  const logout = useCallback(async () => {
    try { await api('/api/logout', { method: 'POST', token, timeoutMs: 5000 }); } catch { /* 忽略 */ }
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
    syncNativeToken('');
    setToken(null);
    setSession(null);
    setGuestAuth(null);
  }, [token]);

  const authProps = { theme, onTheme: setTheme, font, onFont: setFont, onAuthed };

  let page;
  if (token && !account) {
    page = <BootSplash error={session?.error} onRetry={() => setSession(null)} />;
  } else if (adding) {
    page = (
      <Suspense fallback={<BootSplash title="正在打开登录" />}>
        <Auth {...authProps} onBack={() => setAdding(false)} backLabel="回到聊天" />
      </Suspense>
    );
  } else if (!token && guestAuth) {
    page = (
      <Suspense fallback={<BootSplash title={guestAuth === 'register' ? '正在打开注册' : '正在打开登录'} />}>
        <Auth {...authProps} initialMode={guestAuth} onBack={() => setGuestAuth(null)} />
      </Suspense>
    );
  } else if (!token) {
    page = <PlazaPage onLogin={() => setGuestAuth('login')} onRegister={() => setGuestAuth('register')} />;
  } else {
    page = (
      <>
        <NetBanner />
        <Suspense fallback={<BootSplash title="正在打开聊天" />}>
          <Shell
            key={token}
            token={token}
            me={account}
            accounts={accounts}
            theme={theme}
            onTheme={setTheme}
            font={font}
            onFont={setFont}
            onSwitchAccount={switchAccount}
            onAddAccount={() => setAdding(true)}
            onLogout={logout}
            onBotSession={onBotSession}
          />
        </Suspense>
      </>
    );
  }
  return (
    <>
      <WinControls />
      {page}
      <Toaster />
    </>
  );
}
