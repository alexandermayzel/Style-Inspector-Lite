import type { RGBA } from './types';

const numeric = /^[+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?(%?)$/;
const angle = /^([+-]?(?:\d+|\d*\.\d+)(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/;
const clip = (value: number): number => Math.max(0, Math.min(1, value));

function channel(token: string, percentScale: number): number {
  // Missing components are zero for a standalone used color, not during
  // interpolation. This parser must not be used to interpolate gradient stops.
  if (token === 'none') return 0;
  const match = numeric.exec(token);
  if (!match) return NaN;
  return match[1] ? parseFloat(token) / 100 * percentScale : Number(token);
}

function hue(token: string): number {
  if (token === 'none') return 0;
  const match = angle.exec(token);
  if (!match) return NaN;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return NaN;
  const period = match[2] === 'turn' ? 1 : match[2] === 'grad' ? 400 : match[2] === 'rad' ? 2 * Math.PI : 360;
  // Reduce before conversion so a large, finite angle cannot overflow.
  return (value % period) / period * 2 * Math.PI;
}

/** Absolute OKLab/OKLCH only; input is normalized by parseColor. */
export function parseOkColor(input: string): RGBA | null {
  if (input.length > 512) return null;
  const match = /^(oklab|oklch)\(([\x20\t\n\r\f\x21-\x7e]*)\)$/.exec(input);
  if (!match) return null;
  const parts = match[2].split('/');
  if (parts.length > 2) return null;
  const values = parts[0].trim().split(/[ \t\n\r\f]+/);
  if (values.length !== 3) return null;
  const lightness = channel(values[0], 1);
  let a = channel(values[1], .4);
  let b = match[1] === 'oklch' ? hue(values[2]) : channel(values[2], .4);
  const alpha = parts.length === 2 ? channel(parts[1].trim(), 1) : 1;
  if (![lightness, a, b, alpha].every(Number.isFinite)) return null;
  if (match[1] === 'oklch') {
    const chroma = Math.max(0, a), radians = b;
    a = chroma * Math.cos(radians);
    b = chroma * Math.sin(radians);
  }

  // CSS Color 4 conversion matrices: OKLab -> LMS -> XYZ D65 -> linear sRGB.
  // https://www.w3.org/TR/css-color-4/#color-conversion-code
  const L = clip(lightness);
  const l = (L + .3963377773761749 * a + .2158037573099136 * b) ** 3;
  const m = (L - .1055613458156586 * a - .0638541728258133 * b) ** 3;
  const s = (L - .0894841775298119 * a - 1.2914855480194092 * b) ** 3;
  const x = 1.2268798758459243 * l - .5578149944602171 * m + .2813910456659647 * s;
  const y = -.0405757452148008 * l + 1.1122868032803170 * m - .0717110580655164 * s;
  const z = -.0763729366746601 * l - .4214933324022432 * m + 1.5869240198367816 * s;
  const linear = [
    12831 / 3959 * x - 329 / 214 * y - 1974 / 3959 * z,
    -851781 / 878810 * x + 1648619 / 878810 * y + 36519 / 878810 * z,
    705 / 12673 * x - 2585 / 12673 * y + 705 / 667 * z,
  ];
  if (!linear.every(Number.isFinite)) return null;

  // Match Firefox's default sRGB display conversion (verified in 142/158),
  // which clips out-of-gamut channels after conversion. This is deliberately
  // not CSS's newer chroma-reduction algorithm: that would display different
  // colors here (e.g. L=1 with chroma becomes white instead of pale yellow).
  // Custom layout.css.gamut-mapping.method settings are outside this model.
  // https://searchfox.org/firefox-main/source/layout/style/StyleColor.cpp
  // Keep full channel precision; only the UI's HEX formatter rounds to bytes.
  const rgb = linear.map(value => {
    const bounded = clip(value);
    return 255 * (bounded <= .0031308 ? 12.92 * bounded : 1.055 * bounded ** (1 / 2.4) - .055);
  });
  return { r: rgb[0], g: rgb[1], b: rgb[2], a: clip(alpha) };
}
