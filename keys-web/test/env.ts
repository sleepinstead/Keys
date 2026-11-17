// Loaded before any test (node --import): every test gets a scratch home, so nothing ever reads or
// writes the real Keys folder (the database path and browsers.json are fixed when server modules load).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-test-'));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, '.config');
process.env.APPDATA = path.join(home, 'AppData', 'Roaming');
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));
