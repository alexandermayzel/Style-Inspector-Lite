import { createServer } from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { root, buildDir, isInside } from '../../internal/scripts/paths.mjs';
export { root } from '../../internal/scripts/paths.mjs';

export async function resolveServedFile(requestPath, { runtimeRoot = buildDir, fixtureRoot = path.join(root, 'tests') } = {}) {
  // Preserve the request path until validation: URL() would normalize ../ before
  // we could reject it. /dist is only an HTTP alias for the external build.
  const pathname = decodeURIComponent(requestPath.split('?')[0]);
  const parts = pathname.split('/');
  if (!pathname.startsWith('/') || /[\\\0]/.test(pathname) || parts.some(part => part === '.' || part === '..')) throw new Error('Forbidden test path');
  const directory = parts[1] === 'dist' ? runtimeRoot : parts[1] === 'tests' ? fixtureRoot : null;
  if (!directory || parts.slice(2).some(part => part.includes(':'))) throw new Error('Forbidden test path');
  const base = await realpath(directory);
  const candidate = path.resolve(base, ...parts.slice(2));
  if (!isInside(base, candidate) || candidate === base) throw new Error('Forbidden test path');
  const resolved = await realpath(candidate);
  if (!isInside(base, resolved) || resolved === base) throw new Error('Forbidden test path');
  return resolved;
}

export async function serve() {
  const server = createServer(async (req, res) => {
    try {
      const file = await resolveServedFile(req.url);
      const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }[path.extname(file)] ?? 'text/plain';
      const bytes = await readFile(file);
      res.writeHead(200, { 'Content-Type': `${mime}; charset=utf-8`, 'Cache-Control': 'no-store' });
      res.end(bytes);
    } catch (error) { res.writeHead(error.message === 'Forbidden test path' ? 403 : 404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}
export const defaults = { schemaVersion: 1, appearance: 'system', colorFormat: 'hex', contrastTarget: 'AA', livePreview: true, contextMenuEnabled: true };
export function message(catalog, key, substitutions = []) {
  const entry = catalog[key]; if (!entry) return '';
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return entry.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '');
}
