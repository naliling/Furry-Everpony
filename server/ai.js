import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Bot 内置模型：自带 key、自带地址、自带人设，直接调 OpenAI 兼容的 /chat/completions。
 *
 * 设计取舍：
 * - 不引任何 SDK，就 node 自带的 fetch，少一个依赖就少一个打包坑。
 * - api_key 存在本地 SQLite 里，对外只回打码后的内容，避免截图/日志泄露。
 * - 回复失败只写日志，不往聊天里塞错误消息（会把用户吓到）。
 * - Bot 和 Bot 之间默认不自动对话，防止两个模型无限对刷烧钱。
 */

const MAX_HISTORY = 20;
const TIMEOUT_MS = 60_000;
// 生成期间续期「正在输入」的心跳间隔：模型慢的时候提示要一直挂着，不能先消失
const HEARTBEAT_MS = 4000;
const MAX_REPLY_CHARS = 2000;

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 8) return '••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}

function defaultPersona(bot) {
  return [
    `你是「${bot.nickname}」，一个住在 Furry Everpony 里的 Bot。`,
    '你在一对一私聊里和用户说话。',
    '说话自然、简短，像在聊天软件里发消息，一次一两句就够。',
    '不要用 Markdown，不要列清单，不要用「首先/其次」这种书面腔。',
    '不知道就说不知道，不要编。',
  ].join('\n');
}

export function createAi({ db }) {
  // 同一个 Bot 的回复串行执行，避免用户连发三条时开出三个请求互相踩
  const queues = new Map();
  // 记录每个会话最后回复过的消息 id，防止重复回复
  const lastReplied = new Map();

  const getStmt = db.prepare('SELECT * FROM bot_models WHERE account_id = ?');

  function getConfig(botId) {
    return getStmt.get(botId) || null;
  }

  function publicConfig(botId) {
    const row = getConfig(botId);
    if (!row) {
      return {
        base_url: '',
        api_key: '',
        has_key: false,
        model: '',
        persona: '',
        temperature: 0.8,
        enabled: false,
        configured: false,
      };
    }
    return {
      base_url: row.base_url || '',
      api_key: maskKey(row.api_key || ''),
      has_key: !!row.api_key,
      model: row.model || '',
      persona: row.persona || '',
      temperature: Number(row.temperature ?? 0.8),
      enabled: !!row.enabled,
      configured: !!(row.base_url && row.api_key && row.model),
    };
  }

  /**
   * 保存配置。api_key 有三种情况：
   * - 不传：保留原来的
   * - 传打码串（含 ••••）：也保留原来的
   * - 传空串：清空
   */
  function saveConfig(botId, patch) {
    const cur = getConfig(botId) || {
      base_url: '',
      api_key: '',
      model: '',
      persona: '',
      temperature: 0.8,
      enabled: 0,
    };
    let apiKey = cur.api_key || '';
    if (typeof patch.api_key === 'string' && !patch.api_key.includes('••••')) {
      apiKey = patch.api_key.trim();
    }
    const next = {
      base_url: (patch.base_url ?? cur.base_url ?? '').trim(),
      api_key: apiKey,
      model: (patch.model ?? cur.model ?? '').trim(),
      persona: patch.persona ?? cur.persona ?? '',
      temperature: Number(patch.temperature ?? cur.temperature ?? 0.8),
      enabled: patch.enabled === undefined ? cur.enabled : patch.enabled ? 1 : 0,
    };
    db.prepare(
      `INSERT INTO bot_models (account_id, base_url, api_key, model, persona, temperature, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         base_url = excluded.base_url,
         api_key = excluded.api_key,
         model = excluded.model,
         persona = excluded.persona,
         temperature = excluded.temperature,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
    ).run(
      botId,
      next.base_url,
      next.api_key,
      next.model,
      next.persona,
      next.temperature,
      next.enabled,
      Date.now(),
    );
    return publicConfig(botId);
  }

  async function chat({ baseUrl, apiKey, model, temperature, messages }) {
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model, temperature, messages, stream: false }),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        throw new Error(`模型接口返回 ${res.status}：${text.slice(0, 200)}`);
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        throw new Error(`模型接口返回的不是 JSON：${text.slice(0, 200)}`);
      }
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('模型返回了空内容');
      }
      return content.trim().slice(0, MAX_REPLY_CHARS);
    } finally {
      clearTimeout(timer);
    }
  }

  function historyFor(conversationId, botId) {
    const rows = db
      .prepare(
        `SELECT sender_id, body, kind FROM messages
         WHERE conversation_id = ? AND recalled = 0
         ORDER BY id DESC LIMIT ?`,
      )
      .all(conversationId, MAX_HISTORY);
    return rows
      .reverse()
      .map((r) => ({
        role: r.sender_id === botId ? 'assistant' : 'user',
        content: r.kind === 'image' ? '[发了一张图片]' : r.body,
      }));
  }

  async function doReply({ convId, bot, sender, onProgress }) {
    const cfg = getConfig(bot.id);
    if (!cfg || !cfg.enabled || !cfg.base_url || !cfg.api_key || !cfg.model) return null;
    // 不让 Bot 互相自动对话（默认关），否则两个模型会无限对刷
    if (sender.type === 'bot') return null;

    const messages = [
      { role: 'system', content: cfg.persona?.trim() || defaultPersona(bot) },
      ...historyFor(convId, bot.id),
    ];

    // 先亮一次，再每 4 秒续期：15 秒的提示撑不住 20 秒的模型，撑不住就会看起来像卡死
    const beat = () => {
      if (!onProgress) return;
      try {
        onProgress();
      } catch {
        /* 续期失败不影响回复本身 */
      }
    };
    beat();
    const beatTimer = onProgress ? setInterval(beat, HEARTBEAT_MS) : null;
    let content;
    try {
      content = await chat({
        baseUrl: cfg.base_url,
        apiKey: cfg.api_key,
        model: cfg.model,
        temperature: Number(cfg.temperature ?? 0.8),
        messages,
      });
    } finally {
      if (beatTimer) clearInterval(beatTimer);
    }

    // 落库：以 Bot 自己的身份发出去
    // 回复期间用户可能又发了消息，这里重新读一次最新 id 作为 last_read
    const info = db
      .prepare('INSERT INTO messages (conversation_id, sender_id, body, created_at, kind) VALUES (?, ?, ?, ?, ?)')
      .run(convId, bot.id, content, Date.now(), 'text');
    const messageId = Number(info.lastInsertRowid);
    db.prepare(
      'UPDATE conversation_members SET last_read_id = ? WHERE conversation_id = ? AND account_id = ?',
    ).run(messageId, convId, bot.id);
    return { id: messageId, body: content };
  }

  /**
   * 排队回复：同一会话的请求串行。
   * 返回 Promise，出错只打印日志，不抛给调用方。
   */
  function maybeReply({ convId, bot, sender, sourceMessageId, onProgress, onError }) {
    const key = `${convId}:${bot.id}`;
    if (sourceMessageId && lastReplied.get(key) === sourceMessageId) return Promise.resolve(null);
    if (sourceMessageId) lastReplied.set(key, sourceMessageId);

    const prev = queues.get(key) || Promise.resolve();
    const next = prev
      .then(() => doReply({ convId, bot, sender, onProgress }))
      .then((out) => {
        if (out) console.log(`[ai] ${bot.number} 回复了 ${convId}#${out.id}`);
        return out;
      })
      .catch((err) => {
        console.warn(`[ai] ${bot.number} 回复失败：${err.message}`);
        // 失败也要有个收尾，否则「正在输入」消失后就彻底没动静了
        if (onError) {
          try {
            onError(err);
          } catch {
            /* 提示失败不影响主流程 */
          }
        }
        return null;
      })
      .finally(() => {
        if (queues.get(key) === next) queues.delete(key);
      });
    queues.set(key, next);
    return next;
  }

  return { getConfig, publicConfig, saveConfig, maybeReply, chat };
}
