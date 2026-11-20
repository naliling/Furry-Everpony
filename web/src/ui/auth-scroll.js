/* 浏览器保留原生滚动；这里只在软键盘缩小可见区域时补足滚动空间。 */
export function revealAuthField(scroller, field, smooth = false) {
  if (!scroller || !field) return;
  const area = scroller.getBoundingClientRect();
  const bounds = field.getBoundingClientRect();
  const gap = 12;
  const above = bounds.top - (area.top + gap);
  const below = bounds.bottom - (area.bottom - gap);
  const delta = above < 0 ? above : below > 0 ? below : 0;
  if (delta) {
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollBy({ top: delta, behavior: smooth && !reduce ? 'smooth' : 'instant' });
  }
}

export function observeAuthKeyboard(scroller) {
  const viewport = window.visualViewport;
  if (!scroller || !viewport) return undefined;

  let frame = 0;
  let height = 0;
  let top = 0;
  let lastField = null;
  const reset = () => {
    if (height) {
      scroller.style.removeProperty('--auth-visible-height');
      scroller.style.removeProperty('--auth-visible-top');
    }
    height = 0;
    top = 0;
    lastField = null;
  };
  const update = () => {
    frame = 0;
    const active = document.activeElement;
    const field = active?.tagName === 'INPUT' && scroller.contains(active) ? active : null;
    const nextHeight = Math.round(viewport.height);
    // 排除缩放以及地址栏轻微伸缩；键盘收起时自动恢复 CSS 的动态视口。
    if (Math.abs(viewport.scale - 1) > 0.01 || window.innerHeight - nextHeight < 70 || (!field && !height)) {
      reset();
      return;
    }
    const nextTop = Math.max(0, Math.round(viewport.pageTop));
    const resized = height !== nextHeight || top !== nextTop;
    if (resized) {
      height = nextHeight;
      top = nextTop;
      scroller.style.setProperty('--auth-visible-height', height + 'px');
      scroller.style.setProperty('--auth-visible-top', top + 'px');
    }
    // 不监听用户滚动；只在键盘尺寸或焦点变化时露出确实被挡住的字段。
    if (field && (resized || field !== lastField)) revealAuthField(scroller, field);
    lastField = field;
  };
  const schedule = () => {
    if (!frame) frame = window.requestAnimationFrame(update);
  };
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  scroller.addEventListener('focusin', schedule);
  scroller.addEventListener('focusout', schedule);
  schedule();
  return () => {
    window.cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    scroller.removeEventListener('focusin', schedule);
    scroller.removeEventListener('focusout', schedule);
    reset();
  };
}
