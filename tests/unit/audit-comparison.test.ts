import test from 'node:test';
import assert from 'node:assert/strict';
import { compareAudits, type AuditComparison } from '../../src/core/audit-comparison';
import type { Audit, TextRun } from '../../src/core/types';
import { fixtureAudit, fixtureRun } from '../fixtures/export/data';

const run = (id: string, foreground = '#000000', size = 16): TextRun => ({ ...fixtureRun(foreground, '#ffffff', size), id, elementRef: `element-${id}` });
const audit = (id: string, runs: TextRun[]): Audit => ({ ...fixtureAudit(runs), id, scope: 'page' });
const valid = (value: AuditComparison) => { if (!value.comparable) throw Error(value.reason); return value; };

test('comparison preserves conservative gradient minimum semantics independently of font findings', () => {
  const before = audit('before', [run('gradient', '#aaaaaa', 11)]);
  const afterRun = run('gradient', '#000000', 12);
  afterRun.effectiveBackground = null;
  afterRun.backgroundRange = { min: { r: 230, g: 230, b: 230, a: 1 }, max: { r: 255, g: 255, b: 255, a: 1 } };
  const result = valid(compareAudits(before, audit('after', [afterRun])));
  const contrast = result.changes.find(change => change.ruleId === 'text.contrast')!;
  assert.equal(contrast.kind, 'resolved'); assert.equal(contrast.after!.ratioKind, 'minimum');
  assert.ok(contrast.after!.ratio! > 16); assert.ok(contrast.after!.ratio! < 21);
  assert.equal(contrast.before!.ratioKind, undefined);
  assert.equal(result.changes.find(change => change.ruleId === 'text.font-size-min')!.after!.ratioKind, undefined);
});

test('manual audit comparison classifies rule-level findings and preserves measured ratios and sizes', () => {
  const before = audit('before', [run('resolved', '#aaaaaa'), run('persistent', '#aaaaaa'), run('new'), run('size', '#000000', 11)]);
  const after = audit('after', [run('resolved'), run('persistent', '#999999'), run('new', '#aaaaaa'), run('size', '#000000', 12), run('added', '#aaaaaa')]);
  before.stale = true;
  const beforeCopy = structuredClone(before), afterCopy = structuredClone(after), result = valid(compareAudits(before, after));
  assert.deepEqual(result.counts, { new: 2, resolved: 2, persistent: 1, unassessed: 0 });
  assert.equal(result.changes.find(change => change.runId === 'size')!.ruleId, 'text.font-size-min');
  assert.equal(result.changes.find(change => change.runId === 'size')!.before!.sizeCssPx, 11);
  assert.equal(result.changes.find(change => change.runId === 'resolved')!.after!.ratio, 21);
  assert.equal(result.changes.find(change => change.runId === 'added')!.before, null);
  assert.equal(result.previousId, 'before'); assert.equal(result.currentId, 'after');
  assert.deepEqual(before, beforeCopy); assert.deepEqual(after, afterCopy);
});

test('removed, hidden and unresolved failures are unassessed instead of repaired', () => {
  const before = audit('before', [run('removed', '#aaaaaa'), run('hidden', '#aaaaaa'), run('manual', '#aaaaaa'), { ...run('unknown'), reasons: ['layered-background'] }]);
  const after = audit('after', [{ ...run('hidden'), notApplicable: 'invisible' }, { ...run('manual'), reasons: ['layered-background'] }, run('unknown')]);
  const result = valid(compareAudits(before, after));
  assert.equal(result.counts.resolved, 0);
  assert.equal(result.counts.unassessed, 4);
  assert.equal(result.changes.find(change => change.runId === 'removed')!.after, null);
  assert.equal(result.changes.find(change => change.runId === 'hidden')!.after!.status, 'not-applicable');
  assert.equal(result.changes.find(change => change.runId === 'manual')!.after!.status, 'manual');
});

test('comparison reassesses both measurements under one chosen target instead of trusting old verdicts', () => {
  const before = audit('before', [run('same', '#767676')]), after = audit('after', [run('same')]);
  before.runs[0].contrast.status = 'fail'; before.target = 'AAA';
  assert.deepEqual(valid(compareAudits(before, after, 'AA')).counts, { new: 0, resolved: 0, persistent: 0, unassessed: 0 });
  assert.deepEqual(valid(compareAudits(before, after, 'AAA')).counts, { new: 0, resolved: 1, persistent: 0, unassessed: 0 });
  const newlyMeasurable = valid(compareAudits(audit('old', [{ ...run('same'), reasons: ['layered-background'] }]), audit('new', [run('same', '#aaaaaa')])));
  assert.equal(newlyMeasurable.changes[0].kind, 'new', 'A new finding means newly observed failure, not proof of when it was caused');
  assert.equal(newlyMeasurable.changes[0].before!.status, 'manual');
});

test('comparison requires complete current evidence, document identity and equivalent measured scopes', () => {
  const before = audit('before', [run('same')]), after = audit('after', [run('same')]);
  const invalid = (patch: Partial<Audit>, reason: string) => assert.deepEqual(compareAudits(before, { ...after, ...patch }), { comparable: false, reason });
  for (const status of ['running', 'partial', 'cancelled'] as const) invalid({ status }, 'incomplete');
  assert.deepEqual(compareAudits({ ...before, status: 'partial' }, after), { comparable: false, reason: 'incomplete' });
  invalid({ stale: true }, 'stale-current');
  for (const field of ['documentToken', 'tabId', 'windowId', 'frameId'] as const) {
    const document = { ...after.document, [field]: field === 'documentToken' ? 'another-document' : 999 };
    invalid({ document }, 'document');
  }
  invalid({ scope: 'viewport' }, 'scope'); invalid({ scope: undefined }, 'scope');
  invalid({ viewport: { width: 1281, height: 800 } }, 'viewport');
  invalid({ viewport: { ...after.viewport, devicePixelRatio: 2 } }, 'viewport');
  const selectedBefore = { ...before, scope: 'selection' as const, rootElementRef: 'section-a' };
  assert.equal(valid(compareAudits(selectedBefore, { ...after, scope: 'selection', rootElementRef: 'section-a' })).changes.length, 0);
  assert.deepEqual(compareAudits(selectedBefore, { ...after, scope: 'selection', rootElementRef: 'section-b' }), { comparable: false, reason: 'selection-root' });
});

test('viewport comparisons require identical initial viewport bounds including scroll position', () => {
  const before = { ...audit('before', [run('same')]), scope: 'viewport' as const, scopeViewport: { left: 0, top: 500, width: 1280, height: 800 } };
  const after = { ...before, id: 'after' };
  assert.equal(valid(compareAudits(before, after)).changes.length, 0);
  for (const field of ['left', 'top', 'width', 'height'] as const) {
    assert.deepEqual(compareAudits(before, { ...after, scopeViewport: { ...after.scopeViewport, [field]: after.scopeViewport[field] + 1 } }), { comparable: false, reason: 'viewport' });
  }
  assert.deepEqual(compareAudits(before, { ...after, scopeViewport: undefined }), { comparable: false, reason: 'viewport' });
});

test('invalid or reused run identities cannot create misleading resolved findings', () => {
  const before = audit('before', [run('same', '#aaaaaa')]);
  for (const runs of [[run('same'), run('same')], [{ ...run('same'), id: '' }], [{ ...run('same'), elementRef: 'changed-owner' }], [{ ...run('same'), textSource: 'placeholder' as const }]]) {
    assert.deepEqual(compareAudits(before, audit('after', runs)), { comparable: false, reason: 'run-identity' });
  }
  assert.deepEqual(compareAudits(audit('before', [run('same'), run('same')]), audit('after', [])), { comparable: false, reason: 'run-identity' });
});

test('comparison remains bounded and contains no text excerpts, selectors or mutable run references', () => {
  const runs = Array.from({ length: 1000 }, (_, index) => run(`old-${index}`, '#aaaaaa', 11));
  const next = Array.from({ length: 1000 }, (_, index) => run(`new-${index}`, '#aaaaaa', 11));
  const before = audit('before', runs), after = audit('after', next);
  Object.defineProperty(runs[0], 'textExcerpt', { get() { throw Error('Do not read private excerpts'); } });
  Object.defineProperty(runs[0], 'selector', { get() { throw Error('Do not read selectors'); }, enumerable: false });
  const result = valid(compareAudits(before, after));
  assert.deepEqual(result.counts, { new: 2000, resolved: 0, persistent: 0, unassessed: 2000 });
  assert.equal(result.changes.length, 4000);
  assert.doesNotMatch(JSON.stringify(result), /textExcerpt|selector|tagName/);
  result.changes[0].after!.sizeCssPx = 200;
  assert.equal(next[0].fontSizeCssPx, 11);
});
