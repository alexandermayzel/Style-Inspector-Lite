import test from 'node:test';
import assert from 'node:assert/strict';
import { pseudoIsSeparated } from '../../src/runtime/pseudo-geometry';

function style(changes: Record<string, string> = {}) {
  const value: Record<string, string> = {
    display: 'block', position: 'static', direction: 'ltr', writingMode: 'horizontal-tb', unicodeBidi: 'normal',
    transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none', zoom: '1',
    cssFloat: 'none', order: '0', flexGrow: '0', flexBasis: 'auto', flexDirection: 'row', flexWrap: 'nowrap', justifyContent: 'normal',
    columnGap: 'normal', columnCount: 'auto', columnWidth: 'auto', boxSizing: 'border-box', width: '20px', height: '20px', content: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderImageSource: 'none', filter: 'none', backdropFilter: 'none', textShadow: 'none', appearance: 'none',
    outlineStyle: 'none', textDecorationLine: 'none', textEmphasisStyle: 'none', boxShadow: 'none', textAlign: 'start', overflowX: 'visible', overflowY: 'visible',
    whiteSpace: 'normal', textTransform: 'none', fontStyle: 'normal', fontStretch: '100%', fontVariantCaps: 'normal',
    fontVariantLigatures: 'normal', fontVariantNumeric: 'normal', fontVariantAlternates: 'normal', fontVariantEastAsian: 'normal',
    fontVariantPosition: 'normal', fontFeatureSettings: 'normal', fontVariationSettings: 'normal', fontSizeAdjust: 'none',
    fontOpticalSizing: 'auto', letterSpacing: 'normal', wordSpacing: '0px', textIndent: '0px',
    fontFamily: 'Arial', fontSize: '12px', fontWeight: '400', fontKerning: 'auto',
    paddingLeft: '0px', paddingRight: '0px', borderLeftWidth: '0px', borderRightWidth: '0px', borderTopWidth: '0px', borderBottomWidth: '0px',
    marginLeft: '0px', marginRight: '0px', marginTop: '0px', marginBottom: '0px',
    top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', '-webkit-text-stroke-width': '0px', ...changes,
  };
  return Object.assign(value, { getPropertyValue: (key: string) => value[key] ?? '' }) as unknown as CSSStyleDeclaration;
}

class ElementFixture {
  namespaceURI = 'http://www.w3.org/1999/xhtml'; nodeType = 1;
  childNodes: (ElementFixture | { nodeType: number; nodeValue: string })[] = [];
  parentElement: ElementFixture | null = null; scrollLeft = 0; scrollTop = 0; fragments = 1; editable = false;
  before = style(); after = style(); computed = style();
  rect = { left: 10, top: 20, width: 59, height: 28 };
  constructor(public ownerDocument: Document) {}
  getClientRects() { return Array.from({ length: this.fragments }, () => this.rect); }
  getBoundingClientRect() { return this.rect; }
  contains(target: ElementFixture) { for (let node: ElementFixture | null = target; node; node = node.parentElement) if (node === this) return true; return false; }
  closest() { return this.editable ? this : null; }
}

function fixture() {
  const ink = { glyphWidth: 6, glyphLeft: 0, glyphRight: 6, targetWidth: 24, targetLeft: 0, targetRight: 24 };
  const context = {
    font: '', textAlign: '', textBaseline: '', direction: '', fontKerning: '',
    measureText(text: string) {
      const glyph = text === '/' || text === '|' || text === '•' || text === '·' || text === '\ue940';
      return { width: glyph ? ink.glyphWidth : ink.targetWidth,
        actualBoundingBoxLeft: glyph ? ink.glyphLeft : ink.targetLeft, actualBoundingBoxRight: glyph ? ink.glyphRight : ink.targetRight,
        actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 };
    },
  };
  const document = { fonts: { status: 'loaded', check: () => true }, defaultView: { devicePixelRatio: 1 }, createElement: () => ({ getContext: () => context }) };
  const owner = new ElementFixture(document as unknown as Document);
  owner.computed = style({ display: 'flex', paddingLeft: '5px', paddingRight: '5px' });
  owner.childNodes = [{ nodeType: 3, nodeValue: 'Text' }];
  const after = style({ display: 'flex', content: '"/"', marginLeft: '5px', borderLeftWidth: '1px', borderRightWidth: '1px',
    boxShadow: 'rgb(191, 191, 191) 1px 1px 1px 0px', justifyContent: 'center' });
  const geometry = { rects: [{ left: 15, top: 25, width: 24, height: 12 }], limited: false };
  return { owner, after, geometry, document, ink };
}

function environment(run: () => void) {
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 }, getComputedStyle: (element: ElementFixture, pseudo?: string) => pseudo === '::before' ? element.before : pseudo === '::after' ? element.after : element.computed })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try { run(); } finally { for (const [key, value] of saved) { if (value) Object.defineProperty(globalThis, key, value); else Reflect.deleteProperty(globalThis, key); } }
}
const check = (data: ReturnType<typeof fixture>, target = data.owner) => pseudoIsSeparated(data.owner as unknown as Element,
  target as unknown as Element, '::after', data.after, data.geometry);

test('static trailing keycaps are separated under translations and conservative Firefox shadow bounds', () => environment(() => {
  const data = fixture();
  assert.equal(check(data), true);
  data.owner.computed.transform = 'matrix(1, 0, 0, 1, 0, -14)';
  data.owner.computed.unicodeBidi = 'isolate';
  const ancestor = new ElementFixture(data.owner.ownerDocument); ancestor.computed.transform = 'matrix(1, 0, 0, 1, 80, 20)'; data.owner.parentElement = ancestor;
  assert.equal(check(data), true);
  data.document.defaultView.devicePixelRatio = 2; assert.equal(check(data), true);
  data.document.defaultView.devicePixelRatio = 0.5; assert.equal(check(data), false, 'A lower device scale requires a larger paint guard');
  data.document.defaultView.devicePixelRatio = 0; assert.equal(check(data), false);
}));

test('centered half-turns reflect icon ink and preserve uncertain transforms and overhangs', () => environment(() => {
  const data = fixture();
  Object.assign(data.after, { content: '"\ue940"', transform: 'matrix(-1, 0, 0, -1, 0, 0)',
    transformOrigin: '10px 10px', transformBox: 'view-box', boxShadow: 'none' });
  assert.equal(check(data), true);
  data.ink.glyphRight = 30;
  assert.equal(check(data), false, 'A reflected right overhang now reaches towards preceding text');
  data.ink.glyphRight = 6;
  for (const changes of [{ transformOrigin: '0px 10px' }, { transformOrigin: '10px 10px 1px' },
    { transformBox: 'content-box' }, { transform: 'matrix(-1, 0, 0, -1, -6, 0)' },
    { transform: 'matrix(0, 1, -1, 0, 0, 0)' }, { boxShadow: 'rgb(0, 0, 0) 1px 1px 1px 0px' }, { rotate: '180deg' }]) {
    const previous = Object.fromEntries(Object.keys(changes).map(key => [key, data.after[key as keyof CSSStyleDeclaration]]));
    Object.assign(data.after, changes); assert.equal(check(data), false, JSON.stringify(changes)); Object.assign(data.after, previous);
  }
  data.document.fonts.status = 'loading'; assert.equal(check(data), false);
  data.document.fonts.status = 'loaded'; data.after.content = '"\ue940\ue940"'; assert.equal(check(data), false);
  data.after.content = '"\ue940"'; data.after.transform = 'none'; assert.equal(check(data), true);
}));

test('inline separators collapse only ASCII boundary whitespace and retain literal glyph measurement', () => environment(() => {
  const data = fixture(); data.owner.computed.display = 'inline'; data.owner.computed.paddingLeft = data.owner.computed.paddingRight = '0px';
  data.geometry.rects[0]!.left = data.owner.rect.left;
  data.owner.rect.width = 35.7;
  Object.assign(data.after, { display: 'inline-block', content: '" | "', width: '3.7px', borderLeftWidth: '0px', borderRightWidth: '0px', marginLeft: '4px', marginRight: '4px', boxShadow: 'none' });
  data.ink.glyphWidth = 3.6; data.ink.glyphRight = 3.5;
  assert.equal(check(data), true);
  data.after.content = '"\u00a0|\u00a0"'; assert.equal(check(data), false, 'Nonbreaking spaces cannot be trimmed into a smaller glyph');
}));

test('a breadcrumb gap separates its one visible child despite a hidden metadata sibling', () => environment(() => {
  const data = fixture(); data.owner.childNodes = []; data.owner.rect.width = 42;
  Object.assign(data.owner.computed, { paddingLeft: '0px', paddingRight: '0px', columnGap: '4px' });
  Object.assign(data.after, { display: 'block', width: '4px', borderLeftWidth: '0px', borderRightWidth: '0px', marginLeft: '0px', boxShadow: 'none' });
  data.ink.glyphWidth = 3.9; data.ink.glyphRight = 3.7;
  const hidden = new ElementFixture(data.owner.ownerDocument); hidden.computed.display = 'none'; hidden.parentElement = data.owner;
  const child = new ElementFixture(data.owner.ownerDocument); child.parentElement = data.owner; child.rect.width = 34;
  child.childNodes = [{ nodeType: 3, nodeValue: 'Text' }]; child.computed = style({ position: 'relative', top: '0px', right: '0px', bottom: '0px', left: '0px' });
  data.owner.childNodes = [hidden, child];
  assert.equal(check(data, child), true);
  child.computed.left = '1px'; assert.equal(check(data, child), false);
  child.computed.left = '0px'; hidden.computed.display = 'block'; assert.equal(check(data, child), false);
}));

test('text ink overhang, mismatched shaping and unavailable fonts retain uncertainty', () => environment(() => {
  const data = fixture(); assert.equal(check(data), true);
  data.ink.targetRight = 26; assert.equal(check(data), false, 'Target glyph ink reaching past its advance can meet a shadow');
  data.ink.targetRight = 24; data.ink.targetWidth = 27; assert.equal(check(data), false);
  data.ink.targetWidth = 24; data.ink.glyphLeft = 12; assert.equal(check(data), false);
  data.ink.glyphLeft = 0; data.ink.glyphWidth = 19; assert.equal(check(data), false);
  data.ink.glyphWidth = 6; data.document.fonts.status = 'loading'; assert.equal(check(data), false);
  data.document.fonts.status = 'loaded'; data.document.fonts.check = () => false; assert.equal(check(data), false);
}));

test('nonstandard layout, paint, content and coordinates cannot use the separator proof', () => environment(() => {
  const changes: Record<string, string>[] = [
    { position: 'absolute' }, { marginLeft: '0px' }, { marginLeft: '-1px' }, { marginRight: '-1px' }, { marginTop: '-1px' },
    { order: '-1' }, { flexGrow: '1' }, { flexBasis: '10px' }, { transform: 'matrix(1, 0, 0, 1, 1, 0)' },
    { scale: '2' }, { rotate: '1deg' }, { translate: '1px' }, { perspective: '100px' }, { offsetPath: 'path("M0 0")' }, { zoom: '2' },
    { backgroundImage: 'url("icon.svg")' }, { borderImageSource: 'url("border.svg")' }, { outlineStyle: 'solid' },
    { filter: 'blur(1px)' }, { textShadow: '1px 1px black' }, { textEmphasisStyle: 'filled dot' }, { appearance: 'auto' },
    { boxShadow: 'rgb(0, 0, 0) 1px 1px 2px 0px' }, { boxShadow: 'rgb(0, 0, 0) -1px 1px 1px 0px' },
    { boxShadow: 'rgb(0, 0, 0) 1px 1px 1px 1px' }, { boxShadow: 'inset rgb(0, 0, 0) 1px 1px 1px 0px' },
    { content: 'url("image.svg")' }, { content: '"\\2f"' }, { content: '"too long content"' }, { content: '"\u202e/"' },
    { fontStyle: 'italic' }, { fontFeatureSettings: '"liga" 0' }, { fontVariationSettings: '"wght" 500' },
    { letterSpacing: '-1px' }, { direction: 'rtl' }, { whiteSpace: 'pre' }, { writingMode: 'vertical-rl' }, { unicodeBidi: 'bidi-override' },
  ];
  for (const change of changes) { const data = fixture(); Object.assign(data.after, change); assert.equal(check(data), false, JSON.stringify(change)); }
  for (const change of [{ flexDirection: 'row-reverse' }, { flexWrap: 'wrap' }, { justifyContent: 'center' },
    { transform: 'matrix(2, 0, 0, 2, 0, 0)' }, { transform: 'matrix(-1, 0, 0, -1, 0, 0)' }, { direction: 'rtl' }]) {
    const data = fixture(); Object.assign(data.owner.computed, change); assert.equal(check(data), false, JSON.stringify(change));
  }
}));

test('incomplete, fragmented, crowded or form-related geometry falls back without unbounded work', () => environment(() => {
  const data = fixture();
  data.geometry.limited = true; assert.equal(check(data), false); data.geometry.limited = false;
  data.geometry.rects.push({ ...data.geometry.rects[0]! }); assert.equal(check(data), false); data.geometry.rects.pop();
  data.owner.fragments = 2; assert.equal(check(data), false); data.owner.fragments = 1;
  data.owner.rect.width = 40; assert.equal(check(data), false); data.owner.rect.width = 59;
  data.owner.editable = true; assert.equal(check(data), false); data.owner.editable = false;
  data.owner.scrollLeft = 1; assert.equal(check(data), false); data.owner.scrollLeft = 0;
  data.owner.before.content = '"prefix"'; assert.equal(check(data), false); data.owner.before.content = 'none';
  data.owner.childNodes.push({ nodeType: 3, nodeValue: 'second' }); assert.equal(check(data), false);
  data.owner.childNodes = [{ nodeType: 3, nodeValue: 'x'.repeat(257) }]; assert.equal(check(data), false);
  data.owner.childNodes = [{ nodeType: 3, nodeValue: 'T\u202eext' }]; assert.equal(check(data), false);
  data.owner.childNodes = Array.from({ length: 65 }, () => ({ nodeType: 3, nodeValue: ' ' })); assert.equal(check(data), false);
}));

function inlineFixture(leading = true) {
  const data = fixture();
  Object.assign(data.owner.computed, { display: 'flow-root', paddingLeft: '0px', paddingRight: '0px' });
  data.owner.rect.width = 38;
  Object.assign(data.after, { display: 'inline', content: '"•"', width: 'auto', marginLeft: '4px', marginRight: '4px',
    borderLeftWidth: '0px', borderRightWidth: '0px', boxShadow: 'none' });
  data.geometry.rects[0]!.left = data.owner.rect.left + (leading ? 14 : 0);
  return data;
}
const checkLeading = (data: ReturnType<typeof fixture>, target = data.owner) => pseudoIsSeparated(data.owner as unknown as Element,
  target as unknown as Element, '::before', data.after, data.geometry);

test('leading and trailing literal inline marks work in independent single-line formatting contexts', () => environment(() => {
  for (const display of ['inline', 'inline-block', 'flow-root']) {
    const before = inlineFixture(); before.owner.computed.display = display;
    assert.equal(checkLeading(before), true, display);
    const after = inlineFixture(false); after.owner.computed.display = display;
    assert.equal(check(after), true, display);
  }
  const data = inlineFixture(); data.owner.computed.display = 'block';
  assert.equal(checkLeading(data), false, 'A normal block may share its line with an outside float');
  const parent = new ElementFixture(data.owner.ownerDocument); parent.computed.display = 'flex'; parent.computed.flexWrap = 'wrap'; data.owner.parentElement = parent;
  assert.equal(checkLeading(data), true, 'A blockified inline span inside wrapping metadata flex creates an independent context');
  parent.computed.display = 'grid'; assert.equal(checkLeading(data), true);
  data.owner.parentElement = null; data.owner.computed.whiteSpace = 'nowrap'; assert.equal(checkLeading(data), true);
  data.owner.computed.whiteSpace = 'normal'; data.owner.computed.overflowX = 'hidden'; assert.equal(checkLeading(data), true);
}));

test('inline separation accounts for padding paint, target left ink and leading shadow direction', () => environment(() => {
  const data = inlineFixture();
  data.ink.glyphLeft = 1; data.ink.glyphRight = 7;
  assert.equal(checkLeading(data), true, 'Ordinary bullet ink can exceed its advance while staying inside a sufficient gap');
  data.ink.glyphRight = 10; assert.equal(checkLeading(data), false, 'An overhang towards text consumes the gap');
  data.ink.glyphLeft = 0; data.ink.glyphRight = 6;
  data.ink.targetLeft = 4; assert.equal(checkLeading(data), false, 'Text ink may extend into a leading mark');
  data.ink.targetLeft = 0;
  data.after.boxShadow = 'rgb(0, 0, 0) 1px 1px 1px 0px'; assert.equal(checkLeading(data), false, 'A rightward shadow reaches towards following text');
  data.after.boxShadow = 'rgb(0, 0, 0) -2px 1px 1px 0px'; assert.equal(checkLeading(data), true, 'A leftward shadow stays away from following text');
  data.after.boxShadow = 'none';
  data.after.marginRight = '0px'; data.after.paddingRight = '4px';
  assert.equal(checkLeading(data), true, 'Transparent padding adds real separation from glyph ink');
  for (const [property, value] of [['borderTopWidth', '1px'], ['borderBottomWidth', '1px'], ['borderTopWidth', 'unknown']]) {
    Object.assign(data.after, { [property!]: value });
    assert.equal(checkLeading(data), false, 'Every border side can paint across horizontal padding');
    Object.assign(data.after, { [property!]: '0px' });
  }
  data.after.backgroundColor = 'rgb(255, 255, 255)'; assert.equal(checkLeading(data), false, 'Painted padding cannot count as an empty gap');
  data.after.backgroundColor = 'rgba(0, 0, 0, 0)'; data.after.content = '" • "'; assert.equal(checkLeading(data), false, 'Inline boundary whitespace has context-dependent collapsing');
  data.after.content = '"•"'; data.owner.computed.textEmphasisStyle = 'filled dot';
  assert.equal(checkLeading(data), false, 'Text emphasis has additional ink outside Canvas text metrics');
}));

test('inline flow requires matching measured position, enough width and ordinary line construction', () => environment(() => {
  for (const shift of [-14, 2, 40]) {
    const data = inlineFixture(); data.geometry.rects[0]!.left += shift;
    assert.equal(checkLeading(data), false, `Unexpected leading Range position ${shift}`);
  }
  const after = inlineFixture(false); after.geometry.rects[0]!.left += 14;
  assert.equal(check(after), false, 'A visually reordered trailing mark cannot use LTR flow assumptions');
  for (const change of [{ columnCount: '2' }, { columnWidth: '50px' }, { textAlign: 'justify' }, { direction: 'rtl' }]) {
    const data = inlineFixture(); Object.assign(data.owner.computed, change); assert.equal(checkLeading(data), false);
  }
  const data = inlineFixture(); data.owner.rect.width = 30; assert.equal(checkLeading(data), false);
  data.owner.rect.width = 38; data.geometry.rects[0]!.top += 30; assert.equal(checkLeading(data), false);
  data.geometry.rects[0]!.top -= 30; data.owner.after.content = '"other"'; assert.equal(checkLeading(data), false);
}));

function flexChildrenFixture(leading: boolean) {
  const data = inlineFixture(leading);
  Object.assign(data.owner.computed, { display: 'flex', columnGap: '4px' });
  Object.assign(data.after, { display: 'block', width: '6px' });
  data.owner.rect.width = 56;
  const first = new ElementFixture(data.owner.ownerDocument), second = new ElementFixture(data.owner.ownerDocument);
  first.parentElement = second.parentElement = data.owner;
  first.rect = { left: leading ? 28 : 10, top: 20, width: 10, height: 20 };
  second.rect = { left: first.rect.left + 14, top: 20, width: 24, height: 20 };
  second.childNodes = [{ nodeType: 3, nodeValue: 'Text' }];
  data.owner.childNodes = [first, second];
  data.geometry.rects[0] = { left: second.rect.left, top: 25, width: 24, height: 12 };
  return { ...data, first, second };
}

test('leading and trailing flex marks use observed multiple-child rectangles without reading their content', () => environment(() => {
  for (const leading of [true, false]) {
    const data = flexChildrenFixture(leading);
    const evaluate = () => leading ? checkLeading(data, data.second) : check(data, data.second);
    assert.equal(evaluate(), true);
    data.first.computed.order = '1'; assert.equal(evaluate(), false);
    data.first.computed.order = '0'; data.first.computed.flexGrow = '1'; assert.equal(evaluate(), false);
    data.first.computed.flexGrow = '0'; data.first.computed.position = 'absolute'; assert.equal(evaluate(), false);
    data.first.computed.position = 'static'; data.first.computed.marginRight = '-1px'; assert.equal(evaluate(), false);
    data.first.computed.marginRight = '0px'; data.second.rect.left = data.first.rect.left + 5; assert.equal(evaluate(), false);
    data.second.rect.left = data.first.rect.left + 14; data.owner.rect.width = 45; assert.equal(evaluate(), false);
    data.owner.rect.width = 56; data.geometry.rects[0]!.left += 2; assert.equal(evaluate(), false);
  }
}));
