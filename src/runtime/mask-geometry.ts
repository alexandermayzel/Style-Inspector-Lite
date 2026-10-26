import { parseColor } from '../core/colors';
import { splitBackgroundLayers } from '../core/gradients';

interface Rect { left: number; top: number; width: number; height: number }
type Transparent = (rect: Rect) => boolean;
const finite = (rect: Rect) => [rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;

/** Axis-aligned alpha gradients only; unknown placement/interpolation stays visible. */
function gradient(raw: string, box: Rect): Transparent | null {
  const match = /^linear-gradient\((.*)\)$/is.exec(raw.trim());
  const parts = match && splitBackgroundLayers(match[1]!);
  if (!parts || parts.length < 3 || parts.length > 16) return null;
  const direction = parts.shift()!;
  if (!['to top', 'to bottom', 'to left', 'to right'].includes(direction)) return null;
  const horizontal = direction === 'to left' || direction === 'to right';
  const reversed = direction === 'to left' || direction === 'to top';
  const length = horizontal ? box.width : box.height;
  const stops: { position: number; transparent: boolean }[] = [];
  for (const part of parts) {
    const stop = /^(#[\da-f]{3,8}|[a-z]+\([^()]*\)|[a-z]+)\s+([+-]?(?:\d+\.?\d*|\.\d+))(px|%)$/i.exec(part);
    if (!stop || !/^(?:#|transparent$|black$|white$|rgba?\(|hsla?\()/i.test(stop[1]!)) return null;
    const color = parseColor(stop[1]!).rgba;
    const position = Number(stop[2]) * (stop[3] === '%' ? length / 100 : 1);
    if (!color || !Number.isFinite(position)) return null;
    // CSS Images stop fixup: a descending position is clamped to its predecessor.
    stops.push({ position: Math.max(position, stops.at(-1)?.position ?? -Infinity), transparent: color.a === 0 });
  }
  const intervals: [number, number][] = [];
  for (let index = 0; index < stops.length; index++) {
    if (!stops[index]!.transparent) continue;
    const start = index;
    while (index + 1 < stops.length && stops[index + 1]!.transparent) index++;
    intervals.push([start === 0 ? -Infinity : stops[start]!.position, index === stops.length - 1 ? Infinity : stops[index]!.position]);
  }
  return rect => {
    const first = horizontal ? rect.left - box.left : rect.top - box.top;
    const last = first + (horizontal ? rect.width : rect.height);
    const low = reversed ? length - last : first, high = reversed ? length - first : last;
    return intervals.some(([start, end]) => low > start && high < end);
  };
}

/**
 * Build a cheap proof for a full-size border-box mask. The caller supplies
 * verified glyph ink, including rounding/overhang guards, not a layout box.
 * Additive mask layers hide text only where every layer has zero alpha.
 */
export function transparentMask(element: Element, style: CSSStyleDeclaration): Transparent | null {
  const images = splitBackgroundLayers(style.maskImage);
  if (!images || images.length > 8 || images.some(image => image === 'none')
    || !['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)
    || element.getClientRects().length !== 1 || element.scrollLeft !== 0 || element.scrollTop !== 0) return null;
  const accepted: [string, string[]][] = [
    [style.maskSize, ['auto', 'auto auto']], [style.maskPosition, ['0% 0%']],
    [style.maskOrigin, ['border-box']], [style.maskClip, ['border-box']],
    [style.maskMode, ['alpha', 'match-source']], [style.maskComposite, ['add']],
    [style.maskRepeat, ['repeat', 'no-repeat', 'repeat no-repeat', 'no-repeat repeat']],
  ];
  if (accepted.some(([raw, values]) => { const list = splitBackgroundLayers(raw); return !list || list.some(value => !values.includes(value)); })) return null;
  const borderMask = style.getPropertyValue('mask-border-source');
  if (borderMask && borderMask !== 'none') return null;
  const box = element.getBoundingClientRect();
  if (!finite(box)) return null;
  const layers = images.map(image => gradient(image, box));
  if (layers.some(layer => !layer)) return null;
  return rect => finite(rect) && rect.left >= box.left && rect.top >= box.top
    && rect.left + rect.width <= box.left + box.width && rect.top + rect.height <= box.top + box.height
    && layers.every(layer => layer!(rect));
}
