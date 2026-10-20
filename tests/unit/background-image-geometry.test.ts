import test from 'node:test';
import assert from 'node:assert/strict';
import { coveringOpaqueGradient, coveringSolidBackground } from '../../src/runtime/background-image-geometry';
import { ElementRegistry, measureRuns } from '../../src/runtime/dom';
import { DEFAULT_SETTINGS } from '../../src/runtime/settings';

const baseStyle = {
  display: 'block', transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none', zoom: '1', transformStyle: 'flat',
  clipPath: 'none', clip: 'auto', maskImage: 'none', filter: 'none', backdropFilter: 'none', contain: 'none', contentVisibility: 'visible',
  borderImageSource: 'none', outlineStyle: 'none', outlineWidth: '0px', outlineColor: 'rgb(0, 0, 0)', fontStyle: 'normal', textShadow: 'none', textDecorationLine: 'none', textEmphasisStyle: 'none',
  backgroundImage: 'linear-gradient(0deg, rgb(255, 255, 255), rgb(255, 255, 255)), linear-gradient(rgb(136, 140, 140), rgb(136, 140, 140))',
  backgroundSize: 'auto, auto', backgroundPosition: '0% 0%, 0% 0%', backgroundAttachment: 'scroll, scroll', backgroundBlendMode: 'normal, normal',
  backgroundRepeat: 'repeat, repeat', backgroundOrigin: 'padding-box, padding-box', backgroundClip: 'border-box, border-box',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  borderTopLeftRadius: '8px', borderTopRightRadius: '8px', borderBottomRightRadius: '8px', borderBottomLeftRadius: '8px',
  boxShadow: 'rgb(33, 98, 161) 0px 0px 0px 2px inset',
};
class Box {
  namespaceURI = 'http://www.w3.org/1999/xhtml'; scrollLeft = 0; scrollTop = 0;
  ownerDocument = { defaultView: { getComputedStyle: (node: Box) => ({ ...node.computed, getPropertyValue: (property: string) => property === '-webkit-text-stroke-width' ? node.computed.textStroke ?? '0px' : property === 'corner-shape' ? node.computed.cornerShape ?? '' : '' }), devicePixelRatio: 1 } };
  constructor(readonly computed: Record<string, string> = { ...baseStyle }, readonly parentElement: Box | null = null) {}
  contains(node: Box): boolean { return node === this || Boolean(node.parentElement && this.contains(node.parentElement)); }
  getBoundingClientRect() { return { left: 0, top: 0, width: 73, height: 107 }; }
  getClientRects() { return [this.getBoundingClientRect()]; }
}
const rect = { left: 4, top: 60, width: 50, height: 12 };
const white = { r: 255, g: 255, b: 255, a: 1 };
function fixture(changes: Record<string, string> = {}) {
  const owner = new Box({ ...baseStyle, ...changes });
  const target = new Box({ ...baseStyle, boxShadow: 'none' }, owner);
  const geometry = [{ rects: [{ ...rect }], limited: false }];
  const check = () => coveringSolidBackground(owner as unknown as Element, target as unknown as Element, owner.computed as unknown as CSSStyleDeclaration, geometry);
  const checkGradient = () => coveringOpaqueGradient(owner as unknown as Element, target as unknown as Element, owner.computed as unknown as CSSStyleDeclaration, geometry);
  return { owner, target, geometry, check, checkGradient };
}

test('a fully covered opaque colored gradient preserves its stops without including hidden lower layers', () => {
  const context = fixture({ backgroundImage: 'linear-gradient(rgb(247, 232, 82), rgb(250, 216, 110)), url("hidden.png")' });
  assert.deepEqual(context.checkGradient(), [{ r: 247, g: 232, b: 82, a: 1 }, { r: 250, g: 216, b: 110, a: 1 }]);
  assert.equal(context.check(), null, 'A changing gradient remains a range rather than an invented solid color');
  context.geometry[0]!.rects.push({ ...rect, left: 72 });
  assert.equal(context.checkGradient(), null, 'Every text fragment must remain covered');
  const changes: Record<string, string>[] = [
    { backgroundSize: '50% 50%' }, { backgroundPosition: '10px 0px' }, { backgroundClip: 'text' },
    { backgroundImage: 'linear-gradient(white, rgba(250, 232, 110, .99))' },
    { backgroundImage: 'linear-gradient(oklch(.8 .1 80), oklch(.9 .1 80))' },
    { backgroundImage: 'linear-gradient(in oklab, white, black)' },
  ];
  for (const change of changes) {
    const item = fixture({ backgroundImage: 'linear-gradient(rgb(247, 232, 82), rgb(250, 216, 110))', ...change });
    assert.equal(item.checkGradient(), null, JSON.stringify(change));
  }
});

test('a covering uniform opaque top image hides lower color and gradient layers away from inset outlines', () => {
  const context = fixture();
  assert.deepEqual(context.check(), white);
  context.owner.computed.cornerShape = 'superellipse(1)';
  assert.deepEqual(context.check(), white, 'Computed superellipse(1) is the ordinary round corner');
  context.owner.computed.backgroundImage = 'linear-gradient(white, white), url("unavailable-image.png")';
  assert.deepEqual(context.check(), white, 'The opaque first image occludes even unsupported lower image sources');
  context.geometry[0]!.rects[0]!.left = 2;
  assert.equal(context.check(), null, 'The selected inset outline still paints near the edge');
});

test('partial images, other blending, nonuniform gradients and unknown positioning keep the conservative range', () => {
  const cases: Record<string, string>[] = [
    { backgroundImage: 'linear-gradient(white, black)' }, { backgroundImage: 'linear-gradient(rgba(255, 255, 255, .5), rgba(255, 255, 255, .5))' },
    { backgroundImage: 'url("image.png"), linear-gradient(white, white)' }, { backgroundSize: '50% 50%' }, { backgroundPosition: '10px 0px' },
    { backgroundAttachment: 'fixed' }, { backgroundBlendMode: 'multiply' }, { backgroundRepeat: 'space' }, { backgroundClip: 'text' },
    { backgroundOrigin: 'unknown-box' }, { display: 'inline' }, { boxShadow: 'rgb(0, 0, 0) 0px 0px 2px 2px inset' },
    { boxShadow: 'rgb(0, 0, 0) 0px 0px 0px 2px' }, { borderTopLeftRadius: '50%' },
    { borderImageSource: 'linear-gradient(red, red)' }, { outlineStyle: 'solid', outlineWidth: '10px' },
  ];
  for (const changes of cases) assert.equal(fixture(changes).check(), null, JSON.stringify(changes));
});

test('coverage includes every fragment and excludes rounded corners, unknown geometry and scrolled surfaces', () => {
  const corner = fixture(); corner.geometry[0]!.rects = [{ left: 2, top: 2, width: 10, height: 10 }]; assert.equal(corner.check(), null);
  const fragments = fixture(); fragments.geometry[0]!.rects.push({ ...rect, left: 72 }); assert.equal(fragments.check(), null);
  const limited = fixture(); limited.geometry[0]!.limited = true; assert.equal(limited.check(), null);
  const missing = fixture(); missing.geometry.length = 0; assert.equal(missing.check(), null);
  const multiple = fixture(); multiple.owner.getClientRects = () => [multiple.owner.getBoundingClientRect(), multiple.owner.getBoundingClientRect()]; assert.equal(multiple.check(), null);
  const scrolled = fixture(); scrolled.owner.scrollLeft = 1; assert.equal(scrolled.check(), null);
  for (const change of [{ transform: 'matrix(2, 0, 0, 2, 0, 0)' }, { clipPath: 'inset(2px)' }, { maskImage: 'linear-gradient(black, transparent)' }, { filter: 'blur(1px)' }]) {
    const context = fixture(); Object.assign(context.target.computed, change); assert.equal(context.check(), null, JSON.stringify(change));
  }
  const foregroundShadow = fixture(); foregroundShadow.target.computed.boxShadow = 'rgb(0, 0, 0) 0px 0px 0px 8px inset'; assert.equal(foregroundShadow.check(), null);
  for (const change of [{ cornerShape: 'bevel' }, { cornerShape: 'notch' }, { fontStyle: 'italic' }, { textStroke: '2px' }, { textShadow: '1px 1px black' }, { textDecorationLine: 'line-through' }, { textEmphasisStyle: 'circle' }, { borderImageSource: 'url("border.png")' }, { outlineStyle: 'solid', outlineWidth: '20px' }]) {
    const context = fixture(); Object.assign(context.target.computed, change); assert.equal(context.check(), null, JSON.stringify(change));
  }
});

test('text near a rounded inset outline is accepted only inside every elliptical corner', () => {
  const context = fixture({ borderTopLeftRadius: '7px', borderTopRightRadius: '7px', borderBottomRightRadius: '7px', borderBottomLeftRadius: '7px' });
  context.owner.getBoundingClientRect = () => ({ left: 0, top: 0, width: 73, height: 113 });
  context.geometry[0]!.rects = [{ left: 4, top: 95, width: 30.6167, height: 11 }];
  assert.deepEqual(context.check(), white, 'The price is inside the curved edge even though its rectangle enters the corner quadrant');
  context.geometry[0]!.rects[0]!.left = 3;
  assert.equal(context.check(), null, 'Moving the same text toward the curve touches the selected outline');
  const elliptical = fixture({ boxShadow: 'none', borderTopLeftRadius: '20px 10px' });
  elliptical.geometry[0]!.rects = [{ left: 5, top: 7, width: 12, height: 8 }];
  assert.deepEqual(elliptical.check(), white);
  elliptical.geometry[0]!.rects[0]!.top = 4;
  assert.equal(elliptical.check(), null, 'Unequal horizontal and vertical radii use their own axes');
  const oversized = fixture({ borderTopLeftRadius: '70px', borderTopRightRadius: '70px' });
  assert.equal(oversized.check(), null, 'Radii requiring CSS overlap normalization remain unsupported');
});

test('content-box clipping and translated boxes require actual complete image coverage', () => {
  const context = fixture({ backgroundClip: 'content-box', paddingLeft: '10px', paddingRight: '10px', boxShadow: 'none' });
  assert.equal(context.check(), null);
  context.geometry[0]!.rects = [{ ...rect, left: 12, width: 40 }];
  assert.deepEqual(context.check(), white);
  context.owner.computed.transform = 'matrix(1, 0, 0, 1, 20, 30)';
  context.owner.getBoundingClientRect = () => ({ left: 20, top: 30, width: 73, height: 107 });
  context.geometry[0]!.rects = [{ ...rect, left: 32, top: 90, width: 40 }];
  assert.deepEqual(context.check(), white);
});

test('an owned background image disables background-color suggestions even after its covering color is resolved', () => {
  const owner = Object.assign(new Box({ ...baseStyle, color: 'rgb(200, 200, 200)', backgroundColor: 'rgb(0, 0, 0)', opacity: '1', mixBlendMode: 'normal', fontSize: '14px', fontWeight: '400' }), {
    tagName: 'SPAN', localName: 'span', matches: () => false,
  });
  const replacements = {
    getComputedStyle: (element: Box, pseudo?: string) => pseudo ? { content: 'none', display: 'none' } : element.computed,
    SVGElement: class {}, innerWidth: 1000, innerHeight: 1000, document: { elementsFromPoint: () => [] },
  };
  const previous = new Map(Object.keys(replacements).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(replacements)) Object.defineProperty(globalThis, key, { value, configurable: true });
  const measure = () => measureRuns(owner as unknown as Element, new ElementRegistry('solid-image'), DEFAULT_SETTINGS, 1, [{ rects: [rect], limited: false }])[0]!;
  try {
    const covered = measure();
    assert.deepEqual(covered.effectiveBackground, white);
    assert.equal(covered.contrast.status, 'fail');
    assert.equal(covered.ownOpaqueBackground, false, 'Changing the CSS background color cannot change an opaque covering image');
    owner.computed.backgroundImage = 'none';
    assert.equal(measure().ownOpaqueBackground, true, 'Ordinary owned opaque color remains eligible');
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
});
