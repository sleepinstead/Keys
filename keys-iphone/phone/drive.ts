// Google Drive, read-only: sign in (OAuth token in the URL fragment, which works in an iPhone
// Home Screen app where pop-ups don't), find Keys.sqlite, then check it for changes and download it.
// No API key: the client ID is the only Google value in the page, and it's public by design.

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TOKEN_KEY = 'keys-drive-token';

export const driveConfigured = Boolean(CLIENT_ID);

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
  const res = await fetch(`https://www.googleapis.com/drive/v3/files${path.startsWith('?') ? '' : '/'}${path}`, { headers: { Authorization: `Bearer ${t}` } });
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

// ------------------------------------------------------------------ finding the vault

export interface Found {
  id: string;
  name: string;
  modifiedTime: string;
  folder: string;
}

/** Every file in your Drive whose name starts with "Keys" and ends in .sqlite (sync copies included), newest first. */
export async function findVaults(): Promise<Found[]> {
  // Only the person's own files: something shared with them by someone else is never offered.
  const q = "name contains 'Keys' and trashed = false and 'me' in owners and mimeType != 'application/vnd.google-apps.folder'";
  const res = await api(`?q=${encodeURIComponent(q)}&fields=files(id,name,modifiedTime,parents)&orderBy=modifiedTime desc&pageSize=50&spaces=drive`);
  const { files = [] } = (await res.json()) as { files?: (Omit<Found, 'folder'> & { parents?: string[] })[] };
  const vaults = files.filter((f) => /^keys.*\.sqlite$/i.test(f.name));
  // Folder names, so two files called Keys.sqlite can be told apart.
  const names = new Map<string, string>();
  for (const pid of new Set(vaults.flatMap((f) => f.parents ?? []))) {
    try {
      names.set(pid, ((await (await api(`${encodeURIComponent(pid)}?fields=name`)).json()) as { name: string }).name);
    } catch {
      /* shared folder we can't name: leave it blank */
    }
  }
  return vaults.map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, folder: names.get(f.parents?.[0] ?? '') ?? '' }));
}
