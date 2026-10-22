import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export default async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const sandboxPath = join(context.appOutDir, 'chrome-sandbox');
  if (!existsSync(sandboxPath)) return;

  chmodSync(sandboxPath, 0o4755);
}
