import test from 'node:test';
import assert from 'node:assert/strict';
import { changeHue, hsvToHex, rgbToHsv } from '../../src/sidebar/hsv';

test('HSV primary colors and achromatic endpoints agree with opaque sRGB', () => {
  for (const [h, hex, channels] of [
    [0, '#FF0000', [255, 0, 0]], [60, '#FFFF00', [255, 255, 0]],
    [120, '#00FF00', [0, 255, 0]], [180, '#00FFFF', [0, 255, 255]],
    [240, '#0000FF', [0, 0, 255]], [300, '#FF00FF', [255, 0, 255]],
  ] as const) {
    assert.equal(hsvToHex({ h, s: 1, v: 1 }), hex);
    assert.deepEqual(rgbToHsv({ r: channels[0], g: channels[1], b: channels[2], a: 1 }), { h, s: 1, v: 1 });
  }
  assert.deepEqual(rgbToHsv({ r: 0, g: 0, b: 0, a: 1 }), { h: 0, s: 0, v: 0 });
  assert.deepEqual(rgbToHsv({ r: 255, g: 255, b: 255, a: 1 }), { h: 0, s: 0, v: 1 });
  assert.deepEqual(rgbToHsv({ r: 128, g: 128, b: 128, a: 1 }), { h: 0, s: 0, v: 128 / 255 });
  assert.equal(hsvToHex({ h: 240, s: 0, v: 1 }), '#FFFFFF');
  assert.equal(hsvToHex({ h: 120, s: 1, v: 0 }), '#000000');
});

test('RGB to HSV roundtrips boundary and interior byte colors without changing the selected HEX', () => {
  const values = [0, 1, 17, 63, 127, 128, 254, 255];
  for (const r of values) for (const g of values) for (const b of values) {
    const expected = '#' + [r, g, b].map(channel => channel.toString(16).padStart(2, '0')).join('').toUpperCase();
    assert.equal(hsvToHex(rgbToHsv({ r, g, b, a: 1 })), expected, expected);
  }
});

test('HSV finite coordinates wrap hue and clamp saturation/value while rejecting non-finite input', () => {
  assert.equal(hsvToHex({ h: 360, s: 1, v: 1 }), '#FF0000');
  assert.equal(hsvToHex({ h: -60, s: 1, v: 1 }), '#FF00FF');
  assert.equal(hsvToHex({ h: 720, s: 2, v: 2 }), '#FF0000');
  assert.equal(hsvToHex({ h: 180, s: -1, v: 1 }), '#FFFFFF');
  assert.equal(hsvToHex({ h: 180, s: 1, v: -1 }), '#000000');
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (const key of ['h', 's', 'v']) assert.throws(() => hsvToHex({ h: 0, s: 1, v: 1, [key]: invalid }), /invalid-hsv/);
    assert.throws(() => changeHue({ h: 0, s: 1, v: 1 }, invalid), /invalid-hsv/);
  }
  for (const invalid of [NaN, Infinity, -1, 256]) assert.throws(() => rgbToHsv({ r: invalid, g: 0, b: 0, a: 1 }), /invalid-rgb/);
});

test('changing hue makes black white and gray visibly chromatic but preserves chosen chromatic saturation/value', () => {
  for (const input of [{ h: 0, s: 0, v: 0 }, { h: 0, s: 0, v: 1 }, { h: 0, s: 0, v: .5 }, { h: 240, s: 1, v: 0 }]) {
    const changed = changeHue(input, 120);
    assert.deepEqual(changed, { h: 120, s: 1, v: 1 });
    assert.equal(hsvToHex(changed), '#00FF00');
  }
  const input = { h: 60, s: .25, v: .75 };
  assert.deepEqual(changeHue(input, 480), { h: 120, s: .25, v: .75 });
  assert.deepEqual(input, { h: 60, s: .25, v: .75 }, 'A hue edit cannot mutate the previous state');
});
