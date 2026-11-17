// Ships a Keys for Windows update: GitHub builds the installer (the "windows" workflow, from the
// pushed commit), this Mac signs it with the update key, writes latest.json (what installed copies
// check) and publishes everything. Installed apps then offer the update themselves.
//
//   npm run release -- --notes "What changed"      (or --notes-file notes.md)
//   npm run release -- --dry-run                   (build and sign only, publish nothing)
//   npm run release -- --prerelease …              (a GitHub pre-release; the update feed is left alone)
//
// Run from keys-windows/. Bump "version" in desktop/app/tauri.conf.json and desktop/app/Cargo.toml,
// commit and push first. The update key stays on this Mac: ~/.tauri/keys-updater.key (or
// KEYS_UPDATER_KEY=/path), its password in KEYS_UPDATER_KEY_PASSWORD. It's only handed to the
// signing step, never to a build.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'sleepinstead/Keys';
const FEED_TAG = 'windows-updates'; // a fixed release holding latest.json, so its address never changes
const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'desktop/app');
const out = path.join(root, 'dist-win');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: root, ...opts });
const read = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { cwd: root, encoding: 'utf8', ...opts }).trim();
const ok = (cmd, argv) => {
  try {
    execFileSync(cmd, argv, { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

const { version } = JSON.parse(fs.readFileSync(path.join(appDir, 'tauri.conf.json'), 'utf8'));
const tag = `windows-v${version}`;
const dry = flag('--dry-run');
const pre = flag('--prerelease');
const notes = value('--notes') ?? (value('--notes-file') ? fs.readFileSync(value('--notes-file'), 'utf8') : '');

const keyFile = process.env.KEYS_UPDATER_KEY ?? path.join(os.homedir(), '.tauri/keys-updater.key');
if (!fs.existsSync(keyFile)) fail(`No update signing key at ${keyFile}.`);

// GitHub builds the pushed commit, so it has to be there (and the tree clean, so it matches).
const head = read('git', ['rev-parse', 'HEAD']);
if (read('git', ['status', '--porcelain', '--untracked-files=no'])) fail('Commit your changes first.');
if (head !== read('git', ['rev-parse', '@{u}'])) fail('Push your commits first.');
let draftExists = false;
if (!dry) {
  if (!notes.trim()) fail('Add release notes: --notes "…" or --notes-file notes.md (they show in the update prompt).');
  if (ok('gh', ['release', 'view', tag, '--repo', REPO])) {
    draftExists = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft', '--jq', '.isDraft']) === 'true';
    if (!draftExists) fail(`${tag} is already released. Bump "version" in desktop/app/tauri.conf.json.`);
  }
}

console.log(`\nBuilding Keys for Windows ${version} on GitHub…`);
const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
const list = () => JSON.parse(read('gh', ['run', 'list', '--repo', REPO, '--workflow', 'windows.yml', '--limit', '20', '--json', 'databaseId,headSha']));
const before = new Set(list().map((r) => r.databaseId));
run('gh', ['workflow', 'run', 'windows.yml', '--repo', REPO, '--ref', branch]);
let winRun = null;
for (let i = 0; i < 60 && !winRun; i++) {
  execFileSync('sleep', ['2']);
  winRun = list().find((r) => !before.has(r.databaseId) && r.headSha === head)?.databaseId ?? null;
}
if (!winRun) fail('The Windows build didn’t start on GitHub.');
try {
  run('gh', ['run', 'watch', String(winRun), '--repo', REPO, '--exit-status', '--interval', '20']);
} catch {
  fail(`The Windows build failed: gh run view ${winRun} --repo ${REPO} --log-failed`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const download = path.join(out, 'build');
run('gh', ['run', 'download', String(winRun), '--repo', REPO, '--name', 'keys-windows', '--dir', download]);
const exes = fs.readdirSync(download).filter((f) => f.endsWith('-setup.exe'));
if (exes.length !== 1 || !exes[0].includes(`_${version}_`)) fail(`Expected one Keys ${version} installer from the Windows build, got: ${exes.join(', ') || 'none'}`);
const setupName = `Keys-windows-${version}-x64-setup.exe`;
const setup = path.join(out, setupName);
fs.copyFileSync(path.join(download, exes[0]), setup);

// The browser extension ships alongside the app, from what's committed.
const extVersion = JSON.parse(fs.readFileSync(path.join(root, '../keys-extension/manifest.json'), 'utf8')).version;
const extName = `Keys-extension-${extVersion}.zip`;
run('git', ['-C', path.join(root, '..'), 'archive', '--format=zip', '--prefix=Keys-extension/', '-o', path.join(out, extName), 'HEAD:keys-extension']);

// Signed here, with the version bound into the signature.
run(path.join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '-f', keyFile, '-p', process.env.KEYS_UPDATER_KEY_PASSWORD ?? '', '--app-version', version, setup], { cwd: appDir });
if (!fs.existsSync(`${setup}.sig`)) fail('Signing produced no signature.');

const latest = {
  version,
  notes: notes.trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(`${setup}.sig`, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${setupName}`,
    },
  },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nBuilt in dist-win/: ${setupName} (signed), ${extName}, latest.json`);
if (dry) process.exit(0);

// Never move the feed backwards.
if (!pre && ok('gh', ['release', 'view', FEED_TAG, '--repo', REPO])) {
  try {
    const live = JSON.parse(read('gh', ['api', '-H', 'Accept: application/octet-stream', read('gh', ['api', `repos/${REPO}/releases/tags/${FEED_TAG}`, '--jq', '.assets[] | select(.name == "latest.json") | .url'])]));
    if (!newer(version, live.version)) fail(`The update feed already offers ${live.version}; ${version} isn't newer.`);
  } catch (e) {
    if (e?.status !== undefined) throw e;
  }
}

console.log(`\nPublishing ${tag}…`);
const notesFile = path.join(out, 'notes.md');
fs.writeFileSync(
  notesFile,
  `${notes.trim()}\n\n## Install\n\nAlready using Keys for Windows? It offers this update itself (in the sidebar, or Check for Updates… in the tray menu).\n\nOtherwise download **${setupName}** and run it. The installer isn't code-signed yet, so Windows may say it protected your PC: click **More info** → **Run anyway**. With Smart App Control on, use Keys in the browser (keys-web) until the installer is signed. Windows 10 or 11, 64-bit.\n\n## Browser extension ${extVersion}\n\nDownload **${extName}**, unzip it, open \`chrome://extensions\`, turn on **Developer mode** and drag the **Keys-extension** folder in. Then use **Connect to Keys**.\n`,
);
if (!draftExists) {
  run('gh', ['release', 'create', tag, '--repo', REPO, '--draft', '--target', head, '--title', `Keys for Windows ${version}`, '--notes-file', notesFile, '--latest=false', ...(pre ? ['--prerelease'] : [])]);
}
const files = [setup, path.join(out, extName)];
run('gh', ['release', 'upload', tag, ...files, '--repo', REPO, '--clobber']);
const assets = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets', '--jq', '[.assets[].name] | join(",")']).split(',');
if (!files.map((f) => path.basename(f)).every((n) => assets.includes(n))) fail('Upload incomplete; rerun this command to finish.');
run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false']);

if (pre) {
  console.log(`\n✓ ${tag} is out as a pre-release. The update feed was left alone.`);
  process.exit(0);
}
if (!ok('gh', ['release', 'view', FEED_TAG, '--repo', REPO])) {
  run('gh', ['release', 'create', FEED_TAG, '--repo', REPO, '--title', 'Keys for Windows: update feed', '--notes', 'Keys for Windows checks this release’s latest.json for updates. Downloads are in the windows-v… releases.', '--latest=false']);
}
run('gh', ['release', 'upload', FEED_TAG, path.join(out, 'latest.json'), '--repo', REPO, '--clobber']);
console.log(`\n✓ Keys for Windows ${version} is out. Installed copies will offer it within a few hours, or right away via Check for Updates….`);
