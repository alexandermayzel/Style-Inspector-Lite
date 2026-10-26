import { transparentMask } from './mask-geometry';

interface Rect { left: number; top: number; width: number; height: number }
interface Clip extends Rect { x: boolean; y: boolean }
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const boxDisplays = new Set(['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid']);
const px = (raw: string): number | null => /^[+-]?(?:\d+\.?\d*|\.\d+)px$/.test(raw) && Number.isFinite(Number.parseFloat(raw)) ? Number.parseFloat(raw) : null;
const zeroOrNormal = (raw: string) => raw === 'normal' || px(raw) === 0;
const finiteRect = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const textProperties = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'fontStretch', 'fontSizeAdjust',
  'fontKerning', 'fontOpticalSizing', 'textRendering',
  'fontVariantCaps', 'fontVariantLigatures', 'fontVariantNumeric', 'fontVariantAlternates', 'fontVariantEastAsian',
  'fontVariantPosition', 'fontFeatureSettings', 'fontVariationSettings', 'letterSpacing', 'wordSpacing',
  'textTransform', 'textShadow', 'textEmphasisStyle', 'textDecorationLine', 'textDecorationStyle', 'textDecorationThickness'] as const;

function translationOnly(raw: string): boolean {
  if (raw === 'none') return true;
  const values = /^matrix\(([^()]*)\)$/.exec(raw)?.[1]?.split(',').map(Number);
  return !!values && values.length === 6 && values.every(Number.isFinite)
    && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1;
}

function simplePaint(style: CSSStyleDeclaration): boolean {
  return translationOnly(style.transform) && [style.translate, style.rotate, style.scale, style.perspective, style.offsetPath].every(value => value === 'none')
    // preserve-3d alone does not move the text plane. This check runs for
    // every ancestor: only 2D translations, with no perspective or individual
    // transforms, may reach the ink proof. Real 3D matrices remain unsupported.
    && ['normal', '1'].includes(style.zoom) && ['flat', 'preserve-3d'].includes(style.transformStyle)
    // Box shadows paint the element's box, not its glyphs. Outer and inset
    // shadows cannot make text outside an established overflow clip reappear.
    && style.filter === 'none' && style.backdropFilter === 'none'
    && style.textShadow === 'none' && style.textEmphasisStyle === 'none'
    && px(style.getPropertyValue('-webkit-text-stroke-width')) === 0;
}

function canvasTextRendering(raw: string): 'auto' | 'optimizeLegibility' | null {
  if (raw === 'auto') return 'auto';
  // CSS computed values are lowercase in Firefox; Canvas uses a camel-case enum.
  return raw === 'optimizelegibility' || raw === 'optimizeLegibility' ? 'optimizeLegibility' : null;
}

function normalText(style: CSSStyleDeclaration): boolean {
  return style.direction === 'ltr' && style.writingMode === 'horizontal-tb'
    && ['normal', 'isolate'].includes(style.unicodeBidi) && ['normal', 'nowrap', 'pre-line', 'pre', 'pre-wrap'].includes(style.whiteSpace)
    && style.textTransform === 'none' && ['normal', 'italic'].includes(style.fontStyle) && ['normal', '100%'].includes(style.fontStretch)
    && [style.fontVariantCaps, style.fontVariantLigatures, style.fontVariantNumeric, style.fontVariantAlternates,
      style.fontVariantEastAsian, style.fontVariantPosition, style.fontVariationSettings].every(value => value === 'normal')
    && (style.fontFeatureSettings === 'normal' || style.fontFeatureSettings === '"kern"' && style.fontKerning !== 'none')
    && style.fontSizeAdjust === 'none' && style.fontOpticalSizing === 'auto'
    && canvasTextRendering(style.textRendering) !== null && ['', 'normal'].includes(style.getPropertyValue('font-language-override'))
    && ['font-synthesis-weight', 'font-synthesis-style'].every(property => ['', 'auto'].includes(style.getPropertyValue(property)))
    // Range positions already include an absolute indent; glyph advances and
    // ink bounds still have to match before a real overflow clip can hide them.
    && zeroOrNormal(style.letterSpacing) && zeroOrNormal(style.wordSpacing) && px(style.textIndent) !== null
    && ['auto', 'normal', 'none'].includes(style.fontKerning);
}

const shapingSpace = (character: string) => /^[\t\r\n\f \u00a0]$/.test(character);

/** Adjacent unspaced text can shape as one ligature or kerning pair. */
function separatedBoundary(text: Text, raw: string, side: 'previousSibling' | 'nextSibling'): boolean {
  if (shapingSpace(side === 'previousSibling' ? raw[0]! : raw.at(-1)!)) return true;
  let node = text[side], examined = 0;
  while (node) {
    if (++examined > 16) return false;
    if (node.nodeType === 3) {
      const adjacent = node as Text;
      if (adjacent.length) return shapingSpace(adjacent.substringData(side === 'previousSibling' ? adjacent.length - 1 : 0, 1));
    } else if (node.nodeType !== 8) return false;
    node = node[side];
  }
  return true;
}

/** Match wrapped lines to ordinary text without guessing where the browser broke it. */
function wrappedLines(text: Text, raw: string, rects: readonly Rect[]): string[] | null {
  if (rects.length > 32 || rects.some((rect, index) => index > 0 && rect.top <= rects[index - 1]!.top)) return null;
  const range = text.ownerDocument.createRange();
  const spans = rects.map(() => ({ start: -1, end: -1 }));
  const near = (a: number, b: number) => Math.abs(a - b) < 0.02;
  let previous = 0;
  // Bounded by the caller's 4096-character limit. A character can have zero
  // advance after whitespace collapsing, but must still belong to one line.
  for (let offset = 0; offset < raw.length; offset++) {
    range.setStart(text, offset); range.setEnd(text, offset + 1);
    const boxes = range.getClientRects();
    if (boxes.length !== 1) return null;
    const box = boxes[0]!;
    const index = rects.findIndex(rect => near(box.top, rect.top) && near(box.height, rect.height)
      && box.left >= rect.left - 0.02 && box.right <= rect.left + rect.width + 0.02);
    if (index < previous || index > previous + 1) return null;
    const span = spans[index]!;
    if (span.start < 0) span.start = offset;
    span.end = offset + 1; previous = index;
  }
  const result: string[] = [];
  // An authored ASCII hyphen may end a naturally wrapped line. Its glyph is
  // already part of the measured span; unlike a synthetic hyphen or an
  // arbitrary word-internal break, it introduces no unmeasured character.
  // Exact Range boundaries and the subsequent Canvas/ink proof still apply.
  const knownBreak = (offset: number) => shapingSpace(raw[offset - 1]!) || shapingSpace(raw[offset]!) || raw[offset - 1] === '-';
  for (const [index, span] of spans.entries()) {
    if (span.start < 0 || span.end <= span.start
      || span.start > 0 && !knownBreak(span.start)
      || span.end < raw.length && !knownBreak(span.end)) return null;
    range.setStart(text, span.start); range.setEnd(text, span.end);
    const boxes = range.getClientRects(), rect = rects[index]!;
    if (boxes.length !== 1 || !(['left', 'top', 'width', 'height'] as const).every(key => near(boxes[0]![key], rect[key]))) return null;
    result.push(raw.slice(span.start, span.end));
  }
  return result;
}

/**
 * Only remove fragments proven completely clipped for simple ordinary text.
 * A Range measures font metrics, not glyph ink. Match those metrics to Canvas,
 * then include ink overhang and pixel rounding before testing a scrollport.
 * Unsupported typography/layout stays in the audit; never clip to the viewport.
 */
export function unclippedTextRects(element: Element, text: Text, rects: readonly Rect[]): Rect[] {
  const unchanged = () => [...rects];
  if (!rects.length || rects.length > 32 || !rects.every(finiteRect) || text.parentElement !== element || text.length > 4096
    || element.namespaceURI !== htmlNamespace || element.closest('input,textarea,select,[contenteditable]')) return unchanged();
  const document = element.ownerDocument, view = document.defaultView;
  if (!view || document.fonts?.status !== 'loaded') return unchanged();
  const style = view.getComputedStyle(element);
  // Preserved whitespace needs a bounded single-fragment subset. The raw-text
  // guards below keep breaks/tabs and pre spacing outside this ink proof.
  if (!normalText(style) || ['pre-line', 'pre', 'pre-wrap'].includes(style.whiteSpace) && rects.length !== 1) return unchanged();
  const clips: Clip[] = [];
  const masks: ((rect: Rect) => boolean)[] = [];
  const ancestors: { element: Element; style: CSSStyleDeclaration }[] = [];
  let needsContainingBlock = false, escaped = false, depth = 0, attemptedMasks = 0;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (++depth > 300 || current.namespaceURI !== htmlNamespace) return unchanged();
    const currentStyle = view.getComputedStyle(current);
    ancestors.push({ element: current, style: currentStyle });
    // An absolutely positioned box bypasses overflow between itself and its
    // containing block. A known positioned block inside the carousel restores
    // the normal ancestor clip chain; nested absolute boxes start it again.
    // Unknown/inline containing blocks are deliberately not used as proof.
    const hasBox = currentStyle.display !== 'contents';
    if (needsContainingBlock && hasBox && boxDisplays.has(currentStyle.display)
      && ['relative', 'absolute'].includes(currentStyle.position)) needsContainingBlock = false;
    // A fieldset clips its anonymous content box, not its visible legend.
    // Its border/client dimensions cannot prove clipping for every descendant.
    if (!escaped && !needsContainingBlock && current !== document.documentElement && current !== document.body && current.tagName !== 'FIELDSET'
      && boxDisplays.has(currentStyle.display)) {
      if (currentStyle.maskImage && !/^none(?:\s*,\s*none)*$/.test(currentStyle.maskImage.trim())) {
        if (++attemptedMasks > 8) return unchanged();
        const masked = transparentMask(current, currentStyle);
        if (masked) masks.push(masked);
      }
      const x = ['hidden', 'auto', 'scroll'].includes(currentStyle.overflowX);
      const y = ['hidden', 'auto', 'scroll'].includes(currentStyle.overflowY);
      if (x || y) {
        if (current.getClientRects().length !== 1) return unchanged();
        const box = current.getBoundingClientRect();
        const values = [box.left, box.top, current.clientLeft, current.clientTop, current.clientWidth, current.clientHeight];
        if (!values.every(Number.isFinite) || values.slice(2).some(value => value < 0)) return unchanged();
        // client dimensions are integers. Expand outwards so their rounding
        // cannot hide a narrow visible strip or a scrollbar-side fragment.
        clips.push({ left: box.left + current.clientLeft - 1, top: box.top + current.clientTop - 1,
          width: current.clientWidth + 2, height: current.clientHeight + 2, x, y });
      }
    }
    // Own clipping still applies to fixed/top-layer boxes, but do not recover
    // their ancestor clips from an ordinary positioned containing block.
    try { if (current.matches(':modal, :popover-open, :fullscreen')) escaped = true; }
    catch { escaped = true; }
    if (hasBox) {
      if (currentStyle.position === 'absolute') needsContainingBlock = true;
      else if (!['static', 'relative'].includes(currentStyle.position)) escaped = true;
    }
  }
  if (!clips.length && !masks.length) return unchanged();
  // The preserved pre-wrap subset is introduced only for mask proofs; keep
  // its existing overflow-only behavior until that separate layout is modeled.
  if (style.whiteSpace === 'pre-wrap' && !masks.length) return unchanged();
  // Measure only candidates whose layout box is already wholly outside a clip.
  const outside = (rect: Rect) => clips.some(clip => clip.x && (rect.left >= clip.left + clip.width || rect.left + rect.width <= clip.left)
    || clip.y && (rect.top >= clip.top + clip.height || rect.top + rect.height <= clip.top));
  // A font box can straddle a mask edge while all glyph ink is hidden. The
  // center is only a cheap candidate gate; removal needs the full ink proof.
  const mayBeMasked = (rect: Rect) => masks.some(mask => mask({ left: rect.left + rect.width / 2,
    top: rect.top + rect.height / 2, width: 0.001, height: 0.001 }));
  if (!rects.some(rect => outside(rect) || mayBeMasked(rect))) return unchanged();
  if (masks.length && ancestors.some(({ element: owner }) => owner.assignedSlot || owner.shadowRoot
    || (owner as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot)) return unchanged();
  // The expensive effect/pseudo/font proof runs only for a candidate that a
  // scrollport could wholly hide. Ordinary visible/offscreen text stops above.
  let decorationLeft = Infinity, decorationRight = -Infinity;
  for (const ancestor of ancestors) {
    if (!simplePaint(ancestor.style)) return unchanged();
    if (ancestor.style.textDecorationLine !== 'none') {
      // A solid strike spans the decorating box horizontally. Its vertical
      // position/thickness can depend on font metrics, so only a horizontal
      // clip may prove it hidden. Other line styles and fragmentation remain
      // unsupported; include the whole decorating box, not only glyph advance.
      if (ancestor.style.textDecorationLine !== 'line-through' || ancestor.style.textDecorationStyle !== 'solid'
        || ancestor.style.writingMode !== 'horizontal-tb' || rects.length !== 1) return unchanged();
      const boxes = ancestor.element.getClientRects();
      if (boxes.length !== 1 || !finiteRect(boxes[0]!)) return unchanged();
      decorationLeft = Math.min(decorationLeft, boxes[0]!.left);
      decorationRight = Math.max(decorationRight, boxes[0]!.left + boxes[0]!.width);
    }
    // These pseudo styles can change text metrics without a separate text node.
    for (const pseudo of ['::first-line', '::first-letter']) {
      const pseudoStyle = view.getComputedStyle(ancestor.element, pseudo);
      // Decorations propagate from their decorating box, rather than being
      // inherited as a first-line/letter computed value. A missing pseudo
      // strike adds no new paint; every other pseudo difference stays unsafe.
      if (textProperties.some(property => pseudoStyle[property] !== ancestor.style[property]
          && !(property === 'textDecorationLine' && ancestor.style.textDecorationLine === 'line-through'
            && ancestor.style.textDecorationStyle === 'solid' && pseudoStyle.textDecorationLine === 'none'))
        || ['font-language-override', 'font-synthesis-weight', 'font-synthesis-style'].some(property => pseudoStyle.getPropertyValue(property) !== ancestor.style.getPropertyValue(property))
        || pseudoStyle.getPropertyValue('-webkit-text-stroke-width') !== ancestor.style.getPropertyValue('-webkit-text-stroke-width')) return unchanged();
    }
  }
  // Read ordinary page text transiently for local ink bounds, never form values.
  // Restrict shaping to simple Latin/Cyrillic, ordinary punctuation and euro
  // prices. Currency still needs the same loaded-font, advance and ink proof.
  // combining marks, bidi controls and complex scripts stay visible.
  const raw = text.data;
  // Even a trailing break may leave only one positive Range rectangle. Never
  // turn preserved breaks or a form-feed control into an ordinary Canvas space.
  if (style.whiteSpace === 'pre-line' && /[\r\n\f]/.test(raw)) return unchanged();
  // Rolling counters use pre for each digit, even when most digits sit outside
  // their scrollport. Without collapsible whitespace, their metrics can use the
  // same exact proof. Never normalize or trim preserved pre spaces to fit it.
  if (['pre', 'pre-wrap'].includes(style.whiteSpace) && /[\t\r\n\f ]/.test(raw)) return unchanged();
  if (!/^[\x20-\x7e\u00a0-\u024f\u0400-\u052f\u2010-\u2027\u20ac\t\r\n\f]+$/.test(raw) || /\p{Mark}/u.test(raw)
    || !separatedBoundary(text, raw, 'previousSibling') || !separatedBoundary(text, raw, 'nextSibling')) return unchanged();
  const content = raw.replace(/[\t\r\n\f ]+/g, ' ');
  if (!content.replace(/ /g, '')) return unchanged();
  const wrapped = rects.length > 1;
  // Synthetic hyphens and arbitrary word-internal shaping need another model.
  if (wrapped && (!['none', 'manual'].includes(style.hyphens) || raw.includes('\u00ad'))) return unchanged();
  const size = px(style.fontSize);
  if (size === null || size <= 0 || !style.fontFamily || style.fontFamily.length > 512
    || !/^(?:[1-9]\d{0,2}|1000|normal|bold)$/.test(style.fontWeight)) return unchanged();
  // Canvas must measure the same italic glyphs, including their actual ink
  // overhang. Unsupported oblique angles still fail normalText above.
  const font = `${style.fontStyle === 'italic' ? 'italic ' : ''}${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (!document.fonts.check(font, content)) return unchanged();
  const families = style.fontFamily.split(',').map(family => family.trim());
  if (families.some(family => !/^(?:"[^"\\]+"|'[^'\\]+'|[\w -]+)$/.test(family))) return unchanged();
  const familyName = (family: string) => family.replace(/^(["'])(.*)\1$/, '$2').toLowerCase();
  let faces = 0;
  for (const face of document.fonts) {
    if (++faces > 128) return unchanged();
    if (families.some(family => familyName(family) === familyName(face.family))
      && [face.ascentOverride, face.descentOverride, face.lineGapOverride].some(value => value !== 'normal')) return unchanged();
  }
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return unchanged();
  context.font = font;
  context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.direction = 'ltr';
  const rendering = canvasTextRendering(style.textRendering)!;
  const explicitKerning = style.fontFeatureSettings === '"kern"';
  // Support only the independently representable kern-on feature. Explicit
  // kern-on with CSS font-kerning:none stays unsupported: legacy kern-table
  // synthesis can differ from OpenType feature selection in other fonts.
  const kerning = explicitKerning ? 'normal' : style.fontKerning as CanvasFontKerning;
  if ((rendering !== 'auto' || explicitKerning) && !('fontKerning' in context)) return unchanged();
  context.fontKerning = kerning;
  if (context.fontKerning !== kerning) return unchanged();
  if (rendering !== 'auto') {
    // Check before assigning: an unsupported property must not appear to work
    // merely because JavaScript permits an expando on a Canvas context.
    if (!('textRendering' in context)) return unchanged();
    context.textRendering = rendering;
    if (context.textRendering !== rendering) return unchanged();
  }
  if (!Number.isFinite(view.devicePixelRatio) || view.devicePixelRatio <= 0) return unchanged();
  const lines = wrapped ? wrappedLines(text, raw, rects) : [raw];
  if (!lines) return unchanged();
  return rects.filter((rect, index) => {
    if (!outside(rect) && !mayBeMasked(rect)) return true;
    const line = lines[index]!.replace(/[\t\r\n\f ]+/g, ' ');
    // CSS collapses spaces at line and text-node boundaries. Preserve every
    // width-matching interpretation and never trim nonbreaking spaces.
    const candidates = [...new Set([line, line.replace(/^ +/, ''), line.replace(/ +$/, ''), line.replace(/^ +| +$/g, '')])];
    let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity, matched = false;
    let inkLeft = Infinity, inkRight = -Infinity, inkTop = Infinity, inkBottom = -Infinity;
    for (const candidate of candidates) {
      const metrics = context.measureText(candidate);
      const values = [metrics.width, metrics.fontBoundingBoxAscent, metrics.fontBoundingBoxDescent,
        metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight, metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent];
      if (!values.every(Number.isFinite) || metrics.width <= 0 || metrics.fontBoundingBoxAscent <= 0 || metrics.fontBoundingBoxDescent < 0) return true;
      const widthError = Math.abs(metrics.width - rect.width);
      const heightError = Math.abs(metrics.fontBoundingBoxAscent + metrics.fontBoundingBoxDescent - rect.height);
      if (widthError > 1 || heightError > 1) continue;
      matched = true;
      const guard = Math.max(1, 1 / view.devicePixelRatio) + Math.max(widthError, heightError);
      const baseline = rect.top + metrics.fontBoundingBoxAscent;
      inkLeft = Math.min(inkLeft, rect.left - metrics.actualBoundingBoxLeft - guard);
      inkRight = Math.max(inkRight, rect.left + metrics.actualBoundingBoxRight + guard);
      inkTop = Math.min(inkTop, baseline - metrics.actualBoundingBoxAscent - guard);
      inkBottom = Math.max(inkBottom, baseline + metrics.actualBoundingBoxDescent + guard);
      // Every matching whitespace interpretation must be hidden. Taking the union
      // preserves a glyph whose overhang could still reach inside the scrollport.
      left = Math.min(left, Math.min(rect.left, rect.left - metrics.actualBoundingBoxLeft) - guard);
      right = Math.max(right, Math.max(rect.left + rect.width, rect.left + metrics.actualBoundingBoxRight) + guard);
      left = Math.min(left, decorationLeft - guard);
      right = Math.max(right, decorationRight + guard);
      // Wrapped lines and the whitespace-free pre subset have verified ink
      // positions. Empty font-box padding must not make an adjacent hidden
      // counter row look visible; real overhang and the rounding guard remain.
      const exactVerticalInk = wrapped || ['pre', 'pre-wrap'].includes(style.whiteSpace);
      top = Math.min(top, (exactVerticalInk ? baseline - metrics.actualBoundingBoxAscent : Math.min(rect.top, baseline - metrics.actualBoundingBoxAscent)) - guard);
      bottom = Math.max(bottom, (exactVerticalInk ? baseline + metrics.actualBoundingBoxDescent : Math.max(rect.top + rect.height, baseline + metrics.actualBoundingBoxDescent)) + guard);
    }
    if (!matched) return true;
    if (decorationLeft === Infinity && masks.some(mask => mask({ left: inkLeft, top: inkTop,
      width: inkRight - inkLeft, height: inkBottom - inkTop }))) return false;
    return !clips.some(clip => clip.x && (left >= clip.left + clip.width || right <= clip.left)
      || decorationLeft === Infinity && clip.y && (top >= clip.top + clip.height || bottom <= clip.top));
  });
}

export function textIsFullyClipped(element: Element, text: Text, rects: readonly Rect[]): boolean {
  return rects.length > 0 && unclippedTextRects(element, text, rects).length === 0;
}
