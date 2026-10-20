import test from 'node:test';
import assert from 'node:assert/strict';
import { manualContrast, parseManualHex } from '../../src/sidebar/manual-contrast';

test('manual HEX accepts opaque short and long values and normalizes without changing channels', () => {
  assert.deepEqual(parseManualHex(' #aBc '), { hex: '#AABBCC', rgba: { r: 170, g: 187, b: 204, a: 1 } });
  assert.deepEqual(parseManualHex('#01020f'), { hex: '#01020F', rgba: { r: 1, g: 2, b: 15, a: 1 } });
  assert.equal(parseManualHex('#000')?.hex, '#000000');
  assert.equal(parseManualHex('#fff')?.hex, '#FFFFFF');
});

test('partial, malformed, alpha and non-HEX manual values cannot produce a stale or guessed ratio', () => {
  for (const value of ['', ' ', '#', '#12', '#1234', '#12345', '#1234567', '#12345678', '#GGGGGG', 'FFFFFF', 'red', 'rgb(0,0,0)', '#fff; color: red', '#ff ff ff']) {
    assert.equal(parseManualHex(value), null, value);
    assert.equal(manualContrast(value, '#FFFFFF'), null, `foreground ${value}`);
    assert.equal(manualContrast('#000000', value), null, `background ${value}`);
  }
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
