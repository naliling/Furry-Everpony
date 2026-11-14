import { createWriteStream, mkdirSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 文件日志。
 *
 * 以前应用一行日志都不落盘，用户报「时不时稳定性不行」时完全无从查起。
 * 现在统一写 <数据库目录>/logs/app-YYYYMMDD.log，按天滚动，默认保留 7 天。
 * 写日志本身永远不能把进程搞崩，所以每一处都 try/catch。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export const DEFAULT_LOG_DIR =
  process.env.FE_LOG_DIR ||
  join(
    dirname(process.env.FE_DB || join(homedir(), '.furry-everpony', 'data', 'everpony.db')),
    'logs',
  );

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

export function createLogger({
  dir = DEFAULT_LOG_DIR,
  level = process.env.FE_LOG_LEVEL || 'info',
  name = 'server',
  keepDays = 7,
  echo = true,
} = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let stream = null;
  let current = '';

  function prune() {
    try {
      const files = readdirSync(dir).filter((f) => /^app-\d{8}\.log$/.test(f)).sort();
      while (files.length > keepDays) {
        const f = files.shift();
        try {
          unlinkSync(join(dir, f));
        } catch {
          /* 删不掉就算了 */
        }
      }
    } catch {
      /* 目录还不存在 */
    }
  }

  function ensure() {
    const key = dayKey();
    if (stream && key === current) return stream;
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      /* ignore */
    }
    try {
      if (stream) stream.end();
      stream = createWriteStream(join(dir, `app-${key}.log`), { flags: 'a' });
      stream.on('error', () => {
        stream = null;
      });
      current = key;
      prune();
    } catch {
      stream = null;
    }
    return stream;
  }

  function write(levelName, args) {
    if ((LEVELS[levelName] ?? 0) < min) return;
    const text = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.stack || a.message;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
    const line = `[${new Date().toISOString()}] [${levelName.toUpperCase()}] [${name}] ${text}\n`;
    if (echo) {
      const out = levelName === 'error' || levelName === 'warn' ? console.error : console.log;
      out(line.trimEnd());
    }
    const s = ensure();
    if (s) {
      try {
        s.write(line);
      } catch {
        /* ignore */
      }
    }
  }

  return {
    dir,
    debug: (...a) => write('debug', a),
    info: (...a) => write('info', a),
    warn: (...a) => write('warn', a),
    error: (...a) => write('error', a),
    file: () => (stream ? join(dir, `app-${current}.log`) : join(dir, `app-${dayKey()}.log`)),
    close: () => {
      try {
        stream?.end();
      } catch {
        /* ignore */
      }
    },
  };
}
