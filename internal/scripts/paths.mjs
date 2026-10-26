import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = fileURLToPath(new URL('../../', import.meta.url));
export const artifactsRoot = path.resolve(process.env.ARTIFACTS_DIR || path.join(root, '../Style-Inspector-Lite-artifacts'));
export const buildDir = path.join(artifactsRoot, 'dist');

const publicDocuments = new Set([
  'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md',
  'internal/RELEASING.md', 'internal/VALIDATION.md', 'internal/MEASUREMENT.md', 'tests/fixtures/export/README.md'
]);
export function publicDocumentAllowed(name) {
  return publicDocuments.has(name);
}

export function isInside(rootPath, target) {
  const rel = path.relative(rootPath, target);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

/** Resolve existing ancestors and links before creating a new output path. */
export async function resolveExternal(repo, output) {
  const resolvedRepo = await realpath(repo);
  const absolute = path.resolve(output);
  let existing = absolute;
  const remaining = [];
  while (true) {
    try { await lstat(existing); break; } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      remaining.unshift(path.basename(existing));
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('No accessible parent for output');
      existing = parent;
    }
  }
  const resolved = path.join(await realpath(existing), ...remaining);
  if (isInside(resolvedRepo, resolved)) throw new Error('Artifact output must be outside the repository (including symlinks).');
  if (isInside(resolved, resolvedRepo)) throw new Error('Artifact output must not be an ancestor of the repository.');
  return resolved;
}
