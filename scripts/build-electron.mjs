import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'undici', '@firecrawl/anydoc'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
// esbuild 不会搬运静态资源，窗口图标得由我们放到主进程旁边才能按 __dirname 找到。
copyFileSync('build/icon.png', 'dist-electron/icon.png');
