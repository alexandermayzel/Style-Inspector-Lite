import { parseColor } from '../core/colors';
import { absolutePseudoIsSeparated } from './absolute-pseudo-geometry';

interface Rect { left: number; top: number; width: number; height: number }
interface Geometry { rects: Rect[]; limited: boolean }
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const pxPattern = /^[+-]?(?:\d+\.?\d*|\.\d+)px$/;
const px = (raw: string): number | null => pxPattern.test(raw) && Number.isFinite(Number.parseFloat(raw)) ? Number.parseFloat(raw) : null;
const zeroOrNormal = (raw: string) => raw === 'normal' || px(raw) === 0;
const normal = (raw: string) => raw === 'normal';
const finiteRect = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const collapseSpaces = (text: string) => text.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ +| +$/g, '');

function translationOnly(raw: string): boolean {
  if (raw === 'none') return true;
  const match = /^matrix\(([^()]*)\)$/.exec(raw);
  if (!match) return false;
  const values = match[1]!.split(',').map(value => Number(value.trim()));
  return values.length === 6 && values.every(Number.isFinite)
    && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1;
}

function unchangedCoordinates(style: CSSStyleDeclaration, translation = false): boolean {
  return (translation ? translationOnly(style.transform) : style.transform === 'none')
    && style.translate === 'none' && style.rotate === 'none' && style.scale === 'none'
    && style.perspective === 'none' && style.offsetPath === 'none'
    && ['1', 'normal'].includes(style.zoom);
}

/** A centered half-turn keeps the border box and only reflects horizontal ink. */
function centeredHalfTurn(style: CSSStyleDeclaration, width: number): boolean {
  const matrix = /^matrix\(([^()]*)\)$/.exec(style.transform)?.[1]?.split(',').map(Number);
  const origin = style.transformOrigin?.split(/\s+/).map(px);
  return !!matrix && matrix.length === 6 && matrix.every((value, index) => value === [-1, 0, 0, -1, 0, 0][index])
    && !!origin && [2, 3].includes(origin.length) && origin.every(value => value !== null)
    && Math.abs(origin[0]! - width / 2) <= 0.001 && (origin.length === 2 || origin[2] === 0)
    && ['border-box', 'view-box'].includes(style.transformBox)
    && style.translate === 'none' && style.rotate === 'none' && style.scale === 'none'
    && style.perspective === 'none' && style.offsetPath === 'none' && ['1', 'normal'].includes(style.zoom)
    && style.boxShadow === 'none';
}

function normalText(style: CSSStyleDeclaration): boolean {
  return style.direction === 'ltr' && style.writingMode === 'horizontal-tb'
    && ['normal', 'isolate'].includes(style.unicodeBidi)
    && ['normal', 'nowrap'].includes(style.whiteSpace) && style.textTransform === 'none'
    && style.fontStyle === 'normal' && ['normal', '100%'].includes(style.fontStretch)
    && [style.fontVariantCaps, style.fontVariantLigatures, style.fontVariantNumeric, style.fontVariantAlternates,
      style.fontVariantEastAsian, style.fontVariantPosition, style.fontFeatureSettings, style.fontVariationSettings].every(normal)
    && style.fontSizeAdjust === 'none' && style.fontOpticalSizing === 'auto'
    && zeroOrNormal(style.letterSpacing) && zeroOrNormal(style.wordSpacing) && px(style.textIndent) === 0
    && style.textShadow === 'none' && style.textEmphasisStyle === 'none'
    && px(style.getPropertyValue('-webkit-text-stroke-width')) === 0;
}

function singleRect(element: Element): Rect | null {
  if (element.getClientRects().length !== 1) return null;
  const rect = element.getBoundingClientRect();
  return finiteRect(rect) ? rect : null;
}

function horizontalBox(style: CSSStyleDeclaration) {
  const values = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth,
    style.marginLeft, style.marginRight, style.marginTop, style.marginBottom].map(px);
  if (values.some(value => value === null || value < 0)) return null;
  return { padding: values[0]! + values[1]!, border: values[2]! + values[3]!,
    paddingLeft: values[0]!, paddingRight: values[1]!, borderLeft: values[2]!, borderRight: values[3]!,
    marginLeft: values[4]!, marginRight: values[5]! };
}

function directText(element: Element): string | null {
  if (element.childNodes.length > 64) return null;
  let found: string | null = null;
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE || !child.nodeValue?.trim()) continue;
    if (found !== null || child.nodeValue.length > 256
      || /[\u0000-\u0008\u000b\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/.test(child.nodeValue)) return null;
    found = child.nodeValue;
  }
  return found;
}

function measureText(document: Document, context: CanvasRenderingContext2D, style: CSSStyleDeclaration, text: string): TextMetrics | null {
  const size = px(style.fontSize);
  if (!normalText(style) || !style.fontFamily || style.fontFamily.length > 512 || size === null || size <= 0) return null;
  if (!/^(?:[1-9]\d{0,2}|1000|normal|bold)$/.test(style.fontWeight)) return null;
  const font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  if (document.fonts?.status !== 'loaded' || !document.fonts.check(font, text)) return null;
  context.font = font;
  context.textAlign = 'left'; context.textBaseline = 'alphabetic'; context.direction = 'ltr';
  if (!['auto', 'normal', 'none'].includes(style.fontKerning)) return null;
  context.fontKerning = style.fontKerning as CanvasFontKerning;
  const metrics = context.measureText(collapseSpaces(text));
  return [metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight,
    metrics.actualBoundingBoxAscent, metrics.actualBoundingBoxDescent].every(Number.isFinite) && metrics.width > 0 ? metrics : null;
}

function shadowReach(style: CSSStyleDeclaration, pixelGuard: number, leading: boolean): number | null {
  if (style.boxShadow === 'none') return -Infinity;
  const match = /^(rgba?\([^()]+\))\s+([^ ]+)\s+([^ ]+)\s+([^ ]+)\s+([^ ]+)$/.exec(style.boxShadow);
  if (!match || !parseColor(match[1]!).rgba) return null;
  const values = match.slice(2).map(px);
  if (values.some(value => value === null)) return null;
  const [x, _y, blur, spread] = values as number[];
  if (blur! < 0 || blur! > 1 || spread !== 0) return null;
  // Firefox allocates a finite blur kernel and rounds its paint bounds out.
  // This deliberately larger guard covers that kernel for blur <= 1 CSS px,
  // plus device-pixel rounding. It does not model arbitrary CSS shadows.
  return 3 * blur! + 2 * pixelGuard + (leading ? x! : -x!);
}

/** Prove horizontal separation from measured normal-flow boxes, never guess a pseudo rectangle. */
export function pseudoIsSeparated(owner: Element, target: Element, pseudo: string, style: CSSStyleDeclaration, geometry: Geometry | undefined): boolean {
  if (!['::before', '::after'].includes(pseudo) || !geometry || geometry.limited || geometry.rects.length !== 1 || !finiteRect(geometry.rects[0]!)) return false;
  const leading = pseudo === '::before';
  if (owner.namespaceURI !== htmlNamespace || target.namespaceURI !== htmlNamespace || !owner.contains(target)
    || target.closest('input,textarea,select,[contenteditable]')) return false;
  if (style.position === 'absolute') return absolutePseudoIsSeparated(owner, target, pseudo, style, geometry, () => {
    const rawText = directText(target);
    const context = owner.ownerDocument.createElement('canvas').getContext('2d');
    return rawText !== null && context ? measureText(owner.ownerDocument, context, getComputedStyle(target), rawText) : null;
  });
  if (style.position !== 'static' || style.cssFloat !== 'none' || style.order !== '0' || style.unicodeBidi !== 'normal') return false;
  if (style.flexGrow !== '0' || style.flexBasis !== 'auto' || !['inline', 'block', 'inline-block', 'flex'].includes(style.display)) return false;
  if ([style.backgroundImage, style.borderImageSource, style.filter, style.backdropFilter, style.textShadow, style.appearance].some(value => value !== 'none')) return false;
  if (style.outlineStyle !== 'none' || style.textDecorationLine !== 'none') return false;
  const content = /^(?:"([^"\\\r\n]*)"|'([^'\\\r\n]*)')$/.exec(style.content);
  const glyph = content?.[1] ?? content?.[2];
  // A single private-use icon still needs loaded-font and measured-ink proof.
  if (!glyph || !/^(?:[\x20-\x7e\u00b7\u2010-\u2015\u2022\u2039\u203a]{1,8}|[\ue000-\uf8ff])$/.test(glyph)) return false;
  const pseudoBox = horizontalBox(style);
  if (!pseudoBox || !['border-box', 'content-box'].includes(style.boxSizing)) return false;
  if (style.display === 'flex' && (style.flexDirection !== 'row' || style.flexWrap !== 'nowrap'
    || !['normal', 'start', 'flex-start', 'center', 'end', 'flex-end'].includes(style.justifyContent))) return false;
  if (!['start', 'left', 'center', 'right', 'end'].includes(style.textAlign)) return false;
  const ownerStyle = getComputedStyle(owner), ownerRect = singleRect(owner), ownerBox = horizontalBox(ownerStyle);
  if (!ownerRect || !ownerBox || !normalText(ownerStyle) || owner.scrollLeft !== 0 || owner.scrollTop !== 0) return false;
  const flex = ['flex', 'inline-flex'].includes(ownerStyle.display);
  if (!flex && !['inline', 'block', 'inline-block', 'flow-root'].includes(ownerStyle.display)) return false;
  if (flex && (ownerStyle.flexDirection !== 'row' || ownerStyle.flexWrap !== 'nowrap'
    || !['normal', 'start', 'flex-start'].includes(ownerStyle.justifyContent))) return false;
  if (flex ? style.display === 'inline' : !['inline', 'inline-block'].includes(style.display)) return false;
  if (!flex && (!['left', 'start'].includes(ownerStyle.textAlign)
    || !['auto', '1'].includes(ownerStyle.columnCount) || ownerStyle.columnWidth !== 'auto')) return false;
  if (!flex && ownerStyle.display === 'block' && ownerStyle.whiteSpace !== 'nowrap') {
    const parentDisplay = owner.parentElement ? getComputedStyle(owner.parentElement).display : '';
    // A plain block can share a line with floats from outside its subtree.
    // Independent formatting contexts keep the measured available width valid.
    if (!['flex', 'inline-flex', 'grid', 'inline-grid'].includes(parentDisplay)
      && !['absolute', 'fixed'].includes(ownerStyle.position) && ownerStyle.cssFloat === 'none'
      && ![ownerStyle.overflowX, ownerStyle.overflowY].some(value => ['hidden', 'auto', 'scroll'].includes(value))) return false;
  }
  const opposite = getComputedStyle(owner, leading ? '::after' : '::before');
  if (!['none', 'normal'].includes(opposite.content) && opposite.display !== 'none') return false;
  let ancestors = 0;
  for (let current: Element | null = owner; current; current = current.parentElement) {
    if (++ancestors > 300 || !unchangedCoordinates(getComputedStyle(current), true)) return false;
  }
  for (let current: Element | null = target; current && current !== owner; current = current.parentElement) {
    if (++ancestors > 300 || !unchangedCoordinates(getComputedStyle(current))) return false;
  }
  if (owner.childNodes.length > 64) return false;
  const children: Element[] = [];
  let textNodes = 0;
  for (const child of owner.childNodes) {
    if (child.nodeType === Node.TEXT_NODE && child.nodeValue?.trim()) textNodes++;
    else if (child.nodeType === Node.ELEMENT_NODE && getComputedStyle(child as Element).display !== 'none') children.push(child as Element);
  }
  const textRect = geometry.rects[0]!;
  const gap = !flex || ownerStyle.columnGap === 'normal' ? 0 : px(ownerStyle.columnGap);
  if (gap === null || gap < 0) return false;
  const available = ownerRect.width - ownerBox.border - ownerBox.padding;
  const rawText = directText(target);
  if (rawText === null) return false;
  const document = owner.ownerDocument, context = document.createElement('canvas').getContext('2d');
  if (!context) return false;
  const glyphMetrics = measureText(document, context, style, glyph);
  const textMetrics = measureText(document, context, getComputedStyle(target), rawText);
  if (!glyphMetrics || !textMetrics || Math.abs(textMetrics.width - textRect.width) > 1) return false;
  // A true inline box ignores width. Boundary whitespace has context-dependent
  // collapsing, so that new case needs a literal without boundary whitespace.
  const inline = style.display === 'inline';
  if (inline && (style.width !== 'auto' || collapseSpaces(glyph) !== glyph)) return false;
  const width = inline ? glyphMetrics.width : px(style.width);
  if (width === null || width < 0) return false;
  const contentWidth = inline || style.boxSizing === 'content-box' ? width : width - pseudoBox.padding - pseudoBox.border;
  const pseudoWidth = contentWidth + pseudoBox.padding + pseudoBox.border;
  const halfTurn = !inline && centeredHalfTurn(style, pseudoWidth);
  if (!unchangedCoordinates(style) && !halfTurn) return false;
  // Ink may legitimately extend beyond its advance (Arial's bullet does).
  // The directional paint bound below includes that overhang explicitly.
  if (contentWidth <= 0 || glyphMetrics.width > contentWidth + 0.01) return false;
  let distance: number;
  if (owner === target && children.length === 0 && textNodes === 1) {
    if (textRect.width + gap + pseudoWidth + pseudoBox.marginLeft + pseudoBox.marginRight > available + 0.01) return false;
    distance = gap + (leading ? pseudoBox.marginRight : pseudoBox.marginLeft);
    if (!flex) {
      // A normal-flow line must start where its actual Range says it starts.
      // This rejects wrapping, bidi reordering and intrusion by outside floats.
      const start = ownerRect.left + ownerBox.borderLeft + ownerBox.paddingLeft;
      const expected = start + (leading ? pseudoWidth + pseudoBox.marginLeft + pseudoBox.marginRight : 0);
      if (Math.abs(textRect.left - expected) > 1
        || textRect.top < ownerRect.top || textRect.top + textRect.height > ownerRect.top + ownerRect.height + 0.01) return false;
      if (leading) distance = textRect.left - start - pseudoBox.marginLeft - pseudoWidth;
    }
  } else {
    if (!flex || children.length === 0 || textNodes !== 0) return false;
    let total = 0, first: { rect: Rect; margin: number } | null = null, last: { rect: Rect; margin: number } | null = null;
    let containsTarget = false, previousRight = -Infinity;
    for (const child of children) {
      const childStyle = getComputedStyle(child), childRect = singleRect(child), childBox = horizontalBox(childStyle);
      const unmoved = childStyle.position === 'static' || childStyle.position === 'relative'
        && [childStyle.top, childStyle.right, childStyle.bottom, childStyle.left].every(value => value === 'auto' || px(value) === 0);
      if (!childRect || !childBox || !unmoved || !unchangedCoordinates(childStyle) || childStyle.order !== '0'
        || childStyle.flexGrow !== '0' || childStyle.visibility === 'collapse'
        || childRect.left - childBox.marginLeft < previousRight - 0.01) return false;
      if (child.contains(target)) {
        if (textRect.left < childRect.left || textRect.left + textRect.width > childRect.left + childRect.width + 0.01
          || textRect.top < childRect.top || textRect.top + textRect.height > childRect.top + childRect.height + 0.01) return false;
        containsTarget = true;
      }
      total += childRect.width + childBox.marginLeft + childBox.marginRight;
      first ??= { rect: childRect, margin: childBox.marginLeft };
      last = { rect: childRect, margin: childBox.marginRight };
      previousRight = childRect.left + childRect.width + childBox.marginRight;
    }
    if (!containsTarget || total + children.length * gap + pseudoWidth + pseudoBox.marginLeft + pseudoBox.marginRight > available + 0.01) return false;
    distance = leading
      ? textRect.left - first!.rect.left + first!.margin + gap + pseudoBox.marginRight
      : last!.rect.left + last!.rect.width + last!.margin + gap + pseudoBox.marginLeft - textRect.left - textRect.width;
  }
  const dpr = document.defaultView?.devicePixelRatio;
  if (dpr === undefined || !Number.isFinite(dpr) || dpr <= 0) return false;
  const pixelGuard = 1 / Math.min(1, dpr), shadow = shadowReach(style, pixelGuard, leading);
  if (shadow === null) return false;
  // Padding contributes separation only when that padding cannot paint itself.
  // Atomic alignment stays inside the known content width; inline text begins
  // at the content edge regardless of its inherited text-align value.
  const alignment = inline ? 'start' : style.display === 'flex' ? style.justifyContent : style.textAlign;
  const alignmentSpace = contentWidth - glyphMetrics.width;
  const offset = alignment === 'center' ? alignmentSpace / 2 : ['right', 'end', 'flex-end'].includes(alignment) ? alignmentSpace : 0;
  const glyphStart = pseudoBox.borderLeft + pseudoBox.paddingLeft + offset;
  const glyphLeft = glyphStart - glyphMetrics.actualBoundingBoxLeft;
  const glyphRight = glyphStart + glyphMetrics.actualBoundingBoxRight;
  const paintedLeft = halfTurn ? pseudoWidth - glyphRight : glyphLeft;
  const paintedRight = halfTurn ? pseudoWidth - glyphLeft : glyphRight;
  const glyphReach = leading ? paintedRight - pseudoWidth : -paintedLeft;
  // Top/bottom borders span the horizontal padding too. Unknown widths cannot
  // establish that padding is clear, even when the side borders are zero.
  const boxPaint = parseColor(style.backgroundColor).rgba?.a !== 0
    || [style.borderLeftWidth, style.borderRightWidth, style.borderTopWidth, style.borderBottomWidth].some(value => px(value) !== 0);
  const reach = Math.max(shadow, glyphReach + pixelGuard, boxPaint ? pixelGuard : -Infinity);
  const targetOverhang = leading ? Math.max(0, textMetrics.actualBoundingBoxLeft)
    : Math.max(0, textMetrics.actualBoundingBoxRight - textRect.width);
  return distance > reach + targetOverhang;
}
