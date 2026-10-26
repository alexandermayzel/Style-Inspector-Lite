/** Structured data only. Bounded text excerpts are opt-in for confirmed selections; never DOM references or form values. */
export type ContrastTarget = 'AA' | 'AAA';
export type ColorFormat = 'hex' | 'rgb' | 'hsl';
export type TabId = 'audit' | 'contrast' | 'colors' | 'typography' | 'layout';
export type RuleStatus = 'pass' | 'fail' | 'manual' | 'not-applicable';
export interface Settings {
  schemaVersion: 1;
  appearance: 'system' | 'light' | 'dark';
  colorFormat: ColorFormat;
  contrastTarget: ContrastTarget;
  livePreview: boolean;
  contextMenuEnabled: boolean;
  showDiagnostics: boolean;
}
/** Encoded sRGB channels 0..255 (floats preserved), alpha 0..1. */
export interface RGBA { r: number; g: number; b: number; a: number }
/** Opaque channel bounds, not two colors asserted to occur beneath the text. */
export interface BackgroundRange { min: RGBA; max: RGBA }
export interface ColorValue { raw: string; rgba: RGBA | null; reason?: string }
export interface Viewport { width: number; height: number; devicePixelRatio?: number }
export interface DocumentIdentity { windowId: number; tabId: number; frameId: number; documentToken: string }
export interface RuleResult { status: RuleStatus; reason?: string }
export interface ContrastResult {
  ruleId: 'text.contrast'; ratio: number | null; category: 'normal' | 'large' | 'unknown';
  /** A conservative lower bound across supported gradient backgrounds. */
  ratioKind?: 'minimum';
  target: ContrastTarget; threshold: number; status: RuleStatus; reason?: string;
  AA: RuleResult & { threshold: number }; AAA: RuleResult & { threshold: number };
}
export interface FontSizeResult extends RuleResult {
  ruleId: 'text.font-size-min'; fontSizeCssPx: number | null; thresholdCssPx: 12;
  operator: 'lt'; category: 'readability'; normative: false;
}
/** Transient selected-element text, excluded from storage and standard exports. */
export interface TextExcerpt { value: string; truncated: boolean }
export interface TextRun {
  id: string; elementRef: string; tagName: string; selector: string;
  /** Absent for ordinary element text; never contains the placeholder contents. */
  textSource?: 'placeholder';
  /** Actual glyph fill differs from the ordinary CSS color. */
  foregroundSource?: 'text-fill';
  /** A foreground correction must also make the resolved fill follow color. */
  textFillPresent?: boolean;
  /** The viewport audit omitted positive text fragments outside its bounds. */
  viewportPartial?: true;
  textExcerpt?: TextExcerpt;
  fontSizeCssPx: number | null; fontWeight: number | null;
  /** Computed CSS values for this text run, including placeholder overrides. */
  fontFamily?: string; lineHeight?: string;
  foreground: ColorValue; background: ColorValue; effectiveBackground: RGBA | null;
  backgroundRange?: BackgroundRange;
  ownOpaqueBackground: boolean;
  reasons: string[];
  notApplicable?: string;
  contrast: ContrastResult; fontSize: FontSizeResult;
}
export type StyleGroup = 'colors' | 'typography' | 'layout';
export interface MeasuredStyles {
  colors: Record<string, string>; typography: Record<string, string>; layout: Record<string, string>;
}
export interface Snapshot {
  id: string; document: DocumentIdentity; elementRef: string; tagName: string; selector: string;
  measuredAt: string; viewport: Viewport; stale: boolean; reasons: string[];
  styles: MeasuredStyles; textRuns: TextRun[];
  textExcerpt?: TextExcerpt;
  rect: { width: number; height: number; x: number; y: number };
}
export interface RuleCounts { pass: number; fail: number; manual: number; notApplicable: number; assessed: number }
export interface AuditCounts {
  contrast: RuleCounts; fontSize: RuleCounts; findings: number; affectedRuns: number; checks: number;
}
export type PaletteRole = 'background' | 'text' | 'accent' | 'other';
export type PaletteSort = 'usage' | 'frequency' | 'hue';
/** Counts describe distinct measured text elements, never painted area. */
export interface PaletteUsage { color: ColorValue; count: number; roles: Partial<Record<PaletteRole, number>>; elementRefs?: string[] }
export interface FontVariant { sizeCssPx: number | null; fontWeight: number | null; lineHeight: string; count: number; elementRefs?: string[] }
export interface FontUsage {
  family: string; count: number; elementRefs?: string[];
  sizes: Array<{ sizeCssPx: number | null; count: number; elementRefs?: string[] }>;
  variants?: FontVariant[];
}
export type AuditScope = 'page' | 'viewport' | 'selection';
export type InventoryLimit = 'colors' | 'font-families' | 'font-sizes' | 'font-variants' | 'elements';
export interface InventoryLimits {
  maxColors: number; maxFontFamilies: number; maxFontSizes: number; maxFontVariants: number; maxElements: number;
  reached: InventoryLimit[];
}
export interface Audit {
  id: string; document: DocumentIdentity; measuredAt: string; viewport: Viewport;
  target: ContrastTarget; status: 'running' | 'complete' | 'cancelled' | 'partial';
  stale: boolean; scanned: number; skipped: number; total: number; reasons: string[];
  runs: TextRun[]; palette: ColorValue[]; fonts: string[]; counts: AuditCounts;
  /** Optional for sessions captured before usage inventories were introduced. */
  paletteUsage?: PaletteUsage[]; fontUsage?: FontUsage[];
  /** Optional for older session snapshots. Scope changes only on an explicit scan. */
  scope?: AuditScope; rootElementRef?: string;
  scopeViewport?: { left: number; top: number; width: number; height: number };
  inventoryLimits?: InventoryLimits;
  durationMs?: number; examined?: number;
  limits?: { maxRuns: number; maxElements: number };
  reachedLimits?: ('text-runs' | 'elements' | 'complexity')[];
}
export interface ContrastSuggestion {
  id: string; snapshotId: string; runId: string; target: ContrastTarget;
  property: 'color' | 'background-color'; oldValue: string; newValue: string;
  color: RGBA; foreground: RGBA; background: RGBA;
  beforeRatio: number; afterRatio: number; threshold: number; category: 'normal' | 'large';
  source: 'computed' | 'page-palette'; algorithmVersion: 'oklch-lightness-v1';
  conditions: string[]; applied: false;
}
export type SimulationMode = 'original' | 'protanopia' | 'deuteranopia' | 'tritanopia' | 'grayscale';
export type ExportFormat = 'css' | 'scss' | 'json' | 'tailwind';
export type ExportScope = 'all' | StyleGroup;
export type ExportSource =
  | { kind: 'element'; snapshot: Snapshot }
  | { kind: 'page-tokens'; audit: Audit }
  | { kind: 'audit'; audit: Audit }
  | { kind: 'contrast-suggestion'; snapshot: Snapshot; suggestion: ContrastSuggestion };
export interface ExportOptions {
  format: ExportFormat; scope?: ExportScope; colorFormat?: ColorFormat;
  version: string; className?: string; target?: ContrastTarget;
  /** Page tokens: overview usage (including placeholders) or raw element CSS. */
  inventory?: 'measured' | 'css';
}
export interface ExportWarning { code: string; property?: string; detail?: string }
export interface ExportResult { filename: string; mimeType: string; text: string; warnings: ExportWarning[]; classes?: string }
