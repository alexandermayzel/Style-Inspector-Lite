import test from 'node:test';
import assert from 'node:assert/strict';
import { composite, parseColor } from '../../src/core/colors';
import { contrastRatio, evaluateContrast, evaluateFontSize, evaluateRun, summarizeRuns } from '../../src/core/contrast';
import { compositeGradientRange, parseLinearGradient, splitBackgroundLayers } from '../../src/core/gradients';
import type { BackgroundRange, RGBA, TextRun } from '../../src/core/types';

const rgba = (raw: string): RGBA => parseColor(raw).rgba!;
const range = (min: string, max: string): BackgroundRange => ({ min: rgba(min), max: rgba(max) });
const evaluate = (backgroundRange: BackgroundRange, foreground = '#4C4C4C') => evaluateContrast({
  foreground: rgba(foreground), background: null, backgroundRange, fontSizeCssPx: 15, fontWeight: 400,
});

test('gradient parser accepts the supported legacy and explicit sRGB subset', () => {
  for (const gradient of [
    'linear-gradient(black, white)',
    'linear-gradient(to top, rgb(246, 246, 246) 0%, rgba(246, 246, 246, 0.5) 60%, rgba(240, 240, 240, 0) 100%)',
    'linear-gradient(0.25turn, #F6F6F5 0% 50%, #FDFDFC 50% 100%)',
    'linear-gradient(to left bottom in srgb, black -2px, white 101%)',
    'linear-gradient(in srgb to right top, black, white)',
    'linear-gradient(90deg in srgb, color(srgb 0 0 0), color(srgb 1 1 1))',
    'linear-gradient(in srgb, transparent, rgb(255 255 255 / 50%))',
  ]) assert.ok(parseLinearGradient(gradient), gradient);
  assert.equal(parseLinearGradient('linear-gradient(black, white)')!.length, 2);
});

test('unsupported gradient spaces, expressions, hints and excessive input remain unknown', () => {
  for (const gradient of [
    'radial-gradient(black, white)', 'repeating-linear-gradient(black, white)',
    'linear-gradient(in oklab, black, white)', 'linear-gradient(in srgb-linear, black, white)',
    'linear-gradient(in hsl longer hue, black, white)', 'linear-gradient(color(srgb 0 0 0), white)',
    'linear-gradient(oklch(.8 .1 80), white)', 'linear-gradient(in srgb, oklch(.8 .1 80), white)',
    'linear-gradient(oklab(.8 .01 .02), white)', 'linear-gradient(lch(80 10 90), white)',
    'linear-gradient(to left right, black, white)', 'linear-gradient(1e999deg, black, white)',
    'linear-gradient(to top in srgb in srgb, black, white)',
    'linear-gradient(black 0%, 30%, white 100%)', 'linear-gradient(black calc(50% - 1px), white)',
    'linear-gradient(var(--color), white)', 'linear-gradient(currentColor, white)',
    'linear-gradient(color-mix(in srgb, black, white), white)',
    'linear-gradient(black 1px 2px 3px, white)', 'linear-gradient(black 1e999px, white)',
    'linear-gradient(black 2vw, white)', 'linear-gradient(black,)', 'linear-gradient(black)',
    'linear-gradient(black, white) trailing', 'linear-gradient(#FFFFFF0, white)',
    `linear-gradient(${Array.from({ length: 33 }, () => 'white').join(',')})`,
    `linear-gradient(black, ${' '.repeat(4096)}white)`,
  ]) assert.equal(parseLinearGradient(gradient), null, gradient.slice(0, 100));
  assert.ok(parseLinearGradient(`linear-gradient(to right, ${Array.from({ length: 32 }, () => 'white').join(',')})`));
});

test('background layer splitting respects nested commas, quoted URLs and work limits', () => {
  assert.deepEqual(splitBackgroundLayers('url("a,b.png"), linear-gradient(rgb(1, 2, 3), white), none'), [
    'url("a,b.png")', 'linear-gradient(rgb(1, 2, 3), white)', 'none',
  ]);
  assert.deepEqual(splitBackgroundLayers('url("a\\\",b.png"), none'), ['url("a\\\",b.png")', 'none']);
  for (const raw of ['', 'none,', ',none', 'none,,none', 'url("bad)', 'linear-gradient(black,white', 'none)',
    Array.from({ length: 17 }, () => 'none').join(','), '('.repeat(9) + ')'.repeat(9)]) assert.equal(splitBackgroundLayers(raw), null);
  assert.equal(splitBackgroundLayers(Array.from({ length: 16 }, () => 'none').join(','))!.length, 16);
});

test('gradient composition retains alpha, CSS image order, own colors and uncovered background', () => {
  const header = parseLinearGradient('linear-gradient(to top, rgb(246, 246, 246) 0%, rgba(246, 246, 246, 0.5) 60%, rgba(240, 240, 240, 0) 100%)')!;
  const bounds = compositeGradientRange([{ color: parseColor('white'), gradients: [header] }])!;
  assert.deepEqual(bounds, range('#F6F6F6', 'white'));
  assert.equal(evaluate(bounds).AAA.status, 'pass');
  const half100 = [rgba('rgba(100,100,100,0.5)'), rgba('rgba(100,100,100,0.5)')];
  const half200 = [rgba('rgba(200,200,200,0.5)'), rgba('rgba(200,200,200,0.5)')];
  const front100 = compositeGradientRange([{ color: parseColor('black'), gradients: [half100, half200] }])!;
  const front200 = compositeGradientRange([{ color: parseColor('black'), gradients: [half200, half100] }])!;
  assert.equal(front100.max.r, 100);
  assert.equal(front200.max.r, 125);
  const own = compositeGradientRange([
    { color: parseColor('rgba(0,0,0,0.5)'), gradients: [] },
    { color: parseColor('white'), gradients: [header] },
  ])!;
  assert.equal(own.min.r, 123); assert.equal(own.max.r, 127.5);
  assert.equal(compositeGradientRange([{ color: parseColor('transparent'), gradients: [header] }]), null);
  assert.equal(compositeGradientRange([{ color: parseColor('unknown'), gradients: [header] }]), null);
});

test('proven opaque top gradients anchor bounds without hidden own colors or ancestors', () => {
  const stops = [rgba('#F7E852'), rgba('#FAD86E')];
  const covered = { color: parseColor('unknown'), gradients: [stops], coveringTopImage: true as const };
  const expected = range('#F7D852', '#FAE86E');
  assert.deepEqual(compositeGradientRange([covered]), expected, 'Opaque image supplies its own anchor');
  assert.deepEqual(compositeGradientRange([covered, { color: parseColor('#212831'), gradients: [] }]), expected);
  assert.deepEqual(compositeGradientRange([covered, { color: parseColor('unknown'), gradients: [] }]), expected);
  const unproven = compositeGradientRange([{ ...covered, color: parseColor('#212831'), coveringTopImage: undefined }])!;
  assert.deepEqual(unproven.min, rgba('#212831'), 'Without geometry proof, uncovered dark background remains possible');
  const result = evaluate(expected, '#030303');
  assert.equal(result.AA.status, 'pass'); assert.equal(result.AAA.status, 'pass'); assert.equal(result.ratioKind, 'minimum');
  const overlay = compositeGradientRange([{ color: parseColor('rgba(0,0,0,.5)'), gradients: [] }, covered])!;
  assert.equal(overlay.min.r, 123.5); assert.equal(overlay.max.r, 125);
  assert.equal(overlay.min.g, 108); assert.equal(overlay.max.g, 116);
  assert.equal(compositeGradientRange([{ color: parseColor('unknown'), gradients: [] }, covered]), null, 'Unknown nearer paint is not hidden by the anchor');
  const nearer = { color: parseColor('unknown'), gradients: [[rgba('#F6F6F6'), rgba('white')]], coveringTopImage: true as const };
  assert.deepEqual(compositeGradientRange([nearer, covered]), range('#F6F6F6', 'white'), 'Nearest proven cover hides farther images');
});

test('opaque coverage claims cannot authorize transparent, malformed or oversized stop sets', () => {
  for (const stops of [[], [rgba('white')], [rgba('white'), rgba('rgba(0,0,0,.99)')],
    [rgba('white'), { ...rgba('black'), r: NaN }], Array.from({ length: 33 }, () => rgba('white'))]) {
    assert.equal(compositeGradientRange([{ color: parseColor('black'), gradients: [stops], coveringTopImage: true }]), null);
  }
  assert.equal(compositeGradientRange([{ color: parseColor('black'), gradients: [], coveringTopImage: true }]), null);
  assert.equal(compositeGradientRange([{ color: parseColor('black'), gradients: Array.from({ length: 17 }, () => [rgba('white'), rgba('white')]), coveringTopImage: true }]), null);
});

test('composed channel bounds enclose premultiplied-alpha interpolation between colored stops', () => {
  const base = rgba('#EDF2E8');
  const stops = [rgba('rgba(0,180,220,0.2)'), rgba('rgba(245,10,90,0.8)'), rgba('rgba(250,250,0,0)')];
  const bounds = compositeGradientRange([{ color: { raw: '#EDF2E8', rgba: base }, gradients: [stops] }])!;
  for (let stop = 0; stop < stops.length - 1; stop++) {
    for (let step = 0; step <= 100; step++) {
      const t = step / 100, left = stops[stop]!, right = stops[stop + 1]!;
      const alpha = left.a * (1 - t) + right.a * t;
      const interpolated: RGBA = { r: 0, g: 0, b: 0, a: alpha };
      for (const channel of ['r', 'g', 'b'] as const) interpolated[channel] = alpha ? (left[channel] * left.a * (1 - t) + right[channel] * right.a * t) / alpha : 0;
      const actual = composite(interpolated, base);
      for (const channel of ['r', 'g', 'b'] as const) {
        assert.ok(actual[channel] >= bounds.min[channel] - 1e-10 && actual[channel] <= bounds.max[channel] + 1e-10);
      }
    }
  }
});

test('minimum contrast proves passes but never mistakes a gradient endpoint for the complete text background', () => {
  const foreground = rgba('#767676');
  assert.ok(contrastRatio(foreground, rgba('black')) >= 4.5);
  assert.ok(contrastRatio(foreground, rgba('white')) >= 4.5);
  const crossed = evaluate(range('black', 'white'), '#767676');
  assert.equal(crossed.ratio, 1);
  assert.equal(crossed.ratioKind, 'minimum');
  assert.equal(crossed.AA.status, 'manual');
  assert.equal(crossed.AAA.status, 'manual');
  assert.equal(crossed.reason, 'gradient-contrast-inconclusive');
  const darkText = evaluate(range('#F6F6F5', '#FDFDFC'));
  assert.equal(darkText.AA.status, 'pass'); assert.equal(darkText.AAA.status, 'pass');
  const lightText = evaluate(range('#050505', '#202020'), 'white');
  assert.equal(lightText.ratio, contrastRatio(rgba('white'), rgba('#202020')));
  assert.equal(lightText.AAA.status, 'pass');
});

test('minimum contrast retains independent AA and AAA outcomes when reassessed or counted', () => {
  const backgroundRange = range('#EEEEEE', 'white');
  const foreground = parseColor('#666666');
  const contrast = evaluate(backgroundRange, '#666666');
  assert.equal(contrast.status, 'pass');
  assert.equal(contrast.AA.status, 'pass'); assert.equal(contrast.AAA.status, 'manual');
  assert.equal(contrast.reason, undefined);
  const run = { id: 'gradient', elementRef: 'gradient', tagName: 'a', selector: 'a', fontSizeCssPx: 15, fontWeight: 400,
    foreground, background: parseColor('transparent'), effectiveBackground: null, backgroundRange,
    ownOpaqueBackground: false, reasons: [], contrast, fontSize: evaluateFontSize(15),
  } satisfies TextRun;
  const aaa = evaluateRun(run, 'AAA');
  assert.equal(aaa.contrast.ratio, contrast.ratio);
  assert.equal(aaa.contrast.ratioKind, 'minimum');
  assert.equal(aaa.contrast.status, 'manual');
  assert.equal(aaa.contrast.reason, 'gradient-contrast-inconclusive');
  assert.equal(evaluateRun(aaa, 'AA').contrast.status, 'pass');
  const counts = summarizeRuns([aaa]);
  assert.equal(counts.contrast.manual, 1); assert.equal(counts.contrast.fail, 0); assert.equal(counts.findings, 0);
});

test('other uncertainties and invalid bounds cannot become gradient passes', () => {
  const base = { foreground: rgba('#4C4C4C'), background: null, backgroundRange: range('#F6F6F6', 'white'), fontSizeCssPx: 15, fontWeight: 400 };
  for (const extra of [
    { reasons: ['overlapping-element'] }, { reasons: ['filter'] }, { reasons: ['group-opacity'] },
    { foreground: rgba('rgba(0,0,0,0.5)') }, { foreground: null }, { fontSizeCssPx: null },
    { backgroundRange: range('white', 'black') },
    { backgroundRange: { min: { ...rgba('black'), a: 0.5 }, max: rgba('white') } },
    { backgroundRange: { min: { ...rgba('black'), r: NaN }, max: rgba('white') } },
  ]) {
    const result = evaluateContrast({ ...base, ...extra });
    assert.equal(result.status, 'manual'); assert.equal(result.ratio, null); assert.equal(result.ratioKind, undefined);
  }
  const disabled = evaluateContrast({ ...base, notApplicable: 'inactive-control' });
  assert.equal(disabled.status, 'not-applicable'); assert.equal(disabled.ratio, null); assert.equal(disabled.ratioKind, undefined);
});
