import test from 'node:test';
import assert from 'node:assert/strict';
import { directTextCount, ElementRegistry, iterateDirectText, iterateMeasuredRuns, iterateMeasurementSteps, measureRuns, measureSnapshot, registerOwnElement, withMeasurementBatch, type TextRunGeometry } from '../../src/runtime/dom';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';
import { contrastRatio, cssColorContrast } from '../../src/core/contrast';

const style = (changes: Record<string, string> = {}) => ({
  color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)',
  backgroundImage: 'none', opacity: '1', filter: 'none', backdropFilter: 'none',
  mixBlendMode: 'normal', backgroundBlendMode: 'normal', textShadow: 'none',
  fontSize: '16px', fontWeight: '400', ...changes,
});

class PaintedElement {
  tagName = 'P'; localName = 'p'; isConnected = true;
  children: PaintedElement[] = [];
  pseudo: Record<string, string> = { content: 'none', display: 'none' };
  constructor(readonly computed: ReturnType<typeof style>, readonly parentElement: PaintedElement | null = null) { parentElement?.children.push(this); }
  matches() { return false; }
  contains(element: PaintedElement) { for (let current: PaintedElement | null = element; current; current = current.parentElement) if (current === this) return true; return false; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 20, height: 20 }; }
}

test('deep paint ancestry yields before a run is emitted and preserves all ancestor effects', () => {
  let target = new PaintedElement(style({ opacity: '.5' }));
  for (let depth = 0; depth < 32; depth++) target = new PaintedElement(style(), target);
  let reads = 0;
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => { reads++; return pseudo ? node.pseudo : node.computed; },
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [target] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  try {
    const registry = new ElementRegistry('cooperative-paint');
    const iterator = iterateMeasurementSteps(target as unknown as Element, registry, DEFAULT_SETTINGS, 1);
    const first = withMeasurementBatch(() => iterator.next());
    assert.equal(first.done, false); assert.equal(first.value, null);
    assert.ok(reads <= 26, `The first chunk must not inspect all 33 ancestors (${reads} style reads)`);
    const rest = [...iterator], runs = rest.filter(step => step !== null);
    assert.ok(rest.filter(step => step === null).length >= 3);
    assert.equal(runs.length, 1); assert.equal(runs[0]!.contrast.status, 'manual');
    assert.ok(runs[0]!.reasons.includes('group-opacity'), 'The last ancestor still affects the measured run');
    assert.deepEqual(runs, measureRuns(target as unknown as Element, registry, DEFAULT_SETTINGS, 1));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('excluded markup containers never read their script or style payload as text candidates', () => {
  let reads = 0;
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Node');
  Object.defineProperty(globalThis, 'Node', { value: { TEXT_NODE: 3 }, configurable: true });
  try {
    for (const tagName of ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD']) {
      const element = {
        tagName, closest: () => null,
        childNodes: [{ nodeType: 3, get nodeValue() { reads++; return 'Excluded source content'; } }],
      } as unknown as Element;
      assert.equal(directTextCount(element), 0);
    }
    assert.equal(reads, 0, 'Excluded payloads must not incur content reads before the visibility check');
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Node', previous); else Reflect.deleteProperty(globalThis, 'Node');
  }
});

test('offscreen pointer-transparent text uses an enclosing opaque background only in undisplaced flow', () => {
  const ordinary = {
    position: 'static', display: 'block', cssFloat: 'none', backgroundColor: 'transparent', backgroundClip: 'border-box',
    transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none', zoom: '1',
    top: 'auto', right: 'auto', bottom: 'auto', left: 'auto', pointerEvents: 'none',
    marginTop: '0px', marginRight: '0px', marginBottom: '0px', marginLeft: '0px',
    borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  };
  const make = (changes: Record<string, string>, parent: PaintedElement | null = null) => Object.assign(new PaintedElement(style({ ...ordinary, ...changes }), parent), {
    namespaceURI: 'http://www.w3.org/1999/xhtml', getClientRects: () => [{ left: 0, top: 0, width: 300, height: 3000 }],
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 300, height: 3000 }),
  });
  const base = make({ position: 'absolute', backgroundColor: '#0F0F0F' });
  const wrapper = make({ position: 'relative', top: '0px', right: '0px', bottom: '0px', left: '0px' }, base);
  const text = make({ color: '#AAAAAA' }, wrapper);
  text.getBoundingClientRect = () => ({ left: 10, top: 2000, width: 50, height: 20 });
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800,
    document: { elementsFromPoint: () => { throw new Error('Offscreen text must not hit-test a different viewport position'); } },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const measure = () => measureRuns(text as unknown as Element, new ElementRegistry('offscreen-flow'), DEFAULT_SETTINGS, 1)[0]!;
  try {
    assert.equal(measure().contrast.status, 'pass', 'Static labels inside an opaque absolute page container are ordinary flow');
    const original = { ...wrapper.computed };
    for (const change of [
      { position: 'absolute' }, { position: 'fixed' }, { position: 'sticky' }, { left: '1px' },
      { transform: 'matrix(1, 0, 0, 1, 10, 0)' }, { translate: '1px' }, { rotate: '1deg' },
      { scale: '2' }, { perspective: '200px' }, { offsetPath: 'path("M 0 0 L 1 1")' },
      { cssFloat: 'left' }, { marginTop: '-1px' }, { zoom: '2' },
    ]) {
      Object.assign(wrapper.computed, original, change);
      const run = measure();
      assert.ok(run.reasons.includes('layered-background'), JSON.stringify(change));
      assert.equal(run.effectiveBackground, null); assert.equal(run.contrast.ratio, null);
    }
    Object.assign(wrapper.computed, original);
    const originalText = { ...text.computed };
    const expectedRatio = measure().contrast.ratio;
    for (const display of ['flex', 'inline-flex', 'grid', 'inline-grid']) {
      Object.assign(wrapper.computed, { display });
      for (const cssFloat of ['left', 'right']) {
        Object.assign(text.computed, { cssFloat });
        const run = measure();
        assert.equal(run.contrast.status, 'pass', `${display} items ignore declared float:${cssFloat}`);
        assert.equal(run.contrast.ratio, expectedRatio);
        assert.equal(run.reasons.includes('layered-background'), false);
      }
    }
    Object.assign(wrapper.computed, { display: 'flex' }); Object.assign(text.computed, { cssFloat: 'left' });
    for (const change of [
      { position: 'absolute' }, { position: 'fixed' }, { position: 'relative', left: '1px' },
      { marginTop: '-1px' }, { transform: 'matrix(1, 0, 0, 1, 10, 0)' }, { scale: '2' },
    ]) {
      Object.assign(text.computed, originalText, { cssFloat: 'left' }, change);
      assert.equal(measure().contrast.ratio, null, `Ignoring float cannot authorize displaced geometry: ${JSON.stringify(change)}`);
    }
    Object.assign(text.computed, originalText, { cssFloat: 'left' });
    for (const display of ['block', 'inline-block', 'contents']) {
      Object.assign(wrapper.computed, { display });
      assert.equal(measure().contrast.ratio, null, `The immediate ${display} parent does not establish a flex/grid item`);
    }
    Object.assign(wrapper.computed, { display: 'flex' });
    for (const tagName of ['DETAILS', 'FIELDSET']) {
      wrapper.tagName = tagName; wrapper.localName = tagName.toLowerCase();
      assert.equal(measure().contrast.ratio, null, `${tagName} can introduce a special anonymous child formatting box`);
    }
    wrapper.tagName = 'P'; wrapper.localName = 'p';
    Object.assign(text, { assignedSlot: {} });
    assert.equal(measure().contrast.ratio, null, 'A slot can establish a different rendered parent from the light-DOM flex host');
    Reflect.deleteProperty(text, 'assignedSlot');
    for (const property of ['shadowRoot', 'openOrClosedShadowRoot']) {
      Object.assign(wrapper, { [property]: {} });
      assert.equal(measure().contrast.ratio, null, `${property} prevents an unproven light-DOM item relationship`);
      Reflect.deleteProperty(wrapper, property);
    }
    Object.assign(text.computed, originalText); Object.assign(wrapper.computed, original);
    base.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 1000 });
    assert.equal(measure().contrast.status, 'manual', 'Overflow below a background box has no proven background');
    base.getBoundingClientRect = () => ({ left: 0, top: 0, width: 300, height: 3000 });
    Object.assign(base.computed, { display: 'contents' });
    assert.equal(measure().contrast.status, 'manual', 'A boxless opaque CSS color cannot establish painted background');
    Object.assign(base.computed, { display: 'block', backgroundClip: 'content-box' });
    assert.equal(measure().contrast.status, 'manual', 'Unsupported background clipping remains conservative');
    Object.assign(base.computed, { backgroundClip: 'border-box' });
    Object.assign(text.computed, { position: 'absolute', backgroundColor: '#0F0F0F' });
    assert.equal(measure().contrast.status, 'pass', 'An owned opaque background is independent of transparent ancestors');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('simple gradient bounds survive layering while unsupported paint stays uncertain', () => {
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const base = new PaintedElement(style());
    const parent = new PaintedElement(style({ backgroundColor: 'transparent', backgroundImage: 'linear-gradient(to top, #f6f6f6 0%, rgba(246,246,246,.5) 60%, rgba(240,240,240,0) 100%)' }), base);
    const child = new PaintedElement(style({ color: '#4C4C4C', backgroundColor: 'transparent' }), parent);
    const measure = () => measureRuns(child as unknown as Element, new ElementRegistry('gradients'), DEFAULT_SETTINGS, 1)[0]!;
    const run = measure();
    assert.equal(run.contrast.AAA.status, 'pass');
    assert.equal(run.contrast.ratioKind, 'minimum');
    assert.ok(run.contrast.ratio! > 7.94);
    assert.equal(run.effectiveBackground, null);
    assert.equal(run.backgroundRange?.min.r, 246);
    parent.computed.backgroundImage += ', linear-gradient(rgba(255,255,255,.5), transparent)';
    parent.computed.backgroundBlendMode = 'normal, normal';
    assert.equal(measure().contrast.status, 'pass');
    parent.computed.backgroundBlendMode = 'normal, multiply';
    assert.equal(measure().contrast.ratio, null);
    parent.computed.backgroundBlendMode = 'normal';
    parent.computed.backgroundImage += ', url("unknown.png")';
    assert.equal(measure().backgroundRange, undefined);
    assert.ok(measure().reasons.includes('background-image-or-gradient'));
    parent.computed.backgroundImage = 'linear-gradient(black, white)';
    assert.equal(measure().contrast.status, 'manual');
    assert.equal(measure().contrast.ratio, 1);
    assert.equal(measure().contrast.reason, 'gradient-contrast-inconclusive');
    child.computed.backgroundColor = 'white';
    assert.equal(measure().backgroundRange, undefined);
    assert.equal(measure().contrast.status, 'pass');
    parent.computed.opacity = '.5';
    assert.equal(measure().contrast.ratio, null);
    let deep = new PaintedElement(style());
    for (let index = 0; index < 301; index++) deep = new PaintedElement(style({ backgroundColor: 'transparent' }), deep);
    const measureDeep = () => measureRuns(deep as unknown as Element, new ElementRegistry('deep-gradient'), DEFAULT_SETTINGS, 1)[0]!;
    assert.equal(measureDeep().contrast.status, 'pass', 'The gradient work limit must not penalize ordinary solid backgrounds');
    deep.computed.backgroundImage = 'linear-gradient(white, #eee)';
    assert.equal(measureDeep().contrast.status, 'manual');
    assert.equal(measureDeep().backgroundRange, undefined);
    for (let index = 0; index < 220; index++) deep = new PaintedElement(style({ backgroundColor: 'transparent' }), deep);
    assert.equal(measureDeep().contrast.status, 'manual', 'Unvisited paint beyond the total ancestry budget is never certified');
    assert.ok(measureDeep().reasons.includes('measurement-complexity-limit'));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('opaque foreground backgrounds hide ancestor images without hiding ancestor group effects', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let paintedStack: PaintedElement[] = [];
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => paintedStack },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    const registry = new ElementRegistry('painting-document');
    const imageAncestor = new PaintedElement(style({ backgroundImage: 'url("background.png")' }));
    const opaque = new PaintedElement(style(), imageAncestor);
    const measure = (element: PaintedElement) => measureRuns(element as unknown as Element, registry, DEFAULT_SETTINGS, 1)[0]!;
    assert.equal(measure(opaque).contrast.status, 'pass');
    assert.ok(!measure(opaque).reasons.includes('background-image-or-gradient'));

    const sharedOpaqueParent = new PaintedElement(style(), imageAncestor);
    for (let sibling = 0; sibling < 2; sibling++) {
      const descendant = new PaintedElement(style({ backgroundColor: 'rgba(0, 0, 0, 0)' }), sharedOpaqueParent);
      assert.equal(measure(descendant).contrast.status, 'pass');
    }
    const ownOverlay = new PaintedElement(style());
    registerOwnElement(ownOverlay as unknown as Element);
    paintedStack = [ownOverlay, opaque, imageAncestor];
    assert.equal(measure(opaque).contrast.status, 'pass');
    paintedStack = [new PaintedElement(style()), opaque, imageAncestor];
    assert.ok(measure(opaque).reasons.includes('overlapping-element'));
    paintedStack = [new PaintedElement(style()), imageAncestor];
    const layered = measure(opaque);
    assert.ok(layered.reasons.includes('layered-background'));
    assert.equal(layered.effectiveBackground, null, 'An unrelated hit surface does not establish the background of pointer-transparent text');
    assert.equal(layered.contrast.ratio, null);
    paintedStack.unshift(new PaintedElement(style({ opacity: '0' })));
    assert.ok(measure(opaque).reasons.includes('layered-background'), 'A nonpainting first hit must not hide an unrelated painted surface below it');
    paintedStack = [imageAncestor];
    assert.equal(measure(opaque).contrast.status, 'pass', 'An ancestor hit still belongs to the known background chain');
    paintedStack = [];

    const offscreen = new PaintedElement(style({ backgroundColor: 'transparent', pointerEvents: 'none' }), sharedOpaqueParent);
    offscreen.getBoundingClientRect = () => ({ left: 0, top: 2000, width: 20, height: 20 });
    assert.ok(measure(offscreen).reasons.includes('layered-background'), 'Offscreen pointer-transparent text cannot establish a separate sibling background');
    assert.equal(measure(offscreen).effectiveBackground, null);
    Object.assign(offscreen.computed, { pointerEvents: 'auto' });
    assert.equal(measure(offscreen).contrast.status, 'pass', 'Ordinary offscreen text retains its known ancestor background');

    const transparent = new PaintedElement(style({ backgroundColor: 'rgba(0, 0, 0, 0)' }), imageAncestor);
    assert.equal(measure(transparent).contrast.status, 'manual');
    assert.ok(measure(transparent).reasons.includes('background-image-or-gradient'));

    opaque.computed.backgroundImage = 'linear-gradient(black, white)';
    assert.equal(measure(opaque).contrast.status, 'manual');
    opaque.computed.backgroundImage = 'none';
    imageAncestor.computed.opacity = '0.5';
    assert.equal(measure(opaque).contrast.status, 'manual');
    assert.ok(measure(opaque).reasons.includes('group-opacity'));

    imageAncestor.computed.opacity = '1';
    opaque.pseudo = { content: '""', display: 'block', backgroundColor: 'black', opacity: '1', visibility: 'visible' };
    assert.equal(measure(opaque).contrast.status, 'manual', 'Empty generated content can still paint an overlay');
    assert.ok(measure(opaque).reasons.includes('pseudo-element'));
    opaque.pseudo.opacity = '0';
    assert.equal(measure(opaque).contrast.status, 'pass');
    opaque.pseudo.opacity = '1'; opaque.pseudo.visibility = 'hidden';
    assert.equal(measure(opaque).contrast.status, 'pass');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('empty generated pseudo-elements only permit contrast when every paint source is absent', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const parent = new PaintedElement(style());
  const element = new PaintedElement(style(), parent);
  const clearPseudo: Record<string, string> = {
    ...style({ backgroundColor: 'rgba(0, 0, 0, 0)' }), content: '""', display: 'block', visibility: 'visible',
    borderImageSource: 'none', boxShadow: 'none', appearance: 'none',
    outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'black',
  };
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) Object.assign(clearPseudo, {
    [`border${side}Style`]: 'none', [`border${side}Width`]: '0px', [`border${side}Color`]: 'black',
  });
  parent.pseudo = { ...clearPseudo };
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const measure = () => measureRuns(element as unknown as Element, new ElementRegistry('empty-pseudo'), DEFAULT_SETTINGS, 1)[0]!;
  try {
    assert.equal(measure().contrast.status, 'pass', 'An empty transparent masthead decoration paints nothing over its descendants');
    parent.pseudo.content = "''";
    assert.equal(measure().contrast.status, 'pass');
    for (const changes of [
      { content: '"visible"' }, { content: 'url("icon.svg")' }, { display: 'list-item' },
      { backgroundColor: 'rgba(0, 0, 0, 0.01)' }, { backgroundColor: 'unknown' },
      { backgroundImage: 'linear-gradient(black, white)' }, { borderImageSource: 'url("border.svg")' },
      { boxShadow: '0 0 0 100px black' }, { textShadow: '1px 1px black' },
      { filter: 'blur(1px)' }, { backdropFilter: 'blur(1px)' }, { appearance: 'auto' },
      { outlineStyle: 'solid', outlineWidth: '1px' },
      ...['Top', 'Right', 'Bottom', 'Left'].map(side => ({ [`border${side}Style`]: 'solid', [`border${side}Width`]: '1px' })),
    ]) {
      parent.pseudo = { ...clearPseudo, ...changes };
      assert.equal(measure().contrast.status, 'manual', JSON.stringify(changes));
      assert.ok(measure().reasons.includes('pseudo-element'));
    }
    for (const missing of ['backgroundColor', 'backgroundImage', 'boxShadow', 'appearance', 'outlineStyle', 'borderTopStyle', 'backdropFilter']) {
      parent.pseudo = { ...clearPseudo };
      delete parent.pseudo[missing];
      assert.equal(measure().contrast.status, 'manual', `Unknown paint property: ${missing}`);
    }
    parent.pseudo = { ...clearPseudo, borderTopStyle: 'solid', borderTopWidth: '1px', borderTopColor: 'transparent' };
    assert.equal(measure().contrast.status, 'pass', 'A fully transparent border adds no painted pixels');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('text-heavy snapshots stop range measurements at the budget and disclose truncation', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let rangeMeasurements = 0;
  const element = new PaintedElement(style({ display: 'block', transform: 'none' }));
  Object.assign(element, {
    childNodes: Array.from({ length: 10_000 }, () => ({ nodeType: 3, nodeValue: 'text' })),
    closest: () => null, getClientRects: () => [{ width: 20, height: 20 }],
  });
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : { ...node.computed, getPropertyValue: () => '' },
    SVGElement: class {}, Node: { TEXT_NODE: 3 }, NodeFilter: { SHOW_ELEMENT: 1 }, innerWidth: 1280, innerHeight: 800,
    window: { innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1 },
    document: {
      createTreeWalker: () => ({ nextNode: () => null }),
      createRange: () => ({ selectNodeContents() {}, getClientRects: () => { rangeMeasurements++; return [{ width: 20, height: 20 }]; } }),
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    const target = element as unknown as Element;
    assert.equal(directTextCount(target, 4), 4);
    assert.equal(rangeMeasurements, 4);
    rangeMeasurements = 0;
    const snapshot = measureSnapshot(target, { windowId: 1, tabId: 10, frameId: 0, documentToken: 'large' }, new ElementRegistry('large'), DEFAULT_SETTINGS);
    assert.equal(snapshot.textRuns.length, 100);
    assert.equal(rangeMeasurements, 101, 'Only one extra run is checked to detect truncation');
    assert.ok(snapshot.reasons.includes('selection-text-limit'));
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('overlap checks and run identity follow actual text nodes across sibling insertion, removal and replacement', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const parent = new PaintedElement(style());
  const element = new PaintedElement(style({ display: 'block' }), parent);
  const neighbour = new PaintedElement(style(), parent);
  const descendant = new PaintedElement(style(), element);
  const ownOverlay = new PaintedElement(style());
  registerOwnElement(ownOverlay as unknown as Element);
  const rect = (top: number) => ({ left: 90, top, width: 12, height: 10 });
  const child = { nodeType: 3, nodeValue: 'DE', rects: [rect(0)] };
  const childNodes = [child];
  Object.assign(element, {
    childNodes, closest: () => null, getClientRects: () => [{ width: 12, height: 44 }],
    getBoundingClientRect: () => ({ left: 90, top: 0, width: 12, height: 44 }),
  });
  let samples: number[] = [];
  let stackAt = (y: number) => y >= 20 ? [neighbour, element, parent] : [element, parent];
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: class {}, Node: { TEXT_NODE: 3 }, innerWidth: 1280, innerHeight: 800,
    document: {
      createRange: () => {
        let selected = child;
        return { selectNodeContents: (node: typeof child) => { selected = node; }, getClientRects: () => selected.rects };
      },
      elementsFromPoint: (_x: number, y: number) => { samples.push(y); return stackAt(y); },
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const registry = new ElementRegistry('text-overlap');
  const measure = () => {
    samples = [];
    return measureRuns(element as unknown as Element, registry, DEFAULT_SETTINGS);
  };
  try {
    assert.equal(measure()[0]!.contrast.status, 'pass', 'The adjacent logo below DE overlaps its layout box, not its text');
    assert.deepEqual(samples, [5]);
    child.rects = [rect(0), rect(20)];
    assert.ok(measure()[0]!.reasons.includes('overlapping-element'), 'An overlay on a later wrapped line still requires review');
    assert.deepEqual(samples, [5, 25]);
    child.rects = [rect(0)];
    childNodes.push({ nodeType: 3, nodeValue: 'other', rects: [rect(20)] });
    const separateRuns = measure();
    assert.equal(separateRuns[0]!.contrast.status, 'pass');
    assert.ok(separateRuns[1]!.reasons.includes('overlapping-element'), 'Only the covered direct text node is affected');
    const covered = childNodes[1]!;
    const originalIds = separateRuns.map(run => run.id);
    childNodes.unshift({ nodeType: 3, nodeValue: 'inserted', rects: [rect(0)] });
    const afterInsert = measure();
    assert.deepEqual(afterInsert.slice(1).map(run => run.id), originalIds, 'Earlier insertion keeps the original runs attached to their nodes');
    assert.equal(afterInsert[2]!.contrast.status, 'manual');
    childNodes.splice(0, 2);
    const afterRemoval = measure();
    assert.equal(afterRemoval[0]!.id, originalIds[1], 'Removing an earlier text node preserves the covered run identity');
    assert.equal(afterRemoval[0]!.contrast.status, 'manual');
    childNodes.unshift(child);
    childNodes.reverse();
    assert.deepEqual(measure().map(run => run.id), [originalIds[1], originalIds[0]], 'DOM order changes the list without reassigning identities');
    childNodes.splice(0, 1, { ...covered });
    assert.notEqual(measure()[0]!.id, originalIds[1], 'A new Text object with identical content and geometry cannot impersonate the removed run');
    const geometry: TextRunGeometry[] = [];
    directTextCount(element as unknown as Element, Infinity, geometry);
    assert.equal(geometry[0]!.identityNode, childNodes[0], 'Audit geometry captures local node identity');
    assert.equal(geometry[0]!.textNode, undefined, 'Identity capture does not opt audits into text excerpts');
    const measured = measureRuns(element as unknown as Element, registry, DEFAULT_SETTINGS, geometry.length, geometry);
    assert.equal(measured[0]!.id, measure()[0]!.id, 'Precomputed audit geometry and fresh inspection share node identities');
    assert.equal(measured.some(run => 'identityNode' in run || 'textNode' in run || 'textExcerpt' in run), false);
    assert.equal(JSON.stringify(measured).includes('"nodeValue"'), false, 'Serialized measurements contain no DOM node references or content');
    childNodes.splice(0, childNodes.length, child);

    stackAt = () => [neighbour, element, parent];
    assert.ok(measure()[0]!.reasons.includes('overlapping-element'), 'A sibling that really covers the glyph area is retained');
    stackAt = () => [ownOverlay, descendant, element, parent];
    assert.equal(measure()[0]!.contrast.status, 'pass', 'Extension-owned overlays and related elements retain their existing treatment');
    child.rects = [rect(900)];
    assert.equal(measure()[0]!.contrast.status, 'pass');
    assert.deepEqual(samples, [], 'Normal offscreen text never probes an unrelated point inside the viewport');

    stackAt = () => [neighbour, element, parent];
    for (const edge of [
      { left: 90, top: 0, width: 3000, height: 10 },
      { left: -2900, top: 0, width: 3000, height: 10 },
      { left: 90, top: -90, width: 12, height: 100 },
      { left: 90, top: 790, width: 12, height: 100 },
    ]) {
      child.rects = [edge];
      assert.ok(measure()[0]!.reasons.includes('overlapping-element'), 'Partly visible text must still check the overlapping paint when its full center is offscreen');
      assert.equal(samples.length, 1);
      assert.ok(samples[0]! >= 0 && samples[0]! < 800, 'The hit-test point is inside the viewport');
      assert.deepEqual(child.rects, [edge], 'Viewport sampling does not alter text fragment bounds');
    }

    element.tagName = 'INPUT';
    Object.assign(element, { getAttribute: () => null });
    stackAt = () => [neighbour, element, parent];
    assert.ok(measure()[0]!.reasons.includes('overlapping-element'), 'Inputs retain their element-box sample');
    assert.deepEqual(samples, [22]);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('viewport fragment omissions are recorded per run without altering full-element geometry', () => {
  const element = new PaintedElement(style({ display: 'block' }));
  const child = { nodeType: 3, nodeValue: 'Visible and offscreen lines' };
  let rects = [{ left: 10, top: 10, width: 100, height: 20 }, { left: 10, top: 1000, width: 100, height: 20 }];
  Object.assign(element, { childNodes: [child], closest: () => null, getClientRects: () => rects });
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: class {}, Node: { TEXT_NODE: 3 }, innerWidth: 1280, innerHeight: 800,
    document: { createRange: () => ({ selectNodeContents() {}, getClientRects: () => rects }), elementsFromPoint: () => [element] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const registry = new ElementRegistry('viewport-fragments');
    const measure = (within?: { width: number; height: number }) => {
      const geometry: TextRunGeometry[] = [];
      const count = directTextCount(element as unknown as Element, 10, geometry, false, within);
      return { geometry, runs: measureRuns(element as unknown as Element, registry, DEFAULT_SETTINGS, count, geometry) };
    };
    const scoped = measure({ width: 1280, height: 800 });
    assert.equal(scoped.geometry[0]!.rects.length, 1); assert.equal(scoped.geometry[0]!.viewportPartial, true);
    assert.equal(scoped.runs[0]!.viewportPartial, true);
    const full = measure();
    assert.equal(full.geometry[0]!.rects.length, 2); assert.equal(full.runs[0]!.viewportPartial, undefined);
    assert.equal(full.runs[0]!.id, scoped.runs[0]!.id, 'Partial geometry does not invent a different Text identity');
    rects[1]!.width = 0;
    assert.equal(measure({ width: 1280, height: 800 }).runs[0]!.viewportPartial, undefined, 'Zero-width helper fragments are not omitted painted text');
    rects = [{ left: 10, top: 1000, width: 100, height: 20 }];
    assert.equal(measure({ width: 1280, height: 800 }).runs.length, 0, 'Entirely offscreen text remains outside the viewport audit');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('incremental text collection and painting preserve synchronous geometry, identities and viewport filtering', () => {
  const element = new PaintedElement(style({ display: 'block' }));
  const children = Array.from({ length: 300 }, (_, index) => ({ nodeType: 3, nodeValue: 'Synthetic text', rects: [
    { left: 10, top: index % 2 ? 1000 : 10, width: 100, height: 20 },
  ] }));
  Object.assign(element, { childNodes: children, closest: () => null, getClientRects: () => children[0]!.rects });
  let ranges = 0;
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: class {}, Node: { TEXT_NODE: 3 }, innerWidth: 1280, innerHeight: 800,
    document: { createRange: () => { let child: typeof children[number]; ranges++; return { selectNodeContents(node: typeof child) { child = node; }, getClientRects: () => child.rects }; }, elementsFromPoint: () => [element] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    const target = element as unknown as Element, registry = new ElementRegistry('incremental-text');
    const partial = iterateDirectText(target, 1000);
    assert.equal(ranges, 0, 'Creating the iterator does not eagerly inspect the element');
    assert.equal(partial.next().done, false); assert.equal(ranges, 1);
    partial.return(undefined); assert.equal(ranges, 1, 'Closing an incomplete collection performs no remaining range reads');
    for (const within of [undefined, { width: 1280, height: 800 }]) {
      const syncGeometry: TextRunGeometry[] = [];
      const count = directTextCount(target, 200, syncGeometry, false, within);
      const syncRuns = withMeasurementBatch(() => measureRuns(target, registry, DEFAULT_SETTINGS, count, syncGeometry));
      const geometry: TextRunGeometry[] = [];
      for (const item of iterateDirectText(target, 200, false, within)) if (item && item !== 'control') geometry.push(item);
      assert.deepEqual(geometry, syncGeometry);
      const runs = [], iterator = iterateMeasuredRuns(target, registry, DEFAULT_SETTINGS, count, geometry);
      for (;;) {
        const item = withMeasurementBatch(() => iterator.next());
        if (item.done) break;
        runs.push(item.value);
      }
      assert.deepEqual(runs, syncRuns, 'Yield boundaries do not change measurement results or stable Text identities');
      assert.equal(runs.length, within ? 150 : 200);
    }
    Object.assign(element, { childNodes: Array.from({ length: 1000 }, () => ({ nodeType: 8 })) });
    const blank = iterateDirectText(target);
    for (let i = 0; i < 10; i++) assert.deepEqual(blank.next(), { value: null, done: false });
    blank.return(undefined);
    const growingChildren = Array.from({ length: 10 }, () => ({ nodeType: 8 }));
    Object.assign(element, { childNodes: growingChildren });
    const growing = iterateDirectText(target);
    for (let i = 0; i < 10; i++) {
      assert.deepEqual(growing.next(), { value: null, done: false });
      growingChildren.push({ nodeType: 8 });
    }
    assert.equal(growing.next().done, true, 'Appending nontext children during each pause cannot keep one element collection alive indefinitely');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('text-fragment overlap sampling is bounded and reports incomplete geometry without affecting font-size checks', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const element = new PaintedElement(style({ display: 'block' }));
  const childNodes = Array.from({ length: 10_000 }, () => ({ nodeType: 3, nodeValue: 'text' }));
  Object.assign(element, { childNodes, closest: () => null, getClientRects: () => [{ width: 20, height: 20 }] });
  let rangeReads = 0, fragmentReads = 0, samples = 0;
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: class {}, Node: { TEXT_NODE: 3 }, innerWidth: 1280, innerHeight: 800,
    document: {
      createRange: () => ({
        selectNodeContents() {},
        getClientRects: () => {
          rangeReads++;
          return (function* () {
            for (let index = 0; index < 10_000; index++) {
              fragmentReads++;
              yield { left: 0, top: 0, width: 20, height: 20 };
            }
          })();
        },
      }),
      elementsFromPoint: () => { samples++; return [element]; },
    },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  try {
    const target = element as unknown as Element;
    const geometry: TextRunGeometry[] = [];
    const count = directTextCount(target, 1, geometry);
    assert.equal(count, 1);
    assert.equal(rangeReads, 1);
    assert.equal(fragmentReads, 33, 'Only one extra fragment is read to establish the sampling limit');
    assert.equal(geometry[0]!.rects.length, 32);
    const [run] = measureRuns(target, new ElementRegistry('bounded-fragments'), DEFAULT_SETTINGS, count, geometry);
    assert.equal(rangeReads, 1, 'Captured geometry is reused without repeating range measurements');
    assert.equal(samples, 32);
    assert.ok(run!.reasons.includes('overlap-sampling-limit'));
    assert.equal(run!.contrast.status, 'manual');
    assert.equal(run!.fontSize.status, 'pass');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('transparent icon padding is ignored only when a bounded subtree proves no paint over the text', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const clearStyle = style({
    backgroundColor: 'transparent', display: 'block', content: 'normal',
    borderImageSource: 'none', boxShadow: 'none', appearance: 'none',
    outlineStyle: 'none', outlineWidth: '3px', outlineColor: 'black',
    overflowX: 'visible', overflowY: 'visible',
  });
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) Object.assign(clearStyle, {
    [`border${side}Style`]: 'none', [`border${side}Width`]: '0px', [`border${side}Color`]: 'black',
  });
  const clearElement = (parent: PaintedElement | null = null) => Object.assign(new PaintedElement({ ...clearStyle }, parent), {
    namespaceURI: 'http://www.w3.org/1999/xhtml', childNodes: [] as { nodeType: number; length?: number; nodeValue?: unknown }[], shadowRoot: null as object | null,
  });
  class SvgElement extends PaintedElement {
    override tagName = 'svg'; override localName = 'svg';
  }
  const target = new PaintedElement(style());
  const wrapper = clearElement();
  const inner = clearElement(wrapper);
  const svg = new SvgElement(style({ ...clearStyle, overflowX: 'hidden', overflowY: 'hidden' }), inner);
  let svgLeft = 0;
  let unrelatedTextRects = [{}];
  Object.assign(svg, { getBoundingClientRect: () => ({ left: svgLeft, top: 0, width: 80, height: 20 }) });
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    SVGElement: SvgElement, Node: { TEXT_NODE: 3 }, innerWidth: 1280, innerHeight: 800,
    document: { elementsFromPoint: () => [wrapper, target], createRange: () => ({ selectNodeContents() {}, getClientRects: () => unrelatedTextRects }) },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const geometry = [{ rects: [{ left: 90, top: 0, width: 12, height: 10 }], limited: false }];
  const measure = () => measureRuns(target as unknown as Element, new ElementRegistry('padded-icon'), DEFAULT_SETTINGS, 1, geometry)[0]!;
  try {
    assert.equal(measure().contrast.status, 'pass', 'Transparent padding around a clipped SVG viewport paints nothing over the nearby label');
    svgLeft = 85;
    assert.ok(measure().reasons.includes('overlapping-element'), 'SVG paint intersecting any part of the text rect remains manual even with pointer-events:none');
    svgLeft = 0;
    Object.assign(svg.computed, { overflowX: 'visible' });
    assert.ok(measure().reasons.includes('overlapping-element'), 'Unclipped SVG descendants or strokes can escape their viewport');
    Object.assign(svg.computed, { overflowX: 'clip', overflowClipMargin: '20px' });
    assert.ok(measure().reasons.includes('overlapping-element'), 'Clip margins can allow SVG paint beyond the viewport');
    Object.assign(svg.computed, { overflowX: 'hidden' });
    for (const changes of [
      { backgroundColor: 'black' }, { boxShadow: '20px 0 black' }, { filter: 'blur(20px)' },
      { backdropFilter: 'blur(20px)' }, { outlineStyle: 'solid' }, { textShadow: '20px 0 black' },
    ]) {
      Object.assign(inner.computed, clearStyle, changes);
      assert.ok(measure().reasons.includes('overlapping-element'), `Potential descendant paint outside its box: ${JSON.stringify(changes)}`);
    }
    Object.assign(inner.computed, clearStyle);
    inner.pseudo = { content: '""', display: 'block', backgroundColor: 'black', opacity: '1', visibility: 'visible' };
    assert.ok(measure().reasons.includes('overlapping-element'), 'Positioned pseudo paint cannot be ruled out from its parent rectangle');
    inner.pseudo = { content: 'none', display: 'none' };
    inner.childNodes = [{ nodeType: 3, get nodeValue(): never { throw new Error('Do not read unrelated text contents'); } }];
    assert.ok(measure().reasons.includes('overlapping-element'), 'Text presence stays conservative without reading the text');
    unrelatedTextRects = [];
    assert.equal(measure().contrast.status, 'pass', 'Text nodes with no rendered rectangles do not paint inside a transparent wrapper');
    unrelatedTextRects = [{ width: 0, height: 0 }];
    inner.childNodes[0]!.length = 0;
    assert.equal(measure().contrast.status, 'pass', 'An empty node cannot paint, even when Firefox 142 supplies a zero-size rectangle');
    inner.childNodes[0]!.length = 1;
    assert.ok(measure().reasons.includes('overlapping-element'), 'A zero-size range alone does not prove absence of glyph ink');
    unrelatedTextRects = [{ width: 0, height: 10 }];
    assert.ok(measure().reasons.includes('overlapping-element'), 'A zero-advance rendered character can still have glyph ink');
    inner.childNodes = [];
    inner.shadowRoot = {};
    assert.ok(measure().reasons.includes('overlapping-element'));
    inner.shadowRoot = null;
    Object.assign(inner, { openOrClosedShadowRoot: {} });
    assert.ok(measure().reasons.includes('overlapping-element'), 'Firefox extension-only closed shadow detection remains conservative');
    Object.assign(inner, { openOrClosedShadowRoot: null });
    inner.tagName = 'IMG';
    assert.ok(measure().reasons.includes('overlapping-element'));
    inner.tagName = 'P';
    assert.equal(measure().contrast.status, 'pass');

    wrapper.children = Array.from({ length: 65 }, () => clearElement());
    const limited = measure();
    assert.equal(limited.contrast.status, 'manual');
    assert.ok(limited.reasons.includes('overlap-sampling-limit'), 'Candidate descendants share a bounded per-run inspection budget');
    wrapper.children = [inner];
    wrapper.childNodes = Array.from({ length: 10_000 }, () => ({ nodeType: 8 }));
    assert.ok(measure().reasons.includes('overlap-sampling-limit'), 'Comment-heavy wrappers cannot bypass the traversal budget');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('fully clipped accessible labels and their descendants are excluded without discarding visible small or offscreen text', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let rangeMeasurements = 0;
  const replacements = {
    getComputedStyle: (element: PaintedElement) => element.computed,
    Node: { TEXT_NODE: 3 },
    document: { createRange: () => ({ selectNodeContents() {}, getClientRects: () => {
      rangeMeasurements++;
      return [{ width: 54, height: 17, top: 4000, left: 100 }];
    } }) },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const element = (changes: Record<string, string>, parent: PaintedElement | null = null) => Object.assign(
    new PaintedElement(style({ display: 'block', visibility: 'visible', position: 'absolute', clipPath: 'none', clip: 'auto', ...changes }), parent),
    { childNodes: [{ nodeType: 3, nodeValue: 'Accessible label' }], closest: () => null, getClientRects: () => [{ width: 1, height: 1, top: 4000, left: 100 }] },
  );
  const count = (target: PaintedElement) => directTextCount(target as unknown as Element);
  try {
    for (const clipPath of ['inset(50%)', 'inset(60% 0%)', 'inset(0% 50%)', 'inset(25% 0% 75%)', 'inset(0% 20% 0% 80%)', 'inset(50% 1px)', 'inset(50% round 2px)', 'inset(50%) padding-box']) {
      assert.equal(count(element({ clipPath })), 0, clipPath);
      assert.equal(count(element({}, element({ clipPath }))), 0, `Clipped ancestor: ${clipPath}`);
    }
    for (const clip of ['rect(0px, 0px, 0px, 0px)', 'rect(0px, 20px, 0px, 0px)', 'rect(auto, 10px, auto, 10px)', 'rect(20px 40px 10px 0px)']) {
      assert.equal(count(element({ clip })), 0, clip);
      assert.equal(count(element({}, element({ clip, position: 'fixed' }))), 0, `Clipped ancestor: ${clip}`);
    }
    assert.equal(rangeMeasurements, 0, 'Empty clips are rejected before reading misleading positive text rectangles');

    for (const clipPath of ['none', 'inset(49.9%)', 'inset(25% 50% 25% 49%)', 'inset(10px)', 'inset(calc(50% - 1px))', 'circle(50%)', 'url("#external-clip")']) {
      assert.equal(count(element({ clipPath })), 1, `Preserve positive or unproven clips: ${clipPath}`);
    }
    assert.equal(count(element({ clip: 'rect(0px, 20px, 20px, 0px)' })), 1, 'A partially clipped text box still counts');
    assert.equal(count(element({ display: 'contents', clipPath: 'inset(50%)' })), 1, 'Boxless elements do not clip their direct text');
    assert.equal(count(element({}, element({ display: 'contents', clipPath: 'inset(50%)' }))), 1, 'Boxless ancestors do not clip their descendants');
    for (const position of ['static', 'relative', 'sticky']) {
      assert.equal(count(element({ clip: 'rect(0px, 0px, 0px, 0px)', position })), 1, `Legacy clip does not apply to ${position} positioning`);
    }
    assert.equal(count(element({})), 1, 'One-pixel boxes and text outside the viewport are not visibility heuristics');
    const restored = element({ clipPath: 'inset(50%)' });
    assert.equal(count(restored), 0);
    Object.assign(restored.computed, { clipPath: 'none' });
    assert.equal(count(restored), 1, 'New measurements recognize labels revealed by style changes');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('shown input placeholders use their own color, opacity and font without reading form text', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  let shown = true, emptyPlaceholder = false, disabled = false, type = 'search';
  const placeholder = style({ color: 'rgba(160, 160, 160, 0.8)', backgroundColor: 'transparent', opacity: '0.5', fontSize: '24px', fontWeight: '700', fontFamily: 'Georgia, serif', lineHeight: 'normal', display: 'inline', visibility: 'visible' });
  const input = Object.assign(new PaintedElement(style({ color: 'white', backgroundColor: 'black', fontFamily: 'Arial, sans-serif', lineHeight: '24px', display: 'inline-block', visibility: 'visible' })), {
    tagName: 'INPUT', localName: 'input', closest: () => null,
    getClientRects: () => [{ width: 200, height: 40 }],
    matches: (selector: string) => selector === ':placeholder-shown' ? shown : selector === '[placeholder=""]' ? emptyPlaceholder : selector === ':disabled' && disabled,
    getAttribute: (name: string) => { assert.equal(name, 'type', 'No form-content attributes may be read'); return type; },
  });
  for (const property of ['value', 'defaultValue', 'placeholder', 'textContent', 'childNodes']) {
    Object.defineProperty(input, property, { get() { throw new Error(`Private input property read: ${property}`); } });
  }
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo === '::placeholder' ? placeholder : pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const target = input as unknown as Element;
  const registry = new ElementRegistry('placeholder-document');
  const measure = () => measureRuns(target, registry, DEFAULT_SETTINGS);
  try {
    const run = measure()[0]!;
    assert.equal(run.textSource, 'placeholder');
    assert.deepEqual(run.foreground.rgba, { r: 160, g: 160, b: 160, a: 0.4 });
    assert.equal(run.fontSizeCssPx, 24);
    assert.equal(run.fontWeight, 700);
    assert.equal(run.fontFamily, 'Georgia, serif');
    assert.equal(run.lineHeight, 'normal', 'Computed normal is not replaced with an invented pixel height');
    assert.equal(run.contrast.category, 'large');
    assert.equal(run.contrast.ratio, contrastRatio(run.foreground.rgba!, { r: 0, g: 0, b: 0, a: 1 }));
    assert.equal(run.contrast.status, 'fail', 'Placeholder opacity changes the contrast even though the input color is white');
    assert.deepEqual(run.reasons, []);

    Object.assign(placeholder, { color: 'rgb(170, 170, 170)', opacity: '1', fontSize: '16px', fontWeight: '400' });
    assert.equal(measure()[0]!.contrast.status, 'pass');
    assert.equal(measure()[0]!.contrast.category, 'normal');
    disabled = true;
    assert.equal(measure()[0]!.contrast.status, 'not-applicable');
    assert.equal(measure()[0]!.fontSize.status, 'not-applicable');
    disabled = false;

    shown = false; // Populated inputs and empty inputs without an active hint are indistinguishable by design.
    const unavailable = measure()[0]!;
    assert.equal(unavailable.textSource, undefined);
    assert.equal(unavailable.contrast.status, 'manual');
    assert.ok(unavailable.reasons.includes('control-text-availability-unknown'));
    shown = true;
    assert.equal(measure()[0]!.contrast.status, 'pass', 'Clearing an input allows the active placeholder to be measured again');

    emptyPlaceholder = true;
    assert.equal(directTextCount(target), 0, 'Browsers match :placeholder-shown even when the hint is exactly empty');
    assert.deepEqual(measureRuns(target, registry, DEFAULT_SETTINGS, 1), []);
    emptyPlaceholder = false;

    for (const changes of [{ opacity: '0' }, { display: 'none' }, { visibility: 'hidden' }, { visibility: 'collapse' }]) {
      Object.assign(placeholder, { opacity: '1', display: 'inline', visibility: 'visible' }, changes);
      assert.equal(directTextCount(target), 0);
      assert.deepEqual(measureRuns(target, registry, DEFAULT_SETTINGS, 1), []);
    }
    Object.assign(placeholder, { opacity: '1', display: 'inline', visibility: 'visible' });
    Object.assign(input.computed, { display: 'none' });
    assert.deepEqual(measure(), []);
    Object.assign(input.computed, { display: 'inline-block' });
    for (type of ['checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden']) assert.deepEqual(measure(), []);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('placeholder contrast retains uncertainty for unsupported paint and ancestor effects', () => {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const placeholder = style({ color: 'rgb(170, 170, 170)', backgroundColor: 'transparent', display: 'inline', visibility: 'visible' });
  const parent = new PaintedElement(style({ backgroundColor: 'black' }));
  const input = Object.assign(new PaintedElement(style({ backgroundColor: 'transparent' }), parent), {
    tagName: 'INPUT', localName: 'input', matches: (selector: string) => selector === ':placeholder-shown',
    getAttribute: (name: string) => name === 'type' ? 'text' : null,
  });
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo === '::placeholder' ? placeholder : pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  for (const [key, value] of Object.entries(replacements)) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const measure = () => measureRuns(input as unknown as Element, new ElementRegistry('placeholder-effects'), DEFAULT_SETTINGS, 1)[0]!;
  try {
    assert.equal(measure().contrast.status, 'pass');
    for (const [property, value, reason] of [
      ['backgroundColor', 'white', 'pseudo-element'],
      ['backgroundImage', 'linear-gradient(black, white)', 'pseudo-element'],
      ['filter', 'brightness(0.5)', 'filter'],
      ['backdropFilter', 'blur(1px)', 'filter'],
      ['mixBlendMode', 'multiply', 'blend-mode'],
      ['textShadow', '1px 1px black', 'text-shadow'],
      ['opacity', '', 'group-opacity'],
      ['color', 'color(display-p3 1 0 0)', 'unsupported-color'],
    ]) {
      const old = placeholder[property as keyof typeof placeholder];
      Object.assign(placeholder, { [property]: value });
      const run = measure();
      assert.equal(run.contrast.status, 'manual', property);
      assert.ok(run.reasons.includes(reason), `${property}: ${reason}`);
      Object.assign(placeholder, { [property]: old });
    }
    parent.computed.opacity = '0.5';
    assert.ok(measure().reasons.includes('group-opacity'));
    assert.equal(measure().contrast.status, 'manual', 'Placeholder opacity never cancels ancestor group opacity');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('editable and semantic input subtrees are excluded before reading any text', () => {
  const excluded = (ancestor: string, designMode = 'off', isContentEditable = false) => ({
    tagName: 'SPAN', ownerDocument: { designMode }, isContentEditable,
    closest: (selector: string) => selector.includes(ancestor) ? {} : null,
    get childNodes(): never { throw new Error('Private editor text must not be read'); },
  }) as unknown as Element;
  // Case-insensitive enumerated selectors also protect nested false islands.
  for (const ancestor of ['[contenteditable="true" i]', '[contenteditable="plaintext-only" i]', '[contenteditable=""]', 'textarea', '[role~="textbox" i]', '[role~="combobox" i]', '[role~="searchbox" i]']) {
    assert.equal(directTextCount(excluded(ancestor)), 0, ancestor);
  }
  assert.equal(directTextCount(excluded('unused', 'off', true)), 0, 'Native inherited editing state is checked before content');
  assert.equal(directTextCount(excluded('unused', 'on')), 0);
  assert.equal(directTextCount(excluded('unused', 'ON')), 0);
});

test('a standalone contenteditable=false declaration remains ordinary measured text', () => {
  let textReads = 0;
  const element = Object.assign(new PaintedElement(style({ display: 'block' })), {
    childNodes: [{ nodeType: 3, get nodeValue() { textReads++; return 'Ordinary non-editable text'; } }],
    isContentEditable: false, ownerDocument: { designMode: 'off' },
    closest: (selector: string) => selector.includes('[contenteditable]') || selector.includes('[contenteditable="false"]') ? {} : null,
    getClientRects: () => [{ left: 0, top: 0, width: 20, height: 20 }],
  });
  const replacements = {
    getComputedStyle: (node: PaintedElement, pseudo?: string) => pseudo ? node.pseudo : node.computed,
    Node: { TEXT_NODE: 3 },
    document: { createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ left: 0, top: 0, width: 20, height: 20 }] }) },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    assert.equal(directTextCount(element as unknown as Element), 1);
    assert.equal(textReads, 1);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('boxless declared backgrounds never replace the painted ancestor background', () => {
  const base = new PaintedElement(style({ backgroundColor: 'white' }));
  const boxless = new PaintedElement(style({ display: 'contents', color: 'white', backgroundColor: 'black', backgroundImage: 'linear-gradient(black, black)' }), base);
  const child = new PaintedElement(style({ color: 'white', backgroundColor: 'transparent' }), boxless);
  const replacements = {
    getComputedStyle: (element: PaintedElement, pseudo?: string) => pseudo ? element.pseudo : element.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try {
    for (const target of [boxless, child]) {
      const run = measureRuns(target as unknown as Element, new ElementRegistry('boxless'), DEFAULT_SETTINGS, 1)[0]!;
      assert.equal(run.contrast.ratio, 1, 'White text is on the white ancestor, regardless of the boxless declaration');
      assert.equal(run.contrast.status, 'fail');
      assert.equal(run.ownOpaqueBackground, false, 'A background-color correction cannot paint a boxless element');
      assert.equal(run.backgroundRange, undefined);
    }
    boxless.computed.backgroundImage = 'none';
    assert.equal(measureRuns(boxless as unknown as Element, new ElementRegistry('boxless-solid'), DEFAULT_SETTINGS, 1)[0]!.contrast.ratio, 1);
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test('a separate glyph fill supplies exact contrast while unknown fill and text outlines remain manual', () => {
  let fill = 'rgb(119, 119, 119)';
  let stroke = '0px';
  const element = new PaintedElement(style());
  Object.assign(element.computed, { getPropertyValue: (property: string) => property === '-webkit-text-fill-color' ? fill : property === '-webkit-text-stroke-width' ? stroke : '' });
  const replacements = {
    getComputedStyle: (target: PaintedElement, pseudo?: string) => pseudo ? target.pseudo : target.computed,
    SVGElement: class {}, innerWidth: 1280, innerHeight: 800, document: { elementsFromPoint: () => [] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  const measure = () => measureRuns(element as unknown as Element, new ElementRegistry('filled'), DEFAULT_SETTINGS, 1)[0]!;
  try {
    assert.equal(measure().contrast.ratio, contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }));
    assert.equal(measure().contrast.status, 'fail', 'A black CSS color cannot hide the lower-contrast gray glyph fill');
    assert.equal(measure().foregroundSource, 'text-fill');
    assert.equal(measure().textFillPresent, true);
    fill = 'rgb(0 0 0 / .5)';
    assert.equal(measure().contrast.ratio, contrastRatio({ r: 0, g: 0, b: 0, a: .5 }, { r: 255, g: 255, b: 255, a: 1 }));
    fill = 'color(display-p3 .5 .5 .5)';
    assert.equal(measure().contrast.status, 'manual');
    assert.equal(measure().foreground.rgba, null);
    fill = 'rgb(119, 119, 119)';
    for (stroke of ['1px', '0.1px']) {
      const run = measure();
      assert.equal(run.contrast.status, 'manual');
      assert.equal(run.contrast.ratio, null);
      assert.ok(run.reasons.includes('text-stroke'));
      assert.equal(cssColorContrast(run)?.ratio, contrastRatio({ r: 119, g: 119, b: 119, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }));
    }
    stroke = '0px';
    for (fill of ['rgb(0, 0, 0)', '#000', 'currentcolor', '']) {
      assert.equal(measure().contrast.ratio, 21, 'The ordinary inherited text color remains supported');
      assert.equal(measure().foregroundSource, undefined);
      assert.equal(measure().textFillPresent, fill ? true : undefined, 'Even a matching resolved fill needs an explicit reset in foreground corrections');
    }
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
