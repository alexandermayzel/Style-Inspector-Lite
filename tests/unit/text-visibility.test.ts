import test from 'node:test';
import assert from 'node:assert/strict';
import { textIsFullyClipped, unclippedTextRects } from '../../src/runtime/text-visibility';

const metrics = (width = 100, left = 0) => ({ width, fontBoundingBoxAscent: 14, fontBoundingBoxDescent: 4,
  actualBoundingBoxLeft: left, actualBoundingBoxRight: width, actualBoundingBoxAscent: 12, actualBoundingBoxDescent: 3 });

function fixture(raw: string, measure: (text: string) => ReturnType<typeof metrics> = () => metrics()) {
  const measured: string[] = [];
  const style: Record<string, string | ((property: string) => string)> = {
    direction: 'ltr', writingMode: 'horizontal-tb', unicodeBidi: 'normal', whiteSpace: 'nowrap', textTransform: 'none', fontStyle: 'normal', fontStretch: 'normal',
    fontVariantCaps: 'normal', fontVariantLigatures: 'normal', fontVariantNumeric: 'normal', fontVariantAlternates: 'normal', fontVariantEastAsian: 'normal', fontVariantPosition: 'normal',
    fontFeatureSettings: 'normal', fontVariationSettings: 'normal', fontSizeAdjust: 'none', fontOpticalSizing: 'auto', textRendering: 'auto',
    letterSpacing: 'normal', wordSpacing: 'normal', textIndent: '0px', fontKerning: 'auto', fontSize: '14px', fontFamily: 'Arial', fontWeight: '400',
    transform: 'none', translate: 'none', rotate: 'none', scale: 'none', perspective: 'none', offsetPath: 'none', zoom: '1', transformStyle: 'flat',
    filter: 'none', backdropFilter: 'none', boxShadow: 'none', textShadow: 'none', textEmphasisStyle: 'none', textDecorationLine: 'none', textDecorationStyle: 'solid', textDecorationThickness: 'auto',
    display: 'block', position: 'relative', overflowX: 'hidden', overflowY: 'hidden', hyphens: 'manual',
    getPropertyValue: property => property === '-webkit-text-stroke-width' ? '0px' : property.startsWith('font-synthesis-') ? 'auto' : '',
  };
  const canvas = { font: '', fontKerning: 'auto', textRendering: 'auto', measureText: (text: string) => { measured.push(text); return measure(text); } };
  const document = { documentElement: null, body: null,
    defaultView: { getComputedStyle: () => style, devicePixelRatio: 1 },
    fonts: Object.assign([], { status: 'loaded', check: (): boolean => true }),
    createElement: () => ({ getContext: () => canvas }),
    createRange: () => { throw new Error('Single-fragment proof must not remap text'); },
  };
  const box = { left: 0, top: 0, width: 100, height: 20 };
  const element = { namespaceURI: 'http://www.w3.org/1999/xhtml', tagName: 'DIV', parentElement: null, ownerDocument: document,
    clientLeft: 0, clientTop: 0, clientWidth: 100, clientHeight: 20, scrollLeft: 0, scrollTop: 0,
    closest: () => null, matches: () => false, getClientRects: () => [box], getBoundingClientRect: () => box };
  const text = { data: raw, length: raw.length, parentElement: element, ownerDocument: document,
    previousSibling: null as unknown, nextSibling: null as unknown };
  const hidden = (rect = { left: 150, top: 1, width: 100, height: 18 }) => textIsFullyClipped(element as unknown as Element, text as unknown as Text, [rect]);
  return { text, element, style, document, measured, hidden, box, canvas };
}

function positionedFixture() {
  const context = fixture('Countdown');
  context.style.position = 'absolute'; context.style.overflowX = 'visible'; context.style.overflowY = 'visible';
  context.box.left = 150;
  const styles = new Map<unknown, typeof context.style>([[context.element, context.style]]);
  let tail = context.element;
  const parent = (changes: Record<string, string> = {}, left = 0, width = 100) => {
    const box = { left, top: 0, width, height: 20 };
    const element = { ...context.element, parentElement: null, clientWidth: width, getClientRects: () => [box], getBoundingClientRect: () => box };
    const style = { ...context.style, position: 'static', textDecorationLine: 'none', ...changes };
    Object.assign(tail, { parentElement: element }); tail = element;
    styles.set(element, style);
    return { element, style, box };
  };
  Object.assign(context.document.defaultView, { getComputedStyle: (node: unknown) => styles.get(node) });
  return { ...context, parent };
}

test('guarded glyph ink can prove a zero-width overflowing helper wholly masked', () => {
  const context = fixture('…', () => ({ ...metrics(14, -2), actualBoundingBoxRight: 12, actualBoundingBoxAscent: 2, actualBoundingBoxDescent: 0 }));
  context.style.whiteSpace = 'pre-wrap'; context.style.overflowX = 'visible'; context.style.overflowY = 'visible'; context.style.display = 'inline-block';
  context.box.width = 0;
  const parentBox = { left: 0, top: 0, width: 200, height: 60 };
  const parent = { ...context.element, getClientRects: () => [parentBox], getBoundingClientRect: () => parentBox };
  const parentStyle = { ...context.style, display: 'block', maskImage: 'linear-gradient(to top, transparent 0%, transparent 20px, black 20px, black 100%), linear-gradient(to right, black 0%, black -21px, transparent 3px, transparent 100%)',
    maskSize: 'auto', maskPosition: '0% 0%', maskOrigin: 'border-box', maskClip: 'border-box', maskMode: 'match-source', maskComposite: 'add', maskRepeat: 'repeat' };
  Object.assign(context.element, { parentElement: parent });
  context.document.defaultView.getComputedStyle = (node?: unknown) => node === parent ? parentStyle : context.style;
  const rect = { left: 3.883, top: 40, width: 14, height: 18 };
  assert.equal(context.hidden(rect), true, 'Mask uses measured ink, not the zero-width owner or padded font box');
  assert.equal(context.hidden({ ...rect, left: 1 }), false, 'Glyph rounding guard reaches the visible fade');
  assert.equal(context.hidden({ ...rect, top: 25 }), false, 'Partially visible glyph stays');
  parentStyle.maskComposite = 'exclude'; assert.equal(context.hidden(rect), false);
  parentStyle.maskComposite = 'add'; context.style.textShadow = '1px 1px black'; assert.equal(context.hidden(rect), false);
  context.style.textShadow = 'none'; context.document.fonts.status = 'loading'; assert.equal(context.hidden(rect), false);
  context.document.fonts.status = 'loaded'; context.style.whiteSpace = 'pre-wrap'; context.text.data = '… '; context.text.length = 2;
  assert.equal(context.hidden(rect), false, 'Preserved spaces remain outside the single-glyph proof');
});

test('unsupported mask ancestors consume the same bounded proof budget', () => {
  const nested = (count: number) => {
    const context = fixture('helper');
    context.style.maskImage = 'url("unresolved-mask.svg")';
    let tail = context.element;
    for (let index = 1; index < count; index++) {
      const parent = { ...context.element, parentElement: null };
      Object.assign(tail, { parentElement: parent }); tail = parent;
    }
    return context;
  };
  assert.equal(nested(8).hidden(), true, 'Ordinary clipping proof can still succeed within the work budget');
  const overBudget = nested(9);
  assert.equal(overBudget.hidden(), false);
  assert.equal(overBudget.measured.length, 0, 'Unsupported mask attempts stop before Canvas work');
});

test('absolute text uses clips at and outside a proven positioned containing block', () => {
  const contained = positionedFixture();
  contained.parent({ position: 'relative' }, 150);
  contained.parent({ overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(contained.hidden(), true);
  assert.equal(contained.hidden({ left: 80, top: 1, width: 100, height: 18 }), false, 'Partly visible text survives');

  const ownBoundary = positionedFixture();
  ownBoundary.parent({ position: 'relative', overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(ownBoundary.hidden(), true, 'The containing block itself can clip its absolute child');

  const nested = positionedFixture();
  nested.parent({ position: 'relative' }, 150);
  nested.parent({ position: 'absolute' }, 150);
  nested.parent({ position: 'relative' }, 150);
  nested.parent({ position: 'relative', overflowX: 'hidden', transform: 'matrix(1, 0, 0, 1, -400, 0)' });
  assert.equal(nested.hidden(), true, 'Each absolute step must reconnect to its own containing block');
});

test('absolute text bypasses clips before its containing block and unknown boxes cannot restore them', () => {
  const escaped = positionedFixture();
  escaped.parent({ overflowX: 'hidden', overflowY: 'hidden' });
  escaped.parent({ position: 'relative' }, 0, 1000);
  assert.equal(escaped.hidden(), false);
  for (const display of ['contents', 'inline', 'table']) {
    const unknown = positionedFixture();
    unknown.parent({ display, position: 'relative' }, 150);
    unknown.parent({ overflowX: 'hidden', overflowY: 'hidden' });
    assert.equal(unknown.hidden(), false, display);
  }
});

test('fixed, sticky and top-layer ancestry never resumes clipping at an ordinary positioned ancestor', () => {
  for (const position of ['fixed', 'sticky']) {
    const context = positionedFixture();
    context.style.position = position;
    context.parent({ position: 'relative', overflowX: 'hidden', overflowY: 'hidden' });
    assert.equal(context.hidden(), false, position);
    const nested = positionedFixture();
    nested.parent({ position });
    nested.parent({ position: 'relative', overflowX: 'hidden', overflowY: 'hidden' });
    assert.equal(nested.hidden(), false, `inside ${position}`);
  }
  for (const selectorBehavior of [() => true, () => { throw new Error('Unsupported selector'); }]) {
    const context = positionedFixture();
    const topLayer = context.parent({ position: 'relative' }, 150);
    topLayer.element.matches = selectorBehavior;
    context.parent({ position: 'relative', overflowX: 'hidden', overflowY: 'hidden' });
    assert.equal(context.hidden(), false, 'Top-layer or unknown ancestry cannot acquire a higher clip');
  }
});

test('solid horizontal strike text needs both the decorating box and glyph ink outside the horizontal clip', () => {
  const context = positionedFixture(); context.style.position = 'static'; context.style.textDecorationLine = 'line-through';
  context.parent({ overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(context.hidden(), true);
  context.box.left = 80;
  assert.equal(context.hidden(), false, 'The decorating box can still reach inside even when glyphs do not');
  context.box.left = 150;
  assert.equal(context.hidden({ left: 80, top: 1, width: 100, height: 18 }), false, 'Visible glyphs remain');
  assert.equal(context.hidden({ left: 0, top: 100, width: 100, height: 18 }), false, 'Unknown strike height never proves vertical clipping');
  for (const [property, value] of [['textDecorationLine', 'underline'], ['textDecorationStyle', 'wavy'], ['textDecorationStyle', 'dashed'], ['textShadow', '-150px 0 black'], ['filter', 'drop-shadow(-150px 0 black)']]) {
    const uncertain = positionedFixture(); uncertain.style.position = 'static'; uncertain.style.textDecorationLine = 'line-through';
    uncertain.style[property!] = value!; uncertain.parent({ overflowX: 'hidden', overflowY: 'hidden' });
    assert.equal(uncertain.hidden(), false, `${property}: ${value}`);
  }
  const ancestorStrike = positionedFixture(); ancestorStrike.style.position = 'static';
  ancestorStrike.parent({ textDecorationLine: 'line-through' }, 80);
  ancestorStrike.parent({ overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(ancestorStrike.hidden(), false, 'Propagated decorations include the entire decorating box');
});

test('italic glyph proof uses the same font style and preserves either ink overhang', () => {
  const context = fixture('Italic label'); context.style.fontStyle = 'italic';
  let checkedFont = '';
  Object.assign(context.document.fonts, { check: (font: string) => { checkedFont = font; return true; } });
  assert.equal(context.hidden(), true);
  assert.equal(context.canvas.font, 'italic 400 14px Arial');
  assert.equal(checkedFont, context.canvas.font);
  const left = fixture('Italic label', () => metrics(100, 60)); left.style.fontStyle = 'italic';
  assert.equal(left.hidden(), false, 'Italic ink may extend back to the left into the viewport');
  const right = fixture('Italic label', () => ({ ...metrics(), actualBoundingBoxRight: 180 })); right.style.fontStyle = 'italic';
  assert.equal(right.hidden({ left: -150, top: 1, width: 100, height: 18 }), false, 'Italic ink may extend to the right into the viewport');
  const mismatch = fixture('Italic label', () => metrics(90)); mismatch.style.fontStyle = 'italic';
  assert.equal(mismatch.hidden(), false);
  for (const fontStyle of ['oblique', 'oblique 10deg', 'unknown']) {
    const unsupported = fixture('Italic label'); unsupported.style.fontStyle = fontStyle;
    assert.equal(unsupported.hidden(), false);
    assert.equal(unsupported.measured.length, 0);
  }
});

test('noninherited pseudo strike values add no paint while new pseudo decorations and fonts stay uncertain', () => {
  for (const changed of [{ textDecorationLine: 'none' }, { textDecorationLine: 'underline' }, { textDecorationLine: 'none', fontStyle: 'italic' }, { textDecorationLine: 'none', textDecorationStyle: 'wavy' }]) {
    const context = positionedFixture(); context.style.position = 'static'; context.style.textDecorationLine = 'line-through';
    context.parent({ overflowX: 'hidden', overflowY: 'hidden' });
    const originalStyle = context.document.defaultView.getComputedStyle as (element: unknown) => typeof context.style;
    Object.assign(context.document.defaultView, { getComputedStyle: (element: unknown, pseudo?: string) => {
      const style = originalStyle(element);
      return pseudo && element === context.element ? { ...style, ...changed } : style;
    } });
    assert.equal(context.hidden(), Object.keys(changed).length === 1 && changed.textDecorationLine === 'none', JSON.stringify(changed));
  }
});

test('preserve-3d without depth permits planar clipping while 3D or perspective anywhere stays uncertain', () => {
  const planar = positionedFixture(); planar.style.transformStyle = 'preserve-3d'; planar.style.transform = 'matrix(1, 0, 0, 1, 0, 0)';
  planar.parent({ position: 'relative', transformStyle: 'preserve-3d', transform: 'matrix(1, 0, 0, 1, 20, 0)' }, 150);
  planar.parent({ overflowX: 'hidden', overflowY: 'hidden' });
  assert.equal(planar.hidden(), true);
  assert.equal(planar.hidden({ left: 80, top: 1, width: 100, height: 18 }), false);
  for (const change of [
    { transform: 'matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1)' },
    { transform: 'matrix(0.9, 0, 0, 1, 0, 0)' }, { perspective: '400px' },
    { translate: '0px 0px 10px' }, { rotate: 'y 20deg' }, { scale: '1 1 2' }, { offsetPath: 'path("M0 0L10 0")' },
  ]) for (const where of ['self', 'ancestor']) {
    const context = positionedFixture(); context.style.transformStyle = 'preserve-3d';
    const owner = context.parent({ position: 'relative' }, 150);
    context.parent({ overflowX: 'hidden', overflowY: 'hidden' });
    Object.assign(where === 'self' ? context.style : owner.style, change);
    assert.equal(context.hidden(), false, `${where}: ${JSON.stringify(change)}`);
  }
});

test('fully clipped adjacent text can retain its leading or trailing collapsed-space advance', () => {
  for (const raw of ['Example ', ' Example']) {
    const context = fixture(raw, value => metrics(value === raw ? 100 : 96));
    assert.equal(context.hidden(), true);
    assert.ok(context.measured.includes(raw));
    assert.ok(context.measured.length <= 4);
  }
});

test('ambiguous whitespace measurements retain text if either possible glyph overhang reaches the clip', () => {
  for (const reachesClip of [' M', 'M ']) {
    const context = fixture(' M ', value => metrics(value === ' M ' ? 104 : value === 'M' ? 96 : 100, value === reachesClip ? 60 : 0));
    assert.equal(context.hidden(), false, 'Every width-matching interpretation contributes to the ink union');
    assert.equal(context.measured.length, 4);
  }
});

test('nonbreaking spaces keep their advance and are not candidates for CSS edge collapsing', () => {
  const context = fixture('\u00a0Example\u00a0');
  assert.equal(context.hidden(), true);
  assert.deepEqual(context.measured, ['\u00a0Example\u00a0']);
});

test('bounded simple Cyrillic and typographic punctuation can be hidden while combining and bidi text remain uncertain', () => {
  for (const raw of ['Пример сообщения.', 'L’exemple — aperçu…', 'A'.repeat(4096)]) assert.equal(fixture(raw).hidden(), true);
  for (const raw of ['А\u0483', 'A\u0301', '\u2068Пример\u2069', 'مرحبا']) {
    const context = fixture(raw);
    assert.equal(context.hidden(), false);
    assert.equal(context.measured.length, 0);
  }
  const overLimit = fixture('A'.repeat(4097));
  Object.defineProperty(overLimit.text, 'data', { get() { throw new Error('Over-limit text must not be read'); } });
  assert.equal(overLimit.hidden(), false);
});

test('euro prices permit clipped-ink proof without weakening font, effect or shaping checks', () => {
  for (const raw of ['185€ p.P.', '€ 34,90', '33.998\u00a0€']) {
    const context = fixture(raw);
    assert.equal(context.hidden(), true, raw);
    assert.ok(context.measured.includes(raw), 'The actual currency glyph must be measured');
    assert.equal(context.hidden({ left: 80, top: 1, width: 100, height: 18 }), false, 'Visible currency ink remains included');
  }
  assert.equal(fixture('185€', () => metrics(90)).hidden(), false, 'Mismatched fallback-font dimensions remain uncertain');
  assert.equal(fixture('185€', () => metrics(100, 60)).hidden(), false, 'Currency ink overhang can reach the visible clip');
  const unavailable = fixture('185€'); unavailable.document.fonts.check = () => false;
  assert.equal(unavailable.hidden(), false);
  const shadow = fixture('185€'); shadow.style.textShadow = '-100px 0 black';
  assert.equal(shadow.hidden(), false);
  for (const raw of ['185€\u0301', '\u2068185€\u2069', '185€\uFE0F']) {
    const context = fixture(raw);
    assert.equal(context.hidden(), false);
    assert.equal(context.measured.length, 0, 'Unsupported combining, bidi and presentation sequences remain excluded from the proof');
  }
});

test('unspaced text and inline-element boundaries retain possible cross-node ligatures and kerning', () => {
  const adjacent = (data: string) => ({ nodeType: 3, length: data.length, substringData: (start: number, count: number) => data.slice(start, start + count) });
  const ligature = fixture('f'); ligature.text.nextSibling = adjacent('i');
  assert.equal(ligature.hidden(), false);
  const kerning = fixture('V'); kerning.text.previousSibling = adjacent('A');
  assert.equal(kerning.hidden(), false);
  const hyphenEnd = fixture('Over-'); hyphenEnd.text.nextSibling = adjacent('ear');
  assert.equal(hyphenEnd.hidden(), false, 'An authored hyphen does not prove independent shaping across text nodes');
  const hyphenStart = fixture('ear'); hyphenStart.text.previousSibling = adjacent('Over-');
  assert.equal(hyphenStart.hidden(), false);
  const inline = fixture('Example'); inline.text.nextSibling = { nodeType: 1 };
  assert.equal(inline.hidden(), false);
  const separated = fixture('Example'); separated.text.previousSibling = adjacent('Previous '); separated.text.nextSibling = adjacent(' next');
  assert.equal(separated.hidden(), true);
});

test('unloaded fonts, mismatching dimensions and unknown ink bounds remain visible', () => {
  const unloaded = fixture('Example'); unloaded.document.fonts.status = 'loading'; assert.equal(unloaded.hidden(), false);
  assert.equal(fixture('Example', () => metrics(90)).hidden(), false);
  assert.equal(fixture('Example', () => ({ ...metrics(), actualBoundingBoxLeft: NaN })).hidden(), false);
  const variable = fixture('Example'); variable.style.fontVariationSettings = '"wght" 450'; assert.equal(variable.hidden(), false);
});

test('supported text rendering and isolated kern-on use matching native Canvas settings', () => {
  for (const textRendering of ['auto', 'optimizelegibility', 'optimizeLegibility']) {
    for (const fontFeatureSettings of ['normal', '"kern"']) for (const fontKerning of ['auto', 'normal', 'none']) {
      if (fontFeatureSettings === '"kern"' && fontKerning === 'none') continue;
      const context = fixture('AVATAR Ta We office ffi');
      Object.assign(context.style, { textRendering, fontFeatureSettings, fontKerning });
      assert.equal(context.hidden(), true, `${textRendering}/${fontFeatureSettings}/${fontKerning}`);
      assert.equal(context.canvas.textRendering, textRendering === 'auto' ? 'auto' : 'optimizeLegibility');
      assert.equal(context.canvas.fontKerning, fontFeatureSettings === '"kern"' ? 'normal' : fontKerning);
    }
  }
});

test('unsupported font features, rendering modes and conflicting kern synthesis remain conservative', () => {
  for (const changes of [
    { textRendering: 'optimizespeed' }, { textRendering: 'geometricprecision' }, { textRendering: 'unknown' },
    { fontFeatureSettings: '"kern" 0' }, { fontFeatureSettings: '"liga"' }, { fontFeatureSettings: '"kern", "liga" 0' },
    { fontFeatureSettings: '"kern"', fontKerning: 'none' },
  ]) {
    const context = fixture('AVATAR Ta We office ffi'); Object.assign(context.style, changes);
    assert.equal(context.hidden(), false, JSON.stringify(changes));
    assert.equal(context.measured.length, 0);
  }
});

test('new Canvas modes require native properties and successful readback without creating expandos', () => {
  for (const property of ['fontKerning', 'textRendering'] as const) {
    const missing = fixture('AVATAR Ta We office ffi');
    Object.assign(missing.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility' });
    Reflect.deleteProperty(missing.canvas, property);
    assert.equal(missing.hidden(), false, `Missing ${property}`);
    assert.equal(property in missing.canvas, false, 'An absent native property must not be assigned');
    assert.equal(missing.measured.length, 0);
    const ignored = fixture('AVATAR Ta We office ffi');
    Object.assign(ignored.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility' });
    Object.defineProperty(ignored.canvas, property, { get: () => 'auto', set: () => {} });
    assert.equal(ignored.hidden(), false, `Ignored ${property}`);
    assert.equal(ignored.measured.length, 0);
  }
});

test('matched rendering modes still require glyph metrics, safe paint and matching pseudo styles', () => {
  const mismatch = fixture('AVATAR Ta We office ffi', () => metrics(90));
  Object.assign(mismatch.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility' });
  assert.equal(mismatch.hidden(), false);
  const overhang = fixture('AVATAR Ta We office ffi', () => metrics(100, 60));
  Object.assign(overhang.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility' });
  assert.equal(overhang.hidden(), false, 'Actual ink can still reach the clipping area');
  const shadow = fixture('AVATAR Ta We office ffi');
  Object.assign(shadow.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility', textShadow: '-100px 0 white' });
  assert.equal(shadow.hidden(), false);
  for (const change of [{ textRendering: 'auto' }, { fontFeatureSettings: 'normal' }]) {
    const pseudo = fixture('AVATAR Ta We office ffi');
    Object.assign(pseudo.style, { fontFeatureSettings: '"kern"', textRendering: 'optimizelegibility' });
    Object.assign(pseudo.document.defaultView, { getComputedStyle: (_element: unknown, selector?: string) => selector ? { ...pseudo.style, ...change } : pseudo.style });
    assert.equal(pseudo.hidden(), false, `Different pseudo metrics: ${JSON.stringify(change)}`);
    assert.equal(pseudo.measured.length, 0);
  }
});

test('single-fragment pre-line text uses verified collapsed-space metrics and keeps visible ink', () => {
  for (const raw of ['20:04', '  20:04\t ', '20:\t 04']) {
    const normalized = raw.replace(/[\t ]+/g, ' ');
    const context = fixture(raw, value => metrics(value === normalized ? 100 : 96)); context.style.whiteSpace = 'pre-line';
    assert.equal(context.hidden(), true, raw);
    assert.ok(context.measured.includes(normalized));
    assert.equal(context.hidden({ left: 80, top: 1, width: 100, height: 18 }), false, 'A partially visible time remains');
    context.style.overflowX = 'visible'; context.style.overflowY = 'visible';
    assert.equal(context.hidden(), false, 'Offscreen position without an overflow clip cannot hide text');
  }
  const nbsp = fixture('\u00a020:04\u00a0'); nbsp.style.whiteSpace = 'pre-line';
  assert.equal(nbsp.hidden(), true);
  assert.deepEqual(nbsp.measured, ['\u00a020:04\u00a0'], 'Nonbreaking spaces must not be trimmed');
});

test('pre-line preserved breaks, controls and multiple fragments remain outside the clipping proof', () => {
  for (const raw of ['20:04\n', '\n20:04', '20:\n04', '20:04\r', '20:04\r\n', '20:04\f', '20:04\u0085', '20:04\u2028', '20:04\u2029']) {
    const context = fixture(raw); context.style.whiteSpace = 'pre-line';
    assert.equal(context.hidden(), false, JSON.stringify(raw));
    assert.equal(context.measured.length, 0, 'A single positive Range box does not make preserved breaks safe to collapse');
  }
  const wrapped = wrappedFixture(); wrapped.style.whiteSpace = 'pre-line';
  assert.deepEqual(wrapped.visible(), wrapped.rects);
  assert.equal(wrapped.calls(), 0, 'Multiple pre-line fragments do not enter the wrapped-line mapper');
  for (const whiteSpace of ['pre-wrap', 'break-spaces']) {
    const unsupported = fixture('20:04'); unsupported.style.whiteSpace = whiteSpace;
    assert.equal(unsupported.hidden(), false, whiteSpace);
  }
});

test('pre-line keeps the metric, overhang, effect and adjacent-text safeguards', () => {
  const mismatch = fixture('20:04', () => metrics(90)); mismatch.style.whiteSpace = 'pre-line';
  assert.equal(mismatch.hidden(), false);
  const overhang = fixture('20:04', () => metrics(100, 60)); overhang.style.whiteSpace = 'pre-line';
  assert.equal(overhang.hidden(), false);
  const shadow = fixture('20:04'); shadow.style.whiteSpace = 'pre-line'; shadow.style.textShadow = '-100px 0 white';
  assert.equal(shadow.hidden(), false);
  const adjacent = fixture('20:04'); adjacent.style.whiteSpace = 'pre-line';
  adjacent.text.nextSibling = { nodeType: 3, length: 2, substringData: (start: number, count: number) => 'PM'.slice(start, start + count) };
  assert.equal(adjacent.hidden(), false);
  for (const whiteSpace of ['pre', 'nowrap']) {
    const context = fixture('20:04'); context.style.whiteSpace = 'pre-line';
    const ancestor = { ...context.element, parentElement: null }, ancestorStyle = { ...context.style, whiteSpace };
    Object.assign(context.element, { parentElement: ancestor });
    Object.assign(context.document.defaultView, { getComputedStyle: (node: unknown) => node === ancestor ? ancestorStyle : context.style });
    assert.equal(context.hidden(), true, `Explicit child pre-line overrides ancestor ${whiteSpace}`);
  }
});

test('single-fragment pre digits are omitted only outside a proven overflow clip', () => {
  for (const raw of ['7', '42', '\u00a07\u00a0']) {
    const context = fixture(raw); context.style.whiteSpace = 'pre';
    assert.equal(context.hidden(), true);
    assert.deepEqual(context.measured, [raw], 'Pre content reaches Canvas unchanged');
    assert.equal(context.hidden({ left: 0, top: -30, width: 100, height: 18 }), true);
    assert.equal(context.hidden({ left: 0, top: 30, width: 100, height: 18 }), true);
    assert.equal(context.hidden({ left: 0, top: 1, width: 100, height: 18 }), false);
    assert.equal(context.hidden({ left: 0, top: 19, width: 100, height: 18 }), false, 'Partly visible digits remain');
    context.style.overflowX = 'visible'; context.style.overflowY = 'visible';
    assert.equal(context.hidden(), false, 'Offscreen content without clipping remains');
  }
});

test('pre spaces, preserved controls and multiple fragments are never normalized into a clipping proof', () => {
  for (const raw of [' 7', '7 ', '7 7', '7  7', '\t7', '7\n', '\n7', '7\r', '7\f']) {
    const context = fixture(raw); context.style.whiteSpace = 'pre';
    assert.equal(context.hidden(), false, JSON.stringify(raw));
    assert.equal(context.measured.length, 0);
  }
  const wrapped = wrappedFixture(); wrapped.style.whiteSpace = 'pre';
  assert.deepEqual(wrapped.visible(), wrapped.rects);
  assert.equal(wrapped.calls(), 0);
});

test('adjacent pre counter rows use verified ink while retaining overhang across the clip edge', () => {
  const above = { left: 0, top: -19, width: 100, height: 18 }, below = { left: 0, top: 21, width: 100, height: 18 };
  const context = fixture('7'); context.style.whiteSpace = 'pre';
  assert.equal(context.hidden(above), true, 'Only empty font-box padding approaches the top edge');
  assert.equal(context.hidden(below), true, 'Only empty font-box padding approaches the bottom edge');
  const descendingInk = fixture('7', () => ({ ...metrics(), actualBoundingBoxDescent: 7 })); descendingInk.style.whiteSpace = 'pre';
  assert.equal(descendingInk.hidden(above), false, 'Ink reaching below the top clip remains');
  const ascendingInk = fixture('7', () => ({ ...metrics(), actualBoundingBoxAscent: 24 })); ascendingInk.style.whiteSpace = 'pre';
  assert.equal(ascendingInk.hidden(below), false, 'Ink reaching above the bottom clip remains');
});

test('pre digits retain metric, ink-overhang, effect and shaping safeguards', () => {
  const mismatch = fixture('7', () => metrics(90)); mismatch.style.whiteSpace = 'pre';
  assert.equal(mismatch.hidden(), false);
  const overhang = fixture('7', () => ({ ...metrics(), actualBoundingBoxAscent: 80 })); overhang.style.whiteSpace = 'pre';
  assert.equal(overhang.hidden({ left: 0, top: 30, width: 100, height: 18 }), false, 'Ink can extend back into the clip');
  for (const property of ['textShadow', 'filter']) {
    const effect = fixture('7'); effect.style.whiteSpace = 'pre'; effect.style[property] = property === 'filter' ? 'blur(10px)' : '0 -30px white';
    assert.equal(effect.hidden(), false, property);
  }
  const adjacent = fixture('7'); adjacent.style.whiteSpace = 'pre';
  adjacent.text.nextSibling = { nodeType: 3, length: 1, substringData: () => '8' };
  assert.equal(adjacent.hidden(), false);
});

test('box shadows on a clipping box or its ancestor cannot reveal fully clipped glyphs', () => {
  for (const boxShadow of ['0px 2px 4px rgba(0, 0, 0, 0.5)', 'inset 0px 0px 8px black']) {
    for (const owner of ['self', 'ancestor']) {
      const context = fixture('Hidden preview ');
      if (owner === 'self') context.style.boxShadow = boxShadow;
      else {
        const ancestor = { ...context.element, parentElement: null };
        const ancestorStyle = { ...context.style, boxShadow, overflowX: 'visible', overflowY: 'visible' };
        Object.assign(context.element, { parentElement: ancestor });
        Object.assign(context.document.defaultView, { getComputedStyle: (node: unknown) => node === ancestor ? ancestorStyle : context.style });
      }
      assert.equal(context.hidden(), true, `${owner}: ${boxShadow}`);
      assert.equal(context.hidden({ left: 80, top: 1, width: 100, height: 18 }), false, 'Partly visible glyphs remain');
      context.style.overflowX = 'visible'; context.style.overflowY = 'visible';
      assert.equal(context.hidden(), false, 'Box shadows do not establish a clip by themselves');
    }
  }
  for (const [property, value] of [['textShadow', '-100px 0 white'], ['filter', 'drop-shadow(-100px 0 white)'], ['backdropFilter', 'blur(2px)']]) {
    const context = fixture('Hidden preview '); context.style.boxShadow = '0 2px 4px black'; context.style[property!] = value!;
    assert.equal(context.hidden(), false, `${property} remains conservative`);
  }
});

test('finite pixel indentation permits exclusion only when overflow completely clips the measured glyphs', () => {
  for (const [indent, left] of [['-9999px', -150], ['9999px', 150], ['-150.5px', -150]] as const) {
    const context = fixture('Search'); context.style.textIndent = indent;
    assert.equal(context.hidden({ left, top: 1, width: 100, height: 18 }), true);
  }
  const partial = fixture('Search'); partial.style.textIndent = '-50px';
  assert.equal(partial.hidden({ left: -50, top: 1, width: 100, height: 18 }), false);
  const visibleOverflow = fixture('Search'); visibleOverflow.style.textIndent = '-9999px';
  visibleOverflow.style.overflowX = 'visible'; visibleOverflow.style.overflowY = 'visible';
  assert.equal(visibleOverflow.hidden({ left: -150, top: 1, width: 100, height: 18 }), false);
  assert.equal(visibleOverflow.hidden({ left: 2000, top: 1, width: 100, height: 18 }), false, 'Viewport position alone never proves clipping');
});

test('indented text retains unsupported indent syntax and paint that could reach back into the visible area', () => {
  for (const indent of ['-100%', 'calc(-100% - 20px)', '-9999px hanging', '-9999px each-line', 'Infinitypx', 'NaNpx']) {
    const context = fixture('Search'); context.style.textIndent = indent;
    assert.equal(context.hidden(), false, indent);
    assert.equal(context.measured.length, 0);
  }
  const shadow = fixture('Search'); shadow.style.textIndent = '-9999px'; shadow.style.textShadow = '9999px 0 white';
  assert.equal(shadow.hidden({ left: -150, top: 1, width: 100, height: 18 }), false);
  const overhang = fixture('Search', () => metrics(100, 60)); overhang.style.textIndent = '150px';
  assert.equal(overhang.hidden(), false, 'The glyph ink can reach the clip even when its indented advance box does not');
});

function wrappedFixture(measure: (text: string) => ReturnType<typeof metrics> = () => metrics(), lines = ['One ', 'Two ', 'Six']) {
  const context = fixture(lines.join(''), measure);
  context.style.whiteSpace = 'normal';
  const rects = lines.map((_, index) => ({ left: 0, top: 1 + index * 20, width: 100, height: 18 }));
  let offset = 0;
  const spans = lines.map(line => { const start = offset; offset += line.length; return { start, end: offset }; });
  let calls = 0, ambiguous = false;
  Object.assign(context.document, { createRange() {
    let start = 0, end = 0;
    return {
      setStart(_text: unknown, offset: number) { start = offset; },
      setEnd(_text: unknown, offset: number) { end = offset; },
      getClientRects() {
        calls++;
        const index = spans.findIndex(span => start >= span.start && start < span.end), rect = rects[index]!;
        const { start: lineStart, end: lineEnd } = spans[index]!;
        const left = (start - lineStart) / (lineEnd - lineStart) * 100;
        const width = (end - start) / (lineEnd - lineStart) * 100;
        const result = { ...rect, left, width, right: left + width };
        return ambiguous ? [result, result] : [result];
      },
    };
  } });
  const visible = () => unclippedTextRects(context.element as unknown as Element, context.text as unknown as Text, rects);
  return { ...context, rects, visible, calls: () => calls, ambiguous() { ambiguous = true; } };
}

test('wrapped clipped lines retain one visible fragment and discard only verified hidden glyphs', () => {
  const context = wrappedFixture();
  assert.deepEqual(context.visible(), [context.rects[0]]);
  assert.equal(context.rects.length, 3, 'Source rectangles are immutable');
  assert.ok(context.measured.some(value => value.startsWith('Two')));
  assert.ok(context.calls() <= context.text.length + context.rects.length);
});

test('authored ASCII hyphen wraps use actual character spans before excluding hidden lines', () => {
  for (const lines of [['Over-', 'ear ', 'headphones'], ['Visible ', 'Noise-', 'Cancelling'], ['Model WH-', '1000XM6 ', 'headphones']]) {
    const context = wrappedFixture(undefined, lines);
    assert.deepEqual(context.visible(), [context.rects[0]], lines.join('|'));
    assert.ok(context.measured.includes(lines[1]!), 'Canvas measures the actual hidden fragment, including any authored hyphen');
    assert.ok(context.calls() <= context.text.length + context.rects.length);
    context.element.clientHeight = 80;
    assert.deepEqual(context.visible(), context.rects, 'Expanding the clip restores every line');
  }
});

test('arbitrary word-internal breaks and unsupported hyphens preserve every wrapped fragment', () => {
  for (const lines of [['Over', 'ear ', 'headphones'], ['Over', '-ear ', 'headphones'], ['Over\u2010', 'ear ', 'headphones']]) {
    const context = wrappedFixture(undefined, lines);
    assert.deepEqual(context.visible(), context.rects, lines.join('|'));
    assert.equal(context.measured.length, 0, 'Unknown wrap boundaries never reach a per-line ink assertion');
  }
  const soft = wrappedFixture(undefined, ['Over\u00ad', 'ear ', 'headphones']);
  assert.deepEqual(soft.visible(), soft.rects);
  assert.equal(soft.calls(), 0);
  const automatic = wrappedFixture(undefined, ['Over-', 'ear ', 'headphones']); automatic.style.hyphens = 'auto';
  assert.deepEqual(automatic.visible(), automatic.rects);
  assert.equal(automatic.calls(), 0);
});

test('hyphen wraps retain mismatched metrics, visible ink overhang and ambiguous character geometry', () => {
  const lines = ['Over-', 'ear ', 'headphones'];
  const mismatch = wrappedFixture(() => metrics(90), lines);
  assert.deepEqual(mismatch.visible(), mismatch.rects, 'A known wrap cannot replace Canvas advance matching');
  const overhang = wrappedFixture(() => ({ ...metrics(), actualBoundingBoxAscent: 30 }), lines);
  assert.deepEqual(overhang.visible(), overhang.rects.slice(0, 2), 'Hidden font boxes can still have visible glyph ink');
  const partial = wrappedFixture(undefined, lines); partial.element.clientHeight = 24;
  assert.deepEqual(partial.visible(), partial.rects.slice(0, 2));
  const ambiguous = wrappedFixture(undefined, lines); ambiguous.ambiguous();
  assert.deepEqual(ambiguous.visible(), ambiguous.rects);
  const shadow = wrappedFixture(undefined, lines); shadow.style.textShadow = '0 -20px white';
  assert.deepEqual(shadow.visible(), shadow.rects);
  assert.equal(shadow.calls(), 0, 'Paint effects still stop the proof before character measurement');
});

test('partial wrapped lines and glyph overhang remain measured', () => {
  const partial = wrappedFixture(); partial.element.clientHeight = 24;
  assert.deepEqual(partial.visible(), partial.rects.slice(0, 2));
  const overhang = wrappedFixture(() => ({ ...metrics(), actualBoundingBoxAscent: 30 }));
  assert.deepEqual(overhang.visible(), overhang.rects.slice(0, 2), 'Actual ink can reach a clip from a hidden layout box');
  const uncertain = wrappedFixture(() => metrics(90));
  assert.deepEqual(uncertain.visible(), uncertain.rects, 'Unmatched Canvas widths cannot remove fragments');
});

test('wrapped fragments need real clipping and are recomputed after expansion', () => {
  const context = wrappedFixture();
  assert.equal(context.visible().length, 1);
  context.element.clientHeight = 80;
  assert.deepEqual(context.visible(), context.rects);
  context.element.clientHeight = 20; context.style.overflowY = 'visible'; context.style.overflowX = 'visible';
  assert.deepEqual(context.visible(), context.rects);
});

test('ambiguous wrapped layout, hyphenation and effects preserve all fragments', () => {
  const ambiguous = wrappedFixture(); ambiguous.ambiguous(); assert.deepEqual(ambiguous.visible(), ambiguous.rects);
  const columns = wrappedFixture(); columns.rects[2]!.top = 1; assert.deepEqual(columns.visible(), columns.rects);
  for (const [property, value] of [['hyphens', 'auto'], ['textShadow', '0 -20px black'], ['fontVariationSettings', '"wght" 500']]) {
    const context = wrappedFixture(); context.style[property!] = value!;
    assert.deepEqual(context.visible(), context.rects, `${property}: ${value}`);
    assert.equal(context.calls(), 0, 'Reject unsupported rendering before per-character layout work');
  }
  const softHyphen = wrappedFixture(); softHyphen.text.data = 'One Tw\u00ado Six'; softHyphen.text.length++;
  assert.deepEqual(softHyphen.visible(), softHyphen.rects);
  assert.equal(softHyphen.calls(), 0);
});

test('wrapped text within its clip or over the work limit never reads character geometry', () => {
  const visible = wrappedFixture(); visible.element.clientHeight = 100;
  assert.deepEqual(visible.visible(), visible.rects); assert.equal(visible.calls(), 0);
  const long = wrappedFixture(); long.text.length = 4097;
  Object.defineProperty(long.text, 'data', { get() { throw new Error('Must not read over-limit text'); } });
  assert.deepEqual(long.visible(), long.rects); assert.equal(long.calls(), 0);
});
