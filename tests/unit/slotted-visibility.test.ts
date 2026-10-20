import test from 'node:test';
import assert from 'node:assert/strict';
import { directTextCount, isRendered } from '../../src/runtime/dom';

class Box {
  tagName = 'DIV'; namespaceURI = 'http://www.w3.org/1999/xhtml';
  parentElement: Box | null = null;
  parentNode: { nodeType: number; host?: Box } | null = null;
  assignedSlot: Box | null = null;
  childNodes: object[] = [];
  shadowRoot: object | null = null;
  topLayer = false;
  computed: Record<string, string> = { display: 'block', position: 'static', opacity: '1', visibility: 'visible', contentVisibility: 'visible' };
  matches() { return this.topLayer; }
  closest() { return null; }
  getClientRects() { return [{ left: 0, top: 0, width: 100, height: 20 }]; }
  get element() { return this as unknown as Element; }
}

function environment(run: () => void) {
  const saved = ['getComputedStyle', 'Node', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (box: Box) => box.computed });
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: { TEXT_NODE: 3 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ left: 0, top: 0, width: 80, height: 18 }] }),
  } });
  try { run(); } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
    }
  }
}

function slotted() {
  const outer = new Box(), wrapper = new Box(), slot = new Box(), light = new Box();
  wrapper.parentNode = { nodeType: 11, host: outer };
  slot.parentElement = wrapper; slot.computed.display = 'contents';
  light.parentElement = outer; light.assignedSlot = slot;
  return { outer, wrapper, slot, light };
}

test('slotted light-DOM visibility follows internal ancestors and changes without cached state', () => environment(() => {
  const { outer, wrapper, light } = slotted();
  assert.equal(isRendered(light.element), true);
  wrapper.computed.opacity = '0';
  assert.equal(isRendered(light.element), false, 'An opaque host box cannot prove its assigned contents visible');
  wrapper.computed.opacity = '1'; assert.equal(isRendered(light.element), true);
  outer.computed.opacity = '0'; assert.equal(isRendered(light.element), false, 'Traversal crosses the shadow root back to its host');
  outer.computed.opacity = '1'; wrapper.computed.opacity = '0';
  light.assignedSlot = null; assert.equal(isRendered(light.element), true, 'A changed assignment removes the old hidden ancestry');
}));

test('boxless slots, visible overrides and faint assigned content remain in scope', () => environment(() => {
  const { wrapper, slot, light } = slotted();
  slot.computed.opacity = '0'; assert.equal(isRendered(light.element), true);
  slot.computed.contentVisibility = 'hidden'; assert.equal(isRendered(light.element), true);
  wrapper.computed.display = 'contents'; wrapper.computed.contentVisibility = 'hidden';
  assert.equal(isRendered(light.element), true, 'Content visibility has no box to contain here');
  wrapper.computed.display = 'block'; wrapper.computed.contentVisibility = 'visible';
  wrapper.computed.opacity = '0.000001'; assert.equal(isRendered(light.element), true);
  wrapper.computed.visibility = 'hidden'; assert.equal(isRendered(light.element), true, 'The target computed visibility can override its ancestor');
  light.computed.visibility = 'hidden'; assert.equal(isRendered(light.element), false);
  light.computed.visibility = 'visible'; slot.computed.display = 'none'; assert.equal(isRendered(light.element), false);
}));

test('top-layer assigned descendants escape ancestor opacity and clips, but not display none', () => environment(() => {
  const { wrapper, light } = slotted();
  wrapper.computed.opacity = '0'; wrapper.computed.clipPath = 'inset(50%)';
  assert.equal(isRendered(light.element), false);
  light.topLayer = true; assert.equal(isRendered(light.element), true);
  light.computed.opacity = '0'; assert.equal(isRendered(light.element), false, 'Own paint effects still apply');
  light.computed.opacity = '1'; wrapper.computed.display = 'none'; assert.equal(isRendered(light.element), false);
}));

test('direct light-DOM text assigned inside its own component respects hidden slots', () => environment(() => {
  const { outer, wrapper, slot } = slotted();
  outer.childNodes = [{ nodeType: 3, nodeValue: 'Skip to navigation', assignedSlot: slot }];
  assert.equal(isRendered(outer.element), true);
  wrapper.computed.opacity = '0'; assert.equal(directTextCount(outer.element), 0);
  wrapper.computed.opacity = '1'; assert.equal(directTextCount(outer.element), 1);
  slot.computed.visibility = 'hidden'; assert.equal(directTextCount(outer.element), 0, 'Text inherits slot visibility');
  slot.computed.visibility = 'visible'; slot.computed.opacity = '0'; assert.equal(directTextCount(outer.element), 1);
}));

test('an internal text slot can override host visibility, but cannot undo host opacity or display', () => environment(() => {
  const { outer, slot } = slotted();
  outer.shadowRoot = {}; outer.computed.visibility = 'hidden';
  outer.childNodes = [{ nodeType: 3, nodeValue: 'Visible internal override', assignedSlot: slot }];
  assert.equal(isRendered(outer.element), false);
  assert.equal(directTextCount(outer.element), 1);
  outer.computed.opacity = '0'; assert.equal(directTextCount(outer.element), 0);
  outer.computed.opacity = '1'; outer.computed.display = 'none'; assert.equal(directTextCount(outer.element), 0);
  outer.computed.display = 'block'; slot.computed.visibility = 'hidden'; assert.equal(directTextCount(outer.element), 0);
}));
