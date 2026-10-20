import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { archive, entriesFor, runtimeAllowed, sourceAllowed } from '../../internal/scripts/package.mjs';
import { root, buildDir, isInside, publicDocumentAllowed, resolveExternal } from '../../internal/scripts/paths.mjs';

// Run after building the external dist. This consumes the actual working tree; Git and private
// sibling instructions are intentionally not inputs. No browser or upload runs.
const argumentsList = process.argv.slice(2);
let offline = false, cache;
for (let i = 0; i < argumentsList.length; i++) {
  const argument = argumentsList[i];
  if (argument === '--offline') offline = true;
  else if (argument === '--cache') {
    cache = argumentsList[++i];
    if (!cache || !path.isAbsolute(cache)) throw new Error('--cache must be an absolute directory path.');
  } else throw new Error(`Unknown source-rebuild option: ${argument}`);
}
const npmCli = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
await access(npmCli);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const temporaryRoot = await realpath(tmpdir());
const prefix = 'sil-source-rebuild-';
await resolveExternal(root, path.join(temporaryRoot, prefix));
const temporary = await mkdtemp(path.join(temporaryRoot, prefix));
const resolvedTemporary = await realpath(temporary);
if (!isInside(temporaryRoot, resolvedTemporary) || resolvedTemporary === temporaryRoot || !path.basename(resolvedTemporary).startsWith(prefix)) throw new Error('Unsafe temporary workspace.');
await resolveExternal(root, resolvedTemporary);
const checkout = path.join(resolvedTemporary, 'source');
const isolatedArtifacts = path.join(resolvedTemporary, 'artifacts');
const report = { status: 'running', startedAt: new Date().toISOString(), node: process.version, offline, commands: [], source: 'current local working tree', privateExternalRulesRequired: false, temporaryWorkspaceRemoved: false };
let failure;

async function npm(args) {
  const command = ['npm', ...args];
  report.commands.push(command);
  console.log(`Source rebuild: ${command.join(' ')}`);
  // No shell: arguments (including paths with spaces) remain exact, and neither
  // batch quoting nor a second shell participates in filesystem operations.
  // Never inherit an artifact override that could rebuild into the real output.
  const env = { ...process.env, ARTIFACTS_DIR: isolatedArtifacts };
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
  env[pathKey] = `${path.dirname(process.execPath)}${path.delimiter}${env[pathKey] ?? ''}`;
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd: checkout, env, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command.join(' ')} failed (${signal ?? code}).`)));
  });
}
async function runtimeEntries(directory) {
  const entries = await entriesFor(directory, () => true);
  for (const name of Object.keys(entries)) if (!runtimeAllowed(name)) throw new Error(`Unexpected runtime artifact: ${name}`);
  if (!entries['manifest.json']) throw new Error(`Build manifest is missing from ${directory}. Build the external dist before running this test.`);
  return entries;
}

try {
  const original = await runtimeEntries(buildDir);
  const source = await entriesFor(root, sourceAllowed);
  for (const required of ['package.json', 'package-lock.json', 'manifest.json', 'internal/scripts/build.mjs']) if (!source[required]) throw new Error(`Incomplete source archive: ${required}`);
  for (const name of Object.keys(source)) {
    if (/\.md$/i.test(name) && !publicDocumentAllowed(name)) throw new Error(`Unlisted documentation in source archive: ${name}`);
    if (name.startsWith('internal/') && !/^internal\/(?:scripts|config)\//.test(name) && !publicDocumentAllowed(name)) throw new Error(`Unexpected internal file in source archive: ${name}`);
  }
  const bytes = archive(source);
  const archivePath = path.join(resolvedTemporary, 'working-source.zip');
  await writeFile(archivePath, bytes, { flag: 'wx' });
  report.sourceArchiveSha256 = sha256(bytes);
  report.sourceFileCount = Object.keys(source).length;
  await mkdir(checkout);
  await resolveExternal(checkout, isolatedArtifacts);
  const extracted = unzipSync(new Uint8Array(await readFile(archivePath)));
  for (const [name, contents] of Object.entries(extracted)) {
    if (!name || /[\\:\0]/.test(name) || name.split('/').some(segment => !segment || segment === '.' || segment === '..')) throw new Error(`Unsafe source archive entry: ${name}`);
    const target = path.resolve(checkout, ...name.split('/'));
    if (!isInside(checkout, target) || target === checkout) throw new Error(`Source archive entry escapes checkout: ${name}`);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: 'wx' });
  }
  const manifest = JSON.parse(await readFile(path.join(checkout, 'manifest.json'), 'utf8'));
  report.version = manifest.version;
  await npm(['ci', '--no-audit', '--no-fund', ...(offline ? ['--offline'] : []), ...(cache ? ['--cache', cache] : [])]);
  await npm(['run', 'build']);
  await npm(['run', 'typecheck']);
  const rebuilt = await runtimeEntries(path.join(isolatedArtifacts, 'dist'));
  const names = Object.keys(original).sort(), rebuiltNames = Object.keys(rebuilt).sort();
  if (JSON.stringify(names) !== JSON.stringify(rebuiltNames)) throw new Error('The clean rebuild has a different runtime file list.');
  report.runtimeFiles = names.map(name => ({ name, originalSha256: sha256(original[name]), rebuiltSha256: sha256(rebuilt[name]) }));
  const mismatches = report.runtimeFiles.filter(file => file.originalSha256 !== file.rebuiltSha256);
  if (mismatches.length) throw new Error(`Clean rebuild byte mismatch: ${mismatches.map(file => file.name).join(', ')}`);
  report.runtimeFileCount = names.length;
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = error instanceof Error ? error.message : String(error);
} finally {
  try {
    // Verify the final absolute target immediately before this recursive delete.
    // No paths are delegated to cmd.exe, and links cannot redirect the root.
    const stat = await lstat(temporary);
    const resolved = await realpath(temporary);
    if (stat.isSymbolicLink() || resolved !== resolvedTemporary || !isInside(temporaryRoot, resolved) || resolved === temporaryRoot || !path.basename(resolved).startsWith(prefix)) throw new Error('Refusing cleanup: temporary workspace path changed.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 });
    report.temporaryWorkspaceRemoved = true;
  } catch (error) {
    failure ??= error;
    report.status = 'failed';
    report.cleanupError = error instanceof Error ? error.message : String(error);
    report.temporaryWorkspace = temporary;
  }
  report.completedAt = new Date().toISOString();
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/source-rebuild.json'), JSON.stringify(report, null, 2) + '\n');
}
if (failure) throw failure;
console.log(`Clean source archive rebuilt successfully: ${report.runtimeFileCount} identical runtime files.`);
