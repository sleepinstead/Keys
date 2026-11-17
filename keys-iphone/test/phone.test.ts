import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import initSqlJs from 'sql.js';
import { decryptAll, readVault, unlock, WrongCredential } from '../phone/vault.ts';

// Vaults are written by the Rust core of keys-macos (its headless server), each in a scratch HOME,
// never the real one. The reader must stay byte-compatible with it.
const desktop = path.resolve(import.meta.dirname, '../../keys-macos/desktop');
const bin = path.join(desktop, 'target/debug/keys-server');
const cargoEnv = { ...process.env, PATH: `${path.join(os.homedir(), '.cargo/bin')}:${process.env.PATH}` };
before(() => execFileSync('cargo', ['build', '-q', '-p', 'keys-core', '--bin', 'keys-server'], { cwd: desktop, env: cargoEnv, stdio: 'inherit' }));

const servers: { proc: ChildProcess; home: string }[] = [];
after(() => servers.forEach((s) => (s.proc.kill(), fs.rmSync(s.home, { recursive: true, force: true }))));

const login = (title: string, password: string, categoryId: string | null = null) => ({ type: 'login', title, username: 'me', password, url: 'github.com', notes: '', codes: '', categoryId, favorite: false, icon: '', customFields: [] });

let nextPort = 5260;
async function make(credential: string, type: 'password' | 'pin' | 'pattern' = 'password') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-phone-'));
  const port = nextPort++;
  const proc = spawn(bin, [], { env: { ...process.env, HOME: home, KEYS_PORT: String(port) }, stdio: 'ignore' });
  servers.push({ proc, home });
  let token = '';
  const call = async (method: string, route: string, body?: unknown): Promise<any> => {
    const res = await fetch(`http://127.0.0.1:${port}/api${route}`, { method, headers: { 'content-type': 'application/json', 'x-keys-request': '1', ...(token ? { 'x-keys-session': token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    assert.ok(res.ok, `${method} ${route}: ${JSON.stringify(json)}`);
    return json;
  };
  for (let i = 0; ; i++) {
    try {
      token = (await call('POST', '/setup', { password: credential, type })).sessionToken;
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const file = (await call('GET', '/status')).storage.path;
  return { call, file: String(file), stop: () => proc.kill() };
}

test('the phone reader decrypts a vault written by the Rust core', async () => {
  const { call, file } = await make('violet-anchor-tundra-58-quill');
  const cat = await call('POST', '/categories', { name: 'Clients' });
  await call('POST', '/entries', login('GitHub', 's3cret-Ü', cat.id));
  const gone = await call('POST', '/entries', login('Old', 'x'));
  await call('DELETE', `/entries/${gone.id}`);

  const SQL = await initSqlJs();
  const locked = readVault(SQL, fs.readFileSync(file));
  await assert.rejects(unlock(locked, 'nope'), WrongCredential);
  const { entries, categories } = await decryptAll(locked, await unlock(locked, 'violet-anchor-tundra-58-quill'));
  assert.deepEqual(entries.map((e) => [e.title, e.password, e.categoryId]), [['GitHub', 's3cret-Ü', cat.id]]);
  assert.ok(categories.some((c) => c.id === cat.id && c.name === 'Clients'));
});

test('the phone reader unlocks PIN and pattern vaults and rejects other files', async () => {
  for (const [cred, type] of [['482913', 'pin'], ['0-4-8-5', 'pattern']] as const) {
    const { call, file } = await make(cred, type);
    await call('POST', '/entries', login('A', 'b'));
    const locked = readVault(await initSqlJs(), fs.readFileSync(file));
    assert.equal(locked.credential.type, type);
    assert.equal((await decryptAll(locked, await unlock(locked, cred))).entries.length, 1);
  }
  assert.throws(() => readVault(null as never, new Uint8Array([1, 2, 3])));
});
