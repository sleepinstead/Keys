// Ships a Keys for Mac update: builds and signs the app, writes latest.json (what installed copies
// check), and publishes both on GitHub. Installed apps then offer the update themselves.
//
//   npm run mac:release -- --notes "What changed"      (or --notes-file notes.md)
//   npm run mac:release -- --dry-run                   (build and sign only, publish nothing)
//
// Bump "version" in desktop/app/tauri.conf.json first. The update key stays on this Mac:
// ~/.tauri/keys-updater.key (or KEYS_UPDATER_KEY=/path); its password, if any, in
// KEYS_UPDATER_KEY_PASSWORD. Never commit it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'sleepinstead/Keys';
const FEED_TAG = 'mac-updates'; // a fixed release holding latest.json, so its address never changes
const root = path.resolve(import.meta.dirname, '..');
const appDir = path.join(root, 'desktop/app');
const out = path.join(root, 'dist-mac');

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { stdio: 'inherit', cwd: root, ...opts });
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

const { version } = JSON.parse(fs.readFileSync(path.join(appDir, 'tauri.conf.json'), 'utf8'));
const tag = `mac-v${version}`;
const dry = flag('--dry-run');
const notes = value('--notes') ?? (value('--notes-file') ? fs.readFileSync(value('--notes-file'), 'utf8') : '');
if (!dry && !notes.trim()) fail('Add release notes: --notes "…" or --notes-file notes.md (they show in the update prompt).');

if (!dry) {
  let exists = true;
  try {
    execFileSync('gh', ['release', 'view', tag, '--repo', REPO], { cwd: root, stdio: 'ignore' });
  } catch {
    exists = false;
  }
  if (exists) fail(`${tag} is already released. Bump "version" in desktop/app/tauri.conf.json.`);
}

const keyFile = process.env.KEYS_UPDATER_KEY ?? path.join(os.homedir(), '.tauri/keys-updater.key');
if (!fs.existsSync(keyFile)) fail(`No update signing key at ${keyFile}.`);
const env = {
  ...process.env,
  PATH: `${path.join(os.homedir(), '.cargo/bin')}:${process.env.PATH}`,
  TAURI_SIGNING_PRIVATE_KEY: fs.readFileSync(keyFile, 'utf8'),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: process.env.KEYS_UPDATER_KEY_PASSWORD ?? '',
};

console.log(`\nBuilding Keys for Mac ${version}…`);
run('npm', ['run', 'build']);
run(path.join(root, 'node_modules/.bin/tauri'), ['build', '--bundles', 'app'], { cwd: appDir, env });

const bundle = path.join(root, 'desktop/target/release/bundle/macos');
const tarball = path.join(bundle, 'Keys.app.tar.gz');
if (!fs.existsSync(`${tarball}.sig`)) fail('The build made no signed update. Check createUpdaterArtifacts in tauri.conf.json.');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const updateName = `Keys-mac-${version}-arm64.app.tar.gz`;
const zipName = `Keys-mac-${version}-arm64.zip`;
fs.copyFileSync(tarball, path.join(out, updateName));
run('ditto', ['-c', '-k', '--keepParent', path.join(bundle, 'Keys.app'), path.join(out, zipName)]);

const latest = {
  version,
  notes: notes.trim(),
  pub_date: new Date().toISOString(),
  platforms: {
    'darwin-aarch64': {
      signature: fs.readFileSync(`${tarball}.sig`, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${updateName}`,
    },
  },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nBuilt in dist-mac/: ${zipName}, ${updateName}, latest.json`);
if (dry) process.exit(0);

console.log(`\nPublishing ${tag}…`);
const notesFile = path.join(out, 'notes.md');
fs.writeFileSync(
  notesFile,
  `${notes.trim()}\n\n## Install\n\nAlready using Keys for Mac 0.2.0 or later? It offers this update itself (Keys → Check for Updates…).\n\nOtherwise download **${zipName}**, unzip it and drag **Keys.app** to Applications. First time: System Settings → Privacy & Security → **Open Anyway**. For Apple silicon Macs, macOS 11 or later.\n`,
);
run('gh', ['release', 'create', tag, path.join(out, zipName), path.join(out, updateName), '--repo', REPO, '--title', `Keys for Mac ${version}`, '--notes-file', notesFile, '--latest=false', ...(flag('--prerelease') ? ['--prerelease'] : [])]);

// The feed: one release whose latest.json is replaced each time.
let feedExists = true;
try {
  execFileSync('gh', ['release', 'view', FEED_TAG, '--repo', REPO], { cwd: root, stdio: 'ignore' });
} catch {
  feedExists = false;
}
if (!feedExists) {
  run('gh', ['release', 'create', FEED_TAG, '--repo', REPO, '--title', 'Keys for Mac: update feed', '--notes', 'Keys for Mac checks this release’s latest.json for updates. Downloads are in the mac-v… releases.', '--latest=false']);
}
run('gh', ['release', 'upload', FEED_TAG, path.join(out, 'latest.json'), '--repo', REPO, '--clobber']);
console.log(`\n✓ Keys for Mac ${version} is out. Installed copies will offer it within a few hours, or right away via Check for Updates….`);
