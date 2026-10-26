import { DIAGNOSTIC_MAX_LAYERS, DIAGNOSTIC_STYLE_PROPERTIES, diagnosticMeasurement, diagnosticStyleValue, diagnosticTag, sanitizeDiagnostic, type DiagnosticLayer, type DiagnosticReport, type DiagnosticTarget } from '../core/diagnostics';
import type { Audit, Snapshot } from '../core/types';
import { isOwnElement } from './dom';

/** This is called only by an explicit diagnostic request, never during a scan. */
export function captureDiagnostic(element: Element, target: DiagnosticTarget, data: Audit | Snapshot): DiagnosticReport {
  const runs = 'runs' in data ? data.runs : data.textRuns;
  const runIndex = runs.findIndex(run => run.id === target.runId && run.elementRef === target.referenceId);
  if (data.id !== target.source.id || runIndex < 0 || !element.isConnected) throw new Error('target-expired');
  const report: DiagnosticReport = {
    schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: new Date().toISOString(),
    generator: { name: 'Style Inspector Lite', version: null }, browser: { name: 'unknown', version: null },
    measurement: diagnosticMeasurement(runs[runIndex], target.source.kind, data.measuredAt, data.stale, runIndex + 1, data.viewport, data.reasons),
    currentViewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    layers: [], samples: [], limitations: ['current-styles-not-a-new-measurement', 'no-text-or-page-address', 'background-assets-omitted', 'pseudo-content-omitted'],
  };
  const ids = new Map<Element, number>();
  const styles = (node: Element, pseudo?: string): DiagnosticLayer['styles'] => {
    try {
      const css = getComputedStyle(node, pseudo);
      const values = Object.fromEntries(DIAGNOSTIC_STYLE_PROPERTIES.map(property => [property, diagnosticStyleValue(property, css.getPropertyValue(property))]));
      if (pseudo) values['generated-content'] = ['none', 'normal', ''].includes(css.content) ? 'absent' : 'present';
      return values;
    } catch { report.limitations.push('style-unavailable'); return {}; }
  };
  const add = (node: Element, role: DiagnosticLayer['role']): number | null => {
    if (ids.has(node)) return ids.get(node)!;
    if (report.layers.length >= DIAGNOSTIC_MAX_LAYERS) { report.limitations.push('point-stack-limit'); return null; }
    const index = report.layers.length, rect = node.getBoundingClientRect(); ids.set(node, index);
    report.layers.push({ index, role, tag: diagnosticTag(node.tagName), rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, styles: styles(node), before: styles(node, '::before'), after: styles(node, '::after') });
    return index;
  };
  let current: Element | null = element;
  for (let index = 0; current && index < 16; index++, current = current.parentElement) add(current, index === 0 ? 'target' : 'ancestor');
  if (current) report.limitations.push('ancestor-limit');
  const rect = element.getBoundingClientRect();
  const left = Math.max(0, rect.left), right = Math.min(window.innerWidth, rect.right), top = Math.max(0, rect.top), bottom = Math.min(window.innerHeight, rect.bottom);
  if (right > left && bottom > top) {
    for (const fraction of [0.5, 0.2, 0.8]) {
      const x = left + (right - left) * fraction, y = top + (bottom - top) / 2;
      try {
        const nodes = element.ownerDocument.elementsFromPoint(x, y).filter(node => !isOwnElement(node));
        if (nodes.length > 8) report.limitations.push('point-stack-limit');
        const stack = nodes.slice(0, 8).map(node => add(node, 'point-stack')).filter((index): index is number => index !== null);
        report.samples.push({ x, y, stack });
      } catch { report.limitations.push('point-stack-unavailable'); }
    }
  } else report.limitations.push(rect.width <= 0 || rect.height <= 0 ? 'target-without-area' : 'target-outside-viewport');
  return sanitizeDiagnostic(report);
}
