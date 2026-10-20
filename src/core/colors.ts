import type { ColorFormat, ColorValue, RGBA } from './types';
import { parseOkColor } from './ok-colors';

export const clamp = (n: number, min = 0, max = 1): number => Math.min(max, Math.max(min, n));
export const isRGBA = (c: RGBA | null | undefined): c is RGBA => Boolean(c && [c.r, c.g, c.b, c.a].every(Number.isFinite) && c.r >= 0 && c.r <= 255 && c.g >= 0 && c.g <= 255 && c.b >= 0 && c.b <= 255 && c.a >= 0 && c.a <= 1);
const numberToken = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i;
function component(token: string, scale: number): number {
  if (!numberToken.test(token)) return NaN;
  return token.endsWith('%') ? parseFloat(token) * scale / 100 : Number(token);
}
export function parseColor(raw: string): ColorValue {
  const unknown = (): ColorValue => ({ raw, rgba: null, reason: 'unsupported-color' });
  if (typeof raw !== 'string' || raw.length > 512) return unknown();
  const s = raw.trim().toLowerCase();
  if (s === 'transparent') return { raw, rgba: { r: 0, g: 0, b: 0, a: 0 } };
  const named: Record<string, string> = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', rebeccapurple: '#663399' };
  if (named[s]) return { ...parseColor(named[s]), raw };
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(s)) {
    const h = s.length <= 5 ? [...s.slice(1)].map(x => x + x).join('') : s.slice(1);
    return { raw, rgba: { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 } };
  }
  if (/^ok(?:lab|lch)\(/.test(s)) {
    const rgba = parseOkColor(s);
    return rgba ? { raw, rgba } : unknown();
  }
  const srgb = /^color\(\s*srgb\s+([^()]*)\)$/.exec(s);
  if (srgb) {
    // Firefox serializes native placeholder colors in this form. Keep the
    // normalized sRGB precision; other spaces and gamut mapping stay explicit.
    const parts = srgb[1].split('/');
    if (parts.length > 2) return unknown();
    const channels = parts[0].trim().split(/\s+/);
    const alpha = parts[1]?.trim() ?? '1';
    if (channels.length !== 3 || ![...channels, alpha].every(token => /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?%?$/i.test(token))) return unknown();
    const rgb = channels.map(token => component(token, 1));
    const a = component(alpha, 1);
    // Out-of-gamut channels require CSS gamut mapping, not channel clipping.
    if (!Number.isFinite(a) || rgb.some(value => !Number.isFinite(value) || value < 0 || value > 1)) return unknown();
    return { raw, rgba: { r: rgb[0] * 255, g: rgb[1] * 255, b: rgb[2] * 255, a: clamp(a) } };
  }
  const match = /^(rgba?|hsla?)\(([^()]*)\)$/.exec(s);
  if (!match) return unknown();
  const comma = match[2].includes(',');
  if (comma && match[2].includes('/')) return unknown();
  const pieces = comma ? match[2].split(',').map(x => x.trim()) : match[2].replace(/\s*\/\s*/, ' ').trim().split(/\s+/);
  if (pieces.length !== 3 && pieces.length !== 4) return unknown();
  const a = pieces[3] === undefined ? 1 : component(pieces[3], 1);
  let rgb: number[];
  if (match[1].startsWith('rgb')) {
    rgb = pieces.slice(0, 3).map(p => component(p, 255));
  } else {
    const hToken = pieces[0].replace(/deg$/, '');
    if (!numberToken.test(hToken) || !Number.isFinite(Number(hToken)) || hToken.endsWith('%') || !pieces[1].endsWith('%') || !pieces[2].endsWith('%')) return unknown();
    const h = ((Number(hToken) % 360) + 360) % 360 / 60;
    const sat = clamp(component(pieces[1], 1)), l = clamp(component(pieces[2], 1));
    // Avoid subtracting almost equal values for colors very close to black.
    const c = 2 * Math.min(l, 1 - l) * sat, x = c * (1 - Math.abs(h % 2 - 1)), m = l - c / 2;
    const bands = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]];
    rgb = bands[Math.floor(h)].map(v => (v + m) * 255);
  }
  if (![...rgb, a].every(Number.isFinite)) return unknown();
  return { raw, rgba: { r: clamp(rgb[0], 0, 255), g: clamp(rgb[1], 0, 255), b: clamp(rgb[2], 0, 255), a: clamp(a) } };
}
export function composite(foreground: RGBA, background: RGBA): RGBA {
  const a = foreground.a + background.a * (1 - foreground.a);
  if (!a) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = (f: number, b: number): number => (f * foreground.a + b * background.a * (1 - foreground.a)) / a;
  return { r: channel(foreground.r, background.r), g: channel(foreground.g, background.g), b: channel(foreground.b, background.b), a };
}
/** Nearest layer first. An unknown/unpainted canvas is deliberately not assumed white. */
export function resolveBackground(layers: ColorValue[]): { rgba: RGBA | null; reason?: string } {
  let result: RGBA = { r: 0, g: 0, b: 0, a: 0 };
  for (const layer of layers) {
    if (!isRGBA(layer.rgba)) return { rgba: null, reason: layer.reason ?? 'unsupported-color' };
    result = composite(result, layer.rgba);
    if (result.a === 1) return { rgba: result };
  }
  return { rgba: null, reason: 'unresolved-background' };
}
export function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
export function linearToSrgb(channel: number): number {
  return 255 * (channel <= 0.0031308 ? 12.92 * channel : 1.055 * channel ** (1 / 2.4) - 0.055);
}
export function luminance(color: RGBA): number {
  return 0.2126 * srgbToLinear(color.r) + 0.7152 * srgbToLinear(color.g) + 0.0722 * srgbToLinear(color.b);
}
const decimal = (n: number): string => String(Number(n.toPrecision(15)));
/** UI labels use byte-rounded HEX; measurements and code exports keep formatColor precision. */
export function formatDisplayColor(color: RGBA, format: ColorFormat = 'hex'): string {
  if (!isRGBA(color)) throw new Error('invalid-color');
  if (format !== 'hex') return formatColor(color, format);
  const channels = [color.r, color.g, color.b, ...(color.a === 1 ? [] : [color.a * 255])];
  return '#' + channels.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('').toUpperCase();
}

export function formatColor(color: RGBA, format: ColorFormat = 'hex'): string {
  if (!isRGBA(color)) throw new Error('invalid-color');
  const { r, g, b, a } = color;
  if (format === 'hex' && [r, g, b].every(Number.isInteger) && (a === 1 || Math.abs(a * 255 - Math.round(a * 255)) < 1e-12)) {
    return '#' + [r, g, b, ...(a === 1 ? [] : [Math.round(a * 255)])].map(x => x.toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  if (format === 'hsl') {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min, l = (max / 255 + min / 255) / 2;
    // Compute saturation in channel units. 1 - abs(2*l - 1) can round to
    // zero near either endpoint even when the original color has chroma.
    const s = d === 0 ? 0 : d / (l <= 0.5 ? max + min : (255 - max) + (255 - min));
    const hue = d === 0 ? 0 : (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
    return `hsl(${decimal(hue)} ${decimal(s * 100)}% ${decimal(l * 100)}%${a === 1 ? '' : ` / ${decimal(a)}`})`;
  }
  return `rgb(${decimal(r)} ${decimal(g)} ${decimal(b)}${a === 1 ? '' : ` / ${decimal(a)}`})`;
}
