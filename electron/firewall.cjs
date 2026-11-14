'use strict';

// Furry Everpony 防火墙辅助模块
// 作用：检测 / 添加 Windows 防火墙的 7788 端口入站放行规则（Private 配置）。
// netsh 加规则需要管理员权限：先试非提权，失败再走 PowerShell Start-Process -Verb RunAs 弹一次 UAC。
// 桌面端已有程序级放行规则（安装包 exe），端口规则用于兜底（换安装路径 / 重装 / 移动 exe 后仍有效）。

const { execFile } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const RULE_NAME = 'Furry Everpony LAN 7788';
const RULE_DESCRIPTION = 'Furry Everpony 局域网访问 7788（桌面端自动添加）';
const MANUAL_COMMAND =
  'netsh advfirewall firewall add rule name="Furry Everpony LAN 7788" ' +
  'dir=in action=allow protocol=TCP localport=7788 profile=any';

const SHOW_ARGS = ['advfirewall', 'firewall', 'show', 'rule', 'name=' + RULE_NAME];
const ADD_ARGS = [
  'advfirewall', 'firewall', 'add', 'rule',
  'name=' + RULE_NAME,
  'dir=in',
  'action=allow',
  'protocol=TCP',
  'localport=7788',
  // profile=any：公用网络（网吧/公司 Wi-Fi/手机热点）也要放行，否则公网 IPv6 直连会被系统挡在门外。
  // 这条规则同时覆盖 IPv4 与 IPv6（netsh 不区分地址族），跨网络加好友必须靠它。
  'profile=any',
  'description=' + RULE_DESCRIPTION,
];

const UAC_CANCEL_RE = /取消|cancel/i;

// 统一的子进程封装：永不 reject，把退出码 / 输出 / 错误都交给调用方判断
function runProcess(file, args, timeoutMs) {
  return new Promise(function (resolve) {
    let settled = false;
    function finish(result) {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    }
    try {
      execFile(file, args, {
        windowsHide: true,
        timeout: timeoutMs,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
      }, function (err, stdout, stderr) {
        if (err) {
          finish({
            code: typeof err.code === 'number' ? err.code : 1,
            stdout: String(stdout || ''),
            stderr: String(stderr || ''),
            error: String((err && err.message) || err || ''),
            timedOut: err.killed === true,
          });
          return;
        }
        finish({
          code: 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: '',
          timedOut: false,
        });
      });
    } catch (err) {
      finish({ code: 1, stdout: '', stderr: '', error: String((err && err.message) || err), timedOut: false });
    }
  });
}

function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

// 规则是否已存在：netsh show 命中规则时退出码为 0，没有匹配规则时退出码为 1
function isRulePresent(runner) {
  if (!IS_WIN) {
    return Promise.resolve(false);
  }
  const run = typeof runner === 'function' ? runner : runProcess;
  return run('netsh.exe', SHOW_ARGS, 8000).then(function (result) {
    return result.code === 0;
  }).catch(function () {
    return false;
  });
}

// 非提权尝试添加（应用本身以管理员身份运行时可以成功）
function addRuleDirect(runner) {
  const run = typeof runner === 'function' ? runner : runProcess;
  return run('netsh.exe', ADD_ARGS, 15000).then(function (result) {
    return {
      ok: result.code === 0,
      error: result.code === 0 ? '' : (result.error || 'netsh 添加规则失败'),
    };
  });
}

// PowerShell 单引号字符串转义
function psQuote(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

// 把参数拼成一条 Windows 命令行（给 Start-Process -ArgumentList 用，带空格的参数要加引号）
function buildArgumentLine(args) {
  return args.map(function (arg) {
    return /[\s"]/.test(arg) ? '"' + String(arg).replace(/"/g, '\\"') + '"' : arg;
  }).join(' ');
}

function buildElevationScript() {
  const argLine = buildArgumentLine(ADD_ARGS);
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$argLine = ' + psQuote(argLine),
    "$netsh = Join-Path $env:SystemRoot 'System32\\netsh.exe'",
    '$proc = Start-Process -FilePath $netsh -ArgumentList $argLine -Verb RunAs -PassThru -Wait',
    'if ($null -eq $proc) { exit 1 }',
    'exit $proc.ExitCode',
  ];
  return lines.join('; ');
}

// 提权尝试：弹一次 UAC（用户取消会失败），返回 ok / cancelled
function addRuleElevated(runner) {
  if (!IS_WIN) {
    return Promise.resolve({ ok: false, cancelled: false, error: '当前平台不需要防火墙规则' });
  }
  const run = typeof runner === 'function' ? runner : runProcess;
  let encoded = '';
  try {
    encoded = Buffer.from(buildElevationScript(), 'utf16le').toString('base64');
  } catch (err) {
    return Promise.resolve({ ok: false, cancelled: false, error: String((err && err.message) || err) });
  }
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-EncodedCommand', encoded,
  ];
  return run('powershell.exe', args, 120000).then(function (result) {
    const detail = [result.stderr, result.stdout, result.error].join(' ');
    return {
      ok: result.code === 0,
      cancelled: result.code !== 0 && UAC_CANCEL_RE.test(detail),
      error: result.code === 0 ? '' : (result.stderr || result.error || '提权添加防火墙规则失败'),
    };
  }).catch(function (err) {
    return { ok: false, cancelled: false, error: String((err && err.message) || err) };
  });
}

// 提权进程退出后防火墙服务可能有短暂延迟，重试确认几次
async function confirmPresent(runner) {
  for (let i = 0; i < 4; i += 1) {
    if (await isRulePresent(runner)) {
      return true;
    }
    if (i < 3) {
      await delay(400);
    }
  }
  return false;
}

// 对外主函数：检测规则，缺失时尝试添加（先非提权，再 UAC）
// options.interactive=false 用于启动时静默尝试（仍可能由系统弹 UAC，由调用方决定是否调用）
async function ensureFirewallRule(options, runner) {
  const opts = options && typeof options === 'object' ? options : {};
  const run = typeof runner === 'function' ? runner : runProcess;
  const base = {
    supported: IS_WIN,
    ruleName: RULE_NAME,
    manualCommand: MANUAL_COMMAND,
  };

  if (!IS_WIN) {
    return Object.assign(base, {
      ok: true,
      exists: false,
      added: false,
      needAdmin: false,
      reason: 'unsupported',
    });
  }

  if (await isRulePresent(run)) {
    return Object.assign(base, { ok: true, exists: true, added: false, needAdmin: false, reason: 'exists' });
  }

  const direct = await addRuleDirect(run);
  if (direct.ok && await confirmPresent(run)) {
    return Object.assign(base, {
      ok: true,
      exists: true,
      added: true,
      elevated: false,
      needAdmin: false,
      reason: 'added',
    });
  }

  const elevated = await addRuleElevated(run);
  if (elevated.ok && await confirmPresent(run)) {
    return Object.assign(base, {
      ok: true,
      exists: true,
      added: true,
      elevated: true,
      needAdmin: false,
      reason: 'added',
    });
  }

  return Object.assign(base, {
    ok: false,
    exists: false,
    added: false,
    needAdmin: true,
    cancelled: elevated.cancelled === true,
    interactive: opts.interactive !== false,
    error: elevated.error || direct.error || '添加防火墙规则失败，请手动执行命令',
  });
}

module.exports = {
  RULE_NAME: RULE_NAME,
  MANUAL_COMMAND: MANUAL_COMMAND,
  isRulePresent: isRulePresent,
  ensureFirewallRule: ensureFirewallRule,
  // 便于自检脚本替换子进程执行器
  runProcess: runProcess,
};
