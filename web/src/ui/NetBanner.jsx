import { useEffect, useState } from 'react';
import Icon from './icons.jsx';
import { subscribeNet } from '../lib/api.js';

/**
 * 顶栏细条：断线时提示「连接已断开，正在重试…」，恢复后显示 2 秒「已恢复」自动收起。
 * 只由 api() 的真实失败触发，业务错误（4xx）不会误报。
 */
export default function NetBanner() {
  const [net, setNet] = useState({ offline: false, recovering: false, reason: '' });

  useEffect(() => subscribeNet(setNet), []);

  if (!net.offline && !net.recovering) return null;

  return (
    <div className={'net-banner' + (net.offline ? ' offline' : ' ok')} role="status" aria-live="polite" title={net.reason || undefined}>
      {net.offline ? (
        <>
          <span className="net-banner-dot" aria-hidden />
          <span>连接已断开，正在重试…</span>
          {net.reason ? <span className="net-banner-reason">{net.reason}</span> : null}
        </>
      ) : (
        <>
          <Icon name="check" size={13} />
          <span>连接已恢复</span>
        </>
      )}
    </div>
  );
}
