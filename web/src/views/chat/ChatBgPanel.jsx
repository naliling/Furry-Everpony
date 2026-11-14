import { useEffect, useRef, useState } from 'react';
import Icon from '../../ui/icons.jsx';
import { Drawer, Modal, toast, useIsMobile } from '../../ui/primitives.jsx';
import {
  CHAT_BG_EVENT,
  addChatBgFiles,
  clearChatBg,
  pickChatBg,
  readChatBg,
  removeChatBgAt,
  resetChatBg,
  requestOpenSettings,
} from '../../lib/chatBg.js';

/**
 * 聊天背景面板：聊天页「更多 → 聊天背景」直接打开，不用再跑去设置页找。
 * 数据与设置页共用 lib/chatBg.js，改完立刻派发 fe:chatbg，聊天区即时换背景。
 * 桌面用居中弹窗，手机用底部抽屉。
 */
export default function ChatBgPanel({ onClose }) {
  const isMobile = useIsMobile();
  const [bg, setBg] = useState(() => readChatBg());
  const fileRef = useRef(null);

  useEffect(() => {
    const read = () => setBg(readChatBg());
    window.addEventListener(CHAT_BG_EVENT, read);
    return () => window.removeEventListener(CHAT_BG_EVENT, read);
  }, []);

  const add = async (e) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    try {
      const next = await addChatBgFiles(bg, files);
      if (!next) { toast('这些图片没能读取，换一张试试', 'error'); return; }
      setBg(next);
      toast('已添加背景', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const choose = (index) => {
    try {
      setBg(pickChatBg(bg, index));
      toast(index < 0 ? '已恢复默认背景' : '已使用第 ' + (index + 1) + ' 张背景', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const remove = (index) => {
    try {
      setBg(removeChatBgAt(bg, index));
      toast('已删除这张背景', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const clearAll = () => {
    if (!bg.list.length) return;
    const ok = window.confirm('确定删除所有聊天背景吗？');
    if (!ok) return;
    try {
      setBg(clearChatBg());
      toast('已全部删除', 'success');
    } catch (err) {
      toast(err.message, 'error');
    }
  };

  const jumpSettings = () => {
    onClose?.();
    requestOpenSettings('chat-bg');
  };

  const body = (
    <div className="chatbg-panel">
      <p className="chatbg-tip">
        <Icon name="image" size={14} />
        选一张图片铺在聊天区，只有你自己看得到；最多 12 张，随时可以换。
      </p>
      <div className="bg-grid">
        <button
          type="button"
          className={'bg-cell bg-none' + (bg.current < 0 ? ' on' : '')}
          onClick={() => choose(-1)}
          title="用主题默认背景"
        >
          <Icon name="palette" size={20} />
          <span>默认</span>
        </button>
        {bg.list.map((src, i) => (
          <div key={i} className={'bg-cell' + (bg.current === i ? ' on' : '')}>
            <button type="button" className="bg-pick" onClick={() => choose(i)} title={'使用第 ' + (i + 1) + ' 张背景'}>
              <img src={src} alt={'背景 ' + (i + 1)} />
            </button>
            <button type="button" className="bg-del" onClick={() => remove(i)} title="删除这张背景" aria-label="删除这张背景">
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
        <button type="button" className="bg-cell bg-add" onClick={() => fileRef.current?.click()} title="添加背景图">
          <Icon name="plus" size={20} />
          <span>添加</span>
        </button>
      </div>
      <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={add} />
      <div className="chatbg-meta">
        <span>当前：{bg.current < 0 ? '默认背景' : '第 ' + (bg.current + 1) + ' 张'}</span>
        <span>共 {bg.list.length} 张</span>
      </div>
      <div className="chatbg-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => fileRef.current?.click()}>
          <Icon name="plus" size={15} /> 添加图片
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => choose(-1)} disabled={bg.current < 0}>
          <Icon name="refresh" size={15} /> 恢复默认
        </button>
        <button type="button" className="btn btn-danger-ghost btn-sm" onClick={clearAll} disabled={!bg.list.length}>
          <Icon name="trash" size={15} /> 全部删除
        </button>
      </div>
      <button type="button" className="chatbg-settings-link" onClick={jumpSettings}>
        <Icon name="gear" size={15} /> 在设置里管理全部背景
        <Icon name="chevron" size={14} />
      </button>
    </div>
  );

  if (isMobile) {
    return (
      <Drawer title="聊天背景" subtitle="只影响你自己的聊天区" icon="image" onClose={onClose} className="chatbg-drawer">
        {body}
      </Drawer>
    );
  }

  return (
    <Modal title="聊天背景" subtitle="只影响你自己的聊天区，换一张换个心情" icon="image" width={520} onClose={onClose}>
      {body}
    </Modal>
  );
}
