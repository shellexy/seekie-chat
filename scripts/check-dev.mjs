import { _electron } from 'playwright';
import electronPath from 'electron';
import { createServer } from 'vite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
// Any free port: a dev server may already be running on the configured one, and this check only
// needs the development page to be served by Vite.
const server = await createServer({ server: { port: 0, strictPort: false } }); await server.listen();
const devUrl = (server.resolvedUrls?.local?.[0] || 'http://127.0.0.1:5173').replace(/\/$/, '');
const env = { ...process.env, DEEPCHAN_DEV_URL: devUrl, DEEPCHAN_DATA_DIR: mkdtempSync(join(tmpdir(), 'deepchan-dev-check-')) }; delete env.ELECTRON_RUN_AS_NODE;
let desktop;
try {
  desktop = await _electron.launch({ executablePath: electronPath, args: ['.'], env });
  const page = await desktop.firstWindow(), errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('heading', { name: '今天，想聊些什么？' }).waitFor();
  await page.getByRole('button', { name: '连接第一个模型' }).click();
  await page.getByRole('heading', { name: '模型服务' }).waitFor();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS: Electron loads the Vite development page with React refresh and settings UI.');
} finally { if (desktop) await desktop.close(); await server.close(); }
