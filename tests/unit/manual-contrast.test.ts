import test from 'node:test';
import assert from 'node:assert/strict';
import { manualContrast, parseManualColor, parseManualHex } from '../../src/sidebar/manual-contrast';
import { contrastRatio } from '../../src/core/contrast';

test('manual HEX accepts opaque short and long values and normalizes without changing channels', () => {
  assert.deepEqual(parseManualHex(' #aBc '), { hex: '#AABBCC', rgba: { r: 170, g: 187, b: 204, a: 1 } });
  assert.deepEqual(parseManualHex('#01020f'), { hex: '#01020F', rgba: { r: 1, g: 2, b: 15, a: 1 } });
  assert.equal(parseManualHex('#000')?.hex, '#000000');
  assert.equal(parseManualHex('#fff')?.hex, '#FFFFFF');
});

test('partial, malformed and contextual manual values cannot produce a stale or guessed ratio', () => {
  for (const value of ['', ' ', '#', '#12', '#12345', '#1234567', '#GGGGGG', 'FFFFFF', 'red', '#fff; color: red', '#ff ff ff', 'Canvas', 'currentColor', 'var(--color)', 'rgb(NaN 0 0)', 'rgb(1 2)', 'rgb(1 2 3); color:red', '#fff'.repeat(40)]) {
    assert.equal(parseManualHex(value), null, value);
    assert.equal(manualContrast(value, '#FFFFFF'), null, `foreground ${value}`);
    assert.equal(manualContrast('#000000', value), null, `background ${value}`);
  }
});

test('transparent backgrounds require an explicit opaque underlay and compose both layers in order', () => {
  assert.equal(manualContrast('#000', '#FFF8'), null);
  assert.equal(manualContrast('#000', '#FFF8', '#0008'), null);
  assert.equal(manualContrast('#000', '#FFF8', 'Canvas'), null);
  const pair = manualContrast('#FFF8', '#0008', '#FFFFFF')!;
  assert.ok(pair);
  assert.deepEqual(pair.effectiveBackground, { r: 119, g: 119, b: 119, a: 1 });
  assert.equal(pair.normal.ratio, contrastRatio(pair.foreground.rgba, pair.effectiveBackground));
  assert.equal(pair.underlay?.value, '#FFFFFF');
  assert.equal(pair.background.value, '#00000088');
  assert.equal(manualContrast('#0000', '#FFF')!.normal.ratio, 1);
  assert.equal(manualContrast('#000', '#0000', '#FFF')!.normal.ratio, 21);
  assert.equal(manualContrast('#000', '#FFF', 'invalid')!.normal.ratio, 21, 'An unused underlay cannot invalidate an opaque background');
});

test('palette imports preserve fractional RGB and alpha while supplying an opaque picker approximation', () => {
  const text = 'rgb(17.0000085 17.0000085 17.0000085 / 0.54)';
  const parsed = parseManualColor(text)!;
  assert.equal(parsed.rgba.r, 17.0000085);
  assert.equal(parsed.rgba.a, 0.54);
  assert.equal(parsed.hex, '#111111');
  assert.deepEqual(parseManualColor(parsed.value)?.rgba, parsed.rgba);
  assert.equal(manualContrast(text, '#FFF')!.normal.ratio, contrastRatio(parsed.rgba, { r: 255, g: 255, b: 255, a: 1 }));
  assert.equal(parseManualHex('#FFF8'), null, 'The existing picker still accepts only opaque HEX');
  assert.equal(parseManualHex(text), null);
});

test('manual colors use exact symmetric contrast and independent normal and large AA/AAA thresholds', () => {
  for (const [foreground, background] of [['#000000', '#FFFFFF'], ['#FFFFFF', '#000000']]) {
    const result = manualContrast(foreground, background)!;
    assert.equal(result.normal.ratio, 21);
    assert.equal(result.large.ratio, 21);
    assert.deepEqual([result.normal.AA.status, result.normal.AAA.status, result.large.AA.status, result.large.AAA.status], ['pass', 'pass', 'pass', 'pass']);
  }
  const identical = manualContrast('#AABBCC', '#abc')!;
  assert.equal(identical.normal.ratio, 1);
  assert.deepEqual([identical.normal.AA.status, identical.normal.AAA.status, identical.large.AA.status, identical.large.AAA.status], ['fail', 'fail', 'fail', 'fail']);
  const weak = manualContrast('#777777', '#FFFFFF')!;
  assert.ok(Math.abs(weak.normal.ratio! - 4.478089453577214) < 1e-12);
  assert.deepEqual([weak.normal.AA.threshold, weak.normal.AAA.threshold, weak.large.AA.threshold, weak.large.AAA.threshold], [4.5, 7, 3, 4.5]);
  assert.deepEqual([weak.normal.AA.status, weak.normal.AAA.status, weak.large.AA.status, weak.large.AAA.status], ['fail', 'fail', 'pass', 'fail']);
  const medium = manualContrast('#707070', '#FFFFFF')!;
  assert.deepEqual([medium.normal.AA.status, medium.normal.AAA.status, medium.large.AA.status, medium.large.AAA.status], ['pass', 'fail', 'pass', 'pass']);
});
