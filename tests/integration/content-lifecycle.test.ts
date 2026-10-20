import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { elementLabel, ElementRegistry, isOwnElement, registerOwnElement } from '../../src/runtime/dom';
import { evaluateContrast, evaluateFontSize } from '../../src/core/contrast';
import { parseColor } from '../../src/core/colors';

// Isolate document lifecycle coordination from browser measurement. Real DOM
// measurement is covered by the Firefox fixture run, not claimed by this fake.
const bundle = build({ entryPoints: ['src/content.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', plugins: [{
  name: 'measurement-fixture', setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]runtime[\\/]dom\.ts$/ }, () => ({ loader: 'js', contents: `
      export const OVERLAY_ATTRIBUTE='data-style-inspector-overlay';
      export const {elementLabel,ElementRegistry,isOwnElement,registerOwnElement}=globalThis.__realDom;
      export const viewport=()=>({width:window.innerWidth,height:window.innerHeight,devicePixelRatio:window.devicePixelRatio});
      export const directTextCount=(element,maximum=Infinity)=>Math.min(element.textCount,maximum);
      export const isRendered=()=>true;
      const {evaluateContrast,evaluateFontSize,parseColor}=globalThis.__measurement;
      export const measureRuns=(element,registry,settings,count=element.textCount)=>{if(element.failMeasurement)throw Error('measurement failed');const foreground=parseColor(element.color),background=parseColor(element.backgroundColor),reasons=[...element.paintReasons];return Array.from({length:count},(_,index)=>({id:registry.reference(element)+':text'+(index+1),elementRef:registry.reference(element),tagName:'p',selector:'p:nth-of-type(1)',reasons,foreground,background,effectiveBackground:background.rgba,fontSizeCssPx:16,fontWeight:400,ownOpaqueBackground:true,contrast:evaluateContrast({foreground:foreground.rgba,background:background.rgba,fontSizeCssPx:16,fontWeight:400,reasons,target:settings.contrastTarget}),fontSize:evaluateFontSize(16)}))};
      let serial=0;
      export const measureSnapshot=(element,identity,registry,settings,options={})=>({id:'fixture-snapshot-'+(++serial),document:{...identity},elementRef:registry.reference(element),tagName:'p',selector:'p:nth-of-type(1)',measuredAt:new Date().toISOString(),viewport:viewport(),stale:false,reasons:[element,...element.snapshotChildren].reduce((count,node)=>count+node.textCount,0)>100?['selection-text-limit']:[],styles:{colors:{},typography:{},layout:{}},textRuns:[element,...element.snapshotChildren].flatMap(node=>measureRuns(node,registry,settings,Math.min(node.textCount,100))).slice(0,100).map(run=>({...run,...(options.includeText?{textExcerpt:{value:'Synthetic selection',truncated:false}}:{})})),...(options.includeText?{textExcerpt:{value:'Synthetic selection',truncated:false}}:{}),rect:{x:0,y:0,width:20,height:20}});
    ` }));
  },
}] });

class FakeElement {
  constructor(private readonly mutation: (record: any) => void = () => {}) {}
  isConnected = true;
  parentElement: FakeElement | null = null;
  children: FakeElement[] = [];
  tagName = 'P';
  get localName() { return this.tagName.toLowerCase(); }
  textCount = 0;
  snapshotChildren: FakeElement[] = [];
  failMeasurement = false;
  color = '#FAFAFA';
  backgroundColor = '#161717';
  fontFamily = 'sans-serif';
  paintReasons: string[] = [];
  scrolls = 0;
  style: Record<string, any> = {};
  attributes: Record<string, string> = {};
  hidden = false;
  textContent = '';
  shadowChildren: FakeElement[] = [];
  rect = { left: 0, top: 0, width: 20, height: 20 };
  rangeRects: { left: number; top: number; right: number; bottom: number; width: number; height: number }[] = [];
  setAttribute(name: string, value: string) { this.attributes[name] = value; if (this.isConnected) this.mutation({ type: 'attributes', attributeName: name, target: this, addedNodes: [], removedNodes: [] }); }
  removeAttribute(name: string) { delete this.attributes[name]; if (this.isConnected) this.mutation({ type: 'attributes', attributeName: name, target: this, addedNodes: [], removedNodes: [] }); }
  hasAttribute(name: string) { return name in this.attributes; }
  attachShadow() { return { append: (...elements: FakeElement[]) => { this.shadowChildren.push(...elements); } }; }
  append(...elements: FakeElement[]) { for (const element of elements) { element.parentElement = this; element.isConnected = this.isConnected; this.children.push(element); } this.mutation({ type: 'childList', target: this, addedNodes: elements, removedNodes: [] }); }
  remove() { const parent = this.parentElement; this.isConnected = false; this.parentElement = null; if (parent) { parent.children = parent.children.filter(element => element !== this); this.mutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] }); } }
  scrollIntoView() { this.scrolls++; }
  getBoundingClientRect() { return { ...this.rect, x: this.rect.left, y: this.rect.top, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
}
async function fixture(initialEpoch = 0) {
  const registries: ElementRegistry[] = [];
  class FixtureRegistry extends ElementRegistry {
    constructor(token: string) { super(token); registries.push(this); }
  }
  const listeners = new Map<string, ((event: any) => void)[]>();
  const listenerOptions = new Map<string, any>();
  const messages: any[] = [];
  let handler: (message: any, sender: any) => any;
  let observerCallback: (records: any[]) => void;
  const mutations: any[] = [];
  const queueMutation = (record: any) => mutations.push(record);
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const frames = new Map<number, () => void>();
  let nextTimer = 0;
  const browser = { runtime: { id: 'test-addon', onMessage: { addListener(callback: any) { handler = callback; } }, sendMessage: async (event: any) => { messages.push(structuredClone(event)); } }, i18n: { getMessage: (key: string, value?: string) => key === 'highlightHint' ? `Highlighted: ${value} · Esc to dismiss` : key, getUILanguage: () => 'en-US' } };
  const window = {
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
    addEventListener(type: string, callback: any, options?: any) { listeners.set(type, [...(listeners.get(type) ?? []), callback]); listenerOptions.set(type, options); },
    removeEventListener(type: string, callback: any) { listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== callback)); },
    setTimeout(callback: () => void, delay = 0) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const element = new FakeElement(queueMutation); element.textCount = 1;
  const documentElement = new FakeElement(queueMutation); documentElement.tagName = 'HTML'; documentElement.append(element); mutations.length = 0;
  const document = { documentElement, createElement: () => { const node = new FakeElement(queueMutation); node.isConnected = false; return node; }, createTreeWalker: () => { const nodes = [...documentElement.children]; let index = 0; return { nextNode: () => nodes[index++] ?? null }; }, createRange: () => { let selected: FakeElement; return { selectNodeContents(node: FakeElement) { selected = node; }, getClientRects: () => selected.rangeRects }; } };
  const context = vm.createContext({ __realDom: { elementLabel, ElementRegistry: FixtureRegistry, isOwnElement, registerOwnElement }, __measurement: { evaluateContrast, evaluateFontSize, parseColor }, __styleInspectorContext: { requestId: 'confirmed', element }, browser, window, document, NodeFilter: { SHOW_ELEMENT: 1 }, getComputedStyle: (node: FakeElement) => ({ color: node.color, backgroundColor: node.backgroundColor, fontFamily: node.fontFamily }), crypto: webcrypto, structuredClone, performance, Element: FakeElement, MutationObserver: class { constructor(callback: any) { observerCallback = callback; } observe() {} takeRecords() { return mutations.splice(0); } }, requestAnimationFrame: (callback: () => void) => { const id = ++nextTimer; frames.set(id, callback); return id; }, cancelAnimationFrame: (id: number) => frames.delete(id), clearTimeout: window.clearTimeout });
  vm.runInContext((await bundle).outputFiles[0]!.text, context);
  const send = async (type: string, requestId: string, epoch = initialEpoch, extra: Record<string, any> = {}) => handler!({ channel: 'sil-content', type, requestId, epoch, windowId: 1, tabId: 10, settings: DEFAULT_SETTINGS, ...extra }, { id: 'test-addon' });
  await send('hello', 'initial');
  const reference = (await send('capture-context', 'confirmed')).snapshot.elementRef;
  const flushMutations = () => { const records = mutations.splice(0); if (records.length) observerCallback!(records); };
  const flushTimers = async (delay: number) => { for (let step = 0; step < 20; step++) { const pending = [...timers].filter(([, timer]) => timer.delay === delay); if (!pending.length) break; for (const [id, timer] of pending) { timers.delete(id); timer.callback(); } await Promise.resolve(); } };
  const flushFrames = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  const registrySize = () => (registries.at(-1)! as unknown as { elements: Map<string, Element> }).elements.size;
  return { registrySize, send, element, reference, messages, context, window, documentElement, mutations, flushMutations, flushTimers, flushFrames, mutate: () => { element.setAttribute('class', 'changed'); flushMutations(); }, listeners, listenerOptions, timers };
}

test('a newer epoch hello cannot resurrect snapshots before delayed clear-data arrives', async () => {
  const f = await fixture();
  assert.ok((await f.send('hello', 'before-clear')).selected);
  const after = await f.send('hello', 'new-generation', 1);
  assert.equal(after.selected, null);
  assert.equal(after.audit, null);
  assert.equal(after.picker, false);
  assert.equal((await f.send('start-picker', 'obsolete', 0)).error, 'stale-document');
});
test('cancelling a picker preserves confirmed identity and its subsequent stale notifications', async () => {
  const f = await fixture();
  await f.send('start-picker', 'picker-request');
  await f.send('cancel-picker', 'cancel-request');
  f.mutate();
  const stale = f.messages.filter(message => message.type === 'stale').at(-1);
  assert.ok(stale);
  assert.equal(stale.requestId, 'picker-request');
  assert.equal(stale.snapshot.elementRef, f.reference);
  assert.equal(stale.snapshot.stale, true);
  assert.equal(f.listeners.get('pointerdown')?.length, 0);
  assert.equal(f.listeners.get('click')?.length, 0);
});
test('picker cancellation restores a confirmed snapshot marked stale during preview', async () => {
  const f = await fixture();
  await f.send('start-picker', 'picker-request');
  f.mutate();
  await f.send('cancel-picker', 'cancel-request');
  const cancelled = f.messages.filter(message => message.type === 'picker-cancelled').at(-1);
  assert.equal(cancelled.snapshot?.stale, true);
});
test('first handshake respects a nonzero session epoch, and later clear drops captured context', async () => {
  const f = await fixture(7);
  assert.ok((await f.send('hello', 'after-first-context')).selected);
  f.context.__styleInspectorContext = { requestId: 'old-capture', element: f.element };
  await f.send('hello', 'clear-generation', 8);
  assert.equal((await f.send('capture-context', 'old-capture', 8)).error, 'target-expired');
});
test('BFCache restoration discards selection, old capture and picker under a fresh document token', async () => {
  const f = await fixture();
  const before = await f.send('hello', 'before-bfcache');
  await f.send('start-picker', 'bfcache-picker');
  f.context.__styleInspectorContext = { requestId: 'old-capture', element: f.element };
  for (const callback of f.listeners.get('pagehide') ?? []) callback({ persisted: true });
  for (const callback of f.listeners.get('pageshow') ?? []) callback({ persisted: true });
  const after = await f.send('hello', 'after-bfcache');
  assert.notEqual(after.documentToken, before.documentToken);
  assert.equal(after.selected, null); assert.equal(after.picker, false); assert.equal(after.audit, null);
  assert.equal((await f.send('capture-context', 'old-capture')).error, 'target-expired');
});

test('showing, scrolling and removing our highlight keeps an audit fresh and repeat navigation works', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  const audit = (await f.send('hello', 'after-audit')).audit;
  assert.equal(audit.status, 'complete'); assert.equal(audit.stale, false);
  const referenceId = audit.runs[0].elementRef;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await f.send('show-node', `show-${attempt}`, 0, { referenceId })).ok, true);
    f.flushMutations();
    for (const listener of f.listeners.get('scroll') ?? []) listener({});
    // Ownership must survive a page script removing our identifying attribute.
    const overlay = f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
    overlay.removeAttribute('data-style-inspector-overlay'); f.flushMutations();
    await f.flushTimers(8000); f.flushMutations();
    for (const listener of f.listeners.get('resize') ?? []) listener({});
    assert.equal((await f.send('hello', 'still-fresh')).audit.stale, false);
  }
  assert.equal(f.element.scrolls, 2);
  assert.equal((await f.send('select-node', 'inspect', 0, { referenceId })).ok, true);
  assert.equal((await f.send('hello', 'inspected')).selected.elementRef, referenceId);
});

test('real mutations mark audit stale without preventing navigation to connected original nodes', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  const referenceId = (await f.send('hello', 'result')).audit.runs[0].elementRef;
  f.mutate();
  assert.equal((await f.send('hello', 'changed')).audit.stale, true);
  assert.equal((await f.send('show-node', 'show-stale', 0, { referenceId })).ok, true);
  assert.equal((await f.send('select-node', 'inspect-stale', 0, { referenceId })).ok, true);
  assert.equal((await f.send('hello', 'remeasured')).selected.stale, false);
  f.element.remove(); f.flushMutations();
  assert.equal((await f.send('show-node', 'removed', 0, { referenceId })).error, 'element-removed');
});

test('explicit highlights identify the target, track nested scroll and resize, and expire with listeners removed', async () => {
  const f = await fixture();
  const stylesBefore = { ...f.element.style };
  f.element.rect = { left: 100, top: 200, width: 140, height: 40 };
  Object.defineProperty(f.element, 'textContent', { get() { throw new Error('Page text must not be captured'); } });
  Object.defineProperty(f.element, 'value', { get() { throw new Error('Input values must not be captured'); } });
  assert.equal((await f.send('show-node', 'show', 0, { referenceId: f.reference })).ok, true);
  const overlay = f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
  const [outline, label] = overlay.shadowChildren;
  assert.match(overlay.style.cssText, /pointer-events:none!important/);
  assert.match(outline!.style.cssText, /border:3px/);
  assert.match(outline!.style.cssText, /box-shadow:.*#fff.*#111827/);
  assert.match(outline!.style.cssText, /background:rgb\(0 117 255 \/ .13\)/);
  assert.equal((overlay as any).lang, 'en-US');
  assert.equal(label!.hidden, false);
  assert.equal(label!.textContent, 'Highlighted: p:nth-of-type(1) · Esc to dismiss');
  assert.equal(outline!.style.left, '100px');
  assert.equal(outline!.style.top, '200px');
  assert.equal(label!.style.top, '170px');
  assert.equal(f.listenerOptions.get('scroll'), true, 'Capture listener also receives nested scroller events');
  assert.equal(f.listeners.get('pointerdown')?.length ?? 0, 0, 'Showing must not intercept page clicks');
  assert.equal([...f.timers.values()].some(timer => timer.delay === 8000), true);
  await f.flushTimers(1000);
  assert.equal(overlay.isConnected, true, 'Explicit highlight outlasts the short selection flash');
  f.element.rect.top = 90;
  for (const listener of f.listeners.get('scroll') ?? []) listener({ target: f.element.parentElement });
  assert.equal(outline!.style.top, '90px');
  assert.equal(label!.style.top, '60px');
  f.element.rect.left = 1270;
  for (const listener of f.listeners.get('resize') ?? []) listener({});
  assert.equal(outline!.style.left, '1270px');
  assert.equal(label!.style.left, '1252px', 'Label remains within the viewport');
  assert.deepEqual(f.element.style, stylesBefore);
  await f.flushTimers(8000);
  assert.equal(overlay.isConnected, false);
  assert.equal(f.listeners.get('keydown')?.length, 0);
  assert.equal(f.listeners.get('scroll')?.length, 1, 'Only the passive audit-change observer remains');
});

test('highlight Escape, picker handoff, rescan and navigation remove the old highlight without leaking guards', async () => {
  const f = await fixture();
  const show = async () => {
    assert.equal((await f.send('show-node', 'show', 0, { referenceId: f.reference })).ok, true);
    return f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
  };
  const overlay = await show();
  let prevented = 0, stopped = 0;
  const keyEvent = { key: 'Enter', preventDefault() { prevented++; }, stopImmediatePropagation() { stopped++; } };
  for (const listener of f.listeners.get('keydown') ?? []) listener(keyEvent);
  assert.equal(prevented, 0); assert.equal(stopped, 0);
  for (const listener of f.listeners.get('keydown') ?? []) listener({ ...keyEvent, key: 'Escape' });
  assert.equal(prevented, 1); assert.equal(stopped, 1);
  assert.equal(overlay.isConnected, false);
  assert.equal(f.messages.some(message => message.type === 'picker-cancelled'), false);

  const beforePicker = await show();
  await f.send('start-picker', 'picker');
  assert.equal(beforePicker.isConnected, false);
  const pickerOverlay = f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
  assert.equal(pickerOverlay.shadowChildren[1]!.textContent, 'pickerHint');
  await f.flushTimers(8000);
  assert.equal(pickerOverlay.isConnected, true, 'An old show timeout must not remove a new picker');
  assert.equal(f.listeners.get('pointerdown')?.length, 1);
  await f.send('cancel-picker', 'cancel');

  const beforeHide = await show();
  for (const listener of f.listeners.get('pagehide') ?? []) listener({ persisted: false });
  assert.equal(beforeHide.isConnected, false);
  assert.equal(f.listeners.get('scroll')?.length, 1, 'Only the passive audit-change observer remains');
  for (const listener of f.listeners.get('pageshow') ?? []) listener({ persisted: false });
  const beforeAudit = await show();
  await f.send('start-audit', 'rescan'); await f.flushTimers(0);
  assert.equal(beforeAudit.isConnected, false);
  assert.equal(f.listeners.get('keydown')?.length, 0);
  assert.equal(f.listeners.get('pointerdown')?.length, 0);
});

test('zero-box wrappers use visible range geometry and removing a shown target clears the overlay', async () => {
  const f = await fixture();
  f.element.rect = { left: 0, top: 0, width: 0, height: 0 };
  f.element.rangeRects = [
    { left: 30, top: 100, right: 90, bottom: 120, width: 60, height: 20 },
    { left: 30, top: 120, right: 150, bottom: 140, width: 120, height: 20 },
  ];
  assert.equal((await f.send('show-node', 'show-wrapper', 0, { referenceId: f.reference })).ok, true);
  const overlay = f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
  const outline = overlay.shadowChildren[0]!;
  assert.equal(outline.style.left, '30px'); assert.equal(outline.style.top, '100px');
  assert.equal(outline.style.width, '120px'); assert.equal(outline.style.height, '40px');
  f.element.remove(); f.flushMutations();
  assert.equal(overlay.isConnected, false);
  assert.equal(f.listeners.get('scroll')?.length, 1, 'Only the passive audit-change observer remains');
  assert.equal((await f.send('show-node', 'removed', 0, { referenceId: f.reference })).error, 'element-removed');
});

test('rescan discards old selection, refs, queued mutations and obsolete jobs while preserving settings', async () => {
  const f = await fixture();
  await f.send('start-audit', 'old-audit');
  await f.send('start-picker', 'old-picker');
  f.element.setAttribute('class', 'new-state-before-rescan');
  const start = f.messages.length;
  await f.send('start-audit', 'fresh-audit', 0, { settings: { ...DEFAULT_SETTINGS, contrastTarget: 'AAA' } });
  f.flushMutations(); await f.flushTimers(0);
  const latest = await f.send('hello', 'fresh-result', 0, { settings: { ...DEFAULT_SETTINGS, contrastTarget: 'AAA' } });
  assert.equal(latest.selected, null); assert.equal(latest.picker, false); assert.equal(latest.selectionRequest, '');
  assert.equal(latest.audit.id, 'fresh-audit'); assert.equal(latest.audit.target, 'AAA');
  assert.equal(latest.audit.status, 'complete'); assert.equal(latest.audit.stale, false);
  assert.equal(latest.audit.runs[0].contrast.target, 'AAA');
  assert.equal((await f.send('show-node', 'obsolete-reference', 0, { referenceId: f.reference })).error, 'element-removed');
  assert.ok(f.messages.slice(start).filter(message => message.type === 'audit').every(message => message.requestId === 'fresh-audit'));
  assert.equal(f.listeners.get('pointerdown')?.length, 0);
});

test('actual viewport changes keep old audit measurements explicitly stale', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  f.window.innerWidth = 900;
  for (const listener of f.listeners.get('resize') ?? []) listener({});
  assert.equal((await f.send('hello', 'resized')).audit.stale, true);
});

test('one text-heavy final element respects the run budget and reports truncation as a partial audit', async () => {
  const f = await fixture();
  f.element.textCount = 100_000;
  await f.send('start-audit', 'many-runs'); await f.flushTimers(0);
  const audit = (await f.send('hello', 'after-many-runs')).audit;
  assert.equal(audit.runs.length, 1000);
  assert.equal(audit.scanned, 1000);
  assert.equal(audit.status, 'partial');
  assert.ok(audit.reasons.includes('scan-limit'));
  assert.equal(audit.runs.at(-1).id.endsWith(':text1000'), true);
});

const latestAudit = (f: Awaited<ReturnType<typeof fixture>>) => f.messages.filter(message => message.type === 'audit').at(-1)?.audit;
const scanStarts = (f: Awaited<ReturnType<typeof fixture>>) => f.messages.filter(message => message.type === 'audit' && message.audit.status === 'running' && message.audit.scanned === 0);
async function uncertainAudit() {
  const f = await fixture(); f.element.paintReasons = ['layered-background'];
  await f.send('start-audit', 'original-audit'); await f.flushTimers(0);
  return { f, audit: latestAudit(f), referenceId: latestAudit(f).runs[0].elementRef as string };
}

test('conflicting explicit inspection rebuilds the entire audit while preserving selection and original references', async () => {
  const { f, audit, referenceId } = await uncertainAudit();
  const original = structuredClone(audit);
  await new Promise(resolve => setTimeout(resolve, 2));
  f.element.paintReasons = []; f.element.fontFamily = 'Refreshed Font';
  const additional = new FakeElement(); additional.textCount = 1; additional.color = '#111111'; additional.backgroundColor = '#FFFFFF'; additional.fontFamily = 'Second Font';
  f.documentElement.append(additional);
  await f.send('select-node', 'inspected', 0, { referenceId });
  const selected = f.messages.filter(message => message.type === 'selected').at(-1);
  assert.equal(selected.requestId, 'inspected'); assert.equal(selected.snapshot.elementRef, referenceId);
  assert.equal(selected.snapshot.textRuns[0].contrast.ratio, 17.210166562311272);
  assert.ok(selected.snapshot.textRuns[0].textExcerpt);
  assert.equal(latestAudit(f).status, 'running');
  f.flushMutations(); await f.flushTimers(0);
  const fresh = latestAudit(f);
  assert.equal(fresh.id, original.id, 'The coordinator still accepts the established audit request token');
  assert.notEqual(fresh.measuredAt, original.measuredAt);
  assert.equal(fresh.status, 'complete'); assert.equal(fresh.stale, false);
  assert.equal(fresh.runs.length, 2); assert.equal(fresh.scanned, 2); assert.equal(fresh.total, 2);
  assert.equal(fresh.counts.contrast.pass, 2); assert.equal(fresh.counts.contrast.manual, 0); assert.equal(fresh.counts.checks, 4);
  assert.deepEqual(fresh.fonts, ['Refreshed Font', 'Second Font']);
  assert.deepEqual(fresh.palette.map((color: any) => color.raw), ['#FAFAFA', '#161717', '#111111', '#FFFFFF']);
  assert.ok(fresh.runs.every((run: any) => !('textExcerpt' in run)), 'Full scans never copy confirmed-selection excerpts');
  assert.equal(f.messages.filter(message => message.type === 'selected').at(-1).snapshot.id, selected.snapshot.id, 'Scan completion does not overwrite selection');
  assert.equal((await f.send('hello', 'after-refresh')).selectionRequest, 'inspected');
  assert.equal((await f.send('show-node', 'retained-reference', 0, { referenceId })).ok, true);
  assert.deepEqual(audit, original, 'Previously sent audit data stays immutable');
  assert.equal(scanStarts(f).length, 2);
  await f.send('select-node', 'unchanged-inspection', 0, { referenceId });
  assert.equal(scanStarts(f).length, 2, 'Matching measurements never restart the scan');
});

test('stale audits refresh in both directions and retain the settings captured by the new scan', async () => {
  const { f, referenceId } = await uncertainAudit();
  f.element.paintReasons = []; f.mutate();
  assert.equal(latestAudit(f).stale, true);
  await f.send('select-node', 'stale-inspection', 0, { referenceId }); await f.flushTimers(0);
  assert.equal(latestAudit(f).counts.contrast.pass, 1); assert.equal(latestAudit(f).stale, false);
  f.element.color = '#777777'; f.element.backgroundColor = '#FFFFFF';
  await f.send('refresh-selection', 'now-failing', 0, { settings: { ...DEFAULT_SETTINGS, contrastTarget: 'AAA' } });
  await f.send('settings', 'new-preference', 0, { settings: DEFAULT_SETTINGS });
  await f.flushTimers(0);
  assert.equal(latestAudit(f).target, 'AAA'); assert.equal(latestAudit(f).runs[0].contrast.target, 'AAA');
  assert.equal(latestAudit(f).counts.contrast.fail, 1, 'A fresh failure replaces the old passing scan');
  f.element.paintReasons = ['overlapping-element'];
  f.context.__styleInspectorContext = { requestId: 'context-change', element: f.element };
  await f.send('capture-context', 'context-change'); await f.flushTimers(0);
  assert.equal(latestAudit(f).counts.contrast.manual, 1); assert.equal(latestAudit(f).runs[0].contrast.ratio, null);
  const starts = scanStarts(f).length;
  await f.send('refresh-selection', 'unchanged-again'); await f.flushTimers(0);
  assert.equal(scanStarts(f).length, starts, 'Manual results do not retry until they pass');
  assert.equal(f.element.scrolls, 0, 'Automatic remeasurement never scrolls the page');
});

test('hello, automatic resize and hover preview can never start a follow-up audit', async () => {
  const { f, referenceId } = await uncertainAudit();
  await f.send('select-node', 'unchanged-selection', 0, { referenceId });
  const starts = scanStarts(f).length;
  f.element.paintReasons = [];
  await f.send('hello', 'passive-measurement');
  assert.equal(latestAudit(f).stale, true); assert.equal(scanStarts(f).length, starts);
  f.window.innerWidth = 1000;
  for (const listener of f.listeners.get('resize') ?? []) listener({});
  await f.flushTimers(150);
  assert.equal(scanStarts(f).length, starts);
  await f.send('start-picker', 'preview-only');
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [f.element] });
  f.flushFrames();
  assert.ok(f.messages.some(message => message.type === 'preview'));
  assert.equal(scanStarts(f).length, starts);
  await f.send('cancel-picker', 'cancel-preview');
  await f.send('refresh-selection', 'explicit-after-passive'); await f.flushTimers(0);
  assert.equal(scanStarts(f).length, starts + 1, 'A later explicit confirmation still resolves the stale conflict');
});

test('running follow-up scans deduplicate requests and cancellation prevents automatic restart', async () => {
  const { f, referenceId } = await uncertainAudit(); f.element.paintReasons = [];
  await f.send('select-node', 'first-refresh', 0, { referenceId });
  const starts = scanStarts(f).length;
  await f.send('select-node', 'newer-selection', 0, { referenceId });
  assert.equal(scanStarts(f).length, starts);
  const newer = f.messages.filter(message => message.type === 'selected').at(-1).snapshot.id;
  await f.send('cancel-audit', 'cancel-follow-up'); await f.flushTimers(0);
  assert.equal(latestAudit(f).status, 'cancelled');
  assert.equal(f.messages.filter(message => message.type === 'selected').at(-1).snapshot.id, newer);
  f.element.paintReasons = ['overlapping-element'];
  await f.send('refresh-selection', 'after-cancel'); await f.flushTimers(0);
  assert.equal(scanStarts(f).length, starts, 'Explicit cancellation remains respected until a manual scan');
  await f.send('start-audit', 'manual-restart'); await f.flushTimers(0);
  const state = await f.send('hello', 'manual-result');
  assert.equal(state.selected, null); assert.equal(state.audit.id, 'manual-restart');
  assert.equal((await f.send('show-node', 'old-reference', 0, { referenceId })).error, 'element-removed');
});

test('clear, newer epochs, navigation and manual scans retire pending automatic audit completions', async () => {
  for (const boundary of ['clear', 'epoch', 'navigation', 'manual']) {
    const { f, referenceId } = await uncertainAudit(); f.element.paintReasons = [];
    await f.send('select-node', 'pending-refresh', 0, { referenceId });
    const before = f.messages.length;
    if (boundary === 'clear') await f.send('clear-data', 'clear', 1);
    else if (boundary === 'epoch') await f.send('hello', 'new-epoch', 1);
    else if (boundary === 'manual') await f.send('start-audit', 'new-manual');
    else {
      for (const listener of f.listeners.get('pagehide') ?? []) listener({ persisted: true });
      for (const listener of f.listeners.get('pageshow') ?? []) listener({ persisted: true });
    }
    await f.flushTimers(0);
    assert.ok(f.messages.slice(before).filter(message => message.type === 'audit').every(message => message.requestId !== 'original-audit'), boundary);
    const state = await f.send('hello', 'after-boundary', boundary === 'clear' || boundary === 'epoch' ? 1 : 0);
    assert.equal(state.selected, null, boundary);
    assert.equal(state.audit?.id ?? null, boundary === 'manual' ? 'new-manual' : null, boundary);
  }
});

test('scroll during a follow-up marks its complete dataset partial and stale without queuing another scan', async () => {
  const { f, referenceId } = await uncertainAudit(); f.element.paintReasons = [];
  await f.send('select-node', 'scrolling-refresh', 0, { referenceId });
  const starts = scanStarts(f).length;
  for (const listener of f.listeners.get('scroll') ?? []) listener({ target: f.element.parentElement });
  await f.flushTimers(0);
  const audit = latestAudit(f);
  assert.equal(audit.status, 'partial'); assert.equal(audit.stale, true);
  assert.ok(audit.reasons.includes('document-changed-during-scan'));
  assert.equal(scanStarts(f).length, starts);
  assert.equal((await f.send('hello', 'after-scrolling')).selectionRequest, 'scrolling-refresh');
});

test('automatic full scans keep the original run limit and do not retry partial measurements', async () => {
  const { f, referenceId } = await uncertainAudit();
  f.element.paintReasons = []; f.element.textCount = 1001;
  await f.send('select-node', 'limited-refresh', 0, { referenceId }); await f.flushTimers(0);
  const audit = latestAudit(f), starts = scanStarts(f).length;
  assert.equal(audit.scanned, 1000); assert.equal(audit.status, 'partial');
  assert.ok(audit.reasons.includes('scan-limit')); assert.equal(audit.counts.checks, 2000);
  await f.flushTimers(0); await f.send('hello', 'partial-result');
  assert.equal(scanStarts(f).length, starts);
});

test('fresh observations contradicting a running scan mark it partial without replacing selection or retrying', async () => {
  for (const observation of ['select-node', 'hello', 'resize']) {
    const { f, referenceId } = await uncertainAudit();
    f.element.paintReasons = [];
    await f.send('select-node', 'start-follow-up', 0, { referenceId });
    const starts = scanStarts(f).length;
    assert.equal(latestAudit(f).status, 'running');
    f.element.paintReasons = ['overlapping-element'];
    if (observation === 'resize') {
      f.window.innerWidth -= 100;
      for (const listener of f.listeners.get('resize') ?? []) listener({});
      await f.flushTimers(150);
    } else await f.send(observation, 'fresh-evidence', 0, { referenceId });
    await f.flushTimers(0);
    const state = await f.send('hello', 'after-conflict');
    assert.equal(state.selected.textRuns[0].contrast.status, 'manual', observation);
    assert.equal(state.audit.runs[0].contrast.status, 'pass', 'Existing measurements are not patched from the selected snapshot');
    assert.equal(state.audit.status, 'partial', observation);
    assert.equal(state.audit.stale, true, observation);
    assert.ok(state.audit.reasons.includes('document-changed-during-scan'));
    assert.equal(scanStarts(f).length, starts, 'No queued scan or automatic retry');
  }
});

test('a later audit batch conflicting with inspection invalidates both measurements without retrying', async () => {
  for (const inspectedManual of [false, true]) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    const target = nodes.at(-1)!;
    target.paintReasons = inspectedManual ? [] : ['layered-background'];
    await f.send('start-audit', 'original'); await f.flushTimers(0);
    const referenceId = latestAudit(f).runs.at(-1).elementRef;
    target.paintReasons = inspectedManual ? ['layered-background'] : [];
    await f.send('select-node', 'inspect-later-node', 0, { referenceId });
    assert.equal(latestAudit(f).status, 'running');
    const selected = f.messages.filter(message => message.type === 'selected').at(-1).snapshot;
    assert.equal(selected.textRuns[0].contrast.status, inspectedManual ? 'manual' : 'pass');
    // Model paint changes not reported by MutationObserver, such as CSSOM or
    // hover. This target has not been reached by the first scan batch.
    target.paintReasons = inspectedManual ? [] : ['layered-background'];
    const starts = scanStarts(f).length;
    await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.runs.at(-1).contrast.status, inspectedManual ? 'pass' : 'manual');
    assert.equal(audit.status, 'partial'); assert.equal(audit.stale, true);
    assert.ok(audit.reasons.includes('document-changed-during-scan'));
    const stale = f.messages.filter(message => message.type === 'stale').at(-1);
    assert.equal(stale.requestId, 'inspect-later-node');
    assert.equal(stale.snapshot.id, selected.id);
    assert.equal(stale.snapshot.stale, true);
    assert.equal(stale.snapshot.textRuns[0].contrast.status, selected.textRuns[0].contrast.status, 'No result is substituted from the other measurement');
    assert.equal(scanStarts(f).length, starts, 'No automatic retry loop');
  }
});

test('a consistent later audit batch completes fresh and cancellation does not invalidate inspection', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    const target = nodes.at(-1)!; target.paintReasons = ['layered-background'];
    await f.send('start-audit', 'original'); await f.flushTimers(0);
    const referenceId = latestAudit(f).runs.at(-1).elementRef;
    target.paintReasons = [];
    await f.send('select-node', 'inspect-later-node', 0, { referenceId });
    const before = f.messages.length;
    if (cancel) {
      target.paintReasons = ['layered-background'];
      await f.send('cancel-audit', 'stop');
    }
    await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.status, cancel ? 'cancelled' : 'complete');
    assert.equal(audit.stale, false);
    assert.equal(f.messages.slice(before).some(message => message.type === 'stale'), false);
    if (!cancel) assert.equal(audit.runs.at(-1).contrast.status, 'pass');
  }
});

test('text disappearing before a later batch invalidates the earlier visible selection', async () => {
  const f = await fixture();
  const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
  f.documentElement.append(...nodes);
  const target = nodes.at(-1)!; target.paintReasons = ['layered-background'];
  await f.send('start-audit', 'original'); await f.flushTimers(0);
  const referenceId = latestAudit(f).runs.at(-1).elementRef;
  target.paintReasons = [];
  await f.send('select-node', 'inspect-later-node', 0, { referenceId });
  target.textCount = 0;
  await f.flushTimers(0);
  assert.equal(latestAudit(f).status, 'partial');
  assert.equal(latestAudit(f).stale, true);
  assert.equal(f.messages.filter(message => message.type === 'stale').at(-1).snapshot.stale, true);
});

test('descendant text disappearing in a later batch invalidates the earlier container selection', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    const target = nodes.at(-1)!; target.paintReasons = ['layered-background'];
    f.element.textCount = 0;
    // The measurement shim models a selected container's bounded subtree;
    // actual descendant geometry is covered by the native Firefox diagnostic.
    f.element.snapshotChildren = [target];
    await f.send('start-audit', 'original'); await f.flushTimers(0);
    target.paintReasons = [];
    f.context.__styleInspectorContext = { requestId: 'inspect-container', element: f.element };
    await f.send('capture-context', 'inspect-container');
    const selected = f.messages.filter(message => message.type === 'selected').at(-1).snapshot;
    assert.equal(selected.textRuns.length, 1);
    assert.notEqual(selected.textRuns[0].elementRef, selected.elementRef);
    assert.equal(latestAudit(f).status, 'running');
    const before = f.messages.length;
    target.textCount = 0;
    if (cancel) await f.send('cancel-audit', 'stop');
    await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.status, cancel ? 'cancelled' : 'partial');
    assert.equal(audit.stale, !cancel);
    const stale = f.messages.slice(before).find(message => message.type === 'stale');
    assert.equal(Boolean(stale), !cancel, 'Incomplete inventories do not prove descendant loss');
    if (stale) {
      assert.equal(stale.requestId, 'inspect-container');
      assert.equal(stale.snapshot.id, selected.id);
      assert.equal(stale.snapshot.stale, true);
    }
  }
});

test('picker previews release earlier nodes while keeping the current preview and confirmed selection usable', async () => {
  const f = await fixture();
  await f.send('start-picker', 'many-previews');
  const references: string[] = [];
  for (let index = 0; index < 150; index++) {
    const node = new FakeElement(); node.textCount = 1;
    f.documentElement.append(node);
    for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [node] });
    f.flushFrames();
    references.push(f.messages.filter(message => message.type === 'preview').at(-1).snapshot.elementRef);
    assert.equal(f.registrySize(), 2, 'Only the current preview and confirmed selection are retained');
  }
  assert.equal((await f.send('show-node', 'retired-preview', 0, { referenceId: references[0] })).error, 'element-removed');
  assert.equal((await f.send('select-node', 'confirmed-preview', 0, { referenceId: references.at(-1) })).ok, true);
  assert.equal(f.registrySize(), 1, 'Confirming a preview releases the preceding selection');
  assert.equal((await f.send('show-node', 'retired-selection', 0, { referenceId: f.reference })).error, 'element-removed');
  const state = await f.send('hello', 'after-preview');
  assert.equal(state.selected.textRuns.length, 1);
  assert.equal((await f.send('show-node', 'current-selection', 0, { referenceId: state.selected.elementRef })).ok, true);
});

test('repeated automatic audits retain their current references without accumulating replaced page nodes', async () => {
  const { f, referenceId } = await uncertainAudit();
  let oldNodes: FakeElement[] = [], retiredReference: string | undefined;
  for (let cycle = 0; cycle < 12; cycle++) {
    for (const node of oldNodes) node.remove();
    oldNodes = Array.from({ length: 40 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...oldNodes);
    f.element.paintReasons = cycle % 2 ? ['layered-background'] : [];
    await f.send('select-node', 'refresh-dynamic-page', 0, { referenceId });
    f.flushMutations(); await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.runs.length, 41);
    assert.equal(audit.stale, false);
    assert.equal(f.registrySize(), 41);
    assert.equal((await f.send('show-node', 'persistent-selection', 0, { referenceId })).ok, true);
    if (retiredReference) assert.equal((await f.send('show-node', 'retired-audit-node', 0, { referenceId: retiredReference })).error, 'element-removed');
    retiredReference = audit.runs[1].elementRef;
  }
  f.element.remove(); f.flushMutations();
  assert.equal(f.registrySize(), 40, 'Disconnected nodes are released even while old audit rows remain visible');
  assert.equal((await f.send('show-node', 'removed-selection', 0, { referenceId })).error, 'element-removed');
});

test('automatic scans preserve live prior audit IDs until completion and release unused references after cancellation', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    f.element.paintReasons = ['layered-background'];
    await f.send('start-audit', 'original'); await f.flushTimers(0);
    const original = latestAudit(f), referenceId = original.runs[0].elementRef;
    const laterReference = original.runs.at(-1).elementRef;
    f.element.paintReasons = [];
    await f.send('select-node', 'automatic', 0, { referenceId });
    assert.equal(latestAudit(f).status, 'running');
    assert.equal(f.registrySize(), 71, 'The bounded preceding audit remains reserved during the scan');
    // A separate preview causes pruning while the later original node has not
    // been scanned yet; it must not retire that node's established audit ID.
    const preview = new FakeElement(); preview.textCount = 1;
    f.documentElement.append(preview);
    await f.send('start-picker', 'during-scan');
    for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [preview] });
    f.flushFrames();
    await f.send('cancel-picker', 'stop-preview');
    if (cancel) await f.send('cancel-audit', 'stop-audit');
    await f.flushTimers(0);
    const finished = latestAudit(f);
    if (cancel) {
      assert.equal(finished.status, 'cancelled');
      assert.equal(finished.runs.some((run: any) => run.elementRef === laterReference), false);
      assert.equal((await f.send('show-node', 'unused-prior-ref', 0, { referenceId: laterReference })).error, 'element-removed');
    } else {
      assert.equal(finished.status, 'complete');
      assert.deepEqual(finished.runs.map((run: any) => run.elementRef), original.runs.map((run: any) => run.elementRef));
      assert.equal((await f.send('show-node', 'same-live-node', 0, { referenceId: laterReference })).ok, true);
    }
    assert.equal(f.registrySize(), finished.runs.length, 'The old reserve and temporary preview are released after the job');
  }
});

test('showing an audit node ends an active picker with the matching coordinator notification', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  const referenceId = latestAudit(f).runs[0].elementRef;
  await f.send('select-node', 'confirmed-audit-node', 0, { referenceId });
  await f.send('start-picker', 'picker-to-end');
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [f.element] });
  f.flushFrames();
  assert.equal((await f.send('show-node', 'show-audit-node', 0, { referenceId })).ok, true);
  const cancelled = f.messages.filter(message => message.type === 'picker-cancelled');
  assert.equal(cancelled.length, 1);
  assert.equal(cancelled[0].requestId, 'picker-to-end');
  assert.equal(cancelled[0].snapshot.elementRef, referenceId);
  const state = await f.send('hello', 'after-show');
  assert.equal(state.picker, false); assert.equal(state.selectionRequest, 'picker-to-end');
  assert.equal(f.listeners.get('pointermove')?.length, 0);
  assert.equal(f.listeners.get('click')?.length, 0);
  f.mutate();
  assert.equal(f.messages.filter(message => message.type === 'stale').at(-1).requestId, 'picker-to-end');
  await f.send('show-node', 'show-again', 0, { referenceId });
  assert.equal(f.messages.filter(message => message.type === 'picker-cancelled').length, 1, 'Ordinary highlights do not create cancellation events');
});

test('moving a tab invalidates old completed and running analysis before adopting its new window', async () => {
  for (const running of [false, true]) {
    const f = await fixture(3);
    await f.send('start-audit', 'old-window-audit', 3);
    if (!running) await f.flushTimers(0);
    await f.send('start-picker', 'old-window-picker', 3);
    const start = f.messages.length;
    assert.equal((await f.send('hello', 'obsolete-epoch', 2, { windowId: 2 })).error, 'stale-document');
    assert.equal((await f.send('start-audit', 'unestablished-window', 3, { windowId: 2 })).error, 'stale-document');
    const moved = await f.send('hello', 'new-window', 3, { windowId: 2 });
    assert.equal(moved.audit, null); assert.equal(moved.selected, null); assert.equal(moved.picker, false);
    assert.equal(moved.auditRequest, ''); assert.equal(moved.selectionRequest, '');
    await f.flushTimers(0);
    assert.equal(f.messages.slice(start).some(message => message.type === 'audit'), false, 'Old running work cannot publish under either window');
    assert.equal((await f.send('show-node', 'old-window-command', 3, { referenceId: f.reference })).error, 'stale-document');
    await f.send('start-audit', 'new-window-audit', 3, { windowId: 2 }); await f.flushTimers(0);
    const current = latestAudit(f);
    assert.equal(current.document.windowId, 2); assert.equal(current.status, 'complete'); assert.equal(current.stale, false);
    f.mutate();
    assert.equal(latestAudit(f).document.windowId, 2); assert.equal(latestAudit(f).stale, true);
  }
});

test('a moved-tab context action preserves only its exact new capture without weakening data-clear boundaries', async () => {
  for (const scenario of ['exact-request', 'old-request', 'new-epoch']) {
    const f = await fixture(3);
    f.context.__styleInspectorContext = { requestId: scenario === 'old-request' ? 'previous-capture' : 'moved-context', element: f.element };
    const epoch = scenario === 'new-epoch' ? 4 : 3;
    await f.send('hello', 'moved-context', epoch, { windowId: 2 });
    const result = await f.send('capture-context', 'moved-context', epoch, { windowId: 2 });
    if (scenario === 'exact-request') {
      assert.equal(result.snapshot.document.windowId, 2);
      assert.notEqual(result.snapshot.elementRef, f.reference);
      assert.equal(result.snapshot.stale, false);
    } else assert.equal(result.error, 'target-expired', scenario);
  }
});
