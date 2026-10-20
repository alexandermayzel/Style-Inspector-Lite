import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
import { webcrypto } from 'node:crypto';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';

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

async function fixture() {
  const calls: { kind: string; detail?: any }[] = [];
  const local: Record<string, any> = {}, session: Record<string, any> = {};
  const tabs = new Map<number, any>([[10, { id: 10, windowId: 1, url: 'https://example.com/', active: true }], [20, { id: 20, windowId: 2, url: 'https://other.example/', active: true }]]);
  const documents = new Map<number, { token: string; selected: any }>();
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
      query: async (detail: any) => { calls.push({ kind: 'tabs-query', detail }); return [...tabs.values()].filter(tab => tab.windowId === detail.windowId && tab.active); },
      sendMessage: async (tabId: number, command: any) => {
        calls.push({ kind: 'content-command', detail: { tabId, ...command } });
        const doc = documents.get(tabId);
        if (!doc) throw new Error('No receiver');
        if (command.type === 'hello') return { documentToken: doc.token, selected: doc.selected, audit: null, picker: false };
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
  vm.runInNewContext((await bundle).outputFiles[0]!.text, { browser: api, crypto: webcrypto, structuredClone, TextEncoder, URL: TrackedURL, Blob, console });
  await tick();
  function sidebar(windowId: number) {
    const messages: any[] = [];
    const port = { name: 'sidebar', sender: { id: 'test-addon', url: 'moz-extension://test/sidebar/index.html' }, onMessage: new Event(), onDisconnect: new Event(), postMessage: (message: any) => messages.push(structuredClone(message)) };
    api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'ready', windowId, requestId: `ready-${windowId}` });
    return { port, messages, state: () => messages.filter(message => message.type === 'state').at(-1)?.state, send: (type: string, extras = {}) => port.onMessage.emit({ type, requestId: `${type}-${Math.random()}`, ...extras }) };
  }
  async function emitContent(tabId: number, event: any) {
    await Promise.all(api.runtime.onMessage.emit({ channel: 'sil-event', documentToken: documents.get(tabId)!.token, epoch: session.analysisSession?.epoch ?? 0, ...event }, { id: 'test-addon', tab: tabs.get(tabId), frameId: 0 }));
    await tick();
  }
  return { api, calls, tabs, documents, local, session, sidebar, emitContent };
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
  assert.equal(f.session.analysisSession.documents['10'].selectionRequest, 'restored-selection');
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

test('rescan clears current analysis before work starts and rejects delayed results while preserving other windows and settings', async () => {
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
  assert.equal(reset.lastEvent, 'audit-reset');
  for (const key of ['selected', 'preview', 'audit', 'progress']) assert.equal(reset[key], null, key);
  assert.equal(reset.picker, false);
  assert.equal(reset.settings.appearance, 'light'); assert.equal(reset.settings.contrastTarget, 'AAA');
  assert.equal(other.state().selected.id, 'selection-20');
  await f.emitContent(10, { type: 'selected', requestId: 'old-selection', snapshot: snapshot(10, 1) });
  await f.emitContent(10, { type: 'audit', requestId: 'old-audit', audit });
  assert.equal(ui.state().selected, null); assert.equal(ui.state().audit, null);
  finish({ ok: true }); await tick();
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
