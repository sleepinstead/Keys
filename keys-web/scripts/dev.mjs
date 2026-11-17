// The web server (restarting on changes) and Vite with live reload, as one process.
import { spawn } from 'node:child_process';

const children = [
  spawn(process.execPath, ['--watch-path=server', '--watch-path=shared', '--watch-preserve-output', 'server/index.ts'], { stdio: 'inherit' }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let code = 0;
const stop = () => children.forEach((c) => c.exitCode === null && c.kill('SIGTERM'));
for (const c of children) {
  c.on('exit', (status, signal) => {
    code ||= status ?? (signal ? 0 : 1);
    stop();
  });
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', () => process.exit(code));
