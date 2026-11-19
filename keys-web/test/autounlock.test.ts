import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../server/app.ts';

const MASTER = 'violet-anchor-tundra-58-quill';
const NEXT = 'saffron-glacier-orbit-91-harp';
let server: Server;
let base: string;
let ctx: ReturnType<typeof createApp>;
let token = '';

async function call(method: string, url: string, body?: unknown) {
  const res = await fetch(base + url, {
    method,
    headers: { 'content-type': 'application/json', 'x-keys-request': '1', ...(token ? { 'x-keys-session': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (parsed?.sessionToken) token = parsed.sessionToken;
  if (url === '/lock') token = '';
  return { status: res.status, body: parsed };
}

before(async () => {
  ctx = createApp({ dbFile: ':memory:', allowedOrigins: [], fetchRange: async () => 'AAAA:0' });
  await new Promise<void>((resolve) => {
    server = ctx.app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
});

after(() => {
  ctx.sessions.dispose();
  server.close();
  ctx.store.close();
});

test('opening without a password: off by default, needs the password to turn on, survives a password change', async () => {
  assert.equal((await call('POST', '/setup', { password: MASTER })).status, 200);
  assert.equal((await call('GET', '/status')).body.autoUnlock, false);

  await call('POST', '/lock');
  assert.equal((await call('POST', '/unlock/auto')).status, 401, 'refused while off');
  assert.equal((await call('POST', '/auto-unlock', { current: MASTER })).status, 401, 'needs a session');

  await call('POST', '/unlock', { password: MASTER });
  assert.equal((await call('POST', '/auto-unlock', { current: 'wrong-password-here' })).status, 401);
  const on = await call('POST', '/auto-unlock', { current: MASTER });
  assert.equal(on.status, 200);
  assert.equal(on.body.autoUnlock, true);

  await call('POST', '/lock');
  const opened = await call('POST', '/unlock/auto');
  assert.equal(opened.status, 200);
  assert.equal(opened.body.unlocked, true);
  assert.equal((await call('GET', '/entries')).status, 200);

  // A new password re-files the saved key under the new one.
  assert.equal((await call('POST', '/account/change-password', { current: MASTER, next: NEXT })).status, 200);
  await call('POST', '/lock');
  assert.equal((await call('POST', '/unlock/auto')).status, 200);

  const off = await call('DELETE', '/auto-unlock');
  assert.equal(off.body.autoUnlock, false);
  await call('POST', '/lock');
  assert.equal((await call('POST', '/unlock/auto')).status, 401);
});
