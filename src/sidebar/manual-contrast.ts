import { parseColor } from '../core/colors';
import { evaluateContrast } from '../core/contrast';
import type { RGBA } from '../core/types';

/** Opaque HEX only: manual input never silently guesses alpha or page context. */
export function parseManualHex(value: string): { hex: string; rgba: RGBA } | null {
  const raw = value.trim();
  if (!/^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(raw)) return null;
  const hex = (raw.length === 4 ? '#' + [...raw.slice(1)].map(channel => channel + channel).join('') : raw).toUpperCase();
  return { hex, rgba: parseColor(hex).rgba! };
}

export function manualContrast(foreground: string, background: string) {
  const fg = parseManualHex(foreground), bg = parseManualHex(background);
  if (!fg || !bg) return null;
  const input = { foreground: fg.rgba, background: bg.rgba, fontWeight: 400 };
  return { foreground: fg, background: bg,
    normal: evaluateContrast({ ...input, fontSizeCssPx: 16 }),
    large: evaluateContrast({ ...input, fontSizeCssPx: 24 }),
  };
}
