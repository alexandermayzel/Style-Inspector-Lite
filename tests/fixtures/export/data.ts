import { parseColor } from '../../../src/core/colors';
import { evaluateContrast, evaluateFontSize, summarizeRuns } from '../../../src/core/contrast';
import type { Audit, Snapshot, TextRun } from '../../../src/core/types';

export function fixtureRun(foreground = '#aaaaaa', background = '#ffffff', size = 11.99): TextRun {
  const fg = parseColor(foreground), bg = parseColor(background);
  return { id: 'private-run-token', elementRef: 'private-element-token', tagName: 'p', selector: '#private-user-attribute', fontSizeCssPx: size, fontWeight: 400, foreground: fg, background: bg, effectiveBackground: bg.rgba, ownOpaqueBackground: true, reasons: [], contrast: evaluateContrast({ foreground: fg.rgba, background: bg.rgba, fontSizeCssPx: size, fontWeight: 400 }), fontSize: evaluateFontSize(size) };
}
export function fixtureSnapshot(run = fixtureRun()): Snapshot {
  return { id: 'snapshot-1', document: { windowId: 42, tabId: 88, frameId: 0, documentToken: 'private-document-token' }, elementRef: run.elementRef, tagName: 'p', selector: run.selector, measuredAt: '2026-10-18T12:00:00.000Z', viewport: { width: 1280, height: 800 }, stale: false, reasons: ['main-document-only'], styles: { colors: { color: run.foreground.raw, 'background-color': run.background.raw }, typography: { 'font-family': '"Example Sans", sans-serif', 'font-size': `${run.fontSizeCssPx}px`, 'font-weight': '400', 'line-height': '18px' }, layout: { display: 'inline-flex', 'box-sizing': 'border-box', width: '160px', 'padding-top': '16px', 'padding-right': '24px', 'border-top-width': '1px', 'border-top-style': 'solid' } }, textRuns: [run], rect: { x: 10, y: 20, width: 200, height: 50 } };
}
export function fixtureAudit(runs = [fixtureRun()]): Audit {
  const snapshot = fixtureSnapshot(runs[0]);
  return { id: 'audit-1', document: snapshot.document, measuredAt: snapshot.measuredAt, viewport: snapshot.viewport, target: 'AA', status: 'complete', stale: false, scanned: runs.length, skipped: 2, total: runs.length + 2, reasons: ['main-document-only'], runs, palette: [parseColor('#aaaaaa'), parseColor('#ffffff'), parseColor('rgb(170 170 170)')], fonts: ['"Example Sans", sans-serif'], counts: summarizeRuns(runs) };
}
