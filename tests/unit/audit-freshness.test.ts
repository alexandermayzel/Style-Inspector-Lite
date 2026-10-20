import test from 'node:test';
import assert from 'node:assert/strict';
import { auditMeasurementsChanged, evaluateRun } from '../../src/core/contrast';
import { fixtureAudit, fixtureRun, fixtureSnapshot } from '../fixtures/export/data';

test('inspection detects changed paint evidence without replacing the audit measurement', () => {
  const original = fixtureRun('#fff', '#232f3e', 14);
  original.reasons = ['overlapping-element'];
  const audit = fixtureAudit([evaluateRun(original, 'AA')]);
  const before = structuredClone(audit);
  const snapshot = fixtureSnapshot(evaluateRun({ ...original, reasons: [] }, 'AA'));
  assert.equal(auditMeasurementsChanged(audit, snapshot), true);
  assert.equal(snapshot.textRuns[0]!.contrast.ratio, 13.569124702898852);
  assert.deepEqual(audit, before);
});

test('target preferences, equivalent CSS spelling and unrelated elements do not stale an audit', () => {
  const run = fixtureRun('#666', '#fff', 16);
  const audit = fixtureAudit([run]);
  const snapshot = fixtureSnapshot(evaluateRun(run, 'AAA'));
  snapshot.textRuns[0]!.foreground = { ...run.foreground, raw: 'rgb(102, 102, 102)' };
  assert.equal(auditMeasurementsChanged(audit, snapshot), false);
  snapshot.elementRef = 'other'; snapshot.textRuns[0] = { ...snapshot.textRuns[0]!, id: 'other:text1', elementRef: 'other' };
  assert.equal(auditMeasurementsChanged(audit, snapshot), false);
});

test('actual colors, gradient bounds, font sizes and lost direct runs invalidate prior measurements', () => {
  const run = fixtureRun('#666', '#fff', 16), audit = fixtureAudit([run]);
  for (const change of [
    { effectiveBackground: { r: 240, g: 240, b: 240, a: 1 } },
    { fontSizeCssPx: 11 },
    { foregroundSource: 'text-fill' as const },
    { backgroundRange: { min: { r: 230, g: 230, b: 230, a: 1 }, max: { r: 255, g: 255, b: 255, a: 1 } } },
  ]) assert.equal(auditMeasurementsChanged(audit, fixtureSnapshot({ ...run, ...change })), true);
  const snapshot = fixtureSnapshot(run); snapshot.textRuns = [];
  assert.equal(auditMeasurementsChanged(audit, snapshot), true);
  snapshot.reasons = ['selection-text-limit'];
  assert.equal(auditMeasurementsChanged(audit, snapshot), false);
});

test('text fill presence invalidates matching colors when the correction export must change', () => {
  const run = fixtureRun('#666', '#fff', 16);
  const withFill = { ...run, textFillPresent: true };
  assert.equal(auditMeasurementsChanged(fixtureAudit([run]), fixtureSnapshot(withFill)), true);
  assert.equal(auditMeasurementsChanged(fixtureAudit([withFill]), fixtureSnapshot(run)), true);
  assert.equal(auditMeasurementsChanged(fixtureAudit([withFill]), fixtureSnapshot(withFill)), false);
  assert.equal(auditMeasurementsChanged(fixtureAudit([run]), fixtureSnapshot({ ...run, textFillPresent: false })), false, 'Absent optional metadata means no observed fill property');
});

test('running scans detect contradictions only in already measured inputs', () => {
  const run = fixtureRun('#666', '#fff', 16), audit = { ...fixtureAudit([run]), status: 'running' as const };
  assert.equal(auditMeasurementsChanged(audit, fixtureSnapshot({ ...run, reasons: ['overlapping-element'] })), true);
  assert.equal(auditMeasurementsChanged(audit, fixtureSnapshot(run)), false);
  const unscanned = fixtureSnapshot({ ...run, id: 'later:text1', elementRef: 'later' });
  unscanned.elementRef = 'later';
  assert.equal(auditMeasurementsChanged(audit, unscanned), false);
  const moreRuns = fixtureSnapshot(run);
  moreRuns.textRuns.push({ ...run, id: `${run.elementRef}:later` });
  assert.equal(auditMeasurementsChanged(audit, moreRuns), false, 'An unfinished inventory does not prove missing direct runs');
  moreRuns.textRuns = [];
  assert.equal(auditMeasurementsChanged(audit, moreRuns), false);
});

test('stale selections and different documents cannot reconcile audit freshness', () => {
  const run = fixtureRun('#666', '#fff', 16), audit = fixtureAudit([run]);
  const snapshot = fixtureSnapshot({ ...run, reasons: ['overlapping-element'] });
  assert.equal(auditMeasurementsChanged(audit, { ...snapshot, stale: true }), false);
  for (const key of ['documentToken', 'tabId', 'windowId', 'frameId'] as const) {
    const foreign = structuredClone(snapshot);
    if (key === 'documentToken') foreign.document[key] += '-different'; else foreign.document[key]++;
    assert.equal(auditMeasurementsChanged(audit, foreign), false);
  }
});

test('completed follow-up inventories detect disappeared direct runs without guessing from truncated scans', () => {
  const run = fixtureRun(), snapshot = fixtureSnapshot(run);
  const audit = fixtureAudit([]);
  assert.equal(auditMeasurementsChanged(audit, snapshot), false, 'Ordinary unrelated selections do not trigger scans');
  assert.equal(auditMeasurementsChanged(audit, snapshot, true), true);
  for (const status of ['running', 'partial', 'cancelled'] as const) {
    assert.equal(auditMeasurementsChanged({ ...audit, status }, snapshot, true), false);
  }
  const replacement = fixtureSnapshot({ ...run, id: 'different-text-node' });
  assert.equal(auditMeasurementsChanged(fixtureAudit([run]), replacement), true, 'The same count does not establish the same text nodes');
});

test('an already stale audit still detects real evidence changes without patching ordinal rows', () => {
  const first = fixtureRun('#fafafa', '#161717', 16);
  first.reasons = ['layered-background'];
  const audit = fixtureAudit([evaluateRun(first, 'AA')]); audit.stale = true;
  const original = structuredClone(audit);
  const selected = fixtureSnapshot(evaluateRun({ ...first, reasons: [] }, 'AA'));
  assert.equal(auditMeasurementsChanged(audit, selected), true);
  assert.equal(selected.textRuns[0]!.contrast.ratio, 17.210166562311272);
  assert.deepEqual(audit, original, 'The caller rebuilds the whole scan; comparison never merges textN records');
  assert.equal(auditMeasurementsChanged(audit, fixtureSnapshot(audit.runs[0]!)), false, 'Staleness alone is not a refresh trigger');
});

test('complete follow-ups detect lost descendant identities only for owners proven in the preceding audit', () => {
  const run = fixtureRun(), selected = fixtureSnapshot(run);
  selected.elementRef = 'selected-container';
  const references = new Set([run.elementRef]);
  const empty = fixtureAudit([]);
  assert.equal(auditMeasurementsChanged(empty, selected, true, references), true);
  const replacement = fixtureAudit([{ ...run, id: 'replacement-text-object' }]);
  assert.equal(auditMeasurementsChanged(replacement, selected, true, references), true, 'Equal counts cannot substitute a different descendant Text object');
  assert.equal(auditMeasurementsChanged(fixtureAudit([run]), selected, true, references), false);
  assert.equal(auditMeasurementsChanged(empty, selected, false, references), false, 'An unrelated ordinary selection does not start a scan');
  assert.equal(auditMeasurementsChanged(empty, selected, true, new Set(['unrelated-owner'])), false, 'Unknown or shadow-root owners have no page-audit inventory');
  assert.equal(auditMeasurementsChanged(empty, selected, true), false, 'Missing prior scope evidence cannot prove descendant loss');
  assert.equal(auditMeasurementsChanged(empty, { ...selected, reasons: ['selection-text-limit'] }, true, references), false);
  for (const status of ['running', 'partial', 'cancelled'] as const) {
    assert.equal(auditMeasurementsChanged({ ...empty, status }, selected, true, references), false);
  }
});
