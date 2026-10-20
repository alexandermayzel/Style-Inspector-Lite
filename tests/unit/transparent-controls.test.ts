import test from 'node:test';
import assert from 'node:assert/strict';
import { directTextCount, ElementRegistry, measureRuns } from '../../src/runtime/dom';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';

function withControl(run: (input: Element, state: { type: string; style: Record<string, string>; properties: Record<string, string> }) => void) {
  const state: { type: string; style: Record<string, string>; properties: Record<string, string> } = { type: 'button', style: { display: 'inline-block', visibility: 'visible', contentVisibility: 'visible', opacity: '1', color: 'transparent', textShadow: 'none', textEmphasisStyle: 'none', textDecorationLine: 'none', backgroundClip: 'border-box' },
    properties: { '-webkit-text-fill-color': 'rgba(0, 0, 0, 0)', '-webkit-text-stroke-width': '0px', '-webkit-background-clip': 'border-box' } };
  const input = {
    tagName: 'INPUT', parentElement: null, closest: () => null, matches: () => false,
    getClientRects: () => [{ width: 240, height: 36 }],
    getAttribute: (name: string) => { assert.equal(name, 'type', 'Only the input type may be read'); return state.type; },
  };
  for (const property of ['value', 'defaultValue', 'placeholder', 'textContent', 'childNodes']) {
    Object.defineProperty(input, property, { get() { throw new Error(`Private form property read: ${property}`); } });
  }
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ ...state.style,
    getPropertyValue: (name: string) => state.properties[name] ?? '' }) });
  try { run(input as unknown as Element, state); }
  finally { if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous); else Reflect.deleteProperty(globalThis, 'getComputedStyle'); }
}

test('fully transparent native button labels are omitted without reading form text or applying opacity thresholds', () => withControl((input, state) => {
  for (const type of ['button', 'submit', 'reset', 'SUBMIT']) for (const opacity of ['1', '0.01', '0.000001']) {
    state.type = type; state.style.opacity = opacity;
    assert.equal(directTextCount(input), 0);
  }
  state.properties['-webkit-text-fill-color'] = '#111111';
  assert.equal(directTextCount(input), 1, 'A faint but painted glyph must remain');
}));

test('fill overrides, shadows, strokes, emphasis, decoration and glyph backgrounds prevent transparent-label exclusion', () => withControl((input, state) => {
  const retainStyle = [['textShadow', '1px 0 rgb(0, 0, 0)'], ['textEmphasisStyle', 'circle'], ['textDecorationLine', 'underline'], ['backgroundClip', 'text']];
  for (const [property, value] of retainStyle) {
    const previous = state.style[property!]; state.style[property!] = value!;
    assert.equal(directTextCount(input), 1, property);
    state.style[property!] = previous!;
  }
  for (const fill of ['#111111', 'color(display-p3 1 0 0)', '']) {
    state.properties['-webkit-text-fill-color'] = fill;
    assert.equal(directTextCount(input), 1, 'Visible/unknown fill remains');
  }
  state.properties['-webkit-text-fill-color'] = 'transparent';
  state.style.color = '#111111';
  assert.equal(directTextCount(input), 0, 'Transparent fill overrides visible color');
  for (const width of ['1px', '', 'unknown']) {
    state.properties['-webkit-text-stroke-width'] = width;
    assert.equal(directTextCount(input), 1, 'Painted/unknown stroke remains');
  }
}));

test('transparent-label proof keeps editable controls and respects resolved currentColor', () => withControl((input, state) => {
  for (const type of ['text', 'search', 'password', 'email', 'number']) {
    state.type = type;
    assert.equal(directTextCount(input), 1);
  }
  state.type = 'button';
  state.properties['-webkit-text-fill-color'] = 'currentcolor';
  assert.equal(directTextCount(input), 0);
  state.style.color = '#111111';
  assert.equal(directTextCount(input), 1);
}));

test('a previously counted button is excluded when a fresh measurement sees a fully transparent label', () => withControl((input, state) => {
  state.properties['-webkit-text-fill-color'] = '#111111';
  const count = directTextCount(input);
  assert.equal(count, 1);
  state.properties['-webkit-text-fill-color'] = 'transparent';
  assert.deepEqual(measureRuns(input, new ElementRegistry('transparent-control'), DEFAULT_SETTINGS, count), []);
}));
