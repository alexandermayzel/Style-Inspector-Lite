import { parseColor } from '../core/colors';
import { splitBackgroundLayers } from '../core/gradients';

interface Rect { left: number; top: number; width: number; height: number }
interface Geometry { rects: Rect[]; limited: boolean }
export type BackgroundCoverage = 'covered' | 'outside' | 'uncertain';
const finite = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const px = (raw: string) => /^\d+(?:\.\d+)?px$/.test(raw) ? Number.parseFloat(raw) : null;
const separates = (box: Rect, rect: Rect) => rect.left >= box.left + box.width || rect.top >= box.top + box.height
  || rect.left + rect.width <= box.left || rect.top + rect.height <= box.top;

/** Range rectangles include ellipsized text. Intersect only ordinary, known
 * overflow clips; unlike a hit-test sample this keeps every visible edge. */
function paintedRects(target: Element, rects: Rect[], readStyle: (element: Element) => CSSStyleDeclaration): Rect[] {
  let result = rects, canClip = true, depth = 0;
  for (let current: Element | null = target; current; current = current.parentElement) {
    if (++depth > 128 || current.namespaceURI !== 'http://www.w3.org/1999/xhtml') return rects;
    const style = readStyle(current);
    if (hasUnboundedPaintTransform(style) || style.clipPath && style.clipPath !== 'none') return rects;
    if (canClip && current !== target.ownerDocument?.documentElement && current !== target.ownerDocument?.body
      && ['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) {
      const x = ['hidden', 'auto', 'scroll'].includes(style.overflowX), y = ['hidden', 'auto', 'scroll'].includes(style.overflowY);
      if (x || y) {
        if (current.getClientRects().length !== 1) return rects;
        const box = current.getBoundingClientRect();
        const borders = ['Top', 'Right', 'Bottom', 'Left'].map(side => px(style[`border${side}Width` as keyof CSSStyleDeclaration] as string || '0px'));
        if (!finite(box) || borders.some(value => value === null)) return rects;
        result = result.map(rect => {
          const left = x ? Math.max(rect.left, box.left + borders[3]!) : rect.left;
          const top = y ? Math.max(rect.top, box.top + borders[0]!) : rect.top;
          const right = x ? Math.min(rect.left + rect.width, box.left + box.width - borders[1]!) : rect.left + rect.width;
          const bottom = y ? Math.min(rect.top + rect.height, box.top + box.height - borders[2]!) : rect.top + rect.height;
          return { left, top, width: right - left, height: bottom - top };
        });
        if (!result.every(finite)) return rects;
      }
    }
    if (style.display !== 'contents' && !['static', 'relative'].includes(style.position)) canClip = false;
  }
  return result;
}

/** Root backgrounds (and the HTML body's propagated background) paint the canvas,
 * including text that overflows their ordinary layout rectangle. */
function canvasBackground(owner: Element, style: CSSStyleDeclaration, readStyle: (element: Element) => CSSStyleDeclaration): boolean {
  const document = owner.ownerDocument, root = document?.documentElement;
  if (!root || root.namespaceURI !== 'http://www.w3.org/1999/xhtml' || root.localName !== 'html') return false;
  if (owner === root) return true;
  if (owner !== document.body || style.display === 'none') return false;
  const rootStyle = readStyle(root);
  if (rootStyle.backgroundImage !== 'none') return false;
  const rootColor = parseColor(rootStyle.backgroundColor).rgba;
  if (rootColor?.a === 0) return true;
  const bodyColor = parseColor(style.backgroundColor).rgba;
  // A body overflowing its own box remains uniform when it paints the exact
  // same opaque solid color as the immediately underlying document canvas.
  return style.backgroundImage === 'none' && rootColor?.a === 1 && bodyColor?.a === 1
    && (['r', 'g', 'b'] as const).every(channel => rootColor[channel] === bodyColor[channel]);
}

/** Decide only whether the authored background covers all measured fragments.
 * Partial coverage never establishes a single painted text/background pair. */
export function backgroundPaintCoverage(owner: Element, target: Element, style: CSSStyleDeclaration,
  geometry: readonly Geometry[], readStyle: (element: Element) => CSSStyleDeclaration): BackgroundCoverage {
  if (canvasBackground(owner, style, readStyle)) return 'covered';
  if (style.display === 'contents') return 'outside';
  const rects = geometry.length ? geometry.flatMap(item => item.rects) : [target.getBoundingClientRect()];
  if (!rects.length || rects.length > 2048 || geometry.some(item => item.limited) || !rects.every(finite)) return 'uncertain';
  const boxes = Array.from(owner.getClientRects());
  if (!boxes.length || boxes.length > 128 || !boxes.every(finite)) return 'uncertain';
  // A bounding rectangle encloses rotated geometry too: complete separation is
  // sufficient to skip this background even when its exact shape is unknown.
  if (rects.every(rect => boxes.every(box => separates(box, rect)))) {
    // Text visibility uses a separate ink proof. A retained fragment outside
    // an overflow clip (for example percentage indentation) may not actually
    // paint on the canvas. Do not turn that unresolved visibility into a
    // confirmed contrast merely by skipping the clipped owner's image.
    return [style.overflowX, style.overflowY].some(value => ['hidden', 'clip', 'auto', 'scroll'].includes(value))
      ? 'uncertain' : 'outside';
  }
  if (owner.namespaceURI !== 'http://www.w3.org/1999/xhtml') return 'uncertain';
  if (style.clipPath && style.clipPath !== 'none' || style.clip && style.clip !== 'auto'
    || style.backgroundAttachment && style.backgroundAttachment.split(',').some(value => value.trim() === 'local')) return 'uncertain';
  const clips = splitBackgroundLayers(style.backgroundClip || 'border-box');
  if (!clips?.length || clips.some(clip => !['border-box', 'padding-box', 'content-box'].includes(clip))) return 'uncertain';
  const border = ['Top', 'Right', 'Bottom', 'Left'].map(side => px(style[`border${side}Width` as keyof CSSStyleDeclaration] as string || '0px'));
  const padding = ['Top', 'Right', 'Bottom', 'Left'].map(side => px(style[`padding${side}` as keyof CSSStyleDeclaration] as string || '0px'));
  if ([...border, ...padding].some(value => value === null)) return 'uncertain';
  const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]
    .map(raw => (raw || '0px').trim().split(/\s+/).map(px));
  if (radii.some(pair => pair.length > 2 || pair.some(value => value === null))) return 'uncertain';
  // The same clip applies to the color and each image layer. Requiring the
  // intersection also handles different clips without inventing a uniform fill.
  const inset = border.map((value, index) => clips.includes('content-box') ? value! + padding[index]!
    : clips.includes('padding-box') ? value! : 0);
  const inside = (box: Rect, rect: Rect): boolean => {
    const left = box.left + inset[3]!, top = box.top + inset[0]!;
    const right = box.left + box.width - inset[1]!, bottom = box.top + box.height - inset[2]!;
    // Keep the outer corner radii for inset clips: this shrinks the accepted
    // interior conservatively instead of guessing at clipped elliptical corners.
    const corners = radii.map(pair => [pair[0]!, pair[1] ?? pair[0]!] as const);
    if (corners[0]![0] + corners[1]![0] > right - left || corners[3]![0] + corners[2]![0] > right - left
      || corners[0]![1] + corners[3]![1] > bottom - top || corners[1]![1] + corners[2]![1] > bottom - top) return false;
    const inCorner = (x: number, y: number, radius: readonly [number, number]) => radius[0] === 0 || radius[1] === 0
      || x >= radius[0] || y >= radius[1] || (1 - x / radius[0]) ** 2 + (1 - y / radius[1]) ** 2 <= 1;
    for (const [x, y] of [[rect.left, rect.top], [rect.left + rect.width, rect.top],
      [rect.left, rect.top + rect.height], [rect.left + rect.width, rect.top + rect.height]]) {
      if (x! < left || y! < top || x! > right || y! > bottom
        || !inCorner(x! - left, y! - top, corners[0]!) || !inCorner(right - x!, y! - top, corners[1]!)
        || !inCorner(right - x!, bottom - y!, corners[2]!) || !inCorner(x! - left, bottom - y!, corners[3]!)) return false;
    }
    return true;
  };
  if (rects.every(rect => boxes.some(box => inside(box, rect)))) return 'covered';
  const clipped = paintedRects(target, rects, readStyle);
  return clipped !== rects && clipped.every(rect => boxes.some(box => inside(box, rect))) ? 'covered' : 'uncertain';
}

/** Axis-aligned DOM bounds cannot prove coverage after rotated/skewed/3D paint. */
export function hasUnboundedPaintTransform(style: CSSStyleDeclaration): boolean {
  if (style.zoom && !['1', 'normal'].includes(style.zoom)) return true;
  if (style.scale && style.scale !== 'none' && !/^1(?:\s+1){0,2}$/.test(style.scale)) return true;
  if (style.rotate && style.rotate !== 'none' && !/^(?:[xyz]\s+)?0(?:deg|rad|turn)$/.test(style.rotate)) return true;
  if (style.perspective && style.perspective !== 'none') return true;
  const transform = style.transform;
  if (!transform || transform === 'none') return false;
  const numbers = /^matrix\(([^()]*)\)$/.exec(transform)?.[1]?.split(',').map(Number);
  // Translation is safe. Scale needs transformed inset/radius lengths, which
  // this coverage proof intentionally does not derive from CSS matrix values.
  return !numbers || numbers.length !== 6 || numbers.some(value => !Number.isFinite(value))
    || numbers[0] !== 1 || numbers[1] !== 0 || numbers[2] !== 0 || numbers[3] !== 1;
}
