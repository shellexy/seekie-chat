import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateDataDirectory } from '../electron/data-paths';
test('renaming retains legacy data and never overwrites a new database', () => {
  const root = mkdtempSync(join(tmpdir(), 'deepchan-migration-'));
  try {
    const old = join(root, 'old'), next = join(root, 'new'); mkdirSync(join(old,'attachments'), { recursive: true });
    writeFileSync(join(old, 'chat.sqlite'), 'old fixture database'); writeFileSync(join(old,'attachments','fixture.txt'), 'image fixture');
    assert.equal(migrateDataDirectory(old, next), true);
    assert.equal(readFileSync(join(next, 'chat.sqlite'), 'utf8'), 'old fixture database');
    assert.equal(readFileSync(join(next, 'attachments','fixture.txt'), 'utf8'), 'image fixture');
    writeFileSync(join(next, 'chat.sqlite'), 'new fixture database');
    assert.equal(migrateDataDirectory(old, next), false);
    assert.equal(readFileSync(join(next, 'chat.sqlite'), 'utf8'), 'new fixture database');
    assert.equal(readFileSync(join(old, 'chat.sqlite'), 'utf8'), 'old fixture database');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
