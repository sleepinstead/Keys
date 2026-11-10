// Runs the API (restarting on changes) and Vite as one process. Output is passed straight through,
// so the terminal shows only Vite's own banner, with no prefixes.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', '--watch-preserve-output', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let code = 0;
const stop = () => children.forEach((c) => c.exitCode === null && c.kill('SIGTERM'));
for (const c of children) {
  c.on('exit', (status) => {
    code ||= status ?? 1;
    stop();
  });
}
// Ctrl+C reaches the children too (same process group); this covers a plain `kill`.
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', () => process.exit(code));
