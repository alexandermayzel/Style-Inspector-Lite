import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, settingsRecord, validateSettings } from '../../src/runtime/settings';
import { AnalysisBudget, boundedSession, emptySession, identityMatches, restoreAuthorizations, safeFilename, type DocumentRecord } from '../../src/runtime/state';
import { randomId } from '../../src/runtime/id';
import { fixtureAudit, fixtureSnapshot } from '../fixtures/export/data';

test('settings validate all choices, migrate legacy targets and reject corrupt values', () => {
  assert.deepEqual(validateSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(validateSettings({ target: 'AAA' }).contrastTarget, 'AAA');
  assert.equal(validateSettings({ contrastTarget: 'garbage', livePreview: 0 }).contrastTarget, 'AA');
  assert.equal(validateSettings({ contrastTarget: 'garbage', livePreview: 0 }).livePreview, true);
  const custom = { ...DEFAULT_SETTINGS, appearance: 'dark' as const, colorFormat: 'hsl' as const, contrastTarget: 'AAA' as const, livePreview: false, contextMenuEnabled: false, showDiagnostics: true };
  assert.deepEqual(validateSettings(settingsRecord(custom)), custom);
  assert.deepEqual(Object.keys(validateSettings({ analysis: 'must not persist', appearance: 'evil' })).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});

test('diagnostic controls default off for existing preferences and reject non-boolean opt-ins', () => {
  for (const showDiagnostics of [undefined, null, false, 1, 'true', [], {}, new Boolean(true)]) {
    assert.equal(validateSettings({ showDiagnostics }).showDiagnostics, false);
    assert.equal(validateSettings({ values: { showDiagnostics } }).showDiagnostics, false);
  }
  assert.equal(validateSettings({ values: { appearance: 'dark' } }).showDiagnostics, false);
  assert.equal(validateSettings(settingsRecord({ ...DEFAULT_SETTINGS, showDiagnostics: true })).showDiagnostics, true);
});

test('stored setting choices reject coercible arrays and objects instead of returning invalid enums', () => {
  for (const wrap of [(value: string) => [value], (value: string) => new String(value)]) {
    assert.deepEqual(validateSettings({ values: { appearance: wrap('dark'), colorFormat: wrap('hsl'), contrastTarget: wrap('AAA') } }), DEFAULT_SETTINGS);
    assert.equal(validateSettings({ target: wrap('AAA') }).contrastTarget, 'AA');
  }
  // Corrupt structured-clone data may shadow Object.prototype.toString.
  const invalid = { toString: null };
  assert.deepEqual(validateSettings({ appearance: invalid, colorFormat: invalid, target: invalid }), DEFAULT_SETTINGS);
});

test('document identity prevents same URL reload and cross-window confusion', () => {
  const record: DocumentRecord = { windowId: 1, tabId: 3, documentToken: 'document-a', touchedAt: 1, selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' };
  assert.equal(identityMatches(record, 1, 3, 'document-a'), true);
  assert.equal(identityMatches(record, 1, 3, 'document-b'), false);
  assert.equal(identityMatches(record, 2, 3, 'document-a'), false);
  assert.equal(identityMatches(record, 1, 4, 'document-a'), false);
});

test('authorization bounds are independent of analysis slots and do not modify source state', () => {
  const session = emptySession();
  for (let id = 1; id <= 15; id++) session.documents[id] = { windowId: 1, tabId: id, documentToken: `d${id}`, touchedAt: id, selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' };
  const bounded = boundedSession(session);
  assert.equal(Object.keys(bounded.documents).length, 15);
  assert.equal(Object.keys(session.documents).length, 15);
  assert.ok(bounded.documents['1']);
  assert.ok(bounded.documents['15']);
  assert.ok(new TextEncoder().encode(JSON.stringify(boundedSession(session, 500))).length <= 500);
});

test('session storage excludes all measurements without mutating live selections', () => {
  const selected = fixtureSnapshot();
  selected.textExcerpt = { value: 'selected-secret', truncated: false };
  selected.textRuns[0]!.textExcerpt = { value: 'run-secret', truncated: false };
  const audit = fixtureAudit(selected.textRuns);
  const session = emptySession();
  session.documents['1'] = { windowId: 1, tabId: 1, documentToken: 'd', touchedAt: 1, selected, audit, picker: false, selectionRequest: '', auditRequest: '' };
  const saved = boundedSession(session);
  assert.doesNotMatch(JSON.stringify(saved), /selected-secret|run-secret|textExcerpt/);
  assert.deepEqual(Object.keys(saved.documents['1']!).sort(), ['documentToken', 'tabId', 'touchedAt', 'windowId']);
  assert.doesNotMatch(JSON.stringify(saved), /textRuns|palette|contrast|selected|audit|previousAudit/);
  assert.equal(selected.textExcerpt.value, 'selected-secret');
  assert.equal(selected.textRuns[0]!.textExcerpt!.value, 'run-secret');
});

test('authorization serialization never traverses measurements and accounts for UTF-8 metadata', () => {
  const session = emptySession();
  for (let id = 1; id <= 15; id++) session.documents[id] = { windowId: 1, tabId: id, documentToken: `d${id}`, touchedAt: id, selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' };
  Object.defineProperty(session.documents['1'], 'audit', { enumerable: true, get() { throw new Error('Evicted analysis must not be traversed'); } });
  session.documents['15']!.documentToken = 'Mehrbyte-🙂-文字';
  const bounded = boundedSession(session);
  assert.equal(Object.keys(bounded.documents).length, 15);
  const bytes = new TextEncoder().encode(JSON.stringify(bounded)).byteLength;
  assert.deepEqual(boundedSession(session, bytes), bounded);
  assert.equal(Object.keys(boundedSession(session, bytes - 1).documents).length, 14);
  bounded.documents['15']!.documentToken = 'changed';
  assert.equal(session.documents['15']!.documentToken, 'Mehrbyte-🙂-文字');
});

test('live budget frees old analysis but preserves authorization identities and request generations', () => {
  const session = emptySession(), budget = new AnalysisBudget();
  for (let id = 1; id <= 15; id++) session.documents[id] = { windowId: id, tabId: id, documentToken: `d${id}`, touchedAt: id, selected: fixtureSnapshot(), audit: fixtureAudit(), picker: false, selectionRequest: `s${id}`, auditRequest: `a${id}` };
  const removed = budget.trim(session);
  assert.deepEqual(removed.map(record => record.tabId), [3, 2, 1]);
  assert.equal(Object.keys(session.documents).length, 15);
  assert.equal(session.documents['1']!.selected, null);
  assert.equal(session.documents['1']!.audit, null);
  assert.equal(identityMatches(session.documents['1'], 1, 1, 'd1'), true);
  assert.equal(session.documents['1']!.selectionRequest, 's1');
  assert.equal(session.documents['1']!.auditRequest, 'a1');
  assert.ok(session.documents['15']!.selected);
  assert.deepEqual(budget.trim(session), []);
});

test('live byte budget counts excerpts and invalidates cached size after run reassessment', () => {
  const session = emptySession(), budget = new AnalysisBudget();
  const selected = fixtureSnapshot();
  session.documents['1'] = { windowId: 1, tabId: 1, documentToken: 'd', touchedAt: 1, selected, audit: null, picker: false, selectionRequest: 's', auditRequest: 'a' };
  assert.deepEqual(budget.trim(session, 10_000), []);
  selected.textRuns = [{ ...selected.textRuns[0]!, textExcerpt: { value: '界'.repeat(4000), truncated: false } }];
  assert.equal(budget.trim(session, 10_000).length, 1);
  assert.equal(session.documents['1']!.selected, null);
});

test('comparison history shares the live budget and is dropped before current measurements', () => {
  const session = emptySession(), budget = new AnalysisBudget();
  const record: DocumentRecord = { windowId: 1, tabId: 1, documentToken: 'd', touchedAt: 1, selected: null, audit: fixtureAudit(), previousAudit: fixtureAudit(), picker: false, selectionRequest: 's', auditRequest: 'a' };
  session.documents['1'] = record;
  const combined = budget.estimate(record);
  record.previousAudit = null;
  const current = budget.estimate(record);
  assert.ok(combined > current);
  record.previousAudit = fixtureAudit();
  assert.deepEqual(budget.trim(session, current), [record]);
  assert.ok(record.audit); assert.equal(record.previousAudit, null);
  assert.equal(budget.estimate(record), current);
  assert.deepEqual(budget.trim(session, current), []);
  record.previousAudit = fixtureAudit();
  assert.equal(budget.trim(session, current, 0).length, 1);
  assert.equal(record.audit, null); assert.equal(record.previousAudit, null);
});

test('comparison history is memory only and legacy data migrates without page payloads', () => {
  const session = emptySession(), audit = fixtureAudit();
  audit.runs[0]!.textExcerpt = { value: 'previous-secret', truncated: false };
  session.documents['1'] = { windowId: 1, tabId: 1, documentToken: 'd', touchedAt: 1, selected: null, audit: null, previousAudit: audit, picker: false, selectionRequest: '', auditRequest: '' };
  const saved = boundedSession(session);
  assert.equal('previousAudit' in saved.documents['1']!, false);
  assert.doesNotMatch(JSON.stringify(saved), /previous-secret|textExcerpt/);
  const bytes = new TextEncoder().encode(JSON.stringify(saved)).byteLength;
  assert.equal(Object.keys(boundedSession(session, bytes - 1).documents).length, 0);
  assert.equal(audit.runs[0]!.textExcerpt!.value, 'previous-secret');
  const restored = restoreAuthorizations(session);
  assert.equal(restored.documents['1']!.previousAudit, null);
  assert.equal(restored.documents['1']!.audit, null);
  assert.equal(restored.documents['1']!.selected, null);
  assert.equal(restored.documents['1']!.auditRequest, '');
  assert.deepEqual(boundedSession(restored), saved);
});

test('authorization migration rejects corrupt identities and bounds separately from analysis', () => {
  assert.deepEqual(restoreAuthorizations({ schemaVersion: 2, epoch: -1, documents: {} }), emptySession());
  const documents = Object.fromEntries(Array.from({ length: 170 }, (_, i) => [i, { windowId: 1, tabId: i, documentToken: `d${i}`, touchedAt: i }]));
  const restored = restoreAuthorizations({ schemaVersion: 2, epoch: 5, documents });
  assert.equal(Object.keys(restored.documents).length, 160);
  assert.equal(restored.documents['9'], undefined);
  assert.equal(restored.epoch, 5);
  assert.deepEqual(restoreAuthorizations({ schemaVersion: 2, epoch: 0, documents: { '10': { windowId: 1, tabId: '10', documentToken: 'd', touchedAt: 5 } } }), emptySession());
});

test('live analysis never evicts protected work or counts empty authorized tabs as analyses', () => {
  const session = emptySession(), budget = new AnalysisBudget();
  for (let id = 1; id <= 20; id++) session.documents[id] = { windowId: 1, tabId: id, documentToken: `d${id}`, touchedAt: id, selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' };
  session.documents['1']!.audit = fixtureAudit();
  assert.deepEqual(budget.trim(session), []);
  session.documents['2']!.selected = fixtureSnapshot();
  assert.deepEqual(budget.trim(session, 1, 0, record => record.tabId === 1), [session.documents['2']]);
  assert.ok(session.documents['1']!.audit);
  assert.equal(session.documents['2']!.selected, null);
});

test('download filenames allow actual serializer formats and reject page-derived paths', () => {
  for (const name of ['style-inspector-lite-element-all.css', 'style-inspector-lite-contrast-suggestion.scss', 'style-inspector-lite-page-tokens.theme.css', 'style-inspector-lite-element-all.tailwind.txt', 'style-inspector-lite-audit.json']) assert.equal(safeFilename(name), true);
  for (const name of ['../secret.css', 'style-inspector-lite-../../evil.css', 'C:\\secret.json', 'style-inspector-lite-a.css.exe', 'style-inspector-lite-a?query.css', 'style-inspector-lite-x.svg', 'style-inspector-lite-a\n.css']) assert.equal(safeFilename(name), false);
});

test('HTTP-compatible identity generation does not depend on randomUUID', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (bytes: Uint8Array) => bytes.fill(171) } });
  try { assert.equal(randomId(), 'ab'.repeat(16)); }
  finally { if (previous) Object.defineProperty(globalThis, 'crypto', previous); }
});
