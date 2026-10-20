import test from 'node:test';
import assert from 'node:assert/strict';
import { cssColorContrast, evaluateRun, summarizeRuns } from '../../src/core/contrast';
import { serializeExport } from '../../src/core/exports';
import { suggestContrast } from '../../src/core/suggestions';
import { linearToSrgb } from '../../src/core/colors';
import { fixtureAudit, fixtureRun, fixtureSnapshot } from '../fixtures/export/data';

const manualRun = () => evaluateRun({ ...fixtureRun('#0F1111', '#FFA41C', 13), reasons: ['overlapping-element'] }, 'AA');

test('CSS sample contrast leaves uncertain page verdicts, counts and suggestions unchanged', () => {
  const run = manualRun(), before = structuredClone(run), counts = summarizeRuns([run]);
  const sample = cssColorContrast(run);
  assert.ok(sample);
  assert.ok(Math.abs(sample.ratio - 9.54274942553824) < 1e-12);
  assert.deepEqual({ ...sample, ratio: 0 }, { ratio: 0, verified: false, basis: 'css-colors', omitted: 'page-layers-and-effects', category: 'normal',
    AA: { threshold: 4.5, status: 'pass' }, AAA: { threshold: 7, status: 'pass' } });
  assert.deepEqual(run, before);
  assert.equal(run.contrast.ratio, null);
  assert.equal(run.contrast.status, 'manual');
  assert.equal(run.contrast.AA.status, 'manual');
  assert.equal(run.contrast.AAA.status, 'manual');
  assert.deepEqual(summarizeRuns([run]), counts);
  assert.equal(counts.contrast.manual, 1);
  assert.deepEqual(suggestContrast(fixtureSnapshot(run), run, 'AA').suggestions, []);
});

test('CSS sample composites precise fractional foreground alpha without display rounding', () => {
  const run = evaluateRun({ ...fixtureRun('color(srgb 0.0666667 0.0666667 0.0666667 / 0.54)', '#FFFFFF', 15), reasons: ['filter'] }, 'AA');
  assert.equal(cssColorContrast(run)?.ratio, 4.032916523267044);
  assert.equal(run.foreground.rgba?.a, 0.54);
  assert.equal(run.contrast.ratio, null);
});

test('CSS sample requires known opaque solid background and never substitutes a verified or excluded result', () => {
  const run = manualRun();
  for (const candidate of [
    { ...run, effectiveBackground: null },
    { ...run, effectiveBackground: { r: 255, g: 255, b: 255, a: 0.5 } },
    { ...run, effectiveBackground: { r: Infinity, g: 255, b: 255, a: 1 } },
    { ...run, foreground: { raw: 'color(display-p3 1 0 0)', rgba: null } },
    { ...run, backgroundRange: { min: { r: 0, g: 0, b: 0, a: 1 }, max: { r: 255, g: 255, b: 255, a: 1 } } },
    { ...run, notApplicable: 'inactive-control' },
    evaluateRun({ ...run, notApplicable: 'inactive-control' }, 'AA'),
    fixtureRun('#000000', '#FFFFFF', 16),
    fixtureRun('#AAAAAA', '#FFFFFF', 16),
  ]) assert.equal(cssColorContrast(candidate), null);
});

test('element and audit JSON separate optional CSS thresholds from unchanged page contrast and counts', () => {
  const run = manualRun(), audited = fixtureAudit([run]), before = structuredClone(audited);
  for (const source of [{ kind: 'element' as const, snapshot: fixtureSnapshot(run) }, { kind: 'audit' as const, audit: audited }]) {
    const data = JSON.parse(serializeExport(source, { format: 'json', version: '1.0.1' }).text);
    assert.equal(data.schemaVersion, 2);
    assert.deepEqual(data.textRuns[0].contrast, run.contrast);
    assert.deepEqual(data.textRuns[0].cssColorContrast, cssColorContrast(run));
    assert.equal(data.textRuns[0].contrast.ratio, null);
    assert.equal(data.textRuns[0].cssColorContrast.verified, false);
    assert.deepEqual(data.textRuns[0].cssColorContrast.AA, { threshold: 4.5, status: 'pass' });
    assert.deepEqual(data.textRuns[0].cssColorContrast.AAA, { threshold: 7, status: 'pass' });
    if (source.kind === 'audit') assert.deepEqual(data.counts, before.counts);
  }
  assert.deepEqual(audited, before);
  const verified = JSON.parse(serializeExport({ kind: 'element', snapshot: fixtureSnapshot(fixtureRun('#000', '#FFF', 16)) }, { format: 'json', version: '1.0.1' }).text);
  assert.equal(verified.textRuns[0].cssColorContrast, undefined);
});

test('CSS thresholds use current normal and large font inputs independently of the selected audit target', () => {
  for (const [size, weight, category, aa, aaa] of [
    [16, 400, 'normal', 4.5, 7], [24, 400, 'large', 3, 4.5],
    [14 * 96 / 72, 700, 'large', 3, 4.5], [14 * 96 / 72 - 0.001, 700, 'normal', 4.5, 7],
    [20, 699, 'normal', 4.5, 7],
  ] as const) {
    const run = { ...manualRun(), ...fixtureRun('#777777', '#FFFFFF', size), fontWeight: weight, reasons: ['overlapping-element'] };
    const aaRun = evaluateRun(run, 'AA'), aaaRun = evaluateRun(run, 'AAA');
    const sample = cssColorContrast(aaRun)!;
    assert.equal(sample.category, category);
    assert.deepEqual(sample.AA, { threshold: aa, status: category === 'large' ? 'pass' : 'fail' });
    assert.deepEqual(sample.AAA, { threshold: aaa, status: 'fail' });
    assert.deepEqual(cssColorContrast(aaaRun), sample);
    assert.equal(aaRun.contrast.AA.status, 'manual'); assert.equal(aaaRun.contrast.AAA.status, 'manual');
  }
});

test('CSS ratios with unknown fonts omit AA/AAA instead of trusting an old stored category', () => {
  for (const changes of [
    { fontSizeCssPx: null }, { fontSizeCssPx: 0 }, { fontSizeCssPx: NaN }, { fontSizeCssPx: Infinity },
    { fontWeight: null }, { fontWeight: 0 }, { fontWeight: -1 }, { fontWeight: Infinity },
  ]) {
    const run = { ...manualRun(), ...changes };
    const sample = cssColorContrast(run)!;
    assert.equal(sample.category, 'unknown');
    assert.equal(sample.AA, undefined); assert.equal(sample.AAA, undefined);
    assert.equal(sample.ratio, cssColorContrast(manualRun())!.ratio);
    if ([run.fontSizeCssPx, run.fontWeight].some(value => value !== null && !Number.isFinite(value))) {
      assert.throws(() => serializeExport({ kind: 'element', snapshot: fixtureSnapshot(run) }, { format: 'json', version: '1.0.1' }), /non-finite-export-value/);
      continue;
    }
    const exported = JSON.parse(serializeExport({ kind: 'element', snapshot: fixtureSnapshot(run) }, { format: 'json', version: '1.0.1' }).text);
    assert.equal(exported.textRuns[0].cssColorContrast.category, 'unknown');
    assert.equal(exported.textRuns[0].cssColorContrast.AA, undefined);
    assert.equal(exported.textRuns[0].contrast.status, 'manual');
  }
  const staleCategory = { ...manualRun(), fontSizeCssPx: 24 };
  assert.equal(staleCategory.contrast.category, 'normal');
  assert.equal(cssColorContrast(staleCategory)!.category, 'large');
});

test('CSS threshold status uses the raw ratio even when display rounding reaches a boundary', () => {
  const channel = linearToSrgb((4.499 - 1) * 0.05);
  const run = evaluateRun({ ...fixtureRun('#000000', `rgb(${channel} ${channel} ${channel})`, 16), reasons: ['filter'] }, 'AA');
  const sample = cssColorContrast(run)!;
  assert.ok(sample.ratio < 4.5 && sample.ratio > 4.49);
  assert.equal(sample.ratio.toFixed(2), '4.50');
  assert.deepEqual(sample.AA, { threshold: 4.5, status: 'fail' });
  assert.equal(run.contrast.status, 'manual');
  assert.equal(summarizeRuns([run]).contrast.fail, 0);
});
