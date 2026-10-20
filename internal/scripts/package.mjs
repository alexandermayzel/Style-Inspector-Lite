import { readFile, writeFile, mkdir, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { zipSync, unzipSync } from 'fflate';
import { buildExtension, root } from './build.mjs';
import { artifactsRoot, publicDocumentAllowed, resolveExternal } from './paths.mjs';
export { isInside, resolveExternal } from './paths.mjs';

export function runtimeAllowed(name) {
  return /^(manifest\.json|background\.js|content\.js|LICENSE|THIRD_PARTY_NOTICES\.md|sidebar\/(index\.html|index\.js|style\.css)|_locales\/(en|de)\/messages\.json|assets\/icon-(16|32|48|96|128)\.png)$/.test(name);
}
const sourceRoots = new Set(['src', '_locales', 'assets', 'internal', 'tests']);
const sourceFiles = new Set(['README.md', 'CHANGELOG.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'manifest.json', '.gitignore']);
const excludedSourcePart = /^(?:\.git|\.hg|\.svn|node_modules|test-results|coverage|\.cache|dist|START\.txt|\.env.*)$/i;
export function sourceAllowed(name, dir) {
  const parts = name.split('/');
  if (parts.some(part => excludedSourcePart.test(part))) return false;
  if (/\.md$/i.test(name) && !publicDocumentAllowed(name)) return false;
  if (parts[0] === 'internal' && parts.length > 1
      && !['scripts', 'config'].includes(parts[1]) && !publicDocumentAllowed(name)) return false;
  if (dir) return sourceRoots.has(parts[0]);
  return sourceFiles.has(name) || (sourceRoots.has(parts[0]) && !/\.(zip|xpi|log)$/i.test(name));
}
export async function entriesFor(dir, filter, prefix = '') {
  const entries = {};
  for (const entry of await readdir(path.join(dir, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not packaged: ${name}`);
    if (entry.isDirectory()) {
      if (filter(name, true)) Object.assign(entries, await entriesFor(dir, filter, name));
    } else if (filter(name, false)) entries[name] = new Uint8Array(await readFile(path.join(dir, name)));
  }
  return entries;
}
export function archive(entries) {
  return zipSync(Object.fromEntries(Object.keys(entries).sort().map(name => [name, [entries[name], { mtime: new Date('1980-01-01T00:00:00Z') }]])), { level: 9 });
}
export async function packageExtension(output = artifactsRoot, runtimeDirectory = path.dirname(root)) {
  const artifacts = await resolveExternal(root, output);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const release = await resolveExternal(root, path.join(artifacts, 'releases', `v${manifest.version}`));
  // Validate the complete filename: the repository's parent is deliberately a
  // valid ZIP destination, but a file or junction inside the source is not.
  const runtimeFile = await resolveExternal(root, path.join(runtimeDirectory, `style-inspector-lite-${manifest.version}.zip`));
  const sourceFile = path.join(release, `style-inspector-lite-${manifest.version}-source.zip`);
  for (const file of [runtimeFile, sourceFile, path.join(release, 'SHA256SUMS'), path.join(release, 'build-metadata.json')]) {
    try { await lstat(file); throw new Error(`Preserving existing artifact: ${file}. Use separate --artifacts and --runtime-dir directories.`); }
    catch (err) { if (err.code !== 'ENOENT') throw err; }
  }
  const built = await buildExtension(path.join(artifacts, 'dist'));
  const runtime = await entriesFor(built, (name, dir) => dir || runtimeAllowed(name));
  const source = await entriesFor(root, sourceAllowed);
  if (!runtime['manifest.json'] || !source['package-lock.json']) throw new Error('Incomplete package');
  const files = [[runtimeFile, archive(runtime)], [sourceFile, archive(source)]];
  await mkdir(release, { recursive: true });
  await mkdir(path.dirname(runtimeFile), { recursive: true });
  const sums = [];
  for (const [file, bytes] of files) {
    const restored = unzipSync(bytes);
    if (file === runtimeFile) for (const item of Object.keys(restored)) if (!runtimeAllowed(item)) throw new Error(`Unexpected runtime file: ${item}`);
    await writeFile(file, bytes, { flag: 'wx' });
    sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${path.relative(release, file).split(path.sep).join('/')}`);
  }
  await writeFile(path.join(release, 'SHA256SUMS'), sums.join('\n') + '\n', { flag: 'wx' });
  await writeFile(path.join(release, 'build-metadata.json'), JSON.stringify({ version: manifest.version, source: 'local working tree; no commit provenance asserted', signed: false, published: false, runtimePackage: path.relative(release, runtimeFile).split(path.sep).join('/'), sourcePackage: path.basename(sourceFile), runtimeFileCount: Object.keys(runtime).length, sourceFileCount: Object.keys(source).length, node: process.version }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Add-on ZIP (unsigned): ${runtimeFile}\nSource ZIP and metadata: ${release}`);
  return release;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    const flag = process.argv[i], value = process.argv[i + 1];
    if (!['--artifacts', '--runtime-dir'].includes(flag) || !value || value.startsWith('--')) throw new Error('Usage: npm run package -- [--artifacts directory] [--runtime-dir directory]');
    options[flag] = value;
  }
  await packageExtension(options['--artifacts'], options['--runtime-dir']);
}
