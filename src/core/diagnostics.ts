import { isRGBA, parseColor } from './colors';
import type { RGBA, RuleStatus, TextRun, Viewport } from './types';

export interface DiagnosticSource { kind: 'audit' | 'selection'; id: string }
export interface DiagnosticTarget { referenceId: string; runId: string; source: DiagnosticSource }
export const DIAGNOSTIC_MAX_BYTES = 160_000;
export const DIAGNOSTIC_MAX_LAYERS = 24;

type PaintValue = string | number | RGBA | null;
export interface DiagnosticLayer {
  index: number; role: 'target' | 'ancestor' | 'point-stack'; tag: string;
  rect: { x: number | null; y: number | null; width: number | null; height: number | null };
  styles: Record<string, PaintValue>;
  before: Record<string, PaintValue>; after: Record<string, PaintValue>;
}
export interface DiagnosticMeasurement {
  source: 'audit' | 'selection'; measuredAt: string | null; stale: boolean; runIndex: number;
  viewportPartial?: true;
  viewport: Viewport; reasons: string[];
  foreground: RGBA | null; cssBackground: RGBA | null; effectiveBackground: RGBA | null;
  backgroundRange: { min: RGBA | null; max: RGBA | null } | null;
  fontSizeCssPx: number | null; fontWeight: number | null;
  contrast: { ratio: number | null; status: RuleStatus; reason: string | null; target: 'AA' | 'AAA'; category: 'normal' | 'large' | 'unknown'; AA: { threshold: number | null; status: RuleStatus }; AAA: { threshold: number | null; status: RuleStatus } };
}
export interface DiagnosticReport {
  schemaVersion: 1; kind: 'contrast-diagnostic'; capturedAt: string | null;
  generator: { name: 'Style Inspector Lite'; version: string | null };
  browser: { name: 'Firefox' | 'unknown'; version: string | null };
  measurement: DiagnosticMeasurement;
  currentViewport: Viewport;
  layers: DiagnosticLayer[];
  samples: Array<{ x: number | null; y: number | null; stack: number[] }>;
  limitations: string[];
}

const reasons = new Set(['main-document-only', 'images-canvas-not-tested', 'shadow-dom-not-tested', 'dynamic-content-snapshot', 'scan-limit', 'measurement-complexity-limit', 'measurement-failed', 'document-changed-during-scan', 'selection-text-limit', 'background-image-or-gradient', 'background-coverage', 'layered-background', 'overlapping-element', 'overlap-sampling-limit', 'unsupported-color', 'unresolved-background', 'unknown-text-size', 'unknown-font-size', 'inactive-control', 'group-opacity', 'filter', 'mask', 'blend-mode', 'text-shadow', 'pseudo-element', 'text-pseudo-style', 'text-pseudo-font', 'text-stroke', 'control-text-availability-unknown', 'svg-text', 'gradient-contrast-inconclusive']);
const limits = new Set(['current-styles-not-a-new-measurement', 'no-text-or-page-address', 'ancestor-limit', 'point-stack-limit', 'style-unavailable', 'point-stack-unavailable', 'target-outside-viewport', 'target-without-area', 'report-size-limit', 'background-assets-omitted', 'pseudo-content-omitted']);
const tags = new Set('a abbr address article aside audio b bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li main map mark menu meter nav noscript object ol optgroup option output p picture pre progress q rp rt ruby s samp search section select slot small source span strong sub summary sup svg table tbody td template textarea tfoot th thead time title tr u ul var video wbr custom-element'.split(' '));
const enumStyles: Record<string, readonly string[]> = {
  display: ['none', 'contents', 'block', 'inline', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid', 'flow-root', 'list-item', 'table', 'table-row', 'table-cell', '-webkit-box'],
  position: ['static', 'relative', 'absolute', 'fixed', 'sticky'],
  visibility: ['visible', 'hidden', 'collapse'],
  'pointer-events': ['auto', 'none'],
  'overflow-x': ['visible', 'hidden', 'clip', 'scroll', 'auto'], 'overflow-y': ['visible', 'hidden', 'clip', 'scroll', 'auto'],
  'mix-blend-mode': ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity', 'plus-lighter', 'plus-darker'],
  'isolation': ['auto', 'isolate'], 'text-overflow': ['clip', 'ellipsis'],
  'white-space': ['normal', 'nowrap', 'pre', 'pre-wrap', 'pre-line', 'break-spaces'],
  'color-scheme': ['normal', 'light', 'dark', 'light dark', 'dark light', 'only light', 'only dark'],
};
const colors = new Set(['color', 'background-color', '-webkit-text-fill-color', 'border-top-color']);
const presentStyles = new Set(['filter', 'backdrop-filter', 'transform', 'clip', 'clip-path', 'mask-image', 'box-shadow', 'text-shadow']);
const numericStyles = new Set(['opacity', 'z-index', 'font-size', 'font-weight', 'line-height', 'border-top-width', 'border-radius', '-webkit-line-clamp']);
export const DIAGNOSTIC_STYLE_PROPERTIES = [...Object.keys(enumStyles), ...colors, ...presentStyles, ...numericStyles, 'background-image'];

const finite = (value: unknown, maximum = 1e8): number | null => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maximum ? value : null;
const rgba = (value: RGBA | null | undefined): RGBA | null => isRGBA(value) ? { r: value.r, g: value.g, b: value.b, a: value.a } : null;
const date = (value: unknown): string | null => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ? value : null;
export const diagnosticVersion = (value: unknown): string | null => typeof value === 'string' && /^\d{1,4}(?:\.\d{1,6}){0,3}$/.test(value) ? value : null;
export const diagnosticTag = (tag: string): string => tags.has(tag.toLowerCase()) ? tag.toLowerCase() : 'custom-element';
const status = (value: unknown): RuleStatus => ['pass', 'fail', 'manual', 'not-applicable'].includes(value as string) ? value as RuleStatus : 'manual';
const safeReasons = (value: string[]): string[] => [...new Set(value.map(item => reasons.has(item) ? item : 'unrecognized-reason'))].slice(0, 24);
const viewport = (value: Viewport): Viewport => ({ width: finite(value.width) ?? 0, height: finite(value.height) ?? 0, ...(finite(value.devicePixelRatio, 100) !== null ? { devicePixelRatio: value.devicePixelRatio } : {}) });

/** Values are parsed or summarized, never copied as arbitrary CSS strings. */
export function diagnosticStyleValue(property: string, value: unknown): PaintValue {
  if (colors.has(property)) return typeof value === 'string' ? rgba(parseColor(value).rgba) : rgba(value as RGBA);
  if (typeof value === 'number' && numericStyles.has(property)) return finite(value);
  if (typeof value !== 'string' || value.length > 16_384) return null;
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (enumStyles[property]) return enumStyles[property].includes(text) ? text : 'other';
  if (numericStyles.has(property)) return /^[+-]?(?:\d+\.?\d*|\.\d+)(?:px)?$/.test(text) ? finite(Number.parseFloat(text)) : text === 'normal' || text === 'auto' || text === 'none' ? text : null;
  if (property === 'background-image') return text === 'none' ? 'none' : /^(?:repeating-)?(?:linear|radial|conic)-gradient\(/.test(text) ? 'gradient' : text === 'gradient' || text === 'image-or-other' ? text : 'image-or-other';
  if (presentStyles.has(property)) return text === 'none' || text === 'auto' ? text : 'present';
  if (property === 'generated-content') return text === 'absent' ? 'absent' : 'present';
  return null;
}

export function diagnosticMeasurement(run: TextRun, source: DiagnosticSource['kind'], measuredAt: string, stale: boolean, runIndex: number, measuredViewport: Viewport, sourceReasons: string[]): DiagnosticMeasurement {
  return {
    source, measuredAt: date(measuredAt), stale, runIndex, viewport: viewport(measuredViewport), reasons: safeReasons([...sourceReasons, ...run.reasons]),
    ...(run.viewportPartial === true ? { viewportPartial: true as const } : {}),
    foreground: rgba(run.foreground.rgba), cssBackground: rgba(run.background.rgba), effectiveBackground: rgba(run.effectiveBackground),
    backgroundRange: run.backgroundRange ? { min: rgba(run.backgroundRange.min), max: rgba(run.backgroundRange.max) } : null,
    fontSizeCssPx: finite(run.fontSizeCssPx), fontWeight: finite(run.fontWeight),
    contrast: { ratio: finite(run.contrast.ratio), status: status(run.contrast.status), reason: run.contrast.reason ? reasons.has(run.contrast.reason) ? run.contrast.reason : 'unrecognized-reason' : null,
      target: run.contrast.target === 'AAA' ? 'AAA' : 'AA', category: ['normal', 'large'].includes(run.contrast.category) ? run.contrast.category : 'unknown',
      AA: { threshold: finite(run.contrast.AA.threshold), status: status(run.contrast.AA.status) }, AAA: { threshold: finite(run.contrast.AAA.threshold), status: status(run.contrast.AAA.status) } },
  };
}

/** Rebuild the public object from an allowlist even when callers attach extra fields. */
export function sanitizeDiagnostic(report: DiagnosticReport): DiagnosticReport {
  const safeStyles = (styles: Record<string, PaintValue>) => Object.fromEntries([...DIAGNOSTIC_STYLE_PROPERTIES, 'generated-content'].filter(key => Object.hasOwn(styles, key)).map(key => [key, diagnosticStyleValue(key, styles[key])]));
  const measured = report.measurement;
  const result: DiagnosticReport = {
    schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: date(report.capturedAt),
    generator: { name: 'Style Inspector Lite', version: diagnosticVersion(report.generator.version) },
    browser: { name: report.browser.name === 'Firefox' ? 'Firefox' : 'unknown', version: diagnosticVersion(report.browser.version) },
    measurement: { source: measured.source === 'audit' ? 'audit' : 'selection', measuredAt: date(measured.measuredAt), stale: Boolean(measured.stale), runIndex: finite(measured.runIndex, 1000) ?? 0,
      ...(measured.viewportPartial === true ? { viewportPartial: true as const } : {}),
      viewport: viewport(measured.viewport), reasons: safeReasons(measured.reasons), foreground: rgba(measured.foreground), cssBackground: rgba(measured.cssBackground), effectiveBackground: rgba(measured.effectiveBackground),
      backgroundRange: measured.backgroundRange ? { min: rgba(measured.backgroundRange.min), max: rgba(measured.backgroundRange.max) } : null,
      fontSizeCssPx: finite(measured.fontSizeCssPx), fontWeight: finite(measured.fontWeight), contrast: { ratio: finite(measured.contrast.ratio), status: status(measured.contrast.status), reason: measured.contrast.reason ? reasons.has(measured.contrast.reason) ? measured.contrast.reason : 'unrecognized-reason' : null,
        target: measured.contrast.target === 'AAA' ? 'AAA' : 'AA', category: ['normal', 'large'].includes(measured.contrast.category) ? measured.contrast.category : 'unknown',
        AA: { threshold: finite(measured.contrast.AA.threshold), status: status(measured.contrast.AA.status) }, AAA: { threshold: finite(measured.contrast.AAA.threshold), status: status(measured.contrast.AAA.status) } } },
    currentViewport: viewport(report.currentViewport),
    layers: report.layers.slice(0, DIAGNOSTIC_MAX_LAYERS).map((layer, index) => ({ index, role: ['target', 'ancestor'].includes(layer.role) ? layer.role : 'point-stack', tag: diagnosticTag(layer.tag),
      rect: { x: finite(layer.rect.x), y: finite(layer.rect.y), width: finite(layer.rect.width), height: finite(layer.rect.height) }, styles: safeStyles(layer.styles), before: safeStyles(layer.before), after: safeStyles(layer.after) })),
    samples: report.samples.slice(0, 3).map(sample => ({ x: finite(sample.x), y: finite(sample.y), stack: sample.stack.filter(index => Number.isSafeInteger(index) && index >= 0 && index < Math.min(report.layers.length, DIAGNOSTIC_MAX_LAYERS)).slice(0, 8) })),
    limitations: [...new Set(report.limitations.filter(item => limits.has(item)))].slice(0, 12),
  };
  if (JSON.stringify(result).length > DIAGNOSTIC_MAX_BYTES / 2) {
    result.layers = result.layers.slice(0, 1); result.samples = []; result.limitations.push('report-size-limit');
  }
  return result;
}

export function serializeDiagnostic(report: DiagnosticReport): string { return `${JSON.stringify(sanitizeDiagnostic(report), null, 2)}\n`; }
