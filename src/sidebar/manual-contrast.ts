import { composite, formatColor, formatDisplayColor, isRGBA, parseColor } from '../core/colors';
import { evaluateContrast } from '../core/contrast';
import type { RGBA } from '../core/types';

/** Opaque HEX only: manual input never silently guesses alpha or page context. */
export function parseManualHex(value: string): { hex: string; rgba: RGBA } | null {
  const raw = value.trim();
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(raw)) return null;
  const hex = (raw.length === 4 ? '#' + [...raw.slice(1)].map(channel => channel + channel).join('') : raw).toUpperCase();
  return { hex, rgba: parseColor(hex).rgba! };
}

/** Restrict manual input to explicit numeric colors; never resolve page variables or system colors. */
export function parseManualColor(value: string): { value: string; hex: string; rgba: RGBA } | null {
  const raw = value.trim();
  if (raw.length > 128 || !/^(?:#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})|rgba?\([\d\s.,%/+\-e]+\))$/i.test(raw)) return null;
  const rgba = parseColor(raw).rgba;
  if (!isRGBA(rgba)) return null;
  return { value: formatColor(rgba, 'hex'), hex: formatDisplayColor({ ...rgba, a: 1 }, 'hex'), rgba };
}

export function manualContrast(foreground: string, background: string, underlay?: string) {
  const fg = parseManualColor(foreground), bg = parseManualColor(background);
  if (!fg || !bg) return null;
  const base = bg.rgba.a < 1 ? parseManualColor(underlay ?? '') : null;
  if (bg.rgba.a < 1 && (!base || base.rgba.a !== 1)) return null;
  const effectiveBackground = base ? composite(bg.rgba, base.rgba) : bg.rgba;
  const input = { foreground: fg.rgba, background: effectiveBackground, fontWeight: 400 };
  return { foreground: fg, background: bg, underlay: base, effectiveBackground,
    normal: evaluateContrast({ ...input, fontSizeCssPx: 16 }),
    large: evaluateContrast({ ...input, fontSizeCssPx: 24 }),
  };
}
