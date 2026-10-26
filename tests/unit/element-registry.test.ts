import test from 'node:test';
import assert from 'node:assert/strict';
import { ElementRegistry } from '../../src/runtime/dom';

const element = () => ({ isConnected: true }) as Element;
const retained = (registry: ElementRegistry) => (registry as unknown as { elements: Map<string, Element> }).elements.size;

test('registry releases selectable references but preserves weak identities for explicitly remeasured nodes', () => {
  const registry = new ElementRegistry('document');
  const selected = element(), old = element(), removed = element();
  const selectedId = registry.reference(selected), oldId = registry.reference(old), removedId = registry.reference(removed);
  Object.assign(removed, { isConnected: false });
  registry.retain(new Set([selectedId, removedId]));
  assert.equal(retained(registry), 1, 'Disconnected nodes are released even when stale snapshots still mention them');
  assert.equal(registry.get(selectedId), selected);
  assert.equal(registry.reference(selected), selectedId);
  assert.equal(registry.get(oldId), null);
  assert.equal(registry.get(removedId), null);
  const freshId = registry.reference(old);
  assert.equal(freshId, oldId, 'Remeasuring a connected node explicitly reactivates its own identity');
  Object.assign(removed, { isConnected: true });
  assert.equal(registry.get(removedId), null, 'Reattaching alone does not reactivate a retired reference');
  assert.equal(registry.reference(removed), removedId, 'Only explicit remeasurement reactivates a reattached node');
  registry.clear();
  assert.equal(retained(registry), 0);
  assert.notEqual(registry.reference(selected), selectedId, 'A reset never recycles its earlier serials');
});

test('repeated large audits and pure picker previews keep only their active reference budget', () => {
  const registry = new ElementRegistry('changing-document');
  const selected = element(), selectedId = registry.reference(selected);
  for (let cycle = 0; cycle < 20; cycle++) {
    const current = Array.from({ length: 1000 }, () => registry.reference(element()));
    registry.retain(new Set([selectedId, ...current]));
    assert.equal(retained(registry), 1001);
    assert.equal(registry.get(selectedId), selected);
  }
  for (let preview = 0; preview < 200; preview++) {
    const current = registry.reference(element());
    registry.retain(new Set([selectedId, current]));
    assert.equal(retained(registry), 2);
  }
  registry.retain(new Set());
  assert.equal(retained(registry), 0);
});

const unreadText = () => Object.defineProperties({}, {
  nodeValue: { get() { throw new Error('Run identity must not read text'); } },
  data: { get() { throw new Error('Run identity must not read text'); } },
}) as Text;

test('text identities survive sibling reordering and distinguish replacement nodes and owners without reading content', () => {
  const registry = new ElementRegistry('text-document');
  const owner = element(), otherOwner = element();
  const first = unreadText(), chosen = unreadText(), last = unreadText();
  const nodes = [first, chosen, last];
  const original = nodes.map(node => registry.textReference(owner, node));
  nodes.unshift(unreadText());
  assert.equal(registry.textReference(owner, nodes[2]!), original[1], 'Inserting an earlier sibling does not change the chosen run');
  nodes.splice(0, 2);
  assert.equal(registry.textReference(owner, nodes[0]!), original[1], 'Removing earlier siblings does not adopt the next ordinal');
  nodes.reverse();
  assert.deepEqual(nodes.map(node => registry.textReference(owner, node)), [original[2], original[1]], 'Reordering preserves each actual node');
  const replacement = unreadText();
  assert.notEqual(registry.textReference(owner, replacement), original[1], 'A replacement with any text content has a distinct identity');
  assert.notEqual(registry.textReference(otherOwner, chosen), original[1], 'Moving a node to a different owner creates a different run context');
  assert.equal(registry.textReference(owner, chosen), original[1]);
  assert.equal(retained(registry), 2, 'Text identity does not add strong references to the element registry');
  assert.ok((registry as unknown as { textIds: WeakMap<Text, number> }).textIds instanceof WeakMap, 'Text objects are held only by weak keys');
});

test('manual scan resets preserve weak run identities while clearing stored data retires them permanently', () => {
  const registry = new ElementRegistry('retired-text');
  const owner = element(), node = unreadText();
  const initial = registry.textReference(owner, node);
  registry.retain(new Set());
  assert.equal(retained(registry), 0);
  const afterRetirement = registry.textReference(owner, node);
  assert.equal(afterRetirement, initial, 'Pruning selectable references does not break successive audit comparisons');
  registry.clear(true);
  assert.equal(retained(registry), 0);
  assert.equal(registry.get(initial.split(':node')[0]!), null);
  assert.equal(registry.textReference(owner, node), initial, 'A manual scan can remeasure the same Text object');
  registry.clear();
  assert.equal(retained(registry), 0);
  const afterClear = registry.textReference(owner, node);
  assert.notEqual(afterClear, initial);
  assert.notEqual(afterClear, afterRetirement, 'Clearing analysis never recycles run identities');
});
