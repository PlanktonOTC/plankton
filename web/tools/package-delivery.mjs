/**
 * Portable delivery packager. Dry run by default; never runs the build itself.
 * node tools/package-delivery.mjs
 * node tools/package-delivery.mjs --package --verify
 * Optional: --python /path/to/python --port 4178
 * Python 3's standard library creates/tests the ZIP. No npm dependency required.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const packaging = args.includes('--package');
const verification = args.includes('--verify');
const option = name => {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value for ${name}`);
  return args[index + 1];
};
const entries = new Map();
async function sourceText(directory) {
  let result = '';
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result += await sourceText(file);
    else if (/\.(?:jsx?|tsx?|css)$/.test(entry.name)) result += await fs.readFile(file, 'utf8');
  }
  return result;
}
const source = await sourceText(path.join(root, 'src'));
const unusedAmbient = !source.includes('plankton-environment');
const unusedStudio = !source.includes('plankton-studio') && !/<MotionVideo\b[^>]*\bname\s*=\s*(?:["']studio["']|\{\s*["']studio["']\s*\})/.test(source);
const currentAsset = file => {
  if (unusedAmbient && /\/plankton-environment-(?:loop\.mp4|poster\.jpg)$/.test(file)) return false;
  if (unusedStudio && /\/plankton-studio-(?:loop\.(?:mp4|webm)|poster\.png)$/.test(file)) return false;
  return true;
};
const slash = value => value.split(path.sep).join('/');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const present = async file => { try { await fs.access(file); return true; } catch { return false; } };
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const allowedDoc = file => /\.(?:md|pdf|png|jpe?g|json)$/i.test(file) && !/(?:prompt|generation-manifest|snapshot|build|render-results|download-results)/i.test(path.basename(file));

async function add(relative, required = false) {
  const absolute = path.resolve(root, relative);
  if (!inside(root, absolute)) throw new Error(`Outside workspace: ${relative}`);
  if (!(await present(absolute))) {
    if (required) throw new Error(`Missing delivery input: ${relative}`);
    return;
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Only regular files may be packaged: ${relative}`);
  const real = await fs.realpath(absolute);
  if (!inside(await fs.realpath(root), real)) throw new Error(`Linked path escapes workspace: ${relative}`);
  entries.set(slash(relative), { absolute, bytes: stat.size, mtime: stat.mtimeMs });
}

async function tree(relative, filter = () => true, required = false) {
  const absolute = path.resolve(root, relative);
  if (!(await present(absolute))) {
    if (required) throw new Error(`Missing delivery directory: ${relative}`);
    return;
  }
  const stat = await fs.lstat(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Unsafe input directory: ${relative}`);
  for (const entry of await fs.readdir(absolute, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.env')) continue;
    const next = path.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlink is not a portable input: ${next}`);
    if (entry.isDirectory()) await tree(next, filter);
    else if (filter(slash(next))) await add(next);
  }
}

for (const file of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'index.html', 'serve-preview.mjs', 'START-HERE.md', 'AGENTS.md', 'THIRD-PARTY.md']) await add(file, true);
for (const file of ['.gitignore', 'vite.config.js', 'vite.config.mjs', 'vite.config.ts', 'jsconfig.json', 'tsconfig.json']) await add(file);
for (const directory of ['src', 'public', 'dist', 'tests']) await tree(directory, currentAsset, true);
await add('tools/package-delivery.mjs', true);
await add('tools/package-logo.cjs');
for (const file of ['backend-handoff.md', 'backend-handoff.pdf', 'source-map.md', 'reference-audit.md', 'motion-audit.md', 'video-slots.md', 'media.md']) await add(`docs/${file}`, true);
for (const file of ['company-logos.md', 'company-logo-provenance.json', 'dashboard-research.md', 'backend-handoff.snapshot.json']) await add(`docs/${file}`);
await tree('docs/qa', allowedDoc);
await tree('docs/source-documents', file => /\.(?:pdf|md)$/i.test(file));
await tree('docs/media-verification', file => allowedDoc(file) && /(?:contact\.(?:jpe?g|png)$|alpha-(?:proof|composite)\.|seam-compare\.|all-final-probes\.json$|loop-check\.json$|slots-verify-results\.json$)/i.test(file));
for (const file of ['source.html', 'index.html', 'server.mjs', 'download-manifest.json', 'urls.txt']) await add(`reference/${file}`);
for (const directory of ['reference/assets', 'reference/_nuxt', 'reference/fonts', 'reference/screenshots']) await tree(directory, file => !/\.(?:mp4|webm|mov|avi|zip)$/i.test(file));
await tree('reference/video', file => /(?:contact[^/]*\.(?:jpe?g|png)|probe\.txt)$/i.test(file));

// Keep current requirements, not unrelated prior chats or rejected brand history.
const task = await fs.readFile(path.join(root, 'TASK-STATE.md'), 'utf8');
const activeStart = task.indexOf('## Active website build');
const firstTableEnd = task.indexOf('\nExpert approach:', activeStart);
if (activeStart < 0 || firstTableEnd < 0) throw new Error('Cannot isolate current website checklist from TASK-STATE.md');
const currentTask = '# PLANKTON website delivery — current requirements\n\n' +
  'This delivery extract preserves the current website checklist. Earlier naming, artwork and conversation history are intentionally excluded.\n\n' +
  task.slice(activeStart, firstTableEnd).replace(/C:[/\\]Users[/\\]User[/\\]Documents[/\\]ChatGPT[/\\]SUBPENNY/g, '<project folder>') + '\n';
const generated = new Map([
  ['TASK-STATE.md', currentTask],
  ['PACKAGE-CONTENTS.md', `# PLANKTON portable website\n\nThe package includes editable React/CSS source, web media and fonts, the compiled dist preview, the dependency lockfile, tests, backend handoff and selected review evidence. Read START-HERE.md first.\n\n## Package boundaries\n\n- This is a local interactive demonstration, not connected financial infrastructure.\n- The four owner-supplied product PDFs are included in docs/source-documents for backend development, outside public and dist. Prior brand experiments, private generation prompts, conversation history, dependency folders and raw video masters are excluded.\n- The reference folder contains the Clear Street source shell, styles, modules, fonts and baseline screenshots for traceability. Its replay server can retrieve missing reference media from the original public host; that reference is not an offline-complete video archive. The PLANKTON dist preview is self-contained.\n- Generated media provenance and final properties are in docs/media.md. The private slot-generation manifest and raw masters mentioned there are intentionally not shipped.\n- DELIVERY-MANIFEST.json records each included file's SHA-256 digest. The packaging tool can reproduce a ZIP after a new build.\n\n## Rebuild this archive\n\nRun tests and build first, then run \`node tools/package-delivery.mjs --package --verify\`. Python 3 is used only for ZIP creation/integrity checking. Set \`--python /path/to/python\` if it is not on PATH. The website itself requires only the Node workflow in START-HERE.md.\n`],
]);

const size = [...entries.values()].reduce((total, entry) => total + entry.bytes, 0);
const newestInput = Math.max(...[...entries.entries()].filter(([name]) => /^(src\/|public\/|index\.html$|package\.json$|pnpm-lock\.yaml$)/.test(name)).map(([, entry]) => entry.mtime));
const built = entries.get('dist/index.html');
if (!built) throw new Error('dist/index.html is missing. Run the production build first.');
const stale = newestInput > built.mtime + 2000;
console.log(`${packaging ? 'Package' : 'Dry run'}: ${entries.size + generated.size + 1} files, ${(size / 1024 / 1024).toFixed(1)} MiB before ZIP compression.`);
console.log('Includes source, public assets, dist, tests, handoff docs and selected reference evidence.');
console.log('Includes the four owner-supplied source PDFs outside public/dist; excludes dependencies, raw original video, prior branding, private prompts and chat history.');
if (stale) console.log('Build is older than a source/public/package input. Rebuild before packaging.');
if (!packaging) {
  console.log('No files written. Run with --package --verify only after final build and review.');
  process.exit(0);
}
if (stale) throw new Error('Refusing stale dist. Run the production build, then package again.');

function pythonRuntime() {
  const explicit = option('--python');
  const candidates = explicit ? [[explicit, []]] : [['python', []], ['python3', []], ['py', ['-3']]];
  for (const [command, prefix] of candidates) {
    const test = spawnSync(command, [...prefix, '-c', 'import sys; assert sys.version_info.major == 3'], { windowsHide: true, encoding: 'utf8' });
    if (!test.error && test.status === 0) return { command, prefix };
  }
  throw new Error('Python 3 was not found. Pass --python with the interpreter path. No ZIP was created.');
}
const python = pythonRuntime();
function runPython(source, scriptArgs) {
  const result = spawnSync(python.command, [...python.prefix, '-c', source, ...scriptArgs], { windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(result.stderr || result.error?.message || 'ZIP operation failed');
  if (result.stdout.trim()) console.log(result.stdout.trim());
}

const delivery = path.join(root, 'delivery');
await fs.mkdir(delivery, { recursive: true });
const stageParent = await fs.mkdtemp(path.join(os.tmpdir(), 'plankton-delivery-'));
const stage = path.join(stageParent, 'PLANKTON-website');
await fs.mkdir(stage);
const manifest = [];
for (const [name, entry] of [...entries.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  const bytes = await fs.readFile(entry.absolute);
  const destination = path.join(stage, name);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.writeFile(destination, bytes);
  manifest.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
for (const [name, content] of generated) {
  const bytes = Buffer.from(content);
  await fs.writeFile(path.join(stage, name), bytes);
  manifest.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
}
manifest.sort((a, b) => a.path.localeCompare(b.path));
await fs.writeFile(path.join(stage, 'DELIVERY-MANIFEST.json'), JSON.stringify({ format: 1, generatedAt: new Date().toISOString(), files: manifest }, null, 2) + '\n');
const zip = path.join(delivery, 'PLANKTON-website.zip');
if (await present(zip)) {
  const previous = path.join(delivery, `PLANKTON-website.previous-${Date.now()}.zip`);
  await fs.rename(zip, previous);
  console.log(`Preserved previous package: ${path.basename(previous)}`);
}
runPython(String.raw`import pathlib, sys, zipfile
stage, target = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(stage.rglob('*')):
        if file.is_file(): archive.write(file, pathlib.PurePosixPath(stage.name, file.relative_to(stage).as_posix()))
with zipfile.ZipFile(target) as archive:
    bad = archive.testzip()
    if bad: raise RuntimeError('ZIP CRC failed: ' + bad)
print('ZIP created; CRC verified.')
`, [stage, zip]);

if (verification) {
  const extractParent = await fs.mkdtemp(path.join(delivery, 'verify-'));
  runPython(String.raw`import pathlib, sys, zipfile
source, target = map(pathlib.Path, sys.argv[1:])
with zipfile.ZipFile(source) as archive:
    for info in archive.infolist():
        member = pathlib.PurePosixPath(info.filename)
        if member.is_absolute() or '..' in member.parts: raise RuntimeError('Unsafe ZIP member')
    archive.extractall(target)
`, [zip, extractParent]);
  const extracted = path.join(extractParent, 'PLANKTON-website');
  for (const entry of manifest) {
    const bytes = await fs.readFile(path.join(extracted, entry.path));
    if (sha(bytes) !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Extracted checksum mismatch: ${entry.path}`);
  }
  const test = spawnSync(process.execPath, ['--test', ...[...entries.keys()].filter(name => /^tests\/[^/]+\.test\.mjs$/.test(name))], { cwd: extracted, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 });
  if (test.status !== 0) throw new Error(`Extracted unit checks failed:\n${test.stderr}\n${test.stdout}`);
  const port = Number(option('--port')) || await new Promise((resolve, reject) => {
    const probe = http.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const port = probe.address().port; probe.close(() => resolve(port)); });
  });
  const server = spawn(process.execPath, ['serve-preview.mjs', '--port', String(port)], { cwd: extracted, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let errorText = '';
  server.stderr.on('data', bytes => { errorText += bytes; });
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Extracted preview startup timed out')), 10000);
      server.stdout.on('data', () => { clearTimeout(timeout); resolve(); });
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Preview exited ${code}: ${errorText}`)); });
    });
    const checks = [];
    for (const route of ['/', '/trade', '/trade?view=portfolio', '/docs', '/docs?topic=risk']) {
      const response = await fetch(`http://127.0.0.1:${port}${route}`);
      if (!response.ok || !(await response.text()).includes('id="root"')) throw new Error(`Extracted route failed: ${route}`);
      checks.push(`${route}: ${response.status}`);
    }
    const movie = [...entries.keys()].find(name => /^dist\/assets\/.+\.mp4$/.test(name));
    if (movie) {
      const response = await fetch(`http://127.0.0.1:${port}/${movie.slice(5)}`, { headers: { Range: 'bytes=0-63' } });
      if (response.status !== 206 || (await response.arrayBuffer()).byteLength !== 64) throw new Error('Extracted video range check failed');
      checks.push('MP4 byte range: 206 / 64 bytes');
    }
    const result = { verifiedAt: new Date().toISOString(), archive: path.basename(zip), sha256: sha(await fs.readFile(zip)), filesChecked: manifest.length, crc: 'pass', cleanExtraction: slash(path.relative(root, extracted)), unitTests: 'pass', builtRoutes: checks, browserVisualQA: 'Separate review; this script checks HTTP and source tests only.' };
    await fs.writeFile(path.join(delivery, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(`Clean extraction passed: ${manifest.length} hashes, source unit tests, routes and media range.`);
    console.log(`Extracted copy: ${extracted}`);
  } finally {
    server.kill();
  }
}
console.log(`Delivery: ${zip}`);
console.log(`Staging retained for inspection: ${stage}`);
