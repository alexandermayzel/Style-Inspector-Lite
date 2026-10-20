import { parseColor } from '../core/colors';
import { parseLinearGradient, splitBackgroundLayers } from '../core/gradients';
import type { RGBA } from '../core/types';

interface Rect { left: number; top: number; width: number; height: number }
interface Geometry { rects: Rect[]; limited: boolean }
type Insets = [number, number, number, number];
type Radius = [number, number];
const namespace = 'http://www.w3.org/1999/xhtml';
const px = (raw: string): number | null => /^[+-]?(?:\d+\.?\d*|\.\d+)px$/.test(raw) && Number.isFinite(Number.parseFloat(raw)) ? Number.parseFloat(raw) : null;
const finite = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
const first = (raw: string) => splitBackgroundLayers(raw)?.[0] ?? null;

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
    && !/\b(?:paint|strict|content)\b/.test(style.contain) && style.contentVisibility === 'visible'
    && style.borderImageSource === 'none'
    && ['', 'round', 'superellipse(1)'].includes(style.getPropertyValue('corner-shape'))
    && (['none', 'hidden'].includes(style.outlineStyle) || px(style.outlineWidth) === 0 || parseColor(style.outlineColor).rgba?.a === 0);
}

function inset(rect: Rect, values: Insets): Rect {
  return { left: rect.left + values[3], top: rect.top + values[0], width: rect.width - values[1] - values[3], height: rect.height - values[0] - values[2] };
}

function widths(style: CSSStyleDeclaration, prefix: 'border' | 'padding'): Insets | null {
  const values = ['Top', 'Right', 'Bottom', 'Left'].map(side => px(style[`${prefix}${side}${prefix === 'border' ? 'Width' : ''}` as keyof CSSStyleDeclaration] as string));
  return values.every(value => value !== null && value >= 0) ? values as Insets : null;
}

function radii(style: CSSStyleDeclaration): Radius[] | null {
  const result: Radius[] = [];
  for (const value of [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius]) {
    const values = value.trim().split(/\s+/).map(px);
    if (values.length < 1 || values.length > 2 || values.some(part => part === null || part < 0)) return null;
    result.push([values[0]!, values[1] ?? values[0]!]);
  }
  return result;
}

/** A rectangle is inside a convex rounded box when all its corners are inside. */
function contains(box: Rect, rect: Rect, radius: Radius[], guard: number): boolean {
  if (!finite(box)) return false;
  const left = rect.left - guard, top = rect.top - guard;
  const right = rect.left + rect.width + guard, bottom = rect.top + rect.height + guard;
  if (left < box.left || top < box.top || right > box.left + box.width || bottom > box.top + box.height) return false;
  const [tl, tr, br, bl] = radius as [Radius, Radius, Radius, Radius];
  // CSS scales overlapping corner radii together. Retain uncertainty instead of
  // normalizing them against a possibly different inset image/shadow box.
  if (tl[0] + tr[0] > box.width || bl[0] + br[0] > box.width
    || tl[1] + bl[1] > box.height || tr[1] + br[1] > box.height) return false;
  const insideCorner = (x: number, y: number, r: Radius) => x >= r[0] || y >= r[1]
    || (1 - x / r[0]) ** 2 + (1 - y / r[1]) ** 2 <= 1;
  for (const [x, y] of [[left, top], [right, top], [right, bottom], [left, bottom]]) {
    if (!insideCorner(x! - box.left, y! - box.top, tl)
      || !insideCorner(box.left + box.width - x!, y! - box.top, tr)
      || !insideCorner(box.left + box.width - x!, box.top + box.height - y!, br)
      || !insideCorner(x! - box.left, box.top + box.height - y!, bl)) return false;
  }
  return true;
}

/** Unblurred inset shadows can paint only bounded strips around the padding box. */
function shadowInsets(raw: string): Insets | null {
  if (raw === 'none') return [0, 0, 0, 0];
  const shadows = splitBackgroundLayers(raw);
  if (!shadows) return null;
  let x = 0, y = 0;
  for (const shadow of shadows) {
    const match = /^(rgba?\([^()]+\))\s+([^ ]+)\s+([^ ]+)\s+([^ ]+)\s+([^ ]+)\s+inset$/.exec(shadow);
    if (!match) return null;
    const color = parseColor(match[1]!).rgba;
    const offsets = match.slice(2).map(px);
    if (!color || offsets.some(value => value === null) || offsets[2] !== 0) return null;
    if (color.a === 0) continue;
    // Symmetric bounds also cover either sign of the offset/spread.
    x = Math.max(x, Math.abs(offsets[0]!) + Math.max(0, offsets[3]!));
    y = Math.max(y, Math.abs(offsets[1]!) + Math.max(0, offsets[3]!));
  }
  return [y, x, y, x];
}

/**
 * A full-size opaque top image occludes all lower image/color layers.
 * Establish coverage of every measured text rectangle before using its color.
 * Unknown placement/effects retain the compositor's conservative color range.
 */
export function coveringOpaqueGradient(element: Element, target: Element, style: CSSStyleDeclaration, geometry: readonly Geometry[]): RGBA[] | null {
  if (!geometry.length || geometry.some(item => item.limited || !item.rects.length)) return null;
  const rects = geometry.flatMap(item => item.rects);
  if (rects.length > 64 || !rects.every(finite) || element.namespaceURI !== namespace || !element.contains(target)
    || element.getClientRects().length !== 1 || !['block', 'inline-block', 'flow-root', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) return null;
  const image = first(style.backgroundImage), stops = image ? parseLinearGradient(image) : null;
  if (!stops || stops.some(stop => stop.a !== 1)) return null;
  if (!['auto', 'auto auto'].includes(first(style.backgroundSize) ?? '') || first(style.backgroundPosition) !== '0% 0%'
    || first(style.backgroundAttachment) !== 'scroll' || first(style.backgroundBlendMode) !== 'normal'
    || !['repeat', 'no-repeat', 'repeat no-repeat', 'no-repeat repeat'].includes(first(style.backgroundRepeat) ?? '')) return null;
  const view = element.ownerDocument.defaultView;
  if (!view || !Number.isFinite(view.devicePixelRatio) || view.devicePixelRatio <= 0) return null;
  const targetStyle = view.getComputedStyle(target);
  if (targetStyle.fontStyle !== 'normal' || targetStyle.textShadow !== 'none'
    || px(targetStyle.getPropertyValue('-webkit-text-stroke-width')) !== 0) return null;
  let depth = 0, reachedImage = false;
  for (let current: Element | null = target; current; current = current.parentElement) {
    if (++depth > 300 || current.namespaceURI !== namespace) return null;
    const currentStyle = view.getComputedStyle(current);
    if (!simpleGeometry(currentStyle) || currentStyle.textDecorationLine !== 'none' || currentStyle.textEmphasisStyle !== 'none'
      || (!reachedImage && current !== element && currentStyle.boxShadow !== 'none')) return null;
    reachedImage ||= current === element;
  }
  const box = element.getBoundingClientRect(), borders = widths(style, 'border'), padding = widths(style, 'padding');
  const radius = radii(style), shadows = shadowInsets(style.boxShadow);
  if (!finite(box) || !borders || !padding || !radius || !shadows || element.scrollLeft !== 0 || element.scrollTop !== 0) return null;
  const paddingBox = inset(box, borders), contentBox = inset(paddingBox, padding);
  const boxes: Record<string, Rect> = { 'border-box': box, 'padding-box': paddingBox, 'content-box': contentBox };
  const origin = boxes[first(style.backgroundOrigin) ?? ''], clip = boxes[first(style.backgroundClip) ?? ''];
  if (!origin || !clip) return null;
  const shadowFree = inset(paddingBox, shadows), guard = Math.max(1, 1 / view.devicePixelRatio);
  // Using the outer radii for inset boxes only makes the accepted interior smaller.
  return rects.every(rect => contains(origin, rect, [[0, 0], [0, 0], [0, 0], [0, 0]], guard)
    && contains(clip, rect, radius, guard) && contains(shadowFree, rect, radius, guard)) ? stops : null;
}

/** A uniform covered image also has an exact solid background color. */
export function coveringSolidBackground(element: Element, target: Element, style: CSSStyleDeclaration, geometry: readonly Geometry[]): RGBA | null {
  const stops = coveringOpaqueGradient(element, target, style, geometry), color = stops?.[0];
  return color && stops!.every(stop => (['r', 'g', 'b', 'a'] as const).every(channel => stop[channel] === color[channel])) ? color : null;
}
