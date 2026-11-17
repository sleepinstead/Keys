// The last downloaded copy of the (still encrypted) database, so the app opens offline.
// IndexedDB because a vault with icons can outgrow localStorage's 5 MB.

export interface Cached {
  source: 'drive' | 'file';
  fileId: string | null;
  name: string;
  version: string | null;
  bytes: Uint8Array;
  fetchedAt: number;
}

function db(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('keys-phone', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('copy');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const conn = await db();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(conn.transaction('copy', mode).objectStore('copy'));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    conn.close();
  }
}

export async function load(): Promise<Cached | null> {
  try {
    return ((await run('readonly', (s) => s.get('vault'))) as Cached | undefined) ?? null;
  } catch {
    return null; // private browsing, or storage cleared
  }
}

export async function save(c: Cached): Promise<void> {
  try {
    await run('readwrite', (s) => s.put(c, 'vault'));
  } catch {
    /* works this time, just not offline */
  }
}

export const forget = () => run('readwrite', (s) => s.delete('vault')).catch(() => undefined);
