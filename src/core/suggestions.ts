import { clamp, formatColor, isRGBA, linearToSrgb, parseColor, srgbToLinear } from './colors';
import { contrastRatio, evaluateRun } from './contrast';
import type { ColorValue, ContrastSuggestion, ContrastTarget, RGBA, Snapshot, TextRun } from './types';

export interface Oklab { L: number; a: number; b: number }
// Björn Ottosson's 2021 Oklab conversion constants, public-domain reference:
// https://bottosson.github.io/posts/oklab/ . Transfer functions are in colors.ts.
export function toOklab(color: RGBA): Oklab {
  const r = srgbToLinear(color.r), g = srgbToLinear(color.g), b = srgbToLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return { L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s };
}
export function fromOklab(lab: Oklab): RGBA {
  const l = (lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b) ** 3;
  const m = (lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b) ** 3;
  const s = (lab.L - 0.0894841775 * lab.a - 1.2914855480 * lab.b) ** 3;
  return { r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s), g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s), b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s), a: 1 };
}
function inGamut(c: RGBA): boolean { return [c.r, c.g, c.b].every(v => v >= -1e-6 && v <= 255.000001); }
/** Preserve hue (a:b direction), reduce chroma to sRGB; achromatic has no hue. */
function candidateAt(L: number, original: Oklab): RGBA {
  let low = 0, high = 1;
  let color = fromOklab({ L, a: original.a, b: original.b });
  if (!inGamut(color)) {
    for (let i = 0; i < 18; i++) {
      const factor = (low + high) / 2;
      const probe = fromOklab({ L, a: original.a * factor, b: original.b * factor });
      if (inGamut(probe)) low = factor; else high = factor;
    }
    color = fromOklab({ L, a: original.a * low, b: original.b * low });
  }
  // Quantize before checking, so the suggested HEX is the value that passes.
  return { r: Math.round(clamp(color.r, 0, 255)), g: Math.round(clamp(color.g, 0, 255)), b: Math.round(clamp(color.b, 0, 255)), a: 1 };
}
export function suggestContrast(snapshot: Snapshot, originalRun: TextRun, target: ContrastTarget, property: 'color' | 'background-color' = 'color', palette: ColorValue[] = []): { suggestions: ContrastSuggestion[]; reason?: string } {
  const fail = (reason: string): { suggestions: ContrastSuggestion[]; reason: string } => ({ suggestions: [], reason });
  if (snapshot.stale) return fail('stale-measurement');
  if (!snapshot.textRuns.some(run => run.id === originalRun.id)) return fail('different-text-run');
  // Element-color exports cannot target a separately styled ::placeholder.
  if (originalRun.backgroundRange || originalRun.textSource === 'placeholder') return fail('unsupported-suggestion');
  const run = evaluateRun(originalRun, target), fg = run.foreground.rgba, bg = run.effectiveBackground;
  if (run.contrast.status === 'pass') return fail('already-passes');
  if (run.contrast.status !== 'fail' || !isRGBA(fg) || !isRGBA(bg) || fg.a !== 1 || bg.a !== 1 || run.reasons.length || run.contrast.category === 'unknown' || run.contrast.ratio === null) return fail('unsupported-suggestion');
  if (property === 'background-color' && (!run.ownOpaqueBackground || run.background.rgba?.a !== 1)) return fail('inherited-background');
  const changed = property === 'color' ? fg : bg;
  const origin = toOklab(changed), threshold = run.contrast.threshold;
  const scored = new Map<string, { color: RGBA; ratio: number; distance: number; source: 'computed' | 'page-palette' }>();
  const add = (color: RGBA, source: 'computed' | 'page-palette'): void => {
    if (!isRGBA(color) || color.a !== 1) return;
    // Palette entries can have fractional channels. Validate the exact default
    // serialized color as well, not only the pre-formatting floating-point input.
    color = parseColor(formatColor(color)).rgba!;
    const ratio = contrastRatio(property === 'color' ? color : fg, property === 'color' ? bg : color);
    if (ratio < threshold) return;
    const name = formatColor(color, 'hex'), lab = toOklab(color);
    const distance = Math.hypot(lab.L - origin.L, lab.a - origin.a, lab.b - origin.b);
    if (!scored.has(name) || source === 'page-palette') scored.set(name, { color, ratio, distance, source });
  };
  // Bounded bidirectional grid, then locally refine around the best verified
  // sample. No assumption that gamut mapping is globally monotonic.
  for (let i = 0; i <= 256; i++) add(candidateAt(i / 256, origin), 'computed');
  const closest = [...scored.values()].sort((a, b) => a.distance - b.distance)[0];
  if (closest) {
    const L = toOklab(closest.color).L;
    for (let i = -64; i <= 64; i++) add(candidateAt(clamp(L + i / 16384), origin), 'computed');
  }
  // Real palette candidates retain original precision and are never fabricated.
  for (const color of palette.slice(0, 512)) if (color.rgba) add(color.rgba, 'page-palette');
  if (!scored.size) return fail('target-unreachable');
  const sorted = [...scored.values()].sort((a, b) => a.distance - b.distance || formatColor(a.color).localeCompare(formatColor(b.color)));
  // Avoid three visually identical adjacent channel steps: prefer one nearby
  // computed candidate, then an actual palette option and the other polarity.
  const chosen = [sorted[0]];
  const page = sorted.find(c => c.source === 'page-palette' && c !== chosen[0]);
  if (page) chosen.push(page);
  const alternate = sorted.find(c => c !== chosen[0] && c !== page && Math.sign(toOklab(c.color).L - origin.L) !== Math.sign(toOklab(chosen[0].color).L - origin.L));
  if (alternate) chosen.push(alternate);
  const suggestions = chosen.slice(0, 3).map((candidate, index): ContrastSuggestion => ({
    id: `${snapshot.id}:${run.id}:${target}:${property}:${index}`, snapshotId: snapshot.id, runId: run.id,
    target, property, oldValue: formatColor(changed), newValue: formatColor(candidate.color), color: candidate.color,
    foreground: { ...fg }, background: { ...bg }, beforeRatio: run.contrast.ratio!, afterRatio: candidate.ratio,
    threshold, category: run.contrast.category as 'normal' | 'large', source: candidate.source,
    algorithmVersion: 'oklch-lightness-v1', applied: false,
    conditions: ['same-text-run', 'same-font-size-and-weight', property === 'color' ? 'unchanged-background' : 'unchanged-foreground', 'current-measurement-only',
      ...(property === 'color' && (run.textFillPresent === true || run.foregroundSource === 'text-fill') ? ['text-fill-reset-to-currentcolor'] : [])],
  }));
  return { suggestions };
}
