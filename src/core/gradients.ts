import { composite, isRGBA, parseColor } from './colors';
import type { BackgroundRange, ColorValue, RGBA } from './types';

const MAX_INPUT = 4096;
const MAX_STOPS = 32;
const MAX_LAYERS = 16;
const number = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[+-]?\\d+)?';
const position = new RegExp(`^(?:${number}(?:px|%)|[+-]?0(?:\\.0+)?)$`, 'i');
const angle = new RegExp(`^(?:${number}(?:deg|grad|rad|turn)|[+-]?0(?:\\.0+)?)$`, 'i');

/** Split CSS lists without treating commas inside functions or URLs as layers. */
function splitList(raw: string, maximum: number): string[] | null {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_INPUT) return null;
  const values: string[] = [];
  let start = 0, depth = 0, quote = '';
  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]!;
    if (quote) {
      if (char === '\\') { index++; continue; }
      if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === '\\') return null;
    if (char === '(') { if (++depth > 8) return null; }
    else if (char === ')') { if (--depth < 0) return null; }
    else if (char === ',' && depth === 0) {
      const value = raw.slice(start, index).trim();
      if (!value || values.length >= maximum - 1) return null;
      values.push(value); start = index + 1;
    }
  }
  const last = raw.slice(start).trim();
  if (quote || depth !== 0 || !last) return null;
  values.push(last);
  return values;
}

export function splitBackgroundLayers(raw: string): string[] | null {
  return splitList(raw, MAX_LAYERS);
}

function validDirection(value: string): boolean {
  if (angle.test(value)) return Number.isFinite(Number.parseFloat(value));
  const match = /^to (left|right|top|bottom)(?: (left|right|top|bottom))?$/.exec(value);
  if (!match) return false;
  return !match[2] || ['left', 'right'].includes(match[1]!) !== ['left', 'right'].includes(match[2]);
}

/**
 * Read a bounded subset whose interpolation stays in encoded sRGB. Stop
 * positions change where colors occur, not the conservative set of colors.
 * Other functions/spaces, hints, unresolved expressions and syntax stay manual.
 */
export function parseLinearGradient(raw: string): RGBA[] | null {
  if (typeof raw !== 'string' || raw.length > MAX_INPUT) return null;
  const match = /^linear-gradient\((.*)\)$/is.exec(raw.trim());
  if (!match) return null;
  const parts = splitList(match[1]!, MAX_STOPS + 1);
  if (!parts) return null;
  let explicitSrgb = false;
  const first = parts[0]!.toLowerCase().replace(/\s+/g, ' ');
  if (first.startsWith('to ') || first.startsWith('in ') || /\bin srgb\b/.test(first) || angle.test(first)) {
    let direction = first;
    if (/\bin srgb\b/.test(direction)) {
      explicitSrgb = true;
      direction = direction.replace(/\bin srgb\b/, '').trim();
    }
    if (direction && !validDirection(direction)) return null;
    if (!direction && !explicitSrgb) return null;
    parts.shift();
  }
  if (parts.length < 2 || parts.length > MAX_STOPS) return null;
  const stops: RGBA[] = [];
  for (const part of parts) {
    const colorMatch = /^(#[\da-f]{3,8}|[a-z]+\([^()]*\)|[a-z]+)(.*)$/i.exec(part);
    if (!colorMatch) return null;
    const rawColor = colorMatch[1]!;
    // New color parsers must not silently expand the supported interpolation
    // spaces. Only legacy functions and explicit color(srgb ...) are admitted.
    const colorFunction = /^([a-z]+)\(/i.exec(rawColor)?.[1]?.toLowerCase();
    if (colorFunction && !['rgb', 'rgba', 'hsl', 'hsla'].includes(colorFunction)
      && !(explicitSrgb && /^color\(\s*srgb\s/i.test(rawColor))) return null;
    const color = parseColor(rawColor).rgba;
    if (!isRGBA(color)) return null;
    const tail = colorMatch[2]!;
    if (tail && !/^\s/.test(tail)) return null;
    const positions = tail.trim() ? tail.trim().split(/\s+/) : [];
    if (positions.length > 2 || positions.some(value => !position.test(value) || !Number.isFinite(Number.parseFloat(value)))) return null;
    stops.push(color);
  }
  return stops;
}

export interface GradientBackgroundLayer {
  color: ColorValue;
  gradients: RGBA[][];
  /** The first image is opaque and independently proved to cover all text. */
  coveringTopImage?: true;
}

export function isBackgroundRange(range: BackgroundRange | null | undefined): range is BackgroundRange {
  return Boolean(range && isRGBA(range.min) && isRGBA(range.max) && range.min.a === 1 && range.max.a === 1
    && range.min.r <= range.max.r && range.min.g <= range.max.g && range.min.b <= range.max.b);
}

/**
 * CSS layers nearest first, and each layer's images front to back. A known
 * opaque farthest color anchors the calculation. Premultiplied sRGB gradient
 * interpolation is a convex combination after composition over an opaque
 * background, so channel bounds enclose every intermediate color. Including
 * uncovered background avoids assumptions about size, repeat and clipping.
 * A separately proven opaque top image anchors its own range and hides every
 * underlying color/image, including otherwise unrecognized background colors.
 */
export function compositeGradientRange(layers: GradientBackgroundLayer[]): BackgroundRange | null {
  if (!layers.length || layers.length > 300) return null;
  const anchor = layers.findIndex(layer => layer.coveringTopImage === true);
  let range: BackgroundRange, start: number;
  if (anchor >= 0) {
    const layer = layers[anchor]!, stops = layer.gradients[0];
    if (layer.gradients.length > MAX_LAYERS || !stops || stops.length < 2 || stops.length > MAX_STOPS
      || !stops.every(stop => isRGBA(stop) && stop.a === 1)) return null;
    const min = { ...stops[0]! }, max = { ...stops[0]! };
    for (const stop of stops) for (const channel of ['r', 'g', 'b'] as const) {
      min[channel] = Math.min(min[channel], stop[channel]);
      max[channel] = Math.max(max[channel], stop[channel]);
    }
    range = { min, max }; start = anchor - 1;
  } else {
    const base = layers[layers.length - 1]!.color.rgba;
    if (!isRGBA(base) || base.a !== 1) return null;
    range = { min: { ...base }, max: { ...base } }; start = layers.length - 1;
  }
  for (let index = start; index >= 0; index--) {
    const layer = layers[index]!;
    if (!isRGBA(layer.color.rgba) || layer.gradients.length > MAX_LAYERS) return null;
    range = { min: composite(layer.color.rgba, range.min), max: composite(layer.color.rgba, range.max) };
    for (let image = layer.gradients.length - 1; image >= 0; image--) {
      const stops = layer.gradients[image]!;
      if (stops.length < 2 || stops.length > MAX_STOPS || !stops.every(isRGBA)) return null;
      const below = range;
      const min = { ...below.min }, max = { ...below.max };
      for (const stop of stops) {
        const low = composite(stop, below.min), high = composite(stop, below.max);
        for (const channel of ['r', 'g', 'b'] as const) {
          min[channel] = Math.min(min[channel], low[channel]);
          max[channel] = Math.max(max[channel], high[channel]);
        }
      }
      range = { min, max };
    }
  }
  return isBackgroundRange(range) ? range : null;
}
