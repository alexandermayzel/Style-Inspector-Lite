import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { createMeasurementStyleCache, elementLabel, ElementRegistry, isOwnElement, registerOwnElement, withMeasurementBatch } from '../../src/runtime/dom';
import { evaluateContrast, evaluateFontSize } from '../../src/core/contrast';
import { parseColor } from '../../src/core/colors';

// Isolate document lifecycle coordination from browser measurement. Real DOM
// measurement is covered by the Firefox fixture run, not claimed by this fake.
const bundle = build({ entryPoints: ['src/content.ts'], bundle: true, write: false, format: 'iife', platform: 'browser', plugins: [{
  name: 'measurement-fixture', setup(builder) {
    builder.onLoad({ filter: /[\\/]src[\\/]runtime[\\/]dom\.ts$/ }, () => ({ loader: 'js', contents: `
      export const OVERLAY_ATTRIBUTE='data-style-inspector-overlay';
      export const {createMeasurementStyleCache,elementLabel,ElementRegistry,isOwnElement,registerOwnElement,withMeasurementBatch}=globalThis.__realDom;
      export const viewport=()=>({width:window.innerWidth,height:window.innerHeight,devicePixelRatio:window.devicePixelRatio});
      export const directTextCount=(element,maximum=Infinity,geometry,includeText,within)=>{if(within&&(element.rect.left>=within.width||element.rect.top>=within.height||element.rect.left+element.rect.width<=0||element.rect.top+element.rect.height<=0))return 0;const count=Math.min(element.textCount,maximum);if(within&&element.viewportPartial)for(let i=0;i<count;i++)geometry.push({viewportPartial:true});return count;};
      export function* iterateDirectText(element,maximum=Infinity,includeText=false,within){const geometry=[];const count=directTextCount(element,maximum,geometry,includeText,within);for(let index=0;index<count;index++){globalThis.__work.geometrySteps++;yield {fixtureIndex:index,...geometry[index]};}}
      export const isRendered=()=>true;
      const {evaluateContrast,evaluateFontSize,parseColor}=globalThis.__measurement;
      export const measureRuns=(element,registry,settings,count=element.textCount,geometry=[])=>{globalThis.__work.measuredElements++;if(element.failMeasurement)throw Error('measurement failed');const foreground=parseColor(element.color),background=parseColor(element.backgroundColor),reasons=[...(geometry[0]?.viewportPartial?element.viewportReasons:element.paintReasons)];return Array.from({length:count},(_,index)=>({id:registry.reference(element)+':text'+(index+1),elementRef:registry.reference(element),tagName:'p',selector:'p:nth-of-type(1)',...(geometry[index]?.viewportPartial?{viewportPartial:true}:{}),reasons,foreground,background,effectiveBackground:background.rgba,fontSizeCssPx:16,fontWeight:400,fontFamily:element.fontFamily,lineHeight:element.lineHeight,ownOpaqueBackground:true,contrast:evaluateContrast({foreground:foreground.rgba,background:background.rgba,fontSizeCssPx:16,fontWeight:400,reasons,target:settings.contrastTarget}),fontSize:evaluateFontSize(16)}))};
      export function* iterateMeasuredRuns(element,registry,settings,count,geometry){for(let index=0;index<count;index++){const run=measureRuns(element,registry,settings,1,[geometry[index]])[0];run.id=registry.reference(element)+':text'+(index+1);yield run;}}
      export const iterateMeasurementSteps=iterateMeasuredRuns;
      let serial=0;
      export function* iterateSnapshot(element,identity,registry,settings,options={}) {
        globalThis.__work.snapshots++; const textRuns=[];
        for(const node of [element,...element.snapshotChildren]) {
          const geometry=[]; for(const item of iterateDirectText(node,101-textRuns.length)){geometry.push(item);yield;}
          for(const run of iterateMeasuredRuns(node,registry,settings,Math.min(geometry.length,100-textRuns.length),geometry)){
            if(options.includeText)run.textExcerpt={value:'Synthetic selection',truncated:false};
            textRuns.push(run);options.onRun?.(run);yield;
          }
          yield; if(textRuns.length>=100)break;
        }
        return {id:'fixture-snapshot-'+(++serial),document:{...identity},elementRef:registry.reference(element),tagName:'p',selector:'p:nth-of-type(1)',measuredAt:new Date().toISOString(),viewport:viewport(),stale:false,reasons:[element,...element.snapshotChildren].reduce((count,node)=>count+node.textCount,0)>100?['selection-text-limit']:[],styles:{colors:{},typography:{},layout:{}},textRuns,...(options.includeText?{textExcerpt:{value:'Synthetic selection',truncated:false}}:{}),rect:{x:0,y:0,width:20,height:20}};
      }
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
  lineHeight = '24px';
  paintReasons: string[] = [];
  viewportPartial = false;
  viewportReasons: string[] = [];
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
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  attachShadow() { return { append: (...elements: FakeElement[]) => { this.shadowChildren.push(...elements); } }; }
  append(...elements: FakeElement[]) { for (const element of elements) { element.parentElement = this; element.isConnected = this.isConnected; this.children.push(element); } this.mutation({ type: 'childList', target: this, addedNodes: elements, removedNodes: [] }); }
  remove() { const parent = this.parentElement; this.isConnected = false; this.parentElement = null; if (parent) { parent.children = parent.children.filter(element => element !== this); this.mutation({ type: 'childList', target: parent, addedNodes: [], removedNodes: [this] }); } }
  scrollIntoView() { this.scrolls++; }
  contains(element: FakeElement) { for (let node: FakeElement | null = element; node; node = node.parentElement) if (node === this) return true; return false; }
  getBoundingClientRect() { return { ...this.rect, x: this.rect.left, y: this.rect.top, right: this.rect.left + this.rect.width, bottom: this.rect.top + this.rect.height }; }
}
async function fixture(initialEpoch = 0, elementCostMs = 0) {
  const registries: ElementRegistry[] = [];
  class FixtureRegistry extends ElementRegistry {
    constructor(token: string) { super(token); registries.push(this); }
  }
  const listeners = new Map<string, ((event: any) => void)[]>();
  const listenerOptions = new Map<string, any>();
  const messages: any[] = [];
  let handler: (message: any, sender: any) => any;
  let observerCallback: (records: any[]) => void;
  const observation = { active: false, starts: 0, stops: 0, deliveries: 0 };
  const work = { snapshots: 0, measuredElements: 0, treeWalks: 0, geometrySteps: 0 };
  const mutations: any[] = [];
  const queueMutation = (record: any) => { if (observation.active) mutations.push(record); };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  const frames = new Map<number, () => void>();
  let nextTimer = 0;
  const browser = { runtime: { id: 'test-addon', onMessage: { addListener(callback: any) { handler = callback; } }, sendMessage: async (event: any) => { messages.push(structuredClone(event)); } }, i18n: { getMessage: (key: string, value?: string) => key === 'highlightHint' ? `Highlighted: ${value} · Esc to dismiss` : key, getUILanguage: () => 'en-US' } };
  const window = {
    innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0,
    addEventListener(type: string, callback: any, options?: any) { listeners.set(type, [...(listeners.get(type) ?? []), callback]); listenerOptions.set(type, options); },
    removeEventListener(type: string, callback: any) { listeners.set(type, (listeners.get(type) ?? []).filter(item => item !== callback)); },
    setTimeout(callback: () => void, delay = 0) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id; },
    clearTimeout(id: number) { timers.delete(id); },
  };
  const element = new FakeElement(queueMutation); element.textCount = 1;
  const documentElement = new FakeElement(queueMutation); documentElement.tagName = 'HTML'; documentElement.append(element); mutations.length = 0;
  const document = { documentElement, createElement: () => { const node = new FakeElement(queueMutation); node.isConnected = false; return node; }, createTreeWalker: (root: FakeElement) => { work.treeWalks++; const descendants = (node: FakeElement): FakeElement[] => node.children.flatMap(child => [child, ...descendants(child)]); const nodes = descendants(root); let index = 0; return { nextNode: () => nodes[index++] ?? null }; }, createRange: () => { let selected: FakeElement; return { selectNodeContents(node: FakeElement) { selected = node; }, getClientRects: () => selected.rangeRects }; } };
  const context = vm.createContext({ __work: work, __realDom: { createMeasurementStyleCache, elementLabel, ElementRegistry: FixtureRegistry, isOwnElement, registerOwnElement, withMeasurementBatch }, __measurement: { evaluateContrast, evaluateFontSize, parseColor }, __styleInspectorContext: { requestId: 'confirmed', element }, browser, window, document, NodeFilter: { SHOW_ELEMENT: 1 }, getComputedStyle: (node: FakeElement) => ({ color: node.color, backgroundColor: node.backgroundColor, fontFamily: node.fontFamily }), crypto: webcrypto, structuredClone, performance: { now: () => performance.now() + work.measuredElements * elementCostMs }, Element: FakeElement, MutationObserver: class { constructor(callback: any) { observerCallback = callback; } observe() { observation.active = true; observation.starts++; } disconnect() { observation.active = false; observation.stops++; mutations.length = 0; } takeRecords() { return mutations.splice(0); } }, requestAnimationFrame: (callback: () => void) => { const id = ++nextTimer; frames.set(id, callback); return id; }, cancelAnimationFrame: (id: number) => frames.delete(id), clearTimeout: window.clearTimeout });
  vm.runInContext((await bundle).outputFiles[0]!.text, context);
  const send = async (type: string, requestId: string, epoch = initialEpoch, extra: Record<string, any> = {}) => handler!({ channel: 'sil-content', type, requestId, epoch, windowId: 1, tabId: 10, settings: DEFAULT_SETTINGS, ...extra }, { id: 'test-addon' });
  await send('hello', 'initial');
  const initialObservation = { ...observation };
  const reference = (await send('capture-context', 'confirmed')).snapshot.elementRef;
  const flushMutations = () => { const records = mutations.splice(0); if (observation.active && records.length) { observation.deliveries++; observerCallback!(records); } };
  const flushTimers = async (delay: number, maximum = 100) => { for (let step = 0; step < maximum; step++) { const pending = [...timers].filter(([, timer]) => timer.delay === delay); if (!pending.length) break; for (const [id, timer] of pending) { timers.delete(id); timer.callback(); } await Promise.resolve(); } };
  const flushFrames = () => { for (const [id, callback] of frames) { frames.delete(id); callback(); } };
  const registrySize = () => (registries.at(-1)! as unknown as { elements: Map<string, Element> }).elements.size;
  return { registrySize, send, element, reference, messages, context, window, documentElement, mutations, observation, initialObservation, work, flushMutations, flushTimers, flushFrames, mutate: () => { element.setAttribute('class', 'changed'); flushMutations(); }, listeners, listenerOptions, timers };
}

test('explicit viewport and section scopes retain boundaries and permit a fresh section rescan', async () => {
  const f = await fixture();
  const child = new FakeElement(); child.textCount = 1; f.element.append(child);
  const below = new FakeElement(); below.textCount = 1; below.rect.top = 1000; f.documentElement.append(below);
  await f.send('start-audit', 'viewport', 0, { scope: 'viewport' }); await f.flushTimers(0);
  let audit = latestAudit(f); assert.equal(audit.scope, 'viewport'); assert.equal(audit.runs.length, 2);
  assert.ok(audit.durationMs >= 0); assert.ok(audit.examined >= 3);
  assert.deepEqual(audit.limits, { maxRuns: 1000, maxElements: 20000 });
  const root = audit.runs[0].elementRef;
  await f.send('start-audit', 'section', 0, { scope: 'selection', referenceId: root }); await f.flushTimers(0);
  audit = latestAudit(f); assert.equal(audit.scope, 'selection'); assert.equal(audit.runs.length, 2);
  assert.ok(audit.rootElementRef);
  await f.send('start-audit', 'section-again', 0, { scope: 'selection', referenceId: audit.rootElementRef }); await f.flushTimers(0);
  audit = latestAudit(f); assert.equal(audit.runs.length, 2); assert.equal(audit.status, 'complete');
  const identity = audit.id; f.element.remove();
  const missing = await f.send('start-audit', 'missing-section', 0, { scope: 'selection', referenceId: audit.rootElementRef });
  assert.equal(missing.error, 'element-removed'); assert.equal(latestAudit(f).id, identity);
});

test('expensive elements yield before the element-count cap and cancellation stops further measurements', async () => {
  const f = await fixture(0, 6);
  for (let i = 0; i < 50; i++) { const node = new FakeElement(); node.textCount = 1; f.documentElement.append(node); }
  const before = f.work.measuredElements;
  await f.send('start-audit', 'costly');
  const after = f.work.measuredElements;
  assert.ok(after > before && after - before < 32, 'Elapsed-time budget must yield before a costly 32-element batch');
  await f.send('cancel-audit', 'cancel-costly'); await f.flushTimers(0);
  assert.equal(f.work.measuredElements, after); assert.equal(latestAudit(f).status, 'cancelled');
});

test('a single text-heavy element yields during collection and measurement and stops promptly on cancellation', async () => {
  for (const phase of ['collection', 'measurement']) {
    const f = await fixture(0, phase === 'measurement' ? 2 : 0);
    f.element.textCount = 1000;
    const before = { ...f.work };
    await f.send('start-audit', 'huge-' + phase);
    assert.ok(f.work.geometrySteps > before.geometrySteps && f.work.geometrySteps - before.geometrySteps < 1000, 'Collection yields within a single owner');
    if (phase === 'measurement') {
      for (let i = 0; i < 20 && f.work.measuredElements === before.measuredElements; i++) await f.flushTimers(0, 1);
      assert.ok(f.work.measuredElements > before.measuredElements && f.work.measuredElements - before.measuredElements < 1000, 'Run painting yields within the same owner');
    }
    const stopped = { ...f.work };
    await f.send('cancel-audit', 'stop-huge'); await f.flushTimers(0);
    assert.equal(f.work.geometrySteps, stopped.geometrySteps);
    assert.equal(f.work.measuredElements, stopped.measuredElements);
    const audit = latestAudit(f);
    assert.equal(audit.status, 'cancelled'); assert.ok(audit.runs.length < 1000);
    assert.equal(new Set(audit.runs.map((run: any) => run.id)).size, audit.runs.length);
    if (audit.runs.length) assert.equal(audit.fontUsage[0].count, 1, 'Partial chunks count one text owner only');
  }
});

test('successive explicit scans preserve current DOM identities without retaining out-of-scope selectable references', async () => {
  const f = await fixture();
  const below = new FakeElement(); below.textCount = 1; below.rect.top = 1000; f.documentElement.append(below);
  await f.send('start-audit', 'first-page'); await f.flushTimers(0);
  const original = latestAudit(f), belowRef = original.runs[1].elementRef;
  f.window.scrollY = 300;
  await f.send('start-audit', 'visible', 0, { scope: 'viewport' }); await f.flushTimers(0);
  const visible = latestAudit(f);
  assert.deepEqual(visible.scopeViewport, { left: 0, top: 300, width: 1280, height: 800 });
  assert.equal(visible.runs[0].id, original.runs[0].id);
  assert.equal((await f.send('show-node', 'out-of-scope', 0, { referenceId: belowRef })).error, 'element-removed');
  await f.send('start-audit', 'second-page'); await f.flushTimers(0);
  assert.deepEqual(latestAudit(f).runs.map((run: any) => run.id), original.runs.map((run: any) => run.id));
  await f.send('clear-data', 'clear-identities');
  await f.send('start-audit', 'after-clear'); await f.flushTimers(0);
  assert.ok(latestAudit(f).runs.every((run: any) => !original.runs.some((old: any) => old.id === run.id)), 'Clearing data starts a new identity generation');
});

test('all chunks of a single element retain exact run and inventory totals without a false scan limit', async () => {
  const f = await fixture(); f.element.textCount = 1000;
  await f.send('start-audit', 'exact-budget'); await f.flushTimers(0);
  const audit = latestAudit(f);
  assert.equal(audit.status, 'complete'); assert.equal(audit.runs.length, 1000);
  assert.equal(new Set(audit.runs.map((run: any) => run.id)).size, 1000);
  assert.equal(audit.reasons.includes('scan-limit'), false);
  assert.deepEqual(audit.reachedLimits, []);
  assert.equal(audit.fontUsage[0].count, 1); assert.equal(audit.fontUsage[0].sizes[0].count, 1);
  assert.ok(audit.paletteUsage.every((entry: any) => entry.count === 1));
  assert.equal(audit.examined, 2, 'Resuming an element does not count it as another visited element');
});

test('inspection outside a running section or viewport does not make unchanged measurements stale', async () => {
  for (const scope of ['selection', 'viewport']) {
    const f = await fixture();
    for (let i = 0; i < 70; i++) { const node = new FakeElement(); node.textCount = 1; f.element.append(node); }
    const outside = new FakeElement(); outside.textCount = 1; outside.rect.top = 1000; f.documentElement.append(outside);
    await f.send('start-audit', 'scoped-running', 0, { scope, ...(scope === 'selection' ? { referenceId: f.reference } : {}) });
    f.context.__styleInspectorContext = { requestId: 'inspect-outside', element: outside };
    await f.send('capture-context', 'inspect-outside');
    await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.status, 'complete', scope); assert.equal(audit.stale, false, scope);
    assert.equal(audit.reasons.includes('document-changed-during-scan'), false, scope);
    assert.equal((await f.send('hello', 'read')).selected.stale, false, scope);
  }
});

test('section completion still detects disappeared text that was inspected inside its root', async () => {
  const f = await fixture();
  const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
  f.element.append(...nodes);
  await f.send('start-audit', 'section-running', 0, { scope: 'selection', referenceId: f.reference });
  const target = nodes.at(-1)!;
  f.context.__styleInspectorContext = { requestId: 'inspect-inside', element: target };
  await f.send('capture-context', 'inspect-inside');
  target.textCount = 0;
  await f.flushTimers(0);
  const audit = latestAudit(f);
  assert.equal(audit.status, 'partial'); assert.equal(audit.stale, true);
  assert.ok(audit.reasons.includes('document-changed-during-scan'));
  assert.equal((await f.send('hello', 'read')).selected.stale, true);
});

test('viewport-fragment and full-element inspections preserve independent evidence without false staleness', async () => {
  const f = await fixture();
  f.element.viewportPartial = true; f.element.paintReasons = ['layered-background'];
  for (let i = 0; i < 70; i++) { const node = new FakeElement(); node.textCount = 1; f.documentElement.append(node); }
  await f.send('start-audit', 'viewport-running', 0, { scope: 'viewport' });
  f.context.__styleInspectorContext = { requestId: 'inspect-full', element: f.element };
  await f.send('capture-context', 'inspect-full');
  await f.flushTimers(0);
  const audit = latestAudit(f), state = await f.send('hello', 'read');
  assert.equal(audit.runs[0].viewportPartial, true); assert.equal(audit.runs[0].contrast.status, 'pass');
  assert.equal(audit.status, 'complete'); assert.equal(audit.stale, false);
  assert.equal(state.selected.textRuns[0].contrast.status, 'manual'); assert.equal(state.selected.stale, false);
  await f.send('refresh-selection', 'inspect-full-again');
  assert.equal((await f.send('hello', 'still-fresh')).audit.stale, false, 'Repeated full inspection does not change the historical scoped audit');
  f.element.color = '#ff0000';
  await f.send('refresh-selection', 'changed-color');
  assert.equal((await f.send('hello', 'changed')).audit.stale, true, 'A genuinely changed CSS color still contradicts its viewport result');
});

test('hover analysis waits for a stable target and cancellation removes a pending preview', async () => {
  const f = await fixture();
  await f.send('start-picker', 'dwell'); const before = f.work.snapshots;
  for (let i = 0; i < 40; i++) {
    const node = new FakeElement(); node.textCount = 1; f.documentElement.append(node);
    for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [node] });
    f.flushFrames();
  }
  assert.equal(f.work.snapshots, before, 'Immediate outlines do not measure each hovered subtree');
  await f.flushTimers(120); assert.equal(f.work.snapshots, before + 1);
  const node = new FakeElement(); node.textCount = 1; f.documentElement.append(node);
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [node] });
  await f.send('cancel-picker', 'cancel-dwell'); await f.flushTimers(120);
  assert.equal(f.work.snapshots, before + 1);
});

test('large explicit selections yield within one element and a newer selection retires the pending capture', async () => {
  const f = await fixture();
  const huge = new FakeElement(); huge.textCount = 1000; f.documentElement.append(huge);
  f.context.__styleInspectorContext = { requestId: 'huge-selection', element: huge };
  const before = { ...f.work };
  const pending = f.send('capture-context', 'huge-selection');
  assert.ok(f.work.geometrySteps - before.geometrySteps < 1000);
  assert.ok(f.work.measuredElements - before.measuredElements < 100);
  assert.equal((await f.send('hello', 'still-confirmed')).selected.elementRef, f.reference);
  const newer = new FakeElement(); newer.textCount = 1; f.documentElement.append(newer);
  f.context.__styleInspectorContext = { requestId: 'newer-selection', element: newer };
  const selected = await f.send('capture-context', 'newer-selection');
  const stopped = { ...f.work };
  await f.flushTimers(0);
  assert.equal((await pending).error, 'request-cancelled');
  assert.deepEqual(f.work, stopped, 'Retired work does not resume after a later target');
  assert.equal(f.messages.some(event => event.type === 'selected' && event.requestId === 'huge-selection'), false);
  assert.equal((await f.send('hello', 'newer-kept')).selected.id, selected.snapshot.id);
  assert.equal(f.registrySize(), 1, 'Incomplete selection references are released');
});

test('incremental selection keeps all capped runs and marks changes between chunks stale', async () => {
  for (const changed of [false, true]) {
    const f = await fixture();
    const huge = new FakeElement(); huge.textCount = 1000; f.documentElement.append(huge);
    f.context.__styleInspectorContext = { requestId: 'incremental-selection', element: huge };
    const pending = f.send('capture-context', 'incremental-selection');
    if (changed) f.mutate();
    await f.flushTimers(0);
    const result = await pending;
    assert.equal(result.snapshot.textRuns.length, 100);
    assert.equal(new Set(result.snapshot.textRuns.map((run: any) => run.id)).size, 100);
    assert.equal(result.snapshot.stale, changed);
    assert.deepEqual(Array.from(result.snapshot.reasons), ['selection-text-limit']);
    assert.ok(result.snapshot.textRuns.every((run: any) => run.textExcerpt));
    assert.equal(f.registrySize(), 1);
  }
});

test('removal between completed measurement and its promise continuation cannot commit a disconnected selection', async () => {
  const f = await fixture();
  const target = new FakeElement(); target.textCount = 1; f.documentElement.append(target);
  f.context.__styleInspectorContext = { requestId: 'removed-before-commit', element: target };
  const pending = f.send('capture-context', 'removed-before-commit');
  target.remove();
  assert.equal((await pending).error, 'element-removed');
  assert.equal(f.messages.some(event => event.type === 'selected' && event.requestId === 'removed-before-commit'), false);
  assert.equal((await f.send('hello', 'preceding-remains')).selected.elementRef, f.reference);
  assert.equal(f.registrySize(), 1);
});

test('moving the pointer cancels already-running preview work without replacing the confirmed selection', async () => {
  const f = await fixture();
  const huge = new FakeElement(); huge.textCount = 1000;
  const next = new FakeElement(); next.textCount = 1;
  f.documentElement.append(huge, next);
  await f.send('start-picker', 'incremental-hover');
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [huge] });
  await f.flushTimers(120);
  assert.equal(f.messages.filter(event => event.type === 'preview').length, 0);
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [next] });
  const stopped = { ...f.work };
  await f.flushTimers(0);
  assert.deepEqual(f.work, stopped);
  await f.flushTimers(120); await f.flushTimers(0);
  assert.equal(f.messages.filter(event => event.type === 'preview').length, 1);
  assert.equal((await f.send('hello', 'confirmed-still-kept')).selected.elementRef, f.reference);
  await f.send('cancel-picker', 'finish-hover');
  assert.equal(f.registrySize(), 1);
});

test('clear, navigation and a new audit cancel pending selections without restoring old results', async () => {
  for (const boundary of ['clear', 'pagehide', 'audit', 'coordinator']) {
    const f = await fixture();
    const huge = new FakeElement(); huge.textCount = 1000; f.documentElement.append(huge);
    f.context.__styleInspectorContext = { requestId: 'pending-selection', element: huge };
    const pending = f.send('capture-context', 'pending-selection');
    if (boundary === 'clear') await f.send('clear-data', 'clear-selection');
    if (boundary === 'pagehide') for (const listener of f.listeners.get('pagehide') ?? []) listener({});
    if (boundary === 'audit') await f.send('start-audit', 'replace-selection');
    if (boundary === 'coordinator') await f.send('hello', 'new-coordinator', 0, { coordinatorToken: 'fresh-background' });
    await f.flushTimers(0);
    assert.equal((await pending).error, 'request-cancelled');
    assert.equal(f.messages.some(event => event.type === 'selected' && event.requestId === 'pending-selection'), false);
    if (boundary !== 'pagehide') {
      const hello = await f.send('hello', 'after-boundary', 0, boundary === 'coordinator' ? { coordinatorToken: 'fresh-background' } : {});
      assert.equal(hello.selected, null);
    }
  }
});

test('picker Escape and disabling preview stop incremental captures and preserve the confirmed selection', async () => {
  for (const action of ['escape', 'disable-preview']) {
    const f = await fixture(); f.context.MouseEvent = class {};
    const huge = new FakeElement(); huge.textCount = 1000; f.documentElement.append(huge);
    await f.send('start-picker', 'pending-pick');
    if (action === 'escape') {
      for (const listener of f.listeners.get('click') ?? []) listener({ type: 'click', composedPath: () => [huge], preventDefault() {}, stopImmediatePropagation() {} });
      for (const listener of f.listeners.get('keydown') ?? []) listener({ key: 'Escape', preventDefault() {}, stopImmediatePropagation() {} });
    } else {
      for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [huge] });
      await f.flushTimers(120);
      await f.send('settings', 'disable-preview', 0, { settings: { ...DEFAULT_SETTINGS, livePreview: false } });
    }
    const stopped = { ...f.work }; await f.flushTimers(0);
    assert.deepEqual(f.work, stopped);
    assert.equal(f.messages.some(event => event.type === 'selected' && event.requestId === 'pending-pick'), false);
    assert.equal(f.messages.filter(event => event.type === 'preview').length, 0);
    assert.equal((await f.send('hello', 'after-cancelled-capture')).selected.elementRef, f.reference);
    if (action === 'escape') assert.equal(f.messages.filter(event => event.type === 'picker-cancelled').length, 1);
    await f.send('cancel-picker', 'finish-pending-pick');
    assert.equal(f.registrySize(), 1);
  }
});

test('analysis eviction releases content data only for matching idle request identities', async () => {
  const f = await fixture();
  assert.equal((await f.send('release-analysis', 'wrong-selection', 0, { expectedSelectionRequest: 'obsolete', expectedAuditRequest: '' })).released, false);
  assert.equal((await f.send('hello', 'kept')).selected.elementRef, f.reference);
  await f.send('start-picker', 'active-picker');
  assert.equal((await f.send('release-analysis', 'picker-busy', 0, { expectedSelectionRequest: 'confirmed', expectedAuditRequest: '' })).released, false);
  await f.send('cancel-picker', 'finish-picker');
  const huge = new FakeElement(); huge.textCount = 1000; f.documentElement.append(huge);
  f.context.__styleInspectorContext = { requestId: 'pending', element: huge };
  const pending = f.send('capture-context', 'pending');
  assert.equal((await f.send('release-analysis', 'capture-busy', 0, { expectedSelectionRequest: 'active-picker', expectedAuditRequest: '' })).released, false);
  await f.flushTimers(0); await pending;
  assert.equal((await f.send('release-analysis', 'late-old-eviction', 0, { expectedSelectionRequest: 'active-picker', expectedAuditRequest: '' })).released, false);
  assert.equal((await f.send('release-analysis', 'matching-eviction', 0, { expectedSelectionRequest: 'pending', expectedAuditRequest: '' })).released, true);
  const empty = await f.send('hello', 'evicted');
  assert.equal(empty.selected, null); assert.equal(empty.audit, null); assert.equal(f.registrySize(), 0); assert.equal(f.observation.active, false);
});

test('a fresh coordinator discards prior in-memory analysis and accepts only its own later commands', async () => {
  const f = await fixture(7);
  const reset = await f.send('hello', 'new-background', 0, { coordinatorToken: 'background-one' });
  assert.equal(reset.selected, null); assert.equal(reset.audit, null);
  f.context.__styleInspectorContext = { requestId: 'fresh-context', element: f.element };
  await f.send('hello', 'fresh-context', 0, { coordinatorToken: 'background-two' });
  const selected = await f.send('capture-context', 'fresh-context', 0, { coordinatorToken: 'background-two' });
  assert.ok(selected.snapshot);
  assert.equal(f.messages.filter(event => event.type === 'selected').at(-1).coordinatorToken, 'background-two');
  assert.equal((await f.send('clear-data', 'late-background-one', 0, { coordinatorToken: 'background-one' })).error, 'stale-document');
  assert.equal((await f.send('hello', 'same-background', 0, { coordinatorToken: 'background-two' })).selected.id, selected.snapshot.id);
  f.context.__styleInspectorContext = { requestId: 'stale-context', element: f.element };
  await f.send('hello', 'different-request', 0, { coordinatorToken: 'background-three' });
  assert.equal((await f.send('capture-context', 'stale-context', 0, { coordinatorToken: 'background-three' })).error, 'target-expired');
});

test('failed inspection retains the preceding element identity and releases incomplete references', async () => {
  const f = await fixture();
  const before = (await f.send('hello', 'before-failure')).selected;
  const target = new FakeElement(); target.textCount = 1;
  const child = new FakeElement(); child.textCount = 1; child.failMeasurement = true;
  target.snapshotChildren = [child]; target.append(child); f.documentElement.append(target);
  f.context.__styleInspectorContext = { requestId: 'failing-inspection', element: target };
  assert.equal((await f.send('capture-context', 'failing-inspection')).error, 'measurement failed');
  const state = await f.send('hello', 'after-failure');
  assert.equal(state.selected.id, before.id, 'An incomplete inspection must not replace the saved measurement');
  assert.equal(state.selectionRequest, 'confirmed', 'The request still belongs to the preceding selected element');
  assert.equal(f.registrySize(), 1, 'References created before the failure are discarded');
  assert.equal((await f.send('refresh-selection', 'refresh-preceding')).ok, true, 'Refresh measures the preceding element rather than the failed replacement');
  assert.equal((await f.send('hello', 'after-refresh')).selected.elementRef, f.reference);
});

test('picker measurement failures cancel cleanly and restore the confirmed selection without retrying', async () => {
  for (const action of ['hover', 'click']) for (const confirmed of [true, false]) {
    const f = await fixture();
    f.context.MouseEvent = class {};
    if (!confirmed) await f.send('clear-data', 'no-confirmed-selection');
    const target = new FakeElement(); target.textCount = 1;
    const child = new FakeElement(); child.textCount = 1; child.failMeasurement = true;
    target.snapshotChildren = [child]; target.append(child); f.documentElement.append(target);
    await f.send('start-picker', 'failing-picker');
    const before = f.work.snapshots;
    const event = { type: action === 'click' ? 'click' : 'pointermove', composedPath: () => [target], prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; } };
    if (action === 'hover') {
      for (const listener of f.listeners.get('pointermove') ?? []) listener(event);
      f.flushFrames(); await assert.doesNotReject(f.flushTimers(120));
    } else {
      assert.doesNotThrow(() => { for (const listener of f.listeners.get('click') ?? []) listener(event); });
      assert.equal(event.prevented, true); assert.equal(event.stopped, true, 'The failed pick must not click through to the page');
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    }
    const cancelled = f.messages.filter(message => message.type === 'picker-cancelled');
    assert.equal(cancelled.length, 1); assert.equal(cancelled[0].requestId, 'failing-picker');
    assert.equal(cancelled[0].snapshot?.elementRef, confirmed ? f.reference : undefined, 'Only an existing confirmed element is restored');
    const state = await f.send('hello', 'after-picker-failure');
    assert.equal(state.picker, false); assert.equal(state.selectionRequest, 'failing-picker');
    assert.equal(state.selected?.elementRef, confirmed ? f.reference : undefined); assert.equal(f.registrySize(), confirmed ? 1 : 0);
    for (const type of ['pointermove', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick']) {
      assert.equal(f.listeners.get(type)?.length ?? 0, 0, `${action}: ${type} guard released`);
    }
    await f.flushTimers(120); await f.flushTimers(0); f.flushFrames();
    assert.equal(f.work.snapshots, before + 1, 'Recovery must not automatically repeat the failing measurement');
    await f.send('start-picker', 'recovered-picker');
    assert.equal((await f.send('hello', 'after-restart')).picker, true, 'A new explicit pick remains possible');
    await f.send('cancel-picker', 'finish-recovered-picker');
  }
});

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

test('our highlight does not invalidate an audit, while scrolling marks it stale and repeat navigation works', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  const audit = (await f.send('hello', 'after-audit')).audit;
  assert.equal(audit.status, 'complete'); assert.equal(audit.stale, false);
  const referenceId = audit.runs[0].elementRef;
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await f.send('show-node', `show-${attempt}`, 0, { referenceId })).ok, true);
    f.flushMutations();
    if (!attempt) assert.equal((await f.send('hello', 'highlight-only')).audit.stale, false);
    for (const listener of f.listeners.get('scroll') ?? []) listener({});
    // Ownership must survive a page script removing our identifying attribute.
    const overlay = f.documentElement.children.find(node => node.hasAttribute('data-style-inspector-overlay'))!;
    overlay.removeAttribute('data-style-inspector-overlay'); f.flushMutations();
    await f.flushTimers(8000); f.flushMutations();
    for (const listener of f.listeners.get('resize') ?? []) listener({});
    assert.equal((await f.send('hello', 'still-stale')).audit.stale, true);
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
  assert.equal(f.listeners.get('scroll')?.length, 0, 'Stale or inactive data needs no scroll observer after the highlight ends');
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
  assert.equal(f.listeners.get('scroll')?.length, 0, 'Stale or inactive data needs no scroll observer after the highlight ends');
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
  assert.equal(f.listeners.get('scroll')?.length, 0, 'Stale or inactive data needs no scroll observer after the highlight ends');
  assert.equal((await f.send('show-node', 'removed', 0, { referenceId: f.reference })).error, 'element-removed');
});

test('rescan discards old selection, queued mutations and obsolete jobs while preserving settings and remeasured identities', async () => {
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
  assert.equal(latest.audit.runs[0].elementRef, f.reference);
  assert.equal((await f.send('show-node', 'remeasured-reference', 0, { referenceId: f.reference })).ok, true);
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

test('conflicting inspection marks the audit stale without rebuilding or mixing its rows and inventories', async () => {
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
  assert.equal(latestAudit(f).status, 'complete');
  f.flushMutations(); await f.flushTimers(0);
  const stale = latestAudit(f);
  assert.deepEqual(stale, { ...original, stale: true });
  assert.equal(scanStarts(f).length, 1);
  assert.equal((await f.send('hello', 'after-inspection')).selectionRequest, 'inspected');
  assert.equal((await f.send('show-node', 'retained-reference', 0, { referenceId })).ok, true);
  assert.deepEqual(audit, original, 'Previously sent audit data stays immutable');
  await f.send('select-node', 'same-explicit-inspection', 0, { referenceId });
  assert.equal(scanStarts(f).length, 1, 'Repeated inspection never starts a page scan');

  await f.send('start-audit', 'manual-rescan'); await f.flushTimers(0);
  const fresh = latestAudit(f);
  assert.equal(fresh.id, 'manual-rescan');
  assert.equal(fresh.status, 'complete'); assert.equal(fresh.stale, false);
  assert.equal(fresh.runs.length, 2); assert.equal(fresh.scanned, 2); assert.equal(fresh.total, 2);
  assert.equal(fresh.counts.contrast.pass, 2); assert.equal(fresh.counts.contrast.manual, 0); assert.equal(fresh.counts.checks, 4);
  assert.deepEqual(fresh.fonts, ['Refreshed Font', 'Second Font']);
  assert.deepEqual(fresh.fontUsage, fresh.runs.map((run: any) => ({ family: run.fontFamily, count: 1, elementRefs: [run.elementRef], sizes: [{ sizeCssPx: 16, count: 1, elementRefs: [run.elementRef] }], variants: [{ sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 1, elementRefs: [run.elementRef] }] })));
  assert.equal(fresh.paletteUsage.find((entry: any) => entry.color.raw === '#FAFAFA').count, 1);
  assert.deepEqual(fresh.palette.map((color: any) => color.raw), ['#FAFAFA', '#161717', '#111111', '#FFFFFF']);
  assert.ok(fresh.runs.every((run: any) => !('textExcerpt' in run)), 'Full scans never copy confirmed-selection excerpts');
  assert.equal((await f.send('hello', 'after-rescan')).selected, null);
  assert.equal(scanStarts(f).length, 2);
});

test('scan inventories reset together and count text elements once across fragments, stale states and cancelled jobs', async () => {
  const f = await fixture();
  f.element.textCount = 4;
  await f.send('start-audit', 'first-inventory'); await f.flushTimers(0);
  const first = structuredClone(latestAudit(f));
  assert.equal(first.runs.length, 4);
  assert.equal(first.fontUsage[0].count, 1);
  assert.deepEqual(first.fontUsage[0].sizes, [{ sizeCssPx: 16, count: 1, elementRefs: [first.runs[0].elementRef] }]);
  assert.deepEqual(first.fontUsage[0].variants, [{ sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 1, elementRefs: [first.runs[0].elementRef] }]);
  assert.ok(first.paletteUsage.every((entry: any) => entry.count === 1));
  assert.ok(first.paletteUsage.every((entry: any) => entry.elementRefs.length === 1 && entry.elementRefs[0] === first.runs[0].elementRef));
  f.element.fontFamily = 'New Stack'; f.element.color = '#123456'; f.mutate();
  const stale = latestAudit(f);
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.paletteUsage, first.paletteUsage);
  assert.deepEqual(stale.fontUsage, first.fontUsage);
  await f.send('start-audit', 'cancelled-inventory');
  f.element.fontFamily = 'Final Stack'; f.element.color = '#ABCDEF';
  await f.send('start-audit', 'final-inventory');
  const start = scanStarts(f).at(-1);
  assert.deepEqual(start.audit.palette, []); assert.deepEqual(start.audit.paletteUsage, []);
  assert.deepEqual(start.audit.fonts, []); assert.deepEqual(start.audit.fontUsage, []);
  await f.flushTimers(0);
  const fresh = latestAudit(f);
  assert.equal(fresh.id, 'final-inventory'); assert.equal(fresh.stale, false);
  assert.deepEqual(fresh.fontUsage, [{ family: 'Final Stack', count: 1, elementRefs: [fresh.runs[0].elementRef], sizes: [{ sizeCssPx: 16, count: 1, elementRefs: [fresh.runs[0].elementRef] }], variants: [{ sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 1, elementRefs: [fresh.runs[0].elementRef] }] }]);
  assert.ok(fresh.paletteUsage.some((entry: any) => entry.color.raw === '#ABCDEF'));
  assert.ok(fresh.paletteUsage.every((entry: any) => entry.color.raw !== '#123456' && entry.color.raw !== '#FAFAFA'));
  assert.equal(first.fontUsage[0].family, 'sans-serif');
  assert.equal(first.paletteUsage.find((entry: any) => entry.color.raw === '#FAFAFA').count, 1);
});

test('explicit selection refresh leaves stale audits unchanged until an explicit scan with captured settings', async () => {
  const { f, referenceId } = await uncertainAudit();
  f.element.paintReasons = []; f.mutate();
  const stale = structuredClone(latestAudit(f));
  await f.send('select-node', 'stale-inspection', 0, { referenceId }); await f.flushTimers(0);
  assert.equal(f.messages.filter(message => message.type === 'selected').at(-1).snapshot.textRuns[0].contrast.status, 'pass');
  assert.deepEqual(latestAudit(f), stale);
  f.element.color = '#777777'; f.element.backgroundColor = '#FFFFFF';
  await f.send('refresh-selection', 'now-failing', 0, { settings: { ...DEFAULT_SETTINGS, contrastTarget: 'AAA' } });
  assert.equal(f.messages.filter(message => message.type === 'selected').at(-1).snapshot.textRuns[0].contrast.status, 'fail');
  assert.deepEqual(latestAudit(f), stale);
  assert.equal(scanStarts(f).length, 1);
  await f.send('start-audit', 'manual-failing', 0, { settings: { ...DEFAULT_SETTINGS, contrastTarget: 'AAA' } });
  await f.send('settings', 'new-preference', 0, { settings: DEFAULT_SETTINGS });
  await f.flushTimers(0);
  assert.equal(latestAudit(f).target, 'AAA'); assert.equal(latestAudit(f).runs[0].contrast.target, 'AAA');
  assert.equal(latestAudit(f).counts.contrast.fail, 1);
  f.element.paintReasons = ['overlapping-element'];
  f.context.__styleInspectorContext = { requestId: 'context-change', element: f.element };
  await f.send('capture-context', 'context-change'); await f.flushTimers(0);
  assert.equal(f.messages.filter(message => message.type === 'selected').at(-1).snapshot.textRuns[0].contrast.status, 'manual');
  assert.equal(latestAudit(f).counts.contrast.fail, 1);
  assert.equal(latestAudit(f).stale, true);
  assert.equal(scanStarts(f).length, 2);
  assert.equal(f.element.scrolls, 0);
});

test('hello and resize use cached selection; user-driven picker previews and refresh never scan the page', async () => {
  const { f, referenceId } = await uncertainAudit();
  await f.send('select-node', 'unchanged-selection', 0, { referenceId });
  const cached = (await f.send('hello', 'cached')).selected;
  const before = { ...f.work };
  f.element.paintReasons = [];
  const handshake = await f.send('hello', 'passive-handshake');
  assert.equal(handshake.selected.id, cached.id);
  assert.equal(handshake.selected.textRuns[0].contrast.status, 'manual');
  assert.equal(latestAudit(f).stale, false, 'A handshake does not inspect changed CSS');
  f.window.innerWidth = 1000;
  for (const listener of f.listeners.get('resize') ?? []) listener({});
  await f.flushTimers(150);
  assert.deepEqual(f.work, before);
  assert.equal((await f.send('hello', 'after-resize')).selected.stale, true);
  await f.send('start-picker', 'preview-only');
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [f.element] });
  f.flushFrames(); await f.flushTimers(120);
  assert.ok(f.messages.some(message => message.type === 'preview'));
  assert.equal(scanStarts(f).length, 1);
  await f.send('cancel-picker', 'cancel-preview');
  await f.send('refresh-selection', 'explicit-after-passive'); await f.flushTimers(0);
  const refreshed = (await f.send('hello', 'refreshed')).selected;
  assert.notEqual(refreshed.id, cached.id);
  assert.equal(refreshed.stale, false); assert.equal(refreshed.textRuns[0].contrast.status, 'pass');
  assert.equal(scanStarts(f).length, 1);
});

test('repeated page changes stop observing stale data without measuring, scanning or flooding messages', async () => {
  for (const trigger of ['mutation', 'resize', 'scroll']) {
    const f = await fixture();
    await f.send('start-audit', 'baseline'); await f.flushTimers(0);
    await f.send('select-node', 'selected', 0, { referenceId: latestAudit(f).runs[0].elementRef });
    const before = { ...f.work }, messages = f.messages.length;
    assert.equal(f.observation.active, true);
    const change = () => {
      if (trigger === 'mutation') f.mutate();
      else {
        if (trigger === 'resize') f.window.innerWidth++;
        for (const listener of f.listeners.get(trigger) ?? []) listener({ target: f.element });
      }
    };
    change();
    const stops = f.observation.stops, deliveries = f.observation.deliveries;
    assert.equal(f.observation.active, false, trigger);
    for (let repeat = 0; repeat < 200; repeat++) { change(); f.mutate(); await f.send('hello', 'passive-' + repeat); }
    await f.flushTimers(150); await f.flushTimers(0);
    assert.deepEqual(f.work, before, trigger);
    assert.equal(f.observation.stops, stops, trigger);
    assert.equal(f.observation.deliveries, deliveries, trigger);
    assert.equal(f.mutations.length, 0, trigger);
    assert.equal(f.messages.slice(messages).filter(message => message.type === 'stale').length, 1, trigger);
    assert.equal(f.messages.slice(messages).filter(message => message.type === 'audit').length, 1, trigger);
    assert.equal(f.messages.slice(messages).some(message => message.type === 'selected'), false, trigger);
    const cached = await f.send('hello', 'stale-result');
    assert.equal(cached.selected.stale, true); assert.equal(cached.audit.stale, true);
    await f.send('refresh-selection', 'manual-refresh');
    assert.equal(f.observation.active, true, trigger);
    assert.equal(f.work.measuredElements, before.measuredElements + 1, trigger);
    assert.equal(f.work.treeWalks, before.treeWalks, trigger);
    assert.equal((await f.send('hello', 'fresh-selection')).selected.stale, false);
    assert.equal(latestAudit(f).stale, true);
    f.mutate(); assert.equal(f.observation.active, false, trigger);
    await f.send('start-audit', 'manual-rescan'); await f.flushTimers(0);
    assert.equal(f.observation.active, true, trigger);
    assert.equal(f.work.treeWalks, before.treeWalks + 1, trigger);
    assert.equal(latestAudit(f).stale, false);
  }
});

test('idle, clear, pagehide and BFCache states stop observation until an explicit new measurement', async () => {
  for (const boundary of ['clear', 'epoch', 'pagehide', 'bfcache']) {
    const f = await fixture();
    assert.equal(f.initialObservation.active, false); assert.equal(f.initialObservation.starts, 0, 'Idle injection does not observe the page');
    if (boundary === 'clear') await f.send('clear-data', 'clear', 1);
    else if (boundary === 'epoch') await f.send('hello', 'new-epoch', 1);
    else {
      for (const listener of f.listeners.get('pagehide') ?? []) listener({ persisted: boundary === 'bfcache' });
      if (boundary === 'bfcache') for (const listener of f.listeners.get('pageshow') ?? []) listener({ persisted: true });
    }
    const before = { ...f.work }, messages = f.messages.length;
    assert.equal(f.observation.active, false, boundary);
    for (let repeat = 0; repeat < 100; repeat++) f.mutate();
    assert.deepEqual(f.work, before); assert.equal(f.messages.length, messages);
    if (boundary !== 'pagehide') {
      const epoch = boundary === 'clear' || boundary === 'epoch' ? 1 : 0;
      await f.send('hello', 'idle-handshake', epoch);
      assert.equal(f.observation.active, false);
      await f.send('start-audit', 'explicit-restart', epoch); await f.flushTimers(0);
      assert.equal(f.observation.active, true);
      assert.equal(latestAudit(f).stale, false);
    }
  }
});

test('a removed stale selection is cleared on handshake or explicit refresh without remeasurement', async () => {
  for (const action of ['hello', 'refresh-selection']) {
    const f = await fixture(); f.mutate();
    assert.equal(f.observation.active, false);
    const before = { ...f.work };
    f.element.remove(); f.flushMutations();
    const result = await f.send(action, 'removed-target');
    if (action === 'refresh-selection') assert.equal(result.error, 'element-removed');
    assert.equal((await f.send('hello', 'after-removal')).selected, null);
    assert.deepEqual(f.work, before);
    assert.equal(f.messages.filter(message => message.type === 'removed').length, 1);
    assert.equal(f.observation.active, false);
  }
});

test('cancelled explicit scans cannot restart from selection refresh or a delayed batch', async () => {
  const f = await fixture();
  const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
  f.documentElement.append(...nodes);
  await f.send('start-audit', 'manual');
  f.context.__styleInspectorContext = { requestId: 'selected-during-scan', element: f.element };
  await f.send('capture-context', 'selected-during-scan');
  await f.send('cancel-audit', 'cancel'); await f.flushTimers(0);
  assert.equal(latestAudit(f).status, 'cancelled');
  const starts = scanStarts(f).length;
  f.element.paintReasons = ['overlapping-element'];
  await f.send('refresh-selection', 'after-cancel'); await f.flushTimers(0);
  assert.equal(scanStarts(f).length, starts);
  await f.send('start-audit', 'manual-restart'); await f.flushTimers(0);
  const state = await f.send('hello', 'manual-result');
  assert.equal(state.selected, null); assert.equal(state.audit.id, 'manual-restart');
});

test('clear, newer epochs, navigation and a new scan retire pending explicit audit completions', async () => {
  for (const boundary of ['clear', 'epoch', 'navigation', 'manual']) {
    const f = await fixture();
    await f.send('start-audit', 'pending-scan');
    const before = f.messages.length;
    if (boundary === 'clear') await f.send('clear-data', 'clear', 1);
    else if (boundary === 'epoch') await f.send('hello', 'new-epoch', 1);
    else if (boundary === 'manual') await f.send('start-audit', 'new-manual');
    else {
      for (const listener of f.listeners.get('pagehide') ?? []) listener({ persisted: true });
      for (const listener of f.listeners.get('pageshow') ?? []) listener({ persisted: true });
    }
    await f.flushTimers(0);
    assert.ok(f.messages.slice(before).filter(message => message.type === 'audit').every(message => message.requestId !== 'pending-scan'), boundary);
    const state = await f.send('hello', 'after-boundary', boundary === 'clear' || boundary === 'epoch' ? 1 : 0);
    assert.equal(state.selected, null, boundary);
    assert.equal(state.audit?.id ?? null, boundary === 'manual' ? 'new-manual' : null, boundary);
  }
});

test('scroll or mutation during an explicit scan marks its result partial and disconnects without retrying', async () => {
  for (const trigger of ['scroll', 'mutation']) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    await f.send('start-audit', 'manual');
    if (trigger === 'mutation') f.mutate();
    else for (const listener of f.listeners.get('scroll') ?? []) listener({ target: f.element.parentElement });
    assert.equal(f.observation.active, false);
    for (let repeat = 0; repeat < 100; repeat++) f.mutate();
    await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.status, 'partial'); assert.equal(audit.stale, true);
    assert.ok(audit.reasons.includes('document-changed-during-scan'));
    assert.equal(scanStarts(f).length, 1); assert.equal(f.observation.active, false);
  }
});

async function laterBatchSelection() {
  const f = await fixture();
  const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
  f.documentElement.append(...nodes);
  await f.send('start-audit', 'manual-batched');
  const target = nodes.at(-1)!;
  f.context.__styleInspectorContext = { requestId: 'inspect-later-node', element: target };
  await f.send('capture-context', 'inspect-later-node');
  return { f, target, selected: f.messages.filter(message => message.type === 'selected').at(-1).snapshot };
}

test('a later manual audit batch conflicting with inspection invalidates both measurements without retrying', async () => {
  const { f, target, selected } = await laterBatchSelection();
  target.paintReasons = ['layered-background'];
  await f.flushTimers(0);
  const audit = latestAudit(f);
  assert.equal(audit.runs.at(-1).contrast.status, 'manual');
  assert.equal(audit.status, 'partial'); assert.equal(audit.stale, true);
  assert.ok(audit.reasons.includes('document-changed-during-scan'));
  const stale = f.messages.filter(message => message.type === 'stale').at(-1);
  assert.equal(stale.requestId, 'inspect-later-node'); assert.equal(stale.snapshot.id, selected.id);
  assert.equal(stale.snapshot.stale, true);
  assert.equal(stale.snapshot.textRuns[0].contrast.status, 'pass', 'Old data remains intact');
  assert.equal(scanStarts(f).length, 1); assert.equal(f.observation.active, false);
});

test('a consistent later manual batch completes fresh and cancellation does not invalidate inspection', async () => {
  for (const cancel of [false, true]) {
    const { f, target } = await laterBatchSelection();
    const before = f.messages.length;
    if (cancel) { target.paintReasons = ['layered-background']; await f.send('cancel-audit', 'stop'); }
    await f.flushTimers(0);
    assert.equal(latestAudit(f).status, cancel ? 'cancelled' : 'complete');
    assert.equal(latestAudit(f).stale, false);
    assert.equal(f.messages.slice(before).some(message => message.type === 'stale'), false);
    assert.equal((await f.send('hello', 'cached-inspection')).selected.stale, false);
  }
});

test('selected text disappearing before a later manual batch invalidates the earlier visible selection', async () => {
  const { f, target } = await laterBatchSelection();
  target.textCount = 0;
  await f.flushTimers(0);
  assert.equal(latestAudit(f).status, 'partial'); assert.equal(latestAudit(f).stale, true);
  assert.equal(f.messages.filter(message => message.type === 'stale').at(-1).snapshot.stale, true);
});

test('picker previews release earlier nodes while keeping the current preview and confirmed selection usable', async () => {
  const f = await fixture();
  await f.send('start-picker', 'many-previews');
  const references: string[] = [];
  for (let index = 0; index < 150; index++) {
    const node = new FakeElement(); node.textCount = 1;
    f.documentElement.append(node);
    for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [node] });
    f.flushFrames(); await f.flushTimers(120);
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

test('repeated manual audits replace references without accumulating former page nodes', async () => {
  const f = await fixture();
  let oldNodes: FakeElement[] = [], retiredReference: string | undefined;
  for (let cycle = 0; cycle < 12; cycle++) {
    for (const node of oldNodes) node.remove();
    oldNodes = Array.from({ length: 40 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...oldNodes);
    await f.send('start-audit', 'manual-' + cycle);
    f.flushMutations(); await f.flushTimers(0);
    const audit = latestAudit(f);
    assert.equal(audit.runs.length, 41); assert.equal(audit.stale, false);
    assert.equal(f.registrySize(), 41);
    assert.equal((await f.send('show-node', 'current-target', 0, { referenceId: audit.runs[0].elementRef })).ok, true);
    if (retiredReference) assert.equal((await f.send('show-node', 'retired-node', 0, { referenceId: retiredReference })).error, 'element-removed');
    retiredReference = audit.runs[1].elementRef;
  }
});

test('a manual scan releases preceding selectable references and keeps only measured or explicitly selected nodes after cancellation', async () => {
  for (const cancel of [false, true]) {
    const f = await fixture();
    const nodes = Array.from({ length: 70 }, () => { const node = new FakeElement(); node.textCount = 1; return node; });
    f.documentElement.append(...nodes);
    await f.send('start-audit', 'original'); await f.flushTimers(0);
    const original = latestAudit(f), oldReference = original.runs.at(-1).elementRef;
    const preview = new FakeElement(); preview.textCount = 1;
    f.documentElement.append(preview);
    await f.send('start-audit', 'replacement');
    assert.ok(f.registrySize() < 71, 'A new manual scan does not keep the previous audit reserve');
    assert.equal((await f.send('show-node', 'retired-before-batch', 0, { referenceId: oldReference })).error, 'element-removed');
    await f.send('start-picker', 'during-scan');
    for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [preview] });
    f.flushFrames(); await f.flushTimers(120);
    await f.send('cancel-picker', 'stop-preview');
    if (cancel) await f.send('cancel-audit', 'stop-audit');
    await f.flushTimers(0);
    const finished = latestAudit(f);
    assert.equal(finished.status, cancel ? 'cancelled' : 'complete');
    assert.equal(finished.runs.some((run: any) => run.elementRef === oldReference), !cancel, 'Remeasuring the same DOM object restores its stable identity');
    assert.equal(f.registrySize(), finished.runs.length, 'Temporary preview references are released after the job');
  }
});

test('showing an audit node ends an active picker with the matching coordinator notification', async () => {
  const f = await fixture();
  await f.send('start-audit', 'audit'); await f.flushTimers(0);
  const referenceId = latestAudit(f).runs[0].elementRef;
  await f.send('select-node', 'confirmed-audit-node', 0, { referenceId });
  await f.send('start-picker', 'picker-to-end');
  for (const listener of f.listeners.get('pointermove') ?? []) listener({ composedPath: () => [f.element] });
  f.flushFrames(); await f.flushTimers(120);
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

test('explicit selected and audit diagnostics read current geometry without selecting, scrolling or publishing analysis', async () => {
  for (const kind of ['selection', 'audit']) {
    const f = await fixture();
    if (kind === 'audit') { await f.send('start-audit', 'diagnostic-audit'); await f.flushTimers(0); }
    const data = kind === 'audit' ? latestAudit(f) : f.messages.filter(message => message.type === 'selected').at(-1).snapshot;
    const run = (data.runs ?? data.textRuns)[0];
    const target = { referenceId: run.elementRef, runId: run.id, source: { kind, id: data.id } };
    Object.defineProperty(f.element, 'textContent', { get() { throw new Error('Diagnostic must not read page text'); } });
    Object.defineProperty(f.element, 'innerHTML', { get() { throw new Error('Diagnostic must not read markup'); } });
    const before = f.messages.length, timers = f.timers.size, references = f.registrySize();
    const result = await f.send('diagnose-node', 'explicit-diagnostic', 0, { diagnosticTarget: target });
    assert.equal(result.report.kind, 'contrast-diagnostic'); assert.equal(result.report.measurement.source, kind);
    assert.equal(result.report.measurement.measuredAt, data.measuredAt);
    assert.equal(result.report.layers[0].tag, 'p'); assert.equal(result.report.layers[1].tag, 'html');
    assert.equal(result.report.measurement.foreground.r, 250);
    assert.equal(f.messages.length, before); assert.equal(f.element.scrolls, 0);
    assert.equal(f.timers.size, timers); assert.equal(f.registrySize(), references);
    assert.equal(JSON.stringify(result.report).includes('Synthetic selection'), false);
  }
});

test('content diagnostics refuse replaced selections, removed runs, active pickers, scans and stale documents', async () => {
  for (const boundary of ['selection', 'run', 'picker', 'scan', 'clear', 'document', 'removed']) {
    const f = await fixture();
    const selected = f.messages.filter(message => message.type === 'selected').at(-1).snapshot;
    const run = selected.textRuns[0], target = { referenceId: run.elementRef, runId: run.id, source: { kind: 'selection', id: selected.id } };
    if (boundary === 'selection') await f.send('refresh-selection', 'new-selection');
    else if (boundary === 'run') target.runId = 'missing-text';
    else if (boundary === 'picker') await f.send('start-picker', 'new-picker');
    else if (boundary === 'scan') await f.send('start-audit', 'new-scan');
    else if (boundary === 'clear') await f.send('clear-data', 'data-clear', 1);
    else if (boundary === 'removed') { f.element.isConnected = false; }
    const result = await f.send('diagnose-node', 'late-diagnostic', 0, { diagnosticTarget: target, ...(boundary === 'document' ? { documentToken: 'old-document' } : {}) });
    assert.ok(['target-expired', 'page-changed', 'stale-document'].includes(result.error), boundary);
    assert.equal(result.report, undefined);
  }
});
