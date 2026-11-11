// Keys autofill on web pages.
//
// When you focus a login field, this asks Keys (through the extension) for logins saved for this
// site, by name and username only, and offers them under the field. A password reaches the page
// only after a real click (or Enter) on one of them. Top frame only, and never on Keys itself.

(() => {
  if (window.top !== window) return;
  if (document.querySelector('meta[name="application-name"][content="Keys"]')) return;

  // After the extension is reloaded or updated, the copy already in a page is cut off from it.
  // Each copy marks itself; an older one stops reacting the moment a newer one is added.
  const me = {};
  window.__keysAutofill = me;
  const alive = () => {
    try {
      return window.__keysAutofill === me && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  };

  const USERNAME_HINT = /user|e-?mail|login|account|identifier|phone/i;
  const TEXTLIKE = ['text', 'email', 'tel', ''];
  let field = null; // the input the menu belongs to
  let host = null;
  let root = null;
  let menuEl = null;
  let follow = null; // keeps the menu beside its field while open
  let filling = false; // our own focus moves while filling mustn't reopen the menu
  let cache = null; // { at, result }: only an unlocked answer is reused, briefly

  // ------------------------------------------------------------------ fields

  const visible = (el) => {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 1 && r.height > 1 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };
  const usable = (i) => i instanceof HTMLInputElement && !i.disabled && !i.readOnly && visible(i);
  const typeOf = (i) => (i.getAttribute('type') || 'text').toLowerCase();
  const autoOf = (i) => (i.getAttribute('autocomplete') || '').toLowerCase();

  /** Where to look for a field's partners: its form, or the document (or shadow root) it lives in. */
  const scopeOf = (input) => input.form ?? input.getRootNode();
  const inputsIn = (scope) => [...scope.querySelectorAll('input')].filter(usable);

  /** A password box someone signs in with, not one they're choosing (sign-up, change password). */
  const isCurrentPassword = (i) => i instanceof HTMLInputElement && typeOf(i) === 'password' && !autoOf(i).includes('new-password');
  const passwordsIn = (scope) => inputsIn(scope).filter(isCurrentPassword);

  /** Looks like a username or email box. `strict` also needs a password box beside it, or a clear label. */
  function isUsernameField(i, strict = true) {
    if (!(i instanceof HTMLInputElement) || !TEXTLIKE.includes(typeOf(i))) return false;
    const auto = autoOf(i);
    if (auto.includes('username') || auto === 'email' || auto.includes('webauthn')) return true;
    if (auto.includes('new-password') || auto === 'off' && !USERNAME_HINT.test(i.name + i.id)) return false;
    const hint = `${i.name} ${i.id} ${i.placeholder} ${i.getAttribute('aria-label') ?? ''}`;
    if (!USERNAME_HINT.test(hint) && typeOf(i) !== 'email') return false;
    return !strict || passwordsIn(scopeOf(i)).length > 0;
  }

  /** Login fields get the menu. Loose ones (an email box on a page with no password yet) only when Keys has a login for the site. */
  function loginKind(el) {
    if (!(el instanceof HTMLInputElement) || el.disabled || el.readOnly) return null;
    if (isCurrentPassword(el)) return 'strong';
    if (isUsernameField(el, true)) return 'strong';
    if (isUsernameField(el, false)) return 'loose';
    return null;
  }

  /** The focused element, looking inside shadow roots. */
  function deepActive() {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    return el;
  }

  /** The username box that goes with a password box: the closest likely one before it. */
  function usernameBefore(password) {
    const inputs = inputsIn(scopeOf(password));
    const before = inputs.slice(0, inputs.indexOf(password)).reverse();
    return before.find((i) => isUsernameField(i, false)) ?? before.find((i) => TEXTLIKE.includes(typeOf(i))) ?? null;
  }

  /** The password box that goes with a username box: the first one after it, in the same form. */
  function passwordAfter(user) {
    const inputs = inputsIn(scopeOf(user));
    return inputs.slice(inputs.indexOf(user) + 1).find(isCurrentPassword) ?? null;
  }

  /** Sets a value the way typing would, so frameworks like React notice it. */
  function setValue(input, value) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    input.focus({ preventScroll: true });
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Fills the form around `anchor` (or the page's login form, for the popup's Fill button). */
  function fill(anchor, { username, password }) {
    let user = null;
    let pass = null;
    if (anchor && isCurrentPassword(anchor)) {
      pass = anchor;
      user = usernameBefore(anchor);
    } else if (anchor) {
      user = anchor;
      pass = passwordAfter(anchor);
    } else {
      pass = passwordsIn(document)[0] ?? null;
      user = pass ? usernameBefore(pass) : (inputsIn(document).find((i) => isUsernameField(i, false)) ?? null);
    }
    filling = true;
    try {
      if (user && username) setValue(user, username);
      if (pass && password) setValue(pass, password);
      (pass ?? user)?.focus({ preventScroll: true });
    } finally {
      // Focus events from the moves above arrive synchronously; let them pass before listening again.
      setTimeout(() => (filling = false), 0);
    }
    close();
    return { filled: Boolean(user || pass) };
  }

  const ask = (msg) =>
    new Promise((resolve) => {
      if (!alive()) return resolve({ ok: false });
      try {
        chrome.runtime.sendMessage(msg, (res) => resolve(chrome.runtime.lastError ? { ok: false } : (res ?? { ok: false })));
      } catch {
        resolve({ ok: false });
      }
    });

  // ------------------------------------------------------------------ the menu

  const asset = (path) => chrome.runtime.getURL(path);
  const STYLE = `
    @font-face { font-family: 'Keys Inter'; font-weight: 100 900; font-display: swap;
      src: url('${asset('fonts/inter.woff2')}') format('woff2-variations'); }
    :host { all: initial !important; position: fixed !important; inset: 0 auto auto 0 !important;
      width: 0 !important; height: 0 !important; overflow: visible !important; margin: 0 !important;
      padding: 0 !important; border: 0 !important; background: none !important; z-index: 2147483647 !important; }
    .menu { position: fixed; z-index: 2147483647; box-sizing: border-box; width: 300px; padding: 6px;
      font: 13.5px/1.4 'Keys Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      -webkit-font-smoothing: antialiased; color: #0a0a0a; background: #fff; text-align: left;
      border: 1px solid #e7e7e9; border-radius: 16px;
      box-shadow: 0 24px 48px -12px rgba(10,10,10,.18), 0 8px 16px -8px rgba(10,10,10,.08);
      animation: in .16s cubic-bezier(.2,0,0,1); transform-origin: top left; user-select: none; }
    .menu[data-above] { transform-origin: bottom left; }
    @keyframes in { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
    .head { display: flex; align-items: center; gap: 7px; padding: 6px 8px 8px; color: #71717a;
      font-size: 12px; font-weight: 600; }
    .head img { width: 18px; height: 18px; }
    .list { display: grid; gap: 2px; max-height: 248px; overflow-y: auto; overscroll-behavior: contain; }
    button { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 10px; width: 100%;
      min-height: 46px; padding: 6px 8px; border-radius: 10px; cursor: pointer; }
    button:hover, button:focus-visible { background: #f4f4f5; }
    button:focus-visible { box-shadow: 0 0 0 3px rgba(10,10,10,.1); }
    .tile { flex: none; display: grid; place-items: center; width: 32px; height: 32px; overflow: hidden;
      border: 1px solid #e7e7e9; border-radius: 9px; background: #fafafa; color: #3f3f46;
      font-size: 13px; font-weight: 600; }
    .tile img { width: 100%; height: 100%; object-fit: cover; }
    .text { display: grid; min-width: 0; }
    .title, .sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .title { font-weight: 550; }
    .sub { color: #71717a; font-size: 12.5px; }
    .foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid #e7e7e9; }
    .foot button { min-height: 34px; color: #71717a; font-size: 12.5px; font-weight: 500; }
    .foot svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2;
      stroke-linecap: round; stroke-linejoin: round; margin: 0 9px; }
    @media (prefers-color-scheme: dark) {
      .menu { color: #fafafa; background: #0a0a0a; border-color: #232323;
        box-shadow: 0 24px 56px -12px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.04); }
      button:hover, button:focus-visible { background: #1c1c1c; }
      button:focus-visible { box-shadow: 0 0 0 3px rgba(255,255,255,.14); }
      .tile { background: #111; border-color: #232323; color: #d4d4d8; }
      .head, .sub, .foot button { color: #a1a1aa; }
      .foot { border-color: #232323; }
    }
    @media (prefers-reduced-motion: reduce) { .menu { animation: none; } }`;

  function close() {
    clearInterval(follow);
    follow = null;
    host?.remove();
    host = root = menuEl = null;
  }

  /** Keeps the menu beside the field; hides it if the field is gone or scrolled out of view. */
  function place() {
    if (!menuEl || !field) return;
    if (!field.isConnected || !visible(field)) return close();
    const r = field.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight) return close();
    const height = menuEl.offsetHeight;
    const above = window.innerHeight - r.bottom < height + 12 && r.top > height + 12;
    menuEl.toggleAttribute('data-above', above);
    menuEl.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - menuEl.offsetWidth - 8))}px`;
    menuEl.style.top = `${above ? r.top - height - 6 : r.bottom + 6}px`;
  }

  function svg(paths) {
    const ns = 'http://www.w3.org/2000/svg';
    const el = document.createElementNS(ns, 'svg');
    el.setAttribute('viewBox', '0 0 24 24');
    el.setAttribute('aria-hidden', 'true');
    for (const d of paths) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      el.append(p);
    }
    return el;
  }

  function option(row) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    const tile = document.createElement('span');
    tile.className = 'tile';
    if (/^data:image\/(png|jpeg|webp);base64,/.test(row.icon ?? '')) {
      const img = document.createElement('img');
      img.src = row.icon;
      img.alt = '';
      tile.append(img);
    } else tile.textContent = (row.title.match(/[\p{L}\p{N}]/u)?.[0] ?? '?').toUpperCase();
    const text = document.createElement('span');
    text.className = 'text';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = row.title;
    text.append(title);
    if (row.sub) {
      const sub = document.createElement('span');
      sub.className = 'sub';
      sub.textContent = row.sub;
      text.append(sub);
    }
    b.append(tile, text);
    return b;
  }

  /** Only the person's own click or key counts. Keys the menu handles don't reach the page. */
  function wire(b, run) {
    b.addEventListener('click', (e) => {
      if (e.isTrusted) run();
    });
    b.addEventListener('keydown', (e) => {
      const all = [...root.querySelectorAll('button')];
      const i = all.indexOf(b);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        all[(i + (e.key === 'ArrowDown' ? 1 : -1) + all.length) % all.length]?.focus();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        const back = field;
        close();
        back?.focus();
      } else if (e.key === 'Tab') {
        // Let Tab carry on from the field, as if the menu weren't there.
        const back = field;
        close();
        back?.focus();
      }
    });
  }

  function show(anchor, rows) {
    close();
    field = anchor;
    host = document.createElement('keys-autofill');
    root = host.attachShadow({ mode: 'closed' }); // page scripts can't read the names in it
    const style = document.createElement('style');
    style.textContent = STYLE;
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    // Clicking anywhere on the menu keeps focus in the field (and the menu open).
    menuEl.addEventListener('mousedown', (e) => e.preventDefault());
    const head = document.createElement('div');
    head.className = 'head';
    const logo = document.createElement('img');
    logo.src = asset('icons/mark.png');
    logo.alt = '';
    head.append(logo, 'Keys');
    const list = document.createElement('div');
    list.className = 'list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Logins from Keys');
    for (const row of rows) {
      const b = option(row);
      wire(b, row.run);
      list.append(b);
    }
    const foot = document.createElement('div');
    foot.className = 'foot';
    const manage = document.createElement('button');
    manage.type = 'button';
    manage.append(svg(['M15 3h6v6', 'M10 14 21 3', 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6']), 'Open Keys');
    wire(manage, () => (close(), ask({ type: 'keys:open-app' })));
    foot.append(manage);
    menuEl.append(head, list, foot);
    root.append(style, menuEl);
    // Inside a sign-in dialog the menu has to live in the dialog too, or the dialog makes it unclickable.
    (anchor.closest('dialog[open]') ?? document.documentElement).append(host);
    // The top layer puts it above modal dialogs and popovers, whatever their z-index.
    if (host.showPopover) {
      host.setAttribute('popover', 'manual');
      try {
        host.showPopover();
      } catch {
        /* not supported here: z-index alone */
      }
    }
    place();
    follow = setInterval(place, 250); // pages re-render, animate and move fields around
  }

  async function offer(anchor, kind) {
    if (!cache || Date.now() - cache.at > 10_000) {
      const result = await ask({ type: 'keys:page-logins' });
      // Only reuse an unlocked answer: "locked" must clear the moment Keys is unlocked.
      cache = result?.ok && result.result.state === 'unlocked' ? { at: Date.now(), result } : null;
      if (!cache) {
        if (!alive() || field !== anchor || deepActive() !== anchor) return;
        return present(anchor, kind, result);
      }
    }
    if (field !== anchor || deepActive() !== anchor) return;
    present(anchor, kind, cache.result);
  }

  function present(anchor, kind, res) {
    if (!res?.ok) return;
    const { state, logins = [] } = res.result;
    if (state === 'locked' && kind === 'strong') {
      show(anchor, [
        {
          title: 'Keys is locked',
          sub: 'Unlock to fill your login',
          run: () => {
            close();
            void ask({ type: 'keys:open-popup' });
          },
        },
      ]);
    } else if (state === 'unlocked' && logins.length) {
      show(
        anchor,
        logins.map((l) => ({
          title: l.title,
          sub: l.username || 'No username',
          icon: l.icon,
          run: async () => {
            const res = await ask({ type: 'keys:page-fill', id: l.id });
            if (res?.ok) fill(anchor, res.result);
            else {
              // Locked (or the login changed) since the menu opened: show the current state.
              cache = null;
              if (deepActive() === anchor) void offer(anchor, kind);
            }
          },
        })),
      );
    }
    // Not connected, Keys not running, or nothing saved here: stay quiet rather than nag.
  }

  function maybeOffer(el) {
    if (!alive() || filling) return;
    const kind = loginKind(el);
    if (!kind) return;
    field = el;
    void offer(el, kind);
  }

  // ------------------------------------------------------------------ events

  document.addEventListener(
    'focusin',
    (e) => {
      const el = e.composedPath()[0]; // the real input, even inside a web component
      if (el instanceof HTMLInputElement) maybeOffer(el);
    },
    true,
  );
  document.addEventListener(
    'focusout',
    (e) => {
      if (!alive() || !host) return;
      // Focus moving from the field into the menu (arrow keys) keeps it open; anything else closes it.
      setTimeout(() => {
        const active = deepActive();
        if (host && active !== field && document.activeElement !== host) close();
      }, 0);
    },
    true,
  );
  // Clicking an already-focused field (after Escape, say) brings the menu back.
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!alive()) return;
      const el = e.composedPath()[0];
      if (host && !e.composedPath().includes(host) && el !== field) close();
      if (!host && e.isTrusted && el instanceof HTMLInputElement && el === deepActive()) maybeOffer(el);
    },
    true,
  );
  document.addEventListener(
    'keydown',
    (e) => {
      if (!alive() || e.composedPath()[0] !== field || !(field instanceof HTMLInputElement)) return;
      if (e.key === 'Escape' && host) {
        // Dismiss the menu only; the page's own Escape (closing its sign-in dialog, say) mustn't fire.
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === 'ArrowDown' && !e.altKey && !e.metaKey && !e.ctrlKey) {
        if (host) {
          e.preventDefault();
          e.stopPropagation();
          root.querySelector('.list button, button')?.focus();
        } else if (deepActive() === field) maybeOffer(field);
      }
    },
    true,
  );
  window.addEventListener('scroll', () => alive() && host && place(), true);
  window.addEventListener('resize', () => alive() && host && place());

  // A field that was focused before this script loaded (autofocus) still gets the menu.
  const initial = deepActive();
  if (initial instanceof HTMLInputElement) maybeOffer(initial);

  // The popup's "Fill" button.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!alive() || msg?.type !== 'keys:fill') return false;
    const active = deepActive();
    sendResponse(fill(active instanceof HTMLInputElement && loginKind(active) ? active : null, msg));
    return false;
  });
})();
