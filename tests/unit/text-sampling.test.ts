import test from 'node:test';
import assert from 'node:assert/strict';
import { visibleTextSampleRect } from '../../src/runtime/text-sampling';

const baseStyle = {
  display: 'block', position: 'static', overflowX: 'visible', overflowY: 'visible',
  transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none',
  zoom: '1', transformStyle: 'flat', clipPath: 'none', clip: 'auto', maskImage: 'none',
  filter: 'none', backdropFilter: 'none', contain: 'none', contentVisibility: 'visible',
  borderTopLeftRadius: '0px', borderTopRightRadius: '0px', borderBottomLeftRadius: '0px', borderBottomRightRadius: '0px',
};
type Rect = { left: number; top: number; width: number; height: number };
class Box {
  namespaceURI = 'http://www.w3.org/1999/xhtml';
  clientLeft = 0; clientTop = 0; clientWidth = 120; clientHeight = 20;
  computed: Record<string, string>;
  ownerDocument = { documentElement: null, body: null, defaultView: { getComputedStyle: (node: Box) => node.computed } };
  constructor(changes: Record<string, string> = {}, readonly parentElement: Box | null = null, readonly bounds: Rect = { left: 0, top: 0, width: 120, height: 20 }) { this.computed = { ...baseStyle, ...changes }; }
  getClientRects() { return [this.bounds]; }
  getBoundingClientRect() { return this.bounds; }
}
const range = { left: 0, top: 2, width: 600, height: 16 };
const sample = (box: Box, rect: Rect = range) => visibleTextSampleRect(box as unknown as Element, rect);

test('sampling partially clipped preview text stays inside the clipping box, without changing source geometry', () => {
  for (const overflow of ['hidden', 'auto', 'scroll']) {
    const box = new Box({ overflowX: overflow, overflowY: 'hidden' });
    assert.deepEqual(sample(box), { left: 1, top: 2, width: 118, height: 16 });
  }
  assert.deepEqual(range, { left: 0, top: 2, width: 600, height: 16 });
  assert.equal(sample(new Box()), range, 'Visible overflow must still sample the overflowing text');
});

test('sampling intersects supported ancestor clips, including fractional translated borders and vertical clipping', () => {
  const parent = new Box({ overflowX: 'hidden', overflowY: 'hidden', transform: 'matrix(1, 0, 0, 1, 30, 5)' }, null, { left: 30.4, top: 5.2, width: 200, height: 40 });
  parent.clientLeft = 1; parent.clientTop = 1; parent.clientWidth = 198; parent.clientHeight = 38;
  const child = new Box({ overflowX: 'hidden' }, parent, { left: 80, top: 0, width: 120, height: 20 });
  assert.deepEqual(sample(child), { left: 81, top: 7.2, width: 118, height: 10.8 });
});

test('sampling preserves unknown clipping, transforms and compositing geometry', () => {
  const changes: Record<string, string>[] = [
    { transform: 'matrix(2, 0, 0, 2, 0, 0)' }, { transform: 'matrix(1, 0.1, 0, 1, 0, 0)' },
    { scale: '2' }, { rotate: '10deg' }, { translate: '10px' }, { perspective: '100px' },
    { zoom: '2' }, { transformStyle: 'preserve-3d' }, { clipPath: 'inset(10px)' },
    { clip: 'rect(0px, 50px, 20px, 0px)' }, { maskImage: 'linear-gradient(black, transparent)' },
    { filter: 'blur(1px)' }, { backdropFilter: 'blur(1px)' }, { contain: 'paint' },
    { contentVisibility: 'auto' }, { overflowX: 'clip' }, { borderTopLeftRadius: '10px' },
  ];
  for (const change of changes) {
    const ancestor = new Box(change);
    const box = new Box({ overflowX: 'hidden' }, ancestor);
    // A radius on an ancestor without clipping is harmless; test it on the clip itself.
    if ('borderTopLeftRadius' in change || 'overflowX' in change) Object.assign(box.computed, change);
    assert.equal(sample(box), range, JSON.stringify(change));
  }
});

test('empty, tiny, invalid and unsupported clipping boxes do not remove or invent visible text', () => {
  const offscreen = { left: 200, top: 2, width: 100, height: 16 };
  assert.equal(sample(new Box({ overflowX: 'hidden' }), offscreen), offscreen);
  const tiny = new Box({ overflowX: 'hidden' }); tiny.clientWidth = 1;
  assert.equal(sample(tiny), range);
  const invalid = new Box({ overflowX: 'hidden' }); invalid.clientWidth = NaN;
  assert.equal(sample(invalid), range);
  const fragments = new Box({ overflowX: 'hidden' }); fragments.getClientRects = () => [fragments.bounds, fragments.bounds];
  assert.equal(sample(fragments), range);
  assert.equal(sample(new Box({ display: 'inline', overflowX: 'hidden' })), range);
  assert.equal(sample(new Box({ display: 'contents', overflowX: 'hidden' })), range);
});

test('an out-of-flow text box can escape ancestor clipping while its own clipping still applies', () => {
  const ancestor = new Box({ overflowX: 'hidden' });
  for (const position of ['absolute', 'fixed', 'sticky']) {
    const text = new Box({ position }, ancestor);
    assert.equal(sample(text), range, position);
    Object.assign(text.computed, { overflowX: 'hidden' });
    assert.deepEqual(sample(text), { left: 1, top: 2, width: 118, height: 16 }, position);
  }
  const fixedRoot = new Box({ position: 'fixed' });
  assert.deepEqual(sample(new Box({ overflowX: 'hidden' }, fixedRoot)), { left: 1, top: 2, width: 118, height: 16 });
});
