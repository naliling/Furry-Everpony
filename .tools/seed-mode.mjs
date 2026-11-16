/* 测试库预置注册模式：老测试脚本假设注册即登录，需要 open 模式 */
import { openDb } from '../server/db.js';
const file = process.argv[2];
const mode = process.argv[3] || 'open';
const db = openDb(file);
db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('registerMode', mode);
db.close();
console.log('registerMode=' + mode + ' -> ' + file);
