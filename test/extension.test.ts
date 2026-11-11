import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { matchesSite } from '../server/extension.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';

test('a login only matches pages on its own site', () => {
  assert.ok(matchesSite('github.com', 'https://github.com/login'));
  assert.ok(matchesSite('https://github.com', 'https://www.github.com/'));
  assert.ok(matchesSite('google.com', 'https://accounts.google.com/signin'), 'subdomains of the saved site');
  assert.ok(!matchesSite('accounts.google.com', 'https://google.com/'), 'not the other way round');
  assert.ok(!matchesSite('github.com', 'https://github.com.evil.example/'), 'look-alike hosts');
  assert.ok(!matchesSite('github.com', 'https://notgithub.com/'));
  assert.ok(!matchesSite('github.com', 'http://github.com/'), 'no filling on plain http unless saved that way');
  assert.ok(matchesSite('http://intranet.local', 'http://intranet.local/login'));
  assert.ok(!matchesSite('localhost:3000', 'https://localhost:4000/'), 'a saved port must match');
  assert.ok(!matchesSite('', 'https://github.com/'));
  assert.ok(!matchesSite('github.com', 'chrome://settings'));
  assert.ok(!matchesSite('com', 'https://anything.com/'), 'a bare suffix matches nothing extra');
});

test('pairing, autofill and locking through the extension API', async () => {
  const ctx = createApp({ dbFile: ':memory:', allowedOrigins: [], appUrl: 'http://localhost:5174' });
  const server = await new Promise<ReturnType<typeof ctx.app.listen>>((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  let session = '';
  const app = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-request': '1', 'x-keys-session': session },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = (await res.json()) as any;
    if (parsed.sessionToken) session = parsed.sessionToken;
    return { status: res.status, body: parsed };
  };
  let token = '';
  const ext = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + '/extension' + path, {
      method,
      headers: { 'content-type': 'application/json', 'x-keys-extension': '1', 'x-keys-extension-token': token, origin: EXT_ORIGIN, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  try {
    assert.equal((await ext('POST', '/pair', { name: 'Chrome' })).status, 409, 'nothing to connect to before setup');
    await app('POST', '/setup', { password: MASTER });
    const gh = (await app('POST', '/entries', { type: 'login', title: 'GitHub', url: 'github.com', username: 'me', password: 'gh-secret' })).body.id;
    await app('POST', '/entries', { type: 'login', title: 'Bank', url: 'bank.example', username: 'me', password: 'bank-secret' });

    // Web pages and other local apps are turned away.
    assert.equal((await ext('GET', '/status', undefined, { origin: 'https://evil.example' })).status, 403);
    assert.equal((await ext('GET', '/status', undefined, { 'x-keys-extension': '0' })).status, 403);
    assert.equal((await ext('GET', '/status')).body.code, 'NOT_PAIRED');

    // Pairing: the extension shows a code, the person types it into the unlocked app.
    const req = (await ext('POST', '/pair', { name: 'Chrome\u0000 on Mac' })).body;
    assert.match(req.code, /^[A-Z2-9]{6}$/);
    assert.equal((await ext('GET', `/pair/${req.requestId}`)).body.status, 'pending');
    assert.equal((await app('POST', '/browsers/approve', { code: 'AAAAAA' })).status, 404, 'a wrong code approves nothing');
    const locked = session;
    session = '';
    assert.equal((await app('POST', '/browsers/approve', { code: req.code })).status, 401, 'approving needs the unlocked app');
    session = locked;
    const approved = await app('POST', '/browsers/approve', { code: `${req.code.slice(0, 3)}-${req.code.slice(3).toLowerCase()}` });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.name, 'Chrome on Mac');
    const done = (await ext('GET', `/pair/${req.requestId}`)).body;
    assert.equal(done.status, 'approved');
    token = done.token;
    assert.equal((await ext('GET', `/pair/${req.requestId}`)).body.status, 'expired', 'the token is handed over once');
    assert.equal((await app('GET', '/browsers')).body.length, 1);
    assert.equal(JSON.stringify((await app('GET', '/browsers')).body).includes(token), false, 'the app never sees the token');

    // Offering to save: check says what saving would do, save stores or updates the login.
    const signIn = 'https://github.com/login';
    assert.equal((await ext('POST', '/save/check', { url: signIn, username: 'me', password: 'gh-secret' })).body.status, 'same');
    assert.equal((await ext('POST', '/save/check', { url: signIn, username: 'me', password: 'gh-new' })).body.status, 'update');
    assert.equal((await ext('POST', '/save/check', { url: signIn, username: 'other', password: 'x' })).body.status, 'new');
    assert.equal((await ext('POST', '/save', { url: signIn, username: 'me', password: 'gh-new' })).body.status, 'updated');
    const updated = (await app('GET', `/entries/${gh}`)).body;
    assert.equal(updated.password, 'gh-new');
    assert.equal(updated.history[0].password, 'gh-secret', 'the old password goes to history');
    const savedNew = (await ext('POST', '/save', { url: 'https://new.example/signup', username: 'fresh', password: 'pw-1' })).body;
    assert.equal(savedNew.status, 'saved');
    const made = (await app('GET', `/entries/${savedNew.id}`)).body;
    assert.deepEqual([made.title, made.url, made.username], ['new.example', 'new.example', 'fresh']);
    assert.equal((await ext('POST', '/save', { url: 'chrome://settings', password: 'x' })).status, 400, 'only websites');
    assert.ok(!ctx.store.getMeta('browser_pairings')!.includes(token), 'only a hash is stored');

    // Unlocked: matches for the page, without passwords.
    const status = (await ext('GET', '/status')).body;
    assert.equal(status.unlocked, true);
    const page = (await ext('GET', '/logins?url=' + encodeURIComponent('https://github.com/login'))).body.logins;
    assert.deepEqual(page.map((l: any) => l.title), ['GitHub']);
    assert.equal(page[0].password, undefined);
    assert.equal((await ext('GET', '/logins?all=1&url=' + encodeURIComponent('https://github.com/'))).body.logins.length, 3, 'GitHub, Bank and the one just saved');

    // Filling only works on the login's own site.
    const filled = await ext('POST', '/fill', { id: gh, url: 'https://github.com/login' });
    assert.deepEqual(filled.body, { username: 'me', password: 'gh-new' });
    assert.equal((await ext('POST', '/fill', { id: gh, url: 'https://evil.example/login' })).body.code, 'WRONG_SITE');

    // Lock from the extension: the app's session ends too, and nothing can be read.
    await ext('POST', '/lock');
    assert.equal((await app('GET', '/entries')).status, 401);
    assert.equal((await ext('GET', '/logins?url=https://github.com/')).body.code, 'LOCKED');
    assert.equal((await ext('POST', '/unlock', { secret: 'wrong' })).status, 401);
    assert.equal((await ext('POST', '/unlock', { secret: MASTER })).body.unlocked, true);
    assert.equal((await ext('POST', '/fill', { id: gh, url: 'https://github.com/' })).body.password, 'gh-new', 'the saved update is what fills');

    // The token is tied to the extension that paired: copied elsewhere, it's refused.
    assert.equal((await ext('GET', '/status', undefined, { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' })).body.code, 'NOT_PAIRED');
    assert.equal((await ext('GET', '/status')).status, 200);
    // Only an extension can start pairing (no Origin, no request).
    const bare = await fetch(base + '/extension/pair', { method: 'POST', headers: { 'content-type': 'application/json', 'x-keys-extension': '1' }, body: '{}' });
    assert.equal(bare.status, 403);

    // A subdomain never overwrites its parent site's saved password; it gets a login of its own.
    const fromSub = (await ext('POST', '/save', { url: 'https://gist.github.com/login', username: 'me', password: 'sub-pass' })).body;
    assert.equal(fromSub.status, 'saved');
    assert.equal((await ext('POST', '/fill', { id: gh, url: 'https://github.com/' })).body.password, 'gh-new', 'the parent login is untouched');

    // A token only works from the extension it was issued to.
    assert.equal((await ext('GET', '/status', undefined, { origin: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba' })).body.code, 'NOT_PAIRED');
    // A subdomain never overwrites its parent site's saved password.
    assert.equal((await ext('POST', '/save/check', { url: 'https://evil.github.com/login', username: 'me', password: 'x' })).body.status, 'new');

    // Removing the browser in the app cuts it off.
    session = '';
    await app('POST', '/unlock', { password: MASTER });
    const id = (await app('GET', '/browsers')).body[0].id;
    assert.equal((await app('DELETE', `/browsers/${id}`)).status, 200);
    assert.equal((await ext('GET', '/status')).body.code, 'NOT_PAIRED');
  } finally {
    ctx.sessions.dispose();
    server.close();
    ctx.store.close();
  }
});
