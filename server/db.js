import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_PATH = join(homedir(), '.furry-everpony', 'data', 'everpony.db');

/**
 * 用 Node 内置的 node:sqlite（Node 22+ / Electron 45 的 Node 24 都有），
 * 不引任何原生模块 —— 打包时不需要编译，也就不会因为 ABI 对不上而炸。
 * 这里补三个 better-sqlite3 风格的便捷方法：pragma / transaction / close。
 */
export function openDb(file = process.env.FE_DB || DEFAULT_PATH) {
  mkdirSync(dirname(file), { recursive: true });
  const raw = new DatabaseSync(file);

  let depth = 0;

  const db = {
    raw,
    exec: (sql) => raw.exec(sql),
    prepare: (sql) => raw.prepare(sql),
    pragma: (sql) => raw.exec(`PRAGMA ${sql}`),
    close: () => raw.close(),
    /**
     * 事务：外层用 BEGIN/COMMIT，嵌套层自动降级成 SAVEPOINT（和 better-sqlite3 行为一致）。
     * 任何异常都回滚，再原样抛出。
     */
    transaction: (fn) => (...args) => {
      const nested = depth > 0;
      const savepoint = `fe_sp_${depth}`;
      raw.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN');
      depth++;
      try {
        const out = fn(...args);
        depth--;
        raw.exec(nested ? `RELEASE ${savepoint}` : 'COMMIT');
        return out;
      } catch (err) {
        depth--;
        try {
          raw.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK');
        } catch {
          /* 回滚失败就让原异常继续抛 */
        }
        throw err;
      }
    },
  };

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      number        TEXT    NOT NULL UNIQUE,
      type          TEXT    NOT NULL DEFAULT 'user',
      nickname      TEXT    NOT NULL,
      bio           TEXT    NOT NULL DEFAULT '',
      password_hash TEXT,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT    PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      kind       TEXT    NOT NULL DEFAULT 'dm',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      account_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      PRIMARY KEY (conversation_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      sender_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      body            TEXT    NOT NULL,
      created_at      INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      from_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      message    TEXT    NOT NULL DEFAULT '',
      status     TEXT    NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friendships (
      a_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      b_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (a_id, b_id)
    );

    CREATE TABLE IF NOT EXISTS bot_links (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      url        TEXT    NOT NULL DEFAULT '',
      token      TEXT    NOT NULL DEFAULT '',
      enabled    INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS blocks (
      a_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      b_id       INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (a_id, b_id)
    );

    CREATE TABLE IF NOT EXISTS groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      number     TEXT    NOT NULL UNIQUE,
      name       TEXT    NOT NULL,
      owner_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      role       TEXT    NOT NULL DEFAULT 'member',
      joined_at  INTEGER NOT NULL,
      PRIMARY KEY (group_id, account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
    CREATE INDEX IF NOT EXISTS idx_members_account ON conversation_members(account_id);
    CREATE INDEX IF NOT EXISTS idx_req_to ON friend_requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_req_from ON friend_requests(from_id, status);
  `);

  if (!hasColumn(db, 'conversation_members', 'last_read_id')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0');
  }

  // Bot 账号：owner_id 指向创建它的个人号，access_token 给 OneBot 客户端鉴权
  if (!hasColumn(db, 'accounts', 'owner_id')) {
    db.exec('ALTER TABLE accounts ADD COLUMN owner_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE');
  }
  if (!hasColumn(db, 'accounts', 'access_token')) {
    db.exec('ALTER TABLE accounts ADD COLUMN access_token TEXT');
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_token ON accounts(access_token)');

  // Bot 是否公开出现在 Bot 广场
  if (!hasColumn(db, 'accounts', 'is_public')) {
    db.exec('ALTER TABLE accounts ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0');
  }

  // 头像：存成 256×256 的 PNG data URL，前端直接当 img src 用
  if (!hasColumn(db, 'accounts', 'avatar')) {
    db.exec("ALTER TABLE accounts ADD COLUMN avatar TEXT NOT NULL DEFAULT ''");
  }

  // 资料卡：自定义背景 + 公开照片墙（JSON 数组，存 data URL 或 /uploads 地址）
  if (!hasColumn(db, 'accounts', 'card_bg')) {
    db.exec("ALTER TABLE accounts ADD COLUMN card_bg TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'accounts', 'photos')) {
    db.exec("ALTER TABLE accounts ADD COLUMN photos TEXT NOT NULL DEFAULT '[]'");
  }

  // 群会话：一个群对应一个 kind='group' 的会话
  if (!hasColumn(db, 'friendships', 'remark')) {
    db.exec("ALTER TABLE friendships ADD COLUMN remark TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'conversation_members', 'pinned')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'groups', 'announcement')) {
    db.exec("ALTER TABLE groups ADD COLUMN announcement TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'messages', 'kind')) {
    db.exec("ALTER TABLE messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'");
  }
  if (!hasColumn(db, 'messages', 'recalled')) {
    db.exec("ALTER TABLE messages ADD COLUMN recalled INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, 'groups', 'conversation_id')) {
    db.exec('ALTER TABLE groups ADD COLUMN conversation_id INTEGER REFERENCES conversations(id)');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS bot_models (
      account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
      base_url TEXT NOT NULL DEFAULT '',
      api_key TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      persona TEXT NOT NULL DEFAULT '',
      temperature REAL NOT NULL DEFAULT 0.7,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )
  `);

  /* ---------- v0.10.0：消息引用、表情回应、收藏、免打扰、在线状态、群管理 ---------- */
  if (!hasColumn(db, 'messages', 'reply_to_id')) {
    db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER');
  }
  if (!hasColumn(db, 'messages', 'meta')) {
    db.exec("ALTER TABLE messages ADD COLUMN meta TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'conversation_members', 'muted')) {
    db.exec('ALTER TABLE conversation_members ADD COLUMN muted INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'accounts', 'status')) {
    db.exec("ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'online'");
  }
  /* ---------- 纯网页版：邮箱登录 + 自选号码 + Bot 标签 ---------- */
  if (!hasColumn(db, 'accounts', 'email')) {
    db.exec('ALTER TABLE accounts ADD COLUMN email TEXT');
  }
  if (!hasColumn(db, 'accounts', 'tags')) {
    db.exec("ALTER TABLE accounts ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
  }
  /* 邮箱唯一：老账号（号码登录时代建的）没有邮箱，NULL 不参与唯一约束 */
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email) WHERE email IS NOT NULL AND email <> ''",
  );
  if (!hasColumn(db, 'friendships', 'group_id')) {
    db.exec('ALTER TABLE friendships ADD COLUMN group_id INTEGER');
  }
  if (!hasColumn(db, 'friendships', 'special')) {
    db.exec('ALTER TABLE friendships ADD COLUMN special INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'group_members', 'nickname')) {
    db.exec("ALTER TABLE group_members ADD COLUMN nickname TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'group_members', 'mute_until')) {
    db.exec('ALTER TABLE group_members ADD COLUMN mute_until INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'group_members', 'announcement_read_at')) {
    db.exec('ALTER TABLE group_members ADD COLUMN announcement_read_at INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'groups', 'mute_all')) {
    db.exec('ALTER TABLE groups ADD COLUMN mute_all INTEGER NOT NULL DEFAULT 0');
  }
  if (!hasColumn(db, 'groups', 'announcement_updated_at')) {
    db.exec('ALTER TABLE groups ADD COLUMN announcement_updated_at INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      emoji      TEXT    NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, account_id, emoji)
    );

    CREATE TABLE IF NOT EXISTS message_deletions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (message_id, account_id)
    );

    CREATE TABLE IF NOT EXISTS favorites (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      UNIQUE (account_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS friend_groups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name       TEXT    NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_files (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id    INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      uploader_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      name        TEXT    NOT NULL,
      url         TEXT    NOT NULL,
      size        INTEGER NOT NULL DEFAULT 0,
      created_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_requests (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id   INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      from_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      to_id      INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      kind       TEXT    NOT NULL DEFAULT 'invite',
      status     TEXT    NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_react_msg ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_del_acct ON message_deletions(account_id);
    CREATE INDEX IF NOT EXISTS idx_fav_acct ON favorites(account_id, id);
    CREATE INDEX IF NOT EXISTS idx_fgroup_acct ON friend_groups(account_id);
    CREATE INDEX IF NOT EXISTS idx_greq_to ON group_requests(to_id, status);
    CREATE INDEX IF NOT EXISTS idx_gfiles_group ON group_files(group_id, id);
  `);

  /* ---------- v0.10.10：实例互联（远端联系人 + 投递队列） ---------- */
  if (!hasColumn(db, 'accounts', 'remote_addr')) {
    db.exec("ALTER TABLE accounts ADD COLUMN remote_addr TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'accounts', 'remote_instance')) {
    db.exec("ALTER TABLE accounts ADD COLUMN remote_instance TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'accounts', 'remote_secret')) {
    db.exec("ALTER TABLE accounts ADD COLUMN remote_secret TEXT NOT NULL DEFAULT ''");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS instance_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS federation_outbox (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      conv_id    INTEGER NOT NULL,
      from_number TEXT NOT NULL,
      to_number  TEXT NOT NULL,
      to_addr    TEXT NOT NULL,
      to_secret  TEXT NOT NULL,
      payload    TEXT NOT NULL,
      attempts   INTEGER NOT NULL DEFAULT 0,
      next_at    INTEGER NOT NULL,
      last_error TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fed_outbox_due ON federation_outbox(next_at);
  `);

  /* ---------- v0.10.21：平台管理员与封禁 ---------- */
  if (!hasColumn(db, 'accounts', 'is_admin')) {
    db.exec("ALTER TABLE accounts ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, 'accounts', 'banned')) {
    db.exec("ALTER TABLE accounts ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
  }
  if (!hasColumn(db, 'accounts', 'ban_reason')) {
    db.exec("ALTER TABLE accounts ADD COLUMN ban_reason TEXT NOT NULL DEFAULT ''");
  }

  /* ---------- v0.10.24：注册审核 + 登录 IP/设备 + 防攻击 ---------- */
  /* 注册后是否已通过审核：1 = 正常可用，0 = 等站长放行（老库默认 1，不影响现有账号） */
  if (!hasColumn(db, 'accounts', 'approved')) {
    db.exec('ALTER TABLE accounts ADD COLUMN approved INTEGER NOT NULL DEFAULT 1');
  }
  /* 会话记下登录来源，管理台能看到「谁在什么设备上登录」 */
  if (!hasColumn(db, 'sessions', 'ip')) {
    db.exec("ALTER TABLE sessions ADD COLUMN ip TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'sessions', 'ua')) {
    db.exec("ALTER TABLE sessions ADD COLUMN ua TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'sessions', 'device')) {
    db.exec("ALTER TABLE sessions ADD COLUMN device TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'accounts', 'last_login_ip')) {
    db.exec("ALTER TABLE accounts ADD COLUMN last_login_ip TEXT NOT NULL DEFAULT ''");
  }
  if (!hasColumn(db, 'accounts', 'last_login_at')) {
    db.exec('ALTER TABLE accounts ADD COLUMN last_login_at INTEGER NOT NULL DEFAULT 0');
  }

  db.exec(`
    /* 站点级开关：registerMode = open / approval / closed */
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    /* 手动封禁的 IP（爬虫、刷号、爆破） */
    CREATE TABLE IF NOT EXISTS ip_bans (
      ip         TEXT PRIMARY KEY,
      reason     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    /* 登录流水：成功的和失败的都记，用来识别撞库与异常设备 */
    CREATE TABLE IF NOT EXISTS login_logs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER,
      number     TEXT NOT NULL DEFAULT '',
      ip         TEXT NOT NULL DEFAULT '',
      ua         TEXT NOT NULL DEFAULT '',
      device     TEXT NOT NULL DEFAULT '',
      ok         INTEGER NOT NULL DEFAULT 0,
      reason     TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_login_logs_created ON login_logs(created_at);
    CREATE INDEX IF NOT EXISTS idx_login_logs_ip ON login_logs(ip);
    CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
  `);
}

