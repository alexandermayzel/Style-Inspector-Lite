import test from 'node:test';
import assert from 'node:assert/strict';
import { formatColor, formatDisplayColor, isRGBA, parseColor } from '../../src/core/colors';
import { contrastRatio, evaluateContrast } from '../../src/core/contrast';
import type { RGBA } from '../../src/core/types';

function color(raw: string): RGBA {
  const result = parseColor(raw);
  assert.ok(isRGBA(result.rgba), raw);
  assert.equal(result.raw, raw);
  return result.rgba;
}
function near(actual: number, expected: number, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function same(actual: RGBA, expected: RGBA, tolerance = 1e-9): void {
  for (const key of ['r', 'g', 'b', 'a'] as const) near(actual[key], expected[key], tolerance);
}

test('OKLab reference primaries and neutral lightness convert into encoded sRGB', () => {
  // Reference OKLab coordinates of the sRGB primaries; the revised CSS D65
  // matrices differ from the original published matrices by tiny roundoff.
  // https://bottosson.github.io/posts/oklab/
  for (const [raw, expected] of [
    ['oklab(0.6279553606145516 0.224863061065974 0.1258462985307351)', '#FF0000'],
    ['oklab(0.8664396115356694 -0.2338875741879082 0.1794984798967299)', '#00FF00'],
    ['oklab(0.4520137183853429 -0.0324569841687639 -0.3115281476783751)', '#0000FF'],
    ['oklab(0 0 0)', '#000000'], ['oklab(1 0 0)', '#FFFFFF'],
  ]) same(color(raw), color(expected), .0003);
  // Neutral L=.5 has linear sRGB .5^3=.125, not encoded sRGB .5.
  const gray = 255 * (1.055 * .125 ** (1 / 2.4) - .055);
  same(color('oklab(.5 0 0)'), { r: gray, g: gray, b: gray, a: 1 });
});

test('in-gamut OKLCH preserves conversion precision while HEX labels round only for display', () => {
  // CSS Color 4 reference conversion result, also #B36B51 in native Firefox
  // 142/158 DOM screenshot and Canvas pixels.
  const raw = ' OKLCH(6e-1 1e-1 40DEG / 12.3456789%) ';
  const actual = color(raw), before = structuredClone(actual);
  same(actual, { r: 178.66413475593922, g: 106.5003687819716, b: 81.20250753516017, a: .123456789 });
  assert.equal(formatDisplayColor(actual), '#B36B511F');
  assert.match(formatColor(actual), /^rgb\(/);
  same(color(formatColor(actual)), actual);
  assert.deepEqual(actual, before);
});

test('out-of-gamut OK colors match the verified Firefox default display policy', () => {
  // Independent native Firefox 142 and 158 DOM screenshot pixels (default
  // layout.css.gamut-mapping.method): clip after conversion, not MINDE.
  for (const [raw, expected] of [
    ['oklch(0.266811 0.0849344 95.9668)', '#322400'],
    ['oklch(1 0.0679475 95.9668)', '#FFFFCC'],
    ['oklch(.7 .4 30)', '#FF0000'],
    ['oklab(.5 .2 .1)', '#C30000'],
  ]) assert.equal(formatDisplayColor(color(raw)), expected);
  const background = color('oklch(1 0.0679475 95.9668)');
  near(background.b, 203.5487239025415);
  assert.notDeepEqual(background, color('#FFFFFF'));
});

test('OK color percentages and hue units use their CSS reference ranges', () => {
  const expected = color('oklch(.6 .1 90 / .5)');
  for (const hue of ['90', '90deg', '100grad', '.25turn', `${Math.PI / 2}rad`, '450deg', '-270deg']) {
    same(color(`oklch(60% 25% ${hue} / 50%)`), expected);
  }
  same(color('oklab(60% 25% -12.5% / 50%)'), color('oklab(.6 .1 -.05 / .5)'));
  assert.ok(isRGBA(color('oklch(.6 .1 1e308turn)')));
  assert.ok(isRGBA(color('oklch(.6 .1 -1e308rad)')));
});

test('standalone missing components, CSS clamping and exact alpha stay explicit', () => {
  same(color('oklab(none none none / none)'), color('transparent'));
  same(color('oklch(.6 none none)'), color('oklab(.6 0 0)'));
  same(color('oklch(.6 .1 none)'), color('oklch(.6 .1 0)'));
  same(color('oklab(.6 none -.05)'), color('oklab(.6 0 -.05)'));
  same(color('oklch(.6 -10% 90)'), color('oklab(.6 0 0)'));
  same(color('oklab(-50% .1 -.05)'), color('oklab(0 .1 -.05)'));
  same(color('oklch(150% .1 90)'), color('oklch(1 .1 90)'));
  assert.equal(color('oklab(.6 .1 -.05 / 200%)').a, 1);
  assert.equal(color('oklch(.6 .1 90 / -2)').a, 0);
  assert.equal(color('oklab(.6 .1 -.05 / .123456789012345)').a, .123456789012345);
});

test('reported OKLCH foreground/background yield AA and AAA without byte rounding', () => {
  const foreground = color('oklch(0.266811 0.0849344 95.9668)');
  const background = color('oklch(1 0.0679475 95.9668)');
  const measured = evaluateContrast({ foreground, background, fontSizeCssPx: 16, fontWeight: 400 });
  near(measured.ratio!, 14.730280417677456);
  assert.equal(measured.AA.status, 'pass');
  assert.equal(measured.AAA.status, 'pass');
  const roundedRatio = contrastRatio(color(formatDisplayColor(foreground)), color(formatDisplayColor(background)));
  assert.ok(Math.abs(measured.ratio! - roundedRatio) > .001);
  const translucent = color('oklch(.6 .1 40 / .5)');
  assert.ok(contrastRatio(translucent, color('#FFFFFF')) < contrastRatio({ ...translucent, a: 1 }, color('#FFFFFF')));
});

test('OK color parsing rejects malformed, relative and unresolved values', () => {
  for (const raw of [
    'oklch()', 'oklab(.5 .1)', 'oklch(.5 .1 90 .5)', 'oklab(.5, .1, .1)',
    'oklch(.5 .1 90 /)', 'oklab(.5 .1 .1 / .5 / .5)', 'oklab(.5 .1 .1 / .5 .5)',
    'oklch(.5 .1 90%)', 'oklab(.5 .1 90deg)', 'oklch(.5 .1 90px)',
    'oklch(.5 .1 90 deg)', 'oklch(.5 .1 .)', 'oklab(1. .1 .1)',
    'oklab(.5 1evil .1)', 'oklch(.5 .1 1e)', 'oklch(.5 .1 1e309)',
    'oklab(.5 NaN 0)', 'oklch(.5 infinity 90)', 'oklab(.5 .1 .1 / 1e309)',
    'oklch(1e309 .1 90)', 'oklab(.5 1e200 1e200)', 'oklch(.5 1e200 90)',
    'oklch(from red l c h)', 'oklab(calc(.5) .1 .1)', 'oklch(.5 var(--c) 90)',
    'oklch(.5 .1 90/*test*/)', 'oklch(.5\u00a0.1 90)', 'oklab(.5 .1 .1) junk',
    'color(display-p3 1 0 0)', 'lab(50% 10 10)', 'lch(50% 10 90)',
    `oklch(${' '.repeat(512)}.5 .1 90)`,
  ]) assert.deepEqual(parseColor(raw), { raw, rgba: null, reason: 'unsupported-color' }, raw);
});
