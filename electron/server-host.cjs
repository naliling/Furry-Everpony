'use strict';

// Furry Everpony 服务端子进程入口
// 由主进程用 ELECTRON_RUN_AS_NODE=1 拉起；服务端崩了只影响子进程，不会带走界面。
// stdout/stderr 由主进程收集写入日志；启动结果通过 IPC message 回报主进程。

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ROOT = process.env.FE_APP_ROOT || path.join(__dirname, '..');
const PORT = Number(process.env.FE_PORT || 7788);
const HOST = process.env.FE_HOST || '127.0.0.1';

function send(message) {
  if (process.send) {
    try { process.send(message); } catch (err) { /* 主进程不在时忽略 */ }
  }
}

function logLine(text) {
  try { process.stdout.write('[fe-server] ' + text + '\n'); } catch (err) { /* 忽略 */ }
}

function reportStartupError(err) {
  const message = String((err && err.message) || err);
  logLine('启动失败: ' + message);
  send({ type: 'startup-error', message: message });
  setTimeout(function () { process.exit(1); }, 100);
}

async function main() {
  logLine('启动中 pid=' + process.pid + ' host=' + HOST + ' port=' + PORT);
  const entry = path.join(APP_ROOT, 'server', 'index.js');
  let mod = null;
  try {
    mod = await import(pathToFileURL(entry).href);
  } catch (err) {
    logLine('加载服务端模块失败: ' + ((err && err.stack) || err));
    reportStartupError(err);
    return;
  }
  if (!mod || typeof mod.buildServer !== 'function') {
    reportStartupError(new Error('服务端模块没有导出 buildServer()'));
    return;
  }
  let instance = null;
  try {
    instance = mod.buildServer();
  } catch (err) {
    logLine('创建服务端实例失败: ' + ((err && err.stack) || err));
    reportStartupError(err);
    return;
  }
  try {
    await instance.listen({ port: PORT, host: HOST });
    logLine('监听成功 pid=' + process.pid + ' http://' + HOST + ':' + PORT + '/');
    send({ type: 'listening', pid: process.pid, host: HOST, port: PORT });
  } catch (err) {
    // 端口被占用：说明已有实例在跑，交给主进程复用，不算启动失败
    if (err && err.code === 'EADDRINUSE') {
      logLine('端口 ' + PORT + ' 已被占用，交给主进程复用已有实例');
      send({ type: 'port-in-use', port: PORT });
      setTimeout(function () { process.exit(0); }, 100);
      return;
    }
    logLine('监听失败: ' + ((err && err.stack) || err));
    reportStartupError(err);
    return;
  }

  const shutdown = function () {
    logLine('收到停止信号，正在关闭服务端');
    Promise.resolve()
      .then(function () { return instance.close(); })
      .catch(function () { /* 忽略 */ })
      .then(function () { process.exit(0); });
    setTimeout(function () { process.exit(0); }, 2000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('disconnect', shutdown);
  process.on('uncaughtException', function (err) {
    logLine('未捕获异常: ' + ((err && err.stack) || err));
    process.exit(1);
  });
  process.on('unhandledRejection', function (reason) {
    logLine('未处理的 Promise 拒绝: ' + String((reason && (reason.stack || reason.message)) || reason));
  });
}

main().catch(function (err) {
  logLine('启动致命错误: ' + ((err && err.stack) || err));
  reportStartupError(err);
});
