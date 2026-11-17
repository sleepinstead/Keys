import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { decrypt, decryptJson, deriveKey, encrypt, encryptJson, KeyWipedError, newKdfParams } from '../server/crypto.ts';
import { estimateEntropy, generatePassword, isObviousPin, randomInt } from '../shared/generator.ts';
import { WORDS } from '../shared/wordlist.ts';
import { buildAuditReport, checkBreaches, parseRange, sha1Upper } from '../server/audit.ts';
import { parseCsv, toCsv } from '../server/importExport.ts';
import { DEFAULT_SETTINGS } from '../shared/types.ts';
import type { Entry } from '../shared/types.ts';
import { fetchSiteIcon, iconCandidates, siteUrl } from '../server/favicon.ts';
import { HttpError, sanitizeEntryInput, sanitizeSettings } from '../server/validate.ts';

test('AES-GCM round-trips and rejects tampering or wrong AAD', () => {
  const key = crypto.randomBytes(32);
  const blob = encrypt(key, Buffer.from('secret'), 'ctx:1');
  assert.equal(decrypt(key, blob, 'ctx:1').toString(), 'secret');
  assert.throws(() => decrypt(key, blob, 'ctx:2'));
  const tampered = Buffer.from(blob);
  tampered[tampered.length - 1]! ^= 1;
  assert.throws(() => decrypt(key, tampered, 'ctx:1'));
  assert.throws(() => decrypt(crypto.randomBytes(32), blob, 'ctx:1'));
});

test('a wiped (zeroed) key is refused', () => {
  const key = crypto.randomBytes(32);
  const blob = encryptJson(key, { a: 1 }, 'x');
  key.fill(0);
  assert.throws(() => encryptJson(key, { a: 1 }, 'x'), KeyWipedError);
  assert.throws(() => decryptJson(key, blob, 'x'), KeyWipedError);
});

test('Argon2id derivation is deterministic per salt and differs across salts', async () => {
  const params = newKdfParams();
  const a = await deriveKey('correct horse battery staple', params);
  const b = await deriveKey('correct horse battery staple', params);
  const c = await deriveKey('correct horse battery staple', newKdfParams());
  assert.equal(a.length, 32);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test('generator honours length and character sets', () => {
  for (let i = 0; i < 200; i++) {
    const pw = generatePassword({ length: 16, symbols: false, digits: true, uppercase: true, lowercase: true });
    assert.equal(pw.length, 16);
    assert.match(pw, /^[A-Za-z0-9]+$/);
    assert.match(pw, /[A-Z]/);
    assert.match(pw, /[a-z]/);
    assert.match(pw, /[0-9]/);
  }
  const noAmb = generatePassword({ length: 128, excludeAmbiguous: true });
  assert.doesNotMatch(noAmb, /[lI1O0o]/);
  assert.throws(() => generatePassword({ lowercase: false, uppercase: false, digits: false, symbols: false }));
  assert.equal(estimateEntropy({ length: 10, lowercase: true, uppercase: false, digits: false, symbols: false }), 47);
});

test('passphrase and PIN modes', () => {
  assert.equal(WORDS.length, 7776);
  const phrase = generatePassword({ mode: 'passphrase', words: 6, separator: '.', capitalize: true, includeNumber: true });
  const parts = phrase.split('.');
  assert.equal(parts.length, 6);
  assert.ok(parts.every((w) => /^[A-Z][a-z]+\d?$/.test(w)));
  assert.equal(parts.filter((w) => /\d$/.test(w)).length, 1);
  assert.equal(estimateEntropy({ mode: 'passphrase', words: 5, includeNumber: false }), 65);
  for (const len of [4, 6, 8]) {
    for (let i = 0; i < 200; i++) {
      const pin = generatePassword({ mode: 'pin', pinLength: len });
      assert.match(pin, new RegExp(`^\\d{${len}}$`));
      assert.equal(isObviousPin(pin), false);
    }
  }
  assert.deepEqual(['0000', '1234', '9876', '1212', '123456', '4821'].map(isObviousPin), [true, true, true, true, true, false]);
});

test('randomInt is roughly uniform', () => {
  const counts = new Array(6).fill(0);
  for (let i = 0; i < 60_000; i++) counts[randomInt(6)]++;
  for (const c of counts) assert.ok(c > 9_000 && c < 11_000, `bucket ${c}`);
});

const entry = (id: string, password: string, extra: Partial<Entry> = {}): Entry => ({
  id,
  type: 'login',
  title: id,
  username: 'me',
  password,
  url: '',
  notes: '',
  codes: '',
  categoryId: null,
  favorite: false,
  icon: '',
  customFields: [],
  passwordUpdatedAt: Date.now(),
  history: [],
  breach: null,
  createdAt: Date.now(),
  updatedAt: Date.now(),
  ...extra,
});

test('audit flags weak, reused, outdated and breached passwords', () => {
  const old = Date.now() - 400 * 86_400_000;
  const report = buildAuditReport(
    [
      entry('a', 'password1'),
      entry('b', 'Xk#9vQ!m2Lp@7wRz$4Tn', { passwordUpdatedAt: old }),
      entry('c', 'Xk#9vQ!m2Lp@7wRz$4Tn'),
      entry('d', 'tB8^qW3!zN6&yH1@pL5%', { breach: { count: 12, checkedAt: Date.now() } }),
      entry('e', 'Zr7&Fm2!Qx9#Lc4$Vb8@'),
      { ...entry('f', 'weak'), type: 'note' },
    ],
    DEFAULT_SETTINGS,
  );
  const byId = Object.fromEntries(report.items.map((i) => [i.id, i.issues]));
  assert.equal(report.totals.logins, 5);
  assert.ok(byId.a!.includes('weak'));
  assert.deepEqual(byId.b!.sort(), ['outdated', 'reused']);
  assert.deepEqual(byId.c, ['reused']);
  assert.deepEqual(byId.d, ['breached']);
  assert.deepEqual(byId.e, []);
  assert.equal(report.reusedGroups.length, 1);
  assert.ok(report.health < 100 && report.health > 0);
});

test('breach check only sends 5-char SHA-1 prefixes and ignores padding', async () => {
  const sent: string[] = [];
  const pwnedHash = sha1Upper('hunter2');
  const fetcher = async (prefix: string) => {
    sent.push(prefix);
    return prefix === pwnedHash.slice(0, 5) ? `${pwnedHash.slice(5)}:4242\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0` : 'AAAA:0';
  };
  const res = await checkBreaches(
    [
      { id: '1', password: 'hunter2' },
      { id: '2', password: 'Zr7&Fm2!Qx9#Lc4$Vb8@' },
      { id: '3', password: 'hunter2' },
    ],
    fetcher,
  );
  assert.ok(sent.every((p) => /^[0-9A-F]{5}$/.test(p)));
  assert.equal(sent.length, 2, 'identical passwords share one lookup');
  assert.equal(res.get('1'), 4242);
  assert.equal(res.get('3'), 4242);
  assert.equal(res.get('2'), 0);
  assert.equal(parseRange('ABC:1\nDEF:0').get('DEF'), 0);
});

test('CSV parser handles quotes, commas, newlines and BOM', () => {
  const rows = [
    ['name', 'password', 'notes'],
    ['a,b', 'p"q', 'line1\nline2'],
  ];
  assert.deepEqual(parseCsv('﻿' + toCsv(rows)), rows);
  assert.deepEqual(parseCsv('x,y\r\n1,2'), [
    ['x', 'y'],
    ['1', '2'],
  ]);
});

test('website icons: candidates, private addresses and stored-icon validation', async () => {
  const base = new URL('https://example.com/');
  const html = `<link rel="icon" href="/fav.ico"><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"><link rel="mask-icon" href="/m.svg">`;
  assert.deepEqual(iconCandidates(html, base).map((u) => u.pathname), ['/touch.png', '/fav.ico']);
  assert.equal(siteUrl('github.com/login').href, 'https://github.com/');

  // Local and private addresses are refused before anything is fetched.
  for (const url of ['localhost:5174', 'http://127.0.0.1', 'http://192.168.1.1', 'http://[::1]/']) {
    await assert.rejects(fetchSiteIcon(url), (e: HttpError) => e.status === 400, url);
  }

  const png = Buffer.alloc(64, 1);
  const fake = async (url: URL) =>
    url.pathname === '/'
      ? new Response(html, { headers: { 'content-type': 'text/html' } })
      : url.pathname === '/touch.png'
        ? new Response(png, { headers: { 'content-type': 'image/png' } })
        : new Response('nope', { status: 404 });
  assert.equal(await fetchSiteIcon('example.com', fake), `data:image/png;base64,${png.toString('base64')}`);
  await assert.rejects(fetchSiteIcon('example.com', async () => new Response('', { status: 404 })), (e: HttpError) => e.status === 404);

  const input = { type: 'login', title: 'x' };
  assert.equal(sanitizeEntryInput({ ...input, icon: 'data:image/png;base64,AAAA' }).icon, 'data:image/png;base64,AAAA');
  assert.equal(sanitizeEntryInput(input).icon, '');
  assert.throws(() => sanitizeEntryInput({ ...input, icon: 'data:image/svg+xml;base64,AAAA' }), HttpError);
  assert.throws(() => sanitizeEntryInput({ ...input, icon: 'https://evil.example/x.png' }), HttpError);
  assert.equal(sanitizeEntryInput({ ...input, icon: 'none' }).icon, 'none', "'none' keeps the letter");
  assert.equal(sanitizeEntryInput({ ...input, icon: 'tint:blue' }).icon, 'tint:blue', 'coloured letter tile');
  assert.throws(() => sanitizeEntryInput({ ...input, icon: 'tint:chartreuse' }), HttpError);
  assert.deepEqual(DEFAULT_SETTINGS.hideIcons, { login: false, note: true, apiKey: true, recovery: true });
  assert.equal(sanitizeSettings({ hideIcons: { note: false, bogus: true } }).hideIcons.note, false);
  assert.equal(sanitizeSettings({ hideLoginIcons: true }).hideIcons.login, true, 'old switch still read');
});
