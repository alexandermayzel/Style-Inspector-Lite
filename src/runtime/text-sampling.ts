interface Rect { left: number; top: number; width: number; height: number }
const htmlNamespace = 'http://www.w3.org/1999/xhtml';
const finiteRect = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;

function translationOnly(raw: string): boolean {
  if (raw === 'none') return true;
  const values = /^matrix\(([^()]*)\)$/.exec(raw)?.[1]?.split(',').map(Number);
  return !!values && values.length === 6 && values.every(Number.isFinite)
    && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1;
}

function simpleGeometry(style: CSSStyleDeclaration): boolean {
  return translationOnly(style.transform) && [style.translate, style.rotate, style.scale, style.perspective, style.offsetPath].every(value => value === 'none')
    && ['normal', '1'].includes(style.zoom) && style.transformStyle === 'flat'
    && style.clipPath === 'none' && style.clip === 'auto' && style.maskImage === 'none'
    && style.filter === 'none' && style.backdropFilter === 'none'
    && !/\b(?:paint|strict|content)\b/.test(style.contain) && style.contentVisibility === 'visible';
}

/**
 * Range rectangles include text hidden by ellipsis/overflow. Hit-test only the
 * provably visible portion, so an adjacent pane cannot become its background.
 * This changes sampling, never text visibility or run counts. Unknown geometry
 * and empty intersections retain the original conservative sample.
 */
export function visibleTextSampleRect(element: Element, rect: Rect): Rect {
  const document = element.ownerDocument, view = document?.defaultView;
  if (!view || !finiteRect(rect)) return rect;
  let left = rect.left, top = rect.top, right = rect.left + rect.width, bottom = rect.top + rect.height;
  let canClip = true, depth = 0;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (++depth > 300 || current.namespaceURI !== htmlNamespace) return rect;
    const style = view.getComputedStyle(current);
    if (!simpleGeometry(style)) return rect;
    if (canClip && current !== document.documentElement && current !== document.body
      && ['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) {
      // overflow:clip may extend its clipping edge through overflow-clip-margin.
      if ([style.overflowX, style.overflowY].includes('clip')) return rect;
      const x = ['hidden', 'auto', 'scroll'].includes(style.overflowX);
      const y = ['hidden', 'auto', 'scroll'].includes(style.overflowY);
      if (x || y) {
        if (current.getClientRects().length !== 1) return rect;
        const box = current.getBoundingClientRect();
        const metrics = [current.clientLeft, current.clientTop, current.clientWidth, current.clientHeight];
        if (!finiteRect(box) || !metrics.every(value => Number.isFinite(value) && value >= 0)
          || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some(value => value !== '0px')) return rect;
        // Integer client metrics round fractional borders and padding. Move
        // inside by one CSS pixel rather than sampling beyond the actual clip.
        if (x) { left = Math.max(left, box.left + current.clientLeft + 1); right = Math.min(right, box.left + current.clientLeft + current.clientWidth - 1); }
        if (y) { top = Math.max(top, box.top + current.clientTop + 1); bottom = Math.min(bottom, box.top + current.clientTop + current.clientHeight - 1); }
        if (right <= left || bottom <= top) return rect;
      }
    }
    // Its own clip still applies, but an out-of-flow box can escape more
    // distant overflow containers. Do not infer their containing blocks.
    if (style.display !== 'contents' && !['static', 'relative'].includes(style.position)) canClip = false;
  }
  return left === rect.left && top === rect.top && right === rect.left + rect.width && bottom === rect.top + rect.height
    ? rect : { left, top, width: right - left, height: bottom - top };
}
