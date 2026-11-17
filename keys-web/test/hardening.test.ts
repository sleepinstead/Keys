// Regressions for the 2026-11 audit: conflict merges, restore, CSV round-trips, PIN backups, icon fetches, markers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../server/db.ts';
import { fetchSiteIcon } from '../server/favicon.ts';
import { exportVault, importVault } from '../server/importExport.ts';
import { findConflicts, mergeConflict, Presence } from '../server/sharing.ts';
import { HttpError, sanitizeEntryInput } from '../server/validate.ts';
import { Vault } from '../server/vault.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keys-hardening-'));

test('merging a conflict copy skips rows that do not decrypt, and the vault stays readable', async () => {
  const d = dir();
  const main = new Store(path.join(d, 'Keys.db')); // not .sqlite: copies are still found
  const vault = new Vault(main);
  const key = await vault.setup(MASTER);
  const id = vault.createEntry(key, sanitizeEntryInput({ type: 'login', title: 'GitHub', password: 'one' })).id;
  main.close();
  fs.copyFileSync(path.join(d, 'Keys.db'), path.join(d, 'Keys (1).db'));
  const copy = new Store(path.join(d, 'Keys (1).db'));
  const copyVault = new Vault(copy);
  copyVault.updateEntry(key, id, sanitizeEntryInput({ type: 'login', title: 'GitHub', password: 'two' }));
  copy.putRaw('entries', { id: 'planted', blob: new Uint8Array([1, 0]), created_at: 1, updated_at: Date.now(), deleted_at: null });
  copy.close();

  const reopened = new Store(path.join(d, 'Keys.db'));
  const v = new Vault(reopened);
  const k = await v.unlock(MASTER);
  const [conflict] = findConflicts(reopened);
  assert.ok(conflict, 'a .db vault finds its .db copy');
  assert.deepEqual(mergeConflict(reopened, conflict.path, k), { merged: 1, skipped: 1 });
  assert.equal(v.listEntries(k).length, 1);
  assert.equal(v.getEntry(k, id).password, 'two');
  // Even a damaged row already in the file doesn't make the vault unreadable.
  reopened.putRaw('entries', { id: 'broken', blob: new Uint8Array([1, 0]), created_at: 1, updated_at: 1, deleted_at: null });
  assert.equal(v.listEntries(k).length, 1);
  reopened.close();
});

test('a restored item stays restored when an older copy (where it was deleted) is merged', async () => {
  const d = dir();
  const main = new Store(path.join(d, 'Keys.sqlite'));
  const vault = new Vault(main);
  const key = await vault.setup(MASTER);
  const id = vault.createEntry(key, sanitizeEntryInput({ type: 'login', title: 'Bank', password: 'p' })).id;
  vault.deleteEntry(id);
  main.close();
  fs.copyFileSync(path.join(d, 'Keys.sqlite'), path.join(d, 'Keys (1).sqlite'));
  const copy = new Store(path.join(d, 'Keys (1).sqlite'));
  new Vault(copy).createEntry(key, sanitizeEntryInput({ type: 'note', title: 'Other device', notes: 'x' }));
  copy.close();
  await new Promise((r) => setTimeout(r, 5));

  const reopened = new Store(path.join(d, 'Keys.sqlite'));
  const v = new Vault(reopened);
  const k = await v.unlock(MASTER);
  v.restoreEntries(k, [id]);
  mergeConflict(reopened, findConflicts(reopened)[0]!.path, k);
  assert.deepEqual(v.listTrash(k), []);
  assert.equal(v.listEntries(k).length, 2);
  reopened.close();
});

test('CSV keeps values that start with an apostrophe, and leaves other apps’ values alone', async () => {
  const a = new Vault(new Store(':memory:'));
  const key = await a.setup(MASTER);
  for (const password of ["'=abc", "'-dash", "'plain", '=SUM(1)']) a.createEntry(key, sanitizeEntryInput({ type: 'login', title: password, password }));
  const file = await exportVault(a, key, 'csv');
  const b = new Vault(new Store(':memory:'));
  const other = await b.setup(MASTER);
  await importVault(b, () => other, file.content);
  assert.deepEqual(b.listEntries(other).map((e) => e.password).sort(), ["'-dash", "'=abc", "'plain", '=SUM(1)'].sort());
  // A Chrome export: an apostrophe is part of the password.
  const c = new Vault(new Store(':memory:'));
  const ck = await c.setup(MASTER);
  await importVault(c, () => ck, "name,url,username,password\nSite,https://s.example,me,'-secret\n");
  assert.equal(c.listEntries(ck)[0]!.password, "'-secret");
});

test('IPv4 addresses hidden in other IPv6 forms are refused', async () => {
  for (const host of ['[::127.0.0.1]', '[::ffff:0:127.0.0.1]', '[fec0::1]']) {
    await assert.rejects(fetchSiteIcon(`http://${host}:1`), (e: HttpError) => e.status === 400, host);
  }
});

test('the presence marker replaces a planted symlink instead of writing through it', () => {
  const d = dir();
  const db = path.join(d, 'Keys.sqlite');
  fs.writeFileSync(db, '');
  const victim = path.join(d, 'victim.txt');
  fs.writeFileSync(victim, 'untouched');
  const presence = new Presence(() => db);
  presence.beat();
  const marker = fs.readdirSync(d).find((n) => n.endsWith('.json'))!;
  fs.rmSync(path.join(d, marker));
  fs.symlinkSync(victim, path.join(d, marker));
  presence.beat();
  assert.equal(fs.readFileSync(victim, 'utf8'), 'untouched');
  assert.ok(!fs.lstatSync(path.join(d, marker)).isSymbolicLink());
  presence.stop();
});
