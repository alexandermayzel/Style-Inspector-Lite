import test from 'node:test';
import assert from 'node:assert/strict';
import { combineTextExcerpts, readTextExcerpt } from '../../src/runtime/text-excerpt';

function textNode(value: string): Text {
  return { length: value.length, substringData: (offset: number, count: number) => value.slice(offset, offset + count),
    get data() { throw new Error('Unbounded read'); }, get textContent() { throw new Error('Unbounded read'); } } as unknown as Text;
}

test('selected text excerpts normalize bounded prefixes and preserve surrogate pairs', () => {
  assert.deepEqual(readTextExcerpt(textNode('  Hello\n\tworld\u00a0 '), { remaining: 50_000 }), { value: 'Hello world', truncated: false });
  assert.deepEqual(readTextExcerpt(textNode('a'.repeat(498) + '😀'), { remaining: 50_000 }), { value: 'a'.repeat(498) + '😀', truncated: false });
  assert.deepEqual(readTextExcerpt(textNode('a'.repeat(499) + '😀end'), { remaining: 50_000 }), { value: 'a'.repeat(499), truncated: true });
  const budget = { remaining: 5000 };
  assert.deepEqual(readTextExcerpt(textNode(' '.repeat(4096) + 'not read'), budget), { value: '', truncated: true });
  assert.equal(budget.remaining, 904);
  assert.deepEqual(readTextExcerpt(textNode('x'.repeat(2000)), budget), { value: 'x'.repeat(500), truncated: true });
  assert.equal(budget.remaining, 0);
  assert.deepEqual(readTextExcerpt(textNode('unread'), budget), { value: '', truncated: true });
});

test('combined excerpts are bounded and propagate selection and per-run limits', () => {
  assert.deepEqual(combineTextExcerpts([{ value: 'one', truncated: false }, { value: '', truncated: false }, { value: 'two', truncated: false }], false), { value: 'one two', truncated: false });
  assert.deepEqual(combineTextExcerpts([{ value: 'one', truncated: true }], false), { value: 'one', truncated: true });
  assert.deepEqual(combineTextExcerpts([], true), { value: '', truncated: true });
  const long = combineTextExcerpts([{ value: 'a'.repeat(1999) + '😀', truncated: false }], false);
  assert.equal(long.value, 'a'.repeat(1999));
  assert.equal(long.truncated, true);
});
