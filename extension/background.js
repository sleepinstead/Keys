// Keys browser extension: the only part that talks to Keys.
//
// Keys runs on this computer and owns the one database. This worker asks it for logins when a
// page or the popup needs them and keeps nothing itself except the address of Keys and this
// browser's pairing token (which is useless without the unlocked app). Passwords are never stored.

const DEFAULT_SERVER = 'http://127.0.0.1:5174';
const CLEAR_ALARM = 'keys-clear-clipboard';

class KeysError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function settings() {
  const { server = DEFAULT_SERVER, token = null } = await chrome.storage.local.get(['server', 'token']);
  return { server: server.replace(/\/+$/, ''), token };
}

/** One request to Keys. Turns "not running", "not connected" and "locked" into clear codes. */
async function keys(path, { method = 'GET', body } = {}) {
  const { server, token } = await settings();
  let res;
  try {
    res = await fetch(`${server}/api/extension${path}`, {
      method,
      cache: 'no-store',
      headers: {
        'x-keys-extension': '1',
        ...(token ? { 'x-keys-extension-token': token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new KeysError('Keys isn’t running on this computer.', 'OFFLINE');
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not Keys */
  }
  if (!res.ok) {
    if (data?.code === 'NOT_PAIRED') await chrome.storage.local.remove('token');
    // Older versions of Keys answer, but don't know about the extension.
    // (A 403 with Keys' own code, like WRONG_SITE, is a real answer, not an old version.)
    if ((res.status === 403 && (!data?.code || data.code === 'FORBIDDEN')) || (res.status === 404 && !data?.code)) {
      throw new KeysError('This version of Keys doesn’t support the browser extension. Update Keys and restart it.', 'OUTDATED');
    }
    throw new KeysError(data?.error ?? `Keys answered ${res.status}`, data?.code ?? (res.status === 403 ? 'FORBIDDEN' : 'ERROR'));
  }
  if (!data) throw new KeysError('That address isn’t Keys.', 'OFFLINE');
  return data;
}

/** What the popup and pages need to know before showing anything. */
async function state() {
  const { token, server } = await settings();
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!token) {
    // Still reachable, and new enough? Tells "not running" apart from "not connected yet".
    try {
      await keys('/status');
    } catch (e) {
      if (e.code === 'OFFLINE') return { state: 'offline', server };
      if (e.code === 'OUTDATED') return { state: 'error', server, error: e.message };
    }
    const live = pairing && pairing.expiresAt > Date.now() ? pairing : null;
    const { pairingExpired = false } = await chrome.storage.session.get('pairingExpired');
    return { state: 'unpaired', server, pairing: live, expired: !live && (pairingExpired || Boolean(pairing)) };
  }
  try {
    const status = await keys('/status');
    return { state: status.unlocked ? 'unlocked' : 'locked', server, ...status };
  } catch (e) {
    if (e.code === 'OFFLINE') return { state: 'offline', server };
    if (e.code === 'NOT_PAIRED') return { state: 'unpaired', server, pairing: null };
    return { state: 'error', server, error: e.message };
  }
}

async function startPairing() {
  const brand = navigator.userAgentData?.brands?.find((b) => !/Not.A.Brand|Chromium/i.test(b.brand))?.brand ?? 'Chromium';
  const platform = navigator.userAgentData?.platform;
  await chrome.storage.session.remove('pairingExpired');
  const pairing = await keys('/pair', { method: 'POST', body: { name: platform ? `${brand} on ${platform}` : brand } });
  await chrome.storage.session.set({ pairing });
  return pairing;
}

/** Checks whether the person typed the code into Keys yet. */
async function pollPairing() {
  const { pairing } = await chrome.storage.session.get('pairing');
  if (!pairing) return { status: 'expired' };
  const res = await keys(`/pair/${encodeURIComponent(pairing.requestId)}`);
  if (res.status === 'approved') {
    await chrome.storage.session.remove('pairingExpired');
    await chrome.storage.local.set({ token: res.token });
    await chrome.storage.session.remove('pairing');
  } else if (res.status === 'expired') {
    await chrome.storage.session.remove('pairing');
    await chrome.storage.session.set({ pairingExpired: true });
  }
  return { status: res.status };
}

/** Opens Keys, reusing a tab that already shows it. */
async function openApp(hash = '') {
  let appUrl;
  try {
    appUrl = (await state()).appUrl;
  } catch {
    /* fall through */
  }
  if (!appUrl) {
    const { pairing } = await chrome.storage.session.get('pairing');
    appUrl = pairing?.appUrl ?? (await settings()).server;
  }
  const origin = new URL(appUrl).origin;
  const [existing] = await chrome.tabs.query({ url: `${origin}/*` });
  if (existing?.id !== undefined) {
    await chrome.tabs.update(existing.id, { active: true, ...(hash ? { url: `${origin}/${hash}` } : {}) });
    if (existing.windowId !== undefined) await chrome.windows.update(existing.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: `${origin}/${hash}` });
  }
}

/** Sends a login to a tab's page. The page address comes from the browser, never from the page. */
async function fillTab(tabId, id) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url) throw new KeysError('This page can’t be filled.', 'NO_PAGE');
  const creds = await keys('/fill', { method: 'POST', body: { id, url: tab.url } });
  const message = { type: 'keys:fill', ...creds };
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    // The page was open before the extension was installed: add the filler, then try again.
    await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  }
}

/** Copied passwords are wiped after Keys' own delay (at least 30 seconds, the browser's limit). */
async function scheduleClipboardClear(seconds) {
  if (!seconds) return;
  await chrome.alarms.create(CLEAR_ALARM, { when: Date.now() + Math.max(30, seconds) * 1000 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== CLEAR_ALARM) return;
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['CLIPBOARD'], justification: 'Clear a copied password' });
  }
  await chrome.runtime.sendMessage({ type: 'keys:clear-clipboard', target: 'offscreen' });
  await chrome.offscreen.closeDocument();
});

// What pages may ask for. Pages only ever get names and usernames for their own site; a
// password is sent to the page only after a real click on one of its own logins.
async function fromPage(msg, sender) {
  if (sender.frameId !== 0 || !sender.tab?.id || !sender.url) throw new KeysError('Not allowed', 'FORBIDDEN');
  switch (msg.type) {
    case 'keys:page-logins': {
      const s = await state();
      if (s.state !== 'unlocked') return { state: s.state };
      const { logins } = await keys(`/logins?url=${encodeURIComponent(sender.url)}`);
      return { state: 'unlocked', logins: logins.map(({ id, title, username, icon }) => ({ id, title, username, icon })) };
    }
    case 'keys:page-fill':
      return keys('/fill', { method: 'POST', body: { id: String(msg.id), url: sender.url } });
    case 'keys:open-app':
      await openApp();
      return { ok: true };
    case 'keys:open-popup':
      try {
        await chrome.action.openPopup();
      } catch {
        await openApp();
      }
      return { ok: true };
    default:
      throw new KeysError('Not allowed', 'FORBIDDEN');
  }
}

// What the popup may ask for.
async function fromPopup(msg) {
  switch (msg.type) {
    case 'keys:state':
      return state();
    case 'keys:pair':
      return startPairing();
    case 'keys:pair-poll':
      return pollPairing();
    case 'keys:pair-cancel':
      await chrome.storage.session.remove(['pairing', 'pairingExpired']);
      return { ok: true };
    case 'keys:unlock':
      return keys('/unlock', { method: 'POST', body: { secret: msg.secret } });
    case 'keys:lock':
      return keys('/lock', { method: 'POST' });
    case 'keys:logins':
      return keys(`/logins?all=1&url=${encodeURIComponent(msg.url ?? '')}`);
    case 'keys:fill-tab':
      return fillTab(msg.tabId, msg.id);
    case 'keys:secret':
      return keys('/secret', { method: 'POST', body: { id: msg.id } });
    case 'keys:copied':
      return scheduleClipboardClear(msg.seconds);
    case 'keys:open-app':
      await openApp(msg.hash ?? '');
      return { ok: true };
    case 'keys:set-server': {
      const url = new URL(msg.server);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') {
        throw new KeysError('Keys only runs on this computer: use http://127.0.0.1 or http://localhost', 'BAD_SERVER');
      }
      await chrome.storage.local.set({ server: url.origin });
      return { ok: true };
    }
    case 'keys:disconnect':
      try {
        await keys('/disconnect', { method: 'POST' });
      } finally {
        await chrome.storage.local.remove('token');
      }
      return { ok: true };
    default:
      throw new KeysError('Unknown request', 'ERROR');
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target === 'offscreen' || sender.id !== chrome.runtime.id) return false;
  // Content scripts report the page's address; only the extension's own pages report its origin.
  const fromExtensionPage = sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`) ?? false;
  (fromExtensionPage ? fromPopup(msg) : fromPage(msg, sender)).then(
    (result) => sendResponse({ ok: true, result }),
    (e) => sendResponse({ ok: false, error: e.message, code: e.code ?? 'ERROR' }),
  );
  return true;
});
