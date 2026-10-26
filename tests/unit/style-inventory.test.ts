import test from 'node:test';
import assert from 'node:assert/strict';
import { getFontEntries, getInventoryRuns, getPaletteEntries, hasInteractiveAncestor, primaryPaletteRole, StyleInventory } from '../../src/core/style-inventory';
import { parseColor } from '../../src/core/colors';
import type { ColorValue, PaletteRole, PaletteUsage, TextRun } from '../../src/core/types';
import { fixtureRun } from '../fixtures/export/data';

const style = (color = '#111111', backgroundColor = '#FFFFFF', fontFamily = 'Arial, sans-serif') => ({ color, backgroundColor, fontFamily });
const run = (color = '#111111', background = '#FFFFFF', size = 16): TextRun => fixtureRun(color, background, size);
const item = (color: string, count: number, role: PaletteRole = 'text'): PaletteUsage => ({ color: parseColor(color), count, roles: { [role]: count } });
const key = (color: ColorValue) => JSON.stringify(color.rgba ?? color.raw);
const find = (inventory: StyleInventory, color: string) => inventory.snapshot().paletteUsage!.find(entry => key(entry.color) === key(parseColor(color)))!;

test('cooperative chunks merge one element without multiplying colors, roles, families or variants', () => {
  const all = new StyleInventory(), chunked = new StyleInventory();
  const computed = { ...style('#111111', '#FFFFFF', 'Arial, sans-serif'), lineHeight: '24px' };
  const runs = [
    { ...run('#999999'), fontFamily: 'Georgia, serif', fontSizeCssPx: 14, lineHeight: '20px' },
    { ...run('#111111'), fontFamily: 'Arial, sans-serif', lineHeight: '24px' },
    { ...run('#AA0000'), fontFamily: 'Arial, sans-serif', fontSizeCssPx: 18, fontWeight: 700, lineHeight: '28px' },
  ];
  all.record('one', computed, runs, false);
  for (const index of [0, 0, 1, 2, 2, 0, 1]) chunked.record('one', computed, [runs[index]], false);
  assert.deepEqual(getPaletteEntries(chunked.snapshot()), getPaletteEntries(all.snapshot()));
  assert.deepEqual(getFontEntries(chunked.snapshot()), getFontEntries(all.snapshot()));
  assert.deepEqual(chunked.snapshot().palette, all.snapshot().palette);
  assert.deepEqual(find(chunked, '#111111').roles, { text: 1 }, 'A provisional computed-color fallback is replaced by actual text evidence');
  assert.deepEqual(chunked.snapshot().inventoryLimits!.reached, []);
  chunked.record('two', computed, runs, false);
  assert.equal(getFontEntries(chunked.snapshot())[0].count, 2);
  assert.ok(chunked.snapshot().paletteUsage!.every(entry => entry.count === 2));
});

test('inventory caps are reported only after omitting a new value or element', () => {
  const colors = new StyleInventory(), fonts = new StyleInventory(), elements = new StyleInventory();
  for (let index = 0; index < 128; index++) {
    const value = `#${index.toString(16).padStart(6, '0')}`;
    colors.record(String(index), style(value, value), [run(value, value)], false);
  }
  assert.deepEqual(colors.snapshot().inventoryLimits!.reached, [], 'Exactly 128 distinct colors is complete');
  colors.record('repeat', style('#000000', '#000000'), [run('#000000', '#000000')], false);
  assert.deepEqual(colors.snapshot().inventoryLimits!.reached, []);
  colors.record('alias', style('black', 'black'), [run('black', 'black')], false);
  assert.deepEqual(colors.snapshot().inventoryLimits!.reached, [], 'A new spelling of an accepted color is not an omitted distinct color');
  colors.record('omitted', style('#abcdef', '#abcdef'), [run('#abcdef', '#abcdef')], false);
  assert.deepEqual(colors.snapshot().inventoryLimits!.reached, ['colors']);
  for (let index = 0; index < 64; index++) fonts.record(String(index), style('#000000', '#ffffff', `Family ${index}`), [run()], false);
  assert.deepEqual(fonts.snapshot().inventoryLimits!.reached, []);
  fonts.record('repeat', style('#000000', '#ffffff', 'Family 0'), [run()], false);
  assert.deepEqual(fonts.snapshot().inventoryLimits!.reached, []);
  fonts.record('omitted', style('#000000', '#ffffff', 'Family 64'), [run()], false);
  assert.deepEqual(fonts.snapshot().inventoryLimits!.reached, ['font-families']);
  for (let index = 0; index < 1000; index++) elements.record(String(index), style(), [run()], false);
  assert.deepEqual(elements.snapshot().inventoryLimits!.reached, []);
  elements.record('0', style(), [run()], false);
  assert.deepEqual(elements.snapshot().inventoryLimits!.reached, []);
  elements.record('1000', style(), [run()], false);
  assert.deepEqual(elements.snapshot().inventoryLimits!.reached, ['elements']);
  const copied = elements.snapshot(); copied.inventoryLimits!.reached.length = 0;
  assert.deepEqual(elements.snapshot().inventoryLimits!.reached, ['elements'], 'Limit metadata is detached from the collector');
});

test('font size and variant caps apply across chunks and still count accepted values on additional elements', () => {
  const inventory = new StyleInventory();
  const runs = Array.from({ length: 1000 }, (_, index) => ({ ...run('#111111', '#FFFFFF', 10 + index / 100), fontWeight: 400, lineHeight: '24px' }));
  for (let start = 0; start < runs.length; start += 16) inventory.record('one', style(), runs.slice(start, start + 16), false);
  assert.deepEqual(inventory.snapshot().inventoryLimits!.reached, []);
  inventory.record('one', style(), [runs[0]], false);
  inventory.record('two', style(), [runs[0]], false);
  assert.deepEqual(inventory.snapshot().inventoryLimits!.reached, []);
  inventory.record('one', style(), [{ ...runs[0], fontWeight: 700 }], false);
  assert.deepEqual(inventory.snapshot().inventoryLimits!.reached, ['font-variants']);
  inventory.record('one', style(), [{ ...runs[0], fontSizeCssPx: 100 }], false);
  assert.deepEqual(inventory.snapshot().inventoryLimits!.reached, ['font-sizes', 'font-variants']);
  const font = getFontEntries(inventory.snapshot())[0];
  assert.equal(font.count, 2); assert.equal(font.sizes.length, 1000); assert.equal(font.variants!.length, 1000);
  assert.equal(font.sizes[0].count, 2); assert.equal(font.variants![0].count, 2);
});

test('large font inventories retain distinct fractional metrics and merge duplicate variants without changing source data', () => {
  const inventory = new StyleInventory();
  for (let index = 0; index < 1000; index++) {
    const measured = { ...run('#111111', '#FFFFFF', 10 + index / 100), fontFamily: 'Arial, sans-serif', fontWeight: index % 2 ? 400 : 700, lineHeight: `${20 + index / 100}px` };
    inventory.record(`large-${index}`, style(), [measured], false);
  }
  const snapshot = inventory.snapshot(), before = structuredClone(snapshot);
  const entries = getFontEntries({ ...snapshot, fontUsage: [...snapshot.fontUsage!, ...snapshot.fontUsage!] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].count, 1000, 'Repeated inventory entries count each known element once');
  assert.equal(entries[0].sizes.length, 1000); assert.equal(entries[0].variants!.length, 1000);
  assert.equal(entries[0].sizes[999].sizeCssPx, 10 + 999 / 100);
  assert.ok(entries[0].variants!.every(variant => variant.count === 1 && variant.elementRefs?.length === 1));
  assert.deepEqual(snapshot, before);
});

test('color occurrence counts use distinct measured elements and merge exact aliases without rounding alpha or channels', () => {
  const inventory = new StyleInventory();
  inventory.record('first', style('#fff', '#fff'), [run('#fff'), run('#FFFFFF'), run('rgb(255 255 255)')], false);
  inventory.record('first', style('#fff', '#fff'), [run('#fff')], false);
  assert.equal(find(inventory, '#FFFFFF').count, 1);
  assert.deepEqual(find(inventory, '#FFFFFF').roles, { background: 1, text: 1 });
  inventory.record('second', style('white', '#fff'), [run('white')], false);
  assert.equal(find(inventory, '#FFFFFF').count, 2);
  for (const [index, color] of ['rgb(17 17 17 / .54)', 'rgb(17.0000085 17.0000085 17.0000085 / .54)', 'rgb(17 17 17 / .54001)', '#1111118A'].entries()) {
    inventory.record(`precise-${index}`, style(color), [run(color)], false);
    assert.equal(find(inventory, color).count, 1);
  }
  assert.equal(inventory.snapshot().paletteUsage!.length, 5);
});

test('usage roles preserve normal surfaces and text ahead of interactive-only accents and unsupported colors', () => {
  const inventory = new StyleInventory();
  inventory.record('link', style('#0066CC', '#FFFFFF'), [run('#0066CC')], true);
  assert.equal(primaryPaletteRole(find(inventory, '#0066CC')), 'accent');
  inventory.record('text', style('#0066CC', '#FFFFFF'), [run('#0066CC')], false);
  assert.equal(primaryPaletteRole(find(inventory, '#0066CC')), 'text');
  assert.deepEqual(find(inventory, '#0066CC').roles, { accent: 1, text: 1 });
  assert.equal(primaryPaletteRole(find(inventory, '#FFFFFF')), 'background');
  inventory.record('transparent', style('transparent', 'var(--missing)'), [run('transparent', 'var(--missing)')], true);
  assert.equal(primaryPaletteRole(find(inventory, 'transparent')), 'other');
  assert.equal(primaryPaletteRole(find(inventory, 'var(--missing)')), 'other');
});

test('transparent CSS background includes a reliable measured surface while uncertain CSS estimates do not', () => {
  const inventory = new StyleInventory();
  const measured = { ...run('#000', 'transparent'), effectiveBackground: parseColor('#fff').rgba };
  inventory.record('measured', style('#000', 'transparent'), [measured], true);
  assert.equal(primaryPaletteRole(find(inventory, '#fff')), 'background');
  assert.deepEqual(inventory.snapshot().palette.map(color => color.raw), ['#000', 'transparent'], 'Original token inventory remains raw CSS values');
  inventory.record('uncertain', style('#000', 'transparent'), [{ ...measured, effectiveBackground: parseColor('#123456').rgba, reasons: ['layered-background'] }], false);
  assert.equal(find(inventory, '#123456'), undefined);
  inventory.record('empty', style(), [], false);
  assert.equal(inventory.snapshot().fontUsage![0].count, 2);
});

test('limits bound distinct values without freezing counts of colors or families already recorded', () => {
  const inventory = new StyleInventory();
  for (let index = 0; index < 160; index++) {
    const color = `rgb(${index} 0 0)`;
    inventory.record(`node-${index}`, style(color, '#FFFFFF', `Font ${index}`), [run(color)], false);
  }
  assert.equal(inventory.snapshot().palette.length, 128);
  assert.equal(inventory.snapshot().paletteUsage!.length, 128);
  assert.equal(inventory.snapshot().fontUsage!.length, 64);
  inventory.record('repeat', style('rgb(0 0 0)', '#FFFFFF', 'Font 0'), [run('rgb(0 0 0)', '#FFFFFF', 24)], false);
  assert.equal(find(inventory, '#000').count, 2);
  assert.equal(find(inventory, '#fff').count, 161);
  assert.equal(inventory.snapshot().fontUsage!.find(font => font.family === 'Font 0')!.count, 2);
});

test('font stacks sort by measured element count and list sizes numerically, with unknown sizes last', () => {
  const inventory = new StyleInventory();
  inventory.record('a', style('#000', '#fff', 'Zeta, sans-serif'), [run('#000', '#fff', 24), run('#000', '#fff', 24), run('#000', '#fff', 9)], false);
  inventory.record('b', style('#000', '#fff', 'Zeta, sans-serif'), [{ ...run(), fontSizeCssPx: null }, run('#000', '#fff', 16)], false);
  inventory.record('c', style('#000', '#fff', 'Arial, sans-serif'), [run()], false);
  inventory.record('d', style('#000', '#fff', 'Beta'), [run()], false);
  const fonts = getFontEntries(inventory.snapshot());
  assert.deepEqual(fonts.map(font => [font.family, font.count]), [['Zeta, sans-serif', 2], ['Arial, sans-serif', 1], ['Beta', 1]]);
  assert.deepEqual(fonts[0].sizes, [{ sizeCssPx: 9, count: 1, elementRefs: ['a'] }, { sizeCssPx: 16, count: 1, elementRefs: ['b'] }, { sizeCssPx: 24, count: 1, elementRefs: ['a'] }, { sizeCssPx: null, count: 1, elementRefs: ['b'] }]);
});

test('sort modes are deterministic, keep equivalent shades together and put transparent or unsupported values last', () => {
  const paletteUsage = [item('#0000FF', 2, 'accent'), item('#333', 3, 'text'), item('#fff', 1, 'background'), item('#FF0000', 1, 'accent'), item('#880000', 1, 'accent'), item('transparent', 100, 'other'), item('var(--missing)', 100, 'other')];
  const audit = { palette: [], paletteUsage };
  const raw = (mode: 'usage' | 'frequency' | 'hue') => getPaletteEntries(audit, mode).map(entry => entry.color.raw);
  assert.deepEqual(raw('usage'), ['#fff', '#333', '#0000FF', '#FF0000', '#880000', 'transparent', 'var(--missing)']);
  assert.deepEqual(raw('frequency'), ['#333', '#0000FF', '#fff', '#FF0000', '#880000', 'transparent', 'var(--missing)']);
  assert.deepEqual(raw('hue'), ['#fff', '#333', '#FF0000', '#880000', '#0000FF', 'transparent', 'var(--missing)']);
  assert.deepEqual(getPaletteEntries({ ...audit, paletteUsage: [...paletteUsage].reverse() }, 'hue'), getPaletteEntries(audit, 'hue'));
});

test('legacy inventories deduplicate aliases without invented usage or font sizes; sorting never mutates snapshots', () => {
  const legacy = { palette: ['#fff', 'white', '#333'].map(parseColor), fonts: ['Zeta', 'Arial', 'Zeta'] };
  assert.equal(getPaletteEntries(legacy, 'usage').length, 2);
  assert.ok(getPaletteEntries(legacy, 'usage').every(entry => entry.count === 0 && primaryPaletteRole(entry) === 'other'));
  assert.deepEqual(getFontEntries(legacy), [{ family: 'Arial', count: 0, sizes: [] }, { family: 'Zeta', count: 0, sizes: [] }]);
  const inventory = new StyleInventory(); inventory.record('first', style(), [run()], false);
  const first = inventory.snapshot(), original = structuredClone(first);
  const colors = getPaletteEntries(first), fonts = getFontEntries(first);
  colors[0].color.rgba!.r = 42; colors[0].roles.text = 500; fonts[0].sizes[0].count = 500;
  inventory.record('second', style(), [run()], false);
  assert.deepEqual(first, original);
  assert.equal(getFontEntries(inventory.snapshot())[0].count, 2);
  assert.equal(getFontEntries(first)[0].count, 1);
});

test('interactive ancestor classification covers nested controls with bounded inspection and no page text reads', () => {
  const node = (tagName: string, attrs: Record<string, string> = {}, parentElement: Element | null = null): Element => ({ tagName, parentElement, getAttribute: (key: string) => attrs[key] ?? null, hasAttribute: (key: string) => key in attrs, get textContent() { throw Error('Text must not be read'); } }) as unknown as Element;
  for (const ancestor of [node('A', { href: '/' }), node('BUTTON'), node('SPAN', { role: 'button' }), node('INPUT'), node('SUMMARY')]) {
    assert.equal(hasInteractiveAncestor(node('SPAN', {}, ancestor)), true);
  }
  assert.equal(hasInteractiveAncestor(node('SPAN', {}, node('A'))), false);
  assert.equal(hasInteractiveAncestor(node('DIV', { role: 'article' })), false);
  let deep = node('BUTTON');
  for (let index = 0; index < 64; index++) deep = node('DIV', {}, deep);
  assert.equal(hasInteractiveAncestor(deep), false);
});

test('inventory associations identify each measured element once and choose a matching run for font variants', () => {
  const inventory = new StyleInventory();
  const first = { ...run('#123456'), id: 'a:first', elementRef: 'a', fontFamily: 'Arial, sans-serif', lineHeight: '24px' };
  const second = { ...first, id: 'a:second', fontSizeCssPx: 20, fontWeight: 700, lineHeight: '30px' };
  const third = { ...first, id: 'b:first', elementRef: 'b' };
  inventory.record('a', style('#123456'), [first, second, first], false);
  inventory.record('b', style('#123456'), [third], false);
  const snapshot = inventory.snapshot(), audit = { runs: [first, second, third] };
  const color = getPaletteEntries(snapshot).find(entry => entry.color.raw === '#123456')!;
  assert.equal(color.count, 2); assert.deepEqual(color.elementRefs, ['a', 'b']);
  assert.deepEqual(getInventoryRuns(audit, ['missing', 'b', 'a', 'a']).map(item => item.id), ['a:first', 'b:first'], 'Audit order remains stable and missing references are omitted');
  assert.deepEqual(getInventoryRuns(audit, []), [], 'Older inventories do not invent associations');
  const font = getFontEntries(snapshot)[0];
  assert.deepEqual(font.elementRefs, ['a', 'b']);
  assert.deepEqual(font.variants, [
    { sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 2, elementRefs: ['a', 'b'] },
    { sizeCssPx: 20, fontWeight: 700, lineHeight: '30px', count: 1, elementRefs: ['a'] },
  ]);
  assert.equal(getInventoryRuns(audit, font.variants![1].elementRefs!, item => item.fontSizeCssPx === 20)[0], second, 'The drill-down can select the matching run rather than a different size on the same element');
});

test('placeholder typography belongs to its actual family and keeps normal line height distinct from pixels', () => {
  const inventory = new StyleInventory();
  const placeholder = { ...run('#999', '#fff', 14), textSource: 'placeholder' as const, fontFamily: 'Georgia, serif', fontWeight: 600, lineHeight: 'normal' };
  inventory.record('hint', { ...style('#000', '#fff', 'Arial, sans-serif'), lineHeight: '24px' }, [placeholder], true);
  inventory.record('body', { ...style('#000', '#fff', 'Arial, sans-serif'), lineHeight: '24px' }, [run()], false);
  const snapshot = inventory.snapshot();
  assert.deepEqual(snapshot.fonts, ['Arial, sans-serif'], 'Legacy token inventory still describes computed element font stacks');
  const fonts = getFontEntries(snapshot);
  assert.deepEqual(fonts.map(font => [font.family, font.count]), [['Arial, sans-serif', 1], ['Georgia, serif', 1]]);
  assert.deepEqual(fonts[1].variants, [{ sizeCssPx: 14, fontWeight: 600, lineHeight: 'normal', count: 1, elementRefs: ['hint'] }]);
  assert.deepEqual(fonts[0].variants, [{ sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 1, elementRefs: ['body'] }]);
});

test('font variants sort by size, weight and numeric line height while preserving unknown measurements', () => {
  const inventory = new StyleInventory();
  const variants = [
    { size: 16, weight: 700, line: '20px' }, { size: 16, weight: 400, line: '30px' },
    { size: 16, weight: 400, line: '9px' }, { size: 16, weight: 400, line: 'normal' },
    { size: 12, weight: 500, line: '18px' }, { size: null, weight: null, line: '' },
  ];
  variants.forEach(({ size, weight, line }, index) => inventory.record(String(index), style(), [{ ...run(), fontSizeCssPx: size, fontWeight: weight, lineHeight: line }], false));
  assert.deepEqual(getFontEntries(inventory.snapshot())[0].variants!.map(variant => [variant.sizeCssPx, variant.fontWeight, variant.lineHeight]), [
    [12, 500, '18px'], [16, 400, '9px'], [16, 400, '30px'], [16, 400, 'normal'], [16, 700, '20px'], [null, null, ''],
  ]);
});

test('nested association arrays and variants stay detached from the collector, snapshots and sorted copies', () => {
  const inventory = new StyleInventory(); inventory.record('a', style(), [{ ...run(), lineHeight: 'normal' }], false);
  const snapshot = inventory.snapshot(), original = structuredClone(snapshot);
  const colors = getPaletteEntries(snapshot), fonts = getFontEntries(snapshot);
  colors[0].elementRefs!.push('changed');
  fonts[0].elementRefs!.push('changed'); fonts[0].sizes[0].elementRefs!.push('changed');
  fonts[0].variants![0].elementRefs!.push('changed'); fonts[0].variants![0].lineHeight = '99px';
  assert.deepEqual(snapshot, original);
  snapshot.paletteUsage![0].elementRefs!.push('snapshot-edit');
  snapshot.fontUsage![0].variants![0].elementRefs!.push('snapshot-edit');
  assert.deepEqual(inventory.snapshot(), original, 'Caller mutation never changes later collector snapshots');
});

test('association and variation inventories remain bounded by the scan limit', () => {
  const inventory = new StyleInventory();
  for (let index = 0; index < 1005; index++) inventory.record(`node-${index}`, style(), [{ ...run('#111', '#fff', index), lineHeight: `${index}px` }], false);
  const snapshot = inventory.snapshot(), font = getFontEntries(snapshot)[0];
  assert.equal(font.count, 1000); assert.equal(font.elementRefs!.length, 1000);
  assert.equal(font.sizes.length, 1000); assert.equal(font.variants!.length, 1000);
  assert.ok(snapshot.paletteUsage!.every(entry => entry.count === 1000 && entry.elementRefs!.length === 1000));
  const allRuns = Array.from({ length: 1005 }, (_, index) => ({ ...run(), id: `text-${index}`, elementRef: `node-${index}` }));
  assert.equal(getInventoryRuns({ runs: allRuns }, allRuns.map(item => item.elementRef)).length, 1000);
});
