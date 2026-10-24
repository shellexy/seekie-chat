import { build } from 'esbuild';
import { copyFileSync } from 'node:fs';
// external 里只放运行时必须真去 require 的包：undici 用动态 require，@firecrawl/anydoc 带原生模块。
// defuddle 与 linkedom 只有主进程用、体积又不小，故意内联进 main.cjs——它们因此在 package.json
// 里属于 devDependencies，不再随包复制一份。往 external 里加它们会让发布包运行时缺模块。
await build({ entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron', 'undici', '@firecrawl/anydoc'], sourcemap: true });
await build({ entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs', bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
// esbuild 不会搬运静态资源，窗口图标得由我们放到主进程旁边才能按 __dirname 找到。
copyFileSync('build/icon.png', 'dist-electron/icon.png');
