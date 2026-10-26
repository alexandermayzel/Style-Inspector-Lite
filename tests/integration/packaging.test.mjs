import test from 'node:test';
import assert from 'node:assert/strict';
import { access, lstat, mkdtemp, mkdir, readFile, realpath, rm, writeFile, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { archive, entriesFor, resolveExternal, runtimeAllowed, sourceAllowed } from '../../internal/scripts/package.mjs';
import { checkField, nextWorkingVersion } from '../../internal/scripts/validate.mjs';
import { buildExtension } from '../../internal/scripts/build.mjs';
import { root, isInside } from '../../internal/scripts/paths.mjs';
import { resolveServedFile } from '../e2e/support.mjs';

async function removeFixture(directory) {
  const resolved = await realpath(directory), temporaryRoot = await realpath(os.tmpdir());
  assert.ok(!(await lstat(directory)).isSymbolicLink() && isInside(temporaryRoot, resolved) && resolved !== temporaryRoot && path.basename(resolved).startsWith('sil-'), 'Refusing unsafe fixture cleanup');
  await rm(resolved, { recursive: true, force: true });
}

test('AMO fields count CRLF, final newline, codepoints and UTF-16 independently', () => {
  assert.equal(checkField('a'.repeat(2998)).utf16CRLF, 3000);
  assert.throws(() => checkField('a'.repeat(2999)), /3000/);
  assert.throws(() => checkField('a'.repeat(3000)), /3000/);
  assert.throws(() => checkField('a'.repeat(3001)), /3000/);
  assert.deepEqual(checkField('ä\n😀'), { codepointsLF: 4, utf16LF: 5, codepointsCRLF: 6, utf16CRLF: 7 });
});
test('only a confirmed publication advances a matching working version once', () => {
  for (const status of ['draft', 'signed', 'unknown']) assert.equal(nextWorkingVersion('1.0.0', { status, version: '1.0.0' }), '1.0.0');
  assert.equal(nextWorkingVersion('1.0.0', { status: 'published', version: '1.0.0' }), '1.0.1');
  assert.equal(nextWorkingVersion('1.0.1', { status: 'published', version: '1.0.0' }), '1.0.1');
  assert.equal(nextWorkingVersion('1.0.0', { status: 'published', version: '1.0.0' }, '1.1.0'), '1.1.0');
});
test('external artifacts reject internal paths, ancestors and junctions into the repository', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sil-path-test-'));
  try {
    const repo = path.join(temp, 'repo'); await mkdir(repo);
    assert.equal(await resolveExternal(repo, path.join(temp, 'artifacts')), path.join(temp, 'artifacts'));
    await assert.rejects(resolveExternal(repo, path.join(repo, 'dist')), /outside/);
    await assert.rejects(resolveExternal(repo, temp), /ancestor/);
    const junction = path.join(temp, 'link');
    await symlink(repo, junction, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveExternal(repo, path.join(junction, 'hidden')), /outside/);
  } finally { await removeFixture(temp); }
});

test('build rejects repository outputs and escaping child junctions before writing runtime files', async () => {
  await assert.rejects(buildExtension(root), /outside/);
  await assert.rejects(buildExtension(path.join(root, 'dist')), /outside/);
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sil-build-path-test-'));
  try {
    const output = path.join(temp, 'dist'); await mkdir(output);
    const redirect = path.join(temp, 'unrelated'); await mkdir(redirect);
    await writeFile(path.join(redirect, 'preserve.txt'), 'preserved');
    await symlink(redirect, path.join(output, 'assets'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildExtension(output), /escapes its target/);
    await assert.rejects(access(path.join(output, 'background.js')), { code: 'ENOENT' });
    assert.equal(await readFile(path.join(redirect, 'preserve.txt'), 'utf8'), 'preserved');
  } finally { await removeFixture(temp); }
});

test('UI fixture routing maps external runtime files and rejects traversal or escaping junctions', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sil-route-test-'));
  try {
    const runtimeRoot = path.join(temp, 'dist'), fixtureRoot = path.join(temp, 'tests'), outside = path.join(temp, 'dist-neighbor');
    for (const directory of [runtimeRoot, fixtureRoot, outside]) await mkdir(directory);
    await writeFile(path.join(runtimeRoot, 'content.js'), 'runtime');
    await writeFile(path.join(fixtureRoot, 'page.html'), 'fixture');
    await writeFile(path.join(outside, 'private.txt'), 'private');
    const routes = { runtimeRoot, fixtureRoot };
    assert.equal(await resolveServedFile('/dist/content.js?cache=1', routes), await realpath(path.join(runtimeRoot, 'content.js')));
    assert.equal(await resolveServedFile('/tests/page.html', routes), await realpath(path.join(fixtureRoot, 'page.html')));
    for (const request of ['/dist/../dist-neighbor/private.txt', '/dist/%2e%2e/dist-neighbor/private.txt', '/dist/%5c..%5cdist-neighbor%5cprivate.txt', '/dist/C:/private.txt', '/tests/../../private.txt', '/README.md']) {
      await assert.rejects(resolveServedFile(request, routes), /Forbidden/);
    }
    await symlink(outside, path.join(runtimeRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(resolveServedFile('/dist/escape/private.txt', routes), /Forbidden/);
  } finally { await removeFixture(temp); }
});
test('runtime allowlist excludes bait files and produces deterministic portable ZIP paths', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sil-zip-test-'));
  try {
    await mkdir(path.join(temp, 'tests'));
    await mkdir(path.join(temp, '_locales/en'), { recursive: true });
    await writeFile(path.join(temp, 'manifest.json'), '{}');
    await writeFile(path.join(temp, '_locales/en/messages.json'), '{}');
    await writeFile(path.join(temp, 'tests/secret.txt'), 'must not ship');
    await writeFile(path.join(temp, 'maintainer-notes.md'), 'private');
    const entries = await entriesFor(temp, (name, dir) => dir || runtimeAllowed(name));
    const bytes = archive(entries);
    assert.deepEqual(bytes, archive(entries));
    assert.deepEqual(Object.keys(unzipSync(bytes)).sort(), ['_locales/en/messages.json', 'manifest.json']);
  } finally { await removeFixture(temp); }
});

test('source archive excludes nested metadata, generated files and case-varied private files', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'sil-source-filter-test-'));
  try {
    const included = ['package.json', 'README.md', 'THIRD_PARTY_NOTICES.md', 'src/content.ts',
      'internal/scripts/build.mjs', 'internal/config/tsconfig.json', 'internal/RELEASING.md',
      'internal/VALIDATION.md', 'internal/MEASUREMENT.md', 'tests/fixtures/page.html', 'tests/fixtures/export/README.md',
      'tests/fixtures/export/style-inspector-lite-element-all.tailwind.txt'];
    const excluded = ['internal/.git/config', 'internal/coverage/report.html', 'tests/test-results/trace.json',
      'src/node_modules/dependency/index.js', 'internal/.ENV.local', 'internal/MAINTAINER.override.MD',
      'internal/START.TXT', 'tests/notes.ZIP', 'assets/old.XPI', 'internal/debug.LOG',
      'internal/spec/requirements.md', 'internal/spec/private.json', 'internal/spec/fixture.ts',
      'internal/SPEC/private.json', 'src/private-notes.MD', 'internal/scripts/private-notes.md',
      'tests/fixtures/PRIVATE.md', 'README.private.md'];
    for (const name of [...included, ...excluded]) {
      await mkdir(path.dirname(path.join(temp, name)), { recursive: true });
      await writeFile(path.join(temp, name), included.includes(name) ? 'source' : 'must not ship');
    }
    const entries = await entriesFor(temp, sourceAllowed);
    assert.deepEqual(Object.keys(unzipSync(archive(entries))).sort(), included.sort());
  } finally { await removeFixture(temp); }
});
