// The toolbar popup: connect this browser, unlock, and fill or copy logins for the current tab.
// Everything comes from Keys through the background worker; nothing is kept here.

const view = document.getElementById('view');
const statusPill = document.getElementById('status');
const lockButton = document.getElementById('lock');
const openButton = document.getElementById('open-app');
let pollTimer = null;

// Lucide icons, the same set the app uses. Static markup only.
const ICONS = {
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  key: '<path d="M2.586 17.414A2 2 0 0 0 2 18.828V21a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h1a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1h.172a2 2 0 0 0 1.414-.586l.814-.814a6.5 6.5 0 1 0-4-4z"/><circle cx="16.5" cy="7.5" r=".5" fill="currentColor"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4"/><path d="M12 16h.01"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Builds an element. Text always goes in as text, never as HTML. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  el.append(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  return el;
}

/** Asks the background worker; throws with Keys' own message on failure. */
async function ask(type, extra = {}) {
  const res = await chrome.runtime.sendMessage({ type, ...extra });
  if (!res?.ok) {
    const err = new Error(res?.error ?? 'Something went wrong');
    err.code = res?.code;
    throw err;
  }
  return res.result;
}

function toast(text, error = false) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: error ? 'alert' : 'status' }, icon(error ? 'alert' : 'check'), text);
  document.body.append(t);
  setTimeout(() => t.remove(), 2400);
}

const openApp = async (hash) => {
  await ask('keys:open-app', { hash }).catch(() => {});
  window.close();
};

openButton.append(icon('external'));
openButton.addEventListener('click', () => void openApp(''));
lockButton.append(icon('lock'));
lockButton.addEventListener('click', async () => {
  await ask('keys:lock').catch(() => {});
  void render();
});

const hostOf = (url) => {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : '';
  } catch {
    return '';
  }
};

const letter = (text) => (text.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();

function mono(title, iconUrl) {
  const tile = h('span', { class: 'mono', 'aria-hidden': 'true' });
  if (/^data:image\/(png|jpeg|webp);base64,/.test(iconUrl ?? '')) tile.append(h('img', { src: iconUrl, alt: '' }));
  else tile.textContent = letter(title);
  return tile;
}

function hero(iconName, title, text, ...rest) {
  return h('section', { class: 'hero' }, h('span', { class: 'hero-icon', 'aria-hidden': 'true' }, icon(iconName)), h('h1', {}, title), h('p', {}, text), ...rest);
}

// ------------------------------------------------------------------ states

function offline(state) {
  const address = h('input', { class: 'input input-plain', value: state.server, 'aria-label': 'Keys address', spellcheck: 'false' });
  const error = h('p', { class: 'error', role: 'alert' });
  const form = h(
    'form',
    {
      class: 'address',
      hidden: true,
      onSubmit: async (e) => {
        e.preventDefault();
        try {
          await ask('keys:set-server', { server: address.value.trim() });
          void render();
        } catch (err) {
          error.textContent = err.message;
        }
      },
    },
    address,
    h('button', { type: 'submit', class: 'btn btn-outline btn-block' }, 'Save address'),
    error,
  );
  const change = h('button', { type: 'button', class: 'text-btn', onClick: () => ((form.hidden = false), (change.hidden = true), address.focus()) }, 'Change address');
  return hero(
    'power',
    'Keys isn’t running',
    'Start Keys on this computer, then try again.',
    h('div', { class: 'hero-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onClick: () => void render() }, 'Try again'), change, form),
  );
}

function unpaired(state) {
  const error = h('p', { class: 'error', role: 'alert' });
  if (!state.pairing) {
    return hero(
      'link',
      'Connect this browser',
      'Fill passwords from Keys on any site. Nothing is copied into the browser.',
      h(
        'div',
        { class: 'hero-actions' },
        state.expired ? h('p', { class: 'error', role: 'alert' }, 'That code expired. Start again to get a new one.') : null,
        h(
          'button',
          {
            type: 'button',
            class: 'btn btn-primary btn-lg btn-block',
            onClick: async () => {
              try {
                await ask('keys:pair');
                void render();
              } catch (err) {
                error.textContent = err.message;
              }
            },
          },
          'Connect to Keys',
        ),
        error,
      ),
    );
  }
  const code = state.pairing.code;
  pollTimer = setInterval(async () => {
    try {
      const { status } = await ask('keys:pair-poll');
      if (status !== 'pending') void render();
    } catch {
      /* try again next tick */
    }
  }, 1500);
  const cells = [...code].map((c) => h('span', { class: 'code-cell' }, c));
  return hero(
    'link',
    'Enter this code in Keys',
    'Keys opens at the right place. The code works for 3 minutes.',
    h(
      'button',
      {
        type: 'button',
        class: 'code',
        title: 'Copy code',
        'aria-label': `Copy code ${[...code].join(' ')}`,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(code);
            toast('Code copied. Paste it in Keys');
          } catch {
            toast('Couldn’t copy. Type the code instead', true);
          }
        },
      },
      cells.slice(0, 3),
      h('span', { class: 'code-dot' }),
      cells.slice(3),
    ),
    h('span', { class: 'code-hint' }, icon('copy'), 'Click the code to copy it'),
    h(
      'div',
      { class: 'hero-actions' },
      h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onClick: async () => { await navigator.clipboard.writeText(code).catch(() => {}); void openApp('#connect-browser'); } }, 'Copy code and open Keys', icon('external')),
      h('span', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Waiting for Keys'),
      h(
        'button',
        {
          type: 'button',
          class: 'text-btn',
          onClick: async () => {
            await ask('keys:pair-cancel');
            void render();
          },
        },
        'Cancel',
      ),
    ),
  );
}

function locked(state) {
  const type = state.credential?.type ?? 'password';
  if (type === 'pattern') {
    return hero(
      'lock',
      'Keys is locked',
      'Your vault unlocks with a pattern. Draw it in Keys, then come back.',
      h('div', { class: 'hero-actions' }, h('button', { type: 'button', class: 'btn btn-primary btn-lg btn-block', onClick: () => void openApp('') }, 'Unlock in Keys')),
    );
  }
  const pin = type === 'pin';
  const name = { password: 'master password', passphrase: 'passphrase', pin: 'PIN' }[type];
  if (pin) return lockedPin(state.credential.length);
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
    'aria-label': `Your ${name}`,
    placeholder: pin ? `${state.credential.length}-digit PIN` : name[0].toUpperCase() + name.slice(1),
    inputmode: pin ? 'numeric' : null,
    maxlength: pin ? String(state.credential.length) : null,
    autofocus: true,
  });
  const error = h('p', { class: 'error', role: 'alert' });
  const submit = h('button', { type: 'submit', class: 'btn btn-primary btn-lg btn-block' }, 'Unlock');
  const form = h(
    'form',
    {
      class: 'hero-actions',
      onSubmit: async (e) => {
        e.preventDefault();
        if (!input.value) return;
        submit.disabled = true;
        error.textContent = '';
        input.removeAttribute('aria-invalid');
        try {
          await ask('keys:unlock', { secret: input.value });
          void render();
        } catch (err) {
          error.textContent = err.message;
          input.setAttribute('aria-invalid', 'true');
          input.select();
          submit.disabled = false;
        }
      },
    },
    h('label', { class: 'field' }, icon('lock'), input),
    submit,
    error,
  );
  return hero('lock', 'Keys is locked', `Enter your ${name} to fill passwords in this browser.`, form);
}

/** PIN unlock drawn like the app's: one box per digit, sent as soon as the last one is typed. */
function lockedPin(length) {
  const input = h('input', {
    class: 'otp-input',
    type: 'password',
    inputmode: 'numeric',
    autocomplete: 'off',
    maxlength: String(length),
    'aria-label': `Your ${length}-digit PIN`,
    autofocus: true,
  });
  const cells = Array.from({ length }, () => h('span', { class: 'otp-cell', 'aria-hidden': 'true' }));
  const half = Math.ceil(length / 2);
  const box = h('div', { class: 'otp' }, input, cells.slice(0, half), h('span', { class: 'otp-sep', 'aria-hidden': 'true' }), cells.slice(half));
  const error = h('p', { class: 'error', role: 'alert' });
  let busy = false;

  const paint = () => {
    const value = input.value;
    const focused = document.activeElement === input;
    cells.forEach((cell, i) => {
      cell.toggleAttribute('data-filled', i < value.length);
      cell.toggleAttribute('data-current', focused && !busy && i === Math.min(value.length, length - 1) && value.length < length);
      cell.replaceChildren(...(i < value.length ? [h('span', { class: 'otp-dot' })] : []));
    });
  };

  input.addEventListener('input', async () => {
    input.value = input.value.replace(/\D/g, '').slice(0, length);
    box.removeAttribute('data-invalid');
    error.textContent = '';
    paint();
    if (input.value.length < length || busy) return;
    busy = true;
    paint();
    // PIN checks are slow on purpose (they resist guessing), so say something is happening.
    error.replaceChildren(h('span', { class: 'waiting' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), 'Checking'));
    try {
      await ask('keys:unlock', { secret: input.value });
      error.replaceChildren();
      box.setAttribute('data-success', '');
      setTimeout(() => void render(), 350);
    } catch (err) {
      error.textContent = err.message;
      box.setAttribute('data-invalid', '');
      setTimeout(() => {
        input.value = '';
        busy = false;
        paint();
      }, 420);
    }
  });
  input.addEventListener('focus', paint);
  input.addEventListener('blur', paint);
  paint();
  return hero('lock', 'Keys is locked', `Enter your ${length}-digit PIN to fill passwords in this browser.`, h('div', { class: 'hero-actions' }, box, error));
}

function loginRow(login, { canFill, tab, clearSeconds }) {
  const copy = async (what) => {
    try {
      const secret = await ask('keys:secret', { id: login.id });
      await navigator.clipboard.writeText(what === 'password' ? secret.password : secret.username);
      if (what === 'password') {
        await ask('keys:copied', { seconds: clearSeconds });
        toast(clearSeconds ? `Copied password. Clears in ${Math.max(30, clearSeconds)}s` : 'Copied password');
      } else toast('Copied username');
    } catch (err) {
      toast(err.message, true);
    }
  };
  return h(
    'li',
    { class: 'row' },
    mono(login.title, login.icon),
    h('span', { class: 'row-text' }, h('span', { class: 'row-title' }, login.title), h('span', { class: 'row-sub' }, login.username || hostOf(login.url) || 'No username')),
    h(
      'span',
      { class: 'row-actions' },
      login.username
        ? h('button', { type: 'button', class: 'icon-btn', title: 'Copy username', 'aria-label': `Copy username for ${login.title}`, onClick: () => void copy('username') }, icon('user'))
        : null,
      h('button', { type: 'button', class: 'icon-btn', title: 'Copy password', 'aria-label': `Copy password for ${login.title}`, onClick: () => void copy('password') }, icon('key')),
      canFill
        ? h(
            'button',
            {
              type: 'button',
              class: 'btn btn-primary btn-sm',
              onClick: async () => {
                try {
                  const res = await ask('keys:fill-tab', { tabId: tab.id, id: login.id });
                  if (res?.filled === false) toast('No login form on this page. Copy the password instead.', true);
                  else window.close();
                } catch (err) {
                  toast(err.message, true);
                }
              },
            },
            'Fill',
          )
        : null,
    ),
  );
}

async function unlocked(state) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = hostOf(tab?.url ?? '');
  const { logins } = await ask('keys:logins', { url: site ? tab.url : '' });
  const matches = logins.filter((l) => l.matches);
  const ctx = { tab, clearSeconds: state.clipboardClearSeconds };

  const results = h('div', { class: 'results' });
  const search = h('input', { class: 'input', type: 'search', placeholder: `Search ${logins.length} ${logins.length === 1 ? 'login' : 'logins'}`, 'aria-label': 'Search logins', autofocus: matches.length === 0 });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    const found = q ? logins.filter((l) => `${l.title} ${l.username} ${l.url}`.toLowerCase().includes(q)).slice(0, 30) : [];
    results.replaceChildren(
      ...(!q ? [] : found.length ? [h('ul', { class: 'group', 'aria-label': 'Search results' }, found.map((l) => loginRow(l, { ...ctx, canFill: l.matches })))] : [h('p', { class: 'empty' }, `Nothing matches “${search.value.trim()}”.`)]),
    );
  });

  const siteCard = site
    ? h(
        'div',
        { class: 'site' },
        mono(site),
        h('span', { class: 'site-text' }, h('span', { class: 'site-host' }, site), h('span', { class: 'site-sub' }, matches.length ? `${matches.length} saved ${matches.length === 1 ? 'login' : 'logins'}` : 'No saved logins')),
      )
    : h('div', { class: 'site' }, h('span', { class: 'mono', 'aria-hidden': 'true' }, icon('globe')), h('span', { class: 'site-text' }, h('span', { class: 'site-host' }, 'No website'), h('span', { class: 'site-sub' }, 'Open a site to fill its login')));

  return h(
    'div',
    {},
    h(
      'div',
      { class: 'body' },
      siteCard,
      matches.length ? h('ul', { class: 'group', 'aria-label': `Logins for ${site}` }, matches.map((l) => loginRow(l, { ...ctx, canFill: true }))) : null,
      h('label', { class: 'field' }, icon('search'), search),
      results,
    ),
    h(
      'footer',
      { class: 'foot' },
      h('span', {}, state.browser ? `Connected as ${state.browser}` : 'Connected'),
      h(
        'button',
        {
          type: 'button',
          class: 'text-btn',
          onClick: async () => {
            await ask('keys:disconnect').catch(() => {});
            void render();
          },
        },
        'Disconnect',
      ),
    ),
  );
}

function failure(message) {
  return hero('alert', 'Something went wrong', message, h('div', { class: 'hero-actions' }, h('button', { type: 'button', class: 'btn btn-outline btn-lg btn-block', onClick: () => void render() }, 'Try again')));
}

async function render(retried = false) {
  clearInterval(pollTimer);
  let state;
  try {
    state = await ask('keys:state');
  } catch (err) {
    state = { state: 'error', error: err.message };
  }
  const known = state.state === 'unlocked' || state.state === 'locked';
  statusPill.hidden = !known;
  statusPill.textContent = state.state === 'unlocked' ? 'Unlocked' : 'Locked';
  statusPill.toggleAttribute('data-on', state.state === 'unlocked');
  lockButton.hidden = state.state !== 'unlocked';
  let content;
  try {
    if (state.state === 'offline') content = offline(state);
    else if (state.state === 'unpaired') content = unpaired(state);
    else if (state.state === 'locked') content = locked(state);
    else if (state.state === 'unlocked') content = await unlocked(state);
    else throw new Error(state.error ?? 'Something went wrong');
  } catch (err) {
    // Keys locked (or the connection was removed) while this was loading: show that instead.
    if (!retried && (err.code === 'LOCKED' || err.code === 'NOT_PAIRED')) return render(true);
    content = failure(err.message);
  }
  view.replaceChildren(content);
  view.querySelector('[autofocus]')?.focus();
}

void render();
