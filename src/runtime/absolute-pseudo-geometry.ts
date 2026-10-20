interface Rect { left: number; top: number; width: number; height: number }
interface Geometry { rects: Rect[]; limited: boolean }
type InkMetrics = Pick<TextMetrics, 'width' | 'actualBoundingBoxLeft' | 'actualBoundingBoxRight'>;
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const px = (raw: string): number | null => /^[+-]?(?:\d+\.?\d*|\.\d+)px$/.test(raw) && Number.isFinite(Number.parseFloat(raw)) ? Number.parseFloat(raw) : null;
const finiteRect = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const boxDisplays = ['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'];
const textProperties = ['color', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontStretch', 'fontSizeAdjust',
  'fontVariantCaps', 'fontVariantLigatures', 'fontVariantNumeric', 'fontVariantAlternates', 'fontVariantEastAsian',
  'fontVariantPosition', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'fontOpticalSizing',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textShadow', 'textEmphasisStyle'] as const;
const hasShadow = (element: Element) => Boolean(element.shadowRoot || (element as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot);

function unchangedCoordinates(style: CSSStyleDeclaration): boolean {
  return [style.transform, style.translate, style.rotate, style.scale, style.perspective, style.offsetPath].every(value => value === 'none')
    && ['1', 'normal'].includes(style.zoom) && style.transformStyle === 'flat'
    && style.writingMode === 'horizontal-tb' && style.direction === 'ltr';
}

function noEffects(style: CSSStyleDeclaration): boolean {
  return [style.filter, style.backdropFilter, style.textShadow].every(value => value === 'none')
    && style.textEmphasisStyle === 'none' && px(style.getPropertyValue('-webkit-text-stroke-width')) === 0;
}

/** The UA disclosure wrapper may itself become an intervening containing block. */
function ordinaryDetailsContent(owner: Element): boolean {
  if (!owner.hasAttribute('open')) return false;
  const content = getComputedStyle(owner, '::details-content');
  return content.display === 'block' && content.position === 'static' && unchangedCoordinates(content) && noEffects(content)
    && content.contain === 'none' && content.containerType === 'normal' && content.contentVisibility === 'visible'
    && content.willChange === 'auto';
}

/**
 * Prove only horizontal separation of an empty absolute decoration. Resolved
 * opposing insets must reconcile with the known padding box; no static-position
 * or anonymous containing block is guessed. The caller supplies loaded-font
 * Canvas metrics for the target's single ordinary text run.
 */
export function absolutePseudoIsSeparated(owner: Element, target: Element, pseudo: string, style: CSSStyleDeclaration,
  geometry: Geometry | undefined, measureInk: () => InkMetrics | null): boolean {
  if (!['::before', '::after'].includes(pseudo) || !geometry || geometry.limited || geometry.rects.length !== 1
    || !finiteRect(geometry.rects[0]!) || owner.namespaceURI !== htmlNamespace || target.namespaceURI !== htmlNamespace
    || !owner.contains(target) || target.closest('input,textarea,select,[contenteditable]')) return false;
  if (!['""', "''"].includes(style.content) || style.position !== 'absolute' || style.cssFloat !== 'none'
    || !boxDisplays.includes(style.display) || !unchangedCoordinates(style) || !noEffects(style)) return false;
  if ([style.backgroundImage, style.borderImageSource, style.boxShadow, style.outlineStyle, style.appearance].some(value => value !== 'none')
    || style.textDecorationLine !== 'none' || style.mixBlendMode !== 'normal' || style.contain !== 'none'
    || !['auto', 'normal'].includes(style.justifySelf) || !['auto', 'normal'].includes(style.alignSelf)) return false;
  for (const [property, defaults] of [
    ['position-area', ['', 'none']], ['position-anchor', ['', 'auto', 'normal']], ['position-try-fallbacks', ['', 'none']],
  ] as const) if (!(defaults as readonly string[]).includes(style.getPropertyValue(property))) return false;
  if ([style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].some(value => px(value) !== 0)) return false;
  if ([style.top, style.bottom].some(value => value !== 'auto' && px(value) === null)) return false;
  const left = px(style.left), right = px(style.right), width = px(style.width);
  const sides = [style.paddingLeft, style.paddingRight, style.borderLeftWidth, style.borderRightWidth,
    style.borderTopWidth, style.borderBottomWidth].map(px);
  if (left === null || right === null || width === null || left < 0 || right < 0 || width <= 0
    || sides.some(value => value === null || value < 0) || !['border-box', 'content-box'].includes(style.boxSizing)) return false;
  const horizontalEdges = sides[0]! + sides[1]! + sides[2]! + sides[3]!;
  const paintWidth = style.boxSizing === 'content-box' ? width + horizontalEdges : width;
  if (paintWidth < horizontalEdges) return false;

  const ownerStyle = getComputedStyle(owner);
  if (!boxDisplays.includes(ownerStyle.display) || !['relative', 'absolute'].includes(ownerStyle.position)
    || ownerStyle.overflowX !== 'visible' || ownerStyle.overflowY !== 'visible'
    || owner.scrollLeft !== 0 || owner.scrollTop !== 0 || owner.getClientRects().length !== 1
    || ['FIELDSET', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'OPTION', 'OPTGROUP', 'TABLE', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME', 'OBJECT', 'EMBED'].includes(owner.tagName)
    || hasShadow(owner) || owner.assignedSlot) return false;
  if (owner.tagName === 'DETAILS' && !ordinaryDetailsContent(owner)) return false;
  if (['grid', 'inline-grid'].includes(ownerStyle.display)
    && [style.gridColumnStart, style.gridColumnEnd, style.gridRowStart, style.gridRowEnd].some(value => value !== 'auto')) return false;
  const bounds = owner.getBoundingClientRect();
  const borderLeft = px(ownerStyle.borderLeftWidth), borderRight = px(ownerStyle.borderRightWidth);
  if (!finiteRect(bounds) || borderLeft === null || borderRight === null || borderLeft < 0 || borderRight < 0) return false;
  const containingWidth = bounds.width - borderLeft - borderRight;
  const insetError = Math.abs(left + paintWidth + right - containingWidth);
  if (containingWidth <= 0 || insetError > 1) return false;

  let depth = 0, reachedOwner = false;
  for (let current: Element | null = target; current; current = current.parentElement) {
    if (++depth > 300 || current.namespaceURI !== htmlNamespace || current.assignedSlot || hasShadow(current)) return false;
    const currentStyle = getComputedStyle(current);
    if (!unchangedCoordinates(currentStyle) || !noEffects(currentStyle)) return false;
    for (const pseudo of ['::first-line', '::first-letter']) {
      const pseudoStyle = getComputedStyle(current, pseudo);
      if (textProperties.some(property => pseudoStyle[property] !== currentStyle[property])
        || pseudoStyle.getPropertyValue('-webkit-text-stroke-width') !== currentStyle.getPropertyValue('-webkit-text-stroke-width')) return false;
    }
    if (current === owner) reachedOwner = true;
  }
  if (!reachedOwner) return false;
  const dpr = owner.ownerDocument.defaultView?.devicePixelRatio;
  if (dpr === undefined || !Number.isFinite(dpr) || dpr <= 0) return false;
  const metrics = measureInk(), rect = geometry.rects[0]!;
  if (!metrics || ![metrics.width, metrics.actualBoundingBoxLeft, metrics.actualBoundingBoxRight].every(Number.isFinite)
    || metrics.width <= 0) return false;
  const widthError = Math.abs(metrics.width - rect.width);
  if (widthError > 1) return false;
  const guard = 2 / Math.min(1, dpr) + widthError + insetError;
  const paintLeft = bounds.left + borderLeft + left, paintRight = paintLeft + paintWidth;
  const inkLeft = Math.min(rect.left, rect.left - metrics.actualBoundingBoxLeft);
  const inkRight = Math.max(rect.left + rect.width, rect.left + metrics.actualBoundingBoxRight);
  return paintRight + guard < inkLeft - guard || paintLeft - guard > inkRight + guard;
}
