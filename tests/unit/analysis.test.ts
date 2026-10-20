import test from 'node:test';
import assert from 'node:assert/strict';
import { composite, formatColor, formatDisplayColor, linearToSrgb, parseColor, resolveBackground, srgbToLinear } from '../../src/core/colors';
import { contrastRatio, evaluateContrast, evaluateFontSize, evaluateRun, reassessAudit, summarizeRuns } from '../../src/core/contrast';
import { fromOklab, suggestContrast, toOklab } from '../../src/core/suggestions';
import { simulateColor } from '../../src/core/simulation';
import type { RGBA, SimulationMode } from '../../src/core/types';
import { fixtureAudit, fixtureRun, fixtureSnapshot } from '../fixtures/export/data';

const color = (s: string): RGBA => parseColor(s).rgba!;
const near = (a: number, b: number, tolerance = 1e-9) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
test('WCAG extrema, exact boundary, large-text classification and independent font-size heuristic', () => {
  assert.equal(contrastRatio(color('#000'), color('#fff')), 21);
  assert.equal(contrastRatio(color('#fff'), color('#fff')), 1);
  for (const [size, weight, category] of [[24, 400, 'large'], [23.999, 400, 'normal'], [14 * 96 / 72, 700, 'large'], [18.666, 700, 'normal'], [20, 699, 'normal']] as const) {
    assert.equal(evaluateContrast({ foreground: color('#000'), background: color('#fff'), fontSizeCssPx: size, fontWeight: weight }).category, category);
  }
  const channel = linearToSrgb((1.05 / 4.499) - 0.05);
  const result = evaluateContrast({ foreground: { r: channel, g: channel, b: channel, a: 1 }, background: color('#fff'), fontSizeCssPx: 16, fontWeight: 400 });
  near(result.ratio!, 4.499); assert.equal(result.AA.status, 'fail');
  for (const n of [11, 11.99, 11.999999]) assert.equal(evaluateFontSize(n).status, 'fail');
  for (const n of [12, 12.0001, 20]) assert.equal(evaluateFontSize(n).status, 'pass');
  for (const n of [null, NaN, Infinity, -1]) assert.equal(evaluateFontSize(n).status, 'manual');
});
test('color parsing preserves floats and precise alpha; unsafe and unknown values are explicit', () => {
  assert.equal(parseColor('color(display-p3 1 0 0)').rgba, null);
  assert.equal(parseColor('rgb(1evil 2 3)').rgba, null);
  assert.equal(parseColor('rgb(1, 2, 3 / 1)').rgba, null);
  assert.deepEqual(color('#f008'), { r: 255, g: 0, b: 0, a: 136 / 255 });
  assert.equal(color('hsl(-120deg 100% 50%)').b, 255);
  const original = color('rgb(12.25 200.125 30.5 / .123456789)');
  for (const format of ['hex', 'rgb', 'hsl'] as const) {
    const formatted = formatColor(original, format), parsed = color(formatted);
    assert.ok(formatted.startsWith(format === 'hsl' ? 'hsl(' : 'rgb('));
    near(parsed.r, original.r); near(parsed.g, original.g); near(parsed.b, original.b); near(parsed.a, original.a);
  }
  for (const [raw, expected] of [['#10203080', '#10203080'], ['#abc', '#AABBCC'], ['#a1B2c3de', '#A1B2C3DE'], ['#fff', '#FFFFFF']]) {
    const parsed = parseColor(raw), formatted = formatColor(parsed.rgba!);
    assert.equal(parsed.raw, raw); assert.equal(formatted, expected);
    assert.deepEqual(color(formatted), parsed.rgba);
  }
});
test('HEX labels round fractional channels and alpha without changing measured or exported colors', () => {
  const placeholder = color('color(srgb 0.0666667 0.0666667 0.0666667 / 0.54)');
  const original = structuredClone(placeholder);
  assert.equal(formatDisplayColor(placeholder), '#1111118A');
  assert.equal(formatColor(placeholder, 'hex'), 'rgb(17.0000085 17.0000085 17.0000085 / 0.54)');
  near(contrastRatio(placeholder, color('#fff')), 4.032916523267044);
  assert.deepEqual(placeholder, original);
  for (const [raw, expected] of [
    ['rgb(12.25 200.125 30.5 / .123456789)', '#0CC81F1F'],
    ['rgb(0 0 0 / .5)', '#00000080'], ['rgb(255 255 255 / .99999)', '#FFFFFFFF'],
    ['rgb(255 255 255 / .00001)', '#FFFFFF00'], ['transparent', '#00000000'],
    ['#a1b2c3de', '#A1B2C3DE'], ['#abc', '#AABBCC'], ['#fff', '#FFFFFF'],
  ]) assert.equal(formatDisplayColor(color(raw)), expected, raw);
  for (const format of ['rgb', 'hsl'] as const) assert.equal(formatDisplayColor(placeholder, format), formatColor(placeholder, format));
  for (const invalid of [{ ...placeholder, r: NaN }, { ...placeholder, a: 1.01 }, { ...placeholder, b: -1 }]) {
    assert.throws(() => formatDisplayColor(invalid), /invalid-color/);
  }
});

test('non-finite HSL hues stay unsupported instead of crashing the color parser', () => {
  for (const raw of ['hsl(1e309 50% 50%)', 'hsl(-1e309 50% 50%)', 'hsla(1e309deg, 50%, 50%, 1)']) {
    assert.deepEqual(parseColor(raw), { raw, rgba: null, reason: 'unsupported-color' });
  }
  assert.notEqual(parseColor('hsl(1e308 50% 50%)').rgba, null);
});

test('normalized sRGB colors preserve native Firefox placeholder alpha and contrast', () => {
  const placeholder = color('color(srgb 1 1 1 / 0.54)');
  assert.deepEqual(placeholder, color('rgb(255 255 255 / .54)'));
  const result = evaluateContrast({ foreground: placeholder, background: color('#121212'), fontSizeCssPx: 16, fontWeight: 400 });
  near(result.ratio!, 6.018941132147167);
  assert.equal(result.AA.status, 'pass'); assert.equal(result.AAA.status, 'fail');
  assert.deepEqual(color('color(srgb 0 .5 1)'), { r: 0, g: 127.5, b: 255, a: 1 });
  assert.deepEqual(color('color(srgb 0% 50% 100% / 54%)'), { r: 0, g: 127.5, b: 255, a: .54 });
  const raw = ' COLOR( sRGB +1e-3 .123456789012345 75% / 1.23456789e-1 ) ';
  const precise = parseColor(raw);
  assert.equal(precise.raw, raw);
  near(precise.rgba!.r, .255); near(precise.rgba!.g, .123456789012345 * 255);
  near(precise.rgba!.b, 191.25); near(precise.rgba!.a, .123456789);
  // CSS clamps alpha at parsing time; this is distinct from gamut mapping RGB.
  assert.equal(color('color(srgb 1 0 0 / 2)').a, 1);
  assert.equal(color('color(srgb 1 0 0 / -50%)').a, 0);
});

test('sRGB parsing rejects ambiguous syntax, other spaces and unmapped gamut values', () => {
  for (const raw of [
    'color(srgb 1 1)', 'color(srgb 1 1 1 .5)', 'color(srgb 1, 1, 1)',
    'color(srgb 1 1 1 /)', 'color(srgb 1 1 1 / .5 / .5)', 'color(srgb 1 1 1 / .5 .5)',
    'color(srgb 1evil 1 1)', 'color(srgb 1. 1 1)', 'color(srgb 1 1 1 / NaN)',
    'color(srgb none 1 1)', 'color(srgb 1 1 1 / none)', 'color(srgb calc(1) 1 1)',
    'color(srgb 1.000001 0 0)', 'color(srgb -0.001 0 0)', 'color(srgb 0 100.1% 0)',
    'color(srgb 1e309 0 0)', 'color(srgb 1 1 1 / 1e309)',
    'color(srgb-linear 1 0 0)', 'color(display-p3 1 0 0)', 'color(xyz-d65 1 0 0)',
  ]) assert.deepEqual(parseColor(raw), { raw, rgba: null, reason: 'unsupported-color' });
});

test('HSL remains finite at RGB endpoints and preserves very dark chromatic colors', () => {
  const channels = [0, Number.MIN_VALUE, 1e-300, 1e-30, 1e-14, 1, 254.99999999999997, 255];
  for (const r of channels) for (const g of channels) for (const b of channels) {
    const original = { r, g, b, a: 0.25 };
    const formatted = formatColor(original, 'hsl'), parsed = parseColor(formatted).rgba;
    assert.doesNotMatch(formatted, /Infinity|NaN/);
    assert.ok(parsed, formatted);
    near(parsed.r, r); near(parsed.g, g); near(parsed.b, b); near(parsed.a, original.a);
  }
  // HSL blue at 5e-15% lightness has B = 255 * 2 * 5e-17.
  const darkBlue = color('hsl(240 100% 5e-15%)');
  assert.equal(darkBlue.r, 0); assert.equal(darkBlue.g, 0);
  near(darkBlue.b / 2.55e-14, 1, 1e-12);
  const roundtrip = color(formatColor({ r: 0, g: 0, b: 1e-14, a: 1 }, 'hsl'));
  assert.equal(roundtrip.r, 0); assert.equal(roundtrip.g, 0);
  near(roundtrip.b / 1e-14, 1, 1e-12);
});

test('background chains, translucent foreground and unknown canvas stay distinct', () => {
  const background = resolveBackground([parseColor('transparent'), parseColor('rgb(0 0 0 / .5)'), parseColor('#fff')]);
  assert.deepEqual(background.rgba, { r: 127.5, g: 127.5, b: 127.5, a: 1 });
  assert.equal(resolveBackground([parseColor('transparent')]).rgba, null);
  assert.equal(resolveBackground([parseColor('color(display-p3 1 0 0)'), parseColor('#fff')]).rgba, null);
  assert.deepEqual(composite(color('rgb(0 0 0 / .5)'), color('#fff')), background.rgba);
  near(contrastRatio(color('rgb(0 0 0 / .5)'), color('#fff')), 3.976653024912438);
  assert.throws(() => contrastRatio(color('#000'), color('transparent')));
});
test('manual contrast does not hide small-text findings, and counts use separate denominators', () => {
  const run = fixtureRun(); run.reasons = ['background-image'];
  const uncertain = evaluateRun(run, 'AAA'), clean = fixtureRun('#000', '#fff', 16);
  assert.equal(uncertain.contrast.status, 'manual'); assert.equal(uncertain.fontSize.status, 'fail');
  const notApplicable = evaluateRun({ ...clean, notApplicable: 'disabled-control' }, 'AA');
  const counts = summarizeRuns([uncertain, clean, notApplicable]);
  assert.deepEqual(counts.contrast, { pass: 1, fail: 0, manual: 1, notApplicable: 1, assessed: 3 });
  assert.equal(counts.fontSize.fail, 1); assert.equal(counts.checks, 6);
  const double = summarizeRuns([fixtureRun()]); assert.equal(double.findings, 2); assert.equal(double.affectedRuns, 1);
  const old = fixtureAudit([fixtureRun('#777', '#fff', 24)]), updated = reassessAudit(old, 'AAA');
  assert.equal(old.runs[0].contrast.status, 'pass'); assert.equal(updated.runs[0].contrast.status, 'fail'); assert.deepEqual(old.runs[0].fontSize, updated.runs[0].fontSize);
});
test('bounded suggestions satisfy their final HEX value and keep original data immutable', () => {
  const snapshot = fixtureSnapshot(), before = JSON.stringify(snapshot);
  for (const target of ['AA', 'AAA'] as const) {
    const result = suggestContrast(snapshot, snapshot.textRuns[0], target, 'color', [parseColor('#111')]);
    assert.ok(result.suggestions.length > 0 && result.suggestions.length <= 3);
    assert.equal(new Set(result.suggestions.map(s => s.newValue)).size, result.suggestions.length);
    for (const suggestion of result.suggestions) {
      const ratio = contrastRatio(color(suggestion.newValue), suggestion.background);
      assert.ok(ratio >= suggestion.threshold); near(ratio, suggestion.afterRatio); assert.equal(suggestion.applied, false);
    }
  }
  assert.equal(JSON.stringify(snapshot), before);
  const inherited = fixtureSnapshot(); inherited.textRuns[0].ownOpaqueBackground = false;
  assert.equal(suggestContrast(inherited, inherited.textRuns[0], 'AA', 'background-color').reason, 'inherited-background');
  assert.ok(suggestContrast(inherited, inherited.textRuns[0], 'AA').suggestions.length);
  const impossible = fixtureSnapshot(fixtureRun('#777', '#777', 16));
  assert.equal(suggestContrast(impossible, impossible.textRuns[0], 'AAA').reason, 'target-unreachable');
  const alpha = fixtureSnapshot(fixtureRun('rgb(170 170 170 / .5)'));
  assert.equal(suggestContrast(alpha, alpha.textRuns[0], 'AA').reason, 'unsupported-suggestion');
  const filled = fixtureSnapshot(fixtureRun('#777', '#777', 16));
  filled.textRuns[0].foregroundSource = 'text-fill';
  filled.textRuns[0].textFillPresent = true;
  for (const property of ['color', 'background-color'] as const) {
    const result = suggestContrast(filled, filled.textRuns[0], 'AA', property);
    assert.ok(result.suggestions.length);
    for (const suggestion of result.suggestions) assert.equal(suggestion.conditions.includes('text-fill-reset-to-currentcolor'), property === 'color', 'Foreground corrections reset the fill; background corrections retain it');
  }
  assert.equal(suggestContrast({ ...snapshot, stale: true }, snapshot.textRuns[0], 'AA').reason, 'stale-measurement');
});
test('OKLab roundtrip, achromatic input and gamut-edge hue do not invent invalid candidates', () => {
  for (const raw of ['#000', '#fff', '#ff0001', '#00ff00', '#0000ff', '#777']) {
    const c = color(raw), roundtrip = fromOklab(toOklab(c));
    near(roundtrip.r, c.r, 0.001); near(roundtrip.g, c.g, 0.001); near(roundtrip.b, c.b, 0.001);
    const snapshot = fixtureSnapshot(fixtureRun(raw, '#777', 16));
    for (const suggestion of suggestContrast(snapshot, snapshot.textRuns[0], 'AA').suggestions) assert.ok(contrastRatio(color(suggestion.newValue), color('#777')) >= 4.5);
  }
});
test('Machado reference primaries and grayscale use linear sRGB, with distinct matrices', () => {
  // Independent tabulated expected values: apply the published severity-1.0
  // matrix first column to linear red, clip and encode IEC sRGB. 1e-5 byte tolerance.
  const expected = { protanopia: [108.78516028625047, 95.02684074297856, 0], deuteranopia: [163.21518657507016, 144.28077000995205, 0], tritanopia: [255, 0, 14.888423465677677] };
  for (const [mode, values] of Object.entries(expected)) {
    const simulated = simulateColor(color('#f00'), mode as SimulationMode)!;
    near(simulated.r, values[0], 0.001); near(simulated.g, values[1], 0.001); near(simulated.b, values[2], 0.001);
  }
  const modes: SimulationMode[] = ['original', 'protanopia', 'deuteranopia', 'tritanopia', 'grayscale'];
  for (const mode of modes) for (const raw of ['#000', '#fff', '#777']) {
    const original = color(raw), simulated = simulateColor(original, mode)!;
    near(original.r, simulated.r, 0.001); near(original.g, simulated.g, 0.001); near(original.b, simulated.b, 0.001);
  }
  near(simulateColor(color('#f00'), 'grayscale')!.r, linearToSrgb(0.2126));
  assert.equal(simulateColor(color('transparent'), 'protanopia'), null);
  // The standard's rounded branch thresholds introduce a < 0.00001-byte
  // discontinuity at 0.04045; do not demand an exact inverse at that point.
  for (const n of [0, 10.31475, 64, 128, 255]) near(linearToSrgb(srgbToLinear(n)), n, 0.00001);
  const snapshot = fixtureSnapshot(), before = JSON.stringify(snapshot);
  simulateColor(snapshot.textRuns[0].foreground.rgba!, 'protanopia');
  assert.equal(JSON.stringify(snapshot), before);
});
