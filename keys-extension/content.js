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
  let shownAt = 0; // clicks right after a menu or prompt appears are ignored (a page could time a decoy over it)
  const typed = new WeakMap(); // field → the value the person last typed into it themselves
  const keysFilled = new WeakSet(); // fields Keys filled: nothing new to save there
  const fresh = () => performance.now() - shownAt < 450;

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
    // The site may have re-rendered its form while Keys was answering: use the field in focus now.
    if (anchor && !anchor.isConnected) {
      const now = deepActive();
      anchor = now instanceof HTMLInputElement && loginKind(now) ? now : null;
    }
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
      if (pass) keysFilled.add(pass);
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
    if (!alive()) return close(); // an older copy after an extension update: tidy up
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
      if (e.isTrusted && !fresh()) run();
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
    shownAt = performance.now();
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

  // ------------------------------------------------------------------ offer to save

  // A sent sign-in or sign-up form is offered to Keys. Only the person's click on "Save" stores it;
  // the page itself can't press it (closed shadow root, trusted clicks only).
  let lastCaptured = '';
  let saveHost = null;

  /**
   * The password being set: on a change-password or sign-up form that's the new one (marked
   * new-password, or the value typed twice for confirmation), not the current one above it.
   */
  function submittedPassword(scope) {
    const filled = inputsIn(scope).filter((i) => typeOf(i) === 'password' && i.value);
    if (!filled.length) return null;
    const marked = filled.find((i) => autoOf(i).includes('new-password'));
    if (marked) return marked;
    const twice = filled.find((i, n) => filled.some((o, m) => m !== n && o.value === i.value));
    return twice ?? filled[filled.length - 1];
  }

  let lastUsername = ''; // from an earlier step of a multi-step sign-in, typed on this page
  let usernameTimer;
  // Kept by the extension for this tab too, since the password step is often a new page.
  const rememberUsername = () => {
    clearTimeout(usernameTimer);
    usernameTimer = setTimeout(() => void ask({ type: 'keys:page-username', username: lastUsername }), 600);
  };

  function capture(from) {
    const scope = from?.form ?? (from instanceof Element ? scopeOf(from) : document);
    const pass = submittedPassword(scope) ?? submittedPassword(document);
    // Only what the person typed: a page setting values from script, or a login Keys filled, isn't offered.
    if (!pass || typed.get(pass) !== pass.value || keysFilled.has(pass)) return;
    const user = usernameBefore(pass);
    const username = (user && isUsernameField(user, false) ? user.value.trim() : '') || lastUsername;
    const fingerprint = `${username}\n${pass.value}`;
    if (fingerprint === lastCaptured) return;
    lastCaptured = fingerprint;
    const startUrl = location.href;
    void ask({ type: 'keys:page-captured', username, password: pass.value }).then((res) => {
      if (!res?.ok || !res.result.offer) return;
      // Ask only once the sign-in has gone through: the page moved on, or the form went away.
      // If the form is still there a few seconds later the password was probably wrong, so stay quiet
      // (the next page in this tab still gets the question if it does go through).
      const started = Date.now();
      const wait = () => {
        if (!alive() || saveHost) return;
        if (location.href !== startUrl || !pass.isConnected || !visible(pass)) return showSave(res.result.offer);
        if (Date.now() - started < 8000) setTimeout(wait, 400);
      };
      setTimeout(wait, 400);
    });
  }

  const EASE = 'cubic-bezier(.2,0,0,1)';
  const SAVE_STYLE = `
    @font-face { font-family: 'Keys Inter'; font-weight: 100 900; font-display: swap;
      src: url('${asset('fonts/inter.woff2')}') format('woff2-variations'); }
    :host { all: initial !important; position: fixed !important; inset: 16px 16px auto auto !important;
      z-index: 2147483647 !important; margin: 0 !important; padding: 0 !important; border: 0 !important;
      background: none !important; width: auto !important; height: auto !important; overflow: visible !important; }
    .card {
      --bg: #fff; --fg: #0a0a0a; --muted: #71717a; --line: #e7e7e9; --hover: #f4f4f5;
      --btn-bg: #0a0a0a; --btn-fg: #fff; --btn-hover: #27272a; --ring: #52525b; --good: #16a34a; --bad: #dc2626;
      box-sizing: border-box; width: 344px; max-width: calc(100vw - 32px); padding: 16px; overflow: hidden;
      font: 13.5px/1.45 'Keys Inter', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif;
      -webkit-font-smoothing: antialiased; color: var(--fg); background: var(--bg); text-align: left;
      border: 1px solid var(--line); border-radius: 16px;
      box-shadow: 0 24px 48px -12px rgba(10,10,10,.2), 0 8px 16px -8px rgba(10,10,10,.08);
      transform-origin: top right;
      transition: opacity .2s ${EASE}, transform .2s ${EASE}, height .24s ${EASE}; }
    .card[data-state='entering'], .card[data-state='leaving'] { opacity: 0; transform: translateY(-8px) scale(.97); }
    .card[data-state='leaving'] { transition-duration: .16s; }
    .view { transition: opacity .16s ${EASE}, transform .16s ${EASE}; }
    .view[data-hidden] { opacity: 0; transform: translateY(4px); }
    .head { display: flex; align-items: flex-start; gap: 11px; }
    .head img { width: 30px; height: 30px; flex: none; }
    .text { min-width: 0; flex: 1; }
    .title { font-size: 14.5px; font-weight: 600; letter-spacing: -.01em; }
    .sub { margin-top: 1px; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .x { all: unset; flex: none; display: grid; place-items: center; width: 26px; height: 26px; margin: -3px -4px 0 0;
      border-radius: 8px; color: var(--muted); cursor: pointer; transition: background .15s, color .15s; }
    .x:hover, .x:focus-visible { background: var(--hover); color: var(--fg); }
    .x svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
    .row { display: flex; align-items: center; gap: 6px; margin-top: 14px; }
    .card .btn { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
      height: 34px; padding: 0 14px; border-radius: 10px; font-size: 13px; font-weight: 550; white-space: nowrap; cursor: pointer;
      transition: background .15s, color .15s, border-color .15s, transform .1s, opacity .15s; }
    .card .btn:active { transform: scale(.97); }
    
    .card .btn[disabled] { cursor: default; opacity: .55; transform: none; }
    .card .btn.ghost { padding: 0 10px; color: var(--muted); }
    .card .btn.ghost:hover:not([disabled]) { background: var(--hover); color: var(--fg); }
    .card .btn.outline { margin-left: auto; border: 1px solid var(--line); color: var(--fg); }
    .card .btn.outline:hover:not([disabled]) { background: var(--hover); }
    .card .btn.primary { background: var(--btn-bg); color: var(--btn-fg); min-width: 72px; }
    .card .btn.primary:hover:not([disabled]) { background: var(--btn-hover); }
    .card .btn.primary[aria-busy='true'] { opacity: 1; }
    .spin { width: 13px; height: 13px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%;
      animation: spin .7s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .error { margin-top: 10px; color: var(--bad); font-size: 12.5px; }
    .error:empty { display: none; }
    .done { display: flex; align-items: center; gap: 10px; font-weight: 550; }
    .done .tick { display: grid; place-items: center; width: 30px; height: 30px; flex: none; border-radius: 50%;
      background: color-mix(in srgb, var(--good) 16%, transparent); }
    .done svg { width: 16px; height: 16px; fill: none; stroke: var(--good); stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round;
      stroke-dasharray: 24; stroke-dashoffset: 24; animation: draw .35s .08s ${EASE} forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }
    .done small { display: block; color: var(--muted); font-size: 12.5px; font-weight: 400; }
    @media (prefers-color-scheme: dark) {
      .card { --bg: #0a0a0a; --fg: #fafafa; --muted: #a1a1aa; --line: #262626; --hover: #1c1c1c;
        --btn-bg: #fafafa; --btn-fg: #0a0a0a; --btn-hover: #e4e4e7; --ring: #a1a1aa; --good: #22c55e; --bad: #f87171;
        box-shadow: 0 24px 56px -12px rgba(0,0,0,.75), 0 0 0 1px rgba(255,255,255,.04); }
    }
    @media (prefers-reduced-motion: reduce) {
      .card, .view, .card .btn { transition: none; }
      .card[data-state] { opacity: 1; transform: none; }
      .done svg { animation: none; stroke-dashoffset: 0; }
    }`;

  let saveTimer;

  /** Fades the prompt out, then removes it. */
  function closeSave(now = false) {
    clearTimeout(saveTimer);
    const leaving = saveHost;
    saveHost = null;
    if (!leaving) return;
    const card = leaving.__card;
    if (now || !card || matchMedia('(prefers-reduced-motion: reduce)').matches) return leaving.remove();
    card.dataset.state = 'leaving';
    setTimeout(() => leaving.remove(), 170);
  }

  /** Swaps the card's contents with a short crossfade, animating its height to fit. */
  function swapView(card, next) {
    const from = card.getBoundingClientRect().height;
    const old = card.querySelector('.view');
    if (old) old.dataset.hidden = '';
    setTimeout(() => {
      next.dataset.hidden = '';
      card.replaceChildren(next);
      card.style.height = `${from}px`;
      const to = next.getBoundingClientRect().height + 32 + 2; // padding and border
      requestAnimationFrame(() => {
        card.style.height = `${to}px`;
        delete next.dataset.hidden;
      });
    }, 140);
  }

  function showSave(offer) {
    closeSave(true);
    shownAt = performance.now();
    const hostEl = document.createElement('keys-save');
    saveHost = hostEl;
    const shadow = hostEl.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = SAVE_STYLE;
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.state = 'entering';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Save to Keys');
    card.setAttribute('aria-live', 'polite');
    hostEl.__card = card;

    const view = document.createElement('div');
    view.className = 'view';
    const head = document.createElement('div');
    head.className = 'head';
    const logo = document.createElement('img');
    logo.src = asset('icons/mark.png');
    logo.alt = '';
    const text = document.createElement('div');
    text.className = 'text';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = offer.status === 'update' ? 'Update the password in Keys?' : 'Save this login to Keys?';
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = offer.username ? `${offer.username} · ${offer.host}` : offer.host;
    text.append(title, sub);
    const x = document.createElement('button');
    x.className = 'x';
    x.setAttribute('aria-label', 'Close');
    x.append(svg(['M18 6 6 18', 'm6 6 12 12']));
    head.append(logo, text, x);

    const row = document.createElement('div');
    row.className = 'row';
    const btn = (label, kind) => {
      const b = document.createElement('button');
      b.className = `btn ${kind}`;
      b.textContent = label;
      row.append(b);
      return b;
    };
    const never = btn('Never for this site', 'ghost');
    const later = btn('Not now', 'outline');
    const saveLabel = offer.status === 'update' ? 'Update' : 'Save';
    const save = btn(saveLabel, 'primary');
    const error = document.createElement('div');
    error.className = 'error';
    error.setAttribute('role', 'alert');
    view.append(head, row, error);

    const buttons = [x, never, later, save];
    const busy = (on) => {
      for (const b of buttons) b.disabled = on;
      save.setAttribute('aria-busy', String(on));
      if (on) {
        const sp = document.createElement('span');
        sp.className = 'spin';
        save.replaceChildren(sp, 'Saving');
      } else save.replaceChildren(saveLabel);
    };
    const trusted = (b, run) => b.addEventListener('click', (e) => e.isTrusted && !b.disabled && !fresh() && run());
    const dismiss = (neverAgain) => {
      closeSave();
      void ask({ type: 'keys:page-dismiss', never: neverAgain });
    };
    trusted(x, () => dismiss(false));
    trusted(later, () => dismiss(false));
    trusted(never, () => dismiss(true));
    trusted(save, async () => {
      error.textContent = '';
      busy(true);
      const res = await ask({ type: 'keys:page-save' });
      if (saveHost !== hostEl) return;
      if (!res?.ok) {
        busy(false);
        error.textContent =
          res?.code === 'LOCKED' ? 'Keys is locked. Unlock it, then press Save again.' : res?.code === 'OFFLINE' ? 'Keys isn’t running. Start it, then press Save again.' : (res?.error ?? 'Couldn’t save. Try again.');
        return;
      }
      cache = null; // the menu should list the new login next time
      clearTimeout(saveTimer);
      const done = document.createElement('div');
      done.className = 'view done';
      const tick = document.createElement('span');
      tick.className = 'tick';
      tick.append(svg(['M20 6 9 17l-5-5']));
      const words = document.createElement('span');
      words.append(res.result.status === 'updated' ? 'Password updated in Keys' : 'Saved to Keys');
      const small = document.createElement('small');
      small.textContent = offer.username ? `${offer.username} · ${offer.host}` : offer.host;
      words.append(small);
      done.append(tick, words);
      swapView(card, done);
      saveTimer = setTimeout(() => saveHost === hostEl && closeSave(), 2200);
    });
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss(false);
      }
    });

    card.append(view);
    shadow.append(style, card);
    // Inside a modal sign-in dialog the prompt has to live in it too, and the top layer keeps it above the page.
    (document.querySelector('dialog[open]') ?? document.documentElement).append(hostEl);
    if (hostEl.showPopover) {
      hostEl.setAttribute('popover', 'manual');
      try {
        hostEl.showPopover();
      } catch {
        /* z-index alone */
      }
    }
    requestAnimationFrame(() => requestAnimationFrame(() => delete card.dataset.state));
    // The question lapses with the login Keys is holding for it.
    const left = (offer.expiresAt ?? Date.now() + 120_000) - Date.now();
    saveTimer = setTimeout(() => saveHost === hostEl && closeSave(), Math.max(0, left));
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

  // What the person typed themselves; a username typed on an earlier step of a sign-in is remembered.
  document.addEventListener(
    'input',
    (e) => {
      const el = e.composedPath()[0];
      if (!e.isTrusted || !(el instanceof HTMLInputElement)) return;
      typed.set(el, el.value);
      keysFilled.delete(el);
      if (isUsernameField(el, false) && el.value.trim()) {
        lastUsername = el.value.trim();
        rememberUsername();
      }
    },
    true,
  );

  // Sending a login form: a real submit, Enter in a field, or a click on its button
  // (many sites sign in with script instead of submitting the form).
  // Only the person's own submit counts: a page dispatching one from script can't make Keys check values.
  document.addEventListener('submit', (e) => e.isTrusted && alive() && capture(e.target), true);
  document.addEventListener(
    'keydown',
    (e) => {
      const el = e.composedPath()[0];
      if (e.isTrusted && alive() && e.key === 'Enter' && el instanceof HTMLInputElement && loginKind(el) !== null) capture(el);
    },
    true,
  );
  document.addEventListener(
    'click',
    (e) => {
      if (!alive() || !e.isTrusted) return;
      const b = e.composedPath()[0]?.closest?.('button, input[type="submit"], [role="button"]');
      if (!b || b.closest('keys-autofill, keys-save')) return;
      const label = `${b.textContent} ${b.getAttribute('value') ?? ''} ${b.getAttribute('aria-label') ?? ''}`.toLowerCase();
      if (b.type === 'submit' || /sign ?in|log ?in|continue|next|sign ?up|register|create|submit/.test(label)) capture(b);
    },
    true,
  );
  // After a sign-in the page usually changes: the new page shows the question still waiting for this tab.
  void ask({ type: 'keys:page-pending' }).then((res) => res?.ok && res.result.offer && showSave(res.result.offer));

  // A field that was focused before this script loaded (autofocus) still gets the menu.
  const initial = deepActive();
  if (initial instanceof HTMLInputElement) maybeOffer(initial);

  // The popup's "Fill" button.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!alive() || msg?.type !== 'keys:fill') return false;
    // The tab may have moved to another site while Keys was answering: never fill there.
    if (msg.origin !== location.origin) return sendResponse({ filled: false }), false;
    const active = deepActive();
    sendResponse(fill(active instanceof HTMLInputElement && loginKind(active) ? active : null, msg));
    return false;
  });
})();
