import React from 'react';

/* 任何视图渲染出错时给出可读提示和「回到聊天」出口，避免整屏黑掉 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[fe] 界面出错', error, info?.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const message = error && error.message ? String(error.message) : '未知错误';
    return (
      <div className="fe-crash">
        <div className="fe-crash-card">
          <div className="fe-crash-title">这个页面出了点问题</div>
          <p className="fe-crash-text">界面渲染失败，已经记下原因。可以回到聊天继续用，其他功能不受影响。</p>
          <pre className="fe-crash-detail">{message}</pre>
          <div className="fe-crash-actions">
            <button type="button" className="btn btn-primary" onClick={() => this.setState({ error: null })}>再试一次</button>
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => {
                this.setState({ error: null });
                window.location.reload();
              }}
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    );
  }
}
