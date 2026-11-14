// Google Drive, read-only, one file: sign in (OAuth token in the URL fragment, which works in an
// iPhone Home Screen app where pop-ups don't), pick Keys.sqlite once with Google's picker
// (that grant is what the drive.file scope allows), then check it for changes and download it.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const API_KEY = import.meta.env.VITE_GOOGLE_API_KEY as string | undefined;
const APP_ID = import.meta.env.VITE_GOOGLE_APP_ID as string | undefined; // the Cloud project number
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const TOKEN_KEY = 'keys-drive-token';

export const driveConfigured = Boolean(CLIENT_ID && API_KEY && APP_ID);

interface Token {
  value: string;
  expiresAt: number;
}

export interface DriveFile {
  id: string;
  name: string;
  version: string;
  modifiedTime: string;
}

const here = () => location.origin + location.pathname;

/** Leaves for Google's sign-in page; `finishSignIn` picks the token up when it comes back. */
export function signIn(): void {
  const state = crypto.randomUUID();
  sessionStorage.setItem('keys-oauth-state', state);
  const q = new URLSearchParams({
    client_id: CLIENT_ID!,
    redirect_uri: here(),
    response_type: 'token',
    scope: SCOPE,
    state,
    include_granted_scopes: 'true',
  });
  location.assign(`https://accounts.google.com/o/oauth2/v2/auth?${q}`);
}

/** Reads the token from the URL after Google sends you back (and removes it from the URL). */
export function finishSignIn(): void {
  if (!location.hash.includes('access_token=') && !location.hash.includes('error=')) return;
  const p = new URLSearchParams(location.hash.slice(1));
  history.replaceState(null, '', here());
  const expected = sessionStorage.getItem('keys-oauth-state');
  sessionStorage.removeItem('keys-oauth-state');
  const value = p.get('access_token');
  if (!value || !expected || p.get('state') !== expected) return; // not a sign-in we started
  const token: Token = { value, expiresAt: Date.now() + (Number(p.get('expires_in')) || 3600) * 1000 - 60_000 };
  sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
}

function token(): string | null {
  try {
    const t = JSON.parse(sessionStorage.getItem(TOKEN_KEY) ?? 'null') as Token | null;
    return t && t.expiresAt > Date.now() ? t.value : null;
  } catch {
    return null;
  }
}

export const signedIn = () => token() !== null;

export class SignInNeeded extends Error {
  constructor() {
    super('Sign in to Google again to check for changes');
  }
}

async function api(path: string): Promise<Response> {
  const t = token();
  if (!t) throw new SignInNeeded();
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${path}`, { headers: { Authorization: `Bearer ${t}` } });
  if (res.status === 401) {
    sessionStorage.removeItem(TOKEN_KEY);
    throw new SignInNeeded();
  }
  if (res.status === 404) throw new Error('Keys can’t see that file anymore. Choose it again.');
  if (!res.ok) throw new Error(`Google Drive answered ${res.status}`);
  return res;
}

export async function fileInfo(id: string): Promise<DriveFile> {
  return (await (await api(`${encodeURIComponent(id)}?fields=id,name,version,modifiedTime`)).json()) as DriveFile;
}

export async function download(id: string): Promise<Uint8Array> {
  return new Uint8Array(await (await api(`${encodeURIComponent(id)}?alt=media`)).arrayBuffer());
}

// ------------------------------------------------------------------ picker

interface PickerResult {
  action: string;
  docs?: { id: string; name: string }[];
}
interface PickerBuilder {
  setAppId(id: string): PickerBuilder;
  setOAuthToken(t: string): PickerBuilder;
  setDeveloperKey(k: string): PickerBuilder;
  addView(v: unknown): PickerBuilder;
  setTitle(t: string): PickerBuilder;
  setCallback(cb: (r: PickerResult) => void): PickerBuilder;
  build(): { setVisible(v: boolean): void };
}
declare const gapi: { load(name: string, cb: () => void): void };
declare const google: {
  picker: {
    Action: { PICKED: string; CANCEL: string };
    DocsView: new () => { setIncludeFolders(v: boolean): unknown; setMode(m: string): unknown };
    DocsViewMode: { LIST: string };
    PickerBuilder: new () => PickerBuilder;
  };
};

let pickerReady: Promise<void> | null = null;
function loadPicker(): Promise<void> {
  pickerReady ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://apis.google.com/js/api.js';
    s.onload = () => gapi.load('picker', () => resolve());
    s.onerror = () => {
      pickerReady = null;
      reject(new Error('Couldn’t reach Google. Check your connection.'));
    };
    document.head.append(s);
  });
  return pickerReady;
}

/** Google's own file picker; resolves with the chosen file, or null if cancelled. */
export async function pickFile(): Promise<{ id: string; name: string } | null> {
  const t = token();
  if (!t) throw new SignInNeeded();
  await loadPicker();
  return new Promise((resolve) => {
    const view = new google.picker.DocsView();
    view.setIncludeFolders(true);
    view.setMode(google.picker.DocsViewMode.LIST);
    new google.picker.PickerBuilder()
      .setAppId(APP_ID!)
      .setOAuthToken(t)
      .setDeveloperKey(API_KEY!)
      .addView(view)
      .setTitle('Choose your Keys.sqlite')
      .setCallback((r) => {
        if (r.action === google.picker.Action.PICKED && r.docs?.[0]) resolve({ id: r.docs[0].id, name: r.docs[0].name });
        else if (r.action === google.picker.Action.CANCEL) resolve(null);
      })
      .build()
      .setVisible(true);
  });
}
