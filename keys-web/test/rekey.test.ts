import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';
import { decrypt, DecryptionError, encrypt } from '../server/crypto.ts';
import { Store } from '../server/db.ts';
import { categoryAad, entryAad, Vault } from '../server/vault.ts';
import type { EntryInput } from '../shared/types.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
const NEXT = 'saffron-glacier-orbit-91-harp';
const login = (title: string, password: string): EntryInput => ({ type: 'login', title, username: 'me', password, url: '', notes: '', codes: '', categoryId: null, favorite: false, icon: '', customFields: [] });

const opensWith = (key: Buffer, blob: Uint8Array, aad: string) => {
  try {
    decrypt(key, blob, aad).fill(0);
    return true;
  } catch (err) {
    if (err instanceof DecryptionError) return false;
    throw err;
  }
};

test('a password change makes a new vault key and re-encrypts everything under it', async () => {
  const store = new Store(':memory:');
  const vault = new Vault(store);
  const oldKey = await vault.setup(MASTER);
  const live = vault.createEntry(oldKey, login('Live', 'a'));
  const binned = vault.createEntry(oldKey, login('Binned', 'b'));
  vault.deleteEntry(binned.id);
  const folder = vault.createCategory(oldKey, 'Clients');
  vault.savePin(oldKey, '4829');
  // A damaged row (a bad sync, say) is left exactly as it was.
  const junk = encrypt(Buffer.alloc(32, 7), Buffer.from('{}'), entryAad('junk'));
  store.insert('entries', { id: 'junk', blob: junk, created_at: 5, updated_at: 5 });
  const before = new Map(store.all('entries').map((r) => [r.id, r.updated_at]));

  const newKey = await vault.changePassword(MASTER, NEXT);
  assert.notDeepEqual(newKey, oldKey);
  await assert.rejects(vault.unlock(MASTER), /Incorrect/);
  assert.deepEqual(await vault.unlock(NEXT), newKey);

  // The old key (an old copy of the file plus the old password) opens nothing that's there now.
  for (const row of store.all('entries')) {
    if (row.id === 'junk') continue;
    assert.equal(opensWith(oldKey, row.blob, entryAad(row.id)), false);
    assert.equal(opensWith(newKey, row.blob, entryAad(row.id)), true, 'same AAD labels as before');
    assert.equal(row.updated_at, before.get(row.id), 're-encrypting is not an edit');
  }
  for (const row of store.all('categories')) {
    assert.equal(opensWith(oldKey, row.blob, categoryAad(row.id)), false);
    assert.equal(opensWith(newKey, row.blob, categoryAad(row.id)), true);
  }
  assert.deepEqual(Buffer.from(store.get('entries', 'junk')!.blob), junk);
  assert.equal(vault.readPin(oldKey), null);
  assert.equal(vault.readPin(newKey), '4829', 'the quick-unlock PIN moves to the new key');

  assert.equal(vault.getEntry(newKey, live.id).password, 'a');
  assert.deepEqual(vault.listTrash(newKey).map((e) => e.title), ['Binned']);
  assert.ok(vault.listCategories(newKey).some((c) => c.id === folder.id && c.name === 'Clients'));
  assert.equal(vault.listCategories(newKey).length, 6);
  store.close();
});

test('a wrong current password changes nothing', async () => {
  const store = new Store(':memory:');
  const vault = new Vault(store);
  const key = await vault.setup(MASTER);
  const item = vault.createEntry(key, login('A', 'a'));
  const wrapped = store.getMeta('wrapped_key');
  const blob = store.get('entries', item.id)!.blob;
  await assert.rejects(vault.changePassword('wrong-password', NEXT), /incorrect/);
  assert.equal(store.getMeta('wrapped_key'), wrapped);
  assert.deepEqual(Buffer.from(store.get('entries', item.id)!.blob), Buffer.from(blob));
  assert.equal(store.getMeta('failed_attempts'), '1');
  store.close();
});

async function serve(dbFile: string) {
  const app = createApp({ dbFile, allowedOrigins: [] });
  const srv = await new Promise<Server>((resolve) => {
    const s = app.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
  let jar = '';
  const go = async (method: string, route: string, body?: unknown) => {
    const res = await fetch(url + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-request': '1', ...(jar ? { 'x-keys-session': jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (parsed?.sessionToken) jar = parsed.sessionToken;
    return { status: res.status, body: parsed };
  };
  const close = () => {
    app.sessions.dispose();
    srv.close();
    app.storage.close();
  };
  return { app, go, close };
}

test('the quick-unlock PIN survives a password change, and the open session moves to the new key', async () => {
  const { app, go, close } = await serve(':memory:');
  try {
    assert.equal((await go('POST', '/setup', { password: MASTER })).status, 200);
    let r = await go('POST', '/pin', { pin: '730415', masterPassword: MASTER });
    assert.deepEqual(r.body.pin, { length: 6, available: true, attemptsLeft: 5 });
    const item = (await go('POST', '/entries', login('A', 'a'))).body;

    r = await go('POST', '/account/change-password', { current: MASTER, next: NEXT });
    assert.equal(r.status, 200);
    assert.equal(r.body.pin.available, true);
    assert.equal((await go('GET', `/entries/${item.id}`)).body.password, 'a', 'the open session moved to the new key');
    await go('POST', '/lock');
    assert.equal((await go('POST', '/unlock/pin', { pin: '730415' })).status, 200, 'quick unlock gives the new key');
    assert.equal((await go('GET', `/entries/${item.id}`)).body.password, 'a');
    assert.equal(app.vault.readPin(Buffer.alloc(32, 1)), null);

    // Switching to a PIN vault also makes a new key, and drops the (now pointless) quick-unlock PIN.
    const before = app.store.getMeta('wrapped_key');
    r = await go('POST', '/account/change-password', { current: NEXT, next: '482913', type: 'pin' });
    assert.deepEqual(r.body.credential, { type: 'pin', length: 6 });
    assert.equal(r.body.pin, null);
    assert.notEqual(app.store.getMeta('wrapped_key'), before);
    assert.equal((await go('GET', `/entries/${item.id}`)).body.password, 'a');
  } finally {
    close();
  }
});

test('a password change made on another computer locks this one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-rekey-'));
  const file = path.join(dir, 'Keys.sqlite');
  const { go, close } = await serve(file);
  try {
    assert.equal((await go('POST', '/setup', { password: MASTER })).status, 200);
    assert.equal((await go('GET', '/entries')).status, 200);
    // The other computer, through the synced file.
    const other = new Store(file);
    await new Vault(other).changePassword(MASTER, NEXT);
    other.close();
    await go('GET', '/sync'); // the app's periodic look notices the change
    assert.equal((await go('GET', '/entries')).status, 401, 'its old key would write rows nobody could read');
    assert.equal((await go('POST', '/unlock', { password: NEXT })).status, 200);
    assert.equal((await go('GET', '/entries')).status, 200);
  } finally {
    close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
