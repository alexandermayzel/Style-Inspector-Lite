import test from 'node:test';
import assert from 'node:assert/strict';
import { ElementRegistry, measureRuns } from '../../src/runtime/dom';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { cssColorContrast } from '../../src/core/contrast';
import { diagnosticMeasurement, sanitizeDiagnostic, type DiagnosticReport } from '../../src/core/diagnostics';

test('masks keep CSS color pairs separate from page contrast for direct, ancestor and placeholder text', () => {
  const style = (changes: Record<string, string> = {}) => ({
    color: '#000', backgroundColor: '#FFF', backgroundImage: 'none', display: 'block', maskImage: 'none',
    opacity: '1', filter: 'none', backdropFilter: 'none', mixBlendMode: 'normal', textShadow: 'none',
    visibility: 'visible', fontSize: '16px', fontWeight: '400', ...changes,
  });
  class Box {
    tagName = 'SPAN'; localName = 'span'; isConnected = true;
    children: Box[] = [];
    constructor(readonly computed = style(), readonly parentElement: Box | null = null) { parentElement?.children.push(this); }
    matches(selector: string) { return this.tagName === 'INPUT' && selector === ':placeholder-shown'; }
    getAttribute(name: string) { return name === 'type' ? 'text' : null; }
    getBoundingClientRect() { return { left: 10, top: 10, width: 80, height: 20 }; }
  }
  const parent = new Box(), target = new Box(style({ backgroundColor: 'transparent' }), parent);
  const placeholder = style({ backgroundColor: 'transparent' });
  const replacements = {
    SVGElement: class {}, innerWidth: 800, innerHeight: 600, document: {},
    getComputedStyle: (element: Box, pseudo?: string) => pseudo === '::placeholder' ? placeholder : pseudo ? { content: 'none' } : element.computed,
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { configurable: true, value });
  const measure = () => measureRuns(target as unknown as Element, new ElementRegistry('mask'), DEFAULT_SETTINGS, 1)[0]!;
  const masked = () => {
    const run = measure();
    assert.equal(run.contrast.status, 'manual'); assert.equal(run.contrast.ratio, null);
    assert.equal(run.contrast.reason, 'mask'); assert.equal(run.contrast.AA.status, 'manual'); assert.equal(run.contrast.AAA.status, 'manual');
    assert.equal(cssColorContrast(run)?.ratio, 21, 'The CSS pair remains usable without certifying masked page paint');
    return run;
  };
  try {
    assert.equal(measure().contrast.ratio, 21);
    for (const value of ['linear-gradient(black, transparent)', 'linear-gradient(#0008, #0008)', 'url("mask.svg")', 'none, linear-gradient(black, transparent)']) {
      target.computed.maskImage = value; masked(); target.computed.maskImage = 'none';
      parent.computed.maskImage = value; masked(); parent.computed.maskImage = 'none';
      placeholder.maskImage = value; target.tagName = 'INPUT'; masked(); target.tagName = 'SPAN'; placeholder.maskImage = 'none';
    }
    for (const value of ['none', 'none, none', ' none , none ']) {
      target.computed.maskImage = value; assert.equal(measure().contrast.ratio, 21);
    }
    target.computed.maskImage = 'none'; parent.computed.maskImage = 'linear-gradient(black, transparent)'; parent.computed.display = 'contents';
    target.computed.backgroundColor = '#FFF';
    assert.equal(measure().contrast.ratio, 21, 'A boxless ancestor has no mask surface');
    parent.computed.display = 'block'; parent.computed.maskImage = 'none'; target.computed.display = 'contents'; target.computed.maskImage = 'linear-gradient(black, transparent)';
    assert.equal(measure().contrast.ratio, 21, 'A boxless text owner also has no mask surface');
    target.computed.display = 'block';
    const run = masked();
    const measurement = diagnosticMeasurement(run, 'selection', '2026-10-20T00:00:00.000Z', false, 1, { width: 800, height: 600 }, []);
    const report: DiagnosticReport = { schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: null,
      generator: { name: 'Style Inspector Lite', version: '1.0.2' }, browser: { name: 'Firefox', version: '142.0' },
      measurement, currentViewport: { width: 800, height: 600 }, layers: [], samples: [], limitations: [] };
    assert.deepEqual(sanitizeDiagnostic(report).measurement.reasons, ['mask']);
    assert.equal(sanitizeDiagnostic(report).measurement.contrast.reason, 'mask');
    target.computed.color = 'rgb(0 0 0 / .5)';
    assert.equal(measure().contrast.status, 'manual'); assert.ok(cssColorContrast(measure())!.ratio > 3);
    target.computed.color = '#000'; parent.computed.backgroundImage = 'linear-gradient(#FFF, #EEE)';
    assert.equal(measure().contrast.status, 'manual', 'A mask never certifies a varying background');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
