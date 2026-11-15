// Ships a Keys for Mac update: builds the app, signs the update package, writes latest.json (what
// installed copies check), and publishes everything. Installed apps then offer the update themselves.
//
//   npm run mac:release -- --notes "What changed"      (or --notes-file notes.md)
//   npm run mac:release -- --dry-run                   (build and sign only, publish nothing)
//   npm run mac:release -- --prerelease …              (a GitHub pre-release; the update feed is left alone)
//
// Bump "version" in desktop/app/tauri.conf.json, commit and push first. The update key stays on this
// Mac: ~/.tauri/keys-updater.key (or KEYS_UPDATER_KEY=/path), its password in KEYS_UPDATER_KEY_PASSWORD.
// It's only handed to the signing step, never to the build (where every dependency's build script runs).
//
// Mirror: if the GitHub repo sleepinstead/keys-updates exists (with Pages on), the feed and the package
// are also published there, for networks that block GitHub's download servers. Apps try it first.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = 'sleepinstead/Keys';
const FEED_TAG = 'mac-updates'; // a fixed release holding latest.json, so its address never changes
const PAGES_REPO = 'sleepinstead/keys-updates';
const PAGES_URL = 'https://sleepinstead.github.io/keys-updates';
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
const tag = `mac-v${version}`;
const dry = flag('--dry-run');
const pre = flag('--prerelease');
const notes = value('--notes') ?? (value('--notes-file') ? fs.readFileSync(value('--notes-file'), 'utf8') : '');

const keyFile = process.env.KEYS_UPDATER_KEY ?? path.join(os.homedir(), '.tauri/keys-updater.key');
if (!fs.existsSync(keyFile)) fail(`No update signing key at ${keyFile}.`);

let draftExists = false;
if (!dry) {
  if (!notes.trim()) fail('Add release notes: --notes "…" or --notes-file notes.md (they show in the update prompt).');
  // Publish exactly what's committed and pushed, so the tag points at the code that was built.
  if (read('git', ['status', '--porcelain', '--untracked-files=no'])) fail('Commit your changes first.');
  if (read('git', ['rev-parse', 'HEAD']) !== read('git', ['rev-parse', '@{u}'])) fail('Push your commits first.');
  if (ok('gh', ['release', 'view', tag, '--repo', REPO])) {
    draftExists = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft', '--jq', '.isDraft']) === 'true';
    if (!draftExists) fail(`${tag} is already released. Bump "version" in desktop/app/tauri.conf.json.`);
  }
}

console.log(`\nBuilding Keys for Mac ${version}…`);
const buildEnv = { ...process.env, PATH: `${path.join(os.homedir(), '.cargo/bin')}:${process.env.PATH}` };
delete buildEnv.TAURI_SIGNING_PRIVATE_KEY;
delete buildEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD;
run('npm', ['run', 'build'], { env: buildEnv });
run(path.join(root, 'node_modules/.bin/tauri'), ['build', '--bundles', 'app', '--config', JSON.stringify({ bundle: { createUpdaterArtifacts: false } })], { cwd: appDir, env: buildEnv });

const bundle = path.join(root, 'desktop/target/release/bundle/macos');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out);
const updateName = `Keys-mac-${version}-arm64.app.tar.gz`;
const zipName = `Keys-mac-${version}-arm64.zip`;
const tarball = path.join(out, updateName);
run('tar', ['-czf', tarball, '-C', bundle, 'Keys.app']);
run('ditto', ['-c', '-k', '--keepParent', path.join(bundle, 'Keys.app'), path.join(out, zipName)]);

// Signed here, with the version bound into the signature (installed apps reject a feed that pairs a
// new version number with an older package).
run(path.join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '-f', keyFile, '-p', process.env.KEYS_UPDATER_KEY_PASSWORD ?? '', '--app-version', version, tarball], { cwd: appDir });
if (!fs.existsSync(`${tarball}.sig`)) fail('Signing produced no signature.');

const pagesOn = ok('gh', ['repo', 'view', PAGES_REPO]);
const latest = {
  version,
  notes: notes.trim(),
  pub_date: new Date().toISOString(),
  ...(pagesOn ? { mirrors: [`${PAGES_URL}/${updateName}`] } : {}),
  platforms: {
    'darwin-aarch64': {
      signature: fs.readFileSync(`${tarball}.sig`, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${updateName}`,
    },
  },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nBuilt in dist-mac/: ${zipName}, ${updateName} (signed), latest.json`);
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
  `${notes.trim()}\n\n## Install\n\nAlready using Keys for Mac 0.2.0 or later? It offers this update itself (it appears in the sidebar, or use Keys → Check for Updates…).\n\nOtherwise download **${zipName}**, unzip it and drag **Keys.app** to Applications. First time: System Settings → Privacy & Security → **Open Anyway**. For Apple silicon Macs, macOS 11 or later.\n`,
);
// A draft first: nothing is public until every file is up, and a failed run can simply be rerun.
if (!draftExists) {
  run('gh', ['release', 'create', tag, '--repo', REPO, '--draft', '--target', read('git', ['rev-parse', 'HEAD']), '--title', `Keys for Mac ${version}`, '--notes-file', notesFile, '--latest=false', ...(pre ? ['--prerelease'] : [])]);
}
run('gh', ['release', 'upload', tag, path.join(out, zipName), tarball, '--repo', REPO, '--clobber']);
const assets = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets', '--jq', '[.assets[].name] | join(",")']).split(',');
if (!assets.includes(zipName) || !assets.includes(updateName)) fail('Upload incomplete; rerun this command to finish.');
run('gh', ['release', 'edit', tag, '--repo', REPO, '--draft=false']);

if (pre) {
  console.log(`\n✓ ${tag} is out as a pre-release. The update feed was left alone.`);
  process.exit(0);
}

// The mirror first, then the main feed (so a mirror listed in latest.json already exists).
if (pagesOn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keys-updates-'));
  try {
    run('git', ['clone', '--depth', '1', `https://github.com/${PAGES_REPO}.git`, dir]);
    for (const f of fs.readdirSync(dir)) if (f !== '.git') fs.rmSync(path.join(dir, f), { recursive: true, force: true });
    fs.copyFileSync(tarball, path.join(dir, updateName));
    fs.copyFileSync(path.join(out, 'latest.json'), path.join(dir, 'latest.json'));
    fs.writeFileSync(path.join(dir, '.nojekyll'), '');
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Keys for Mac updates</title><p>Keys for Mac ${version}. <a href="https://github.com/${REPO}/releases/tag/${tag}">Release notes and downloads</a>.</p>\n`);
    // One commit, replaced each time, so the repo never fills up with old packages.
    run('git', ['checkout', '--orphan', 'next'], { cwd: dir });
    run('git', ['add', '-A'], { cwd: dir });
    run('git', ['commit', '-q', '-m', `Keys for Mac ${version}`], { cwd: dir });
    run('git', ['push', '-q', '--force', 'origin', 'next:main'], { cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (!ok('gh', ['release', 'view', FEED_TAG, '--repo', REPO])) {
  run('gh', ['release', 'create', FEED_TAG, '--repo', REPO, '--title', 'Keys for Mac: update feed', '--notes', 'Keys for Mac checks this release’s latest.json for updates. Downloads are in the mac-v… releases.', '--latest=false']);
}
run('gh', ['release', 'upload', FEED_TAG, path.join(out, 'latest.json'), '--repo', REPO, '--clobber']);
console.log(`\n✓ Keys for Mac ${version} is out. Installed copies will offer it within a few hours, or right away via Check for Updates….`);
