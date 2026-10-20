const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const BOX_DISPLAYS = new Set(['block', 'inline-block', 'flow-root', 'flex', 'inline-flex', 'grid', 'inline-grid']);
const CLIPPING_OVERFLOW = new Set(['hidden', 'auto', 'scroll']);

function pixels(value: string): number | null {
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value)) return null;
  const number = Number.parseFloat(value);
  return Number.isFinite(number) ? number : null;
}

/** An exactly empty padding box cannot paint text, regardless of glyph metrics.
 * Do not use integer clientWidth/clientHeight: they round small visible strips
 * down to zero. Unknown boxes and overflow-clip-margin stay in scope.
 */
export function hasEmptyOverflow(element: Element, style: CSSStyleDeclaration): boolean {
  // Fieldset overflow clips its anonymous content box; its first legend can
  // still paint outside an empty fieldset width. Do not apply this proof there.
  if (element.namespaceURI !== HTML_NAMESPACE || ['HTML', 'BODY', 'FIELDSET'].includes(element.tagName)
    || !BOX_DISPLAYS.has(style.display) || !['content-box', 'border-box'].includes(style.boxSizing)) return false;
  const emptyAxis = (axis: 'width' | 'height', start: 'Left' | 'Top', end: 'Right' | 'Bottom', overflow: string) => {
    if (!CLIPPING_OVERFLOW.has(overflow)) return false;
    const size = pixels(style[axis]);
    const paddingStart = pixels(style[`padding${start}`]), paddingEnd = pixels(style[`padding${end}`]);
    // A border-box dimension is floored by its padding/borders. Requiring no
    // padding avoids mistaking a declared zero for an empty used padding box.
    if (size === null || paddingStart !== 0 || paddingEnd !== 0) return false;
    if (style.boxSizing === 'content-box') return size === 0;
    const borderStart = pixels(style[`border${start}Width`]), borderEnd = pixels(style[`border${end}Width`]);
    return borderStart !== null && borderEnd !== null && size === borderStart + borderEnd;
  };
  if (!emptyAxis('width', 'Left', 'Right', style.overflowX) && !emptyAxis('height', 'Top', 'Bottom', style.overflowY)) return false;
  // Fragmented boxes can have different used sizes; this proof is deliberately
  // limited to a single ordinary box and excludes viewport overflow propagation.
  return element.getClientRects().length === 1;
}

/** Positioned descendants or top-layer boxes may escape an ancestor's clip. */
export function mayEscapeOverflow(element: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'contents') return false;
  if (!['static', 'relative'].includes(style.position)) return true;
  try { return element.matches(':modal, :popover-open, :fullscreen'); }
  catch { return true; }
}
