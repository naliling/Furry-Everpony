import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Icon from './icons.jsx';
import { useOverlay } from './primitives.jsx';

const clampScale = (v) => Math.min(6, Math.max(0.5, v));

export default function ImageViewer({ items = [], index = 0, onIndex, onClose }) {
  const [scale, setScale] = useState(0.85);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const stageRef = useRef(null);
  const gesture = useRef(null);
  const session = useRef(0);
  useOverlay(onClose);

  const item = items[index] || null;
  const current = session.current;

  const reset = () => {
    session.current += 1;
    setScale(0.85);
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
      // 普通滚轮留给浏览器滚动长图（之前无条件 preventDefault，长图只能看第一屏、滚不动）
      if (!e.ctrlKey) return;
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
    if (scale <= 1) {
      gesture.current = { mode: 'swipe', sx: e.clientX, sy: e.clientY };
      return;
    }
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
    if (!g || g.mode !== 'swipe') return;
    const dx = e.clientX - g.sx;
    const dy = e.clientY - g.sy;
    // 只把「横向为主」的滑动当翻页，纵向留给原生滚动看长图
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      changeIndex(dx > 0 ? index - 1 : index + 1);
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
          if (scale !== 0.85) reset();
          else setScale(1.8);
        }}
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
    </div>,
    document.body
  );
}
