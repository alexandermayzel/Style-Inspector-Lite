import test from 'node:test';
import assert from 'node:assert/strict';
import { transparentMask } from '../../src/runtime/mask-geometry';

const doubleMask = 'linear-gradient(to top, transparent 0%, transparent 20px, black 20px, black 100%), linear-gradient(to right, black 0%, black -21px, transparent 3px, transparent 100%)';
function fixture() {
  const box = { left: 10, top: 20, width: 200, height: 60 };
  const element = { scrollLeft: 0, scrollTop: 0, getClientRects: () => [box], getBoundingClientRect: () => box };
  const style = { maskImage: doubleMask, display: 'block', maskSize: 'auto, auto', maskPosition: '0% 0%, 0% 0%',
    maskOrigin: 'border-box, border-box', maskClip: 'border-box, border-box', maskMode: 'match-source, match-source',
    maskComposite: 'add, add', maskRepeat: 'repeat, repeat', getPropertyValue: () => '' };
  const hidden = (rect = { left: 15, top: 65, width: 12, height: 4 }) => transparentMask(element as unknown as Element, style as unknown as CSSStyleDeclaration)?.(rect) ?? false;
  return { box, element, style, hidden };
}

test('only the shared transparent region of additive full-size masks hides ink', () => {
  const f = fixture();
  assert.equal(f.hidden(), true);
  assert.equal(f.hidden({ left: 12, top: 65, width: 12, height: 4 }), false, 'Horizontal fading region still has alpha');
  assert.equal(f.hidden({ left: 15, top: 59, width: 12, height: 4 }), false, 'Opaque vertical layer restores visibility');
  assert.equal(f.hidden({ left: 15, top: 60, width: 12, height: 4 }), false, 'Hard-stop boundary remains conservative');
  assert.equal(f.hidden({ left: 15, top: 65, width: 0, height: 4 }), false);
  assert.equal(f.hidden({ left: 15, top: 79, width: 12, height: 4 }), false, 'Do not infer mask tiling outside its box');
});

test('gradient stop fixup and both axis directions preserve fading regions', () => {
  const f = fixture();
  f.style.maskImage = 'linear-gradient(to right, black 20px, transparent -10px, transparent 100%)';
  assert.equal(f.hidden({ left: 15, top: 65, width: 12, height: 4 }), false);
  assert.equal(f.hidden({ left: 35, top: 65, width: 12, height: 4 }), true);
  f.style.maskImage = 'linear-gradient(to left, black 0%, transparent 50%, transparent 100%)';
  assert.equal(f.hidden(), true);
  assert.equal(f.hidden({ left: 150, top: 65, width: 12, height: 4 }), false);
  f.style.maskImage = 'linear-gradient(to bottom, black 0px, transparent 20px, transparent 100%)';
  assert.equal(f.hidden(), true);
  f.style.maskImage = 'linear-gradient(to right, transparent 0%, transparent 100%)';
  assert.equal(f.hidden(), true);
  f.style.maskImage = 'linear-gradient(to right, rgba(0,0,0,.001) 0%, rgba(0,0,0,.001) 100%)';
  assert.equal(f.hidden(), false, 'Small alpha is not fully hidden');
});

test('unsupported mask placement, modes and geometry cannot hide text', () => {
  for (const [key, value] of Object.entries({ maskSize: '50%', maskPosition: '1px 0px', maskOrigin: 'content-box',
    maskClip: 'no-clip', maskMode: 'luminance', maskComposite: 'intersect', maskRepeat: 'round', display: 'inline' })) {
    const f = fixture(); Object.assign(f.style, { [key]: value }); assert.equal(f.hidden(), false, key);
  }
  for (const image of ['none', `${doubleMask}, none`, 'radial-gradient(transparent, black)', 'url("mask.svg")',
    'linear-gradient(45deg, transparent 0%, transparent 100%)', 'linear-gradient(to right, transparent, transparent)',
    'linear-gradient(to right, transparent calc(0px), transparent 100%)', 'linear-gradient(to right, transparent 0%, 25%, black 100%)']) {
    const f = fixture(); f.style.maskImage = image; assert.equal(f.hidden(), false, image);
  }
  const scrolled = fixture(); scrolled.element.scrollLeft = 1; assert.equal(scrolled.hidden(), false);
  const fragmented = fixture(); fragmented.element.getClientRects = () => [fragmented.box, fragmented.box]; assert.equal(fragmented.hidden(), false);
});
