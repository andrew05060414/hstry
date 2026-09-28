// Install the browser extension into a stable directory the browser loads
// unpacked, exported from a git ref (default origin/main) rather than from
// whatever branch the working tree happens to be on.
//
// Usage: node scripts/install-extension.mjs [--dest DIR] [--ref REF] [--no-fetch] [--dry-run]
//
// Destination: --dest, then $CHRONICLE_EXTENSION_DIR, then the directory used
// last time (git config chronicle.extensionDir), then
// $XDG_DATA_HOME/chronicle/extension (Windows: %LOCALAPPDATA%\chronicle\extension).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const MARKER = 'chronicle-install.json';

function parseArgs(argv) {
  const args = { dest: null, ref: 'origin/main', fetch: true, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dest') args.dest = argv[++i];
    else if (arg === '--ref') args.ref = argv[++i];
    else if (arg === '--no-fetch') args.fetch = false;
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      console.log('Usage: node scripts/install-extension.mjs [--dest DIR] [--ref REF] [--no-fetch] [--dry-run]');
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function git(args, options = {}) {
  return execFileSync('git', args, { encoding: options.encoding ?? 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function gitConfig(key) {
  try {
    return git(['config', '--local', '--get', key]).trim() || null;
  } catch {
    return null;
  }
}

function defaultDest() {
  if (process.platform === 'win32') {
    const base = process.env.XDG_DATA_HOME ?? process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
    return join(base, 'chronicle', 'extension');
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'chronicle', 'extension');
}

function expand(path) {
  return path.replace(/^~(?=$|[\\/])/, homedir()).replace(/\$(\w+)|%(\w+)%/g, (match, a, b) => process.env[a ?? b] ?? match);
}

/** Only ever replace a directory this script created, or an empty one. */
function assertReplaceable(dest) {
  if (!existsSync(dest)) return;
  if (existsSync(join(dest, MARKER))) return;
  if (readdirSync(dest).length === 0) return;
  throw new Error(`${dest} exists and was not created by install-extension; refusing to overwrite it`);
}

const args = parseArgs(process.argv.slice(2));
const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);

const rememberedDest = gitConfig('chronicle.extensionDir');
const dest = resolve(expand(args.dest ?? process.env.CHRONICLE_EXTENSION_DIR ?? rememberedDest ?? defaultDest()));

if (args.fetch && args.ref.startsWith('origin/')) {
  git(['fetch', '--quiet', 'origin', args.ref.slice('origin/'.length)]);
}
const commit = git(['rev-parse', '--verify', `${args.ref}^{commit}`]).trim();
const files = git(['ls-tree', '-r', '--name-only', commit, '--', 'extension'])
  .split('\n')
  .filter(Boolean)
  .filter(path => !path.startsWith('extension/test/'));
if (!files.includes('extension/manifest.json')) {
  throw new Error(`${args.ref} has no extension/manifest.json`);
}
const manifest = JSON.parse(git(['show', `${commit}:extension/manifest.json`]));

console.log(`extension ${manifest.name} v${manifest.version} from ${args.ref} (${commit.slice(0, 10)})`);
console.log(`destination ${dest}`);
if (args.dryRun) {
  console.log(`dry run: would copy ${files.length} files`);
  process.exit(0);
}

assertReplaceable(dest);
const staging = `${dest}.installing-${process.pid}`;
rmSync(staging, { recursive: true, force: true });
for (const path of files) {
  const target = join(staging, path.slice('extension/'.length));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, git(['show', `${commit}:${path}`], { encoding: 'buffer' }));
}
writeFileSync(
  join(staging, MARKER),
  `${JSON.stringify({ ref: args.ref, commit, version: manifest.version, installedAt: new Date().toISOString() }, null, 2)}\n`
);

mkdirSync(dirname(dest), { recursive: true });
const previous = existsSync(dest) ? `${dest}.previous-${process.pid}` : null;
if (previous) renameSync(dest, previous);
renameSync(staging, dest);
if (previous) rmSync(previous, { recursive: true, force: true });

if (args.dest && rememberedDest !== dest) git(['config', '--local', 'chronicle.extensionDir', dest]);

console.log(`installed ${files.length} files`);
console.log(
  previous
    ? `next: open chrome://extensions (or edge://extensions) and click Reload on "${manifest.name}"`
    : `next: open chrome://extensions (or edge://extensions), enable Developer mode, "Load unpacked", and pick ${dest}`
);
