import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// Starts the real app against a database written by the previous (sql.js) release, so an upgrade
// path regression cannot slip through unnoticed.
const directory = mkdtempSync(join(tmpdir(), 'deepchan-upgrade-'));
cpSync(join(process.cwd(), 'tests/fixtures/legacy-chat.sqlite'), join(directory, 'chat.sqlite'));
const env = { ...process.env, DEEPCHAN_DATA_DIR: directory };
delete env.ELECTRON_RUN_AS_NODE; delete env.DEEPCHAN_DEV_URL;
const desktop = await electron.launch({ executablePath: electronPath, args: ['.'], env });
try {
  const page = await desktop.firstWindow();
  const state = await page.evaluate(() => window.deepchan.load());
  assert.equal(state.conversations.length, 1);
  assert.equal(state.settings.connections[0].name, '旧版连接');
  assert.equal(state.conversations[0].messages[0].text, '旧库里的提问');
  assert.equal(state.conversations[0].messages[1].text, '旧库里的回答');
  assert.equal(await page.locator('.conversation-item').count(), 1, '旧会话必须仍然出现在列表里');
  const requests = readdirSync(join(directory, 'requests'));
  assert.equal(requests.length, 1, '旧库里的请求记录应迁移为文件');
  assert.equal(JSON.parse(readFileSync(join(directory, 'requests', requests[0]), 'utf8'))[0].url, 'https://legacy.example/v1/chat/completions');
} finally { await desktop.close(); }

// The single state document must have become one row per entity, with the original database kept
// beside it in case the migration ever needs to be inspected.
assert.ok(existsSync(join(directory, 'chat.sqlite.pre-normalize')), '迁移前应保留一份数据库副本');
const db = new DatabaseSync(join(directory, 'chat.sqlite'));
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => String(row.name));
for (const table of ['meta', 'conversations', 'branches', 'messages', 'secrets']) assert.ok(tables.includes(table), `迁移后应有 ${table} 表`);
assert.ok(!tables.includes('state'), '迁移后不应再有整份状态表');
assert.equal(db.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
assert.equal(db.prepare('SELECT count(*) AS n FROM branches').get().n, 1);
assert.ok(JSON.parse(db.prepare("SELECT value FROM meta WHERE key='settings'").get().value).connections.length === 1);
db.close();
console.log('PASS: a database written by the sql.js release opens, keeps its data, migrates request records and is normalised into one row per entity.');
