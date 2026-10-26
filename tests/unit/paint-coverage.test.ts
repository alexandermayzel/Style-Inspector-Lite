import test from 'node:test';
import assert from 'node:assert/strict';
import { backgroundPaintCoverage, hasUnboundedPaintTransform } from '../../src/runtime/background-paint-coverage';
import { textPseudoStyle, withTextPseudoBatch } from '../../src/runtime/text-pseudo-style';

const namespaceURI = 'http://www.w3.org/1999/xhtml';
const style = (overrides: Record<string, string> = {}) => ({ display: 'block', backgroundColor: 'black', backgroundImage: 'none',
  backgroundClip: 'border-box', backgroundAttachment: 'scroll', clip: 'auto', clipPath: 'none', position: 'static',
  transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', overflowX: 'visible', overflowY: 'visible',
  color: 'black', fontSize: '16px', fontWeight: '400', backgroundRepeat: 'repeat', ...overrides,
  getPropertyValue(name: string) { return overrides[name] ?? ''; },
} as unknown as CSSStyleDeclaration);
const box = (left = 0, top = 0, width = 100, height = 100) => ({ left, top, width, height });
const element = (rect = box(), overrides: Record<string, unknown> = {}) => ({ namespaceURI, localName: 'div', parentElement: null,
  getClientRects: () => [rect], getBoundingClientRect: () => rect, ...overrides,
} as unknown as Element);
const geometry = (...rects: ReturnType<typeof box>[]) => [{ rects, limited: false }];

test('background coverage distinguishes entire containment, separation and partial overlap across every fragment', () => {
  const owner = element(), target = element(), css = style();
  const check = (...rects: ReturnType<typeof box>[]) => backgroundPaintCoverage(owner, target, css, geometry(...rects), () => css);
  assert.equal(check(box(10, 10, 20, 20)), 'covered');
  assert.equal(check(box(120, 10, 20, 20)), 'outside');
  assert.equal(check(box(80, 10, 30, 20)), 'uncertain');
  assert.equal(check(box(10, 10, 20, 20), box(120, 10, 20, 20)), 'uncertain', 'One in-box fragment cannot authorize another escaped line');
  assert.equal(backgroundPaintCoverage(owner, target, css, [{ ...geometry(box(10, 10))[0]!, limited: true }], () => css), 'uncertain');
});

test('background clips and rounded corners require coverage of the text rectangle rather than its center', () => {
  const owner = element(), target = element();
  const check = (changes: Record<string, string>, rect: ReturnType<typeof box>) => {
    const css = style(changes); return backgroundPaintCoverage(owner, target, css, geometry(rect), () => css);
  };
  assert.equal(check({ backgroundClip: 'content-box', paddingLeft: '20px' }, box(0, 10, 10, 20)), 'uncertain');
  assert.equal(check({ backgroundClip: 'content-box', paddingLeft: '20px' }, box(25, 10, 10, 20)), 'covered');
  assert.equal(check({ backgroundClip: 'text' }, box(25, 10, 10, 20)), 'uncertain');
  assert.equal(check({ borderTopLeftRadius: '30px' }, box(0, 0, 20, 20)), 'uncertain');
  assert.equal(check({ borderTopLeftRadius: '30px' }, box(40, 40, 20, 20)), 'covered');
  assert.equal(check({ borderTopLeftRadius: '50%' }, box(40, 40, 20, 20)), 'uncertain');
  assert.equal(check({ clipPath: 'circle(10px)' }, box(40, 40, 20, 20)), 'uncertain');
});

test('overflow clipping retains a bounded ellipsized text background without shrinking ordinary overflow', () => {
  const owner = element(), target = element(box(), { parentElement: owner });
  const ordinary = style({ backgroundColor: 'transparent' });
  const css = style({ overflowX: 'hidden', overflowY: 'hidden' });
  const read = (node: Element) => node === owner ? css : ordinary;
  assert.equal(backgroundPaintCoverage(owner, target, css, geometry(box(5, 5, 250, 20)), read), 'covered');
  css.overflowX = css.overflowY = 'visible';
  assert.equal(backgroundPaintCoverage(owner, target, css, geometry(box(5, 5, 250, 20)), read), 'uncertain');
  css.overflowX = css.overflowY = 'hidden'; ordinary.position = 'absolute';
  assert.equal(backgroundPaintCoverage(owner, target, css, geometry(box(5, 5, 250, 20)), read), 'uncertain', 'An escaped positioned descendant is not guessed to be clipped');
  assert.equal(backgroundPaintCoverage(owner, target, css, geometry(box(150, 5, 30, 20)), read), 'uncertain', 'Retained text beyond a clip has no proven visible canvas background');
});

test('HTML canvas propagation is retained without treating every body color as an infinite surface', () => {
  const root = element(box(), { localName: 'html' }), body = element(), target = element(box(200, 0, 20, 20));
  const document = { documentElement: root, body };
  Object.assign(root, { ownerDocument: document }); Object.assign(body, { ownerDocument: document });
  const css = style(), rootCss = style({ backgroundColor: 'transparent' });
  const read = (node: Element) => node === root ? rootCss : css;
  assert.equal(backgroundPaintCoverage(root, target, rootCss, geometry(box(200, 0, 20, 20)), read), 'covered');
  assert.equal(backgroundPaintCoverage(body, target, css, geometry(box(200, 0, 20, 20)), read), 'covered');
  rootCss.backgroundColor = 'white';
  assert.equal(backgroundPaintCoverage(body, target, css, geometry(box(200, 0, 20, 20)), read), 'outside');
  rootCss.backgroundColor = 'black';
  assert.equal(backgroundPaintCoverage(body, target, css, geometry(box(200, 0, 20, 20)), read), 'covered', 'Matching body and document canvas colors remain uniform across the body edge');
  rootCss.backgroundColor = 'transparent'; rootCss.backgroundImage = 'url(image.png)';
  assert.equal(backgroundPaintCoverage(body, target, css, geometry(box(200, 0, 20, 20)), read), 'outside');
});

test('only translation matrices preserve the background proof without transformed inset geometry', () => {
  assert.equal(hasUnboundedPaintTransform(style()), false);
  assert.equal(hasUnboundedPaintTransform(style({ transform: 'matrix(1, 0, 0, 1, 20, -3)' })), false);
  const changes: Record<string, string>[] = [{ transform: 'matrix(2, 0, 0, 2, 0, 0)' }, { transform: 'matrix(1, 0.1, 0, 1, 0, 0)' },
    { rotate: '15deg' }, { scale: '2' }, { perspective: '100px' }, { zoom: '2' }];
  for (const change of changes) assert.equal(hasUnboundedPaintTransform(style(change)), true);
});

test('text pseudo styles distinguish inherited ordinary values from paint and font threshold changes', () => {
  const owner = element(), base = style();
  let pseudo = style({ display: 'inline', backgroundColor: 'transparent' });
  const read = (_node: Element, selector?: string) => selector ? pseudo : base;
  assert.equal(textPseudoStyle(owner, [], read), false, 'Default transparent pseudo background must not compare unequal to its owner background');
  Object.assign(base, { textDecorationLine: 'underline', textDecorationColor: 'blue', textDecorationStyle: 'wavy' });
  Object.assign(pseudo, { textDecorationLine: 'none', textDecorationColor: 'black', textDecorationStyle: 'solid' });
  assert.equal(textPseudoStyle(owner, [], read), false, 'A noninherited decoration default does not remove or alter an ordinary link underline');
  pseudo.textDecorationLine = 'overline'; assert.equal(textPseudoStyle(owner, [], read), 'paint');
  pseudo.textDecorationLine = 'none';
  pseudo.color = 'white'; assert.equal(textPseudoStyle(owner, [], read), 'paint');
  pseudo.fontSize = '9px'; assert.equal(textPseudoStyle(owner, [], read), 'font');
  base.display = 'inline'; assert.equal(textPseudoStyle(owner, [], read), false, 'Declared inline first-line styling is inapplicable');
  base.display = 'flex'; assert.equal(textPseudoStyle(owner, [], read), false, 'A flex container does not have a first formatted text line');
});

test('derived pseudo comparisons are reused within one chunk and refreshed after a cooperative yield', () => {
  const owner = element(), base = style(), pseudo = style({ display: 'inline', backgroundColor: 'transparent' });
  let pseudoReads = 0;
  const read = (_node: Element, selector?: string) => { if (selector) pseudoReads++; return selector ? pseudo : base; };
  withTextPseudoBatch(() => {
    assert.equal(textPseudoStyle(owner, [], read), false);
    assert.equal(textPseudoStyle(owner, [], read), false);
    assert.equal(pseudoReads, 2, 'Shared ancestor pseudo properties are compared only once in the current synchronous chunk');
  });
  pseudo.color = 'white';
  withTextPseudoBatch(() => assert.equal(textPseudoStyle(owner, [], read), 'paint'));
  assert.equal(pseudoReads, 4, 'A later chunk observes changed live pseudo declarations');
});
