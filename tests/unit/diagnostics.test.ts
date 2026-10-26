import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticMeasurement, diagnosticStyleValue, serializeDiagnostic, DIAGNOSTIC_MAX_BYTES, type DiagnosticReport } from '../../src/core/diagnostics';
import { evaluateContrast, evaluateFontSize } from '../../src/core/contrast';
import { parseColor } from '../../src/core/colors';
import { isSidebarCommand } from '../../src/runtime/protocol';
import { captureDiagnostic } from '../../src/runtime/diagnostics';
import type { TextRun } from '../../src/core/types';

const run: TextRun = {
  id: 'private-run', elementRef: 'private-reference', selector: '#private-selector', tagName: 'span', textExcerpt: { value: 'private-page-text', truncated: false },
  foreground: parseColor('#FFF9'), background: parseColor('transparent'), effectiveBackground: parseColor('#161717').rgba,
  reasons: ['layered-background'], ownOpaqueBackground: false, fontSizeCssPx: 14, fontWeight: 400,
  contrast: evaluateContrast({ foreground: parseColor('#FFF9').rgba, background: null, fontSizeCssPx: 14, fontWeight: 400, reasons: ['layered-background'] }), fontSize: evaluateFontSize(14),
};
const report = (): DiagnosticReport => ({ schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: '2026-10-20T12:01:00.000Z', generator: { name: 'Style Inspector Lite', version: '1.0.2' }, browser: { name: 'Firefox', version: '158.0' }, measurement: diagnosticMeasurement(run, 'audit', '2026-10-20T12:00:00.000Z', true, 3, { width: 1280, height: 800 }, []), currentViewport: { width: 1200, height: 800 }, layers: [], samples: [], limitations: ['current-styles-not-a-new-measurement', 'no-text-or-page-address'] });

test('diagnostic measurement separates past measurement from current capture without page text or identifiers', () => {
  const value = report(), json = serializeDiagnostic(value), parsed = JSON.parse(json);
  assert.equal(parsed.measurement.measuredAt, '2026-10-20T12:00:00.000Z');
  assert.equal(parsed.capturedAt, '2026-10-20T12:01:00.000Z');
  assert.equal(parsed.measurement.stale, true);
  assert.equal(parsed.measurement.contrast.status, 'manual');
  assert.deepEqual(parsed.measurement.reasons, ['layered-background']);
  assert.equal(parsed.measurement.foreground.a, 0.6);
  assert.equal(json.includes('private-'), false);
});

test('diagnostics retain an explicit complexity limit instead of hiding why a measurement stopped', () => {
  const value = report();
  value.measurement.reasons = ['measurement-complexity-limit'];
  value.measurement.contrast.reason = 'measurement-complexity-limit';
  const result = JSON.parse(serializeDiagnostic(value));
  assert.deepEqual(result.measurement.reasons, ['measurement-complexity-limit']);
  assert.equal(result.measurement.contrast.reason, 'measurement-complexity-limit');
  assert.equal(result.measurement.contrast.status, 'manual');
});
test('diagnostics preserve only an explicit visible-fragment measurement flag', () => {
  const value = report();
  value.measurement = diagnosticMeasurement({ ...run, viewportPartial: true }, 'audit', '2026-10-20T12:00:00.000Z', false, 0, { width: 1280, height: 800 }, []);
  assert.equal(JSON.parse(serializeDiagnostic(value)).measurement.viewportPartial, true);
  Object.assign(value.measurement, { viewportPartial: 'PRIVATE_SCOPE' });
  assert.doesNotMatch(serializeDiagnostic(value), /PRIVATE_SCOPE|viewportPartial/);
});

test('CSS diagnostic values never retain URLs, escapes, quoted strings or arbitrary identifiers', () => {
  const secrets = ['url(https://private.example/token?secret=page)', 'u\\72l("https://private.example/path")', 'image-set("private-page-data" 1x)', 'url("data:image/svg+xml,<svg>private-page-text</svg>")', 'var(--private-page-text)', '"private-page-text"'];
  for (const secret of secrets) {
    for (const property of ['color', 'background-color', 'background-image', 'filter', 'mask-image', 'clip-path', 'display', 'opacity', 'font-family', 'content']) {
      const result = JSON.stringify(diagnosticStyleValue(property, secret));
      assert.equal(result.includes('private'), false, `${property}: ${result}`);
      assert.equal(result.includes('https'), false);
      assert.equal(result.includes('svg'), false);
    }
  }
  assert.deepEqual(diagnosticStyleValue('color', 'rgb(17.0000085 17.0000085 17.0000085 / 0.54)'), { r: 17.0000085, g: 17.0000085, b: 17.0000085, a: 0.54 });
  assert.equal(diagnosticStyleValue('font-size', '16px'), 16);
  assert.equal(diagnosticStyleValue('background-image', 'linear-gradient(#fff, #000),url("private")'), 'gradient');
  assert.equal(diagnosticStyleValue('opacity', ''), null);
});

test('diagnostic serializer uses explicit allowlists even when callers attach private extras', () => {
  const value: any = report();
  value.url = 'https://private.example'; value.html = '<span>private-page-text</span>'; value.measurement.textExcerpt = run.textExcerpt;
  value.measurement.reasons.push('private-page-text'); value.generator.version = 'private-build'; value.browser.name = 'private-browser';
  value.layers.push({ index: 73, role: 'target', tag: 'private-custom-element', rect: { x: Infinity, y: 1, width: 50, height: 20, text: 'private' }, styles: { color: '#ffffff', 'background-image': 'url(private)', 'font-family': 'private-font', 'content': 'private-text', 'z-index': 'auto' }, before: { 'generated-content': 'present', content: 'private-text' }, after: {}, className: 'private-class' });
  value.samples.push({ x: 1, y: 1, stack: [0, 73, -1, NaN], text: 'private' });
  value.limitations.push('private-note');
  const json = serializeDiagnostic(value), parsed = JSON.parse(json);
  assert.equal(json.includes('private'), false);
  assert.equal(parsed.layers[0].tag, 'custom-element');
  assert.equal(parsed.layers[0].rect.x, null);
  assert.equal(parsed.layers[0].styles['background-image'], 'image-or-other');
  assert.deepEqual(parsed.samples[0].stack, [0]);
  assert.equal(parsed.generator.version, null);
  assert.equal(parsed.browser.name, 'unknown');
});

test('diagnostic report serialization bounds layer, sample, reason and output sizes', () => {
  const value = report();
  value.layers = Array.from({ length: 1000 }, (_, index) => ({ index, role: 'ancestor', tag: 'div', rect: { x: 0, y: 0, width: 100, height: 100 }, styles: { 'background-image': 'url(' + 's'.repeat(100000) + ')' }, before: {}, after: {} }));
  value.samples = Array.from({ length: 1000 }, () => ({ x: 0, y: 0, stack: Array.from({ length: 1000 }, (_, i) => i) }));
  const json = serializeDiagnostic(value), parsed = JSON.parse(json);
  assert.equal(parsed.layers.length, 24); assert.equal(parsed.samples.length, 3);
  assert.ok(parsed.samples.every((sample: any) => sample.stack.length <= 8));
  assert.ok(Buffer.byteLength(json) < DIAGNOSTIC_MAX_BYTES);
});

test('diagnosis protocol requires exact document, source and run qualifiers', () => {
  const command = { type: 'diagnose-node', requestId: 'diagnostic-1', referenceId: 'node-1', runId: 'node-1:text1', source: { kind: 'audit', id: 'audit-1' }, expectedTabId: 10, expectedDocumentToken: 'document-1', expectedRevision: 4 };
  assert.equal(isSidebarCommand(command), true);
  for (const key of ['referenceId', 'runId', 'source', 'expectedTabId', 'expectedDocumentToken', 'expectedRevision']) {
    const invalid: any = { ...command }; delete invalid[key]; assert.equal(isSidebarCommand(invalid), false, key);
  }
  for (const source of [null, {}, { kind: 'other', id: 'audit-1' }, { kind: 'audit', id: '' }]) assert.equal(isSidebarCommand({ ...command, source }), false);
  assert.equal(isSidebarCommand({ ...command, expectedRevision: -1 }), false);
});

test('explicit DOM diagnostics cap ancestor and point-stack reads without accessing text or attributes', () => {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldStyle = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  let styleReads = 0, attributeReads = 0;
  const node = (): any => ({ isConnected: true, tagName: 'SPAN', parentElement: null, ownerDocument: null,
    getBoundingClientRect: () => ({ x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 40, width: 100, height: 20 }),
    get textContent() { throw new Error('Text access forbidden'); }, get innerHTML() { throw new Error('Markup access forbidden'); },
    getAttribute() { attributeReads++; throw new Error('Attribute access forbidden'); } });
  const target = node(); let parent = target;
  for (let i = 0; i < 64; i++) { parent.parentElement = node(); parent = parent.parentElement; }
  const stack = Array.from({ length: 40 }, node); target.ownerDocument = { elementsFromPoint: () => stack };
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 } });
    Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => { styleReads++; return { content: '"private-generated-text"', getPropertyValue(property: string) { return property === 'color' ? 'rgb(255, 255, 255)' : property === 'background-image' ? 'url("https://private.example/image")' : property === 'opacity' ? '1' : 'none'; } }; } });
    const data: any = { id: 'audit-1', runs: [run], measuredAt: '2026-10-20T12:00:00.000Z', stale: false, viewport: { width: 1280, height: 800 }, reasons: [] };
    const captured = captureDiagnostic(target, { referenceId: run.elementRef, runId: run.id, source: { kind: 'audit', id: 'audit-1' } }, data);
    assert.equal(captured.layers.length, 24); assert.equal(styleReads, 24 * 3); assert.equal(attributeReads, 0);
    assert.equal(captured.samples.length, 3); assert.ok(captured.samples.every(sample => sample.stack.length === 8));
    assert.ok(captured.limitations.includes('ancestor-limit')); assert.ok(captured.limitations.includes('point-stack-limit'));
    assert.equal(serializeDiagnostic(captured).includes('private'), false);
    assert.equal(captured.layers[0].before['generated-content'], 'present');
    target.getBoundingClientRect = () => ({ x: 31, y: 280, left: 31, top: 280, right: 31, bottom: 300, width: 0, height: 20 });
    const zeroWidth = captureDiagnostic(target, { referenceId: run.elementRef, runId: run.id, source: { kind: 'audit', id: 'audit-1' } }, data);
    assert.equal(zeroWidth.samples.length, 0);
    assert.ok(zeroWidth.limitations.includes('target-without-area'));
    assert.equal(zeroWidth.limitations.includes('target-outside-viewport'), false, 'A zero-width in-viewport box is not an offscreen element');
    target.getBoundingClientRect = () => ({ x: 31, y: 1200, left: 31, top: 1200, right: 131, bottom: 1220, width: 100, height: 20 });
    const offscreen = captureDiagnostic(target, { referenceId: run.elementRef, runId: run.id, source: { kind: 'audit', id: 'audit-1' } }, data);
    assert.equal(offscreen.samples.length, 0);
    assert.ok(offscreen.limitations.includes('target-outside-viewport'));
    assert.equal(offscreen.limitations.includes('target-without-area'), false);
  } finally {
    if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (oldStyle) Object.defineProperty(globalThis, 'getComputedStyle', oldStyle); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});
