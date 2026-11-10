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

test('erasing needs a session and the password, then leaves an empty database', async () => {
  const ctx = createApp({ dbFile: ':memory:', allowedOrigins: [] });
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
    await call('POST', '/entries', { type: 'login', title: 'x', password: 'p' });
    const session = token;
    token = 'wrong';
    assert.equal((await call('POST', '/storage/wipe', { current: MASTER })).status, 401, 'no session');
    token = session;
    assert.equal((await call('POST', '/storage/wipe', { current: 'nope' })).status, 401, 'wrong password');
    assert.equal((await call('GET', '/entries')).body.length, 1, 'nothing erased yet');
    const done = await call('POST', '/storage/wipe', { current: MASTER });
    assert.equal(done.status, 200);
    assert.equal(done.body.initialized, false);
    assert.equal(done.body.unlocked, false);
    assert.equal((await call('GET', '/entries')).status, 401);
    assert.equal(ctx.store.all('entries').length + ctx.store.all('categories').length, 0);
  } finally {
    ctx.sessions.dispose();
    server.close();
    ctx.store.close();
  }
});

test('exact copies of a login are grouped, newest kept, and copies with their own notes are flagged', async () => {
  const { buildAuditReport } = await import('../server/audit.ts');
  const { DEFAULT_SETTINGS } = await import('../shared/types.ts');
  const base = { type: 'login', title: 'GitHub', username: 'me@x.com', password: 'Correct-Horse-1', url: 'https://github.com', notes: '', codes: '', customFields: [], categoryId: null, favorite: false, icon: '', passwordUpdatedAt: 0, history: [], breach: null, createdAt: 0 };
  const entries = [
    { ...base, id: 'old', updatedAt: 1 },
    { ...base, id: 'new', updatedAt: 3, url: 'www.github.com/login', username: 'ME@x.com ' },
    { ...base, id: 'notes', updatedAt: 2, notes: 'backup email: other@x.com' },
    { ...base, id: 'other-site', updatedAt: 4, url: 'gitlab.com' }, // same password, different site: reused, not a copy
  ] as any[];
  const r = buildAuditReport(entries, DEFAULT_SETTINGS);
  assert.equal(r.duplicateGroups.length, 1);
  assert.deepEqual(r.duplicateGroups[0]!.items.map((i) => [i.id, i.extra]), [['new', false], ['notes', true], ['old', false]]);
  assert.equal(r.totals.duplicates, 2);
  assert.equal(r.totals.reused, 4);
});

test('bulk delete needs a session and removes all or nothing', async () => {
  const ctx = createApp({ dbFile: ':memory:', allowedOrigins: [] });
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
    const a = (await call('POST', '/entries', { type: 'login', title: 'a', password: 'p' })).body.id;
    const b = (await call('POST', '/entries', { type: 'login', title: 'b', password: 'p' })).body.id;
    const session = token;
    token = 'nope';
    assert.equal((await call('POST', '/entries/delete', { ids: [a] })).status, 401);
    token = session;
    assert.equal((await call('POST', '/entries/delete', { ids: [a, 'missing'] })).status, 404);
    assert.equal((await call('GET', '/entries')).body.length, 2, 'a failed batch removes nothing');
    assert.equal((await call('POST', '/entries/delete', { ids: [a, b] })).body.deleted, 2);
    assert.equal((await call('GET', '/entries')).body.length, 0);
  } finally {
    ctx.sessions.dispose();
    server.close();
    ctx.store.close();
  }
});
