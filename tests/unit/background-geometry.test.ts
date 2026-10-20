import test from 'node:test';
import assert from 'node:assert/strict';
import { negativeBackground, opaqueAncestorCoversText, siblingControlCssBackground, singleSiblingInput } from '../../src/runtime/background-geometry';
import { ElementRegistry, measureRuns, type TextRunGeometry } from '../../src/runtime/dom';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { cssColorContrast } from '../../src/core/contrast';

const defaults = {
  opacity: '1', visibility: 'visible', contentVisibility: 'visible', animationName: 'none', display: 'block', mixBlendMode: 'normal', filter: 'none', backdropFilter: 'none',
  clipPath: 'none', clip: 'auto', maskImage: 'none', perspective: 'none', transformStyle: 'flat', transform: 'none',
  translate: 'none', rotate: 'none', scale: 'none', offsetPath: 'none', zoom: '1', contain: 'none', containerType: 'normal',
  willChange: 'auto', isolation: 'auto', position: 'static', zIndex: 'auto', overflowX: 'visible', overflowY: 'visible',
  backgroundColor: 'transparent', backgroundImage: 'none', backgroundClip: 'border-box', borderImageSource: 'none',
  boxShadow: 'none', textShadow: 'none', appearance: 'none', content: 'normal', outlineStyle: 'none',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px', pointerEvents: 'auto',
};
class Box {
  namespaceURI = 'http://www.w3.org/1999/xhtml'; tagName = 'DIV';
  ownerDocument = { defaultView: { innerWidth: 1280, innerHeight: 800, getComputedStyle: (node: Box) => node.css } };
  clientLeft = 0; clientTop = 0; clientWidth = 200; clientHeight = 80;
  css = { ...defaults }; pseudo = { content: 'none' };
  children: Box[] = []; childNodes: { nodeType: number; length?: number; nodeValue?: unknown }[] = [];
  shadowRoot = null; box = { left: 0, top: 0, right: 200, bottom: 80, width: 200, height: 80 };
  constructor(public parentElement: Box | null, changes: Partial<typeof defaults> = {}) { Object.assign(this.css, changes); }
  contains(other: Box): boolean { for (let node: Box | null = other; node; node = node.parentElement) if (node === this) return true; return false; }
  getClientRects() { return [this.box]; }
  getBoundingClientRect() { return this.box; }
  matches() { return false; }
  getAttribute(name: string): string | null { return name === 'type' ? 'search' : null; }
}
function fixture() {
  const context = new Box(null, { position: 'fixed', zIndex: '2020' });
  const common = new Box(context);
  const backdrop = new Box(common, { position: 'absolute', zIndex: '-1', backgroundColor: '#0F0F0F' });
  const button = new Box(common, { position: 'relative', backgroundColor: 'rgba(255,255,255,0.1)' });
  const label = new Box(button);
  return { context, common, backdrop, button, label };
}
function environment(run: () => void) {
  const originals = new Map(['Node', 'getComputedStyle'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'Node', { value: { TEXT_NODE: 3, COMMENT_NODE: 8 }, configurable: true });
  Object.defineProperty(globalThis, 'getComputedStyle', { value: (node: Box, pseudo?: string) => pseudo ? node.pseudo : node.css, configurable: true });
  try { run(); } finally { for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } }
}
const rect = { left: 30, top: 20, width: 70, height: 17 };
const measure = (f: ReturnType<typeof fixture>) => negativeBackground(f.label as unknown as Element, f.backdrop as unknown as Element, rect);

function opaqueFixture() {
  const outer = new Box(null);
  const frame = new Box(outer, { position: 'relative', backgroundColor: '#242626' });
  const wrapper = new Box(frame);
  const hint = new Box(wrapper, { position: 'absolute', zIndex: '2', pointerEvents: 'none' });
  return { outer, frame, wrapper, hint };
}
const covers = (f: ReturnType<typeof opaqueFixture>, bounds = rect, budget?: { remaining: number; limited: boolean }) =>
  opaqueAncestorCoversText(f.hint as unknown as Element, f.frame as unknown as Element, bounds, budget);

test('an opaque ancestor covers complete text without inspecting editable or unrelated contents', () => environment(() => {
  const f = opaqueFixture();
  for (const node of [f.outer, f.frame, f.wrapper, f.hint]) for (const name of ['value', 'textContent', 'innerText', 'nodeValue', 'children', 'childNodes']) {
    Object.defineProperty(node, name, { get() { throw Error(`Content must not be read: ${name}`); } });
  }
  assert.equal(covers(f), true);
  f.frame.css.transform = 'matrix(1, 0, 0, 1, 12, 0)';
  f.frame.css.borderTopLeftRadius = '10px';
  f.frame.css.borderTopWidth = '2px';
  assert.equal(covers(f), true, 'Known translations and a safely inset rounded rectangle remain supported');
  assert.equal(covers(f, { ...rect, top: 12 }), false, 'The radius and border guard applies to the whole fragment');
}));

test('opaque ancestor cutoffs reject uncertain paint, ordering and partial coverage', () => environment(() => {
  const changes: [string, (f: ReturnType<typeof opaqueFixture>) => void][] = [
    ['translucent boundary', f => { f.frame.css.backgroundColor = 'rgba(36,36,36,.9)'; }],
    ['image', f => { f.frame.css.backgroundImage = 'linear-gradient(black,white)'; }],
    ['content image', f => { f.frame.css.content = 'url(image.svg)'; }],
    ['inset shadow', f => { f.frame.css.boxShadow = 'inset 0 0 20px black'; }],
    ['inward outline', f => { f.frame.css.outlineStyle = 'solid'; }],
    ['content clipping', f => { f.frame.css.backgroundClip = 'content-box'; }],
    ['unknown radius', f => { f.frame.css.borderTopLeftRadius = '50%'; }],
    ['near rounded corner', f => { f.frame.css.borderTopLeftRadius = '30px'; }],
    ['intermediate background', f => { f.wrapper.css.backgroundColor = 'rgba(255,255,255,.1)'; }],
    ['intermediate border', f => { f.wrapper.css.borderTopWidth = '1px'; }],
    ['negative context', f => { f.wrapper.css.position = 'relative'; f.wrapper.css.zIndex = '-1'; }],
    ['negative boundary', f => { f.frame.css.zIndex = '-1'; }],
    ['outer opacity', f => { f.outer.css.opacity = '.5'; }],
    ['outer filter', f => { f.outer.css.filter = 'blur(1px)'; }],
    ['scaled ancestor', f => { f.outer.css.transform = 'matrix(2,0,0,2,0,0)'; }],
    ['shadow host', f => { Object.assign(f.wrapper, { openOrClosedShadowRoot: {} }); }],
    ['assigned slot', f => { Object.assign(f.hint, { assignedSlot: {} }); }],
    ['top layer', f => { f.frame.matches = () => true; }],
    ['root backdrop', f => { f.frame.tagName = 'BODY'; }],
    ['anonymous inner box', f => { f.frame.tagName = 'FIELDSET'; }],
    ['fragmented owner', f => { f.frame.getClientRects = () => [f.frame.box, f.frame.box]; }],
    ['nonancestor', f => { f.hint.parentElement = f.outer; }],
    ['partial frame', f => { f.frame.box.width = 90; }],
  ];
  for (const [name, change] of changes) { const f = opaqueFixture(); change(f); assert.equal(covers(f), false, name); }
  const f = opaqueFixture();
  for (const bounds of [{ ...rect, width: 0 }, { ...rect, left: NaN }, { ...rect, left: -1 }, { ...rect, top: 795 }]) assert.equal(covers(f, bounds), false);
}));

test('ancestor clipping requires the entire text inside the scrollport including scrollbar margins', () => environment(() => {
  const f = opaqueFixture(); f.outer.css.overflowX = 'auto'; f.outer.css.overflowY = 'auto';
  assert.equal(covers(f), true);
  f.outer.clientWidth = 99;
  assert.equal(covers(f), false, 'A border box can cover text while a vertical scrollbar clips it');
  f.outer.clientWidth = 200; f.outer.clientHeight = 37;
  assert.equal(covers(f), false, 'Horizontal scrollbars also clip the range');
  f.outer.clientHeight = 80; f.outer.clientLeft = 31;
  assert.equal(covers(f), false, 'Left-side scrollbar space is not background coverage');
  f.outer.clientLeft = 0; f.outer.clientWidth = NaN;
  assert.equal(covers(f), false, 'Unknown client geometry cannot establish coverage');
}));

test('opaque ancestor proofs retain bounded traversal and shared paint budgets', () => environment(() => {
  const f = opaqueFixture(), budget = { remaining: 4, limited: false };
  assert.equal(covers(f, rect, budget), true); assert.equal(budget.remaining, 0); assert.equal(budget.limited, false);
  assert.equal(covers(f, rect, budget), false); assert.equal(budget.limited, true);
  for (let i = 0; i < 65; i++) f.outer.parentElement = new Box(f.outer.parentElement);
  assert.equal(covers(f), false);
}));

test('paint below a covering ancestor is ignored only when every original fragment is covered', () => environment(() => {
  const f = opaqueFixture(), under = new Box(null, { backgroundColor: 'white' }), overlay = new Box(null, { backgroundColor: 'red' });
  Object.assign(f.hint.css, { color: 'white', fontSize: '15px', fontWeight: '400' });
  let stack = [f.frame, under];
  const geometry: TextRunGeometry = { rects: [rect, { ...rect, top: 40 }], limited: false };
  const replacements = { SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => stack } };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const measure = () => measureRuns(f.hint as unknown as Element, new ElementRegistry('opaque-hint'), DEFAULT_SETTINGS, 1, [geometry])[0]!;
  try {
    const run = measure(); assert.equal(run.contrast.status, 'pass'); assert.deepEqual(run.effectiveBackground, { r: 36, g: 38, b: 38, a: 1 });
    stack = [overlay, f.frame, under]; assert.equal(measure().contrast.status, 'manual', 'A real earlier overlay remains unresolved');
    stack = [f.frame, under];
    geometry.rects[1] = { ...rect, top: 70 }; assert.equal(measure().contrast.status, 'manual', 'A later fragment extends beyond the boundary');
    geometry.rects.reverse(); assert.equal(measure().contrast.status, 'manual', 'An invalid first fragment is not discarded');
    geometry.rects = [rect]; geometry.limited = true; assert.equal(measure().contrast.status, 'manual', 'Incomplete range sampling remains manual');
    geometry.limited = false; geometry.rects = Array.from({ length: 17 }, () => rect);
    assert.ok(measure().reasons.includes('overlap-sampling-limit'), 'Shared ancestor proof work exhausts the existing per-run budget');
  } finally { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } }
}));

test('separate opaque backgrounds compose below translucent button ancestors in their shared context', () => environment(() => {
  const f = fixture();
  assert.deepEqual(measure(f), { r: 39, g: 39, b: 39, a: 1 });
  f.backdrop.css.backgroundColor = '#333333';
  assert.deepEqual(measure(f), { r: 71.4, g: 71.4, b: 71.4, a: 1 });
  f.button.css.backgroundColor = '#FFFFFF';
  assert.deepEqual(measure(f), { r: 255, g: 255, b: 255, a: 1 });
}));

test('a negative number alone cannot establish background order across unrelated or lower text contexts', () => environment(() => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.backdrop.parentElement = new Box(f.common, { position: 'relative', zIndex: '3' }); },
    (f: ReturnType<typeof fixture>) => { f.button.css.zIndex = '-2'; },
    (f: ReturnType<typeof fixture>) => { f.backdrop.css.zIndex = '0'; },
    (f: ReturnType<typeof fixture>) => { f.backdrop.css.zIndex = '2'; },
    (f: ReturnType<typeof fixture>) => { f.context.css.position = 'static'; f.context.css.zIndex = 'auto'; },
    (f: ReturnType<typeof fixture>) => { f.common.css.transform = 'rotate(20deg)'; },
    (f: ReturnType<typeof fixture>) => { f.context.css.overflowX = 'hidden'; },
    (f: ReturnType<typeof fixture>) => { f.common.css.contentVisibility = 'auto'; },
    (f: ReturnType<typeof fixture>) => { f.common.css.animationName = 'fade'; },
    (f: ReturnType<typeof fixture>) => { f.backdrop.matches = () => true; },
  ]) { const f = fixture(); change(f); assert.equal(measure(f), null); }
}));

test('partial or uncertain paint cannot supply a background and unrelated text contents are never read', () => environment(() => {
  for (const changes of [
    { backgroundColor: 'rgba(15,15,15,0.9)' }, { backgroundImage: 'linear-gradient(black,white)' },
    { maskImage: 'url(mask.svg)' }, { opacity: '0.5' }, { borderTopLeftRadius: '20px' },
    { filter: 'blur(1px)' }, { backdropFilter: 'blur(1px)' }, { display: 'list-item' },
  ]) { const f = fixture(); Object.assign(f.backdrop.css, changes); assert.equal(measure(f), null); }
  const f = fixture(); f.backdrop.box.right = 80; assert.equal(measure(f), null); f.backdrop.box.right = 200;
  f.backdrop.childNodes = [{ nodeType: 3, length: 1, get nodeValue(): never { throw Error('No unrelated text reads'); } }];
  assert.equal(measure(f), null);
  f.backdrop.childNodes[0]!.length = 0; assert.deepEqual(measure(f), { r: 39, g: 39, b: 39, a: 1 });
  f.backdrop.pseudo.content = '""'; assert.equal(measure(f), null);
}));

test('background proofs stop at bounded ancestry and child-node limits', () => environment(() => {
  const f = fixture();
  for (let i = 0; i < 60; i++) f.common.parentElement = new Box(f.common.parentElement);
  assert.deepEqual(measure(f), { r: 39, g: 39, b: 39, a: 1 });
  for (let i = 0; i < 5; i++) f.common.parentElement = new Box(f.common.parentElement);
  assert.equal(measure(f), null);
  const crowded = fixture(); crowded.backdrop.childNodes = Array.from({ length: 33 }, () => ({ nodeType: 8 }));
  assert.equal(measure(crowded), null);
}));

function hintFixture() {
  const parent = new Box(null, { position: 'relative' });
  const input = new Box(parent, { display: 'inline-block', backgroundColor: '#29323D', paddingRight: '100px' });
  input.tagName = 'INPUT';
  Object.defineProperties(input, {
    value: { get() { throw new Error('Input values must never be read'); } },
    placeholder: { get() { throw new Error('Placeholder text must never be read'); } },
  });
  const hint = new Box(parent, { position: 'absolute', pointerEvents: 'none', transform: 'matrix(1, 0, 0, 1, 0, -14)' });
  parent.children = [hint, input];
  return { parent, input, hint };
}
const hintRect = { left: 120, top: 20, width: 40, height: 17 };
const cssHint = (f: ReturnType<typeof hintFixture>, bounds = hintRect) => siblingControlCssBackground(f.hint as unknown as Element, f.input as unknown as Element, bounds);

test('reserved input padding supplies a CSS-only background without reading control contents', () => environment(() => {
  const f = hintFixture();
  assert.deepEqual(cssHint(f), { r: 41, g: 50, b: 61, a: 1 });
  f.parent.parentElement = new Box(null, { display: 'contents' });
  assert.deepEqual(cssHint(f), { r: 41, g: 50, b: 61, a: 1 }, 'A boxless outer wrapper retains the same CSS pair');
  f.parent.parentElement.css.opacity = '.5'; assert.equal(cssHint(f), null, 'Boxless wrappers still retain effect guards');
  f.parent.parentElement.css.opacity = '1';
  assert.equal(cssHint(f, { ...hintRect, left: 50 }), null, 'The input text area is not a hint background');
  assert.equal(cssHint(f, { ...hintRect, left: 180 }), null, 'Partial coverage is not enough');
  f.input.css.paddingRight = '0px'; assert.equal(cssHint(f), null);
}));

test('sibling CSS backgrounds reject unrelated controls, native paint, unknown geometry and compositing', () => environment(() => {
  for (const change of [
    (f: ReturnType<typeof hintFixture>) => { f.input.parentElement = new Box(f.parent); },
    (f: ReturnType<typeof hintFixture>) => { f.input.tagName = 'TEXTAREA'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.getAttribute = () => 'password'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.css.appearance = 'auto'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.css.backgroundColor = 'rgba(41,50,61,.5)'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.css.backgroundImage = 'linear-gradient(white,black)'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.css.borderTopLeftRadius = '50%'; },
    (f: ReturnType<typeof hintFixture>) => { f.input.css.borderTopLeftRadius = '50px'; },
    (f: ReturnType<typeof hintFixture>) => { f.hint.css.zIndex = '-1'; },
    (f: ReturnType<typeof hintFixture>) => { f.hint.css.backgroundColor = 'white'; },
    (f: ReturnType<typeof hintFixture>) => { f.parent.css.opacity = '.5'; },
    (f: ReturnType<typeof hintFixture>) => { f.parent.css.transform = 'matrix(2,0,0,2,0,0)'; },
  ]) { const f = hintFixture(); change(f); assert.equal(cssHint(f), null); }
}));

test('offscreen input associations are bounded, direct and unambiguous without reading form contents', () => environment(() => {
  const f = hintFixture(), find = () => singleSiblingInput(f.hint as unknown as Element);
  assert.equal(find(), f.input);
  f.input.getAttribute = name => { assert.equal(name, 'type'); return 'search'; };
  assert.deepEqual(cssHint(f), { r: 41, g: 50, b: 61, a: 1 });
  const other = new Box(f.parent); other.tagName = 'INPUT';
  f.parent.children.push(other); assert.equal(find(), null, 'A second input has no provable order offscreen');
  f.parent.children.pop();
  f.parent.children = [f.hint, ...Array.from({ length: 30 }, () => new Box(f.parent)), f.input];
  assert.equal(find(), f.input); f.parent.children.push(new Box(f.parent)); assert.equal(find(), null);
  f.parent.children = [f.hint, new Box(f.parent)]; assert.equal(find(), null, 'No descendant search');
  f.parent.children = [f.hint, f.input];
  for (const [node, property] of [[f.parent, 'shadowRoot'], [f.parent, 'openOrClosedShadowRoot'], [f.parent, 'assignedSlot'], [f.hint, 'assignedSlot'], [f.input, 'assignedSlot']] as const) {
    Object.assign(node, { [property]: {} }); assert.equal(find(), null, property); Object.assign(node, { [property]: null });
  }
}));

test('all offscreen text fragments must share the reserved input padding before exposing a CSS pair', () => environment(() => {
  const f = hintFixture();
  f.parent.css.backgroundColor = '#212831';
  Object.assign(f.hint.css, { color: '#BFBFBF', fontSize: '11px', fontWeight: '400' });
  f.input.box = { left: 0, top: -1000, right: 200, bottom: -920, width: 200, height: 80 };
  const first = { ...hintRect, top: -980 }, second = { ...hintRect, top: -960 };
  const geometry: TextRunGeometry = { rects: [first, second], limited: false };
  const replacements = {
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800,
    document: { elementsFromPoint: () => { throw Error('Offscreen coordinates cannot be hit-tested'); } },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const measure = () => measureRuns(f.hint as unknown as Element, new ElementRegistry('offscreen-hint'), DEFAULT_SETTINGS, 1, [geometry])[0]!;
  try {
    const run = measure();
    assert.equal(run.contrast.ratio, null); assert.equal(run.contrast.status, 'manual');
    assert.equal(run.contrast.reason, 'layered-background');
    assert.equal(cssColorContrast(run)?.ratio, 7.058440424184376);
    assert.equal(cssColorContrast(run)?.verified, false);
    geometry.rects = [first, { ...second, left: 50 }]; assert.equal(cssColorContrast(measure()), null, 'A later fragment enters the input text area');
    geometry.rects.reverse(); assert.equal(cssColorContrast(measure()), null, 'An invalid first fragment cannot be discarded');
    geometry.rects = [first, second]; geometry.limited = true; assert.equal(cssColorContrast(measure()), null);
    geometry.limited = false;
    const other = new Box(f.parent); other.tagName = 'INPUT'; f.parent.children.push(other);
    assert.equal(cssColorContrast(measure()), null, 'Ambiguous inputs do not acquire a pair through the audit path');
  } finally { for (const [key, descriptor] of previous) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } }
}));
