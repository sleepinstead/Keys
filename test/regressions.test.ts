import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.ts';
import { Store } from '../server/db.ts';
import { fetchSiteIcon } from '../server/favicon.ts';
import { exportVault, importVault } from '../server/importExport.ts';
import { SessionManager } from '../server/session.ts';
import { HttpError, sanitizeEntryInput } from '../server/validate.ts';
import { Vault } from '../server/vault.ts';
import type { AddressInfo } from 'node:net';

const MASTER = 'violet-anchor-tundra-58-quill';
const fresh = () => {
  const store = new Store(':memory:');
  return { store, vault: new Vault(store) };
};

test('two setups at once: only one wins and the vault stays readable', async () => {
  const { vault } = fresh();
  const results = await Promise.allSettled([vault.setup(MASTER), vault.setup(MASTER)]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(vault.listCategories(await vault.unlock(MASTER)).length, 5);
});

test('parallel password checks run one at a time', async () => {
  const { store, vault } = fresh();
  await vault.setup(MASTER);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => vault.verifyPassword('wrong')));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(store.getMeta('failed_attempts'), '1');
});

test('IPv4-mapped IPv6 loopback is refused', async () => {
  await assert.rejects(fetchSiteIcon('http://[::ffff:127.0.0.1]:1'), (e: HttpError) => e.status === 400);
});

test('a backup keeps item icons', async () => {
  const a = fresh();
  const key = await a.vault.setup(MASTER);
  const icon = 'data:image/png;base64,AAAA';
  a.vault.createEntry(key, sanitizeEntryInput({ type: 'login', title: 'x', password: 'p', icon }));
  const file = await exportVault(a.vault, key, 'json');
  const b = fresh();
  const other = await b.vault.setup(MASTER);
  await importVault(b.vault, () => other, file.content);
  assert.equal(b.vault.listEntries(other)[0]!.icon, icon);
});

test('a database with absurd key settings is refused before deriving', async () => {
  const { store, vault } = fresh();
  await vault.setup(MASTER);
  store.setMeta('kdf', JSON.stringify({ algorithm: 'argon2id', memory: 2 ** 31, passes: 1, parallelism: 1, salt: 'AAAAAAAAAAAAAAAAAAAAAA==' }));
  await assert.rejects(vault.unlock(MASTER), (e: HttpError) => e.status === 400);
});

test('an unreadable database locks the session instead of throwing from the timer', () => {
  const sessions = new SessionManager(() => {
    throw new Error('disk gone');
  });
  const token = sessions.open(Buffer.alloc(32, 1));
  assert.equal(sessions.authorize(token), null);
  sessions.dispose();
});

test('an item deleted during a breach check does not cancel the other results', async () => {
  let ctx: ReturnType<typeof createApp>;
  let doomed = '';
  ctx = createApp({
    dbFile: ':memory:',
    allowedOrigins: [],
    fetchRange: async () => {
      if (doomed) ctx.vault.deleteEntry(doomed);
      doomed = '';
      return 'AAAA:0';
    },
  });
  const server = await new Promise<ReturnType<typeof ctx.app.listen>>((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  let token = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-request': '1', 'x-keys-session': token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await res.json()) as any;
    if (parsed.sessionToken) token = parsed.sessionToken;
    return { status: res.status, body: parsed };
  };
  try {
    await call('POST', '/setup', { password: MASTER });
    await call('PUT', '/settings', { breachCheckEnabled: true });
    const gone = await call('POST', '/entries', { type: 'login', title: 'gone', password: 'one' });
    await call('POST', '/entries', { type: 'login', title: 'kept', password: 'two' });
    doomed = gone.body.id;
    const r = await call('POST', '/audit/breaches', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.totals.unchecked, 0);
  } finally {
    ctx.sessions.dispose();
    server.close();
    ctx.store.close();
  }
});

test('a new vault starts the welcome; older settings and bad values do not', async () => {
  const { store, vault } = fresh();
  await vault.setup(MASTER);
  assert.deepEqual(vault.getSettings().checklist, { tourSeen: false, done: [] });
  assert.deepEqual(vault.updateSettings({ checklist: { tourSeen: true, done: ['audit', 'nope', 'audit'] } }).checklist, { tourSeen: true, done: ['audit'] });
  assert.equal(vault.updateSettings({ checklist: null }).checklist, null);
  store.setMeta('settings', '{}');
  assert.equal(vault.getSettings().checklist, null, 'vaults from before onboarding stay quiet');
});
