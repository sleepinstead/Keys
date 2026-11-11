import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { KeyWipedError } from './crypto.ts';
import { createApi } from './routes.ts';
import type { RangeFetcher } from './audit.ts';
import type { IconFetcher } from './favicon.ts';
import { apiGuard, loopbackOnly, securityHeaders } from './security.ts';
import { createExtensionApi } from './extension.ts';
import { SessionManager } from './session.ts';
import { QuickUnlock } from './pin.ts';
import { HttpError } from './validate.ts';
import { Vault } from './vault.ts';
import { DB_FILE } from './db.ts';
import { Storage } from './storage.ts';

export interface AppOptions {
  /** Only tests override this (with ':memory:'). */
  dbFile?: string;
  allowedOrigins: string[];
  staticDir?: string;
  fetchRange?: RangeFetcher;
  /** Tests replace the network call for website icons. */
  fetchIcon?: IconFetcher;
  /** Where the app's page is served, for the browser extension's "Open Keys" button. */
  appUrl?: string;
}

export function createApp(opts: AppOptions) {
  // Tests use an in-memory database; the app uses the file the user chose (or the default).
  const storage = opts.dbFile === ':memory:' ? new Storage({ memory: true }) : new Storage({ defaultFile: opts.dbFile ?? DB_FILE });
  const vault = new Vault(storage);
  const sessions = new SessionManager(() => vault.getSettings().autoLockMinutes * 60_000);
  const quick = new QuickUnlock();

  const app = express();
  app.disable('x-powered-by');
  app.set('etag', false);
  app.use(loopbackOnly, securityHeaders);
  const browsers = createExtensionApi({ vault, storage, sessions, quick, appUrl: opts.appUrl ?? 'http://localhost:5174' });
  app.use('/api/extension', browsers.extension);
  app.use(
    '/api',
    apiGuard(new Set(opts.allowedOrigins)),
    browsers.manage,
    createApi({ vault, storage, sessions, quick, fetchRange: opts.fetchRange, fetchIcon: opts.fetchIcon }),
  );

  if (opts.staticDir && fs.existsSync(path.join(opts.staticDir, 'index.html'))) {
    // Built files have content hashes in their names, so they never change: cache them for good.
    // The page itself always revalidates, so a new build shows up on the next load.
    app.use('/assets', express.static(path.join(opts.staticDir, 'assets'), { index: false, immutable: true, maxAge: '1y' }));
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(opts.staticDir!, 'index.html'));
    });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
    } else if (err instanceof KeyWipedError) {
      res.status(401).json({ error: 'Locked. Unlock to continue', code: 'LOCKED' });
    } else if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.too.large') {
      res.status(413).json({ error: 'Request is too large' });
    } else if (err && typeof err === 'object' && 'type' in err && err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Malformed JSON' });
    } else if (err && typeof err === 'object' && 'errcode' in err && (err.errcode === 5 || err.errcode === 6)) {
      // SQLITE_BUSY / SQLITE_LOCKED: another program held the file past the busy timeout.
      res.status(503).json({ error: 'The database is busy (another program is using it). Try again in a moment.', code: 'BUSY' });
    } else {
      // Never echo internal errors (they could contain data); log a generic line only.
      console.error('Unexpected error:', err instanceof Error ? err.name + ': ' + err.message : 'unknown');
      res.status(500).json({ error: 'Internal error' });
    }
  });

  return {
    app,
    storage,
    /** The currently open database (changes when the user connects another file). */
    get store() {
      return storage.store;
    },
    vault,
    sessions,
    quick,
  };
}
