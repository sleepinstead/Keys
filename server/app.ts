import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { KeyWipedError } from './crypto.ts';
import { createApi } from './routes.ts';
import type { RangeFetcher } from './audit.ts';
import type { IconFetcher } from './favicon.ts';
import { apiGuard, loopbackOnly, securityHeaders } from './security.ts';
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
  app.use(
    '/api',
    apiGuard(new Set(opts.allowedOrigins)),
    createApi({ vault, storage, sessions, quick, fetchRange: opts.fetchRange, fetchIcon: opts.fetchIcon }),
  );

  if (opts.staticDir && fs.existsSync(path.join(opts.staticDir, 'index.html'))) {
    app.use(express.static(opts.staticDir, { index: false, maxAge: '1h' }));
    app.get(/.*/, (_req, res) => res.sendFile(path.join(opts.staticDir!, 'index.html')));
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
    } else {
      // Never echo internal errors (they could contain data); log a generic line only.
      console.error('[keys] unexpected error:', err instanceof Error ? err.name + ': ' + err.message : 'unknown');
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
