'use strict';

// Furry Everpony 预加载脚本（sandbox: true）
// 只通过 contextBridge 暴露白名单能力，不把 ipcRenderer / Node 能力交给页面。

const { contextBridge, ipcRenderer } = require('electron');

const platform = process.platform;
const navigateListeners = new Set();

// 诊断种子信息：主进程已注册同步处理器，preload 启动时同步取一次（失败不影响页面）
let diagnosticsSeed = { logDir: '', version: '', serverPid: 0, serverState: 'idle' };
try {
  const syncInfo = ipcRenderer.sendSync('fe:diagnostics-sync');
  if (syncInfo && typeof syncInfo === 'object') {
    diagnosticsSeed = {
      logDir: typeof syncInfo.logDir === 'string' ? syncInfo.logDir : '',
      version: typeof syncInfo.version === 'string' ? syncInfo.version : '',
      serverPid: Number.isFinite(Number(syncInfo.serverPid)) ? Number(syncInfo.serverPid) : 0,
      serverState: typeof syncInfo.serverState === 'string' ? syncInfo.serverState : 'idle',
    };
  }
} catch (err) {
  // 同步 IPC 不可用时降级为 getDiagnostics() 实时查询
}

// 统一导航事件负载：兼容字符串与会话对象两种形态
function readConversationId(payload) {
  if (typeof payload === 'string') {
    return payload.trim().slice(0, 128);
  }
  if (payload && typeof payload === 'object' && typeof payload.conversationId === 'string') {
    return payload.conversationId.trim().slice(0, 128);
  }
  return '';
}

ipcRenderer.on('fe:navigate', function (event, payload) {
  const conversationId = readConversationId(payload);
  if (!conversationId) {
    return;
  }
  navigateListeners.forEach(function (listener) {
    try {
      listener(conversationId);
    } catch (err) {
      console.error('[fe] onNavigate 回调异常:', err && err.message);
    }
  });
});

function sanitizeNotify(input) {
  const data = input && typeof input === 'object' ? input : {};
  return {
    title: typeof data.title === 'string' ? data.title.slice(0, 120) : '',
    body: typeof data.body === 'string' ? data.body.slice(0, 500) : '',
    conversationId: typeof data.conversationId === 'string' ? data.conversationId.slice(0, 128) : '',
  };
}

function sanitizeBadge(count) {
  const value = Number(count);
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(999, Math.trunc(value)));
}

function sanitizeExternalUrl(url) {
  return typeof url === 'string' ? url : '';
}

contextBridge.exposeInMainWorld('fe', {
  platform: platform,
  notify: function (input) {
    return ipcRenderer.invoke('fe:notify', sanitizeNotify(input));
  },
  setBadge: function (count) {
    return ipcRenderer.invoke('fe:set-badge', sanitizeBadge(count));
  },
  flash: function () {
    return ipcRenderer.invoke('fe:flash');
  },
  onNavigate: function (callback) {
    if (typeof callback !== 'function') {
      return function () {};
    }
    navigateListeners.add(callback);
    return function () {
      navigateListeners.delete(callback);
    };
  },
  setAutoStart: function (enabled) {
    return ipcRenderer.invoke('fe:set-auto-start', enabled === true);
  },
  getAutoStart: function () {
    return ipcRenderer.invoke('fe:get-auto-start');
  },
  getPlatform: function () {
    return ipcRenderer.invoke('fe:platform');
  },
  openExternal: function (url) {
    return ipcRenderer.invoke('fe:open-external', sanitizeExternalUrl(url));
  },
  getPrefs: function () {
    return ipcRenderer.invoke('fe:get-prefs');
  },
  setPrefs: function (patch) {
    return ipcRenderer.invoke('fe:set-prefs', patch && typeof patch === 'object' ? patch : {});
  },
  restartApp: function () {
    return ipcRenderer.invoke('fe:restart-app');
  },
  quitApp: function () {
    return ipcRenderer.invoke('fe:quit-app');
  },
  ensureFirewall: function () {
    return ipcRenderer.invoke('fe:ensure-firewall');
  },
  getFirewallStatus: function () {
    return ipcRenderer.invoke('fe:firewall-status');
  },
  // 诊断入口：日志目录 / 版本 / 服务端 pid / 手动重启服务端
  openLogDir: function () {
    return ipcRenderer.invoke('fe:open-log-dir');
  },
  getDiagnostics: function () {
    return ipcRenderer.invoke('fe:diagnostics-info');
  },
  diagnostics: {
    logDir: diagnosticsSeed.logDir,
    version: diagnosticsSeed.version,
    serverPid: diagnosticsSeed.serverPid,
    serverState: diagnosticsSeed.serverState,
    openLogDir: function () {
      return ipcRenderer.invoke('fe:open-log-dir');
    },
    restartServer: function () {
      return ipcRenderer.invoke('fe:restart-server');
    },
    getInfo: function () {
      return ipcRenderer.invoke('fe:diagnostics-info');
    },
  },
});

// 保留原有窗口控制能力（标题栏按钮）
contextBridge.exposeInMainWorld('feWin', {
  minimize: function () { ipcRenderer.send('win:minimize'); },
  toggleMax: function () { ipcRenderer.send('win:toggle-max'); },
  close: function () { ipcRenderer.send('win:close'); },
  toggleFullscreen: function () { ipcRenderer.send('win:toggle-fullscreen'); },
});
