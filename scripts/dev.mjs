// Runs the Rust Keys server (the same core the Mac app ships) and Vite as one process.
// Restart this after changing desktop/core; the UI reloads on its own.
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const env = { ...process.env, PATH: `${path.join(os.homedir(), '.cargo/bin')}:${process.env.PATH}` };
const children = [
  spawn('cargo', ['run', '-q', '-p', 'keys-core', '--bin', 'keys-server'], { stdio: 'inherit', cwd: 'desktop', env }),
  spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' }),
];

let code = 0;
const stop = () => children.forEach((c) => c.exitCode === null && c.kill('SIGTERM'));
for (const c of children) {
  c.on('exit', (status, signal) => {
    // Stopped by a signal (Ctrl+C) is a normal stop, not a failure.
    code ||= status ?? (signal ? 0 : 1);
    stop();
  });
}
// Ctrl+C reaches the children too (same process group); this covers a plain `kill`.
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', () => process.exit(code));
