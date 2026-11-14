'use strict';

// Furry Everpony 桌面端日志模块
// 主进程 console 输出、服务端子进程 stdout/stderr、关键事件全部写到
// userData/logs/app-YYYYMMDD.log，按天滚动，保留最近 7 个日志文件。

const fs = require('node:fs');
const path = require('node:path');

const KEEP_FILES = 7;

let logDir = '';
let logFile = '';
let stream = null;
let currentDate = '';
let consoleHooked = false;
let writeFailureLogged = false;

function pad(value, width) {
  return String(value).padStart(width || 2, '0');
}

function dateStamp(date) {
  const d = date || new Date();
  return '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate());
}

function timestamp(date) {
  const d = date || new Date();
  return '' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) +
    '.' + pad(d.getMilliseconds(), 3);
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.stack || (value.name + ': ' + value.message);
  if (value === undefined) return 'undefined';
  try {
    const seen = new WeakSet();
    const json = JSON.stringify(value, function (key, val) {
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      return val;
    });
    return json === undefined ? String(value) : json;
  } catch (err) {
    return String(value);
  }
}

function formatArgs(args) {
  return args.map(safeStringify).join(' ');
}

// 只保留最近 KEEP_FILES 个按天日志，超出部分从最旧开始删
function pruneOldFiles() {
  let names = [];
  try {
    names = fs.readdirSync(logDir);
  } catch (err) {
    return;
  }
  const files = names.filter(function (name) { return /^app-\d{8}\.log$/.test(name); }).sort();
  while (files.length > KEEP_FILES) {
    const oldName = files.shift();
    try { fs.unlinkSync(path.join(logDir, oldName)); } catch (err) { /* 忽略 */ }
  }
}

function openStream(file) {
  try {
    // 先同步建文件：createWriteStream 异步打开，清理旧日志时还看不到当天文件
    fs.closeSync(fs.openSync(file, 'a'));
    stream = fs.createWriteStream(file, { flags: 'a' });
    stream.on('error', function () { stream = null; });
  } catch (err) {
    stream = null;
  }
}

// 跨天时换新文件；当前实现按写入时检查日期，长时间挂机也不会写错文件
function rotateIfNeeded() {
  const today = dateStamp();
  if (stream && today === currentDate) return;
  if (stream) {
    try { stream.end(); } catch (err) { /* 忽略 */ }
    stream = null;
  }
  currentDate = today;
  logFile = path.join(logDir, 'app-' + today + '.log');
  openStream(logFile);
  // 新文件建好后再清理，保证「当天 + 最近 6 天」正好 7 个
  pruneOldFiles();
}

function writeRaw(level, source, text) {
  if (!logDir || text === undefined || text === null || text === '') return;
  try {
    rotateIfNeeded();
  } catch (err) {
    return;
  }
  if (!stream) return;
  const tag = source ? '[' + source + '] ' : '';
  const lines = String(text).split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (!lines.length) return;
  const chunk = lines.map(function (line) {
    return timestamp() + ' [' + level + '] ' + tag + line + '\n';
  }).join('');
  try {
    stream.write(chunk);
  } catch (err) {
    if (!writeFailureLogged) {
      writeFailureLogged = true;
      try { process.stderr.write('[fe-log] 写日志失败: ' + (err && err.message) + '\n'); } catch (e) { /* 忽略 */ }
    }
  }
}

// 劫持主进程 console：终端照常输出，同时写入日志文件
function hookConsole() {
  if (consoleHooked) return;
  consoleHooked = true;
  const levels = [['log', 'info'], ['info', 'info'], ['warn', 'warn'], ['error', 'error'], ['debug', 'debug']];
  levels.forEach(function (pair) {
    const method = pair[0];
    const level = pair[1];
    const original = typeof console[method] === 'function' ? console[method].bind(console) : function () {};
    console[method] = function () {
      const args = Array.prototype.slice.call(arguments);
      try { original.apply(null, args); } catch (err) { /* 忽略 */ }
      writeRaw(level, 'console', formatArgs(args));
    };
  });
}

function logAt(level) {
  return function () {
    writeRaw(level, 'main', formatArgs(Array.prototype.slice.call(arguments)));
  };
}

const info = logAt('info');
const warn = logAt('warn');
const error = logAt('error');
const debug = logAt('debug');

function write(level, source, text) {
  writeRaw(level || 'info', source || 'main', text);
}

function init(options) {
  if (stream) return getInfo();
  const dir = options && typeof options.logDir === 'string' ? options.logDir : '';
  if (!dir) return getInfo();
  logDir = dir;
  try {
    fs.mkdirSync(logDir, { recursive: true });
  } catch (err) {
    logDir = '';
    return getInfo();
  }
  rotateIfNeeded();
  pruneOldFiles();
  hookConsole();
  info('[log] 日志已启用 file=' + logFile + ' keep=' + KEEP_FILES);
  return getInfo();
}

function getInfo() {
  return {
    logDir: logDir,
    logFile: logFile || (logDir ? path.join(logDir, 'app-' + dateStamp() + '.log') : ''),
    keepFiles: KEEP_FILES,
  };
}

function close() {
  if (stream) {
    try { stream.end(); } catch (err) { /* 忽略 */ }
    stream = null;
  }
}

module.exports = { init, info, warn, error, debug, write, getInfo, close, KEEP_FILES };
