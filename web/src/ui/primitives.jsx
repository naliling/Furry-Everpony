import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { colorFor, statusMeta } from '../lib/format.js';

export const cx = (...args) => args.filter(Boolean).join(' ');

/* ---------- 浮层栈：统一处理 Esc，最上层先关 ---------- */
const escStack = [];
let escInstalled = false;

function ensureEscListener() {
  if (escInstalled || typeof window === 'undefined') return;
  escInstalled = true;
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key !== 'Escape' || !escStack.length) return;
      e.preventDefault();
      e.stopPropagation();
      escStack[escStack.length - 1]();
    },
    true
  );
}

export function overlayOpen() {
  return escStack.length > 0;
}

/* 安卓返回键：先关最上层浮层；返回 true 表示这次返回已被页面消费 */
export function installBackHandler() {
  if (typeof window === 'undefined') return;
  window.__feBack = () => {
    if (!escStack.length) return false;
    escStack[escStack.length - 1]();
    return true;
  };
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const motionPreference = () => window.matchMedia?.(REDUCED_MOTION);
export const prefersReducedMotion = () => Boolean(motionPreference()?.matches);

function timeInMs(value) {
  // 透明度是公共层的首项过渡，计算后样式已经解析 CSS 变量。
  const first = value.split(',')[0].trim();
  return (parseFloat(first) || 0) * (first.endsWith('ms') ? 1 : 1000);
}

export function useOpacityExit(layerRef, exiting, onFinish) {
  const finishRef = useRef(onFinish);
  finishRef.current = onFinish;
  useLayoutEffect(() => {
    if (!exiting) return;
    const layer = layerRef.current;
    const preference = motionPreference();
    if (!layer || preference?.matches) { finishRef.current(); return; }
    const style = getComputedStyle(layer);
    const duration = timeInMs(style.transitionDuration);
    if (!duration || Number(style.opacity) === 0) { finishRef.current(); return; }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      finishRef.current();
    };
    const onEnd = (event) => {
      if (event.target === layer && event.propertyName === 'opacity' && Number(getComputedStyle(layer).opacity) === 0) finish();
    };
    const onPreference = (event) => { if (event.matches) finish(); };
    layer.addEventListener('transitionend', onEnd);
    preference?.addEventListener?.('change', onPreference);
    // 只为浏览器中断或丢失 transitionend 的情况兜底，不作为正常的关闭时机。
    const fallback = window.setTimeout(finish, duration + timeInMs(style.transitionDelay) + 80);
    return () => {
      window.clearTimeout(fallback);
      layer.removeEventListener('transitionend', onEnd);
      preference?.removeEventListener?.('change', onPreference);
    };
  }, [exiting, layerRef]);
}

/* 弹层与短反馈共用可反向的透明度过渡，过渡结束才卸载。 */
export function useOverlayClose(onClose) {
  const [closing, setClosing] = useState(false);
  const layerRef = useRef(null);
  const phase = useRef('open');
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const finish = useCallback(() => {
    if (phase.current === 'closed') return;
    phase.current = 'closed';
    closeRef.current?.();
  }, []);

  const beginClose = useCallback(() => {
    if (phase.current !== 'open') return;
    const layer = layerRef.current;
    if (!layer || prefersReducedMotion() || Number(getComputedStyle(layer).opacity) === 0) {
      finish();
      return;
    }
    phase.current = 'closing';
    setClosing(true);
  }, [finish]);

  useLayoutEffect(() => {
    const layer = layerRef.current;
    if (!layer || prefersReducedMotion()) return;
    // 进场前建立起始样式，兼容不支持 @starting-style 的浏览器。默认样式仍可见。
    layer.classList.add('is-entering');
    getComputedStyle(layer).opacity;
    layer.classList.remove('is-entering');
  }, []);
  useOpacityExit(layerRef, closing, finish);

  return { closing, beginClose, layerRef };
}
export function useOverlay(onClose, enabled = true) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!enabled) return;
    ensureEscListener();
    const close = () => closeRef.current();
    escStack.push(close);
    return () => {
      const i = escStack.indexOf(close);
      if (i >= 0) escStack.splice(i, 1);
    };
  }, [enabled]);
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

function ToastItem({ item, onRemove }) {
  const { closing, beginClose, layerRef } = useOverlayClose(onRemove);
  useEffect(() => {
    if (item.expired) beginClose();
  }, [item.expired, beginClose]);
  return (
    <div ref={layerRef} className={cx('toast', 'motion-layer', 'toast-' + item.type, closing && 'is-closing')} aria-hidden={closing || undefined}>
      <Icon name={item.type === 'error' ? 'warning' : item.type === 'success' ? 'check' : 'info'} size={16} />
      <span>{item.message}</span>
    </div>
  );
}

export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const onItem = (item) => {
      if (item.remove) {
        setItems((prev) => prev.map((x) => x.id === item.id ? { ...x, expired: true } : x));
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
        <ToastItem key={item.id} item={item} onRemove={() => setItems((prev) => prev.filter((x) => x.id !== item.id))} />
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
  const { closing, beginClose, layerRef } = useOverlayClose(onClose);
  useOverlay(beginClose);

  useLayoutEffect(() => {
    if (isMobile) return;
    const el = ref.current;
    if (!el) return;
    const pad = 10;
    // 用布局尺寸，不把进场缩放算进菜单定位。
    const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - el.offsetWidth - pad));
    const top = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - el.offsetHeight - pad));
    setPos({ left, top });
  }, [x, y, isMobile]);

  const usable = items.filter(Boolean);
  const body = (
    <div
      ref={layerRef}
      className={cx('ctx-layer', 'motion-layer', isMobile && 'ctx-layer-mobile', closing && 'is-closing')}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => { if (e.target === e.currentTarget) beginClose(); }}
    >
      {isMobile ? <div className="ctx-mask" onPointerDown={beginClose} /> : null}
      <div
        ref={ref}
        className={cx('ctx-menu', 'motion-surface', isMobile && 'ctx-sheet')}
        inert={closing}
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
                beginClose();
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
const OverlayDismissContext = createContext(null);

export function OverlayDismissButton({ onClick, type = 'button', ...props }) {
  const dismiss = useContext(OverlayDismissContext);
  return <button {...props} type={type} onClick={(event) => {
    onClick?.(event);
    if (!event.defaultPrevented) dismiss?.();
  }} />;
}

export function Modal({ title, subtitle, icon, children, footer, onClose, width = 480, className = '', headerExtra, closeOnMask = true, dismissible = true }) {
  const { closing, beginClose, layerRef } = useOverlayClose(onClose);
  const dismiss = useCallback(() => { if (dismissible) beginClose(); }, [beginClose, dismissible]);
  useOverlay(dismiss);
  const layer = createPortal(
    <div ref={layerRef} className={cx('overlay', 'motion-layer', closing && 'is-closing')} onPointerDown={(e) => { if (closeOnMask && e.target === e.currentTarget) dismiss(); }}>
      <div className={cx('modal', 'motion-surface', className)} style={{ maxWidth: width }} role="dialog" aria-modal="true" aria-label={title || '对话框'} inert={closing}>
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
              <button type="button" className="icon-btn" onClick={dismiss} disabled={!dismissible} aria-label="关闭">
                <Icon name="close" size={18} />
              </button>
            </div>
          </header>
        ) : null}
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{typeof footer === 'function' ? footer(beginClose) : footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
  return <OverlayDismissContext.Provider value={dismiss}>{layer}</OverlayDismissContext.Provider>;
}

export function Drawer({ title, subtitle, onClose, children, footer, width = 420, className = '', icon }) {
  const { closing, beginClose, layerRef } = useOverlayClose(onClose);
  useOverlay(beginClose);
  const isMobile = useIsMobile();
  const layer = createPortal(
    <div ref={layerRef} className={cx('overlay', 'overlay-drawer', 'motion-layer', closing && 'is-closing')} onPointerDown={(e) => { if (e.target === e.currentTarget) beginClose(); }}>
      <aside className={cx('drawer', 'motion-surface', className)} style={!isMobile ? { width } : undefined} role="dialog" aria-modal="true" aria-label={title || '抽屉'} inert={closing}>
        <header className="drawer-head">
          <button type="button" className="icon-btn drawer-back" onClick={beginClose} aria-label="返回">
            <Icon name="back" size={20} />
          </button>
          <div className="drawer-title">
            {icon ? <Icon name={icon} size={18} /> : null}
            <div>
              <h2>{title}</h2>
              {subtitle ? <p>{subtitle}</p> : null}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={beginClose} aria-label="关闭">
            <Icon name="close" size={18} />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer ? <footer className="drawer-foot">{footer}</footer> : null}
      </aside>
    </div>,
    document.body
  );
  return <OverlayDismissContext.Provider value={beginClose}>{layer}</OverlayDismissContext.Provider>;
}

export function Confirm({ title = '确认操作', message, confirmText = '确定', cancelText = '取消', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (dismiss) => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
      dismiss();
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
      dismissible={!busy}
      footer={(dismiss) => (
        <>
          <OverlayDismissButton className="btn btn-ghost" disabled={busy}>{cancelText}</OverlayDismissButton>
          <button type="button" className={cx('btn', danger ? 'btn-danger' : 'btn-primary')} onClick={() => run(dismiss)} disabled={busy}>
            {busy ? '处理中…' : confirmText}
          </button>
        </>
      )}
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
  const distance = useRef(0);
  const reset = () => {
    start.current = null;
    distance.current = 0;
    setOffset(0);
  };
  useEffect(() => { if (!enabled) reset(); }, [enabled]);
  const handlers = {
    onTouchStart: (e) => {
      reset();
      if (!enabled || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (t.clientX < 34) start.current = { x: t.clientX, y: t.clientY };
    },
    onTouchMove: (e) => {
      if (!start.current) return;
      if (e.touches.length !== 1) { reset(); return; }
      const t = e.touches[0];
      const dx = t.clientX - start.current.x;
      const dy = Math.abs(t.clientY - start.current.y);
      // 纵向为主时让原生列表滚动，不搬动整个聊天列。
      if (dy > 12 && dy >= dx) { reset(); return; }
      distance.current = dx > 8 && dx > dy * 1.4 ? Math.min(140, dx) : 0;
      setOffset(distance.current);
    },
    onTouchEnd: () => {
      const shouldReturn = start.current && distance.current > 86;
      reset();
      if (shouldReturn) onBack();
    },
    onTouchCancel: reset,
  };
  return { offset, handlers };
}
