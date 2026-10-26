import { isRGBA, parseColor } from './colors';
import type { Audit, ColorValue, FontUsage, FontVariant, InventoryLimit, PaletteRole, PaletteSort, PaletteUsage, TextRun } from './types';

const paletteLimit = 128, fontLimit = 64, elementLimit = 1000;
const roles: PaletteRole[] = ['background', 'text', 'accent', 'other'];
const inventoryLimitOrder: InventoryLimit[] = ['colors', 'font-families', 'font-sizes', 'font-variants', 'elements'];
const copyColor = (color: ColorValue): ColorValue => ({ ...color, rgba: color.rgba ? { ...color.rgba } : null });
// UI HEX labels intentionally round channels. Identity must retain the complete
// measured values, including alpha and noninteger channels.
const colorKey = (color: ColorValue): string => isRGBA(color.rgba)
  ? `rgba:${color.rgba.r},${color.rgba.g},${color.rgba.b},${color.rgba.a}`
  : `raw:${color.raw.trim()}`;
const colored = (color: ColorValue): boolean => isRGBA(color.rgba) && color.rgba.a > 0;
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const metric = (value: number | null): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const copyRefs = <T extends { elementRefs?: string[] }>(entry: T): T => ({ ...entry, ...(entry.elementRefs ? { elementRefs: [...new Set(entry.elementRefs)].slice(0, elementLimit) } : {}) });
const copyFont = (entry: FontUsage): FontUsage => ({ ...copyRefs(entry), sizes: entry.sizes.map(copyRefs), ...(entry.variants ? { variants: entry.variants.map(copyRefs) } : {}) });
const variantKey = (variant: Pick<FontVariant, 'sizeCssPx' | 'fontWeight' | 'lineHeight'>): string => JSON.stringify([variant.sizeCssPx, variant.fontWeight, variant.lineHeight]);
function mergeUsage(target: { count: number; elementRefs?: string[] }, source: { count: number; elementRefs?: string[] }): void {
  const complete = target.elementRefs?.length === target.count && source.elementRefs?.length === source.count;
  const refs = target.elementRefs || source.elementRefs ? [...new Set([...(target.elementRefs ?? []), ...(source.elementRefs ?? [])])].slice(0, elementLimit) : undefined;
  target.count = complete && refs ? refs.length : target.count + source.count;
  if (refs) target.elementRefs = refs;
}

/** Bounded ancestry inspection; no labels, text contents or form values. */
export function hasInteractiveAncestor(element: Element): boolean {
  let current: Element | null = element;
  for (let depth = 0; current && depth < 64; depth++, current = current.parentElement) {
    const tag = current.tagName.toUpperCase();
    if (['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(tag)
      || (['A', 'AREA'].includes(tag) && current.hasAttribute('href'))) return true;
    const role = current.getAttribute('role')?.trim().toLowerCase().split(/\s+/)[0];
    if (role && ['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'checkbox', 'radio', 'switch', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton'].includes(role)) return true;
  }
  return false;
}

/** One instance per scan; snapshots contain no mutable collection references. */
export class StyleInventory {
  // A scan can measure one large element in several cooperative chunks. Keep
  // only accepted inventory keys here so repeated chunks neither multiply
  // occurrences nor grow bookkeeping beyond the public inventory bounds.
  private readonly elements = new Map<string, {
    colors: Map<string, Set<PaletteRole>>;
    fonts: Map<string, { sizes: Set<number | null>; variants: Set<string> }>;
  }>();
  private readonly reached = new Set<InventoryLimit>();
  private readonly palette = new Map<string, ColorValue>();
  private readonly paletteKeys = new Set<string>();
  private readonly colors = new Map<string, PaletteUsage>();
  private readonly fonts = new Map<string, FontUsage>();
  private readonly fontSizes = new Map<string, Map<number | null, FontUsage['sizes'][number]>>();
  private readonly fontVariants = new Map<string, Map<string, FontVariant>>();
  private readonly cssFonts = new Set<string>();

  record(elementRef: string, style: Pick<CSSStyleDeclaration, 'color' | 'backgroundColor' | 'fontFamily'> & Partial<Pick<CSSStyleDeclaration, 'lineHeight'>>, runs: readonly TextRun[], interactive: boolean): void {
    if (!runs.length) return;
    let element = this.elements.get(elementRef);
    if (!element) {
      if (this.elements.size >= elementLimit) { this.reached.add('elements'); return; }
      element = { colors: new Map(), fonts: new Map() }; this.elements.set(elementRef, element);
    }
    // Preserve the raw CSS inventory used by existing token exports.
    for (const raw of [style.color, style.backgroundColor]) {
      if (!this.palette.has(raw)) {
        const color = parseColor(raw), key = colorKey(color);
        if (this.palette.size < paletteLimit) { this.palette.set(raw, color); this.paletteKeys.add(key); }
        else if (!this.paletteKeys.has(key)) this.reached.add('colors');
      }
    }
    const cssFamily = style.fontFamily.trim().slice(0, 512);
    if (cssFamily && !this.cssFonts.has(cssFamily)) {
      if (this.cssFonts.size < fontLimit) this.cssFonts.add(cssFamily);
      else this.reached.add('font-families');
    }
    const observed = new Map<string, { color: ColorValue; roles: Set<PaletteRole> }>();
    const add = (color: ColorValue, role: PaletteRole) => {
      const key = colorKey(color);
      let item = observed.get(key);
      if (!item) { item = { color, roles: new Set() }; observed.set(key, item); }
      item.roles.add(colored(color) ? role : 'other');
    };
    const ownBackground = parseColor(style.backgroundColor);
    add(ownBackground, interactive ? 'accent' : 'background');
    for (const run of runs) {
      add(run.foreground, interactive ? 'accent' : 'text');
      // Effective backgrounds are available only where measurement resolved a
      // solid surface. A CSS estimate or gradient range is not such a surface.
      if (isRGBA(run.effectiveBackground) && run.effectiveBackground.a === 1 && !run.backgroundRange && !run.reasons.length) {
        const rgba = run.effectiveBackground;
        const color: ColorValue = { raw: `rgb(${rgba.r} ${rgba.g} ${rgba.b})`, rgba };
        add(color, interactive && colorKey(color) === colorKey(ownBackground) ? 'accent' : 'background');
      }
    }
    const cssForeground = parseColor(style.color);
    if (!observed.has(colorKey(cssForeground))) add(cssForeground, 'other');
    for (const [key, item] of observed) {
      let entry = this.colors.get(key);
      if (!entry) {
        if (this.colors.size >= paletteLimit) { this.reached.add('colors'); continue; }
        entry = { color: copyColor(item.color), count: 0, roles: {}, elementRefs: [] }; this.colors.set(key, entry);
      }
      let seenRoles = element.colors.get(key);
      if (!seenRoles) {
        seenRoles = new Set(); element.colors.set(key, seenRoles);
        entry.count++; entry.elementRefs!.push(elementRef);
      }
      // The computed foreground is only an "other" fallback until a later
      // chunk measures it as real text or background on this same element.
      if (colored(item.color) && [...item.roles].some(role => role !== 'other') && seenRoles.delete('other')) {
        if (entry.roles.other! > 1) entry.roles.other = entry.roles.other! - 1;
        else delete entry.roles.other;
      }
      for (const role of item.roles) if (!seenRoles.has(role)) {
        if (role === 'other' && colored(item.color) && seenRoles.size) continue;
        seenRoles.add(role); entry.roles[role] = (entry.roles[role] ?? 0) + 1;
      }
    }
    // A placeholder can use a different family from the input itself. Record
    // actual run metrics together, never combine a placeholder size with its
    // control's unrelated family or line height.
    const observedFonts = new Map<string, Map<string, FontVariant>>();
    for (const run of runs) {
      const family = (run.fontFamily ?? cssFamily).trim().slice(0, 512);
      if (!family) continue;
      let variants = observedFonts.get(family);
      if (!variants) { variants = new Map(); observedFonts.set(family, variants); }
      const variant = { sizeCssPx: metric(run.fontSizeCssPx), fontWeight: metric(run.fontWeight), lineHeight: (run.lineHeight ?? style.lineHeight ?? '').trim().slice(0, 128), count: 1, elementRefs: [elementRef] };
      variants.set(variantKey(variant), variant);
    }
    for (const [family, variants] of observedFonts) {
      let font = this.fonts.get(family);
      if (!font) {
        if (this.fonts.size >= fontLimit) { this.reached.add('font-families'); continue; }
        font = { family, count: 0, sizes: [], variants: [], elementRefs: [] }; this.fonts.set(family, font);
        this.fontSizes.set(family, new Map()); this.fontVariants.set(family, new Map());
      }
      let seen = element.fonts.get(family);
      if (!seen) {
        seen = { sizes: new Set(), variants: new Set() }; element.fonts.set(family, seen);
        font.count++; font.elementRefs!.push(elementRef);
      }
      for (const sizeCssPx of new Set([...variants.values()].map(variant => variant.sizeCssPx))) {
        if (seen.sizes.has(sizeCssPx)) continue;
        const sizes = this.fontSizes.get(family)!, size = sizes.get(sizeCssPx);
        if (size) { size.count++; size.elementRefs!.push(elementRef); }
        else if (font.sizes.length < elementLimit) { const item = { sizeCssPx, count: 1, elementRefs: [elementRef] }; font.sizes.push(item); sizes.set(sizeCssPx, item); }
        else { this.reached.add('font-sizes'); continue; }
        seen.sizes.add(sizeCssPx);
      }
      for (const [key, variant] of variants) {
        if (seen.variants.has(key)) continue;
        const indexed = this.fontVariants.get(family)!, previous = indexed.get(key);
        if (previous) { previous.count++; previous.elementRefs!.push(elementRef); }
        else if (font.variants!.length < elementLimit) { font.variants!.push(variant); indexed.set(key, variant); }
        else { this.reached.add('font-variants'); continue; }
        seen.variants.add(key);
      }
    }
  }

  snapshot(): Pick<Audit, 'palette' | 'fonts' | 'paletteUsage' | 'fontUsage' | 'inventoryLimits'> {
    return {
      palette: [...this.palette.values()].map(copyColor), fonts: [...this.cssFonts],
      paletteUsage: [...this.colors.values()].map(entry => ({ ...copyRefs(entry), color: copyColor(entry.color), roles: { ...entry.roles } })),
      fontUsage: [...this.fonts.values()].map(copyFont),
      inventoryLimits: { maxColors: paletteLimit, maxFontFamilies: fontLimit, maxFontSizes: elementLimit,
        maxFontVariants: elementLimit, maxElements: elementLimit, reached: inventoryLimitOrder.filter(limit => this.reached.has(limit)) },
    };
  }
}

export function primaryPaletteRole(entry: PaletteUsage): PaletteRole {
  if (!colored(entry.color)) return 'other';
  return roles.find(role => (entry.roles[role] ?? 0) > 0) ?? 'other';
}

function hueComponents(color: ColorValue): number[] {
  if (!colored(color)) return [isRGBA(color.rgba) ? 1 : 2, 0, 0, 0, 0];
  const { r, g, b, a } = color.rgba!;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), delta = max - min;
  const lightness = (max + min) / 510;
  const neutral = delta <= 1;
  const hue = neutral ? 0 : ((max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4) * 60 + 360) % 360;
  return [0, neutral ? 0 : 1, hue, -lightness, -a];
}
function compareHue(a: PaletteUsage, b: PaletteUsage): number {
  const left = hueComponents(a.color), right = hueComponents(b.color);
  for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return left[index] - right[index];
  return compareText(colorKey(a.color), colorKey(b.color));
}
export function getPaletteEntries(audit: Pick<Audit, 'palette' | 'paletteUsage'>, sort: PaletteSort = 'usage'): PaletteUsage[] {
  const entries = new Map<string, PaletteUsage>();
  const source: PaletteUsage[] = audit.paletteUsage ?? audit.palette.map(color => ({ color, count: 0, roles: {} }));
  for (const item of source) {
    const key = colorKey(item.color);
    const existing = entries.get(key);
    if (existing) {
      mergeUsage(existing, item);
      for (const role of roles) if (item.roles[role]) existing.roles[role] = (existing.roles[role] ?? 0) + item.roles[role]!;
    } else if (entries.size < paletteLimit) entries.set(key, { ...copyRefs(item), color: copyColor(item.color), roles: { ...item.roles } });
  }
  return [...entries.values()].sort((a, b) => {
    // Transparent and unresolved values have no standalone visible swatch.
    const visibility = Number(!colored(a.color)) - Number(!colored(b.color));
    if (visibility) return visibility;
    if (sort === 'usage') {
      const role = roles.indexOf(primaryPaletteRole(a)) - roles.indexOf(primaryPaletteRole(b));
      if (role) return role;
    }
    if (sort !== 'hue' && a.count !== b.count) return b.count - a.count;
    return compareHue(a, b);
  });
}

export function getFontEntries(audit: Pick<Audit, 'fonts' | 'fontUsage'>): FontUsage[] {
  const entries = new Map<string, FontUsage>();
  const sizes = new Map<string, Map<number | null, FontUsage['sizes'][number]>>();
  const variants = new Map<string, Map<string, FontVariant>>();
  const source: FontUsage[] = audit.fontUsage ?? audit.fonts.map(family => ({ family, count: 0, sizes: [] }));
  for (const item of source) {
    let existing = entries.get(item.family);
    if (!existing) {
      if (entries.size >= fontLimit) continue;
      existing = { family: item.family, count: 0, sizes: [], ...(item.elementRefs ? { elementRefs: [] } : {}), ...(item.variants ? { variants: [] } : {}) }; entries.set(item.family, existing);
      sizes.set(item.family, new Map()); variants.set(item.family, new Map());
    }
    mergeUsage(existing, item);
    for (const size of item.sizes) {
      const indexed = sizes.get(item.family)!, previous = indexed.get(size.sizeCssPx);
      if (previous) mergeUsage(previous, size);
      else if (existing.sizes.length < elementLimit) { const copied = copyRefs(size); existing.sizes.push(copied); indexed.set(size.sizeCssPx, copied); }
    }
    for (const variant of item.variants ?? []) {
      existing.variants ??= [];
      const indexed = variants.get(item.family)!, key = variantKey(variant), previous = indexed.get(key);
      if (previous) mergeUsage(previous, variant);
      else if (existing.variants.length < elementLimit) { const copied = copyRefs(variant); existing.variants.push(copied); indexed.set(key, copied); }
    }
  }
  const compareMetric = (a: number | null, b: number | null): number => a === null ? Number(b !== null) : b === null ? -1 : a - b;
  const compareLineHeight = (a: string, b: string): number => /^\d+(?:\.\d+)?px$/.test(a) && /^\d+(?:\.\d+)?px$/.test(b) ? parseFloat(a) - parseFloat(b) : compareText(a, b);
  for (const entry of entries.values()) {
    entry.sizes.sort((a, b) => compareMetric(a.sizeCssPx, b.sizeCssPx));
    entry.variants?.sort((a, b) => compareMetric(a.sizeCssPx, b.sizeCssPx) || compareMetric(a.fontWeight, b.fontWeight) || compareLineHeight(a.lineHeight, b.lineHeight));
  }
  return [...entries.values()].sort((a, b) => b.count - a.count || compareText(a.family.toLowerCase(), b.family.toLowerCase()) || compareText(a.family, b.family));
}

/** Resolve saved inventory associations without selectors, text or a fresh scan. */
export function getInventoryRuns(audit: Pick<Audit, 'runs'>, elementRefs: readonly string[], prefer?: (run: TextRun) => boolean): TextRun[] {
  const refs = new Set<string>();
  for (const ref of elementRefs) { if (refs.size >= elementLimit) break; refs.add(ref); }
  const matches = new Map<string, TextRun>();
  for (const run of audit.runs) {
    if (!refs.has(run.elementRef)) continue;
    const previous = matches.get(run.elementRef);
    if (!previous || (prefer && !prefer(previous) && prefer(run))) matches.set(run.elementRef, run);
  }
  return [...matches.values()];
}
