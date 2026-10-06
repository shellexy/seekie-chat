import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
/** Copy legacy data once, retaining the original and never replacing a new database. */
export function migrateDataDirectory(legacy: string, destination: string): boolean {
  if (legacy === destination || existsSync(join(destination, 'chat.sqlite')) || !existsSync(join(legacy, 'chat.sqlite'))) return false;
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  cpSync(legacy, destination, { recursive: true, force: false, errorOnExist: true });
  return true;
}
