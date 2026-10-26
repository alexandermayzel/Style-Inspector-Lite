import { formatColor, isRGBA, parseColor } from './colors';
import { contrastRatio, cssColorContrast, evaluateRun, reassessAudit } from './contrast';
import { isBackgroundRange } from './gradients';
import { getFontEntries, getPaletteEntries } from './style-inventory';
import type { Audit, ColorFormat, ColorValue, ExportOptions, ExportResult, ExportSource, ExportWarning, MeasuredStyles, Snapshot, StyleGroup, TextRun } from './types';

/** Physical longhands win; no shorthand/longhand duplicates or inferred values. */
export const STYLE_PROPERTIES: Record<StyleGroup, readonly string[]> = {
  colors: ['color', 'background-color', 'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color'],
  typography: ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-transform', 'text-align', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color'],
  layout: ['box-sizing', 'display', 'position', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left', 'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius', 'flex-direction', 'flex-wrap', 'align-items', 'justify-content', 'align-content', 'flex-grow', 'flex-shrink', 'flex-basis', 'row-gap', 'column-gap', 'grid-template-columns', 'grid-template-rows'],
};
type Declaration = { property: string; raw: string; value: string; group: StyleGroup };
const ALL_PROPERTIES = new Set(Object.values(STYLE_PROPERTIES).flat());
const COLOR_PROPERTIES = new Set([...STYLE_PROPERTIES.colors, 'text-decoration-color']);
const keywordProperties: Record<string, readonly string[]> = {
  'box-sizing': ['border-box', 'content-box'], display: ['none', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'table', 'table-cell', 'table-row', 'flow-root', 'contents', 'list-item'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'], 'font-style': ['normal', 'italic', 'oblique'],
  'text-transform': ['none', 'capitalize', 'uppercase', 'lowercase', 'full-width', 'full-size-kana'],
  'text-align': ['start', 'end', 'left', 'right', 'center', 'justify', 'match-parent'],
  'text-decoration-line': ['none', 'underline', 'overline', 'line-through', 'underline overline', 'underline line-through', 'overline line-through', 'underline overline line-through'],
  'text-decoration-style': ['solid', 'double', 'dotted', 'dashed', 'wavy'],
  'flex-direction': ['row', 'row-reverse', 'column', 'column-reverse'], 'flex-wrap': ['nowrap', 'wrap', 'wrap-reverse'],
};
const commonAlign = /^(?:(?:safe|unsafe) )?(?:normal|stretch|start|end|center|flex-start|flex-end|self-start|self-end|baseline|first baseline|last baseline|space-between|space-around|space-evenly)$/;
const length = /^(?:0|-?(?:\d+\.?\d*|\.\d+)(?:px|em|rem|%|vh|vw|vmin|vmax|ch|ex|pt|pc|in|cm|mm))$/;
function dimensionValue(property: string, raw: string): boolean {
  const nonnegative = (value: string) => length.test(value) && Number.parseFloat(value) >= 0;
  if (property === 'line-height') return raw === 'normal' || nonnegative(raw) || /^(?:\d+\.?\d*|\.\d+)$/.test(raw);
  if (property === 'letter-spacing') return raw === 'normal' || length.test(raw);
  if (property.startsWith('margin-')) return raw === 'auto' || length.test(raw);
  if (property.startsWith('grid-template-')) return raw === 'none' || raw.split(' ').every(value => ['auto', 'min-content', 'max-content'].includes(value) || nonnegative(value) || /^\d+(?:\.\d+)?fr$/.test(value));
  if (property.endsWith('-radius')) { const parts = raw.split(' '); return parts.length <= 2 && parts.every(nonnegative); }
  if (property === 'row-gap' || property === 'column-gap') return raw === 'normal' || nonnegative(raw);
  if (['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'flex-basis'].includes(property)) {
    if (nonnegative(raw) || ['min-content', 'max-content', 'fit-content'].includes(raw)) return true;
    return property.startsWith('max-') ? raw === 'none' : raw === 'auto';
  }
  return nonnegative(raw);
}

/** Deliberately narrow, grammar-aware export boundary. Unknowns are omitted. */
export function safeValue(property: string, raw: string): boolean {
  if (!ALL_PROPERTIES.has(property) || typeof raw !== 'string' || !raw || raw.length > 2048 || /[\x00-\x1f\x7f;{}<>\\@]/.test(raw) || /\/\*|\*\/|#\{|\$|\b(?:url|var|env|expression|attr)\s*\(/i.test(raw)) return false;
  if (COLOR_PROPERTIES.has(property)) return isRGBA(parseColor(raw).rgba);
  if (property === 'font-family') {
    // A list of safe quoted or unquoted family names. Interpolation, escapes and
    // punctuation with cross-language meaning are intentionally unsupported.
    return raw.split(',').every(part => /^(?:"[\p{L}\p{N} _.-]+"|'[\p{L}\p{N} _.-]+'|[\p{L}][\p{L}\p{N} _-]*)$/u.test(part.trim()));
  }
  if (keywordProperties[property]) return keywordProperties[property].includes(raw);
  if (/^border-(?:top|right|bottom|left)-style$/.test(property)) return /^(none|hidden|solid|dashed|dotted|double|groove|ridge|inset|outset)$/.test(raw);
  if (['align-items', 'align-content', 'justify-content'].includes(property)) return commonAlign.test(raw);
  if (property === 'font-weight') return /^(?:[1-9]\d{0,2}(?:\.\d+)?|1000|normal|bold)$/.test(raw);
  if (property === 'flex-grow' || property === 'flex-shrink') return /^(?:\d+\.?\d*|\.\d+)$/.test(raw);
  return dimensionValue(property, raw);
}
function formatValue(property: string, raw: string, options: ExportOptions, warnings: ExportWarning[]): string {
  if (!COLOR_PROPERTIES.has(property)) return raw;
  const color = parseColor(raw).rgba!;
  const value = formatColor(color, options.colorFormat ?? 'hex');
  if ((options.colorFormat ?? 'hex') === 'hex' && !value.startsWith('#')) warnings.push({ code: 'precise-color-fallback', property });
  return value;
}
function collectStyles(styles: MeasuredStyles, options: ExportOptions, warnings: ExportWarning[]): Declaration[] {
  const result: Declaration[] = [];
  const groups: StyleGroup[] = options.scope && options.scope !== 'all' ? [options.scope] : ['colors', 'typography', 'layout'];
  for (const group of groups) {
    for (const property of STYLE_PROPERTIES[group]) {
      const raw = styles[group][property];
      if (raw === undefined) continue;
      if (!safeValue(property, raw)) { warnings.push({ code: 'unsupported-value', property }); continue; }
      result.push({ property, raw, value: formatValue(property, raw, options, warnings), group });
    }
    for (const property of Object.keys(styles[group])) if (!STYLE_PROPERTIES[group].includes(property)) warnings.push({ code: 'unsupported-property', property: /^[a-z-]{1,64}$/.test(property) ? property : undefined });
  }
  return result;
}
function metadata(data: Snapshot | Audit) {
  const inventory = 'status' in data ? data.inventoryLimits : undefined;
  const inventoryFields = ['maxColors', 'maxFontFamilies', 'maxFontSizes', 'maxFontVariants', 'maxElements'] as const;
  const inventoryLimits = inventory && inventoryFields.every(key => Number.isSafeInteger(inventory[key]) && inventory[key] > 0)
    ? { ...Object.fromEntries(inventoryFields.map(key => [key, inventory[key]])),
      reached: Array.isArray(inventory.reached) ? [...new Set(inventory.reached.filter(value => ['colors', 'font-families', 'font-sizes', 'font-variants', 'elements'].includes(value)))] : [] } : undefined;
  const scopeViewport = 'status' in data && data.scope === 'viewport' ? data.scopeViewport : undefined;
  const scan = 'status' in data ? {
    scanStatus: data.status, scanned: data.scanned, skipped: data.skipped, total: data.total,
    ...(data.scope && ['page', 'viewport', 'selection'].includes(data.scope) ? { scope: data.scope } : {}),
    ...(typeof data.durationMs === 'number' && Number.isFinite(data.durationMs) && data.durationMs >= 0 ? { durationMs: data.durationMs } : {}),
    ...(Number.isSafeInteger(data.examined) && data.examined! >= 0 ? { examined: data.examined } : {}),
    ...(data.limits && Number.isSafeInteger(data.limits.maxRuns) && data.limits.maxRuns > 0
      && Number.isSafeInteger(data.limits.maxElements) && data.limits.maxElements > 0
      ? { limits: { maxRuns: data.limits.maxRuns, maxElements: data.limits.maxElements } } : {}),
    ...(Array.isArray(data.reachedLimits) ? { reachedLimits: [...new Set(data.reachedLimits.filter(value => ['text-runs', 'elements', 'complexity'].includes(value)))] } : {}),
    ...(inventoryLimits ? { inventoryLimits } : {}),
    ...(scopeViewport && (['left', 'top', 'width', 'height'] as const).every(key => Number.isFinite(scopeViewport[key]))
      && scopeViewport.width > 0 && scopeViewport.height > 0
      ? { scopeViewport: { left: scopeViewport.left, top: scopeViewport.top, width: scopeViewport.width, height: scopeViewport.height } } : {}),
  } : {};
  return { measuredAt: data.measuredAt, viewport: { width: data.viewport.width, height: data.viewport.height }, stale: data.stale, limitations: data.reasons, ...scan };
}
function publicColor(value: ColorValue) {
  // Unknown modern color spaces may be metadata, but never executable styles.
  const safeRaw = typeof value.raw === 'string' && value.raw.length <= 512 && /^[a-zA-Z0-9().,%# /+\-]+$/.test(value.raw);
  return { raw: safeRaw ? value.raw : null, rgba: isRGBA(value.rgba) ? value.rgba : null, ...(value.reason ? { reason: value.reason } : {}) };
}
function publicRun(run: TextRun, index: number) {
  // CSS-pair thresholds remain a separate optional object. They never replace
  // the actual page verdict or contribute to the exported audit counters.
  const sample = cssColorContrast(run);
  return {
    reference: `text-${String(index + 1).padStart(4, '0')}`, tagName: /^[a-z][a-z0-9-]{0,63}$/.test(run.tagName) ? run.tagName : 'element',
    ...(run.textSource === 'placeholder' ? { textSource: 'placeholder' } : {}),
    ...(run.viewportPartial === true ? { viewportPartial: true } : {}),
    foreground: publicColor(run.foreground), cssBackground: publicColor(run.background), effectiveBackground: run.effectiveBackground,
    ...(isBackgroundRange(run.backgroundRange) ? { backgroundRange: run.backgroundRange } : {}),
    fontSizeCssPx: run.fontSizeCssPx, fontWeight: run.fontWeight,
    contrast: run.contrast, fontSize: run.fontSize,
    ...(sample ? { cssColorContrast: sample } : {}),
  };
}
function styleJSON(declarations: Declaration[]) {
  return declarations.map(d => ({ group: d.group, property: d.property, raw: d.raw, formatted: d.value, ...(COLOR_PROPERTIES.has(d.property) ? { rgba: parseColor(d.raw).rgba } : {}) }));
}
function pageTokens(audit: Audit, options: ExportOptions, warnings: ExportWarning[]): Declaration[] {
  const result: Declaration[] = [];
  const colors = new Map<string, ColorValue>();
  const palette = options.inventory === 'measured' ? getPaletteEntries(audit).map(entry => entry.color) : audit.palette;
  const fonts = options.inventory === 'measured' ? getFontEntries(audit).map(entry => entry.family) : audit.fonts;
  for (const color of palette.slice(0, 1024)) {
    if (!isRGBA(color.rgba)) { warnings.push({ code: 'unsupported-palette-color' }); continue; }
    const canonical = formatColor(color.rgba, 'rgb');
    colors.set(canonical, color);
  }
  [...colors.keys()].sort().forEach((key, index) => {
    const color = colors.get(key)!;
    result.push({ property: `sil-color-${String(index + 1).padStart(3, '0')}`, raw: publicColor(color).raw ?? formatColor(color.rgba!, 'rgb'), value: formatColor(color.rgba!, options.colorFormat ?? 'hex'), group: 'colors' });
  });
  [...new Set(fonts)].sort().slice(0, 512).forEach((font, index) => {
    if (!safeValue('font-family', font)) { warnings.push({ code: 'unsupported-font-family' }); return; }
    result.push({ property: `sil-font-${String(index + 1).padStart(3, '0')}`, raw: font, value: font, group: 'typography' });
  });
  return result;
}
function safeClass(name?: string): string {
  if (name === undefined || name === '') return 'sil-inspected-element';
  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error('invalid-export-class');
  return name;
}
/** Only exact property utilities; there is no assumption about the target theme. */
function tailwindClass(d: Declaration): string | null {
  if (/[[\]\\]/.test(d.value)) return null;
  const fixed: Record<string, string> = { block: 'block', inline: 'inline', 'inline-block': 'inline-block', flex: 'flex', 'inline-flex': 'inline-flex', grid: 'grid', 'inline-grid': 'inline-grid', none: 'hidden', contents: 'contents', 'flow-root': 'flow-root' };
  if (d.property === 'display' && fixed[d.value]) return fixed[d.value];
  // Literal underscores must survive Tailwind's whitespace decoding.
  const value = d.value.replace(/_/g, '\\_').replace(/\s/g, '_');
  return `[${d.property}:${value}]`;
}
function warningComment(warnings: ExportWarning[]): string {
  return warnings.length ? `/* Notes: ${warnings.map(w => w.code + (w.property ? ` (${w.property})` : '')).join('; ')}. */\n` : '';
}
function scssValue(declaration: Declaration): string {
  if (declaration.property !== 'font-family' && !declaration.property.startsWith('sil-font-')) return declaration.value;
  // CSS family identifiers such as null, red or Alpha or Beta are Sass values
  // or expressions. Quote actual names while preserving CSS generic keywords.
  const generic = /^(?:serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-serif|ui-sans-serif|ui-monospace|ui-rounded|emoji|math|fangsong|inherit|initial|unset|revert|revert-layer)$/i;
  return declaration.value.split(',').map(part => {
    const family = part.trim();
    return /^["']/.test(family) || generic.test(family) ? family : `"${family}"`;
  }).join(', ');
}
/** Colors-tab quick copy, separate from an element style-rule file export. */
export function serializeColorVariables(snapshot: Snapshot, colorFormat: ColorFormat = 'hex'): string {
  const warnings: ExportWarning[] = [];
  const declarations = collectStyles(snapshot.styles, { format: 'css', scope: 'colors', colorFormat, version: '0.0.0' }, warnings);
  return '/* Generated export names from measured colors; not original design tokens. */\n' + warningComment(warnings) + ':root {\n' + declarations.map((d, i) => `  --sil-color-${String(i + 1).padStart(3, '0')}: ${d.value}; /* ${d.property} */`).join('\n') + '\n}\n';
}
export function serializeExport(source: ExportSource, options: ExportOptions): ExportResult {
  if (!/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error('invalid-generator-version');
  if (!['css', 'scss', 'json', 'tailwind'].includes(options.format)) throw new Error('unsupported-export-format');
  if (options.inventory !== undefined && !['measured', 'css'].includes(options.inventory)) throw new Error('unsupported-export-inventory');
  if (source.kind === 'audit' && options.format !== 'json') throw new Error('audit-requires-json');
  const warnings: ExportWarning[] = [];
  const data = 'snapshot' in source ? source.snapshot : source.audit;
  if (data.stale) warnings.push({ code: 'stale-measurement' });
  if ('status' in data && data.status !== 'complete') warnings.push({ code: 'partial-scan' });
  if ('status' in data && Array.isArray(data.inventoryLimits?.reached)
    && data.inventoryLimits.reached.some(value => ['colors', 'font-families', 'font-sizes', 'font-variants', 'elements'].includes(value))) warnings.push({ code: 'partial-style-inventory' });
  const className = safeClass(options.className);
  const isPage = source.kind === 'page-tokens';
  const target = options.target ?? ('audit' in source ? source.audit.target : source.snapshot.textRuns[0]?.contrast.target ?? 'AA');
  let declarations: Declaration[] = [], suggestionJSON: Record<string, unknown> | undefined;
  if (source.kind === 'element') declarations = collectStyles(source.snapshot.styles, options, warnings);
  if (isPage) declarations = pageTokens(source.audit, options, warnings);
  if (source.kind === 'contrast-suggestion') {
    const suggestion = source.suggestion;
    if (suggestion.property !== 'color' && suggestion.property !== 'background-color') throw new Error('invalid-suggestion-property');
    const run = source.snapshot.textRuns.find(r => r.id === suggestion.runId);
    if (source.snapshot.stale || suggestion.snapshotId !== source.snapshot.id || !run || (options.target && options.target !== suggestion.target)) throw new Error('stale-suggestion');
    const current = evaluateRun(run, suggestion.target);
    if (current.backgroundRange || current.textSource === 'placeholder' || current.contrast.status !== 'fail' || current.foreground.rgba?.a !== 1 || current.effectiveBackground?.a !== 1 || (suggestion.property === 'background-color' && !run.ownOpaqueBackground)) throw new Error('invalid-suggestion-context');
    const newColor = parseColor(suggestion.newValue).rgba;
    if (!isRGBA(newColor) || newColor.a !== 1) throw new Error('invalid-suggestion-color');
    const value = formatColor(newColor, options.colorFormat ?? 'hex');
    const emitted = parseColor(value).rgba!;
    const ratio = contrastRatio(suggestion.property === 'color' ? emitted : current.foreground.rgba, suggestion.property === 'color' ? current.effectiveBackground : emitted);
    if (ratio < current.contrast.threshold) throw new Error('suggestion-below-target');
    declarations = [{ property: suggestion.property, raw: suggestion.newValue, value, group: 'colors' }];
    // Resolved currentColor and an equal explicitly fixed fill look identical.
    // Reset every observed fill for a foreground correction, independently of
    // caller metadata; source evidence also supports older stored snapshots.
    const resetFill = suggestion.property === 'color' && (current.textFillPresent === true || current.foregroundSource === 'text-fill');
    const conditions = suggestion.conditions.filter(condition => condition !== 'text-fill-reset-to-currentcolor');
    if (resetFill) {
      declarations.push({ property: '-webkit-text-fill-color', raw: 'currentColor', value: 'currentColor', group: 'colors' });
      conditions.push('text-fill-reset-to-currentcolor');
    }
    suggestionJSON = { property: suggestion.property, oldValue: suggestion.property === 'color' ? formatColor(current.foreground.rgba) : formatColor(current.effectiveBackground), newValue: value, color: emitted,
      ...(resetFill ? { additionalDeclarations: [{ property: '-webkit-text-fill-color', value: 'currentColor' }] } : {}),
      originalForeground: current.foreground.rgba, originalBackground: current.effectiveBackground, beforeRatio: current.contrast.ratio, afterRatio: ratio, category: current.contrast.category, target: suggestion.target, threshold: current.contrast.threshold, source: suggestion.source, conditions, algorithmVersion: suggestion.algorithmVersion, applied: false };
  }
  const groups = options.scope && options.scope !== 'all' ? [options.scope] : ['colors', 'typography', 'layout'];
  const baseName = `style-inspector-lite-${source.kind}${source.kind === 'element' ? `-${options.scope ?? 'all'}` : ''}`;
  const measured = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(data.measuredAt) ? data.measuredAt : 'unknown';
  const dimensions = [data.viewport.width, data.viewport.height].every(n => Number.isFinite(n) && n >= 0) ? `${data.viewport.width}x${data.viewport.height}` : 'unknown';
  let origin = source.kind === 'contrast-suggestion' ? 'Contrast suggestion; not applied. Only this text run and unchanged opposite color are covered.' : 'Generated from measured styles. Export names are generated, not original design tokens.';
  origin += ` Measured: ${measured}; page viewport: ${dimensions} CSS px.`;
  if (source.kind === 'page-tokens') {
    if (options.inventory) origin += options.inventory === 'measured' ? ' Inventory: page overview (measured usage).' : ' Inventory: raw element CSS.';
    const scope = source.audit.scope;
    const scopeLabel = scope === 'page' ? 'whole page' : scope === 'viewport' ? 'initial visible area' : scope === 'selection' ? 'selected section' : null;
    const status = ['running', 'complete', 'partial', 'cancelled'].includes(source.audit.status) ? source.audit.status : 'unknown';
    if (scopeLabel) origin += ` Audit scope: ${scopeLabel}; audit status: ${status}.`;
  }
  if (source.kind === 'contrast-suggestion' && suggestionJSON) {
    origin += ` Original foreground: ${formatColor(source.suggestion.foreground)}; original background: ${formatColor(source.suggestion.background)}. Target: ${source.suggestion.target}; threshold: ${suggestionJSON.threshold}:1; before: ${suggestionJSON.beforeRatio}:1; after: ${suggestionJSON.afterRatio}:1. Font size and weight must remain unchanged.`;
  }
  let text: string, classes: string | undefined;
  let extension = options.format === 'tailwind' ? isPage ? 'theme.css' : 'tailwind.txt' : options.format;
  let mimeType = extension.endsWith('css') && options.format !== 'scss' ? 'text/css;charset=utf-8' : options.format === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8';
  if (options.format === 'json') {
    const json: Record<string, unknown> = { schemaVersion: 2, generator: { name: 'Style Inspector Lite', version: options.version }, kind: source.kind, metadata: metadata(data), warnings };
    if (source.kind === 'element') Object.assign(json, { groups, generatedSelector: `.${className}`, styles: styleJSON(declarations), textRuns: source.snapshot.textRuns.map((r, i) => publicRun(evaluateRun(r, target), i)), visualRect: { width: source.snapshot.rect.width, height: source.snapshot.rect.height }, target });
    if (source.kind === 'page-tokens') Object.assign(json, { generatedTokens: declarations.map(d => ({ name: d.property, origin: 'generated', group: d.group, raw: d.raw, value: d.value })), target, ...(options.inventory ? { inventory: options.inventory } : {}) });
    if (source.kind === 'audit') {
      const audit = reassessAudit(source.audit, target);
      Object.assign(json, { target, ruleDefinitions: [{ ruleId: 'text.contrast', normative: true, normal: { AA: 4.5, AAA: 7 }, large: { AA: 3, AAA: 4.5 } }, { ruleId: 'text.font-size-min', thresholdCssPx: 12, operator: 'lt', category: 'readability', normative: false }], counts: audit.counts, textRuns: audit.runs.map(publicRun), palette: audit.palette.map(publicColor), cssFontFamilies: audit.fonts.filter(font => safeValue('font-family', font)), recommendations: [] });
    }
    if (suggestionJSON) Object.assign(json, suggestionJSON, { generatedSelector: `.${className}` });
    text = JSON.stringify(json, (_key, value) => { if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non-finite-export-value'); return value; }, 2) + '\n';
  } else if (options.format === 'css') {
    text = `/* ${origin} */\n` + warningComment(warnings) + `${isPage ? ':root' : `.${className}`} {\n` + declarations.map(d => `  ${isPage ? '--' : ''}${d.property}: ${d.value};`).join('\n') + '\n}\n';
  } else if (options.format === 'scss') {
    const reusable = declarations.filter(d => d.group === 'colors' || d.property === 'font-family' || isPage);
    const variable = (d: Declaration): string => `$${isPage ? d.property : `sil-${d.property}`}`;
    text = `/* ${origin} */\n` + warningComment(warnings) + reusable.map(d => `${variable(d)}: ${scssValue(d)};`).join('\n') + '\n';
    if (!isPage) text += `\n.${className} {\n` + declarations.map(d => `  ${d.property}: ${reusable.includes(d) ? variable(d) : d.value};`).join('\n') + '\n}\n';
  } else if (isPage) {
    text = `/* Generated Tailwind CSS v4 theme; import into your existing v4 stylesheet. ${origin} */\n` + warningComment(warnings) + '@theme static {\n' + declarations.map(d => `  --${d.group === 'colors' ? 'color' : 'font'}-${d.property.replace(/^sil-(?:color|font)-/, 'sil-')}: ${d.value};`).join('\n') + '\n}\n';
  } else {
    const list: string[] = [];
    for (const d of declarations) { const c = tailwindClass(d); if (c) list.push(c); else warnings.push({ code: 'unsupported-tailwind-value', property: d.property }); }
    classes = list.join(' ');
    text = `Tailwind CSS v4 — ${origin}\nPlace the complete classes in a source file scanned by your Tailwind build.\n\n${classes}\n` + (warnings.length ? `\nNotes:\n${warnings.map(w => `- ${w.code}${w.property ? `: ${w.property}` : ''}`).join('\n')}\n` : '');
  }
  return { filename: `${baseName}.${extension}`, mimeType, text, warnings, ...(classes !== undefined ? { classes } : {}) };
}
