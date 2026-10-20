import test from 'node:test';
import assert from 'node:assert/strict';
import { absolutePseudoIsSeparated } from '../../src/runtime/absolute-pseudo-geometry';

function style(changes: Record<string, string> = {}) {
  const values: Record<string, string> = {
    display: 'block', position: 'static', content: '""', cssFloat: 'none', direction: 'ltr', writingMode: 'horizontal-tb',
    transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none', transformStyle: 'flat', zoom: '1',
    backgroundImage: 'none', borderImageSource: 'none', boxShadow: 'none', filter: 'none', backdropFilter: 'none', textShadow: 'none',
    outlineStyle: 'none', appearance: 'none', textDecorationLine: 'none', textEmphasisStyle: 'none', mixBlendMode: 'normal',
    justifySelf: 'auto', alignSelf: 'auto', contain: 'none', containerType: 'normal', contentVisibility: 'visible', willChange: 'auto',
    width: '6px', left: '0px', right: '294px', top: '0px', bottom: '0px', boxSizing: 'border-box',
    marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px', paddingLeft: '0px', paddingRight: '0px',
    borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
    overflowX: 'visible', overflowY: 'visible', gridColumnStart: 'auto', gridColumnEnd: 'auto', gridRowStart: 'auto', gridRowEnd: 'auto',
    '-webkit-text-stroke-width': '0px', ...changes,
  };
  return Object.assign(values, { getPropertyValue: (property: string) => values[property] ?? '' }) as unknown as CSSStyleDeclaration;
}

class ElementFixture {
  namespaceURI = 'http://www.w3.org/1999/xhtml'; tagName = 'DIV'; assignedSlot = null; shadowRoot = null;
  parentElement: ElementFixture | null = null; scrollLeft = 0; scrollTop = 0; fragments = 1; open = true;
  computed = style(); detailsContent = style(); firstLine: CSSStyleDeclaration | null = null;
  bounds = { left: 10, top: 20, width: 300, height: 100 };
  ownerDocument = { defaultView: { devicePixelRatio: 1 } };
  contains(target: ElementFixture) { for (let node: ElementFixture | null = target; node; node = node.parentElement) if (node === this) return true; return false; }
  closest() { return null; }
  hasAttribute(name: string) { return name === 'open' && this.open; }
  getClientRects() { return Array.from({ length: this.fragments }, () => this.bounds); }
  getBoundingClientRect() { return this.bounds; }
}

function fixture() {
  const owner = new ElementFixture(), target = new ElementFixture(); owner.computed.position = 'relative'; target.parentElement = owner;
  const pseudo = style({ position: 'absolute' });
  const geometry = { rects: [{ left: 50, top: 30, width: 100, height: 20 }], limited: false };
  const metrics = { width: 100, actualBoundingBoxLeft: 0, actualBoundingBoxRight: 100 };
  const check = () => absolutePseudoIsSeparated(owner as unknown as Element, target as unknown as Element, '::after', pseudo, geometry, () => metrics);
  return { owner, target, pseudo, geometry, metrics, check };
}

function environment(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (element: ElementFixture, pseudo?: string) =>
    pseudo === '::details-content' ? element.detailsContent : pseudo === '::first-line' && element.firstLine ? element.firstLine : element.computed });
  try { run(); } finally { if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous); else Reflect.deleteProperty(globalThis, 'getComputedStyle'); }
}

test('empty left and right absolute strips use padding edges, both box models and offscreen coordinates', () => environment(() => {
  for (const display of ['block', 'flex', 'grid', 'inline-flex', 'inline-grid']) {
    const data = fixture(); data.owner.computed.display = display; assert.equal(data.check(), true, display);
    data.pseudo.left = '294px'; data.pseudo.right = '0px'; assert.equal(data.check(), true, `${display}: right strip`);
  }
  const data = fixture(); data.owner.computed.borderLeftWidth = '3px'; data.owner.computed.borderRightWidth = '5px';
  data.pseudo.right = '286px'; assert.equal(data.check(), true);
  Object.assign(data.pseudo, { boxSizing: 'content-box', width: '2px', paddingLeft: '1px', paddingRight: '1px', borderLeftWidth: '1px', borderRightWidth: '1px' });
  assert.equal(data.check(), true);
  data.owner.bounds.top -= 3000; data.geometry.rects[0]!.top -= 3000; assert.equal(data.check(), true, 'Viewport intersection is irrelevant');
}));

test('strip overlap, text overhang, uncertainty and insufficient paint guards retain the pseudo', () => environment(() => {
  const data = fixture(); data.pseudo.left = '45px'; data.pseudo.right = '249px'; assert.equal(data.check(), false);
  data.pseudo.left = '0px'; data.pseudo.right = '294px'; data.metrics.actualBoundingBoxLeft = 40; assert.equal(data.check(), false);
  data.metrics.actualBoundingBoxLeft = 0; data.pseudo.left = '294px'; data.pseudo.right = '0px'; data.metrics.actualBoundingBoxRight = 260; assert.equal(data.check(), false);
  data.metrics.actualBoundingBoxRight = 100; data.metrics.width = 104; assert.equal(data.check(), false);
  data.metrics.width = 100; data.geometry.limited = true; assert.equal(data.check(), false);
  data.geometry.limited = false; data.geometry.rects.push({ ...data.geometry.rects[0]! }); assert.equal(data.check(), false);
  const edge = fixture(); edge.geometry.rects[0]!.left = 20; assert.equal(edge.check(), false, 'Touching the conservative pixel guard cannot pass');
  const scale = fixture(); scale.owner.ownerDocument.defaultView.devicePixelRatio = 0; assert.equal(scale.check(), false);
  const missing = fixture();
  assert.equal(absolutePseudoIsSeparated(missing.owner as unknown as Element, missing.target as unknown as Element,
    '::after', missing.pseudo, missing.geometry, () => null), false, 'An unavailable loaded-font ink proof cannot be bypassed');
}));

test('unknown dimensions, alignment, content and expanded painting cannot use absolute separation', () => environment(() => {
  for (const changes of [
    { content: '"icon"' }, { content: 'url(icon.svg)' }, { position: 'fixed' }, { left: 'auto' }, { right: '10%' }, { width: 'auto' }, { right: '100px' },
    { marginLeft: '1px' }, { marginTop: 'auto' }, { top: 'calc(50% - 1px)' }, { justifySelf: 'center' }, { alignSelf: 'end' },
    { boxShadow: '0 0 5px black' }, { filter: 'blur(2px)' }, { outlineStyle: 'solid' }, { borderImageSource: 'url(border.svg)' },
    { backgroundImage: 'linear-gradient(white, black)' }, { transform: 'matrix(1, 0, 0, 1, 30, 0)' }, { rotate: '180deg' },
    { direction: 'rtl' }, { writingMode: 'vertical-rl' }, { '-webkit-text-stroke-width': '1px' }, { 'position-area': 'center' },
    { 'position-anchor': '--surface' }, { 'position-try-fallbacks': 'flip-inline' },
  ]) { const data = fixture(); Object.assign(data.pseudo, changes); assert.equal(data.check(), false, JSON.stringify(changes)); }
}));

test('anonymous, scrolling, fragmented, shadow and altered coordinate owners remain uncertain', () => environment(() => {
  for (const tagName of ['FIELDSET', 'BUTTON', 'TABLE', 'SELECT']) { const data = fixture(); data.owner.tagName = tagName; assert.equal(data.check(), false, tagName); }
  for (const changes of [{ position: 'static' }, { display: 'inline' }, { overflowX: 'auto' }, { transform: 'matrix(1,0,0,1,10,0)' }, { perspective: '400px' }]) {
    const data = fixture(); Object.assign(data.owner.computed, changes); assert.equal(data.check(), false, JSON.stringify(changes));
  }
  const fragmented = fixture(); fragmented.owner.fragments = 2; assert.equal(fragmented.check(), false);
  const scrolled = fixture(); scrolled.owner.scrollLeft = 10; assert.equal(scrolled.check(), false);
  for (const property of ['assignedSlot', 'shadowRoot', 'openOrClosedShadowRoot']) {
    const data = fixture(); Object.assign(data.target, { [property]: {} }); assert.equal(data.check(), false, property);
  }
  const ancestor = fixture(); const parent = new ElementFixture(); parent.computed.scale = '2'; ancestor.owner.parentElement = parent; assert.equal(ancestor.check(), false);
  const firstLine = fixture(); firstLine.target.firstLine = style({ fontSize: '50px' }); assert.equal(firstLine.check(), false);
  const placed = fixture(); placed.owner.computed.display = 'grid'; placed.pseudo.gridColumnStart = '2'; assert.equal(placed.check(), false);
}));

test('open details need an ordinary internal block without additional containing-block effects', () => environment(() => {
  const data = fixture(); data.owner.tagName = 'DETAILS'; assert.equal(data.check(), true);
  data.owner.open = false; assert.equal(data.check(), false); data.owner.open = true;
  for (const changes of [{ display: '' }, { position: 'relative' }, { transform: 'matrix(1,0,0,1,40,0)' },
    { contain: 'layout' }, { containerType: 'inline-size' }, { contentVisibility: 'auto' }, { willChange: 'transform' }, { filter: 'blur(1px)' }] as Record<string, string>[]) {
    data.owner.detailsContent = style(changes); assert.equal(data.check(), false, JSON.stringify(changes));
  }
}));
