import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { useOverlay } from './primitives.jsx';

const clampScale = (v) => Math.min(6, Math.max(1, v));

export default function ImageViewer({ items = [], index = 0, onIndex, onClose }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stageRef = useRef(null);
  const gesture = useRef(null);
  const session = useRef(0);
  useOverlay(onClose);

  const item = items[index] || null;
  const current = session.current;

  const reset = () => {
    session.current += 1;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const changeIndex = (next) => {
    if (!items.length) return;
    const wrapped = (next + items.length) % items.length;
    reset();
    onIndex?.(wrapped);
  };

  useEffect(() => {
    reset();
  }, [index]);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left - rect.width / 2;
      const my = e.clientY - rect.top - rect.height / 2;
      setScale((prev) => {
        const next = clampScale(prev * (1 - e.deltaY * 0.0016));
        const ratio = next / prev;
        setOffset((off) => ({
          x: mx - (mx - off.x) * ratio,
          y: my - (my - off.y) * ratio,
        }));
        return next;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        changeIndex(index - 1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        changeIndex(index + 1);
      } else if (e.key === '0') {
        reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    gesture.current = { mode: 'drag', sx: e.clientX, sy: e.clientY, ox: offset.x, oy: offset.y };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'drag') {
      if (scale > 1) {
        setOffset({ x: g.ox + (e.clientX - g.sx), y: g.oy + (e.clientY - g.sy) });
      }
    }
  };

  const onPointerUp = (e) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || scale > 1) return;
    const dx = e.clientX - g.sx;
    if (Math.abs(dx) > 60 && Math.abs(e.clientY - g.sy) < 80) {
      changeIndex(dx > 0 ? index - 1 : index + 1);
    }
  };

  const onTouchStart = (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      gesture.current = {
        mode: 'pinch',
        dist: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
        scale,
      };
    } else if (e.touches.length === 1 && scale === 1) {
      gesture.current = { mode: 'swipe', sx: e.touches[0].clientX, sy: e.touches[0].clientY };
    }
  };

  const onTouchMove = (e) => {
    const g = gesture.current;
    if (!g) return;
    if (g.mode === 'pinch' && e.touches.length === 2) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      setScale(clampScale((g.scale * dist) / Math.max(1, g.dist)));
    }
  };

  const onTouchEnd = (e) => {
    const g = gesture.current;
    gesture.current = null;
    if (g && g.mode === 'swipe' && e.changedTouches.length) {
      const t = e.changedTouches[0];
      const dx = t.clientX - g.sx;
      if (Math.abs(dx) > 60 && Math.abs(t.clientY - g.sy) < 90) changeIndex(dx > 0 ? index - 1 : index + 1);
    }
  };

  const download = async () => {
    if (!item) return;
    try {
      const res = await fetch(item.url);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = item.name || 'image-' + Date.now() + '.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch {
      window.open(item.url, '_blank', 'noopener');
    }
  };

  if (!item) return null;

  return createPortal(
    <div className="imgviewer" role="dialog" aria-modal="true" aria-label="图片查看器">
      <div className="imgviewer-top">
        <span className="imgviewer-count">
          {index + 1} / {items.length}
        </span>
        <div className="imgviewer-actions">
          <button type="button" className="icon-btn" aria-label="缩小" onClick={() => setScale((s) => clampScale(s / 1.4))}>
            <Icon name="search" size={18} />
            <span className="imgviewer-minus">−</span>
          </button>
          <button type="button" className="icon-btn" aria-label="放大" onClick={() => setScale((s) => clampScale(s * 1.4))}>
            <Icon name="plus" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="原始大小" onClick={reset}>
            <Icon name="refresh" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="下载" onClick={download}>
            <Icon name="download" size={18} />
          </button>
          <button type="button" className="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={20} />
          </button>
        </div>
      </div>

      <div
        ref={stageRef}
        className="imgviewer-stage"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          gesture.current = null;
        }}
        onDoubleClick={() => {
          if (scale > 1) reset();
          else setScale(2.4);
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <img
          key={index}
          src={item.url}
          alt={item.name || '图片'}
          draggable={false}
          style={{
            transform: 'translate(' + offset.x + 'px,' + offset.y + 'px) scale(' + scale + ')',
            transition: gesture.current ? 'none' : 'transform 160ms cubic-bezier(.2,.8,.2,1)',
            cursor: scale > 1 ? 'grab' : 'zoom-in',
          }}
        />
      </div>

      {items.length > 1 ? (
        <>
          <button type="button" className="imgviewer-nav prev" aria-label="上一张" onClick={() => changeIndex(index - 1)}>
            <Icon name="back" size={22} />
          </button>
          <button type="button" className="imgviewer-nav next" aria-label="下一张" onClick={() => changeIndex(index + 1)}>
            <Icon name="chevron" size={22} />
          </button>
        </>
      ) : null}
      <div className="imgviewer-hint">滚轮缩放 · 拖拽移动 · 左右键切换</div>
    </div>,
    document.body
  );
}
