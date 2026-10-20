import test from 'node:test';
import assert from 'node:assert/strict';
import { directTextCount, isRendered } from '../../src/runtime/dom';

class Box {
  tagName = 'DIV'; namespaceURI = 'http://www.w3.org/1999/xhtml';
  parentElement: Box | null = null; children: Box[] = []; childNodes: object[] = [];
  open = false;
  computed: Record<string, string> = { display: 'block', visibility: 'visible', opacity: '1', position: 'static' };
  content: Record<string, string> = {};
  matches() { return false; } closest() { return null; }
  getClientRects() { return [{ left: 0, top: 0, width: 100, height: 20 }]; }
  append(child: Box) { this.children.push(child); child.parentElement = this; return child; }
  get element() { return this as unknown as Element; }
}

function environment(run: () => void) {
  const saved = ['getComputedStyle', 'Node', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: (box: Box, pseudo?: string) => pseudo ? box.content : box.computed });
  Object.defineProperty(globalThis, 'Node', { configurable: true, value: { TEXT_NODE: 3 } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [{ left: 0, top: 0, width: 80, height: 18 }] }),
  } });
  try { run(); } finally { for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  } }
}
function disclosure() {
  const details = new Box(); details.tagName = 'DETAILS';
  const body = details.append(new Box()), summary = details.append(new Box()); summary.tagName = 'SUMMARY';
  const second = details.append(new Box()); second.tagName = 'SUMMARY';
  const label = summary.append(new Box());
  return { details, body, summary, second, label };
}

test('collapsed disclosures retain only their first direct summary, including nested contents', () => environment(() => {
  const { details, body, summary, second, label } = disclosure();
  assert.equal(isRendered(details.element), true);
  assert.equal(isRendered(summary.element), true); assert.equal(isRendered(label.element), true);
  assert.equal(isRendered(body.element), false); assert.equal(isRendered(second.element), false);
  body.tagName = 'SUMMARY'; body.namespaceURI = 'urn:foreign';
  assert.equal(isRendered(summary.element), true, 'A foreign namesake is not the native summary');
  const inner = disclosure(); inner.details.open = true; body.append(inner.details);
  assert.equal(isRendered(inner.summary.element), false);
  details.open = true; assert.equal(isRendered(inner.body.element), true);
  details.open = false; assert.equal(isRendered(inner.body.element), false);
}));

test('direct and boxless disclosure text follows supported pseudo overrides without changing the DOM', () => environment(() => {
  const { details, body, summary } = disclosure();
  details.childNodes = [{ nodeType: 3, nodeValue: 'Direct content' }];
  body.computed.display = 'contents';
  assert.equal(directTextCount(details.element), 0); assert.equal(isRendered(body.element), false);
  details.open = true; assert.equal(directTextCount(details.element), 1); assert.equal(isRendered(body.element), true);
  details.content = { display: 'block', contentVisibility: 'hidden' };
  assert.equal(directTextCount(details.element), 0); assert.equal(isRendered(body.element), false);
  assert.equal(isRendered(summary.element), true);
  details.open = false; details.content.contentVisibility = 'visible';
  assert.equal(directTextCount(details.element), 1); assert.equal(isRendered(body.element), true);
  details.content = { display: 'contents', contentVisibility: 'hidden' };
  assert.equal(directTextCount(details.element), 1); assert.equal(isRendered(body.element), true);
  details.content.display = 'inline';
  assert.equal(directTextCount(details.element), 1); assert.equal(isRendered(body.element), true);
  details.content.display = 'none'; assert.equal(isRendered(body.element), false);
}));

test('native layout visibility excludes skipped boxes but does not discard visible boxless text', () => environment(() => {
  const node = new Box(); let calls = 0;
  Object.assign(node, { checkVisibility(...args: unknown[]) { calls++; assert.equal(args.length, 0); return false; } });
  assert.equal(isRendered(node.element), false); assert.equal(calls, 1);
  node.computed.display = 'contents'; assert.equal(isRendered(node.element), true); assert.equal(calls, 1);
}));
