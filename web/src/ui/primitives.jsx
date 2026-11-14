import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { colorFor, statusMeta } from '../lib/format.js';

export const cx = (...args) => args.filter(Boolean).join(' ');

/* ---------- 浮层栈：统一处理 Esc，最上层先关 ---------- */
let overlayDepth = 0;
const escStack = [];
let escInstalled = false;

function ensureEscListener() {
  if (escInstalled || typeof window === 'undefined') return;
  escInstalled = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !escStack.length) return;
      const top = escStack[escStack.length - 1];
      if (top.enabled()) {
        e.preventDefault();
        e.stopPropagation();
        top.close();
      }
    },
    true
  );
}

export function overlayOpen() {
  return overlayDepth > 0;
}

/* 安卓返回键：先关最上层浮层；返回 true 表示这次返回已被页面消费 */
export function installBackHandler() {
  if (typeof window === 'undefined') return;
  window.__feBack = () => {
    if (!escStack.length) return false;
    const top = escStack[escStack.length - 1];
    if (!top.enabled()) return false;
    top.close();
    return true;
  };
}

export function useOverlay(onClose, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  useEffect(() => {
    ensureEscListener();
    overlayDepth += 1;
    const entry = { close: () => closeRef.current(), enabled: () => enabledRef.current };
    escStack.push(entry);
    return () => {
      overlayDepth = Math.max(0, overlayDepth - 1);
      const i = escStack.indexOf(entry);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, []);
}

/* 只在没有浮层打开时才响应 Esc（用于返回/关面板） */
export function useEscape(enabled, onEscape) {
  const cb = useRef(onEscape);
  cb.current = onEscape;
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape' && !overlayOpen()) {
        cb.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/* ---------- 响应式 ---------- */
export function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => (typeof window === 'undefined' ? false : window.matchMedia(query).matches));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

export function useIsMobile() {
  return useMediaQuery('(max-width: 759px)');
}

export function useIsTablet() {
  return useMediaQuery('(max-width: 1079px)');
}

/* ---------- 吐司 ---------- */
const toastSubs = new Set();
let toastSeq = 0;

export function toast(message, type = 'info', duration = 2600) {
  const item = { id: (toastSeq += 1), message, type };
  toastSubs.forEach((fn) => fn(item));
  window.setTimeout(() => {
    toastSubs.forEach((fn) => fn({ id: item.id, remove: true }));
  }, duration);
}

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onItem = (item) => {
      if (item.remove) {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
      } else {
        setItems((prev) => [...prev.slice(-3), item]);
      }
    };
    toastSubs.add(onItem);
    return () => toastSubs.delete(onItem);
  }, []);
  if (!items.length) return null;
  return createPortal(
    <div className="toaster" role="status" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={cx('toast', 'toast-' + item.type)}>
          <Icon name={item.type === 'error' ? 'warning' : item.type === 'success' ? 'check' : 'info'} size={16} />
          <span>{item.message}</span>
        </div>
      ))}
    </div>,
    document.body
  );
}

/* ---------- 头像 / 状态 ---------- */
export function StatusDot({ status, className = '', showLabel }) {
  const meta = statusMeta(status);
  return (
    <span className={cx('status-dot', 'tone-' + meta.tone, className)} title={meta.label}>
      {showLabel ? meta.label : null}
    </span>
  );
}

export function Avatar({ number, nickname, avatar, size = 40, status, className = '', onClick, title, square }) {
  const letter = (nickname || number || '?').slice(0, 1).toUpperCase();
  const bg = colorFor(number || nickname || 'anon');
  const style = { width: size, height: size, fontSize: Math.max(11, Math.round(size * 0.4)) };
  return (
    <span
      className={cx('avatar', square && 'avatar-square', className)}
      style={style}
      onClick={onClick}
      title={title || nickname || number}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      {avatar ? (
        <img src={avatar} alt="" loading="lazy" />
      ) : (
        <span className="avatar-letter" style={{ background: 'linear-gradient(135deg,' + bg + ',' + bg + '88)' }}>
          {letter}
        </span>
      )}
      {status ? <StatusDot status={status} className="avatar-status" /> : null}
    </span>
  );
}

/* ---------- 右键 / 长按菜单 ---------- */
export function ContextMenu({ x, y, items, onClose, title }) {
  const ref = useRef(null);
  const isMobile = useIsMobile();
  const [pos, setPos] = useState(null);
  useOverlay(onClose);

  useLayoutEffect(() => {
    if (isMobile) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 10;
    const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - r.width - pad));
    const top = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - r.height - pad));
    setPos({ left, top });
  }, [x, y, isMobile]);

  useEffect(() => {
    if (!isMobile) return undefined;
    const close = () => onClose();
    return () => close;
  }, [isMobile, onClose]);

  const usable = items.filter(Boolean);
  const body = (
    <div
      className={cx('ctx-layer', isMobile && 'ctx-layer-mobile')}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {isMobile ? <div className="ctx-mask" onPointerDown={onClose} /> : null}
      <div
        ref={ref}
        className={cx('ctx-menu', isMobile && 'ctx-sheet')}
        style={!isMobile && pos ? { left: pos.left + 'px', top: pos.top + 'px' } : undefined}
        role="menu"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {isMobile ? <div className="ctx-grip" /> : null}
        {title ? <div className="ctx-title">{title}</div> : null}
        {usable.map((item, idx) =>
          item.divider ? (
            <div className="ctx-divider" key={'d' + idx} />
          ) : (
            <button
              type="button"
              key={item.label + idx}
              className={cx('ctx-item', item.danger && 'danger', item.disabled && 'disabled')}
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                if (item.disabled) return;
                onClose();
                item.onClick?.();
              }}
            >
              {item.icon ? <Icon name={item.icon} size={18} /> : null}
              <span>{item.label}</span>
              {item.checked ? <Icon name="check" size={16} className="ctx-check" /> : null}
            </button>
          )
        )}
      </div>
    </div>
  );
  return createPortal(body, document.body);
}

/* 长按 = 右键（触摸设备） */
export function useLongPress(onLongPress, delay = 460) {
  const timer = useRef(null);
  const start = useRef({ x: 0, y: 0 });
  const clear = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  useEffect(() => clear, []);
  return {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      start.current = { x: t.clientX, y: t.clientY };
      clear();
      timer.current = setTimeout(() => {
        timer.current = null;
        onLongPress({ x: t.clientX, y: t.clientY });
      }, delay);
    },
    onTouchMove: (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (Math.abs(t.clientX - start.current.x) > 12 || Math.abs(t.clientY - start.current.y) > 12) clear();
    },
    onTouchEnd: clear,
    onTouchCancel: clear,
  };
}

/* ---------- 弹窗 ---------- */
export function Modal({ title, subtitle, icon, children, footer, onClose, width = 480, className = '', headerExtra, closeOnMask = true }) {
  useOverlay(onClose);
  return createPortal(
    <div className="overlay" onPointerDown={(e) => { if (closeOnMask && e.target === e.currentTarget) onClose(); }}>
      <div className={cx('modal', className)} style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title || '对话框'}>
        {title ? (
          <header className="modal-head">
            <div className="modal-head-main">
              {icon ? <span className="modal-icon"><Icon name={icon} size={18} /></span> : null}
              <div>
                <h2>{title}</h2>
                {subtitle ? <p>{subtitle}</p> : null}
              </div>
            </div>
            <div className="modal-head-extra">
              {headerExtra}
              <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            </div>
          </header>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}

export function Drawer({ title, subtitle, onClose, children, footer, width = 420, className = '', icon }) {
  useOverlay(onClose);
  const isMobile = useIsMobile();
  return createPortal(
    <div className="overlay overlay-drawer" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className={cx('drawer', className)} style={!isMobile ? { width } : undefined} role="dialog" aria-modal="true" aria-label={title || '抽屉'}>
        <header className="drawer-head">
          <button type="button" className="icon-btn drawer-back" onClick={onClose} aria-label="返回">
            <Icon name="back" size={20} />
          </button>
          <div className="drawer-title">
            {icon ? <Icon name={icon} size={18} /> : null}
            <div>
              <h2>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body
  );
}

export function Confirm({ title = '确认操作', message, confirmText = '确定', cancelText = '取消', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err.message || '操作失败');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      icon={danger ? 'warning' : 'info'}
      onClose={onClose}
      width={400}
      footer={
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>{cancelText}</button>
          <button type="button" className={cx('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={run} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      }
    >
      {message ? <p className="confirm-text">{message}</p> : null}
      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}

/* ---------- 空状态 / 骨架屏 / 加载 ---------- */
export function Empty({ icon = 'chat', title = '这里空空如也', sub, action, compact, className = '' }) {
  return (
    <div className={cx('empty', compact && 'empty-compact', className)}>
      <div className="empty-icon-wrap">
        <span className="empty-glow" />
        <Icon name={icon} size={compact ? 26 : 34} />
      </div>
      <h3>{title}</h3>
      {sub ? <p>{sub}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

export function Skeleton({ w, h = 12, r = 6, className = '' }) {
  return <span className={cx('sk', className)} style={{ width: w || '100%', height: h, borderRadius: r }} />;
}

export function SkeletonList({ rows = 7, avatar = true }) {
  return (
    <div className="sk-list" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div className="sk-row" key={i}>
          {avatar ? <Skeleton w={44} h={44} r={999} /> : null}
          <div className="sk-lines">
            <Skeleton w={i % 3 === 0 ? '48%' : '36%'} h={12} />
            <Skeleton w={i % 4 === 0 ? '72%' : '58%'} h={10} />
          </div>
        </div>
      ))}
    </div>
  );
}

export function Spinner({ size = 18, className = '' }) {
  return <span className={cx('spinner', className)} style={{ width: size, height: size }} aria-label="加载中" />;
}

export function LoadingBlock({ text = '加载中…' }) {
  return (
    <div className="loading-block">
      <Spinner size={20} />
      <span>{text}</span>
    </div>
  );
}

/* ---------- 开关 / 分段 ---------- */
export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={cx('toggle', checked && 'on')}
      onClick={() => !disabled && onChange(!checked)}
      disabled={disabled}
    >
      <span className="toggle-knob" />
    </button>
  );
}

export function Segmented({ value, options, onChange, className = '', small }) {
  return (
    <div className={cx('segmented', small && 'segmented-sm', className)} role="tablist">
      {options.map((opt) => (
        <button
          type="button"
          key={opt.value}
          role="tab"
          aria-selected={value === opt.value}
          className={cx('seg-btn', value === opt.value && 'active')}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon ? <Icon name={opt.icon} size={15} /> : null}
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs({ tabs, value, onChange, className = '' }) {
  return (
    <div className={cx('tabs', className)} role="tablist">
      {tabs.map((tab) => (
        <button
          type="button"
          key={tab.id}
          role="tab"
          aria-selected={value === tab.id}
          className={cx('tab', value === tab.id && 'active')}
          onClick={() => onChange(tab.id)}
        >
          {tab.icon ? <Icon name={tab.icon} size={16} /> : null}
          <span>{tab.label}</span>
          {tab.badge ? <span className="tab-badge">{tab.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Badge({ count, dot, className = '' }) {
  if (!count && !dot) return null;
  return <span className={cx('badge', dot && 'badge-dot', className)}>{count > 99 ? '99+' : dot ? '' : count}</span>;
}

/* ---------- 滑动返回（手机） ---------- */
export function useSwipeBack(enabled, onBack) {
  const [offset, setOffset] = useState(0);
  const start = useRef(null);
  const cb = useRef(onBack);
  cb.current = onBack;
  const handlers = {
    onTouchStart: (e) => {
      if (!enabled || e.touches.length !== 1) return;
      const t = e.touches[0];
      start.current = t.clientX < 34 ? { x: t.clientX, y: t.clientY, active: true } : null;
    },
    onTouchMove: (e) => {
      if (!start.current || !start.current.active) return;
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = Math.abs(t.clientY - start.current.y);
      if (dy > 60) {
        start.current = null;
        setOffset(0);
        return;
      }
      if (dx > 0) setOffset(Math.min(140, dx));
    },
    onTouchEnd: () => {
      if (!start.current) return;
      const should = offset > 86;
      start.current = null;
      setOffset(0);
      if (should) cb.current();
    },
  };
  return { offset, handlers };
}
