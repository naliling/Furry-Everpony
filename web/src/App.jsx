import { useCallback, useEffect, useState } from 'react';
import Auth from './views/Auth.jsx';
import Shell from './views/Shell.jsx';
import Icon from './ui/icons.jsx';
import { Spinner, Toaster, toast } from './ui/primitives.jsx';
import NetBanner from './ui/NetBanner.jsx';
import { ACCOUNTS_KEY, TOKEN_KEY, api, loadAccounts, rememberAccount, syncNativeToken } from './lib/api.js';

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

function BootSplash() {
  return (
    <div className="boot-splash">
      <span className="brand-mark brand-mark-lg"><Icon name="chat" size={26} /></span>
      <div className="boot-title">Furry Everpony</div>
      <div className="boot-sub">正在连接你的世界</div>
      <Spinner size={20} />
    </div>
  );
}

/* 添加账号时 Auth 是全屏的，给一个回到聊天的浮层按钮 */
function BackToChat({ onClick }) {
  return (
    <button type="button" className="auth-back btn btn-ghost" onClick={onClick}>
      <Icon name="back" size={16} /> 回到聊天
    </button>
  );
}

export default function App() {
  const [theme, setTheme] = useState(readTheme);
  const [font, setFont] = useState(readFont);
  const [token, setToken] = useState(() => DEV_TOKEN || (localStorage.getItem(TOKEN_KEY) || null));
  const [account, setAccount] = useState(null);
  const [ready, setReady] = useState(false);
  const [adding, setAdding] = useState(false);
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
    if (!token) {
      setAccount(null);
      setReady(true);
      return undefined;
    }
    let alive = true;
    setReady(false);
    api('/api/me', { token })
      .then((data) => {
        if (!alive) return;
        setAccount(data.account);
        setAccounts(loadAccounts());
      })
      .catch(() => {
        if (!alive) return;
        try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
        setToken(null);
        setAccount(null);
      })
      .finally(() => { if (alive) setReady(true); });
    return () => { alive = false; };
  }, [token]);

  const onAuthed = useCallback((data) => {
    try {
      localStorage.setItem(TOKEN_KEY, data.token);
      localStorage.setItem(ACCOUNTS_KEY, JSON.stringify(loadAccounts()));
    } catch {
      /* 忽略 */
    }
    setAccounts(loadAccounts());
    setToken(data.token);
    setAccount(data.account);
    setAdding(false);
    syncNativeToken(data.token);
  }, []);

  const switchAccount = useCallback(({ token: nextToken, account: nextAccount }) => {
    try { localStorage.setItem(TOKEN_KEY, nextToken); } catch { /* 忽略 */ }
    setToken(nextToken);
    setAccount(nextAccount);
    syncNativeToken(nextToken);
    toast('已切换账号', 'success');
  }, []);

  const onBotSession = useCallback(({ token: nextToken, account: nextAccount }) => {
    try {
      localStorage.setItem(TOKEN_KEY, nextToken);
      rememberAccount(nextAccount, nextToken);
    } catch {
      /* 忽略 */
    }
    setAccounts(loadAccounts());
    setToken(nextToken);
    setAccount(nextAccount);
    syncNativeToken(nextToken);
    toast('已切换为 ' + (nextAccount?.nickname || 'Bot'), 'success');
  }, []);

  const logout = useCallback(async () => {
    try { await api('/api/logout', { method: 'POST', token }); } catch { /* 忽略 */ }
    try { localStorage.removeItem(TOKEN_KEY); } catch { /* 忽略 */ }
    syncNativeToken('');
    setToken(null);
    setAccount(null);
  }, [token]);

  const authProps = { theme, onTheme: setTheme, font, onFont: setFont, onAuthed };

  if (!ready) {
    return (
      <>
        <WinControls />
        <BootSplash />
      </>
    );
  }

  if (adding) {
    return (
      <>
        <WinControls />
        <Auth {...authProps} />
        <BackToChat onClick={() => setAdding(false)} />
      </>
    );
  }

  if (!token || !account) {
    return (
      <>
        <WinControls />
        <Auth {...authProps} />
        <Toaster />
      </>
    );
  }

  return (
    <>
      <WinControls />
      <NetBanner />
      <Shell
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
      <Toaster />
    </>
  );
}
