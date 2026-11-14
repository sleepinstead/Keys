// Keys for iPhone: a read-only Home Screen web app. It gets the encrypted Keys.sqlite from
// Google Drive (or the Files app), unlocks it on the phone, and lets you look up and copy.
import '@fontsource-variable/inter';
import initSqlJs from 'sql.js';
import type { SqlJsStatic } from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import './phone.css';
import * as cache from './cache.ts';
import * as drive from './drive.ts';
import { decryptAll, readVault, unlock, WrongCredential } from './vault.ts';
import type { LockedVault, PhoneCategory, PhoneEntry } from './vault.ts';

const IDLE_LOCK_MS = 5 * 60_000;
const HIDDEN_LOCK_MS = 60_000;

// ------------------------------------------------------------------ state

let SQL: SqlJsStatic;
let copy: cache.Cached | null = null;
let locked: LockedVault | null = null;
let key: CryptoKey | null = null;
let entries: PhoneEntry[] = [];
let categories: PhoneCategory[] = [];
let openId: string | null = null;
let query = '';
let status: { text: string; action?: { label: string; run: () => void } } | null = null;
let error = '';
let busy = false;
let choices: drive.Found[] | null = null;

const root = document.getElementById('app')!;

// ------------------------------------------------------------------ tiny DOM helper (text only, never HTML)

type Child = Node | string | null | false | undefined;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<Record<string, unknown>> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c) el.append(c);
  return el;
}

const ago = (t: number) => {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

function toast(text: string) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 1600);
}

async function copyText(value: string, what: string) {
  try {
    await navigator.clipboard.writeText(value);
    toast(`${what} copied`);
  } catch {
    toast('Couldn’t copy');
  }
}

// ------------------------------------------------------------------ data flow

async function useBytes(next: cache.Cached) {
  const vault = readVault(SQL, next.bytes); // throws on a non-Keys file, before anything is replaced
  copy = next;
  locked = vault;
  await cache.save(next);
  if (key) await decrypt();
}

async function decrypt() {
  if (!locked || !key) return;
  ({ entries, categories } = await decryptAll(locked, key));
  if (openId && !entries.some((e) => e.id === openId)) openId = null;
}

/** Asks Drive whether the file changed and downloads it if so. Quiet when offline. */
async function refresh() {
  if (copy?.source !== 'drive' || !copy.fileId) return;
  if (!drive.signedIn()) {
    status = { text: `Saved copy from ${ago(copy.fetchedAt)}`, action: { label: 'Check for changes', run: drive.signIn } };
    return render();
  }
  try {
    const info = await drive.fileInfo(copy.fileId);
    if (info.version !== copy.version) {
      const bytes = await drive.download(copy.fileId);
      await useBytes({ ...copy, name: info.name, version: info.version, bytes, fetchedAt: Date.now() });
    } else {
      copy = { ...copy, fetchedAt: Date.now() };
      await cache.save(copy);
    }
    status = { text: `Up to date · ${new Date(info.modifiedTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` };
  } catch (e) {
    status =
      e instanceof drive.SignInNeeded
        ? { text: `Saved copy from ${ago(copy.fetchedAt)}`, action: { label: 'Check for changes', run: drive.signIn } }
        : { text: navigator.onLine ? (e as Error).message : `Offline · saved copy from ${ago(copy.fetchedAt)}` };
  }
  render();
}

async function chooseFromDrive() {
  if (!drive.signedIn()) {
    sessionStorage.setItem('keys-after-signin', 'pick');
    return drive.signIn();
  }
  try {
    busy = true;
    render();
    const found = await drive.findVaults();
    busy = false;
    if (found.length === 0) throw new Error('No Keys.sqlite in your Google Drive. Check the file is uploaded, then try again.');
    if (found.length > 1) {
      choices = found;
      error = '';
      return render();
    }
    await openFromDrive(found[0]!);
  } catch (e) {
    busy = false;
    error = (e as Error).message;
    render();
  }
}

async function openFromDrive(picked: { id: string }) {
  choices = null;
  try {
    busy = true;
    render();
    const info = await drive.fileInfo(picked.id);
    await useBytes({ source: 'drive', fileId: picked.id, name: info.name, version: info.version, bytes: await drive.download(picked.id), fetchedAt: Date.now() });
    status = { text: 'Up to date' };
    error = '';
  } catch (e) {
    error = (e as Error).message;
  }
  busy = false;
  render();
}

async function chooseLocalFile(file: File) {
  try {
    await useBytes({ source: 'file', fileId: null, name: file.name, version: null, bytes: new Uint8Array(await file.arrayBuffer()), fetchedAt: Date.now() });
    status = { text: `Opened ${file.name} · pick it again to update` };
    error = '';
  } catch (e) {
    error = (e as Error).message;
  }
  render();
}

async function tryUnlock(credential: string) {
  if (!locked || busy || !credential) return;
  busy = true;
  error = '';
  render();
  await new Promise((r) => setTimeout(r, 30)); // let "Unlocking…" paint before Argon2 takes the main thread
  try {
    key = await unlock(locked, credential);
    await decrypt();
    void refresh();
  } catch (e) {
    error = e instanceof WrongCredential ? wrongText() : (e as Error).message;
  }
  busy = false;
  render();
}

const wrongText = () => (locked?.credential.type === 'pin' ? 'Wrong PIN' : locked?.credential.type === 'pattern' ? 'Wrong pattern' : 'Wrong password');

function lock() {
  key = null; // the CryptoKey is non-extractable; dropping it is all we can do
  entries = [];
  categories = [];
  openId = null;
  query = '';
  render();
}

async function forgetFile() {
  if (!confirm('Remove the saved copy from this iPhone? Your file in Google Drive stays as it is.')) return;
  await cache.forget();
  lock();
  copy = null;
  locked = null;
  status = null;
  render();
}

// ------------------------------------------------------------------ auto-lock

let idleTimer = 0;
let hiddenAt = 0;
const bumpIdle = () => {
  clearTimeout(idleTimer);
  if (key) idleTimer = window.setTimeout(lock, IDLE_LOCK_MS);
};
addEventListener('pointerdown', bumpIdle, { passive: true });
addEventListener('keydown', bumpIdle);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenAt = Date.now();
  else {
    if (key && hiddenAt && Date.now() - hiddenAt > HIDDEN_LOCK_MS) lock();
    void refresh();
  }
});

// ------------------------------------------------------------------ screens

function render() {
  const scroll = root.querySelector('.scroll')?.scrollTop ?? 0;
  const focused = document.activeElement?.id;
  root.replaceChildren(!locked ? startScreen() : !key ? lockScreen() : openId ? detailScreen() : listScreen());
  if (focused) (document.getElementById(focused) as HTMLInputElement | null)?.focus({ preventScroll: true });
  const sc = root.querySelector('.scroll');
  if (sc && !openId) sc.scrollTop = scroll;
  bumpIdle();
}

const brand = () => h('div', { class: 'brand' }, h('img', { src: './favicon.png', alt: '', width: 40, height: 40 }), h('span', {}, 'Keys'));

function filePicker(label: string, cls: string) {
  const input = h('input', { type: 'file', class: 'sr-only', id: 'file-input', onchange: () => input.files?.[0] && chooseLocalFile(input.files[0]) });
  return h('label', { class: cls }, label, input);
}

function startScreen() {
  return h(
    'main',
    { class: 'center' },
    brand(),
    h('h1', {}, 'Your passwords, on your iPhone'),
    h('p', { class: 'muted' }, 'Keys opens the vault file your computers use, unlocks it on this phone, and never changes it.'),
    drive.driveConfigured
      ? choices
        ? h(
            'div',
            { class: 'stack' },
            h('p', { class: 'muted' }, 'Which one is your vault?'),
            ...choices.map((f) =>
              h('button', { class: 'btn choice', disabled: busy, onclick: () => openFromDrive(f) },
                h('strong', {}, f.name),
                h('small', {}, [f.folder, new Date(f.modifiedTime).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })].filter(Boolean).join(' · ')),
              ),
            ),
          )
        : h('button', { class: 'btn primary', disabled: busy, onclick: chooseFromDrive }, busy ? 'Looking in Google Drive…' : 'Open from Google Drive')
      : h('p', { class: 'note' }, 'Google Drive isn’t set up in this build yet. You can still open the file from the Files app.'),
    filePicker('Open from Files instead', 'btn'),
    error && h('p', { class: 'error', role: 'alert' }, error),
  );
}

function lockScreen() {
  const kind = locked!.credential;
  const form =
    kind.type === 'pattern'
      ? patternPad()
      : kind.type === 'pin'
        ? pinCells(kind.length)
        : (() => {
          const input = h('input', {
            id: 'credential',
            class: 'input',
            type: 'password',
            autocomplete: 'current-password',
            placeholder: kind.type === 'passphrase' ? 'Passphrase' : 'Master password',
            disabled: busy,
          });
          return h(
            'form',
            { class: 'stack', onsubmit: (e: Event) => (e.preventDefault(), tryUnlock(input.value)) },
            input,
            h('button', { class: 'btn primary', disabled: busy }, busy ? 'Unlocking…' : 'Unlock'),
          );
        })();
  queueMicrotask(() => document.getElementById('credential')?.focus());
  return h(
    'main',
    { class: 'center' },
    brand(),
    h('p', { class: 'muted' }, copy ? `${copy.name} · ${copy.source === 'drive' ? 'Google Drive' : 'from Files'} · ${ago(copy.fetchedAt)}` : ''),
    form,
    error && h('p', { class: 'error', role: 'alert' }, error),
    h('button', { class: 'link', onclick: forgetFile }, 'Use a different file'),
  );
}

/** The desktop app's PIN boxes: one hidden numeric field under a row of cells; unlocks when full. */
function pinCells(length: number) {
  const cells = Array.from({ length }, (_, i) => h('span', { class: 'otp-cell', style: `--i:${i}`, 'aria-hidden': 'true' }));
  const paint = (value: string, focused: boolean) =>
    cells.forEach((c, i) => {
      const filled = i < value.length;
      c.toggleAttribute('data-filled', filled);
      c.toggleAttribute('data-current', focused && i === Math.min(value.length, length - 1) && (!filled || value.length === length));
      if (filled !== !!c.firstChild) c.replaceChildren(...(filled ? [h('span', { class: 'otp-dot' })] : []));
    });
  const input = h('input', {
    id: 'credential',
    class: 'otp-input',
    type: 'password',
    inputMode: 'numeric',
    pattern: '[0-9]*',
    autocomplete: 'off',
    maxLength: length,
    disabled: busy,
    'aria-label': `${length}-digit PIN`,
    oninput: () => {
      input.value = input.value.replace(/\D/g, '').slice(0, length);
      paint(input.value, true);
      if (input.value.length === length) void tryUnlock(input.value);
    },
    onfocus: () => paint(input.value, true),
    onblur: () => paint(input.value, false),
  });
  const row = h('div', { class: 'otp', 'data-length': length, 'data-invalid': error ? '' : undefined, 'data-busy': busy ? '' : undefined, onclick: () => input.focus() }, input);
  cells.forEach((c, i) => {
    if (length === 6 && i === 3) row.append(h('span', { class: 'otp-sep', 'aria-hidden': 'true' }));
    row.append(c);
  });
  paint(busy ? '•'.repeat(length) : '', false);
  return h('div', { class: 'stack' }, h('p', { class: 'muted pin-hint' }, busy ? 'Unlocking…' : `Enter your ${length}-digit PIN`), row);
}

function patternPad() {
  const points: number[] = [];
  const dots = Array.from({ length: 9 }, (_, i) =>
    h('button', {
      type: 'button',
      class: 'dot',
      'aria-label': `Dot ${i + 1}`,
      disabled: busy,
      onclick: () => {
        if (points.includes(i)) return;
        points.push(i);
        dots[i]!.dataset.n = String(points.length);
      },
    }),
  );
  return h(
    'div',
    { class: 'stack' },
    h('p', { class: 'muted' }, 'Tap the dots in the order you draw your pattern.'),
    h('div', { class: 'pad' }, ...dots),
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => (points.length = 0, dots.forEach((d) => delete d.dataset.n)) }, 'Clear'),
      h('button', { class: 'btn primary', type: 'button', disabled: busy, onclick: () => tryUnlock(points.join('-')) }, busy ? 'Unlocking…' : 'Unlock'),
    ),
  );
}

function statusBar() {
  if (!status) return null;
  return h(
    'div',
    { class: 'status' },
    h('span', {}, status.text),
    status.action && h('button', { class: 'link', onclick: status.action.run }, status.action.label),
  );
}

function avatar(e: PhoneEntry) {
  if (e.icon.startsWith('data:image/')) return h('img', { class: 'avatar', src: e.icon, alt: '' });
  return h('span', { class: 'avatar', 'aria-hidden': 'true' }, (e.title.trim()[0] ?? '?').toUpperCase());
}

const TYPE_LABEL = { login: 'Login', note: 'Secure note', apiKey: 'API key', recovery: 'Recovery codes' } as const;

function listBody() {
  const q = query.trim().toLowerCase();
  const shown = q ? entries.filter((e) => `${e.title} ${e.username} ${e.url}`.toLowerCase().includes(q)) : entries;
  const favs = q ? [] : shown.filter((e) => e.favorite);
  const row = (e: PhoneEntry) =>
    h(
      'li',
      {},
      h(
        'button',
        { class: 'item', onclick: () => ((openId = e.id), render(), scrollTo(0, 0)) },
        avatar(e),
        h('span', { class: 'item-text' }, h('strong', {}, e.title || 'Untitled'), h('small', {}, e.username || TYPE_LABEL[e.type])),
      ),
    );
  return h(
    'div',
    { class: 'scroll' },
    favs.length > 0 && h('h2', {}, 'Favorites'),
    favs.length > 0 && h('ul', { class: 'list' }, ...favs.map(row)),
    !q && favs.length > 0 && h('h2', {}, 'All items'),
    shown.length ? h('ul', { class: 'list' }, ...shown.map(row)) : h('p', { class: 'muted pad-x' }, q ? 'Nothing matches.' : 'No items yet.'),
  );
}

function listScreen() {
  return h(
    'main',
    { class: 'screen' },
    h(
      'header',
      { class: 'bar' },
      brand(),
      h('button', { class: 'btn small', onclick: lock }, 'Lock'),
    ),
    statusBar(),
    h('div', { class: 'search' }, h('input', {
      id: 'search',
      class: 'input',
      type: 'search',
      placeholder: `Search ${entries.length} items`,
      value: query,
      autocomplete: 'off',
      oninput: (ev: Event) => {
        query = (ev.target as HTMLInputElement).value;
        root.querySelector('.scroll')?.replaceWith(listBody());
      },
    })),
    listBody(),
  );
}

function field(label: string, value: string, opts: { secret?: boolean; mono?: boolean; link?: boolean } = {}) {
  if (!value) return null;
  let shown = !opts.secret;
  const text = h('div', { class: `value${opts.mono || opts.secret ? ' mono' : ''}` });
  const paint = () => (text.textContent = shown ? value : '•'.repeat(Math.min(value.length, 14)));
  paint();
  const reveal =
    opts.secret &&
    h('button', { class: 'btn small', onclick: (ev: Event) => ((shown = !shown), paint(), ((ev.target as HTMLElement).textContent = shown ? 'Hide' : 'Show')) }, 'Show');
  const url = opts.link ? (/^https?:\/\//i.test(value) ? value : `https://${value}`) : null;
  return h(
    'div',
    { class: 'field' },
    h('div', { class: 'field-main' }, h('span', { class: 'label' }, label), text),
    h(
      'div',
      { class: 'actions' },
      reveal,
      url && h('a', { class: 'btn small', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Open'),
      h('button', { class: 'btn small', onclick: () => copyText(value, label) }, 'Copy'),
    ),
  );
}

function detailScreen() {
  const e = entries.find((x) => x.id === openId)!;
  const cat = categories.find((c) => c.id === e.categoryId)?.name;
  const isLogin = e.type === 'login';
  return h(
    'main',
    { class: 'screen' },
    h('header', { class: 'bar' }, h('button', { class: 'btn small', onclick: () => ((openId = null), render()) }, '‹ Back'), h('button', { class: 'btn small', onclick: lock }, 'Lock')),
    h(
      'div',
      { class: 'scroll detail' },
      h('div', { class: 'detail-head' }, avatar(e), h('div', {}, h('h1', {}, e.title || 'Untitled'), h('p', { class: 'muted' }, [TYPE_LABEL[e.type], cat].filter(Boolean).join(' · ')))),
      h(
        'section',
        { class: 'card' },
        field(isLogin ? 'Username' : e.type === 'apiKey' ? 'Key ID' : 'Account', e.username),
        field(isLogin ? 'Password' : 'Secret', e.password, { secret: true }),
        field('Website', e.url, { link: true }),
        ...e.customFields.map((f) => field(f.label || 'Field', f.value, { secret: f.hidden })),
      ),
      e.codes && h('section', { class: 'card' }, field('Recovery codes', e.codes, { secret: true, mono: true })),
      e.notes && h('section', { class: 'card' }, h('div', { class: 'field' }, h('div', { class: 'field-main' }, h('span', { class: 'label' }, 'Notes'), h('div', { class: 'value notes' }, e.notes)))),
      h('p', { class: 'muted small' }, `Last changed ${ago(e.updatedAt)}`),
    ),
  );
}

// ------------------------------------------------------------------ start

async function start() {
  drive.finishSignIn();
  if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  SQL = await initSqlJs({ locateFile: () => wasmUrl });
  copy = await cache.load();
  if (copy) {
    try {
      locked = readVault(SQL, copy.bytes);
      status = { text: `Saved copy from ${ago(copy.fetchedAt)}` };
    } catch {
      copy = null;
    }
  }
  render();
  if (sessionStorage.getItem('keys-after-signin') === 'pick' && drive.signedIn()) {
    sessionStorage.removeItem('keys-after-signin');
    void chooseFromDrive();
  } else void refresh();
}

start().catch((e: unknown) => {
  root.replaceChildren(h('main', { class: 'center' }, h('p', { class: 'error' }, `Keys couldn’t start: ${(e as Error).message}`)));
});
