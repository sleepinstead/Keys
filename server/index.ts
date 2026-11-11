import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.ts';

// `--production` works on every OS (NODE_ENV=... in an npm script doesn't on Windows).
const production = process.env.NODE_ENV === 'production' || process.argv.includes('--production');
const port = Number(process.env.KEYS_PORT ?? 5174);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`KEYS_PORT must be a port number from 1 to 65535 (got "${process.env.KEYS_PORT}")`);
  process.exit(1);
}
const host = '127.0.0.1'; // never listen on external interfaces
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
if (!production) origins.push('http://localhost:5173', 'http://127.0.0.1:5173'); // Vite dev server

if (production && !fs.existsSync(path.join(root, 'dist', 'index.html'))) {
  console.error('The app isn’t built yet. Run `npm run build`, then `npm start`.');
  process.exit(1);
}

const { app, storage, sessions } = createApp({
  allowedOrigins: origins,
  staticDir: production ? path.join(root, 'dist') : undefined,
  appUrl: production ? `http://localhost:${port}` : 'http://localhost:5173',
});

const server = app.listen(port, host, (err?: Error) => {
  if (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(code === 'EADDRINUSE' ? `Port ${port} is already in use. Stop the other program, or set KEYS_PORT to another port.` : `Keys couldn’t start: ${err.message}`);
    process.exit(1);
  }
  // In dev, Vite prints the address to open.
  if (production) console.log(`Keys: http://localhost:${port}`);
  const where = storage.info();
  if (!where.available) console.warn(`Database unavailable: ${where.error}`);
});

function shutdown() {
  sessions.dispose(); // wipes the in-memory key
  server.close(() => {
    storage.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
