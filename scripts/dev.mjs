import { spawn } from 'node:child_process';
import { createServer } from 'vite';
import { build } from 'esbuild';
import electron from 'electron';
const server = await createServer();
await server.listen();
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'sql.js', 'undici', 'markitdown-ts'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env, DEEPCHAN_DEV_URL: 'http://127.0.0.1:5173' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
let closing = false;
async function close(code = 0) { if (closing) return; closing = true; child.kill(); await server.close(); process.exit(code); }
child.on('exit', code => close(code ?? 0));
process.on('SIGINT', () => close());
process.on('SIGTERM', () => close());
console.log('DeepChan-chat: http://127.0.0.1:5173 — Electron 已启动，主进程修改后请重启。');
