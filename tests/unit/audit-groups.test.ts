import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAuditRuns } from '../../src/core/audit-groups';
import { evaluateRun } from '../../src/core/contrast';
import { fixtureRun } from '../fixtures/export/data';

test('identical measurements group without losing references, order, or changing inputs', () => {
  const first = fixtureRun();
  const second = { ...first, id: 'second', elementRef: 'second', tagName: 'a', selector: 'a:nth-of-type(2)' };
  const different = fixtureRun('#000', '#FFF', 24);
  const input = [first, different, second], before = structuredClone(input);
  const groups = groupAuditRuns(input);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].representative, first);
  assert.deepEqual(groups[0].runs.map(run => run.elementRef), [first.elementRef, 'second']);
  assert.deepEqual(input, before);
  assert.equal(groupAuditRuns([second])[0].id, groups[0].id, 'Group identity is independent of pagination/order');
  assert.deepEqual(groupAuditRuns([]), []);
});

test('real measurements, CSS pairs, unknown colors, gradient minima and exemptions never share a group', () => {
  const exact = fixtureRun('#000', '#FFF', 16);
  const css = evaluateRun({ ...exact, reasons: ['overlapping-element'] }, 'AA');
  const missing = evaluateRun({ ...css, effectiveBackground: null }, 'AA');
  const exempt = evaluateRun({ ...exact, notApplicable: 'inactive-control' }, 'AA');
  const gradient = { ...exact, contrast: { ...exact.contrast, ratioKind: 'minimum' as const } };
  assert.equal(groupAuditRuns([exact, css, missing, exempt, gradient]).length, 5);
  const same = { ...missing, id: 'other', elementRef: 'other' };
  assert.equal(groupAuditRuns([missing, same]).length, 1);
  const otherReason = evaluateRun({ ...missing, reasons: ['unsupported-color'] }, 'AA');
  assert.equal(groupAuditRuns([missing, otherReason]).length, 2);
});

test('group identity keeps exact color precision, typography thresholds, all reasons and placeholder meaning', () => {
  const exact = fixtureRun('#000', '#FFF', 16);
  const roundedTwin = evaluateRun({ ...exact, foreground: { raw: 'rgb(0.0001 0 0)', rgba: { r: 0.0001, g: 0, b: 0, a: 1 } } }, 'AA');
  const bold = evaluateRun({ ...exact, fontWeight: 700 }, 'AA');
  const placeholder = { ...exact, textSource: 'placeholder' as const };
  const multi = evaluateRun({ ...exact, reasons: ['overlapping-element', 'group-opacity'] }, 'AA');
  const reordered = { ...multi, reasons: ['group-opacity', 'overlapping-element', 'group-opacity'] };
  assert.equal(groupAuditRuns([exact, roundedTwin, bold, placeholder, multi]).length, 5);
  assert.equal(groupAuditRuns([multi, reordered]).length, 1);
  const other = evaluateRun({ ...multi, reasons: ['overlapping-element', 'filter'] }, 'AA');
  assert.equal(groupAuditRuns([multi, other]).length, 2);
});

test('equal ratios retain different viewport coverage when results are grouped', () => {
  const full = fixtureRun('#000', '#FFF', 16);
  const partial = { ...full, id: 'partial', elementRef: 'partial', viewportPartial: true as const };
  const secondPartial = { ...partial, id: 'second-partial', elementRef: 'second-partial' };
  const groups = groupAuditRuns([full, partial, secondPartial]);
  assert.equal(groups.length, 2, 'A full measurement cannot stand in for a partly measured Text node');
  assert.equal(groups[0].representative.viewportPartial, undefined);
  assert.equal(groups[1].representative.viewportPartial, true);
  assert.deepEqual(groups[1].runs.map(run => run.id), ['partial', 'second-partial']);
});
