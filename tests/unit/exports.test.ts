import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileString } from 'sass';
import { compile } from '@tailwindcss/node';
import { parseColor } from '../../src/core/colors';
import { contrastRatio } from '../../src/core/contrast';
import { safeValue, serializeColorVariables, serializeExport } from '../../src/core/exports';
import { suggestContrast } from '../../src/core/suggestions';
import type { ExportFormat, ExportSource } from '../../src/core/types';
import { fixtureAudit, fixtureRun, fixtureSnapshot } from '../fixtures/export/data';

const options = (format: ExportFormat) => ({ format, version: '1.0.0' });
test('page token exports explicitly choose the measured overview or legacy element CSS without private references', () => {
  const audit = fixtureAudit();
  audit.palette = [parseColor('#000000')]; audit.fonts = ['Arial, sans-serif'];
  audit.paletteUsage = [{ color: parseColor('#ff0000'), count: 1, roles: { text: 1 }, elementRefs: ['PRIVATE_REF'] }, { color: parseColor('#ffffff'), count: 1, roles: { background: 1 } }];
  audit.fontUsage = [{ family: 'Georgia, serif', count: 1, sizes: [{ sizeCssPx: 16, count: 1 }], elementRefs: ['PRIVATE_REF'] }];
  const before = structuredClone(audit), source = { kind: 'page-tokens' as const, audit };
  const raw = JSON.parse(serializeExport(source, options('json')).text);
  assert.deepEqual(raw.generatedTokens.map((token: { value: string }) => token.value), ['#000000', 'Arial, sans-serif']);
  assert.equal(raw.inventory, undefined, 'Callers without an explicit basis keep the existing format');
  for (const inventory of ['measured', 'css'] as const) for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const output = serializeExport(source, { ...options(format), inventory });
    assert.doesNotMatch(output.text, /PRIVATE_REF|elementRefs|textExcerpt/);
    if (inventory === 'measured') { assert.match(output.text, /#FF0000/); assert.match(output.text, /#FFFFFF/); assert.match(output.text, /Georgia/); assert.doesNotMatch(output.text, /Arial/); }
    else { assert.match(output.text, /#000000/); assert.match(output.text, /Arial/); assert.doesNotMatch(output.text, /Georgia/); }
    if (format === 'json') assert.equal(JSON.parse(output.text).inventory, inventory);
    else assert.match(output.text, inventory === 'measured' ? /Inventory: page overview/ : /Inventory: raw element CSS/);
  }
  assert.deepEqual(audit, before);
  audit.fontUsage.push({ family: 'Unsafe; injected {}', count: 1, sizes: [] });
  audit.paletteUsage.push({ color: { raw: 'unsafe', rgba: null }, count: 1, roles: {} });
  const safe = serializeExport(source, { ...options('css'), inventory: 'measured' });
  assert.doesNotMatch(safe.text, /injected/);
  assert.deepEqual(safe.warnings.map(warning => warning.code).sort(), ['unsupported-font-family', 'unsupported-palette-color']);
  assert.throws(() => serializeExport(source, { ...options('css'), inventory: 'unsupported' as 'css' }), /unsupported-export-inventory/);
});
test('exports retain bounded inventory and viewport scope metadata without unknown fields', () => {
  const audit = fixtureAudit();
  Object.assign(audit, { scope: 'viewport', scopeViewport: { left: 2, top: 50, width: 1200, height: 800, private: 'PRIVATE_SCOPE' },
    inventoryLimits: { maxColors: 128, maxFontFamilies: 64, maxFontSizes: 1000, maxFontVariants: 1000, maxElements: 1000,
      reached: ['colors', 'colors', 'font-variants', 'PRIVATE_LIMIT'], private: 'PRIVATE_FIELD' } });
  for (const kind of ['audit', 'page-tokens'] as const) {
    const output = serializeExport({ kind, audit }, options('json')), data = JSON.parse(output.text);
    assert.deepEqual(data.metadata.scopeViewport, { left: 2, top: 50, width: 1200, height: 800 });
    assert.deepEqual(data.metadata.inventoryLimits, { maxColors: 128, maxFontFamilies: 64, maxFontSizes: 1000, maxFontVariants: 1000, maxElements: 1000, reached: ['colors', 'font-variants'] });
    assert.ok(output.warnings.some(item => item.code === 'partial-style-inventory'));
    assert.doesNotMatch(output.text, /PRIVATE_/);
  }
  assert.match(serializeExport({ kind: 'page-tokens', audit }, options('css')).text, /partial-style-inventory/);
  Object.assign(audit.inventoryLimits!, { maxColors: -1 }); Object.assign(audit.scopeViewport!, { top: NaN });
  const invalid = JSON.parse(serializeExport({ kind: 'audit', audit }, options('json')).text);
  assert.equal('inventoryLimits' in invalid.metadata, false); assert.equal('scopeViewport' in invalid.metadata, false);
  const legacy = JSON.parse(serializeExport({ kind: 'audit', audit: fixtureAudit() }, options('json')).text);
  assert.equal('inventoryLimits' in legacy.metadata, false); assert.equal('scopeViewport' in legacy.metadata, false);
});
test('non-JSON page-token exports identify the measured scope and completion state', () => {
  const audit = fixtureAudit();
  audit.rootElementRef = 'PRIVATE_SECTION_REF'; audit.status = 'partial';
  for (const [scope, label] of [['page', 'whole page'], ['viewport', 'initial visible area'], ['selection', 'selected section']] as const) {
    audit.scope = scope;
    for (const format of ['css', 'scss', 'tailwind'] as const) {
      const text = serializeExport({ kind: 'page-tokens', audit }, options(format)).text;
      assert.ok(text.includes(`Audit scope: ${label}; audit status: partial.`));
      assert.doesNotMatch(text, /PRIVATE_SECTION_REF|rootElementRef/);
    }
  }
  assert.doesNotMatch(serializeExport({ kind: 'page-tokens', audit: fixtureAudit() }, options('css')).text, /Audit scope:/, 'Legacy results must not invent a measured scope');
  Object.assign(audit, { scope: '*/ UNSAFE', status: '*/ UNSAFE' });
  assert.doesNotMatch(serializeExport({ kind: 'page-tokens', audit }, options('css')).text, /UNSAFE/);
});
test('scoped audit and page-token reports retain completion metadata without private root references', () => {
  const audit = fixtureAudit();
  Object.assign(audit, { scope: 'selection', durationMs: 34.5, examined: 48,
    limits: { maxRuns: 1000, maxElements: 20000 }, reachedLimits: ['text-runs'], rootElementRef: 'PRIVATE_SECTION_REF' });
  for (const kind of ['audit', 'page-tokens'] as const) {
    const result = serializeExport({ kind, audit }, options('json'));
    const data = JSON.parse(result.text);
    assert.equal(data.metadata.scope, 'selection');
    assert.equal(data.metadata.durationMs, 34.5);
    assert.equal(data.metadata.examined, 48);
    assert.deepEqual(data.metadata.limits, { maxRuns: 1000, maxElements: 20000 });
    assert.deepEqual(data.metadata.reachedLimits, ['text-runs']);
    assert.doesNotMatch(result.text, /PRIVATE_SECTION_REF|rootElementRef/);
  }
  const legacy = JSON.parse(serializeExport({ kind: 'audit', audit: fixtureAudit() }, options('json')).text);
  assert.equal('scope' in legacy.metadata, false, 'An old snapshot must not invent its scan scope or duration');
  assert.equal('durationMs' in legacy.metadata, false);
  Object.assign(audit, { scope: 'INVALID_SCOPE', durationMs: NaN, examined: -1,
    limits: { maxRuns: -10, maxElements: Infinity }, reachedLimits: ['elements', 'elements', 'PRIVATE_REASON'] });
  const invalid = serializeExport({ kind: 'audit', audit }, options('json'));
  const metadata = JSON.parse(invalid.text).metadata;
  assert.equal('scope' in metadata, false); assert.equal('durationMs' in metadata, false);
  assert.equal('examined' in metadata, false); assert.equal('limits' in metadata, false);
  assert.deepEqual(metadata.reachedLimits, ['elements']);
  assert.doesNotMatch(invalid.text, /PRIVATE_|INVALID_SCOPE/);
});
test('audit JSON distinguishes a visible-fragment measurement without exposing fragment geometry', () => {
  const audit = fixtureAudit(); audit.scope = 'viewport'; audit.runs[0]!.viewportPartial = true;
  const parsed = JSON.parse(serializeExport({ kind: 'audit', audit }, options('json')).text);
  assert.equal(parsed.textRuns[0].viewportPartial, true);
  assert.equal('rects' in parsed.textRuns[0], false);
  Object.assign(audit.runs[0]!, { viewportPartial: 'PRIVATE_SCOPE' });
  assert.doesNotMatch(serializeExport({ kind: 'audit', audit }, options('json')).text, /PRIVATE_SCOPE|viewportPartial/);
});
test('explicit diagnostic text stays out of all standard export sources and formats', () => {
  const snapshot = fixtureSnapshot();
  snapshot.textExcerpt = { value: 'EXCERPT_ROOT_PRIVATE', truncated: false };
  snapshot.textRuns[0]!.textExcerpt = { value: 'EXCERPT_RUN_PRIVATE', truncated: false };
  const audit = fixtureAudit(snapshot.textRuns);
  const suggestion = suggestContrast(snapshot, snapshot.textRuns[0]!, 'AA').suggestions[0]!;
  for (const source of [{ kind: 'element', snapshot }, { kind: 'audit', audit }, { kind: 'page-tokens', audit }, { kind: 'contrast-suggestion', snapshot, suggestion }] as ExportSource[]) {
    for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
      if (source.kind === 'audit' && format !== 'json') continue;
      assert.doesNotMatch(serializeExport(source, options(format)).text, /EXCERPT_|textExcerpt/);
    }
  }
  assert.doesNotMatch(serializeColorVariables(snapshot), /EXCERPT_|textExcerpt/);
});
test('gradient exports preserve lower bounds and independent ratings without invented backgrounds or suggestions', () => {
  const run = fixtureRun('#666666', 'transparent', 16);
  run.effectiveBackground = null;
  run.backgroundRange = { min: parseColor('#eee').rgba!, max: parseColor('#fff').rgba! };
  const snapshot = fixtureSnapshot(run);
  for (const source of [{ kind: 'element', snapshot }, { kind: 'audit', audit: fixtureAudit([run]) }] as const) {
    for (const target of ['AA', 'AAA'] as const) {
      const json = JSON.parse(serializeExport(source, { ...options('json'), target }).text);
      assert.deepEqual(json.textRuns[0].backgroundRange, run.backgroundRange);
      assert.equal(json.textRuns[0].effectiveBackground, null);
      assert.equal(json.textRuns[0].contrast.ratioKind, 'minimum');
      assert.equal(json.textRuns[0].contrast.AA.status, 'pass');
      assert.equal(json.textRuns[0].contrast.AAA.status, 'manual');
      assert.equal(json.textRuns[0].contrast.status, target === 'AA' ? 'pass' : 'manual');
      if (source.kind === 'audit') {
        assert.equal(json.counts.contrast.fail, 0);
        assert.equal(json.counts.contrast.manual, target === 'AAA' ? 1 : 0);
      }
    }
  }
  const css = serializeExport({ kind: 'element', snapshot }, options('css')).text;
  assert.match(css, /background-color: #00000000/);
  assert.doesNotMatch(css, /#EEEEEE|#FFFFFF|backgroundRange/);
  const original = fixtureSnapshot();
  const suggestion = suggestContrast(original, original.textRuns[0], 'AA').suggestions[0]!;
  // Even an inconsistent payload retaining a flat background must not make a
  // gradient recommendation eligible for a one-property solid-color export.
  original.textRuns[0].backgroundRange = run.backgroundRange;
  for (const property of ['color', 'background-color'] as const) {
    assert.equal(suggestContrast(original, original.textRuns[0], 'AA', property).reason, 'unsupported-suggestion');
  }
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    assert.throws(() => serializeExport({ kind: 'contrast-suggestion', snapshot: original, suggestion }, options(format)), /invalid-suggestion-context/);
  }
});

test('all original formats are deterministic, preserve measured widths and exclude private identifiers', () => {
  const source: ExportSource = { kind: 'element', snapshot: fixtureSnapshot() };
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const result = serializeExport(source, options(format));
    assert.deepEqual(result, serializeExport(source, options(format)));
    assert.doesNotMatch(result.text, /private-|200px/);
    if (format !== 'json') assert.match(result.text, /160px/);
    if (format === 'scss') {
      assert.match(result.text, /\$sil-color: #AAAAAA;/);
      const compiledColor = /^\s*color:\s*([^;]+);/m.exec(compileString(result.text).css);
      assert.ok(compiledColor); assert.deepEqual(parseColor(compiledColor[1]).rgba, parseColor('#aaa').rgba);
    }
    if (format === 'json') {
      const data = JSON.parse(result.text); assert.equal(data.schemaVersion, 2); assert.equal(data.kind, 'element');
      const foreground = data.styles.find((d: { property: string }) => d.property === 'color');
      assert.equal(foreground.raw, '#aaaaaa'); assert.equal(foreground.formatted, '#AAAAAA');
      assert.equal(data.styles.find((d: { property: string }) => d.property === 'width').raw, '160px');
      assert.equal(data.visualRect.width, 200); assert.equal(data.textRuns[0].fontSize.normative, false);
    }
  }
});
test('property allowlist and separate language contexts reject imports, URLs, Sass and declaration injection', () => {
  const malicious = ['red; background: url(https://example.invalid)', 'red} @import "bad"; /*', '#{evil()}', 'url(https://example.invalid)', 'var(--secret)', 'red\\3b background:blue', '"#{1+1}"', 'rgb(0 0 0);color:red'];
  for (const value of malicious) for (const property of ['color', 'font-family', 'width']) assert.equal(safeValue(property, value), false);
  const snapshot = fixtureSnapshot();
  snapshot.styles.colors.color = 'red; background: url(https://example.invalid)';
  snapshot.styles.typography['font-family'] = '"#{evil()}"';
  snapshot.styles.layout['--evil'] = 'red'; snapshot.styles.layout['background-image'] = 'url(https://example.invalid)';
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const result = serializeExport({ kind: 'element', snapshot }, options(format));
    assert.doesNotMatch(result.text, /evil\(|example\.invalid|#\{|background-image:/);
    assert.ok(result.warnings.length >= 4);
    if (format === 'scss') compileString(result.text);
  }
  assert.throws(() => serializeExport({ kind: 'element', snapshot }, { ...options('css'), className: 'x} body {' }), /invalid-export-class/);
  assert.equal(safeValue('padding-top', '-1px'), false);
  assert.equal(safeValue('width', '4'), false);
  assert.equal(safeValue('width', 'normal'), false);
  assert.equal(safeValue('line-height', '1.5'), true);
});
test('second fixture preserves alpha, negative margins, unequal padding and Unicode fonts', async () => {
  const snapshot = fixtureSnapshot(fixtureRun('rgb(12.5 34.25 56.125 / .123456789)', '#fff', 12.5));
  snapshot.styles.typography['font-family'] = '"Schöne Schrift", sans-serif';
  Object.assign(snapshot.styles.layout, { 'margin-left': '-3.25px', 'padding-top': '7.5px', 'padding-right': '19px', 'border-top-left-radius': '12px 6px' });
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const result = serializeExport({ kind: 'element', snapshot }, options(format));
    assert.match(result.text, /123456789/); assert.match(result.text, /-3\.25px/); assert.match(result.text, /Schöne/);
    assert.ok(result.warnings.some(w => w.code === 'precise-color-fallback'));
    if (format === 'scss') assert.match(compileString(result.text).css, /margin-left: -3\.25px/);
    if (format === 'tailwind') {
      const compiler = await compile('@import "tailwindcss";\n@theme { --spacing: 37px; }', { base: process.cwd(), onDependency: () => {} });
      const css = compiler.build(result.classes!.split(' '));
      assert.match(css, /padding-top: 7\.5px/); assert.match(css, /border-top-left-radius: 12px 6px/);
    }
  }
  const variables = serializeColorVariables(snapshot);
  assert.match(variables, /--sil-color-001:/); assert.match(variables, /--sil-color-002:/);
  assert.match(variables, /not original design tokens/); assert.doesNotMatch(variables, /\.sil-inspected-element/);
});
test('SCSS preserves family names that Sass would otherwise evaluate as expressions', () => {
  for (const family of ['null', 'Alpha or Beta', 'Alpha and Beta', 'not Helvetica', 'red', 'Roboto']) {
    const snapshot = fixtureSnapshot();
    const font = `${family}, sans-serif`;
    snapshot.styles.typography['font-family'] = font;
    assert.equal(safeValue('font-family', font), true);
    const element = serializeExport({ kind: 'element', snapshot }, options('scss'));
    const audit = fixtureAudit(); audit.fonts = [font];
    const tokens = serializeExport({ kind: 'page-tokens', audit }, options('scss'));
    for (const style of ['expanded', 'compressed'] as const) {
      const css = compileString(element.text, { style }).css;
      const tokenCSS = compileString(tokens.text + '\n.example { font-family: $sil-font-001; }', { style }).css;
      for (const compiled of [css, tokenCSS]) assert.match(compiled, new RegExp(`font-family:\\s*"${family}",\\s*sans-serif`));
    }
    const css = serializeExport({ kind: 'element', snapshot }, options('css'));
    assert.ok(css.text.includes(`font-family: ${font};`));
    const json = JSON.parse(serializeExport({ kind: 'element', snapshot }, options('json')).text);
    assert.equal(json.styles.find((d: { property: string }) => d.property === 'font-family').raw, font);
  }
  const snapshot = fixtureSnapshot();
  snapshot.styles.typography['font-family'] = 'ui-serif, system-ui, sans-serif';
  assert.match(compileString(serializeExport({ kind: 'element', snapshot }, options('scss')).text).css, /font-family: ui-serif, system-ui, sans-serif/);
});

test('HSL exports keep near-black and near-white measured colors valid', () => {
  for (const raw of ['rgb(0 0 1e-14)', 'rgb(255 254.99999999999997 255)']) {
    const snapshot = fixtureSnapshot(fixtureRun(raw));
    const json = JSON.parse(serializeExport({ kind: 'element', snapshot }, { ...options('json'), colorFormat: 'hsl' }).text);
    const declaration = json.styles.find((d: { property: string }) => d.property === 'color');
    assert.equal(declaration.raw, raw);
    assert.ok(parseColor(declaration.formatted).rgba);
    for (const format of ['css', 'scss', 'tailwind'] as const) {
      const result = serializeExport({ kind: 'element', snapshot }, { ...options(format), colorFormat: 'hsl' });
      assert.doesNotMatch(result.text, /Infinity|NaN/);
      if (format === 'scss') compileString(result.text);
    }
  }
});

test('page tokens deduplicate colors, use generated names and compile as Sass and Tailwind v4', async () => {
  const source: ExportSource = { kind: 'page-tokens', audit: fixtureAudit() };
  const json = JSON.parse(serializeExport(source, options('json')).text);
  assert.equal(json.generatedTokens.length, 3); assert.ok(json.generatedTokens.every((t: { origin: string }) => t.origin === 'generated'));
  const scss = serializeExport(source, options('scss')); compileString(scss.text);
  const theme = serializeExport(source, options('tailwind'));
  assert.ok(theme.filename.endsWith('.theme.css')); assert.match(theme.text, /@theme static/);
  assert.doesNotMatch(theme.text, /--\*:|--color-\*:/);
  const compiler = await compile(`@import "tailwindcss";\n${theme.text}`, { base: process.cwd(), onDependency: () => {} });
  const css = compiler.build(['bg-sil-001', 'font-sil-001']);
  assert.match(css, /--color-sil-001:/); assert.match(css, /--font-sil-001:/); assert.match(css, /\.bg-sil-001/);
});
test('Tailwind v4 compiles every emitted element utility with exact decimals and quoted font families', async () => {
  const snapshot = fixtureSnapshot(); snapshot.styles.typography['font-family'] = '"Example_Sans Font", sans-serif';
  snapshot.styles.layout['padding-top'] = '12.5px';
  const result = serializeExport({ kind: 'element', snapshot }, options('tailwind'));
  assert.ok(result.filename.endsWith('.tailwind.txt')); assert.ok(result.classes); assert.doesNotMatch(result.classes!, /p-4|blue-600/);
  const compiler = await compile('@import "tailwindcss";', { base: process.cwd(), onDependency: () => {} });
  const css = compiler.build(result.classes!.split(' '));
  assert.match(css, /padding-top: 12\.5px/); assert.match(css, /font-size: 11\.99px/);
  assert.match(css, /Example_Sans Font/);
  for (const candidate of result.classes!.split(' ')) {
    const isolated = await compile('@tailwind utilities;', { base: process.cwd(), onDependency: () => {} });
    assert.ok(isolated.build([candidate]).includes('{'), `Tailwind rejected ${candidate}`);
  }
});
test('audit exports both independent rule groups, fresh target counters, null unknowns and no private data', () => {
  const audit = fixtureAudit([fixtureRun(), fixtureRun('#777', '#fff', 24)]);
  audit.runs[0].reasons = ['background-image']; audit.status = 'partial'; audit.stale = true;
  const result = serializeExport({ kind: 'audit', audit }, { ...options('json'), target: 'AAA' });
  const json = JSON.parse(result.text);
  assert.equal(json.target, 'AAA'); assert.equal(json.counts.contrast.manual, 1); assert.equal(json.counts.contrast.fail, 1);
  assert.equal(json.counts.fontSize.fail, 1); assert.equal(json.textRuns[0].contrast.ratio, null);
  assert.equal(json.ruleDefinitions[1].thresholdCssPx, 12); assert.equal(json.ruleDefinitions[1].normative, false);
  assert.equal(json.metadata.scanStatus, 'partial'); assert.equal(json.metadata.stale, true);
  assert.doesNotMatch(result.text, /private-|documentToken|windowId|tabId|selector/);
  assert.throws(() => serializeExport({ kind: 'audit', audit }, options('css')), /audit-requires-json/);
  const broken = fixtureSnapshot(); broken.viewport.width = NaN;
  assert.throws(() => serializeExport({ kind: 'element', snapshot: broken }, options('json')), /non-finite/);
});
test('suggestion exports change one property, remain separate from originals, and reverify serialized colors', async () => {
  const snapshot = fixtureSnapshot(), before = serializeExport({ kind: 'element', snapshot }, options('css'));
  const suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const result = serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, options(format));
    assert.match(result.filename, /contrast-suggestion/);
    assert.doesNotMatch(result.text, /background-color:/);
    if (format === 'scss') compileString(result.text);
    if (format === 'tailwind') {
      const compiler = await compile('@tailwind utilities;', { base: process.cwd(), onDependency: () => {} });
      assert.match(compiler.build(result.classes!.split(' ')), /color:/);
    }
    if (format === 'json') {
      const json = JSON.parse(result.text); assert.equal(json.applied, false); assert.equal(json.kind, 'contrast-suggestion');
      assert.equal(json.schemaVersion, 2); assert.ok(contrastRatio(parseColor(json.newValue).rgba!, json.originalBackground) >= json.threshold);
    }
  }
  assert.deepEqual(before, serializeExport({ kind: 'element', snapshot }, options('css')));
  assert.throws(() => serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion: { ...suggestion, newValue: '#fff' } }, options('css')), /below-target/);
  for (const property of ['-webkit-text-fill-color', 'color; background-image:url(https://invalid.example)', '__proto__']) {
    assert.throws(() => serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion: { ...suggestion, property: property as typeof suggestion.property } }, options('css')), /invalid-suggestion-property/);
  }
  assert.throws(() => serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, { ...options('css'), target: 'AAA' }), /stale-suggestion/);
});
test('suggestion RGB/HSL and both change sides retain the fixed color and final promised target', () => {
  for (const pair of [['#333', '#000'], ['#aaa', '#fff']] as const) for (const property of ['color', 'background-color'] as const) {
    const snapshot = fixtureSnapshot(fixtureRun(...pair));
    const suggestions = suggestContrast(snapshot, snapshot.textRuns[0], 'AA', property, [parseColor('rgb(3.123456789012345 4.25 5.5)')]).suggestions;
    for (const suggestion of suggestions) for (const colorFormat of ['hex', 'rgb', 'hsl'] as const) {
      const result = serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, { ...options('json'), colorFormat });
      const json = JSON.parse(result.text), changed = parseColor(json.newValue).rgba!;
      assert.ok(contrastRatio(property === 'color' ? changed : json.originalForeground, property === 'color' ? json.originalBackground : changed) >= json.threshold);
      assert.deepEqual(json.originalForeground, snapshot.textRuns[0].foreground.rgba);
      assert.deepEqual(json.originalBackground, snapshot.textRuns[0].effectiveBackground);
    }
  }
});
test('placeholder measurements retain their source and cannot export element-color suggestions', () => {
  const snapshot = fixtureSnapshot();
  const suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
  snapshot.textRuns[0].textSource = 'placeholder';
  for (const property of ['color', 'background-color'] as const) {
    assert.equal(suggestContrast(snapshot, snapshot.textRuns[0], 'AA', property).reason, 'unsupported-suggestion');
  }
  const json = JSON.parse(serializeExport({ kind: 'element', snapshot }, options('json')).text);
  assert.equal(json.textRuns[0].textSource, 'placeholder');
  for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    assert.throws(() => serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, options(format)), /invalid-suggestion-context/);
  }
});

test('foreground suggestion exports explicitly reset every observed fill using current measurement evidence', async () => {
  for (const metadata of [{ textFillPresent: true }, { textFillPresent: true, foregroundSource: 'text-fill' as const }, { foregroundSource: 'text-fill' as const }]) {
    const snapshot = fixtureSnapshot(fixtureRun('#777', '#fff', 16));
    Object.assign(snapshot.textRuns[0], metadata);
    const suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
    suggestion.conditions = []; // Caller metadata cannot suppress the required reset.
    const source = { kind: 'contrast-suggestion' as const, snapshot, suggestion };
    const json = JSON.parse(serializeExport(source, options('json')).text);
    assert.deepEqual(json.additionalDeclarations, [{ property: '-webkit-text-fill-color', value: 'currentColor' }]);
    assert.equal(json.conditions.includes('text-fill-reset-to-currentcolor'), true);
    assert.ok(contrastRatio(parseColor(json.newValue).rgba!, json.originalBackground) >= json.threshold);
    assert.match(serializeExport(source, options('css')).text, /-webkit-text-fill-color: currentColor;/);
    assert.match(compileString(serializeExport(source, options('scss')).text).css, /-webkit-text-fill-color: currentColor;/);
    const tailwind = serializeExport(source, options('tailwind'));
    assert.ok(tailwind.classes!.split(' ').includes('[-webkit-text-fill-color:currentColor]'));
    const compiler = await compile('@tailwind utilities;', { base: process.cwd(), onDependency: () => {} });
    assert.match(compiler.build(tailwind.classes!.split(' ')), /-webkit-text-fill-color: currentColor;/);
    const normal = JSON.parse(serializeExport({ kind: 'element', snapshot }, options('json')).text);
    assert.deepEqual(normal.textRuns[0].foreground.rgba, { r: 119, g: 119, b: 119, a: 1 });
    assert.equal(normal.textRuns[0].contrast.status, 'fail');
    assert.equal(normal.textRuns[0].foregroundSource, undefined);
    assert.equal(normal.textRuns[0].textFillPresent, undefined, 'Runtime provenance stays internal to normal exports');
    assert.doesNotMatch(serializeExport({ kind: 'element', snapshot }, options('css')).text, /-webkit-text-fill-color/);
  }
});

test('background corrections retain glyph fill and caller conditions cannot invent a reset', () => {
  const snapshot = fixtureSnapshot(fixtureRun('#777', '#777', 16));
  snapshot.textRuns[0].textFillPresent = true;
  snapshot.textRuns[0].foregroundSource = 'text-fill';
  const suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA', 'background-color').suggestions[0];
  suggestion.conditions.push('text-fill-reset-to-currentcolor');
  const json = JSON.parse(serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, options('json')).text);
  assert.equal(json.additionalDeclarations, undefined);
  assert.equal(json.conditions.includes('text-fill-reset-to-currentcolor'), false);
  for (const format of ['css', 'scss', 'tailwind'] as const) {
    assert.doesNotMatch(serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion }, options(format)).text, /-webkit-text-fill-color/);
  }
  delete snapshot.textRuns[0].foregroundSource;
  delete snapshot.textRuns[0].textFillPresent;
  const colorSuggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
  colorSuggestion.conditions.push('text-fill-reset-to-currentcolor');
  const noFill = JSON.parse(serializeExport({ kind: 'contrast-suggestion', snapshot, suggestion: colorSuggestion }, options('json')).text);
  assert.equal(noFill.additionalDeclarations, undefined);
  assert.equal(noFill.conditions.includes('text-fill-reset-to-currentcolor'), false);
});

test('checked-in illustrative exports match serializer bytes', () => {
  const snapshot = fixtureSnapshot(), suggestion = suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions[0];
  for (const kind of ['element', 'contrast-suggestion'] as const) for (const format of ['css', 'scss', 'json', 'tailwind'] as const) {
    const source: ExportSource = kind === 'element' ? { kind, snapshot } : { kind, snapshot, suggestion };
    const result = serializeExport(source, options(format));
    assert.equal(readFileSync(new URL(`../fixtures/export/${result.filename}`, import.meta.url), 'utf8'), result.text);
  }
});
