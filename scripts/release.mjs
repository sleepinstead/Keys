// Ships a Keys update for Mac and Windows: builds both, signs both update packages, writes latest.json
// (what installed copies check), and publishes everything in one release. Installed apps then offer
// the update themselves.
//
//   npm run release -- --notes "What changed"      (or --notes-file notes.md)
//   npm run release -- --dry-run                   (build and sign only, publish nothing)
//   npm run release -- --prerelease …              (a GitHub pre-release; the update feed is left alone)
//   npm run release -- --mac-only …                (skip Windows; same as npm run mac:release)
//
// Bump "version" in desktop/app/tauri.conf.json, commit and push first. Windows is built by the
// "windows" GitHub workflow from the pushed commit (unsigned), while the Mac app builds here.
// The update key stays on this Mac: ~/.tauri/keys-updater.key (or KEYS_UPDATER_KEY=/path), its
// password in KEYS_UPDATER_KEY_PASSWORD. It's only handed to the signing steps, never to a build
// (where every dependency's build script runs).
//
// Mirror: if the GitHub repo sleepinstead/keys-updates exists (with Pages on), the feed and the
// packages are also published there, for networks that block GitHub's download servers.
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
const tag = `v${version}`;
const dry = flag('--dry-run');
const pre = flag('--prerelease');
const withWindows = !flag('--mac-only');
const winDir = path.join(root, 'dist-win');
const notes = value('--notes') ?? (value('--notes-file') ? fs.readFileSync(value('--notes-file'), 'utf8') : '');

const keyFile = process.env.KEYS_UPDATER_KEY ?? path.join(os.homedir(), '.tauri/keys-updater.key');
if (!fs.existsSync(keyFile)) fail(`No update signing key at ${keyFile}.`);

let draftExists = false;
const head = read('git', ['rev-parse', 'HEAD']);
if (!dry || withWindows) {
  // Windows builds on GitHub, so the commit has to be there (and the tree clean, so it matches).
  if (read('git', ['status', '--porcelain', '--untracked-files=no'])) fail('Commit your changes first.');
  if (head !== read('git', ['rev-parse', '@{u}'])) fail('Push your commits first.');
}
if (!dry) {
  if (!notes.trim()) fail('Add release notes: --notes "…" or --notes-file notes.md (they show in the update prompt).');
  if (ok('gh', ['release', 'view', tag, '--repo', REPO])) {
    draftExists = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'isDraft', '--jq', '.isDraft']) === 'true';
    if (!draftExists) fail(`${tag} is already released. Bump "version" in desktop/app/tauri.conf.json.`);
  }
}

// Windows: start the GitHub build now; it runs while the Mac app builds here.
let winRun = null;
if (withWindows) {
  const branch = read('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const list = () => JSON.parse(read('gh', ['run', 'list', '--repo', REPO, '--workflow', 'windows.yml', '--limit', '20', '--json', 'databaseId,headSha']));
  const before = new Set(list().map((r) => r.databaseId));
  run('gh', ['workflow', 'run', 'windows.yml', '--repo', REPO, '--ref', branch]);
  for (let i = 0; i < 60 && !winRun; i++) {
    execFileSync('sleep', ['2']);
    winRun = list().find((r) => !before.has(r.databaseId) && r.headSha === head)?.databaseId ?? null;
  }
  if (!winRun) fail('The Windows build didn’t start on GitHub.');
  console.log(`\nWindows is building on GitHub (run ${winRun}).`);
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
// macOS tar adds AppleDouble "._" files for extended attributes; the updater can't unpack those.
run('tar', ['--no-mac-metadata', '--no-xattrs', '-czf', tarball, '-C', bundle, 'Keys.app'], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
// Listed raw (macOS tar hides "._" entries when it reads its own archives).
const listing = read('python3', ['-c', 'import sys,tarfile; print("\\n".join(tarfile.open(sys.argv[1]).getnames()))', tarball]).split('\n');
if (listing.some((f) => path.basename(f.replace(/\/$/, '')).startsWith('._'))) fail('The update package contains macOS metadata files.');
if (!listing.includes('Keys.app/Contents/MacOS/keys-app')) fail('The update package is missing the app.');
run('ditto', ['-c', '-k', '--keepParent', path.join(bundle, 'Keys.app'), path.join(out, zipName)]);
// The browser extension ships alongside the app, from what's committed (git archive, like before).
const extVersion = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8')).version;
const extName = `Keys-extension-${extVersion}.zip`;
run('git', ['archive', '--format=zip', `--prefix=Keys-extension/`, '-o', path.join(out, extName), 'HEAD:extension']);

// Signed here, with the version bound into the signature (installed apps reject a feed that pairs a
// new version number with an older package).
run(path.join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '-f', keyFile, '-p', process.env.KEYS_UPDATER_KEY_PASSWORD ?? '', '--app-version', version, tarball], { cwd: appDir });
if (!fs.existsSync(`${tarball}.sig`)) fail('Signing produced no signature.');

// Windows: wait for GitHub's build, take its installer, and sign it here like the Mac package.
const winName = `Keys-windows-${version}-x64-setup.exe`;
const winSetup = path.join(out, winName);
if (withWindows) {
  console.log('\nWaiting for the Windows build…');
  try {
    run('gh', ['run', 'watch', String(winRun), '--repo', REPO, '--exit-status', '--interval', '20']);
  } catch {
    fail(`The Windows build failed: gh run view ${winRun} --repo ${REPO} --log-failed`);
  }
  fs.rmSync(winDir, { recursive: true, force: true });
  run('gh', ['run', 'download', String(winRun), '--repo', REPO, '--name', 'keys-windows', '--dir', winDir]);
  const exes = fs.readdirSync(winDir).filter((f) => f.endsWith('-setup.exe'));
  if (exes.length !== 1 || !exes[0].includes(`_${version}_`)) fail(`Expected one Keys ${version} installer from the Windows build, got: ${exes.join(', ') || 'none'}`);
  fs.copyFileSync(path.join(winDir, exes[0]), winSetup);
  run(path.join(root, 'node_modules/.bin/tauri'), ['signer', 'sign', '-f', keyFile, '-p', process.env.KEYS_UPDATER_KEY_PASSWORD ?? '', '--app-version', version, winSetup], { cwd: appDir });
  if (!fs.existsSync(`${winSetup}.sig`)) fail('Signing the Windows installer produced no signature.');
}

const pagesOn = ok('gh', ['repo', 'view', PAGES_REPO]);
const latest = {
  version,
  notes: notes.trim(),
  pub_date: new Date().toISOString(),
  ...(pagesOn ? { mirrors: [`${PAGES_URL}/${updateName}`] } : {}), // shortcut: the mirror covers the Mac package only
  platforms: {
    'darwin-aarch64': {
      signature: fs.readFileSync(`${tarball}.sig`, 'utf8').trim(),
      url: `https://github.com/${REPO}/releases/download/${tag}/${updateName}`,
    },
    ...(withWindows
      ? {
          'windows-x86_64': {
            signature: fs.readFileSync(`${winSetup}.sig`, 'utf8').trim(),
            url: `https://github.com/${REPO}/releases/download/${tag}/${winName}`,
          },
        }
      : {}),
  },
};
fs.writeFileSync(path.join(out, 'latest.json'), JSON.stringify(latest, null, 2) + '\n');
console.log(`\nBuilt in dist-mac/: ${zipName}, ${updateName} (signed), ${withWindows ? `${winName} (signed), ` : ''}${extName}, latest.json`);
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
  `${notes.trim()}\n\n## Install\n\nAlready using Keys? It offers this update itself (in the sidebar, or use Check for Updates…).\n\n**Mac:** download **${zipName}**, unzip it and drag **Keys.app** to Applications. First time: System Settings → Privacy & Security → **Open Anyway**. For Apple silicon Macs, macOS 11 or later.\n\n${withWindows ? `**Windows:** download **${winName}** and run it. The installer isn't code-signed yet, so Windows may say it protected your PC: click **More info** → **Run anyway**. Windows 10 or 11, 64-bit.\n\n` : ''}## Browser extension ${extVersion}\n\nDownload **${extName}**, unzip it, open \`chrome://extensions\`, turn on **Developer mode** and drag the **Keys-extension** folder in (or replace your existing folder's files and click reload). Then use **Connect to Keys**.\n`,
);
// A draft first: nothing is public until every file is up, and a failed run can simply be rerun.
if (!draftExists) {
  run('gh', ['release', 'create', tag, '--repo', REPO, '--draft', '--target', head, '--title', `Keys ${version}`, '--notes-file', notesFile, '--latest=false', ...(pre ? ['--prerelease'] : [])]);
}
const files = [path.join(out, zipName), tarball, path.join(out, extName), ...(withWindows ? [winSetup] : [])];
run('gh', ['release', 'upload', tag, ...files, '--repo', REPO, '--clobber']);
const assets = read('gh', ['release', 'view', tag, '--repo', REPO, '--json', 'assets', '--jq', '[.assets[].name] | join(",")']).split(',');
if (!files.map((f) => path.basename(f)).every((n) => assets.includes(n))) fail('Upload incomplete; rerun this command to finish.');
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
    if (withWindows) fs.copyFileSync(winSetup, path.join(dir, winName));
    fs.copyFileSync(path.join(out, 'latest.json'), path.join(dir, 'latest.json'));
    fs.writeFileSync(path.join(dir, '.nojekyll'), '');
    fs.writeFileSync(path.join(dir, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Keys updates</title><p>Keys ${version}. <a href="https://github.com/${REPO}/releases/tag/${tag}">Release notes and downloads</a>.</p>\n`);
    // One commit, replaced each time, so the repo never fills up with old packages.
    run('git', ['checkout', '--orphan', 'next'], { cwd: dir });
    run('git', ['add', '-A'], { cwd: dir });
    run('git', ['commit', '-q', '-m', `Keys ${version}`], { cwd: dir });
    run('git', ['push', '-q', '--force', 'origin', 'next:main'], { cwd: dir });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
if (!ok('gh', ['release', 'view', FEED_TAG, '--repo', REPO])) {
  run('gh', ['release', 'create', FEED_TAG, '--repo', REPO, '--title', 'Keys: update feed', '--notes', 'Keys checks this release’s latest.json for updates. Downloads are in the version releases.', '--latest=false']);
}
run('gh', ['release', 'upload', FEED_TAG, path.join(out, 'latest.json'), '--repo', REPO, '--clobber']);
console.log(`\n✓ Keys ${version} is out${withWindows ? ' for Mac and Windows' : ' for Mac'}. Installed copies will offer it within a few hours, or right away via Check for Updates….`);
