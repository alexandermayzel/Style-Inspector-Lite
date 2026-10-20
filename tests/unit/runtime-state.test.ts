import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, settingsRecord, validateSettings } from '../../src/runtime/settings';
import { boundedSession, emptySession, identityMatches, safeFilename, type DocumentRecord } from '../../src/runtime/state';
import { randomId } from '../../src/runtime/id';
import { fixtureAudit, fixtureSnapshot } from '../fixtures/export/data';

test('settings validate all five choices, migrate legacy targets and reject corrupt values', () => {
  assert.deepEqual(validateSettings(undefined), DEFAULT_SETTINGS);
  assert.equal(validateSettings({ target: 'AAA' }).contrastTarget, 'AAA');
  assert.equal(validateSettings({ contrastTarget: 'garbage', livePreview: 0 }).contrastTarget, 'AA');
  assert.equal(validateSettings({ contrastTarget: 'garbage', livePreview: 0 }).livePreview, true);
  const custom = { ...DEFAULT_SETTINGS, appearance: 'dark' as const, colorFormat: 'hsl' as const, contrastTarget: 'AAA' as const, livePreview: false, contextMenuEnabled: false };
  assert.deepEqual(validateSettings(settingsRecord(custom)), custom);
  assert.deepEqual(Object.keys(validateSettings({ analysis: 'must not persist', appearance: 'evil' })).sort(), Object.keys(DEFAULT_SETTINGS).sort());
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

test('session bounds remove oldest snapshots without modifying source state', () => {
  const session = emptySession();
  for (let id = 1; id <= 15; id++) session.documents[id] = { windowId: 1, tabId: id, documentToken: `d${id}`, touchedAt: id, selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' };
  const bounded = boundedSession(session);
  assert.equal(Object.keys(bounded.documents).length, 12);
  assert.equal(Object.keys(session.documents).length, 15);
  assert.equal(bounded.documents['1'], undefined);
  assert.ok(bounded.documents['15']);
  assert.ok(new TextEncoder().encode(JSON.stringify(boundedSession(session, 500))).length <= 500);
});

test('session storage strips selected text excerpts without mutating live selection or measurements', () => {
  const selected = fixtureSnapshot();
  selected.textExcerpt = { value: 'selected-secret', truncated: false };
  selected.textRuns[0]!.textExcerpt = { value: 'run-secret', truncated: false };
  const audit = fixtureAudit(selected.textRuns);
  const session = emptySession();
  session.documents['1'] = { windowId: 1, tabId: 1, documentToken: 'd', touchedAt: 1, selected, audit, picker: false, selectionRequest: '', auditRequest: '' };
  const saved = boundedSession(session);
  assert.doesNotMatch(JSON.stringify(saved), /selected-secret|run-secret|textExcerpt/);
  assert.equal(saved.documents['1']!.selected!.textRuns[0]!.contrast.ratio, selected.textRuns[0]!.contrast.ratio);
  assert.equal(selected.textExcerpt.value, 'selected-secret');
  assert.equal(selected.textRuns[0]!.textExcerpt!.value, 'run-secret');
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
