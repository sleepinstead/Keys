import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { APP_ID } from '../server/db.ts';
import { normalizePath, Storage } from '../server/storage.ts';
import { HttpError } from '../server/validate.ts';

// Everything happens in a throwaway folder: never the default database or the real pointer file.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-storage-test-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const at = (name: string) => path.join(dir, name);
const opts = () => ({ defaultFile: at('default.sqlite'), pointerFile: at('config/location.json') });
const status = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as HttpError).status;
  }
  return 200;
};

test('the default location is used until another file is connected', () => {
  const s = new Storage(opts());
  assert.equal(s.info().isDefault, true);
  assert.equal(s.available, true);
  assert.equal(fs.existsSync(at('config/location.json')), false, 'no pointer for the default');
  s.close();
});

test('a downloaded template can be placed anywhere and connected; the choice survives restarts', () => {
  const bytes = Storage.template();
  assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
  fs.mkdirSync(at('iCloud Drive'));
  const file = at('iCloud Drive/Keys.sqlite');
  fs.writeFileSync(file, bytes);

  const s = new Storage(opts());
  s.store.setMeta('marker', 'default');
  const info = s.connect(file);
  assert.deepEqual([info.path, info.isDefault, info.available], [file, false, true]);
  assert.equal(s.store.getMeta('marker'), null, 'the connected file is a different database');
  s.store.setMeta('marker', 'cloud');
  s.close();

  const again = new Storage(opts());
  assert.equal(again.info().path, file, 'pointer remembered');
  assert.equal(again.store.getMeta('marker'), 'cloud');
  const db = new DatabaseSync(file, { readOnly: true });
  assert.equal((db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id, APP_ID);
  db.close();

  again.useDefault();
  assert.equal(again.store.getMeta('marker'), 'default');
  assert.equal(fs.existsSync(at('config/location.json')), false, 'pointer removed');
  again.close();
});

test('files that are not Keys databases are refused without being changed', () => {
  const s = new Storage(opts());
  fs.writeFileSync(at('notes.txt'), 'hello');
  const other = new DatabaseSync(at('other.sqlite'));
  other.exec('CREATE TABLE photos (id INTEGER)');
  other.close();
  const before = fs.readFileSync(at('other.sqlite'));
  assert.equal(status(() => s.connect(at('notes.txt'))), 400);
  assert.equal(status(() => s.connect(at('other.sqlite'))), 400);
  assert.equal(status(() => s.connect(at('missing.sqlite'))), 400);
  assert.equal(status(() => s.connect(dir)), 400, 'a folder');
  assert.equal(status(() => s.connect('relative/path.sqlite')), 400);
  assert.deepEqual(fs.readFileSync(at('other.sqlite')), before, 'untouched');
  assert.equal(s.info().isDefault, true, 'still on the old file');
  s.close();
});

test('create makes a new file; move copies everything and continues from the copy', () => {
  const s = new Storage(opts());
  s.store.setMeta('wrapped_key', 'secret-ciphertext');
  assert.equal(status(() => s.create(at('nope/Keys.sqlite'))), 400, 'folder must exist');

  const moved = s.move(at('Moved'));
  assert.equal(moved.path, at('Moved.sqlite'), '.sqlite added');
  assert.equal(s.store.getMeta('wrapped_key'), 'secret-ciphertext');
  assert.equal(status(() => s.move(at('Moved.sqlite'))), 409, 'never overwrites');

  const created = s.create(at('Fresh.sqlite'));
  assert.equal(created.path, at('Fresh.sqlite'));
  assert.equal(s.store.getMeta('wrapped_key'), null, 'empty');
  s.close();
});

test('a connected file that goes missing is reported, not replaced', () => {
  const file = at('Gone.sqlite');
  fs.writeFileSync(file, Storage.template());
  const s = new Storage(opts());
  s.connect(file);
  s.close();
  fs.rmSync(file);

  const later = new Storage(opts());
  const info = later.info();
  assert.equal(info.available, false);
  assert.equal(info.path, file);
  assert.match(info.error!, /doesn’t exist/);
  assert.equal(status(() => later.store), 503);
  assert.equal(fs.existsSync(file), false, 'not silently recreated');
  fs.writeFileSync(file, Storage.template());
  assert.equal(later.retry().available, true, 'retry once it is back');
  later.close();
});

test('paths: ~, quotes and file:// URLs are accepted', () => {
  assert.equal(normalizePath('~/Keys.sqlite'), path.join(os.homedir(), 'Keys.sqlite'));
  assert.equal(normalizePath("'/tmp/My Keys.sqlite'"), '/tmp/My Keys.sqlite');
  assert.equal(normalizePath('file:///tmp/My%20Keys.sqlite'), '/tmp/My Keys.sqlite');
});
