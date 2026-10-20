import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
async function collect(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...await collect(p));
    else if (/\.test\.(?:mjs|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
const tests = await collect(path.join(root, 'tests'));
if (!tests.length) throw new Error('No tests found');
const run = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...tests.sort()], { cwd: root, stdio: 'inherit' });
process.exitCode = run.status ?? 1;
