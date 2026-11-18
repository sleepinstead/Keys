import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/db.ts';
import { exportVault, importVault } from '../server/importExport.ts';
import { sanitizeEntryInput } from '../server/validate.ts';
import { Vault } from '../server/vault.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
const fresh = async () => {
  const store = new Store(':memory:');
  const vault = new Vault(store);
  return { store, vault, key: await vault.setup(MASTER) };
};
// About the size of a real website icon.
const icon = (seed: string) => `data:image/png;base64,${Buffer.alloc(8000, seed).toString('base64')}`;

test('backups store each distinct icon once and restore every item’s icon', async () => {
  const a = await fresh();
  const github = icon('g');
  const mail = icon('m');
  for (let i = 0; i < 20; i++) a.vault.createEntry(a.key, sanitizeEntryInput({ type: 'login', title: `GitHub ${i}`, username: `me${i}`, password: 'p', icon: github }));
  a.vault.createEntry(a.key, sanitizeEntryInput({ type: 'login', title: 'Mail', password: 'q', icon: mail }));
  a.vault.createEntry(a.key, sanitizeEntryInput({ type: 'note', title: 'Plain', notes: 'n' }));
  a.vault.createEntry(a.key, sanitizeEntryInput({ type: 'login', title: 'Picked', password: 'r', icon: 'none' }));

  const plain = await exportVault(a.vault, a.key, 'json');
  const json = JSON.parse(plain.content);
  assert.equal(json.version, 2);
  assert.equal(json.icons.length, 3);
  assert.ok(json.entries.every((e: { icon?: string }) => e.icon === undefined));
  assert.ok(plain.content.length < 2 * (github.length + mail.length), `one copy of each icon (${plain.content.length} chars)`);
  const encrypted = await exportVault(a.vault, a.key, 'encrypted', 'export-password-1');
  assert.ok(encrypted.content.length < 3 * (github.length + mail.length));

  for (const [file, password] of [[plain.content, undefined], [encrypted.content, 'export-password-1']] as const) {
    const b = await fresh();
    const result = await importVault(b.vault, () => b.key, file, password);
    assert.equal(result.imported, 23);
    const byTitle = new Map(b.vault.listEntries(b.key).map((e) => [e.title, e.icon]));
    assert.equal(byTitle.get('GitHub 7'), github);
    assert.equal(byTitle.get('Mail'), mail);
    assert.equal(byTitle.get('Picked'), 'none');
    assert.equal(byTitle.get('Plain'), '');
    b.store.close();
  }
  a.store.close();
});

test('version 1 backups (an icon inside each item) still import, and bad icon references are ignored', async () => {
  const b = await fresh();
  const github = icon('g');
  const v1 = {
    format: 'keys-plain',
    version: 1,
    categories: [],
    entries: [
      { type: 'login', title: 'Old', username: '', password: 'p', url: '', notes: '', codes: '', category: null, favorite: false, icon: github, customFields: [] },
      { type: 'login', title: 'Dangling', username: '', password: 'q', url: '', notes: '', codes: '', category: null, favorite: false, iconRef: 9, customFields: [] },
    ],
  };
  assert.equal((await importVault(b.vault, () => b.key, JSON.stringify(v1))).imported, 2);
  const byTitle = new Map(b.vault.listEntries(b.key).map((e) => [e.title, e.icon]));
  assert.equal(byTitle.get('Old'), github);
  assert.equal(byTitle.get('Dangling'), '');
  b.store.close();
});
