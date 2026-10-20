import test from 'node:test';
import assert from 'node:assert/strict';
import { hasEmptyOverflow, mayEscapeOverflow } from '../../src/runtime/empty-overflow';
import { isRendered } from '../../src/runtime/dom';

const style = (changes: Partial<CSSStyleDeclaration> = {}) => ({
  display: 'block', position: 'static', boxSizing: 'content-box', opacity: '1',
  width: '210px', height: '0px', overflowX: 'hidden', overflowY: 'hidden',
  paddingTop: '0px', paddingRight: '0px', paddingBottom: '0px', paddingLeft: '0px',
  borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px',
  ...changes,
}) as CSSStyleDeclaration;
const element = (computed = style(), parentElement: Element | null = null, overrides = {}) => ({
  tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', computed, parentElement,
  getClientRects: () => [{ width: 210, height: 0 }], matches: () => false, ...overrides,
}) as unknown as Element;

test('empty overflow proof uses exact padding dimensions and preserves positive or unknown clips', () => {
  const target = element();
  for (const overflow of ['hidden', 'auto', 'scroll']) {
    assert.equal(hasEmptyOverflow(target, style({ overflowY: overflow })), true, overflow);
  }
  assert.equal(hasEmptyOverflow(target, style({ height: '40px', width: '0px' })), true);
  assert.equal(hasEmptyOverflow(target, style({ borderTopWidth: '3px', borderBottomWidth: '3px' })), true, 'Content-box borders do not enlarge the padding clip');
  assert.equal(hasEmptyOverflow(target, style({ boxSizing: 'border-box', height: '6px', borderTopWidth: '3px', borderBottomWidth: '3px' })), true);
  for (const change of [
    { height: '0.25px' }, { height: '0.5px' }, { paddingTop: '1px' }, { height: 'auto' },
    { height: 'calc(1px - 1px)' }, { height: '-1px' }, { height: '0%' }, { height: 'Infinitypx' },
    { overflowY: 'visible' }, { overflowY: 'clip' }, { display: 'contents' }, { display: 'inline' }, { display: 'table' },
    { boxSizing: 'border-box', height: '6.25px', borderTopWidth: '3px', borderBottomWidth: '3px' },
    { boxSizing: 'border-box', height: '0px', borderTopWidth: '3px' },
    { boxSizing: 'border-box', height: '6px', borderTopWidth: '3px', borderBottomWidth: '3px', paddingTop: '1px' },
  ]) assert.equal(hasEmptyOverflow(target, style(change)), false, JSON.stringify(change));
  for (const tagName of ['HTML', 'BODY', 'FIELDSET']) assert.equal(hasEmptyOverflow(element(style(), null, { tagName }), style()), false);
  const fieldsetStyle = style({ width: '0px', height: '100px' });
  assert.equal(hasEmptyOverflow(element(fieldsetStyle, null, { tagName: 'FIELDSET' }), fieldsetStyle), false, 'A visible legend can escape the anonymous overflow area');
  assert.equal(hasEmptyOverflow(element(style(), null, { namespaceURI: 'http://www.w3.org/2000/svg' }), style()), false);
  assert.equal(hasEmptyOverflow(element(style(), null, { getClientRects: () => [{}, {}] }), style()), false);
});

test('empty overflow visibility follows ordinary flow while preserving escaped or visible inert text', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'getComputedStyle');
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (target: { computed: CSSStyleDeclaration }) => target.computed });
  try {
    const closed = element();
    const text = (changes: Partial<CSSStyleDeclaration> = {}, parent = closed, extra = {}) => element(style({ height: '41px', ...changes }), parent, extra);
    assert.equal(isRendered(text()), false);
    assert.equal(isRendered(element(style(), null)), false, 'Own empty clip');
    assert.equal(isRendered(text({}, element(style(), null, { inert: true }))), false);
    assert.equal(isRendered(text({}, element(style({ height: '100px' }), null, { inert: true }))), true, 'Inert does not hide painted content');
    for (const position of ['absolute', 'fixed', 'sticky']) assert.equal(isRendered(text({ position })), true, position);
    assert.equal(isRendered(text({}, closed, { matches: () => true })), true, 'Top layer escapes ancestor overflow');
    assert.equal(isRendered(element(style({ position: 'absolute' }))), false, 'Own clip still applies to a positioned element');
    const boxless = element(style({ display: 'contents', position: 'absolute' }), closed);
    assert.equal(isRendered(text({}, boxless)), false, 'A boxless ancestor cannot establish an escaping containing block');
    for (const height of ['0.25px', '0.5px', '100px']) assert.equal(isRendered(text({}, element(style({ height })))), true, height);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'getComputedStyle', previous); else Reflect.deleteProperty(globalThis, 'getComputedStyle');
  }
});

test('unknown top-layer matching and positioning keep ancestor clips unproven', () => {
  assert.equal(mayEscapeOverflow(element(), style()), false);
  assert.equal(mayEscapeOverflow(element(), style({ position: '' })), true);
  assert.equal(mayEscapeOverflow(element(style(), null, { matches: () => { throw new Error('Unsupported selector'); } }), style()), true);
});
