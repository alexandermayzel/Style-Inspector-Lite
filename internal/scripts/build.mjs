import { build } from 'esbuild';
import sharp from 'sharp';
import { cp, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateProject } from './validate.mjs';
import { root, buildDir, isInside, resolveExternal } from './paths.mjs';

export { root } from './paths.mjs';
export async function buildExtension(output = buildDir) {
  await validateProject(root);
  const dist = await resolveExternal(root, output);
  // Check all output locations before the first write, including pre-existing
  // child links. A linked sidebar/assets directory must not redirect the build.
  const outputFiles = ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'background.js', 'content.js', 'sidebar/index.js', 'sidebar/index.html', 'sidebar/style.css', '_locales/en/messages.json', '_locales/de/messages.json', ...[16, 32, 48, 96, 128].map(size => `assets/icon-${size}.png`)];
  for (const file of outputFiles) {
    const resolved = await resolveExternal(root, path.join(dist, file));
    if (!isInside(dist, resolved) || resolved === dist) throw new Error(`Build output escapes its target directory: ${file}`);
  }
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(dist, 'sidebar'), { recursive: true });
  await build({
    absWorkingDir: root,
    entryPoints: { background: 'src/background.ts', content: 'src/content.ts', 'sidebar/index': 'src/sidebar/index.ts' },
    outdir: dist, bundle: true, platform: 'browser', format: 'iife',
    target: 'firefox142', minify: false, sourcemap: false, legalComments: 'inline',
    banner: { js: '/* Style Inspector Lite — MPL-2.0. See LICENSE and THIRD_PARTY_NOTICES.md. */' }
  });
  for (const file of ['manifest.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await cp(path.join(root, file), path.join(dist, file));
  }
  for (const locale of ['en', 'de']) {
    await mkdir(path.join(dist, '_locales', locale), { recursive: true });
    await cp(path.join(root, '_locales', locale, 'messages.json'), path.join(dist, '_locales', locale, 'messages.json'));
  }
  for (const file of ['index.html', 'style.css']) await cp(path.join(root, 'src/sidebar', file), path.join(dist, 'sidebar', file));
  // Exact circle crop from the approved 1254 × 1254 source. No recoloring/redrawing.
  // Crop bounds include the antialiased edge; the circular mask removes only the source backdrop.
  const source = path.join(root, 'assets/logo-source.png');
  const metadata = await sharp(source).metadata();
  if (metadata.width !== 1254 || metadata.height !== 1254) throw new Error('Approved logo dimensions changed; review crop coordinates.');
  const circle = Buffer.from('<svg width="700" height="700"><circle cx="350" cy="350" r="350" fill="white"/></svg>');
  const cropped = await sharp(source).extract({ left: 277, top: 200, width: 700, height: 700 })
    .ensureAlpha().composite([{ input: circle, blend: 'dest-in' }]).png().toBuffer();
  for (const size of [16, 32, 48, 96, 128]) {
    await sharp(cropped).resize(size, size, { kernel: 'lanczos3' }).png().toFile(path.join(dist, 'assets', `icon-${size}.png`));
  }
  console.log(`Built Style Inspector Lite ${(JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'))).version}: ${dist}`);
  return dist;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildExtension();
