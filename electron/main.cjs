'use strict';

// Furry Everpony 桌面端主进程
// v0.10.0 桌面增强：托盘常驻（关闭即隐藏）、单实例聚焦、窗口状态持久化、
// 系统通知/未读角标/任务栏闪烁/开机自启/全局快捷键，同时保留内嵌服务端与窗口控制能力。
// 注意：主进程使用 CommonJS（.cjs）；内嵌服务端是 ESM，用动态 import 加载。

const {
  app, BrowserWindow, shell, Menu, Tray, Notification, ipcMain,
  nativeTheme, nativeImage, globalShortcut, screen,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const firewall = require('./firewall.cjs');
const logger = require('./logger.cjs');

const APP_TITLE = 'Furry Everpony';
const APP_USER_MODEL_ID = 'com.furryeverpony.desktop';
const PORT = Number(process.env.FE_PORT || 7788);
const URL_BASE = 'http://127.0.0.1:' + PORT + '/';
const IS_WIN = process.platform === 'win32';
const MIN_WIDTH = 960;
const MIN_HEIGHT = 620;
const START_HIDDEN = process.argv.includes('--hidden');
const GLOBAL_SHORTCUT = 'Control+Alt+E';

// 服务端以独立子进程运行（崩溃不带走界面），日志/退出码/pid 由主进程统一采集
const SERVER_HOST_SCRIPT = path.join(__dirname, 'server-host.cjs');
const SERVER_RESTART_DELAY_MS = 3000;   // 崩溃后 3 秒自动重启
const SERVER_MAX_FAILURES = 5;          // 连续失败 5 次停止重启并显示错误页
const SERVER_STABLE_MS = 60 * 1000;     // 稳定运行 60 秒后失败计数清零

let serverChild = null;       // 服务端子进程
let serverPid = 0;            // 当前服务端 pid（没有则为 0）
let serverState = 'idle';     // idle | starting | running | restarting | reused | failed | stopped
let serverFailures = 0;       // 连续启动失败次数
let serverRestartTimer = null;
let serverStableTimer = null;
let serverStopping = false;   // 主动停止（退出/重启），不触发自动重启
let serverPortInUse = false;  // 端口被已有实例占用，直接复用
let serverLastExit = null;    // { code, signal, at }
let serverFailureDetail = ''; // 最近一次启动失败原因（给错误页用）
let mainWindow = null;        // 主窗口
let tray = null;              // 托盘图标
let isQuitting = false;       // 真正的退出流程（区分「关闭窗口」与「退出应用」）
let ipcReady = false;         // IPC 处理器只注册一次
let pendingConversationId = ''; // 窗口还没加载完时暂存的跳转目标
let saveStateTimer = null;

// ---------------------------------------------------------------------------
// 基础工具：userData 下的小 JSON 读写
// ---------------------------------------------------------------------------

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJsonFile(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('[fe] 写入状态文件失败:', file, err && err.message);
  }
}

function windowStateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function trayHintFile() {
  return path.join(app.getPath('userData'), 'tray-hint.json');
}

function firewallHintFile() {
  return path.join(app.getPath('userData'), 'firewall-hint.json');
}

// 桌面偏好：默认「点叉 = 退出」，需要托盘常驻的用户可以自己打开
const DEFAULT_PREFS = { closeToTray: false, lanAccess: false };

function prefsFile() {
  return path.join(app.getPath('userData'), 'desktop-prefs.json');
}

function loadPrefs() {
  const raw = readJsonFile(prefsFile());
  const prefs = Object.assign({}, DEFAULT_PREFS);
  if (raw && typeof raw === 'object' && typeof raw.closeToTray === 'boolean') {
    prefs.closeToTray = raw.closeToTray;
  }
  if (raw && typeof raw === 'object' && typeof raw.lanAccess === 'boolean') {
    prefs.lanAccess = raw.lanAccess;
  }
  return prefs;
}

function savePrefs(patch) {
  const next = Object.assign(loadPrefs(), patch && typeof patch === 'object' ? patch : {});
  writeJsonFile(prefsFile(), {
    closeToTray: next.closeToTray === true,
    lanAccess: next.lanAccess === true,
  });
  return next;
}

// ---------------------------------------------------------------------------
// 窗口状态持久化（大小 / 位置 / 最大化）
// ---------------------------------------------------------------------------

const DEFAULT_STATE = { width: 1200, height: 820, isMaximized: false };

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function loadWindowState() {
  const state = {
    width: DEFAULT_STATE.width,
    height: DEFAULT_STATE.height,
    x: undefined,
    y: undefined,
    isMaximized: false,
  };
  const raw = readJsonFile(windowStateFile());
  if (raw && typeof raw === 'object') {
    if (isFiniteNumber(raw.width)) state.width = Math.max(MIN_WIDTH, Math.round(raw.width));
    if (isFiniteNumber(raw.height)) state.height = Math.max(MIN_HEIGHT, Math.round(raw.height));
    if (isFiniteNumber(raw.x)) state.x = Math.round(raw.x);
    if (isFiniteNumber(raw.y)) state.y = Math.round(raw.y);
    state.isMaximized = raw.isMaximized === true;
  }
  return ensureOnScreen(state);
}

// 校验窗口与任意显示器工作区有足够交集，避免拔掉副屏后窗口跑到屏幕外
function ensureOnScreen(state) {
  if (!isFiniteNumber(state.x) || !isFiniteNumber(state.y)) {
    return state;
  }
  const displays = screen.getAllDisplays();
  const visible = displays.some(function (display) {
    const area = display.workArea;
    const overlapWidth = Math.min(state.x + state.width, area.x + area.width) - Math.max(state.x, area.x);
    const overlapHeight = Math.min(state.y + state.height, area.y + area.height) - Math.max(state.y, area.y);
    return overlapWidth >= 160 && overlapHeight >= 120;
  });
  if (!visible) {
    console.warn('[fe] 上次窗口位置不在任何屏幕内，回退到系统默认位置');
    state.x = undefined;
    state.y = undefined;
  }
  return state;
}

function currentWindowState() {
  const state = {
    width: DEFAULT_STATE.width,
    height: DEFAULT_STATE.height,
    isMaximized: false,
  };
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getNormalBounds();
    state.width = Math.max(MIN_WIDTH, bounds.width);
    state.height = Math.max(MIN_HEIGHT, bounds.height);
    state.x = bounds.x;
    state.y = bounds.y;
    state.isMaximized = mainWindow.isMaximized();
  }
  return state;
}

function saveWindowState() {
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
    saveStateTimer = null;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  writeJsonFile(windowStateFile(), currentWindowState());
}

function scheduleSaveWindowState() {
  if (saveStateTimer) {
    clearTimeout(saveStateTimer);
  }
  saveStateTimer = setTimeout(function () {
    saveStateTimer = null;
    saveWindowState();
  }, 400);
}

// ---------------------------------------------------------------------------
// 内嵌服务端（独立子进程：userData/data 作为数据目录，端口占用时复用）
// ---------------------------------------------------------------------------

function serverDataDir() {
  return path.join(app.getPath('userData'), 'data');
}

function serverHost() {
  // 局域网访问开关：关着只绑本机，开着手机/平板/外网才能连进来。
  // 绑 :: 是双栈：IPv4 照样能连，同时收公网 IPv6 —— 不在同一个 Wi-Fi 下也能加好友靠的就是它。
  return loadPrefs().lanAccess === true ? '::' : '127.0.0.1';
}

function diagnosticsInfo() {
  const info = logger.getInfo();
  return {
    logDir: info.logDir,
    logFile: info.logFile,
    version: app.getVersion(),
    serverPid: serverPid,
    serverState: serverState,
    serverFailures: serverFailures,
    serverLastExit: serverLastExit,
    restartDelayMs: SERVER_RESTART_DELAY_MS,
    maxFailures: SERVER_MAX_FAILURES,
    logKeepFiles: info.keepFiles,
  };
}

async function openLogDir() {
  const info = logger.getInfo();
  if (!info.logDir) {
    return { ok: false, error: '日志目录不可用' };
  }
  try {
    fs.mkdirSync(info.logDir, { recursive: true });
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
  try {
    const failure = await shell.openPath(info.logDir);
    if (failure) {
      return { ok: false, error: failure, logDir: info.logDir };
    }
    logger.info('[main] 已打开日志目录 ' + info.logDir);
    return { ok: true, logDir: info.logDir };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err), logDir: info.logDir };
  }
}

function clearServerRestartTimer() {
  if (serverRestartTimer) {
    clearTimeout(serverRestartTimer);
    serverRestartTimer = null;
  }
}

function clearServerStableTimer() {
  if (serverStableTimer) {
    clearTimeout(serverStableTimer);
    serverStableTimer = null;
  }
}

// 服务端连续运行 60 秒后认为本次启动成功，失败计数清零
function markServerStableLater() {
  clearServerStableTimer();
  serverStableTimer = setTimeout(function () {
    serverStableTimer = null;
    if (serverState === 'running') {
      serverFailures = 0;
      logger.info('[main] 服务端已稳定运行 ' + Math.round(SERVER_STABLE_MS / 1000) + ' 秒，失败计数清零');
    }
  }, SERVER_STABLE_MS);
  if (serverStableTimer && typeof serverStableTimer.unref === 'function') {
    serverStableTimer.unref();
  }
}

function scheduleServerRestart() {
  clearServerRestartTimer();
  logger.warn('[main] ' + Math.round(SERVER_RESTART_DELAY_MS / 1000) + ' 秒后重启服务端（连续失败 ' + serverFailures + '/' + SERVER_MAX_FAILURES + '）');
  serverRestartTimer = setTimeout(function () {
    serverRestartTimer = null;
    if (!isQuitting) {
      startServerProcess();
    }
  }, SERVER_RESTART_DELAY_MS);
}

function isStatusPageShowing() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  try {
    return mainWindow.webContents.getURL().indexOf('status.html') !== -1;
  } catch (err) {
    return false;
  }
}

function isAppPageShowing() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  try {
    return mainWindow.webContents.getURL().indexOf(URL_BASE) === 0;
  } catch (err) {
    return false;
  }
}

function showStatusPage(state, message) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve();
  }
  return mainWindow.loadFile(path.join(__dirname, 'status.html'), {
    query: {
      state: state || 'starting',
      message: String(message || '').slice(0, 500),
      appUrl: URL_BASE,
    },
  }).catch(function (err) {
    console.error('[fe] 加载状态页失败:', err && err.message);
  });
}

// 服务端就绪后加载主界面；如果界面已经在运行（服务端重启热恢复）则不打断用户
function ensureAppLoaded() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (isAppPageShowing()) {
    return;
  }
  let currentUrl = '';
  try {
    currentUrl = mainWindow.webContents.getURL();
  } catch (err) {
    currentUrl = '';
  }
  if (currentUrl && currentUrl.indexOf('status.html') === -1) {
    // 用户正停在其它页面，不强行跳转
    return;
  }
  mainWindow.loadURL(URL_BASE).catch(function (err) {
    console.error('[fe] 加载主界面失败:', err && err.message);
    showStatusPage('failed', '界面加载失败：' + String((err && err.message) || err));
  });
}

function showServerFailureUi() {
  const detail = serverFailureDetail || ('上次退出 ' + JSON.stringify(serverLastExit || {}));
  console.error('[fe] 服务端连续 ' + SERVER_MAX_FAILURES + ' 次启动失败，停止自动重启');
  showStatusPage('failed', '服务端连续 ' + SERVER_MAX_FAILURES + ' 次启动失败，已停止自动重启。' + detail);
  if (!Notification.isSupported()) {
    return;
  }
  try {
    const notification = new Notification({
      title: APP_TITLE + ' 服务启动失败',
      body: '服务启动失败，点这里看日志',
      icon: nativeImage.createFromPath(appIconPath()),
    });
    notification.on('click', function () {
      showWindow();
      openLogDir().catch(function () { /* 忽略 */ });
    });
    notification.show();
  } catch (err) {
    console.error('[fe] 服务失败通知发送失败:', err && err.message);
  }
}

function handleServerMessage(child, message) {
  if (child !== serverChild || !message || typeof message !== 'object') {
    return;
  }
  if (message.type === 'listening') {
    serverState = 'running';
    serverFailureDetail = '';
    if (!serverPid && message.pid) {
      serverPid = Number(message.pid) || 0;
    }
    logger.info('[main] 服务端监听成功 pid=' + serverPid + ' url=http://' + message.host + ':' + message.port + '/');
    markServerStableLater();
    ensureAppLoaded();
    return;
  }
  if (message.type === 'port-in-use') {
    serverPortInUse = true;
    serverState = 'reused';
    logger.warn('[main] 端口 ' + PORT + ' 已被占用，复用已有服务端');
    ensureAppLoaded();
    return;
  }
  if (message.type === 'startup-error') {
    serverFailureDetail = String(message.message || '').slice(0, 500);
    logger.error('[main] 服务端启动失败: ' + serverFailureDetail);
  }
}

function handleServerExit(child, code, signal) {
  if (child !== serverChild) {
    return;
  }
  serverChild = null;
  serverPid = 0;
  clearServerStableTimer();
  serverLastExit = {
    code: code === null || code === undefined ? null : code,
    signal: signal || null,
    at: Date.now(),
  };
  const exitText = 'code=' + serverLastExit.code + ' signal=' + (serverLastExit.signal || '无');
  if (serverStopping || isQuitting) {
    serverState = 'stopped';
    logger.info('[main] 服务端进程已停止（主动停止） ' + exitText);
    return;
  }
  if (serverPortInUse) {
    serverState = 'reused';
    logger.warn('[main] 服务端子进程退出（端口冲突交给已有实例） ' + exitText);
    return;
  }
  serverFailures += 1;
  logger.error('[main] 服务端进程意外退出 ' + exitText + ' 连续失败=' + serverFailures + '/' + SERVER_MAX_FAILURES);
  if (serverFailures >= SERVER_MAX_FAILURES) {
    serverState = 'failed';
    showServerFailureUi();
    return;
  }
  serverState = 'restarting';
  if (isStatusPageShowing()) {
    showStatusPage('starting', '服务端异常退出，正在第 ' + serverFailures + ' 次重试…');
  }
  scheduleServerRestart();
}

function startServerProcess() {
  if (isQuitting || serverChild) {
    return;
  }
  clearServerRestartTimer();
  const dataDir = serverDataDir();
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    console.error('[fe] 创建数据目录失败:', err && err.message);
  }
  const host = serverHost();
  const env = Object.assign({}, process.env, {
    ELECTRON_RUN_AS_NODE: '1',
    FE_APP_ROOT: app.getAppPath(),
    FE_DB: path.join(dataDir, 'everpony.db'),
    FE_PORT: String(PORT),
    FE_HOST: host,
    FE_LOG_DIR: path.join(app.getPath('userData'), 'logs'),
  });
  serverState = 'starting';
  serverPortInUse = false;
  let child = null;
  try {
    child = spawn(process.execPath, [SERVER_HOST_SCRIPT], {
      env: env,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
  } catch (err) {
    serverFailures += 1;
    serverFailureDetail = '拉起服务端进程失败：' + String((err && err.message) || err);
    console.error('[fe] ' + serverFailureDetail);
    if (serverFailures >= SERVER_MAX_FAILURES) {
      serverState = 'failed';
      showServerFailureUi();
    } else {
      serverState = 'restarting';
      scheduleServerRestart();
    }
    return;
  }
  serverChild = child;
  serverPid = child.pid || 0;
  console.log('[fe] 已拉起服务端进程 pid=' + serverPid + ' host=' + host + ' port=' + PORT + ' dataDir=' + dataDir);
  if (child.stdout && typeof child.stdout.on === 'function') {
    try { child.stdout.setEncoding('utf8'); } catch (err) { /* 忽略 */ }
    child.stdout.on('data', function (chunk) { logger.write('info', 'server', chunk); });
  }
  if (child.stderr && typeof child.stderr.on === 'function') {
    try { child.stderr.setEncoding('utf8'); } catch (err) { /* 忽略 */ }
    child.stderr.on('data', function (chunk) { logger.write('warn', 'server:err', chunk); });
  }
  child.on('message', function (message) { handleServerMessage(child, message); });
  child.on('error', function (err) {
    console.error('[fe] 服务端子进程错误:', err && err.message);
  });
  child.on('exit', function (code, signal) { handleServerExit(child, code, signal); });
}

function stopServerProcess() {
  clearServerRestartTimer();
  clearServerStableTimer();
  const child = serverChild;
  if (!child) {
    serverChild = null;
    serverPid = 0;
    return Promise.resolve();
  }
  serverStopping = true;
  serverState = 'stopped';
  serverChild = null;
  serverPid = 0;
  return new Promise(function (resolve) {
    let settled = false;
    const finish = function () {
      if (settled) return;
      settled = true;
      resolve();
    };
    const timer = setTimeout(function () {
      try { child.kill('SIGKILL'); } catch (err) { /* 忽略 */ }
      finish();
    }, 2500);
    if (timer && typeof timer.unref === 'function') timer.unref();
    child.once('exit', function () {
      clearTimeout(timer);
      finish();
    });
    try {
      child.kill();
    } catch (err) {
      clearTimeout(timer);
      finish();
    }
  });
}

async function restartServerFromUi() {
  if (isQuitting) {
    return { ok: false, error: 'quitting' };
  }
  logger.info('[main] 用户请求重启服务端');
  serverFailures = 0;
  serverFailureDetail = '';
  await stopServerProcess();
  serverStopping = false;
  serverPortInUse = false;
  startServerProcess();
  return { ok: true, pid: serverPid, state: serverState };
}

// ---------------------------------------------------------------------------
// 窗口 / 托盘 / 快捷键
// ---------------------------------------------------------------------------

function trayIconPath() {
  return path.join(app.getAppPath(), 'build', 'icon.ico');
}

function appIconPath() {
  return path.join(app.getAppPath(), 'build', 'icon.ico');
}

function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

function hideWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }
  saveWindowState();
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    showWindow();
    return;
  }
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    hideWindow();
  } else {
    showWindow();
  }
}

function quitApp() {
  isQuitting = true;
  saveWindowState();
  app.quit();
}

function toggleFullScreen() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return false;
  }
  const next = !mainWindow.isFullScreen();
  mainWindow.setFullScreen(next);
  return next;
}

function refreshTrayMenu() {
  if (!tray) {
    return;
  }
  const visible = !!mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible();
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主窗口', enabled: !visible, click: function () { showWindow(); } },
    { label: '隐藏到托盘', enabled: visible, click: function () { hideWindow(); } },
    { type: 'separator' },
    { label: '打开日志目录', click: function () {
        openLogDir().then(function (result) {
          if (!result.ok) {
            console.warn('[fe] 打开日志目录失败:', result.error);
          }
        }).catch(function () { /* 忽略 */ });
      } },
    { type: 'separator' },
    { label: '退出', click: function () { quitApp(); } },
  ]));
}

function createTray() {
  if (tray) {
    return;
  }
  let image = nativeImage.createFromPath(trayIconPath());
  if (image.isEmpty()) {
    image = nativeImage.createFromPath(path.join(app.getAppPath(), 'build', 'icon.png'));
  }
  if (image.isEmpty()) {
    console.warn('[fe] 托盘图标缺失，跳过托盘功能');
    return;
  }
  tray = new Tray(IS_WIN ? image : image.resize({ width: 22, height: 22 }));
  tray.setToolTip(APP_TITLE);
  console.log('[fe] 托盘已创建');
  refreshTrayMenu();
  tray.on('double-click', function () { showWindow(); });
  tray.on('click', function () { refreshTrayMenu(); });
}

// 首次隐藏到托盘时提示一次（写入 userData/tray-hint.json 记录）
function trayHintAlreadyShown() {
  const raw = readJsonFile(trayHintFile());
  return !!(raw && raw.shown === true);
}

function showTrayHint() {
  if (trayHintAlreadyShown()) {
    return;
  }
  writeJsonFile(trayHintFile(), { shown: true });
  const body = '窗口已隐藏到托盘。双击托盘图标即可恢复，托盘菜单可退出。';
  if (IS_WIN && tray && typeof tray.displayBalloon === 'function') {
    try {
      tray.displayBalloon({
        title: APP_TITLE,
        content: body,
        icon: nativeImage.createFromPath(trayIconPath()),
        noSound: true,
      });
      return;
    } catch (err) {
      // 气泡失败不阻塞流程，降级到系统通知
    }
  }
  if (Notification.isSupported()) {
    try {
      new Notification({ title: APP_TITLE, body: body }).show();
    } catch (err) {
      console.warn('[fe] 托盘提示通知失败:', err && err.message);
    }
  }
}

function registerGlobalShortcuts() {
  try {
    const ok = globalShortcut.register(GLOBAL_SHORTCUT, function () {
      toggleWindow();
    });
    if (!ok) {
      console.warn('[fe] 全局快捷键 ' + GLOBAL_SHORTCUT + ' 注册失败（可能被占用）');
    } else {
      console.log('[fe] 全局快捷键已注册 ' + GLOBAL_SHORTCUT);
    }
  } catch (err) {
    // 注册失败静默降级，不影响主流程
    console.warn('[fe] 全局快捷键注册异常:', err && err.message);
  }
}

// ---------------------------------------------------------------------------
// IPC：通知 / 角标 / 闪烁 / 自启动 / 平台信息 / 外链
// ---------------------------------------------------------------------------

// 只接受主窗口渲染进程发来的 IPC，避免任意页面调用桌面能力
function isTrustedSender(event) {
  if (!event || !event.sender) {
    return false;
  }
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  return !!senderWindow && senderWindow === mainWindow;
}

function navigateRenderer(conversationId) {
  if (!conversationId) {
    return;
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    pendingConversationId = conversationId;
    return;
  }
  const contents = mainWindow.webContents;
  if (contents.isLoadingMainFrame()) {
    pendingConversationId = conversationId;
    return;
  }
  try {
    contents.send('fe:navigate', { conversationId: conversationId });
  } catch (err) {
    console.error('[fe] 发送导航事件失败:', err && err.message);
  }
}

function flushPendingNavigation() {
  if (!pendingConversationId) {
    return;
  }
  const conversationId = pendingConversationId;
  pendingConversationId = '';
  navigateRenderer(conversationId);
}

function loginItemOptions() {
  // 未打包时 Electron 的可执行文件需要额外参数才能定位应用目录
  const args = ['--hidden'];
  if (!app.isPackaged) {
    args.push(app.getAppPath());
  }
  return { path: process.execPath, args: args };
}

// 防火墙提示去抖：用户取消过 UAC 后 12 小时内不再在启动时自动尝试
const FIREWALL_RETRY_MS = 12 * 60 * 60 * 1000;

function firewallRetryAllowed() {
  const raw = readJsonFile(firewallHintFile());
  const declinedAt = raw && typeof raw === 'object' ? Number(raw.declinedAt) : NaN;
  if (!Number.isFinite(declinedAt) || declinedAt <= 0) {
    return true;
  }
  return Date.now() - declinedAt >= FIREWALL_RETRY_MS;
}

// 启动时自动检查：开启了局域网访问但规则缺失时尝试添加（可能由系统弹一次 UAC）
function maybeEnsureFirewallOnStartup() {
  if (!IS_WIN || loadPrefs().lanAccess !== true) {
    return;
  }
  if (!firewallRetryAllowed()) {
    return;
  }
  const timer = setTimeout(function () {
    firewall.ensureFirewallRule({ interactive: false }).then(function (result) {
      if (result.ok) {
        if (result.added) {
          console.log('[fe] 已添加局域网防火墙规则 ' + firewall.RULE_NAME);
        }
        return;
      }
      console.warn('[fe] 添加局域网防火墙规则失败:', result.error || result.reason || '需要管理员权限');
      writeJsonFile(firewallHintFile(), { declinedAt: Date.now() });
    }).catch(function (err) {
      console.error('[fe] 防火墙检查异常:', err && err.message);
    });
  }, 1500);
  if (timer && typeof timer.unref === 'function') {
    timer.unref();
  }
}

function registerIpcHandlers() {
  if (ipcReady) {
    return;
  }
  ipcReady = true;

  // 窗口控制（保留原有通道，只校验来源窗口）
  ipcMain.on('win:minimize', function (event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.minimize();
    }
  });
  ipcMain.on('win:toggle-max', function (event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return;
    }
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  });
  ipcMain.on('win:close', function (event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.close(); // 触发 close 事件 → 按偏好退出或隐藏到托盘
    }
  });
  ipcMain.on('win:toggle-fullscreen', function (event) {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) {
      return;
    }
    win.setFullScreen(!win.isFullScreen());
  });

  // 桌面偏好读写（关闭行为等）
  ipcMain.handle('fe:get-prefs', function (event) {
    if (!isTrustedSender(event)) {
      return { closeToTray: false, lanAccess: false };
    }
    return loadPrefs();
  });
  ipcMain.handle('fe:set-prefs', function (event, payload) {
    if (!isTrustedSender(event)) {
      return { ok: false, reason: 'untrusted' };
    }
    const patch = payload && typeof payload === 'object' ? payload : {};
    const current = loadPrefs();
    const next = savePrefs({
      closeToTray: typeof patch.closeToTray === 'boolean' ? patch.closeToTray : current.closeToTray,
      lanAccess: typeof patch.lanAccess === 'boolean' ? patch.lanAccess : current.lanAccess,
    });
    return { ok: true, prefs: next };
  });
  // 重启应用（改监听地址等需要重启才生效的设置）
  ipcMain.handle('fe:restart-app', function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, reason: 'untrusted' };
    }
    app.relaunch();
    setTimeout(function () { app.exit(0); }, 200);
    return { ok: true };
  });

  // 真正退出应用（开启「点叉隐藏到托盘」后，设置页仍需要一键退出）
  ipcMain.handle('fe:quit-app', function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, reason: 'untrusted' };
    }
    // 稍微延迟，保证 IPC 返回值先送到渲染进程
    setTimeout(function () { quitApp(); }, 30);
    return { ok: true };
  });

  // 系统通知：点击后聚焦窗口并把 conversationId 发给渲染进程
  ipcMain.handle('fe:notify', function (event, payload) {
    if (!isTrustedSender(event)) {
      return { ok: false, reason: 'untrusted' };
    }
    const data = payload && typeof payload === 'object' ? payload : {};
    const title = typeof data.title === 'string' && data.title.trim()
      ? data.title.trim().slice(0, 120)
      : APP_TITLE;
    const body = typeof data.body === 'string' ? data.body.slice(0, 500) : '';
    const conversationId = typeof data.conversationId === 'string'
      ? data.conversationId.trim().slice(0, 128)
      : '';
    if (!Notification.isSupported()) {
      return { ok: false, reason: 'unsupported' };
    }
    try {
      const notification = new Notification({
        title: title,
        body: body,
        icon: nativeImage.createFromPath(appIconPath()),
        silent: false,
      });
      notification.on('click', function () {
        showWindow();
        navigateRenderer(conversationId);
      });
      notification.show();
      return { ok: true };
    } catch (err) {
      console.error('[fe] 发送通知失败:', err && err.message);
      return { ok: false, reason: 'error' };
    }
  });

  // 未读角标（Windows 任务栏角标能力有限，失败静默忽略）
  ipcMain.handle('fe:set-badge', function (event, count) {
    if (!isTrustedSender(event)) {
      return false;
    }
    const value = Number.isFinite(Number(count))
      ? Math.max(0, Math.min(999, Math.trunc(Number(count))))
      : 0;
    try {
      return app.setBadgeCount(value);
    } catch (err) {
      return false;
    }
  });

  // 任务栏闪烁：窗口聚焦时立即停止
  ipcMain.handle('fe:flash', function (event) {
    if (!isTrustedSender(event)) {
      return false;
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return false;
    }
    if (mainWindow.isFocused()) {
      return true;
    }
    try {
      mainWindow.flashFrame(true);
      return true;
    } catch (err) {
      return false;
    }
  });

  // 开机自启
  ipcMain.handle('fe:set-auto-start', function (event, enabled) {
    if (!isTrustedSender(event)) {
      return false;
    }
    try {
      const options = loginItemOptions();
      app.setLoginItemSettings({
        openAtLogin: enabled === true,
        path: options.path,
        args: options.args,
      });
      const settings = app.getLoginItemSettings({ path: options.path, args: options.args });
      return settings.openAtLogin === true;
    } catch (err) {
      console.error('[fe] 设置开机自启失败:', err && err.message);
      return false;
    }
  });

  ipcMain.handle('fe:get-auto-start', function (event) {
    if (!isTrustedSender(event)) {
      return false;
    }
    try {
      const options = loginItemOptions();
      const settings = app.getLoginItemSettings({ path: options.path, args: options.args });
      return settings.openAtLogin === true;
    } catch (err) {
      return false;
    }
  });

  ipcMain.handle('fe:platform', function (event) {
    if (!isTrustedSender(event)) {
      return '';
    }
    return process.platform;
  });

  // 安全外链：只允许 http / https，其余一律拒绝
  ipcMain.handle('fe:open-external', async function (event, url) {
    if (!isTrustedSender(event) || typeof url !== 'string') {
      return false;
    }
    let parsed = null;
    try {
      parsed = new URL(url.slice(0, 2048));
    } catch (err) {
      return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    try {
      await shell.openExternal(parsed.toString());
      return true;
    } catch (err) {
      return false;
    }
  });

  // 防火墙：局域网 7788 端口放行（检测 / 一键添加，添加时可能弹一次 UAC）
  ipcMain.handle('fe:firewall-status', async function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, supported: false, exists: false, ruleName: firewall.RULE_NAME, manualCommand: firewall.MANUAL_COMMAND };
    }
    let exists = false;
    try {
      exists = await firewall.isRulePresent();
    } catch (err) {
      exists = false;
    }
    return {
      ok: true,
      supported: IS_WIN,
      exists: exists,
      ruleName: firewall.RULE_NAME,
      manualCommand: firewall.MANUAL_COMMAND,
    };
  });

  ipcMain.handle('fe:ensure-firewall', async function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, reason: 'untrusted', ruleName: firewall.RULE_NAME, manualCommand: firewall.MANUAL_COMMAND };
    }
    try {
      return await firewall.ensureFirewallRule({ interactive: true });
    } catch (err) {
      return {
        ok: false,
        error: String((err && err.message) || err),
        ruleName: firewall.RULE_NAME,
        manualCommand: firewall.MANUAL_COMMAND,
      };
    }
  });

  // 诊断：日志目录 / 版本 / 服务端 pid / 手动重启服务端
  ipcMain.on('fe:diagnostics-sync', function (event) {
    try {
      event.returnValue = diagnosticsInfo();
    } catch (err) {
      event.returnValue = { logDir: '', logFile: '', version: '', serverPid: 0, serverState: 'idle' };
    }
  });

  ipcMain.handle('fe:diagnostics-info', function (event) {
    if (!isTrustedSender(event)) {
      return { logDir: '', logFile: '', version: '', serverPid: 0, serverState: 'idle' };
    }
    return diagnosticsInfo();
  });

  ipcMain.handle('fe:open-log-dir', async function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted' };
    }
    return openLogDir();
  });

  ipcMain.handle('fe:restart-server', async function (event) {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'untrusted' };
    }
    return restartServerFromUi();
  });
}

// ---------------------------------------------------------------------------
// 主窗口
// ---------------------------------------------------------------------------

async function createWindow() {
  const state = loadWindowState();
  mainWindow = new BrowserWindow({
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    title: APP_TITLE,
    icon: appIconPath(),
    backgroundColor: '#0f0f11',
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 窗口最小化/被遮挡时不要节流定时器：一被节流，消息轮询就从 2 秒退化成几十秒一次，
      // 表现就是「对方回了我这边半天没动静」
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  if (state.isMaximized) {
    mainWindow.maximize();
  }

  mainWindow.once('ready-to-show', function () {
    console.log('[fe] 主窗口已就绪 hidden=' + START_HIDDEN);
    if (!START_HIDDEN) {
      mainWindow.show();
    }
  });

  // 关闭按钮：默认直接退出应用；只有用户在设置里勾了「最小化到托盘」才隐藏
  mainWindow.on('close', function (event) {
    console.log('[fe] 收到窗口关闭请求 isQuitting=' + isQuitting + ' closeToTray=' + loadPrefs().closeToTray);
    saveWindowState();
    if (isQuitting) {
      return;
    }
    if (loadPrefs().closeToTray) {
      event.preventDefault();
      hideWindow();
      showTrayHint();
      return;
    }
    isQuitting = true;
  });

  mainWindow.on('show', function () {
    console.log('[fe] 主窗口显示');
    refreshTrayMenu();
  });
  mainWindow.on('hide', function () {
    console.log('[fe] 主窗口隐藏');
    refreshTrayMenu();
  });
  mainWindow.on('focus', function () {
    if (mainWindow && !mainWindow.isDestroyed()) {
      try {
        mainWindow.flashFrame(false);
      } catch (err) {
        // 忽略：部分平台不支持
      }
    }
  });
  mainWindow.on('resize', scheduleSaveWindowState);
  mainWindow.on('move', scheduleSaveWindowState);
  mainWindow.on('maximize', function () {
    saveWindowState();
  });
  mainWindow.on('unmaximize', function () {
    saveWindowState();
  });
  mainWindow.on('closed', function () {
    console.log('[fe] 主窗口已关闭');
    mainWindow = null;
  });

  // Windows 关机 / 注销时直接退出，避免被「隐藏到托盘」挡住关机
  mainWindow.on('session-end', function () {
    console.log('[fe] 系统会话结束，直接退出');
    isQuitting = true;
    saveWindowState();
  });

  const contents = mainWindow.webContents;
  console.log('[fe] 主窗口已创建');

  // 渲染进程崩溃：写日志并切到可点击的恢复页，避免白屏
  contents.on('render-process-gone', function (event, details) {
    const info = details && typeof details === 'object' ? details : {};
    console.error('[fe] 渲染进程崩溃 reason=' + info.reason + ' exitCode=' + info.exitCode);
    if (isQuitting) {
      return;
    }
    if (isStatusPageShowing()) {
      console.error('[fe] 恢复页自身渲染失败，不再自动重载');
      return;
    }
    if (Notification.isSupported()) {
      try {
        new Notification({
          title: APP_TITLE,
          body: '界面进程崩溃，已切到恢复页，可重试或查看日志。',
          icon: nativeImage.createFromPath(appIconPath()),
        }).show();
      } catch (err) {
        console.warn('[fe] 崩溃通知发送失败:', err && err.message);
      }
    }
    showStatusPage('crashed', '界面进程崩溃（' + (info.reason || 'unknown') + '），可重新加载或打开日志。');
  });

  contents.on('unresponsive', function () {
    console.warn('[fe] 窗口无响应');
  });

  // 右键菜单：Electron 默认没有，输入框右键「粘贴」全靠它
  contents.on('context-menu', function (event, params) {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' }
      );
    } else if (params.selectionText && params.selectionText.trim()) {
      items.push({ role: 'copy', label: '复制' }, { role: 'selectAll', label: '全选' });
    }
    if (params.linkURL && /^https?:/i.test(params.linkURL)) {
      items.push({ type: 'separator' }, {
        label: '在浏览器打开链接',
        click: function () { shell.openExternal(params.linkURL); },
      });
    }
    if (params.mediaType === 'image' && params.srcURL) {
      items.push({ type: 'separator' }, {
        label: '在新窗口打开图片',
        click: function () { shell.openExternal(params.srcURL); },
      });
    }
    if (!items.length) {
      return;
    }
    Menu.buildFromTemplate(items).popup({ window: mainWindow });
  });

  // 键盘：F11 全屏、Ctrl+Shift+I 开发者工具
  contents.on('before-input-event', function (event, input) {
    if (input.type !== 'keyDown') {
      return;
    }
    if (input.key === 'F11') {
      event.preventDefault();
      toggleFullScreen();
    }
  });

  contents.on('did-finish-load', function () {
    flushPendingNavigation();
  });

  // 外链统一交给系统浏览器
  contents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) {
      shell.openExternal(details.url).catch(function () {});
    }
    return { action: 'deny' };
  });

  // 禁止窗口内跳转到站外地址（站内路由不受影响）
  contents.on('will-navigate', function (event, url) {
    if (url.startsWith(URL_BASE)) {
      return;
    }
    event.preventDefault();
    if (/^https?:/i.test(url)) {
      shell.openExternal(url).catch(function () {});
    }
  });

  // Ctrl+Q 退出应用
  contents.on('before-input-event', function (event, input) {
    if (input.type !== 'keyDown' || input.alt || input.shift || input.meta) {
      return;
    }
    if (input.control && String(input.key).toLowerCase() === 'q') {
      event.preventDefault();
      quitApp();
    }
  });

  try {
    if (serverState === 'running' || serverState === 'reused') {
      await mainWindow.loadURL(URL_BASE);
    } else if (serverState === 'failed') {
      await showStatusPage('failed', '服务端连续 ' + SERVER_MAX_FAILURES + ' 次启动失败。' + serverFailureDetail);
    } else {
      await showStatusPage('starting', '正在启动本地服务…');
    }
  } catch (err) {
    console.error('[fe] 加载界面失败:', err && err.message);
    showStatusPage('failed', '界面加载失败：' + String((err && err.message) || err));
  }
}

// ---------------------------------------------------------------------------
// 应用生命周期
// ---------------------------------------------------------------------------

// 日志初始化失败不影响应用启动
function initLogging() {
  try {
    return logger.init({ logDir: path.join(app.getPath('userData'), 'logs') });
  } catch (err) {
    return { logDir: '', logFile: '', keepFiles: logger.KEEP_FILES };
  }
}

function logStartupInfo() {
  const info = logger.getInfo();
  logger.info('[main] ' + APP_TITLE + ' 启动 version=' + app.getVersion() + ' packaged=' + app.isPackaged);
  logger.info('[main] electron=' + process.versions.electron + ' chrome=' + process.versions.chrome + ' node=' + process.versions.node);
  logger.info('[main] platform=' + process.platform + ' arch=' + process.arch + ' pid=' + process.pid);
  logger.info('[main] appPath=' + app.getAppPath());
  logger.info('[main] userData=' + app.getPath('userData'));
  logger.info('[main] argv=' + JSON.stringify(process.argv.slice(0, 8)) + ' hidden=' + START_HIDDEN);
  logger.info('[main] logFile=' + info.logFile + ' keep=' + info.keepFiles);
}

// 主进程兜底：未捕获异常只记录，不让窗口直接消失
process.on('uncaughtException', function (err) {
  logger.error('[main] 未捕获异常: ' + ((err && (err.stack || err.message)) || err));
});
process.on('unhandledRejection', function (reason) {
  logger.error('[main] 未处理的 Promise 拒绝: ' + String((reason && (reason.stack || reason.message)) || reason));
});

const logInfo = initLogging();
if (!logInfo.logDir) {
  try { process.stderr.write('[fe] 日志目录初始化失败，本轮不落盘\n'); } catch (err) { /* 忽略 */ }
}
logStartupInfo();

if (!app.requestSingleInstanceLock()) {
  logger.warn('[main] 已有实例在运行（未获得单实例锁），本次启动退出');
  app.quit();
} else {
  logger.info('[main] 已获得单实例锁');
  app.on('second-instance', function () {
    logger.info('[main] 检测到第二次启动，恢复并聚焦已有窗口');
    showWindow();
  });

  app.whenReady().then(async function () {
    nativeTheme.themeSource = 'dark';
    if (IS_WIN) {
      app.setAppUserModelId(APP_USER_MODEL_ID);
    }
    Menu.setApplicationMenu(null);
    logger.info('[main] 应用就绪，开始初始化桌面能力');

    registerIpcHandlers();
    createTray();
    registerGlobalShortcuts();

    startServerProcess();

    await createWindow();
    maybeEnsureFirewallOnStartup();
    logger.info('[main] 启动流程完成 serverState=' + serverState + ' serverPid=' + serverPid);

    app.on('activate', function () {
      logger.info('[main] activate');
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      } else {
        showWindow();
      }
    });
  }).catch(function (err) {
    logger.error('[main] 桌面端启动失败: ' + ((err && (err.stack || err.message)) || err));
  });

  app.on('window-all-closed', function () {
    logger.info('[main] 所有窗口已关闭');
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('before-quit', function () {
    isQuitting = true;
    logger.info('[main] 应用退出流程开始');
    saveWindowState();
    try {
      globalShortcut.unregisterAll();
    } catch (err) {
      // 忽略
    }
    if (tray) {
      try {
        tray.destroy();
      } catch (err) {
        // 忽略
      }
      tray = null;
    }
    stopServerProcess();
  });

  app.on('will-quit', function () {
    logger.info('[main] 应用即将退出，关闭日志');
    logger.close();
  });
}
