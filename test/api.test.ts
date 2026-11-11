import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
let server: Server;
let base: string;
let ctx: ReturnType<typeof createApp>;
let token = '';

async function call(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-keys-request': '1',
      ...(token ? { 'x-keys-session': token } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (parsed?.sessionToken) token = parsed.sessionToken;
  if (url === '/lock') token = '';
  return { status: res.status, body: parsed, headers: res.headers };
}

before(async () => {
  // In-memory database: tests never touch a database file or write files.
  ctx = createApp({
    dbFile: ':memory:',
    allowedOrigins: [],
    fetchRange: async () => 'AAAA:0',
  });
  await new Promise<void>((resolve) => {
    server = ctx.app.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}/api`;
});

after(() => {
  ctx.sessions.dispose();
  server.close();
  ctx.store.close();
});

test('requests without the API header or from foreign origins are rejected', async () => {
  const plain = await fetch(base + '/status');
  assert.equal(plain.status, 403);
  const foreign = await call('GET', '/status', undefined, { origin: 'http://evil.example' });
  assert.equal(foreign.status, 403);
  const crossSite = await call('GET', '/status', undefined, { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);
});

test('full vault lifecycle', async () => {
  let r = await call('GET', '/status');
  assert.deepEqual([r.body.initialized, r.body.unlocked], [false, false]);

  r = await call('POST', '/setup', { password: 'password123' });
  assert.equal(r.status, 400, 'weak master password refused');

  r = await call('POST', '/setup', { password: MASTER });
  assert.equal(r.status, 200);
  assert.ok(token, 'unlocking returns a session token');
  assert.equal(r.headers.get('set-cookie'), null, 'cookies would be shared with other localhost ports');

  const cats = (await call('GET', '/categories')).body;
  assert.equal(cats.length, 5);

  r = await call('POST', '/entries', {
    type: 'login',
    title: 'GitHub',
    username: 'octo',
    password: 'first-Password-1!',
    url: 'github.com',
    categoryId: cats[0].id,
  });
  assert.equal(r.status, 201);
  const id = r.body.id;

  // Folder colours: set, kept across a rename, cleared, and only known colours accepted.
  let c = await call('PUT', `/categories/${cats[0].id}`, { color: 'blue' });
  assert.equal(c.body.color, 'blue');
  c = await call('PUT', `/categories/${cats[0].id}`, { name: 'Personal stuff' });
  assert.deepEqual([c.body.name, c.body.color], ['Personal stuff', 'blue']);
  assert.equal((await call('PUT', `/categories/${cats[0].id}`, { color: 'chartreuse' })).status, 400);
  c = await call('PUT', `/categories/${cats[0].id}`, { name: cats[0].name, color: null });
  assert.equal(c.body.color, null);

  r = await call('PUT', `/entries/${id}`, { ...r.body, password: 'second-Password-2!' });
  assert.equal(r.body.history.length, 1);
  assert.equal(r.body.history[0].password, 'first-Password-1!');

  // Setting only the icon is not an edit: updatedAt and the password history stay put.
  const before = r.body.updatedAt;
  r = await call('PUT', `/entries/${id}/icon`, { icon: 'data:image/png;base64,AAAA' });
  assert.equal(r.body.icon, 'data:image/png;base64,AAAA');
  assert.equal(r.body.updatedAt, before);
  assert.equal(r.body.history.length, 1);
  r = await call('PUT', `/entries/${id}/icon`, { icon: 'none' });
  assert.equal(r.body.icon, 'none');
  assert.equal((await call('PUT', `/entries/${id}/icon`, { icon: 'https://evil.example/i.png' })).status, 400);
  r = await call('GET', `/entries/${id}`);

  // Plaintext never reaches the database: scan every stored row and meta value.
  const stored = Buffer.concat(
    [
      ...(ctx.store.db.prepare('SELECT id, blob FROM entries UNION ALL SELECT id, blob FROM categories').all() as {
        id: string;
        blob: Uint8Array;
      }[]).flatMap((r) => [Buffer.from(r.id), Buffer.from(r.blob)]),
      ...(ctx.store.db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map((r) =>
        Buffer.from(r.key + r.value),
      ),
    ],
  );
  for (const needle of ['GitHub', 'octo', 'second-Password-2!', 'first-Password-1!', 'Personal']) {
    assert.equal(stored.includes(Buffer.from(needle)), false, `${needle} found in db`);
  }

  // Generator options are stored with settings and sanitised.
  r = await call('PUT', '/settings', { generator: { length: 999, lowercase: false, uppercase: false, digits: true, symbols: false } });
  assert.equal(r.body.settings.generator.length, 128);
  assert.equal(r.body.settings.generator.digits, true);
  r = await call('PUT', '/settings', { generator: { lowercase: false, uppercase: false, digits: false, symbols: false } });
  assert.equal(r.body.settings.generator.digits, true, 'cannot disable every character set');

  // Categories toggle in settings
  assert.equal(r.body.settings.categoriesEnabled, true);
  r = await call('PUT', '/settings', { categoriesEnabled: false });
  assert.equal(r.body.settings.categoriesEnabled, false);
  r = await call('PUT', '/settings', { categoriesEnabled: true });
  assert.equal(r.body.settings.categoriesEnabled, true);

  const list = (await call('GET', '/entries')).body;
  assert.equal(list.length, 1);
  assert.equal('password' in list[0], false, 'list view omits secrets');

  r = await call('GET', '/audit');
  assert.equal(r.body.totals.logins, 1);

  r = await call('POST', '/audit/breaches', {});
  assert.equal(r.status, 400, 'breach checks are opt-in');
  await call('PUT', '/settings', { breachCheckEnabled: true });
  r = await call('POST', '/audit/breaches', {});
  assert.equal(r.status, 200);
  assert.equal(r.body.items[0].breachCount, 0);

  // Encrypted export -> import into the same vault skips the duplicate.
  r = await call('POST', '/export', { format: 'encrypted', masterPassword: 'wrong' });
  assert.equal(r.status, 401);
  r = await call('POST', '/export', { format: 'encrypted', masterPassword: MASTER, exportPassword: 'export-pass-xyz' });
  assert.equal(r.status, 200);
  assert.equal(r.body.content.includes('GitHub'), false);
  const exported = r.body.content;
  r = await call('POST', '/import', { content: exported, password: 'nope-nope-nope' });
  assert.equal(r.body.code, 'BAD_PASSWORD');
  r = await call('POST', '/import', { content: exported, password: 'export-pass-xyz' });
  assert.deepEqual([r.body.imported, r.body.skipped], [0, 1]);

  r = await call('POST', '/import', {
    content: 'name,url,username,password,note\nBank,https://bank.example,me,Hunter2-Hunter2,acct 1\n',
  });
  assert.equal(r.body.imported, 1);

  // Lock wipes the session.
  await call('POST', '/lock');
  r = await call('GET', '/entries');
  assert.equal(r.status, 401);

  r = await call('POST', '/unlock', { password: 'not the password' });
  assert.equal(r.status, 401);
  r = await call('POST', '/unlock', { password: MASTER });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/entries')).body.length, 2);

  // Change master password; old one stops working, data survives.
  r = await call('POST', '/account/change-password', { current: MASTER, next: 'saffron-glacier-orbit-91-harp' });
  assert.equal(r.status, 200);
  await call('POST', '/lock');
  assert.equal((await call('POST', '/unlock', { password: MASTER })).status, 401);
  assert.equal((await call('POST', '/unlock', { password: 'saffron-glacier-orbit-91-harp' })).status, 200);
  assert.equal((await call('GET', '/entries')).body.length, 2);
});

test('PIN quick unlock', async () => {
  const master = 'saffron-glacier-orbit-91-harp';
  let r = await call('POST', '/pin', { pin: '1234', masterPassword: master });
  assert.equal(r.body.code, 'WEAK_PIN');
  r = await call('POST', '/pin', { pin: '48a9', masterPassword: master });
  assert.equal(r.status, 400);
  r = await call('POST', '/pin', { pin: '4829', masterPassword: 'wrong' });
  assert.equal(r.status, 401);
  r = await call('POST', '/pin', { pin: '4829', masterPassword: master });
  assert.deepEqual(r.body.pin, { length: 4, available: true, attemptsLeft: 5 });
  assert.equal(ctx.store.getMeta('pin')!.includes('4829'), false, 'PIN is stored encrypted');

  await call('POST', '/lock');
  r = await call('POST', '/unlock/pin', { pin: '0000' });
  assert.equal(r.body.code, 'BAD_PIN');
  r = await call('POST', '/unlock/pin', { pin: '4829' });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/entries')).status, 200);

  // Five wrong PINs destroy quick unlock until the master password is used again.
  await call('POST', '/lock');
  for (let i = 0; i < 5; i++) r = await call('POST', '/unlock/pin', { pin: '5550' });
  assert.equal(r.body.code, 'PIN_EXHAUSTED');
  r = await call('POST', '/unlock/pin', { pin: '4829' });
  assert.equal(r.body.code, 'PIN_UNAVAILABLE');
  assert.equal((await call('GET', '/status')).body.pin.available, false);
  r = await call('POST', '/unlock', { password: master });
  assert.equal(r.body.pin.available, true);

  r = await call('DELETE', '/pin');
  assert.equal((await call('GET', '/status')).body.pin, null);
});

test('a vault can be created with a 4 or 6-digit PIN instead of a password', async () => {
  const pinApp = createApp({ dbFile: ':memory:', allowedOrigins: [] });
  const srv = await new Promise<Server>((resolve) => {
    const s = pinApp.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
  let jar = '';
  const go = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-request': '1', ...(jar ? { 'x-keys-session': jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await res.json()) as any;
    if (parsed?.sessionToken) jar = parsed.sessionToken;
    if (path === '/lock') jar = '';
    return { status: res.status, body: parsed };
  };
  try {
    assert.equal((await go('POST', '/setup', { password: '1234', type: 'pin' })).body.code, 'WEAK_PIN');
    assert.equal((await go('POST', '/setup', { password: '48291', type: 'pin' })).status, 400, 'only 4 or 6 digits');
    let r = await go('POST', '/setup', { password: '4829', type: 'pin' });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.credential, { type: 'pin', length: 4 });
    assert.equal(JSON.parse(pinApp.store.getMeta('kdf')!).memory, 524288, 'PIN vaults use the heavier KDF');

    assert.equal((await go('POST', '/pin', { pin: '730415', masterPassword: '4829' })).body.code, 'PIN_VAULT');
    r = await go('POST', '/export', { format: 'encrypted', masterPassword: '4829' });
    assert.equal(r.body.code, 'NEEDS_EXPORT_PASSWORD');

    await go('POST', '/lock');
    assert.equal((await go('POST', '/unlock', { password: '4820' })).status, 401);
    assert.equal((await go('POST', '/unlock', { password: '4829' })).status, 200);

    // 8-digit PINs are not offered.
    assert.equal((await go('POST', '/account/change-password', { current: '4829', next: '73041592', type: 'pin' })).status, 400, 'no 8-digit PIN');
    // Every other credential kind: 6-digit PIN, pattern, passphrase.
    r = await go('POST', '/account/change-password', { current: '4829', next: '730415', type: 'pin' });
    assert.deepEqual(r.body.credential, { type: 'pin', length: 6 });
    assert.equal((await go('POST', '/account/change-password', { current: '730415', next: '0-1-2', type: 'pattern' })).status, 400, 'straight line refused');
    assert.equal((await go('POST', '/account/change-password', { current: '730415', next: '0-1-1-2', type: 'pattern' })).status, 400, 'repeated dot refused');
    r = await go('POST', '/account/change-password', { current: '730415', next: '0-4-8-5-2', type: 'pattern' });
    assert.deepEqual(r.body.credential, { type: 'pattern' });
    assert.equal(JSON.parse(pinApp.store.getMeta('kdf')!).memory, 524288, 'patterns use the heavy KDF');
    await go('POST', '/lock');
    assert.equal((await go('POST', '/unlock', { password: '0-4-8-5-6' })).status, 401);
    assert.equal((await go('POST', '/unlock', { password: '0-4-8-5-2' })).status, 200);
    assert.equal((await go('POST', '/account/change-password', { current: '0-4-8-5-2', next: 'orbit velvet', type: 'passphrase' })).status, 400, 'two words refused');
    r = await go('POST', '/account/change-password', { current: '0-4-8-5-2', next: 'quarry lantern velvet orbit tundra', type: 'passphrase' });
    assert.deepEqual(r.body.credential, { type: 'passphrase' });
    assert.equal(JSON.parse(pinApp.store.getMeta('kdf')!).memory, 131072);
    r = await go('POST', '/account/change-password', { current: 'quarry lantern velvet orbit tundra', next: '4829', type: 'pin' });
    assert.deepEqual(r.body.credential, { type: 'pin', length: 4 });

    // Switch to a 6-digit PIN, then to a password.
    r = await go('POST', '/account/change-password', { current: '4829', next: '730415', type: 'pin' });
    assert.deepEqual(r.body.credential, { type: 'pin', length: 6 });
    r = await go('POST', '/account/change-password', { current: '730415', next: 'violet-anchor-tundra-58-quill', type: 'password' });
    assert.deepEqual(r.body.credential, { type: 'password' });
    assert.equal(JSON.parse(pinApp.store.getMeta('kdf')!).memory, 131072);
    assert.deepEqual((await go('GET', '/status')).body.credential, { type: 'password' });
  } finally {
    pinApp.sessions.dispose();
    srv.close();
    pinApp.store.close();
  }
});

test('repeated failures trigger a lockout', async () => {
  await call('POST', '/lock');
  let last;
  for (let i = 0; i < 8; i++) last = await call('POST', '/unlock', { password: `bad-${i}` });
  assert.equal(last!.status, 429);
  assert.equal(last!.body.code, 'LOCKED_OUT');
  assert.ok((await call('GET', '/status')).body.lockoutUntil > Date.now());
});

test('changing the database file needs the current password or PIN', async () => {
  const app2 = createApp({ dbFile: ':memory:', allowedOrigins: [] });
  const srv = await new Promise<Server>((resolve) => {
    const s = app2.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/api`;
  let jar = '';
  const go = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(url + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-request': '1', ...(jar ? { 'x-keys-session': jar } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    if (parsed?.sessionToken) jar = parsed.sessionToken;
    if (path === '/lock') jar = '';
    return { status: res.status, body: parsed };
  };
  try {
    // Nothing to protect yet: an empty database can be switched freely.
    assert.equal((await go('POST', '/storage/default', {})).status, 200);
    assert.equal((await go('POST', '/setup', { password: '4829', type: 'pin' })).status, 200);
    assert.equal((await go('GET', '/status')).body.storage.isDefault, true);

    assert.equal((await go('POST', '/storage/default', {})).status, 400, 'missing PIN');
    const wrong = await go('POST', '/storage/default', { current: '1111' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'Incorrect PIN');
    assert.equal((await go('POST', '/storage/move', { path: '/tmp/x.sqlite', current: '1111' })).status, 401);
    assert.equal((await go('POST', '/storage/connect', { path: '/tmp/x.sqlite' })).status, 400, 'missing PIN');
    assert.equal((await go('GET', '/entries')).status, 200, 'refusals do not lock the session');
  } finally {
    app2.sessions.dispose();
    srv.close();
    app2.storage.close();
  }
});

test('starring or filing an item does not count as editing it', async () => {
  const { Store } = await import('../server/db.ts');
  const { Vault } = await import('../server/vault.ts');
  const store = new Store(':memory:');
  try {
    const vault = new Vault(store);
    const key = await vault.setup(MASTER);
    const base = { type: 'login' as const, title: 'Site', username: 'me', password: 'pw-1', url: '', notes: '', codes: '', categoryId: null, favorite: false, icon: '', customFields: [] };
    const made = vault.createEntry(key, base);
    await new Promise((r) => setTimeout(r, 5));
    assert.equal(vault.updateEntry(key, made.id, { ...base, favorite: true }).updatedAt, made.updatedAt);
    await new Promise((r) => setTimeout(r, 5));
    assert.ok(vault.updateEntry(key, made.id, { ...base, favorite: true, title: 'Site 2' }).updatedAt > made.updatedAt);
  } finally {
    store.close();
  }
});

test('CSV exports guard against spreadsheet formulas and import back exactly', async () => {
  const { toCsv, parseCsv } = await import('../server/importExport.ts');
  const csv = toCsv([['title', 'username', 'password'], ['Site', '=HYPERLINK("x")', '+1-555']]);
  assert.match(csv, /'=HYPERLINK/, 'a formula-looking cell is defused');
  assert.deepEqual(parseCsv(csv)[1], ['Site', '\'=HYPERLINK("x")', "'+1-555"]);
});

test('audit ratings are remembered and redone only when a password changes', async () => {
  const { rateLogins, strengthKey } = await import('../server/audit.ts');
  const e = { id: 'a', type: 'login', title: 'Site', username: 'me', url: 'site.com', password: 'correct horse battery staple' } as never as Parameters<typeof strengthKey>[0];
  assert.equal((await rateLogins([e])).size, 1, 'rated the first time');
  assert.equal((await rateLogins([e])).size, 0, 'remembered after that');
  e.password = 'password1';
  const again = await rateLogins([e]);
  assert.equal(again.size, 1, 'a new password is rated again');
  assert.ok(again.get('a')!.score <= 1);
});

test('CSV export guards against spreadsheet formulas, and import undoes the guard', async () => {
  const { createApp: make } = await import('../server/app.ts');
  const app2 = make({ dbFile: ':memory:', allowedOrigins: [] });
  try {
    const key = await app2.vault.setup(MASTER);
    app2.vault.createEntry(key, { type: 'login', title: 'Site', username: '=HYPERLINK("x")', password: '+1-pw', url: '', notes: '', codes: '', categoryId: null, favorite: false, icon: '', customFields: [] });
    const { exportVault, importVault } = await import('../server/importExport.ts');
    const csv = (await exportVault(app2.vault, key, 'csv')).content;
    assert.ok(csv.includes(`'=HYPERLINK`), 'formula cell is neutralised');
    assert.ok(csv.includes(`'+1-pw`));
    const app3 = make({ dbFile: ':memory:', allowedOrigins: [] });
    const key3 = await app3.vault.setup(MASTER);
    await importVault(app3.vault, () => key3, csv);
    const back = app3.vault.listEntries(key3)[0]!;
    assert.deepEqual([back.username, back.password], ['=HYPERLINK("x")', '+1-pw'], 'round-trips unchanged');
    app3.sessions.dispose();
  } finally {
    app2.sessions.dispose();
  }
});
