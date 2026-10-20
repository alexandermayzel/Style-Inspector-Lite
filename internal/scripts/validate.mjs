import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { publicDocumentAllowed } from './paths.mjs';

export const categories = ['Security', 'Added', 'Fixed', 'Changed', 'Removed'];
export function fieldCounts(text) {
  const lf = text.replace(/\r\n?/g, '\n').replace(/\n*$/, '\n');
  const crlf = lf.replace(/\n/g, '\r\n');
  return { codepointsLF: [...lf].length, utf16LF: lf.length, codepointsCRLF: [...crlf].length, utf16CRLF: crlf.length };
}
export function checkField(text, label = 'AMO field') {
  const counts = fieldCounts(text);
  if (Math.max(...Object.values(counts)) > 3000) throw new Error(`${label}: over 3000 characters ${JSON.stringify(counts)}`);
  return counts;
}
export function nextWorkingVersion(current, publication, explicit) {
  if (explicit) return explicit;
  if (publication?.status !== 'published' || publication.version !== current) return current;
  const parts = current.split('.').map(Number); parts[2]++;
  return parts.join('.');
}
export async function validateProject(root) {
  const json = async file => JSON.parse(await readFile(path.join(root, file), 'utf8'));
  const [pkg, lock, manifest, en, de] = await Promise.all(['package.json', 'package-lock.json', 'manifest.json', '_locales/en/messages.json', '_locales/de/messages.json'].map(json));
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, manifest.version);
  assert.equal(lock.version, manifest.version);
  assert.equal(lock.packages[''].version, manifest.version);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.default_locale, 'en');
  assert.ok(Number.parseInt(manifest.browser_specific_settings.gecko.strict_min_version) >= 142);
  assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['none']);
  assert.ok(!manifest.action.default_popup && !manifest.background.service_worker && !manifest.host_permissions && !manifest.content_scripts);
  assert.deepEqual([...manifest.optional_permissions], ['downloads']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(Object.keys(en).sort(), Object.keys(de).sort(), 'Locale key parity');
  for (const [key, entry] of Object.entries(en)) {
    assert.ok(entry.message.trim() && de[key].message.trim(), `Empty locale: ${key}`);
    assert.deepEqual(Object.keys(entry.placeholders ?? {}).sort(), Object.keys(de[key].placeholders ?? {}).sort(), `Placeholders: ${key}`);
  }
  for (const [, key] of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)) assert.ok(en[key], `Missing manifest locale: ${key}`);
  async function inspect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', '.git', '.cache', 'test-results'].includes(entry.name)) continue;
      const relative = path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/');
      assert.ok(!/\.md$/i.test(entry.name) || publicDocumentAllowed(relative), `Unlisted documentation must remain outside the repository: ${relative}`);
      assert.ok(!/^README[._-]de(?:[._-]|$)/i.test(entry.name), 'Only English README');
      if (entry.isDirectory()) await inspect(path.join(dir, entry.name));
    }
  }
  await inspect(root);
  return { version: manifest.version, localeKeys: Object.keys(en).length };
}
