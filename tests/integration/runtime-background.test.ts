import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { diagnosticMeasurement, type DiagnosticReport } from '../../src/core/diagnostics';
import { evaluateContrast, evaluateFontSize } from '../../src/core/contrast';
import { parseColor } from '../../src/core/colors';
import type { TextRun } from '../../src/core/types';

class Event<T extends (...args: any[]) => any = (...args: any[]) => any> {
  listeners: T[] = [];
  addListener = (listener: T) => { this.listeners.push(listener); };
  removeListener = (listener: T) => { this.listeners = this.listeners.filter(item => item !== listener); };
  hasListener = (listener: T) => this.listeners.includes(listener);
  emit(...args: Parameters<T>) { return this.listeners.map(listener => listener(...args)); }
}
const bundle = build({ entryPoints: ['src/background.ts'], bundle: true, write: false, format: 'iife', platform: 'browser' });
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
const auditIntent = (state: any) => ({ expectedTabId: state.tabId, expectedDocumentToken: state.documentToken, expectedRevision: state.documentRevision });

async function fixture(beforeStart?: (api: any, local: Record<string, any>, session: Record<string, any>) => void) {
  const calls: { kind: string; detail?: any }[] = [];
  const local: Record<string, any> = {}, session: Record<string, any> = {};
  const tabs = new Map<number, any>([[10, { id: 10, windowId: 1, url: 'https://example.com/', active: true }], [20, { id: 20, windowId: 2, url: 'https://other.example/', active: true }]]);
  const documents = new Map<number, { token: string; selected: any; audit?: any; coordinatorToken?: string; selectionRequest?: string; auditRequest?: string }>();
  function storage(data: Record<string, any>, kind: string) {
    return { get: async (key: string) => ({ [key]: structuredClone(data[key]) }), set: async (value: object) => { Object.assign(data, structuredClone(value)); calls.push({ kind, detail: value }); }, remove: async (key: string) => { delete data[key]; } };
  }
  const api: any = {
    runtime: { id: 'test-addon', getURL: (path: string) => `moz-extension://test/${path}`, onConnect: new Event(), onMessage: new Event(), onInstalled: new Event(), onStartup: new Event() },
    storage: { local: storage(local, 'local-write'), session: storage(session, 'session-write'), onChanged: new Event() },
    sidebarAction: { open: () => { calls.push({ kind: 'open' }); return Promise.resolve(); } },
    action: { onClicked: new Event() },
    menus: { onClicked: new Event(), create: (detail: any) => { calls.push({ kind: 'menu-create', detail }); }, remove: async () => { calls.push({ kind: 'menu-remove' }); } },
    i18n: { getMessage: (key: string) => key },
    scripting: { executeScript: async (detail: any) => {
      calls.push({ kind: detail.func ? 'context-capture' : 'inject', detail });
      if (!documents.has(detail.target.tabId)) documents.set(detail.target.tabId, { token: `token-${detail.target.tabId}`, selected: null });
      return [{ result: true }];
    } },
    tabs: {
      get: async (tabId: number) => { const tab = tabs.get(tabId); if (!tab) throw new Error('No tab'); return { ...tab }; },
      query: async (detail: any) => { calls.push({ kind: 'tabs-query', detail }); return [...tabs.values()].filter(tab => tab.windowId === detail.windowId && tab.active); },
      sendMessage: async (tabId: number, command: any) => {
        calls.push({ kind: 'content-command', detail: { tabId, ...command } });
        const doc = documents.get(tabId);
        if (!doc) throw new Error('No receiver');
        if (command.type === 'hello') {
          if (doc.coordinatorToken && doc.coordinatorToken !== command.coordinatorToken) { doc.selected = null; doc.audit = null; doc.selectionRequest = ''; doc.auditRequest = ''; }
          doc.coordinatorToken = command.coordinatorToken;
          return { documentToken: doc.token, selected: doc.selected, audit: doc.audit ?? null, picker: false };
        }
        if (command.type === 'clear-data') { doc.selected = null; doc.audit = null; }
        if (command.type === 'release-analysis') {
          if (command.expectedSelectionRequest !== (doc.selectionRequest ?? '') || command.expectedAuditRequest !== (doc.auditRequest ?? '')) return { released: false };
          doc.selected = null; doc.audit = null; doc.selectionRequest = command.requestId; doc.auditRequest = '';
          return { released: true };
        }
        if (['start-picker', 'select-node', 'capture-context', 'refresh-selection'].includes(command.type)) doc.selectionRequest = command.requestId;
        if (command.type === 'start-audit') { doc.selectionRequest = command.requestId; doc.auditRequest = command.requestId; doc.selected = null; }
        return { ok: true, documentToken: doc.token };
      },
      onActivated: new Event(), onUpdated: new Event(), onRemoved: new Event(),
    },
    windows: { get: async (id: number) => ({ id }), onRemoved: new Event() },
    permissions: { contains: async () => false, onAdded: new Event(), onRemoved: new Event() },
    // Downloads API is intentionally absent before its optional permission is granted.
  };
  class TrackedURL extends URL {
    static createObjectURL(blob: Blob) { const url = URL.createObjectURL(blob); calls.push({ kind: 'blob-created', detail: url }); return url; }
    static revokeObjectURL(url: string) { calls.push({ kind: 'blob-revoked', detail: url }); URL.revokeObjectURL(url); }
  }
  beforeStart?.(api, local, session);
  const background = (await bundle).outputFiles[0]!.text;
  const launch = () => vm.runInNewContext(background, { browser: api, crypto: webcrypto, structuredClone, TextEncoder, URL: TrackedURL, Blob, console });
  launch();
  await tick();
  function sidebar(windowId: number) {
    const messages: any[] = [];
    const port = { name: 'sidebar', sender: { id: 'test-addon', url: 'moz-extension://test/sidebar/index.html' }, onMessage: new Event(), onDisconnect: new Event(), postMessage: (message: any) => messages.push(structuredClone(message)) };
    api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'ready', windowId, requestId: `ready-${windowId}` });
    return { port, messages, state: () => messages.filter(message => message.type === 'state').at(-1)?.state, send: (type: string, extras = {}) => port.onMessage.emit({ type, requestId: `${type}-${Math.random()}`, ...extras }) };
  }
  async function emitContent(tabId: number, event: any) {
    if (event.type === 'audit') documents.get(tabId)!.audit = event.audit;
    if (event.type === 'selected') documents.get(tabId)!.selected = event.snapshot;
    await Promise.all(api.runtime.onMessage.emit({ channel: 'sil-event', documentToken: documents.get(tabId)!.token, coordinatorToken: documents.get(tabId)!.coordinatorToken, epoch: session.analysisSession?.epoch ?? 0, ...event }, { id: 'test-addon', tab: tabs.get(tabId), frameId: 0 }));
    await tick();
  }
  async function restart() {
    for (const section of ['runtime', 'storage', 'tabs', 'windows', 'action', 'menus', 'permissions']) {
      for (const value of Object.values(api[section])) if (value instanceof Event) value.listeners = [];
    }
    launch(); await tick();
  }
  return { api, calls, tabs, documents, local, session, sidebar, emitContent, restart };
}

test('toolbar opens synchronously and only injects; initial sidebar readiness does not lose activation', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10));
  assert.equal(f.calls.at(-1)?.kind, 'open');
  const ui = f.sidebar(1);
  await tick();
  assert.equal(ui.state().access, 'ready');
  assert.equal(ui.state().tabId, 10);
  assert.equal(ui.state().selected, null);
  assert.equal(f.calls.some(call => call.kind === 'content-command' && ['start-picker', 'start-audit'].includes(call.detail.type)), false);
  f.api.action.onClicked.emit(f.tabs.get(10));
  await tick();
  assert.equal(f.calls.filter(call => call.kind === 'open').length, 2);
});

test('a failed session read preserves valid preferences and a failed preferences read preserves authorized documents', async () => {
  const withPreferences = await fixture((api, local) => {
    local.preferences = { values: { appearance: 'dark', colorFormat: 'hsl', livePreview: false, contextMenuEnabled: false } };
    api.storage.session.get = async () => { throw new Error('Temporary session storage failure'); };
  });
  const preferencesUi = withPreferences.sidebar(1); await tick();
  assert.equal(preferencesUi.state().settings.appearance, 'dark');
  assert.equal(preferencesUi.state().settings.colorFormat, 'hsl');
  assert.equal(preferencesUi.state().settings.livePreview, false);
  assert.equal(withPreferences.calls.some(call => call.kind === 'menu-create'), false);
  withPreferences.api.action.onClicked.emit(withPreferences.tabs.get(10)); await tick();
  preferencesUi.send('start-audit', { requestId: 'after-session-read-failure' }); await tick();
  await withPreferences.emitContent(10, { type: 'audit', requestId: 'after-session-read-failure', audit: { id: 'after-session-read-failure', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, runs: [], status: 'complete', stale: false, palette: [], fonts: [], reasons: [], scanned: 0, skipped: 0, total: 0 } });
  assert.equal(preferencesUi.state().audit.id, 'after-session-read-failure', 'New measurements remain usable after the failed initial read');
  assert.equal('audit' in withPreferences.session.analysisSession.documents['10'], false);
  assert.equal(preferencesUi.state().settings.appearance, 'dark');

  const withDocuments = await fixture((api, _local, session) => {
    api.storage.local.get = async () => { throw new Error('Temporary preference storage failure'); };
    session.analysisSession = { schemaVersion: 1, epoch: 2, documents: { '10': { windowId: 1, tabId: 10, documentToken: 'token-10', touchedAt: 1, selected: null, audit: null, selectionRequest: '', auditRequest: '', picker: false } } };
  });
  withDocuments.documents.set(10, { token: 'token-10', selected: null });
  const documentUi = withDocuments.sidebar(1); await tick();
  assert.equal(documentUi.state().access, 'ready', 'A preferences failure does not erase established session access');
  assert.deepEqual(documentUi.state().settings, DEFAULT_SETTINGS);
  assert.equal(withDocuments.calls.some(call => call.kind === 'inject'), false);
  documentUi.send('start-picker', { requestId: 'after-preferences-read-failure' }); await tick();
  await withDocuments.emitContent(10, { type: 'selected', requestId: 'after-preferences-read-failure', snapshot: { id: 'restored-epoch-selection', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} } });
  assert.equal(documentUi.state().selected.id, 'restored-epoch-selection', 'The restored generation accepts current document events');
  assert.equal(withDocuments.session.analysisSession.epoch, 2);
  documentUi.send('update-settings', { settings: { colorFormat: 'hsl' } }); await tick();
  assert.equal(withDocuments.local.preferences.values.colorFormat, 'hsl');
  assert.equal(documentUi.state().selected.id, 'restored-epoch-selection');
});

test('closing a sidebar during readiness does not restore its connection or read the page afterward', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
  let finishWindow!: (value: unknown) => void;
  f.api.windows.get = () => new Promise(resolve => { finishWindow = resolve; });
  const ui = f.sidebar(1); await tick();
  ui.port.onDisconnect.emit();
  const calls = f.calls.length;
  finishWindow({ id: 1 }); await tick();
  assert.equal(f.calls.slice(calls).some(call => call.kind === 'tabs-query' || call.kind === 'content-command'), false);
  assert.deepEqual(ui.messages, []);
});

test('context menu captures before sidebar readiness and rejects frame substitution', async () => {
  const f = await fixture();
  f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 0, targetElementId: 6 }, f.tabs.get(10));
  assert.deepEqual(f.calls.slice(-2).map(call => call.kind), ['open', 'context-capture']);
  await tick();
  assert.ok(f.calls.find(call => call.kind === 'content-command' && call.detail.type === 'capture-context'));
  const ui = f.sidebar(1); await tick();
  const before = f.calls.filter(call => call.kind === 'context-capture').length;
  f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 4, targetElementId: 6 }, f.tabs.get(10));
  await tick();
  assert.equal(f.calls.filter(call => call.kind === 'context-capture').length, before);
  assert.equal(ui.state().error, 'unsupported-frame');
});

test('sidebar close cancels only its window picker, keeping audit independent', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10)); f.api.action.onClicked.emit(f.tabs.get(20));
  const first = f.sidebar(1), second = f.sidebar(2); await tick();
  first.send('start-picker'); second.send('start-picker'); second.send('start-audit'); await tick();
  first.port.onDisconnect.emit(); await tick();
  assert.equal(second.state().picker, false, 'Starting an audit ends the picker in that window');
  const cancellations = f.calls.filter(call => call.kind === 'content-command' && call.detail.type === 'cancel-picker');
  assert.equal(cancellations.at(-1)?.detail.tabId, 10);
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'cancel-audit'), false);
});

test('global clear invalidates delayed content results in every window and preserves preferences', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10)); f.api.action.onClicked.emit(f.tabs.get(20));
  const first = f.sidebar(1), second = f.sidebar(2); await tick();
  first.send('update-settings', { settings: { appearance: 'dark' } }); await tick();
  first.send('start-picker'); await tick();
  const request = [...f.calls].reverse().find(call => call.kind === 'content-command' && call.detail.type === 'start-picker')!.detail;
  first.send('clear-data'); await tick();
  assert.equal(first.state().selected, null); assert.equal(second.state().selected, null);
  assert.equal(first.state().settings.appearance, 'dark');
  assert.equal(second.state().lastEvent, 'data-cleared');
  assert.ok(f.session.analysisSession.epoch > request.epoch);
  await f.emitContent(10, { type: 'selected', epoch: request.epoch, requestId: request.requestId, snapshot: { document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} } });
  assert.equal(first.state().selected, null);
  assert.deepEqual(Object.keys(f.local), ['preferences']);
});

test('same-URL navigation invalidates identity and requires fresh activation', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  assert.equal(ui.state().access, 'ready');
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  assert.equal(ui.state().access, 'needs-activation');
  assert.equal(ui.state().documentToken, null);
  assert.equal(f.session.analysisSession?.documents['10'], undefined);
});

test('uninspected tab loads, removals and unrelated window closes do not persist analysis', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); f.sidebar(1); await tick();
  const before = f.calls.filter(call => call.kind === 'session-write').length;
  for (let id = 100; id < 150; id++) {
    f.api.tabs.onUpdated.emit(id, { status: 'loading' }, { id, windowId: 1 });
    f.api.tabs.onRemoved.emit(id);
    f.api.windows.onRemoved.emit(id);
  }
  await tick();
  assert.equal(f.calls.filter(call => call.kind === 'session-write').length, before);
  assert.ok(f.session.analysisSession.documents['10']);
});

test('scan progress and terminal measurements stay memory only', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-audit', { requestId: 'progress-test', scope: 'viewport' }); await tick();
  const command = f.calls.find(call => call.kind === 'content-command' && call.detail.type === 'start-audit')!.detail;
  assert.equal(command.scope, 'viewport');
  const before = f.calls.filter(call => call.kind === 'session-write').length;
  const audit = { id: 'progress-test', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, runs: [], status: 'running', stale: false, palette: [], fonts: [], reasons: [], scanned: 0, skipped: 0, total: 0 };
  for (let scanned = 1; scanned <= 12; scanned++) await f.emitContent(10, { type: 'audit', requestId: 'progress-test', audit: { ...audit, scanned, total: scanned } });
  assert.equal(ui.state().progress.scanned, 12);
  assert.equal(f.calls.filter(call => call.kind === 'session-write').length, before);
  await f.emitContent(10, { type: 'audit', requestId: 'progress-test', audit: { ...audit, status: 'complete', scanned: 12 } });
  assert.equal(f.calls.filter(call => call.kind === 'session-write').length, before + 1);
  assert.equal(ui.state().audit.status, 'complete');
  assert.equal('audit' in f.session.analysisSession.documents['10'], false);
});

test('slow authorization storage coalesces writes without serializing any selected result', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-picker', { requestId: 'queue-test' }); await tick();
  const write = f.api.storage.session.set;
  let finish!: () => void, writes = 0;
  f.api.storage.session.set = async (value: any) => { if (++writes === 1) await new Promise<void>(resolve => { finish = resolve; }); await write(value); };
  const snapshot = (id: number) => ({ id: `selected-${id}`, document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {}, textExcerpt: { value: 'private-selected-text', truncated: false } });
  for (let id = 0; id < 20; id++) await f.emitContent(10, { type: 'selected', requestId: 'queue-test', snapshot: snapshot(id) });
  assert.equal(writes, 1);
  assert.equal(ui.state().selected.id, 'selected-19');
  finish(); await tick();
  assert.equal(writes, 2, 'Intermediate snapshots are not queued');
  assert.equal('selected' in f.session.analysisSession.documents['10'], false);
  assert.doesNotMatch(JSON.stringify(f.session.analysisSession), /private-selected-text|textExcerpt/);
});

test('clear, navigation and revocation supersede pending writes without resurrecting analysis', async () => {
  for (const action of ['clear', 'navigate', 'revoke']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    ui.send('start-picker', { requestId: 'pending-storage' }); await tick();
    const write = f.api.storage.session.set;
    let finish!: () => void, writes = 0;
    f.api.storage.session.set = async (value: any) => { if (++writes === 1) await new Promise<void>(resolve => { finish = resolve; }); await write(value); };
    const snapshot = { id: 'old-selection', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} };
    await f.emitContent(10, { type: 'selected', requestId: 'pending-storage', snapshot });
    await f.emitContent(10, { type: 'selected', requestId: 'pending-storage', snapshot: { ...snapshot, id: 'pending-selection' } });
    if (action === 'clear') ui.send('clear-data');
    else if (action === 'navigate') f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10));
    else f.api.permissions.onRemoved.emit({ origins: ['https://example.com/*'] });
    await tick(); finish(); await tick();
    assert.equal(writes, 2, action);
    assert.equal(ui.state().selected, null, action);
    if (action === 'clear') { assert.equal('selected' in f.session.analysisSession.documents['10'], false); assert.equal(f.session.analysisSession.epoch, 1); }
    else assert.equal(f.session.analysisSession.documents['10'], undefined, action);
    assert.doesNotMatch(JSON.stringify(f.session.analysisSession), /old-selection|pending-selection/);
  }
});

test('a failed storage write does not block the newest pending result', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-picker', { requestId: 'storage-recovery' }); await tick();
  const write = f.api.storage.session.set;
  let fail!: (error: Error) => void, writes = 0;
  f.api.storage.session.set = async (value: any) => { if (++writes === 1) await new Promise((_, reject) => { fail = reject; }); await write(value); };
  const snapshot = { id: 'old', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} };
  await f.emitContent(10, { type: 'selected', requestId: 'storage-recovery', snapshot });
  await f.emitContent(10, { type: 'selected', requestId: 'storage-recovery', snapshot: { ...snapshot, id: 'newest' } });
  fail(new Error('Storage unavailable')); await tick();
  assert.equal(writes, 2);
  assert.equal(ui.state().selected.id, 'newest');
  assert.equal('selected' in f.session.analysisSession.documents['10'], false);
  assert.equal(ui.messages.filter(message => message.type === 'error' && message.code === 'storage-failed').length, 1);
});

test('live analysis eviction releases visible payloads while retaining established page access', async () => {
  const f = await fixture(), sidebars: ReturnType<typeof f.sidebar>[] = [];
  for (let id = 100; id < 113; id++) {
    const tab = { id, windowId: id, url: 'https://example.com/', active: true };
    f.tabs.set(id, tab); f.api.action.onClicked.emit(tab); const ui = f.sidebar(id); sidebars.push(ui); await tick();
    await f.emitContent(id, { type: 'selected', requestId: '', snapshot: { id: `s${id}`, document: { windowId: id, tabId: id, frameId: 0, documentToken: `token-${id}` }, textRuns: [], styles: {} } });
  }
  assert.equal(sidebars[0]!.state().selected, null);
  assert.equal(f.documents.get(100)!.selected, null, 'Eviction also releases the page-owned result');
  assert.ok(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'release-analysis' && call.detail.tabId === 100));
  assert.equal(sidebars[0]!.state().access, 'ready');
  assert.equal(sidebars[12]!.state().selected.id, 's112');
  const injections = f.calls.filter(call => call.kind === 'inject').length;
  const restored = f.sidebar(100); await tick();
  assert.equal(restored.state().access, 'ready', 'An evicted payload does not revoke an established document identity');
  assert.equal(f.calls.filter(call => call.kind === 'inject').length, injections);
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'cancel-audit'), false);
});

test('legacy stored measurements are removed and background restart retains only access and preferences', async () => {
  const f = await fixture((_api, local, session) => {
    local.preferences = { values: { appearance: 'dark' } };
    session.analysisSession = { schemaVersion: 1, epoch: 4, documents: { '10': {
      windowId: 1, tabId: 10, documentToken: 'token-10', touchedAt: 1,
      selected: { id: 'legacy-private-selection' }, audit: { id: 'legacy-private-audit' }, previousAudit: { id: 'legacy-private-history' },
      selectionRequest: 'legacy-selection', auditRequest: 'legacy-audit', picker: true,
    } } };
  });
  assert.equal(f.session.analysisSession.schemaVersion, 2);
  assert.doesNotMatch(JSON.stringify(f.session), /legacy-private|selected|previousAudit|auditRequest|selectionRequest/);
  f.documents.set(10, { token: 'token-10', selected: null });
  const first = f.sidebar(1); await tick();
  first.send('start-audit', { requestId: 'before-restart' }); await tick();
  await f.emitContent(10, { type: 'audit', requestId: 'before-restart', audit: retainedAudit('before-restart') });
  first.send('select-node', { requestId: 'selected-before-restart', referenceId: 'current' }); await tick();
  await f.emitContent(10, { type: 'selected', requestId: 'selected-before-restart', snapshot: { id: 'private-memory-only', document: retainedAudit('x').document, styles: {}, textRuns: [] } });
  const previousCoordinator = f.documents.get(10)!.coordinatorToken;
  const scans = f.calls.filter(call => call.kind === 'content-command' && call.detail.type === 'start-audit').length;
  assert.doesNotMatch(JSON.stringify(f.session), /before-restart|private-memory|palette|textRuns/);
  await f.restart();
  const current = f.sidebar(1); await tick();
  assert.equal(current.state().access, 'ready'); assert.equal(current.state().settings.appearance, 'dark');
  assert.equal(current.state().selected, null); assert.equal(current.state().audit, null); assert.equal(current.state().previousAudit, null);
  assert.equal(f.documents.get(10)!.selected, null); assert.equal(f.documents.get(10)!.audit, null);
  assert.notEqual(f.documents.get(10)!.coordinatorToken, previousCoordinator);
  current.send('start-picker', { requestId: 'new-picker' }); await tick();
  await f.emitContent(10, { type: 'selected', requestId: 'new-picker', coordinatorToken: previousCoordinator, snapshot: { id: 'old-coordinator', document: retainedAudit('x').document, styles: {}, textRuns: [] } });
  assert.equal(current.state().selected, null, 'Events from the earlier coordinator are rejected');
  assert.equal(f.calls.filter(call => call.kind === 'content-command' && call.detail.type === 'start-audit').length, scans, 'Restart never starts a new audit automatically');
});

test('new empty authorized tabs cannot displace an existing live analysis', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-audit', { requestId: 'retained' }); await tick();
  await f.emitContent(10, { type: 'audit', requestId: 'retained', audit: retainedAudit('retained') });
  for (let id = 100; id < 115; id++) {
    const tab = { id, windowId: id, url: 'https://example.com/', active: true };
    f.tabs.set(id, tab); f.api.action.onClicked.emit(tab); await tick();
  }
  assert.equal(ui.state().audit.id, 'retained');
  assert.ok(f.session.analysisSession.documents['10']);
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'release-analysis'), false);
});

test('delayed eviction cannot restore old analysis or delete a newer inspected result', async () => {
  const f = await fixture(), sidebars = new Map<number, ReturnType<typeof f.sidebar>>();
  const send = f.api.tabs.sendMessage;
  let release!: () => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'release-analysis' && tabId === 100
    ? new Promise(resolve => { release = () => { void send(tabId, command).then(resolve); }; }) : send(tabId, command);
  for (let id = 100; id < 113; id++) {
    const tab = { id, windowId: id, url: 'https://example.com/', active: true };
    f.tabs.set(id, tab); f.api.action.onClicked.emit(tab); sidebars.set(id, f.sidebar(id)); await tick();
    await f.emitContent(id, { type: 'selected', requestId: '', snapshot: { id: `s${id}`, document: { windowId: id, tabId: id, frameId: 0, documentToken: `token-${id}` }, textRuns: [], styles: {} } });
  }
  const ui = sidebars.get(100)!;
  assert.equal(ui.state().selected, null); assert.equal(f.documents.get(100)!.selected.id, 's100');
  f.api.action.onClicked.emit(f.tabs.get(100)); await tick();
  assert.equal(ui.state().selected, null, 'A handshake cannot resurrect content data awaiting release');
  await f.emitContent(100, { type: 'selected', requestId: '', snapshot: f.documents.get(100)!.selected });
  assert.equal(ui.state().selected, null, 'Old content requests were retired immediately');
  ui.send('select-node', { requestId: 'new-selection', referenceId: 'node' }); await tick();
  const newer = { id: 'newer', document: { windowId: 100, tabId: 100, frameId: 0, documentToken: 'token-100' }, textRuns: [], styles: {} };
  await f.emitContent(100, { type: 'selected', requestId: 'new-selection', snapshot: newer });
  release(); await tick();
  assert.equal(ui.state().selected.id, 'newer'); assert.equal(f.documents.get(100)!.selected.id, 'newer');
});

test('active snapshot work remains protected from analysis eviction until it completes', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  await f.emitContent(10, { type: 'selected', requestId: '', snapshot: { id: 'old-selection', document: retainedAudit('x').document, textRuns: [], styles: {} } });
  const send = f.api.tabs.sendMessage;
  let finish!: (value: any) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'select-node' && tabId === 10
    ? new Promise(resolve => { finish = resolve; }) : send(tabId, command);
  ui.send('select-node', { requestId: 'working-selection', referenceId: 'huge' }); await tick();
  for (let id = 100; id < 113; id++) {
    const tab = { id, windowId: id, url: 'https://example.com/', active: true };
    f.tabs.set(id, tab); f.api.action.onClicked.emit(tab); f.sidebar(id); await tick();
    await f.emitContent(id, { type: 'selected', requestId: '', snapshot: { id: `s${id}`, document: { windowId: id, tabId: id, frameId: 0, documentToken: `token-${id}` }, textRuns: [], styles: {} } });
  }
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'release-analysis' && call.detail.tabId === 10), false);
  await f.emitContent(10, { type: 'selected', requestId: 'working-selection', snapshot: { id: 'completed-selection', document: retainedAudit('x').document, textRuns: [], styles: {} } });
  finish({ ok: true }); await tick();
  assert.equal(ui.state().selected.id, 'completed-selection');
});

test('reset settings preserves session analysis identity and does not start a scan', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('update-settings', { settings: { contrastTarget: 'AAA', livePreview: false, contextMenuEnabled: false } }); await tick();
  ui.send('reset-settings'); await tick();
  assert.deepEqual(ui.state().settings, DEFAULT_SETTINGS);
  assert.equal(ui.state().documentToken, 'token-10');
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'start-audit'), false);
});

test('concurrent settings patches merge inside the serialized write queue', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('update-settings', { settings: { appearance: 'dark' } });
  ui.send('update-settings', { settings: { colorFormat: 'hsl' } });
  ui.send('update-settings', { settings: { livePreview: false } });
  await tick();
  assert.equal(ui.state().settings.appearance, 'dark');
  assert.equal(ui.state().settings.colorFormat, 'hsl');
  assert.equal(ui.state().settings.livePreview, false);
  assert.equal(f.local.preferences.values.appearance, 'dark');
});

test('display preferences broadcast once without rewriting analysis; contrast target reassesses retained results', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  const foreground = parseColor('#666666'), background = parseColor('#ffffff');
  const run: TextRun = { id: 'settings-run', elementRef: 'settings-node', tagName: 'span', selector: 'span', foreground, background, effectiveBackground: background.rgba,
    reasons: [], fontSizeCssPx: 14, fontWeight: 400, ownOpaqueBackground: false,
    contrast: evaluateContrast({ foreground: foreground.rgba, background: background.rgba, fontSizeCssPx: 14, fontWeight: 400 }), fontSize: evaluateFontSize(14) };
  const document = { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' };
  ui.send('start-audit', { requestId: 'settings-audit' }); await tick();
  await f.emitContent(10, { type: 'audit', requestId: 'settings-audit', audit: { id: 'settings-audit', document, runs: [run], status: 'complete', stale: false, palette: [], fonts: [], reasons: [], scanned: 1, skipped: 0, total: 1 } });
  ui.send('select-node', { requestId: 'settings-selection', referenceId: 'settings-node' }); await tick();
  const snapshot = { id: 'settings-selection', document, textRuns: [run], styles: {} };
  await f.emitContent(10, { type: 'selected', requestId: 'settings-selection', snapshot });
  ui.send('start-picker', { requestId: 'settings-preview' }); await tick();
  await f.emitContent(10, { type: 'preview', requestId: 'settings-preview', snapshot: { ...snapshot, id: 'settings-preview' } });

  // Firefox can deliver onChanged for our write before storage.set resolves.
  const write = f.api.storage.local.set;
  f.api.storage.local.set = async (value: any) => {
    await write(value);
    f.api.storage.onChanged.emit({ preferences: { newValue: value.preferences } }, 'local');
  };
  const count = (kind: string) => f.calls.filter(call => call.kind === kind).length;
  const settingsCommands = () => f.calls.filter(call => call.kind === 'content-command' && call.detail.type === 'settings').length;
  const settingsMessages = () => ui.messages.filter(message => message.type === 'state' && message.state.lastEvent === 'settings').length;
  const writes = count('session-write'), menus = count('menu-remove');
  for (const patch of [{ appearance: 'dark' }, { colorFormat: 'hsl' }, { livePreview: false }, { showDiagnostics: true }, { contextMenuEnabled: false }]) {
    const commands = settingsCommands(), messages = settingsMessages();
    ui.send('update-settings', { settings: patch }); await tick();
    assert.equal(settingsCommands(), commands + 1, 'A self-generated preference event is applied once');
    assert.equal(settingsMessages(), messages + 1, 'The active sidebar receives one coherent preference update');
    assert.equal(count('session-write'), writes, 'Display and control changes do not serialize analysis');
    assert.equal(ui.state().audit.runs[0].contrast.target, 'AA');
    assert.equal(ui.state().selected.textRuns[0].contrast.status, 'pass');
    assert.equal(ui.state().preview.textRuns[0].contrast.status, 'pass');
  }
  assert.equal(count('menu-remove'), menus + 1, 'Only the context-menu preference rebuilds its menu');
  assert.equal(ui.state().settings.showDiagnostics, true);
  const commands = settingsCommands(), messages = settingsMessages();
  ui.send('update-settings', { settings: { contrastTarget: 'AAA' } }); await tick();
  assert.equal(settingsCommands(), commands + 1);
  assert.equal(settingsMessages(), messages + 1);
  assert.equal(count('session-write'), writes + 1);
  assert.equal(ui.state().audit.counts.contrast.fail, 1);
  assert.equal(ui.state().selected.textRuns[0].contrast.status, 'fail');
  assert.equal(ui.state().preview.textRuns[0].contrast.status, 'fail');
  assert.equal('audit' in f.session.analysisSession.documents['10'], false);

  ui.send('update-settings', { settings: { contrastTarget: 'AAA' } }); await tick();
  assert.equal(settingsCommands(), commands + 1, 'Identical settings do not trigger content work');
  assert.equal(settingsMessages(), messages + 1);
  assert.equal(count('session-write'), writes + 1);
  ui.send('reset-settings'); await tick();
  assert.deepEqual(ui.state().settings, DEFAULT_SETTINGS);
  assert.equal(ui.state().audit.counts.contrast.pass, 1);
  assert.equal(ui.state().selected.textRuns[0].contrast.status, 'pass');
  assert.equal(ui.state().preview.textRuns[0].contrast.status, 'pass');
  assert.equal(count('session-write'), writes + 2);
  assert.equal(count('menu-remove'), menus + 2);
});

test('clear invalidates a context capture still awaiting browser injection', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  let completeCapture!: (value: any) => void;
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = (detail: any) => detail.func ? new Promise(resolve => { completeCapture = resolve; }) : execute(detail);
  f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 0, targetElementId: 8 }, f.tabs.get(10));
  ui.send('clear-data'); await tick();
  completeCapture([{ result: true }]); await tick();
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'capture-context'), false);
  assert.equal(ui.state().selected, null);
});

test('a tab switch retires a pending context capture and its errors without changing the new sidebar', async () => {
  for (const result of ['captured', 'expired', 'rejected']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    let completeCapture!: (value: any) => void, rejectCapture!: (error: Error) => void;
    const execute = f.api.scripting.executeScript;
    f.api.scripting.executeScript = (detail: any) => detail.func
      ? new Promise((resolve, reject) => { completeCapture = resolve; rejectCapture = reject; }) : execute(detail);
    f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 0, targetElementId: 8 }, f.tabs.get(10));
    const tab = { id: 11, windowId: 1, active: true, url: 'https://next.example/' };
    f.tabs.get(10).active = false; f.tabs.set(11, tab);
    f.api.tabs.onActivated.emit({ windowId: 1, tabId: 11 });
    f.api.action.onClicked.emit(tab); await tick();
    const before = structuredClone(ui.state());
    const injections = f.calls.filter(call => call.kind === 'inject').length;
    if (result === 'rejected') rejectCapture(new Error('Old page inaccessible'));
    else completeCapture([{ result: result === 'captured' }]);
    await tick();
    assert.deepEqual(ui.state(), before, result);
    assert.equal(ui.state().tabId, 11);
    assert.equal(f.calls.filter(call => call.kind === 'inject').length, injections, result);
    assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'capture-context'), false, result);
  }
});

test('newer selection intents retire older context captures and their late errors', async () => {
  for (const command of ['start-picker', 'select-node', 'refresh-selection', 'cancel-picker']) for (const result of ['captured', 'rejected']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    let finishCapture!: (value: any) => void, rejectCapture!: (error: Error) => void;
    const execute = f.api.scripting.executeScript;
    f.api.scripting.executeScript = (detail: any) => detail.func
      ? new Promise((resolve, reject) => { finishCapture = resolve; rejectCapture = reject; }) : execute(detail);
    f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 0, targetElementId: 8 }, f.tabs.get(10));
    await tick();
    ui.send(command, { requestId: 'newer-selection', referenceId: 'current-node' }); await tick();
    const boundary = f.calls.length, messages = ui.messages.length;
    if (result === 'captured') finishCapture([{ result: true }]); else rejectCapture(new Error('Expired older capture'));
    await tick();
    assert.equal(f.calls.slice(boundary).some(call => call.kind === 'content-command' && call.detail.type === 'capture-context'), false, `${command}/${result}`);
    assert.equal(ui.messages.slice(messages).some(message => message.type === 'error' || message.state?.error), false, `${command}/${result}`);
    assert.equal(ui.state().picker, command === 'start-picker');
  }
});

test('late successful or failed handshakes cannot erase newer picker requests and previews', async () => {
  for (const outcome of ['resolved', 'rejected']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    const send = f.api.tabs.sendMessage;
    let finishHello!: (value: any) => void, rejectHello!: (error: Error) => void;
    f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'hello'
      ? new Promise((resolve, reject) => { finishHello = resolve; rejectHello = reject; }) : send(tabId, command);
    f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
    ui.send('start-picker', { requestId: 'newer-picker' }); await tick();
    if (outcome === 'resolved') finishHello({ documentToken: 'token-10', selected: null, audit: null, picker: false, selectionRequest: '', auditRequest: '' });
    else rejectHello(new Error('Obsolete hello failure'));
    await tick();
    assert.equal(ui.state().access, 'ready', outcome); assert.equal(ui.state().picker, true, outcome);
    await f.emitContent(10, { type: 'preview', requestId: 'newer-picker', snapshot: { id: 'preview-now', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} } });
    assert.equal(ui.state().preview?.id, 'preview-now', outcome);
  }
});

test('late handshakes retain accepted content events even when their request IDs stay unchanged', async () => {
  for (const update of ['selected', 'stale', 'audit']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    const document = { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' };
    const snapshot = { id: 'confirmed', document, textRuns: [], styles: {}, stale: false };
    ui.send('start-audit', { requestId: 'same-audit' }); await tick();
    ui.send('start-picker', { requestId: 'same-selection' }); await tick();
    if (update === 'stale') await f.emitContent(10, { type: 'selected', requestId: 'same-selection', snapshot });
    const send = f.api.tabs.sendMessage;
    let finishHello!: (value: any) => void;
    f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'hello' ? new Promise(resolve => { finishHello = resolve; }) : send(tabId, command);
    f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
    if (update === 'audit') await f.emitContent(10, { type: 'audit', requestId: 'same-audit', audit: { id: 'same-audit', document, runs: [], status: 'complete', stale: false, palette: [], fonts: [], reasons: [], scanned: 0, skipped: 0, total: 0 } });
    else await f.emitContent(10, { type: update, requestId: 'same-selection', snapshot });
    finishHello({ documentToken: 'token-10', selected: update === 'stale' ? snapshot : null, audit: null, picker: true, selectionRequest: 'same-selection', auditRequest: 'same-audit' });
    await tick();
    if (update === 'audit') assert.equal(ui.state().audit?.status, 'complete');
    else { assert.equal(ui.state().selected?.id, 'confirmed'); assert.equal(ui.state().picker, false); if (update === 'stale') assert.equal(ui.state().selected.stale, true); }
  }
});

test('handshakes begun during pending captures preserve their request identity and initialize new sidebars', async () => {
  for (const operation of ['select-node', 'start-audit', 'start-picker']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const first = f.sidebar(1); await tick();
    first.send('start-audit', { requestId: 'confirmed-audit' }); await tick();
    const audit = retainedAudit('confirmed-audit');
    await f.emitContent(10, { type: 'audit', requestId: 'confirmed-audit', audit });
    first.send('select-node', { requestId: 'confirmed-selection', referenceId: 'old-node' }); await tick();
    const snapshot = { id: 'confirmed-selection', document: audit.document, textRuns: [], styles: {}, stale: false };
    await f.emitContent(10, { type: 'selected', requestId: 'confirmed-selection', snapshot });
    const send = f.api.tabs.sendMessage;
    let finish: ((value: any) => void) | undefined;
    f.api.tabs.sendMessage = (tabId: number, command: any) => {
      if (command.type === operation && operation !== 'start-picker') return new Promise(resolve => { finish = resolve; });
      if (command.type === 'hello') return Promise.resolve({ documentToken: 'token-10', selected: snapshot, audit, picker: false, selectionRequest: 'confirmed-selection', auditRequest: 'confirmed-audit' });
      return send(tabId, command);
    };
    first.send(operation, { requestId: 'pending-work', referenceId: 'new-node' }); await tick();
    // During a picker click, content has stopped the overlay but continues its
    // chunked capture. It still reports the preceding confirmed selection.
    const reopened = f.sidebar(1); await tick();
    assert.equal(reopened.state()?.selected?.id, 'confirmed-selection', `${operation}: a newly opened sidebar receives the current record`);
    if (operation === 'start-audit') await f.emitContent(10, { type: 'audit', requestId: 'pending-work', audit: retainedAudit('pending-work') });
    else await f.emitContent(10, { type: 'selected', requestId: 'pending-work', snapshot: { ...snapshot, id: 'new-selection' } });
    finish?.({ ok: true }); await tick();
    for (const ui of [first, reopened]) {
      if (operation === 'start-audit') {
        assert.equal(ui.state().audit.id, 'pending-work'); assert.equal(ui.state().previousAudit.id, 'confirmed-audit');
      } else { assert.equal(ui.state().selected.id, 'new-selection'); assert.equal(ui.state().picker, false); }
    }
  }
});

test('a newer cancellation survives an old handshake while unchanged handshakes still restore receiver state', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-picker', { requestId: 'picker' }); await tick();
  const send = f.api.tabs.sendMessage;
  let finishHello!: (value: any) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'hello' ? new Promise(resolve => { finishHello = resolve; }) : send(tabId, command);
  f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
  ui.send('cancel-picker'); await tick();
  finishHello({ documentToken: 'token-10', selected: null, audit: null, picker: true, selectionRequest: 'picker', auditRequest: '' }); await tick();
  assert.equal(ui.state().picker, false);
  f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
  const snapshot = { id: 'restored', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} };
  finishHello({ documentToken: 'token-10', selected: snapshot, audit: null, picker: false, selectionRequest: 'restored-selection', auditRequest: '' }); await tick();
  assert.equal(ui.state().selected?.id, 'restored');
  assert.equal('selectionRequest' in f.session.analysisSession.documents['10'], false);
});

test('cancelled picker adopts restored stale snapshot and hello null removes it permanently', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-picker'); await tick();
  const request = [...f.calls].reverse().find(call => call.kind === 'content-command' && call.detail.type === 'start-picker')!.detail;
  const snapshot = { id: 'snapshot-a', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {}, stale: true };
  await f.emitContent(10, { type: 'picker-cancelled', requestId: request.requestId, snapshot });
  assert.equal(ui.state().selected.id, 'snapshot-a');
  assert.equal(ui.state().selected.stale, true);
  f.api.action.onClicked.emit(f.tabs.get(10)); await tick();
  assert.equal(ui.state().selected, null);
});

test('late active-tab query cannot replace a newer tab activation', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const first = f.sidebar(1); await tick();
  const query = f.api.tabs.query;
  let oldQuery!: (value: any) => void;
  let delayed = false;
  f.api.tabs.query = (detail: any) => {
    if (!delayed) { delayed = true; return new Promise(resolve => { oldQuery = resolve; }); }
    return query(detail);
  };
  f.sidebar(1); await tick();
  const tab = { id: 11, windowId: 1, active: true, url: 'https://new.example/' };
  f.tabs.get(10).active = false; f.tabs.set(11, tab);
  f.api.tabs.onActivated.emit({ windowId: 1, tabId: 11 });
  f.api.action.onClicked.emit(tab); await tick();
  oldQuery([f.tabs.get(10)]); await tick();
  assert.equal(first.state().tabId, 11);
  assert.equal(first.state().documentToken, 'token-11');
});

test('a captured context target waits for sidebar readiness including its navigation intent', async () => {
  const f = await fixture();
  f.api.menus.onClicked.emit({ menuItemId: 'style-inspector-lite-inspect', frameId: 0, targetElementId: 8 }, f.tabs.get(10));
  await tick();
  const request = f.calls.find(call => call.kind === 'content-command' && call.detail.type === 'capture-context')!.detail;
  const snapshot = { id: 'late-context', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {}, stale: false };
  f.documents.get(10)!.selected = snapshot;
  await f.emitContent(10, { type: 'selected', requestId: request.requestId, snapshot });
  const ui = f.sidebar(1); await tick();
  assert.equal(ui.state().selected.id, 'late-context');
  assert.equal(ui.state().lastEvent, 'selected');
  assert.equal(ui.state().selectionOrigin, 'context');
});

test('rescan retains the completed audit until acceptance and rejects delayed results while preserving other windows and settings', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10)); f.api.action.onClicked.emit(f.tabs.get(20));
  const ui = f.sidebar(1), other = f.sidebar(2); await tick();
  ui.send('update-settings', { settings: { appearance: 'light', contrastTarget: 'AAA' } }); await tick();
  const snapshot = (tabId: number, windowId: number) => ({ id: `selection-${tabId}`, document: { windowId, tabId, frameId: 0, documentToken: `token-${tabId}` }, textRuns: [], styles: {}, stale: false });
  ui.send('start-picker', { requestId: 'old-selection' }); other.send('start-picker', { requestId: 'other-selection' }); await tick();
  await f.emitContent(10, { type: 'selected', requestId: 'old-selection', snapshot: snapshot(10, 1) });
  await f.emitContent(20, { type: 'selected', requestId: 'other-selection', snapshot: snapshot(20, 2) });
  ui.send('start-audit', { requestId: 'old-audit' }); await tick();
  const audit = { id: 'old-audit', document: snapshot(10, 1).document, runs: [], status: 'complete', stale: true, palette: [], fonts: [], reasons: [], scanned: 0, skipped: 0, total: 0 };
  await f.emitContent(10, { type: 'audit', requestId: 'old-audit', audit });
  ui.send('start-picker', { requestId: 'old-selection' }); await tick();
  await f.emitContent(10, { type: 'preview', requestId: 'old-selection', snapshot: snapshot(10, 1) });
  assert.ok(ui.state().audit && ui.state().preview && ui.state().picker);
  const send = f.api.tabs.sendMessage;
  let finish!: (value: any) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.requestId === 'new-audit' && command.type === 'start-audit'
    ? new Promise(resolve => { finish = resolve; }) : send(tabId, command);
  ui.send('start-audit', { requestId: 'new-audit' }); await tick();
  const reset = ui.state();
  assert.equal(reset.audit.id, 'old-audit', 'The previous scan remains available while scope validation is pending');
  assert.equal(reset.previousAudit, null);
  assert.equal(reset.picker, true, 'An in-flight picker intent remains intact until the new scan is accepted');
  assert.equal(reset.settings.appearance, 'light'); assert.equal(reset.settings.contrastTarget, 'AAA');
  assert.equal(other.state().selected.id, 'selection-20');
  await f.emitContent(10, { type: 'selected', requestId: 'old-selection', snapshot: snapshot(10, 1) });
  await f.emitContent(10, { type: 'audit', requestId: 'old-audit', audit });
  assert.equal(ui.state().selected, null); assert.equal(ui.state().audit.id, 'old-audit');
  finish({ ok: true }); await tick();
  assert.equal(ui.state().audit, null); assert.equal(ui.state().previousAudit.id, 'old-audit');
  await f.emitContent(10, { type: 'audit', requestId: 'new-audit', audit: { ...audit, id: 'new-audit', stale: false } });
  assert.equal(ui.state().audit.id, 'new-audit'); assert.equal(ui.state().audit.stale, false);
});

test('a removed audit target reports an operation error without disabling live document actions', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  const send = f.api.tabs.sendMessage;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'show-node'
    ? Promise.resolve({ error: 'element-removed' }) : send(tabId, command);
  ui.send('show-node', { requestId: 'missing-node', referenceId: 'expired' }); await tick();
  assert.equal(ui.state().access, 'ready');
  assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'missing-node' && message.code === 'element-removed'));
  ui.send('start-audit', { requestId: 'still-works' }); await tick();
  assert.ok(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'still-works'));
  f.api.tabs.sendMessage = () => Promise.reject(new Error('No receiver'));
  ui.send('show-node', { referenceId: 'no-document' }); await tick();
  assert.equal(ui.state().access, 'needs-activation', 'Transport failure still requires activation');
});

const retainedAudit = (id: string, tabId = 10, windowId = 1, status = 'complete') => ({
  id, document: { windowId, tabId, frameId: 0, documentToken: `token-${tabId}` }, measuredAt: '2026-10-21T10:00:00Z', viewport: { width: 1000, height: 700 },
  runs: [], status, stale: false, palette: [], fonts: [], reasons: [], scanned: 0, skipped: 0, total: 0,
});

test('a rejected section scan preserves current and previous complete audits and restores accepted event identity', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  for (const id of ['first', 'second']) {
    ui.send('start-audit', { requestId: id }); await tick();
    await f.emitContent(10, { type: 'audit', requestId: id, audit: retainedAudit(id) });
  }
  const send = f.api.tabs.sendMessage;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.requestId === 'removed-section' && command.type === 'start-audit'
    ? Promise.resolve({ error: 'element-removed' }) : send(tabId, command);
  ui.send('start-audit', { requestId: 'removed-section', scope: 'selection', referenceId: 'expired' }); await tick();
  assert.equal(ui.state().audit.id, 'second'); assert.equal(ui.state().previousAudit.id, 'first');
  assert.equal(ui.state().access, 'ready');
  assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'removed-section' && message.code === 'element-removed'));
  await f.emitContent(10, { type: 'audit', requestId: 'second', audit: { ...retainedAudit('second'), stale: true } });
  assert.equal(ui.state().audit.stale, true, 'The restored audit continues accepting its own stale events');
  assert.equal('previousAudit' in f.session.analysisSession.documents['10'], false);
});

test('only accepted complete scans rotate one baseline; partial and cancelled scans retain the last complete baseline', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  for (const [id, status, previous] of [['first', 'complete', null], ['cancelled', 'cancelled', 'first'], ['partial', 'partial', 'first'], ['second', 'complete', 'first'], ['third', 'complete', 'second']]) {
    ui.send('start-audit', { requestId: id }); await tick();
    await f.emitContent(10, { type: 'audit', requestId: id, audit: retainedAudit(id!, 10, 1, status!) });
    assert.equal(ui.state().previousAudit?.id ?? null, previous);
    assert.equal('previousAudit' in f.session.analysisSession.documents['10'], false);
  }
  ui.send('update-settings', { settings: { contrastTarget: 'AAA' } }); await tick();
  assert.equal(ui.state().previousAudit.target, 'AAA');
  assert.equal(ui.state().audit.target, 'AAA');
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  assert.equal(ui.state().previousAudit, null);
  assert.equal(f.session.analysisSession.documents['10'], undefined);
});

test('a delayed scan acceptance or rejection cannot overwrite a newer inspected selection', async () => {
  for (const accepted of [false, true]) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    ui.send('start-audit', { requestId: 'preceding' }); await tick();
    await f.emitContent(10, { type: 'audit', requestId: 'preceding', audit: retainedAudit('preceding') });
    const send = f.api.tabs.sendMessage;
    let finish!: (value: any) => void;
    f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'start-audit' && command.requestId === 'pending-scan'
      ? new Promise(resolve => { finish = resolve; }) : send(tabId, command);
    ui.send('start-audit', { requestId: 'pending-scan' }); await tick();
    ui.send('select-node', { requestId: 'new-selection', referenceId: 'selected-later' }); await tick();
    await f.emitContent(10, { type: 'selected', requestId: 'new-selection', snapshot: { id: 'selected-later', document: retainedAudit('x').document, textRuns: [], styles: {}, stale: false } });
    if (accepted) await f.emitContent(10, { type: 'audit', requestId: 'pending-scan', audit: retainedAudit('pending-scan', 10, 1, 'running') });
    finish(accepted ? { ok: true } : { error: 'element-removed' }); await tick();
    assert.equal(ui.state().selected.id, 'selected-later');
    if (accepted) assert.equal(ui.state().previousAudit.id, 'preceding');
    else {
      assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'pending-scan' && message.code === 'element-removed'), 'The rejected start settles its original caller even after a new selection');
      assert.equal(ui.state().access, 'ready');
      await f.emitContent(10, { type: 'audit', requestId: 'preceding', audit: { ...retainedAudit('preceding'), stale: true } });
      assert.equal(ui.state().audit.stale, true, 'Rejecting the old start restores its audit event identity independently of the new selection');
      assert.equal(ui.state().previousAudit, null);
    }
  }
});

test('retained-analysis overview lists bounded live titles and clears only the requested document across windows', async () => {
  const f = await fixture();
  f.tabs.get(10).title = 'Current page'; f.tabs.get(20).title = 'Other\u0000 page '.repeat(30);
  f.api.action.onClicked.emit(f.tabs.get(10)); f.api.action.onClicked.emit(f.tabs.get(20));
  const ui = f.sidebar(1), other = f.sidebar(2); await tick();
  for (const [tabId, windowId, sidebar] of [[10, 1, ui], [20, 2, other]] as const) for (const suffix of ['a', 'b']) {
    const id = `${tabId}-${suffix}`;
    sidebar.send('start-audit', { requestId: id }); await tick();
    await f.emitContent(tabId, { type: 'audit', requestId: id, audit: retainedAudit(id, tabId, windowId) });
  }
  const epoch = f.session.analysisSession.epoch;
  ui.send('list-analyses', { requestId: 'overview' }); await tick();
  const overview = ui.messages.find(message => message.type === 'analyses' && message.requestId === 'overview');
  assert.equal(overview.entries.length, 2); assert.equal(overview.maximumBytes, 6_000_000); assert.equal(overview.maximumRecords, 12);
  for (const entry of overview.entries) {
    assert.equal(entry.previousAudit, true); assert.ok(entry.estimatedBytes > 0);
    assert.ok(entry.title.length <= 160); assert.doesNotMatch(entry.title, /\u0000/);
    assert.equal('url' in entry, false); assert.equal('runs' in entry, false); assert.equal('textExcerpt' in entry, false);
  }
  assert.doesNotMatch(JSON.stringify(f.session), /Current page|Other page/);
  ui.send('clear-tab-analysis', { requestId: 'stale-delete', targetTabId: 20, documentToken: 'wrong-document' }); await tick();
  assert.equal(other.state().audit.id, '20-b');
  assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'stale-delete' && message.code === 'page-changed'));
  ui.send('clear-tab-analysis', { requestId: 'delete-other', targetTabId: 20, documentToken: 'token-20' }); await tick();
  assert.equal(ui.state().audit.id, '10-b'); assert.equal(ui.state().previousAudit.id, '10-a');
  assert.equal(other.state().audit, null); assert.equal(other.state().previousAudit, null);
  assert.equal(other.state().lastEvent, 'data-cleared'); assert.equal(f.session.analysisSession.epoch, epoch);
  assert.deepEqual(ui.messages.find(message => message.type === 'analyses' && message.requestId === 'delete-other').entries.map((entry: any) => entry.tabId), [10]);
  await f.emitContent(20, { type: 'audit', requestId: '20-b', audit: retainedAudit('20-b', 20, 2) });
  assert.equal(other.state().audit, null, 'A late result cannot restore deleted analysis');
  ui.send('clear-data'); await tick();
  assert.equal(ui.state().previousAudit, null);
  assert.equal('previousAudit' in f.session.analysisSession.documents['10'], false);
});

test('overview title lookups cannot return navigated records or override a newer overview request', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-audit', { requestId: 'scanned' }); await tick();
  await f.emitContent(10, { type: 'audit', requestId: 'scanned', audit: retainedAudit('scanned') });
  let finish!: (value: unknown) => void;
  f.api.tabs.get = () => new Promise(resolve => { finish = resolve; });
  ui.send('list-analyses', { requestId: 'old-overview' }); await tick();
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  ui.send('list-analyses', { requestId: 'new-overview' }); await tick();
  finish({ id: 10, windowId: 1, title: 'Old title' }); await tick();
  assert.equal(ui.messages.some(message => message.type === 'analyses' && message.requestId === 'old-overview'), false);
  assert.deepEqual(ui.messages.find(message => message.type === 'analyses' && message.requestId === 'new-overview').entries, []);
});

test('clearing one tab while its handshake waits cannot resurrect its saved results', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-audit', { requestId: 'scanned' }); await tick();
  const audit = retainedAudit('scanned');
  await f.emitContent(10, { type: 'audit', requestId: 'scanned', audit });
  const send = f.api.tabs.sendMessage;
  let finish!: (value: any) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'hello'
    ? new Promise(resolve => { finish = resolve; }) : send(tabId, command);
  const otherSidebar = f.sidebar(1); await tick();
  ui.send('clear-tab-analysis', { requestId: 'clear-during-hello', targetTabId: 10, documentToken: 'token-10' }); await tick();
  finish({ documentToken: 'token-10', audit, selected: null, picker: false, auditRequest: 'scanned' }); await tick();
  assert.equal(ui.state().audit, null); assert.equal(otherSidebar.state().audit, null);
  assert.equal('audit' in f.session.analysisSession.documents['10'], false);
});

test('an old command transport failure cannot disable a newer scan', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  const send = f.api.tabs.sendMessage;
  let rejectOld!: (error: Error) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.requestId === 'old-show'
    ? new Promise((_, reject) => { rejectOld = reject; }) : send(tabId, command);
  ui.send('show-node', { requestId: 'old-show', referenceId: 'old-target' }); await tick();
  ui.send('start-audit', { requestId: 'new-scan' }); await tick();
  rejectOld(new Error('No receiver')); await tick();
  assert.equal(ui.state().access, 'ready'); assert.equal(ui.state().audit, null);
  assert.ok(!ui.messages.some(message => message.type === 'error' && message.requestId === 'old-show'), 'Obsolete failure must not replace a new scan status');
});

test('a failed old picker command cannot disable a newer picker or selection in the same document', async () => {
  for (const next of ['start-picker', 'select-node']) {
    const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
    const send = f.api.tabs.sendMessage;
    let rejectOld!: (error: Error) => void;
    f.api.tabs.sendMessage = (tabId: number, command: any) => command.requestId === 'old-picker'
      ? new Promise((_, reject) => { rejectOld = reject; }) : send(tabId, command);
    ui.send('start-picker', { requestId: 'old-picker' }); await tick();
    const revision = ui.state().documentRevision;
    ui.send(next, { requestId: 'new-selection', referenceId: 'current-element' }); await tick();
    if (next === 'select-node') {
      const snapshot = { id: 'new-snapshot', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {}, stale: false };
      await f.emitContent(10, { type: 'selected', requestId: 'new-selection', snapshot });
    }
    rejectOld(new Error('No receiver')); await tick();
    assert.equal(ui.state().documentRevision, revision);
    assert.equal(ui.state().access, 'ready', next);
    assert.equal(ui.state().picker, next === 'start-picker', next);
    if (next === 'select-node') assert.equal(ui.state().selected.id, 'new-snapshot');
    assert.ok(!ui.messages.some(message => message.type === 'error' && message.requestId === 'old-picker'));

    // Cancellation must keep the current picker request attached to its
    // restored snapshot, so later staleness still reaches the sidebar.
    if (next === 'start-picker') {
      ui.send('cancel-picker', { requestId: 'cancel-current' }); await tick();
      const snapshot = { id: 'restored-snapshot', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {}, stale: false };
      await f.emitContent(10, { type: 'picker-cancelled', requestId: 'new-selection', snapshot });
      await f.emitContent(10, { type: 'stale', requestId: 'new-selection', snapshot: { ...snapshot, stale: true } });
      assert.equal(ui.state().picker, false);
      assert.equal(ui.state().selected.id, 'restored-snapshot');
      assert.equal(ui.state().selected.stale, true);
    }
  }
});

test('downloads complete once after a delayed ownership write without regressing to started', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  let releaseWrite!: () => void;
  const set = f.api.storage.session.set;
  f.api.storage.session.set = (value: any) => 'download:71' in value
    ? new Promise<void>(resolve => { releaseWrite = () => { void set(value).then(resolve); }; }) : set(value);
  f.api.permissions.contains = async () => true;
  f.api.downloads = {
    onChanged: new Event(), download: async () => 71,
    search: async (detail: any) => { f.calls.push({ kind: 'download-search', detail }); return [{ id: 71, state: 'complete' }]; },
  };
  f.api.permissions.onAdded.emit({ permissions: ['downloads'] });
  ui.send('save-export', { requestId: 'save-delayed', filename: 'style-inspector-lite-colors.css', mime: 'text/css', text: '.sample { color: #123456; }' }); await tick();
  const statuses = () => ui.messages.filter(message => message.type === 'saved').map(message => message.status);
  assert.deepEqual(statuses(), ['started']);
  f.api.downloads.onChanged.emit({ id: 71, state: { current: 'complete' } });
  f.api.downloads.onChanged.emit({ id: 71, state: { current: 'complete' } }); await tick();
  assert.deepEqual(statuses(), ['started']);
  releaseWrite(); await tick();
  assert.deepEqual(statuses(), ['started', 'complete']);
  assert.equal(f.session['download:71'], undefined);
  f.api.downloads.onChanged.emit({ id: 71, state: { current: 'complete' } });
  f.api.downloads.onChanged.emit({ id: 999, state: { current: 'interrupted' } }); await tick();
  assert.deepEqual(statuses(), ['started', 'complete']);
  assert.ok(f.calls.filter(call => call.kind === 'download-search').every(call => call.detail.id === 71));
  assert.deepEqual(f.calls.filter(call => call.kind === 'blob-created').map(call => call.detail), f.calls.filter(call => call.kind === 'blob-revoked').map(call => call.detail));
});

test('completion before download returns its ID is reconciled only for the owned transfer', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  let returnId!: (id: number) => void;
  f.api.permissions.contains = async () => true;
  f.api.downloads = {
    onChanged: new Event(), download: () => new Promise<number>(resolve => { returnId = resolve; }),
    search: async (detail: any) => { f.calls.push({ kind: 'download-search', detail }); return [{ id: 72, state: 'complete' }]; },
  };
  f.api.permissions.onAdded.emit({ permissions: ['downloads'] });
  ui.send('save-export', { requestId: 'save-early', filename: 'style-inspector-lite-colors.css', mime: 'text/css', text: 'p { color: black; }' }); await tick();
  f.api.downloads.onChanged.emit({ id: 72, state: { current: 'complete' } }); await tick();
  assert.equal(ui.messages.filter(message => message.type === 'saved').length, 0);
  assert.equal(f.calls.filter(call => call.kind === 'download-search').length, 0);
  returnId(72); await tick();
  assert.deepEqual(ui.messages.filter(message => message.type === 'saved').map(message => message.status), ['started', 'complete']);
  assert.equal(f.session['download:72'], undefined);
  assert.equal(f.calls.filter(call => call.kind === 'blob-revoked').length, 1);
});

test('download recovery distinguishes user cancellation, disk errors and unknown interruption', async () => {
  const f = await fixture(), ui = f.sidebar(1), other = f.sidebar(2); await tick();
  const errors = new Map<number, string | undefined>([[81, 'USER_CANCELED'], [82, 'FILE_NO_SPACE'], [83, undefined]]);
  f.api.downloads = {
    onChanged: new Event(), search: async (detail: any) => { f.calls.push({ kind: 'download-search', detail }); return [{ id: detail.id, state: 'interrupted', error: errors.get(detail.id) }]; },
  };
  f.api.permissions.onAdded.emit({ permissions: ['downloads'] });
  for (const id of errors.keys()) {
    // The previous event page stored ownership; this one has no live URL map.
    f.session[`download:${id}`] = { requestId: `restored-${id}`, windowId: 1 };
    f.api.downloads.onChanged.emit({ id, state: { current: 'interrupted' }, ...(id === 82 ? { error: { current: 'FILE_NO_SPACE' } } : {}) });
  }
  f.api.downloads.onChanged.emit({ id: 900, state: { current: 'interrupted' } }); await tick();
  const results = ui.messages.filter(message => message.type === 'saved').sort((a, b) => a.downloadId - b.downloadId);
  assert.deepEqual(results.map(message => [message.downloadId, message.status]), [[81, 'cancelled'], [82, 'failed'], [83, 'failed']]);
  assert.equal(other.messages.filter(message => message.type === 'saved').length, 0);
  assert.ok(f.calls.filter(call => call.kind === 'download-search').every(call => errors.has(call.detail.id)));
  assert.ok([...errors.keys()].every(id => f.session[`download:${id}`] === undefined));
});

test('failed download ownership storage still reports actual completion and revokes the object URL', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  const set = f.api.storage.session.set;
  f.api.storage.session.set = (value: any) => 'download:91' in value ? Promise.reject(new Error('storage full')) : set(value);
  f.api.permissions.contains = async () => true;
  f.api.downloads = { onChanged: new Event(), download: async () => 91, search: async () => [{ id: 91, state: 'complete' }] };
  f.api.permissions.onAdded.emit({ permissions: ['downloads'] });
  ui.send('save-export', { requestId: 'save-storage-failure', filename: 'style-inspector-lite-colors.css', mime: 'text/css', text: 'p { color: black; }' }); await tick();
  assert.deepEqual(ui.messages.filter(message => message.type === 'saved').map(message => message.status), ['started', 'complete']);
  assert.ok(ui.messages.some(message => message.type === 'error' && message.code === 'storage-failed'));
  assert.equal(f.calls.filter(call => call.kind === 'blob-revoked').length, 1);
});

test('an explicit rescan activates a new website in the same window without reopening or automatic scans', async () => {
  const f = await fixture();
  f.api.action.onClicked.emit(f.tabs.get(10)); f.api.action.onClicked.emit(f.tabs.get(20));
  const ui = f.sidebar(1), other = f.sidebar(2); await tick();
  const before = f.calls.length;
  f.tabs.get(10).url = 'https://new.example/page';
  f.documents.delete(10);
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  f.api.permissions.onAdded.emit({ origins: ['http://*/*', 'https://*/*'] }); await tick();
  assert.equal(ui.state().access, 'needs-activation');
  assert.equal(f.calls.slice(before).some(call => call.kind === 'inject' || call.kind === 'open'), false);
  assert.equal(f.calls.slice(before).some(call => call.kind === 'content-command' && call.detail.type === 'start-audit'), false);
  ui.send('start-audit', { requestId: 'new-site', ...auditIntent(ui.state()) }); await tick();
  assert.equal(ui.state().access, 'ready'); assert.equal(ui.state().tabId, 10);
  assert.equal(other.state().access, 'ready'); assert.equal(other.state().documentToken, 'token-20');
  assert.equal(f.calls.slice(before).filter(call => call.kind === 'open').length, 0);
  assert.equal(f.calls.slice(before).filter(call => call.kind === 'inject').length, 1);
  const scans = f.calls.slice(before).filter(call => call.kind === 'content-command' && call.detail.type === 'start-audit');
  assert.equal(scans.length, 1); assert.equal(scans[0]!.detail.tabId, 10);
  for (const call of f.calls.filter(call => call.kind === 'tabs-query')) assert.deepEqual(Object.keys(call.detail).sort(), ['active', 'windowId']);
});

test('page permission failure remains retryable and unsupported protocols never receive injection', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  const execute = f.api.scripting.executeScript;
  f.api.scripting.executeScript = async () => { throw new Error('Missing host permission'); };
  ui.send('start-audit', { requestId: 'no-permission', ...auditIntent(ui.state()) }); await tick();
  assert.equal(ui.state().access, 'needs-activation');
  assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'no-permission' && message.code === 'activation-required'));
  f.api.scripting.executeScript = execute;
  ui.send('start-audit', { requestId: 'granted', ...auditIntent(ui.state()) }); await tick();
  assert.equal(ui.state().access, 'ready');
  assert.equal(f.calls.some(call => call.kind === 'open'), false);
  const before = f.calls.filter(call => call.kind === 'inject').length;
  f.tabs.get(10).url = 'about:config';
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  ui.send('start-audit', { requestId: 'unsupported', ...auditIntent(ui.state()) }); await tick();
  assert.equal(ui.state().access, 'unsupported');
  assert.equal(f.calls.filter(call => call.kind === 'inject').length, before);
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'unsupported' && call.detail.type === 'start-audit'), false);
});

test('a same-tab same-URL navigation invalidates a pending permission intent even when both tokens are null', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  const intent = auditIntent(ui.state());
  assert.equal(intent.expectedDocumentToken, null);
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  assert.equal(ui.state().documentToken, null);
  assert.ok(ui.state().documentRevision > intent.expectedRevision);
  ui.send('start-audit', { requestId: 'outdated-grant', ...intent }); await tick();
  assert.equal(f.calls.some(call => call.kind === 'inject'), false);
  assert.ok(ui.messages.some(message => message.type === 'error' && message.requestId === 'outdated-grant' && message.code === 'page-changed'));
});

test('navigation while the explicit audit queries its active tab cannot inject into either page', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  const query = f.api.tabs.query;
  let finishQuery!: (value: any) => void;
  f.api.tabs.query = () => new Promise(resolve => { finishQuery = resolve; });
  ui.send('start-audit', { requestId: 'query-race', ...auditIntent(ui.state()) }); await tick();
  f.tabs.get(10).url = 'https://changed.example/';
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  f.api.tabs.query = query;
  finishQuery([f.tabs.get(10)]); await tick();
  assert.equal(f.calls.some(call => call.kind === 'inject'), false);
  assert.equal(ui.state().access, 'needs-activation');
  assert.ok(!ui.messages.some(message => message.type === 'error' && message.requestId === 'query-race'));
});

test('an obsolete audit activation cannot report an error after a newer audit started', async () => {
  for (const outcome of ['resolved', 'rejected']) {
    const f = await fixture(), ui = f.sidebar(1); await tick();
    const query = f.api.tabs.query;
    let finishQuery!: (value: any) => void;
    let failQuery!: (error: Error) => void;
    f.api.tabs.query = () => new Promise((resolve, reject) => { finishQuery = resolve; failQuery = reject; });
    ui.send('start-audit', { requestId: 'old-activation', ...auditIntent(ui.state()) }); await tick();
    f.api.tabs.query = query;
    ui.send('start-audit', { requestId: 'current-audit' }); await tick();
    assert.ok(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'start-audit' && call.detail.requestId === 'current-audit'));
    if (outcome === 'resolved') finishQuery([f.tabs.get(10)]); else failQuery(new Error('Tab no longer exists'));
    await tick();
    assert.equal(ui.state().access, 'ready');
    assert.ok(!ui.messages.some(message => message.type === 'error' && message.requestId === 'old-activation'), outcome);
    assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'old-activation'), false);
  }
});

test('navigation while injection is pending cancels the old audit before hello or scan', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  let finishInjection!: (value: any) => void;
  f.api.scripting.executeScript = () => new Promise(resolve => { finishInjection = resolve; });
  ui.send('start-audit', { requestId: 'injection-race', ...auditIntent(ui.state()) }); await tick();
  f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10)); await tick();
  finishInjection([{ result: true }]); await tick();
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'injection-race'), false);
  assert.equal(ui.state().access, 'needs-activation');
  assert.ok(!ui.messages.some(message => message.type === 'error' && message.requestId === 'injection-race'));
});

test('switching active tabs during the audit handshake cannot dispatch a scan or revive the old record', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  const send = f.api.tabs.sendMessage;
  let finishHello!: (value: any) => void;
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'hello' && command.requestId === 'hello-race'
    ? new Promise(resolve => { finishHello = resolve; }) : send(tabId, command);
  ui.send('start-audit', { requestId: 'hello-race', ...auditIntent(ui.state()) }); await tick();
  const tab = { id: 11, windowId: 1, active: true, url: 'https://next.example/' };
  f.tabs.get(10).active = false; f.tabs.set(11, tab);
  f.api.tabs.onActivated.emit({ windowId: 1, tabId: 11 }); await tick();
  finishHello({ documentToken: 'token-10', selected: null, audit: null }); await tick();
  assert.equal(ui.state().tabId, 11); assert.equal(ui.state().access, 'needs-activation');
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'start-audit'), false);
  assert.equal(f.session.analysisSession?.documents['10'], undefined);
});

test('host revocation clears live page records and an existing receiver cannot bypass the next injection permission check', async () => {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  ui.send('start-picker', { requestId: 'before-revoke' }); await tick();
  f.api.permissions.onRemoved.emit({ permissions: ['downloads'] }); await tick();
  assert.equal(ui.state().access, 'ready', 'An unrelated optional permission does not clear page access');
  f.api.permissions.onRemoved.emit({ origins: ['https://*/*'] }); await tick();
  assert.equal(ui.state().access, 'needs-activation'); assert.equal(ui.state().picker, false);
  assert.equal(ui.state().documentToken, null); assert.deepEqual(f.session.analysisSession.documents, {});
  assert.ok(f.calls.some(call => call.kind === 'content-command' && call.detail.type === 'clear-data'));
  assert.ok(f.documents.has(10), 'The receiver remains alive in this regression fixture');
  f.api.tabs.onActivated.emit({ windowId: 1, tabId: 10 }); await tick();
  assert.equal(ui.state().access, 'needs-activation', 'Passive tab activation cannot revive a receiver after access was revoked');
  const reopened = f.sidebar(1); await tick();
  assert.equal(reopened.state().access, 'needs-activation', 'Sidebar readiness cannot revive revoked access either');
  await f.emitContent(10, { type: 'selected', requestId: 'before-revoke', snapshot: { document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, textRuns: [], styles: {} } });
  assert.equal(ui.state().selected, null);
  f.api.scripting.executeScript = async () => { throw new Error('Host access revoked'); };
  ui.send('start-audit', { requestId: 'revoked', ...auditIntent(ui.state()) }); await tick();
  assert.equal(ui.state().access, 'needs-activation');
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'revoked'), false);
});

test('permission revocation while an audit injects prevents its handshake and scan', async () => {
  const f = await fixture(), ui = f.sidebar(1); await tick();
  let finishInjection!: (value: any) => void;
  f.api.scripting.executeScript = () => new Promise(resolve => { finishInjection = resolve; });
  ui.send('start-audit', { requestId: 'revoke-race', ...auditIntent(ui.state()) }); await tick();
  f.api.permissions.onRemoved.emit({ origins: ['https://*/*'] }); await tick();
  finishInjection([{ result: true }]); await tick();
  assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === 'revoke-race'), false);
  assert.equal(ui.state().access, 'needs-activation');
});

test('closing the target tab or window while injection is pending prevents a late audit', async () => {
  for (const closed of ['tab', 'window']) {
    const f = await fixture(), ui = f.sidebar(1); await tick();
    let finishInjection!: (value: any) => void;
    f.api.scripting.executeScript = () => new Promise(resolve => { finishInjection = resolve; });
    ui.send('start-audit', { requestId: `close-${closed}`, ...auditIntent(ui.state()) }); await tick();
    if (closed === 'tab') f.api.tabs.onRemoved.emit(10);
    else f.api.windows.onRemoved.emit(1);
    await tick();
    finishInjection([{ result: true }]); await tick();
    assert.equal(f.calls.some(call => call.kind === 'content-command' && call.detail.requestId === `close-${closed}`), false, closed);
    assert.equal(f.session.analysisSession?.documents['10'], undefined, closed);
    if (closed === 'tab') assert.equal(ui.state().tabId, null);
  }
});

async function diagnosticFixture(source: 'audit' | 'selection' = 'selection', enabled = true) {
  const f = await fixture(); f.api.action.onClicked.emit(f.tabs.get(10)); const ui = f.sidebar(1); await tick();
  if (enabled) { ui.send('update-settings', { settings: { showDiagnostics: true } }); await tick(); }
  const other = f.sidebar(1); await tick();
  f.api.runtime.getManifest = () => ({ version: '1.0.2' });
  f.api.runtime.getBrowserInfo = async () => ({ name: 'Firefox', version: '158.0', vendor: 'ignored-vendor', buildID: 'ignored-build' });
  const run: TextRun = { id: 'node-1:text1', elementRef: 'node-1', tagName: 'span', selector: 'span:nth-of-type(1)', foreground: parseColor('#FFF9'), background: parseColor('transparent'), effectiveBackground: parseColor('#161717').rgba, reasons: ['layered-background'], fontSizeCssPx: 14, fontWeight: 400, ownOpaqueBackground: false,
    contrast: evaluateContrast({ foreground: parseColor('#FFF9').rgba, background: null, reasons: ['layered-background'], fontSizeCssPx: 14, fontWeight: 400 }), fontSize: evaluateFontSize(14), textExcerpt: { value: 'Private message contents', truncated: false } };
  const data = { id: 'diagnostic-source', document: { windowId: 1, tabId: 10, frameId: 0, documentToken: 'token-10' }, measuredAt: '2026-10-20T12:00:00.000Z', stale: true, viewport: { width: 1280, height: 800 }, reasons: [], elementRef: 'node-1', styles: { colors: {}, typography: {}, layout: {} }, textRuns: [run], runs: [run], palette: [], fonts: [], status: 'complete', scanned: 1, skipped: 0, total: 1 };
  ui.send(source === 'audit' ? 'start-audit' : 'start-picker', { requestId: 'diagnostic-source' }); await tick();
  await f.emitContent(10, { type: source === 'audit' ? 'audit' : 'selected', requestId: 'diagnostic-source', ...(source === 'audit' ? { audit: data } : { snapshot: data }) });
  const report: DiagnosticReport = { schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: '2026-10-20T12:01:00.000Z', generator: { name: 'Style Inspector Lite', version: null }, browser: { name: 'unknown', version: null }, measurement: diagnosticMeasurement(run, source, data.measuredAt, true, 1, data.viewport, []), currentViewport: data.viewport, layers: [], samples: [], limitations: ['current-styles-not-a-new-measurement'] };
  const send = f.api.tabs.sendMessage;
  f.api.tabs.sendMessage = async (tabId: number, command: any) => {
    if (command.type === 'diagnose-node') { f.calls.push({ kind: 'diagnostic-command', detail: command }); return { documentToken: 'token-10', report }; }
    return send(tabId, command);
  };
  const intent = () => ({ requestId: 'diagnostic-request', referenceId: run.elementRef, runId: run.id, source: { kind: source, id: data.id }, ...auditIntent(ui.state()) });
  return { ...f, ui, other, report, intent, data };
}

test('diagnostics require the setting, persist opt-in and reset to disabled without reading page layers', async () => {
  const f = await diagnosticFixture('selection', false);
  assert.equal(f.ui.state().settings.showDiagnostics, false);
  f.ui.send('diagnose-node', f.intent()); await tick();
  assert.equal(f.calls.some(call => call.kind === 'diagnostic-command'), false);
  f.ui.send('update-settings', { settings: { showDiagnostics: true } }); await tick();
  assert.equal(f.other.state().settings.showDiagnostics, true);
  f.ui.send('diagnose-node', f.intent()); await tick();
  assert.equal(f.calls.filter(call => call.kind === 'diagnostic-command').length, 1);
  f.ui.send('reset-settings'); await tick();
  assert.equal(f.ui.state().settings.showDiagnostics, false);
  f.ui.send('diagnose-node', f.intent()); await tick();
  assert.equal(f.calls.filter(call => call.kind === 'diagnostic-command').length, 1);
});

test('explicit diagnostics reply only to the requester and never change state, session storage or selection', async () => {
  for (const source of ['audit', 'selection'] as const) {
    const f = await diagnosticFixture(source);
    const before = structuredClone(f.ui.state()), session = structuredClone(f.session), writes = f.calls.filter(call => call.kind === 'session-write').length;
    f.ui.send('diagnose-node', f.intent()); await tick();
    const response = f.ui.messages.filter(message => message.type === 'diagnostic');
    assert.equal(response.length, 1, source); assert.equal(f.other.messages.some(message => message.type === 'diagnostic'), false);
    assert.equal(response[0].report.generator.version, '1.0.2'); assert.equal(response[0].report.browser.name, 'Firefox');
    assert.equal(response[0].report.measurement.measuredAt, '2026-10-20T12:00:00.000Z');
    assert.equal(response[0].report.capturedAt, '2026-10-20T12:01:00.000Z');
    assert.equal(JSON.stringify(response[0]).includes('Private message'), false);
    assert.deepEqual(f.ui.state(), before); assert.deepEqual(f.session, session);
    assert.equal(f.calls.filter(call => call.kind === 'session-write').length, writes);
    assert.equal(f.calls.filter(call => call.kind === 'diagnostic-command').length, 1);
  }
});

test('diagnostics reject mismatched source, run and document before dispatching content reads', async () => {
  const f = await diagnosticFixture();
  for (const patch of [{ expectedDocumentToken: 'wrong' }, { expectedRevision: 999 }, { expectedTabId: 20 }, { source: { kind: 'selection', id: 'old-source' } }, { source: { kind: 'audit', id: 'diagnostic-source' } }, { runId: 'different-text' }, { referenceId: 'other-element' }]) {
    f.ui.send('diagnose-node', { ...f.intent(), ...patch }); await tick();
    assert.equal(f.ui.messages.at(-1).type, 'error');
  }
  assert.equal(f.calls.some(call => call.kind === 'diagnostic-command'), false);
});

test('late diagnostic successes and errors are discarded across selection, scan, clear, navigation and port races', async () => {
  for (const boundary of ['start-picker', 'cancel-picker', 'select-node', 'refresh-selection', 'start-audit', 'clear-data', 'navigation', 'tab', 'disconnect', 'settings', 'disable-diagnostics', 'reset-settings', 'revocation']) for (const failure of [false, true]) {
    const f = await diagnosticFixture();
    const send = f.api.tabs.sendMessage; let resolve!: (value: any) => void, reject!: (error: Error) => void;
    f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'diagnose-node' ? new Promise((yes, no) => { resolve = yes; reject = no; }) : send(tabId, command);
    f.ui.send('diagnose-node', f.intent()); await tick();
    if (boundary === 'navigation') f.api.tabs.onUpdated.emit(10, { status: 'loading' }, f.tabs.get(10));
    else if (boundary === 'tab') { f.tabs.get(10).active = false; f.tabs.set(11, { id: 11, windowId: 1, active: true, url: 'https://next.example/' }); f.api.tabs.onActivated.emit({ windowId: 1, tabId: 11 }); }
    else if (boundary === 'disconnect') f.ui.port.onDisconnect.emit();
    else if (boundary === 'settings') f.ui.send('update-settings', { settings: { contrastTarget: 'AAA' } });
    else if (boundary === 'disable-diagnostics') f.ui.send('update-settings', { settings: { showDiagnostics: false } });
    else if (boundary === 'revocation') f.api.permissions.onRemoved.emit({ origins: ['https://example.com/*'] });
    else f.ui.send(boundary, { referenceId: 'new-node', ...auditIntent(f.ui.state()) });
    await tick(); const before = f.ui.messages.length;
    if (failure) reject(new Error('Old diagnostic failure')); else resolve({ documentToken: 'token-10', report: f.report });
    await tick();
    assert.equal(f.ui.messages.slice(before).some(message => message.requestId === 'diagnostic-request'), false, `${boundary}, failure=${failure}`);
    assert.equal(JSON.stringify(f.session).includes('contrast-diagnostic'), false);
  }
});

test('newer diagnostics supersede older requests and a stale measurement event retires an in-flight report', async () => {
  const f = await diagnosticFixture();
  const send = f.api.tabs.sendMessage, pending = new Map<string, (value: any) => void>();
  f.api.tabs.sendMessage = (tabId: number, command: any) => command.type === 'diagnose-node' ? new Promise(resolve => pending.set(command.requestId, resolve)) : send(tabId, command);
  f.ui.send('diagnose-node', { ...f.intent(), requestId: 'older' }); await tick();
  f.ui.send('diagnose-node', { ...f.intent(), requestId: 'newer' }); await tick();
  pending.get('newer')!({ documentToken: 'token-10', report: f.report }); await tick();
  pending.get('older')!({ documentToken: 'token-10', report: f.report }); await tick();
  assert.deepEqual(f.ui.messages.filter(message => message.type === 'diagnostic').map(message => message.requestId), ['newer']);
  f.ui.send('diagnose-node', { ...f.intent(), requestId: 'stale-pending' }); await tick();
  await f.emitContent(10, { type: 'stale', requestId: 'diagnostic-source' });
  pending.get('stale-pending')!({ documentToken: 'token-10', report: f.report }); await tick();
  assert.equal(f.ui.messages.some(message => message.type === 'diagnostic' && message.requestId === 'stale-pending'), false);
});
