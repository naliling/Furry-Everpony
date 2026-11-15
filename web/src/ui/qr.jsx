import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import jsQR from 'jsqr';

/**
 * 二维码（纯 SVG，不依赖 canvas 与图片，缩放不糊）。
 * text 为空时渲染占位方块，避免布局跳动。
 */
export function QrCode({ text, size = 168, className = '' }) {
  const matrix = useMemoMatrix(text);
  if (!matrix) {
    return <div className={'qr-box qr-empty ' + className} style={{ width: size, height: size }} aria-label="二维码" />;
  }
  const quiet = 4;
  const total = matrix.count + quiet * 2;
  const cells = [];
  for (let r = 0; r < matrix.count; r++) {
    for (let c = 0; c < matrix.count; c++) {
      if (!matrix.isDark(r, c)) continue;
      cells.push(<rect key={r + '_' + c} x={c + quiet} y={r + quiet} width={1} height={1} />);
    }
  }
  return (
    <div className={'qr-box ' + className} style={{ width: size, height: size }}>
      <svg viewBox={'0 0 ' + total + ' ' + total} width="100%" height="100%" shapeRendering="crispEdges" role="img" aria-label="二维码">
        <rect width={total} height={total} fill="#fff" />
        <g fill="#0b0f17">{cells}</g>
      </svg>
    </div>
  );
}

function useMemoMatrix(text) {
  const [matrix, setMatrix] = useState(null);
  useEffect(() => {
    const value = String(text || '').trim();
    if (!value) {
      setMatrix(null);
      return;
    }
    try {
      const qr = qrcode(0, 'M');
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      setMatrix({ count, isDark: (r, c) => qr.isDark(r, c) });
    } catch {
      setMatrix(null);
    }
  }, [text]);
  return matrix;
}

/** 从图片元素/位图里解一个二维码，失败返回 '' */
function decodeImage(source, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, width, height);
  const data = ctx.getImageData(0, 0, width, height);
  const found = jsQR(data.data, data.width, data.height, { inversionAttempts: 'attemptBoth' });
  return found && found.data ? found.data : '';
}

/**
 * 扫一扫：摄像头实时识别，识别不到也能从相册/截图里选一张图。
 * onResult(text) 拿到文本后由调用方决定怎么用；onClose() 关掉浮层。
 */
export function QrScanner({ onResult, onClose, title = '扫一扫' }) {
  const videoRef = useRef(null);
  const fileRef = useRef(null);
  const rafRef = useRef(0);
  const streamRef = useRef(null);
  const doneRef = useRef(false);
  const [err, setErr] = useState('');
  const [hint, setHint] = useState('把二维码放进取景框里，识别到就会自动填入');

  const stop = useCallback(() => {
    doneRef.current = true;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
  }, []);

  const finish = useCallback(
    (text) => {
      if (doneRef.current) return;
      const value = String(text || '').trim();
      if (!value) return;
      stop();
      onResult?.(value);
    },
    [onResult, stop],
  );

  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      if (cancelled || doneRef.current) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && video.videoWidth > 0) {
        try {
          const value = decodeImage(video, video.videoWidth, video.videoHeight);
          if (value) {
            finish(value);
            return;
          }
        } catch {
          /* 单帧解码失败继续下一帧 */
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setErr('这个环境不支持摄像头，可以从相册/截图选一张二维码图片');
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          await video.play().catch(() => {});
        }
        setErr('');
        rafRef.current = requestAnimationFrame(tick);
      } catch (e) {
        const name = e && e.name ? e.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setErr('没有摄像头权限：请在系统/浏览器里允许相机，或从相册选一张二维码图片');
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setErr('没找到可用的摄像头，可以从相册/截图选一张二维码图片');
        } else {
          setErr('摄像头打不开（' + (name || '未知原因') + '），可以从相册/截图选一张二维码图片');
        }
      }
    })();

    return () => {
      cancelled = true;
      stop();
    };
  }, [finish, stop]);

  const onPick = async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    setHint('正在识别图片…');
    try {
      const bitmap = await createImageBitmap(file);
      const value = decodeImage(bitmap, bitmap.width, bitmap.height);
      bitmap.close?.();
      if (value) {
        finish(value);
        return;
      }
      setHint('这张图里没找到二维码，换一张试试');
    } catch {
      setHint('图片读不出来，换一张试试');
    }
  };

  return (
    <div className="qr-scan" role="dialog" aria-label={title}>
      <div className="qr-scan-head">
        <span>{title}</span>
        <button type="button" className="qr-scan-close" onClick={() => { stop(); onClose?.(); }} aria-label="关闭">
          ×
        </button>
      </div>
      <div className="qr-scan-stage">
        <video ref={videoRef} className="qr-scan-video" muted playsInline />
        <div className="qr-scan-frame" aria-hidden="true">
          <i className="qr-scan-line" />
        </div>
      </div>
      <p className={'qr-scan-hint' + (err ? ' is-err' : '')}>{err || hint}</p>
      <div className="qr-scan-foot">
        <button type="button" className="btn btn-ghost" onClick={() => fileRef.current?.click()}>
          从图片识别
        </button>
        <button type="button" className="btn btn-primary" onClick={() => { stop(); onClose?.(); }}>
          取消
        </button>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={onPick} />
      </div>
    </div>
  );
}

export default QrCode;
