import { access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildExtension } from './build.mjs';
import { root, buildDir, resolveExternal } from './paths.mjs';

export async function runWebExt(mode, additional = []) {
  if (!['lint', 'run'].includes(mode)) throw new Error('Use web-ext.mjs lint or web-ext.mjs run.');
  if (additional.some(arg => /^(?:-s(?:=|$)|--source-dir(?:=|$)|--sourceDir(?:=|$))/.test(arg))) throw new Error('The extension source directory is managed by ARTIFACTS_DIR; do not override --source-dir.');
  const source = mode === 'run' ? await buildExtension() : await resolveExternal(root, buildDir);
  try { await access(path.join(source, 'manifest.json')); }
  catch { throw new Error(`Built manifest not found at ${path.join(source, 'manifest.json')}. Run npm run build first.`); }
  const command = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  const args = [command, mode, '--source-dir', source, ...(mode === 'lint' ? ['--warnings-as-errors'] : ['--no-reload']), ...additional];
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (status, signal) => signal ? reject(new Error(`web-ext stopped with signal ${signal}`)) : resolve(status ?? 1));
  });
  return code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runWebExt(process.argv[2], process.argv.slice(3));
}
