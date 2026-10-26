import { composite, isRGBA, luminance } from './colors';
import { isBackgroundRange } from './gradients';
import type { Audit, AuditCounts, BackgroundRange, ContrastResult, ContrastTarget, FontSizeResult, RGBA, RuleCounts, RuleStatus, Snapshot, TextRun } from './types';

export function contrastRatio(foreground: RGBA, background: RGBA): number {
  if (!isRGBA(foreground) || !isRGBA(background) || background.a !== 1) throw new Error('unresolved-color-pair');
  const fg = foreground.a === 1 ? foreground : composite(foreground, background);
  const l1 = luminance(fg), l2 = luminance(background);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
export interface CssColorContrast {
  ratio: number; verified: false; basis: 'css-colors'; omitted: 'page-layers-and-effects';
  category: ContrastResult['category'];
  AA?: { threshold: number; status: 'pass' | 'fail' };
  AAA?: { threshold: number; status: 'pass' | 'fail' };
}
function textCategory(size: number | null, weight: number | null): ContrastResult['category'] {
  const known = size !== null && Number.isFinite(size) && size > 0 && weight !== null && Number.isFinite(weight) && weight > 0;
  return !known ? 'unknown' : size >= 24 || (size >= 14 * 96 / 72 && weight >= 700) ? 'large' : 'normal';
}
/** Mathematical CSS thresholds only, never a verdict about the painted page. */
export function cssColorContrast(run: TextRun): CssColorContrast | null {
  if (run.contrast.ratio !== null || run.contrast.status !== 'manual' || run.notApplicable
    || run.backgroundRange !== undefined || !isRGBA(run.foreground.rgba)
    || !isRGBA(run.effectiveBackground) || run.effectiveBackground.a !== 1) return null;
  const ratio = contrastRatio(run.foreground.rgba, run.effectiveBackground);
  // Validate the measured inputs anew: a stored contrast category may belong to
  // older font settings. Unknown size/weight permits a ratio, not a threshold.
  const category = textCategory(run.fontSizeCssPx, run.fontWeight);
  const comparison = (threshold: number) => ({ threshold, status: ratio >= threshold ? 'pass' as const : 'fail' as const });
  return { ratio, verified: false, basis: 'css-colors', omitted: 'page-layers-and-effects', category,
    ...(category === 'unknown' ? {} : { AA: comparison(category === 'large' ? 3 : 4.5), AAA: comparison(category === 'large' ? 4.5 : 7) }) };
}
export interface ContrastInput {
  foreground: RGBA | null; background: RGBA | null;
  backgroundRange?: BackgroundRange;
  fontSizeCssPx: number | null; fontWeight: number | null; target?: ContrastTarget;
  reasons?: string[]; notApplicable?: string;
}
export function evaluateContrast(input: ContrastInput): ContrastResult {
  const { fontSizeCssPx: size, fontWeight: weight } = input;
  const category = textCategory(size, weight), known = category !== 'unknown';
  const aa = category === 'large' ? 3 : 4.5, aaa = category === 'large' ? 4.5 : 7;
  const target = input.target ?? 'AA';
  const range = input.backgroundRange;
  const validRange = isBackgroundRange(range);
  const reason = input.notApplicable ?? input.reasons?.[0] ?? (!known ? 'unknown-text-size' : !isRGBA(input.foreground) ? 'unsupported-color'
    : range !== undefined ? !validRange ? 'unresolved-background' : input.foreground.a !== 1 ? 'background-image-or-gradient' : undefined
    : !isRGBA(input.background) || input.background.a !== 1 ? 'unresolved-background' : undefined);
  if (!reason && validRange) {
    const low = luminance(range.min), high = luminance(range.max), foreground = luminance(input.foreground!);
    const ratio = foreground < low ? (low + 0.05) / (foreground + 0.05)
      : foreground > high ? (foreground + 0.05) / (high + 0.05) : 1;
    const result = (threshold: number) => ratio >= threshold
      ? { threshold, status: 'pass' as const }
      : { threshold, status: 'manual' as const, reason: 'gradient-contrast-inconclusive' };
    const AA = result(aa), AAA = result(aaa), selected = target === 'AA' ? AA : AAA;
    return { ruleId: 'text.contrast', ratio, ratioKind: 'minimum', category, target, ...selected, AA, AAA };
  }
  const ratio = reason ? null : contrastRatio(input.foreground!, input.background!);
  const status = (threshold: number): RuleStatus => input.notApplicable ? 'not-applicable' : reason || ratio === null ? 'manual' : ratio >= threshold ? 'pass' : 'fail';
  return { ruleId: 'text.contrast', ratio, category, target, threshold: target === 'AA' ? aa : aaa, status: status(target === 'AA' ? aa : aaa), ...(reason ? { reason } : {}), AA: { threshold: aa, status: status(aa), ...(reason ? { reason } : {}) }, AAA: { threshold: aaa, status: status(aaa), ...(reason ? { reason } : {}) } };
}
export function evaluateFontSize(size: number | null, notApplicable?: string): FontSizeResult {
  const valid = size !== null && Number.isFinite(size) && size > 0;
  return { ruleId: 'text.font-size-min', fontSizeCssPx: valid ? size : null, thresholdCssPx: 12, operator: 'lt', category: 'readability', normative: false, status: notApplicable ? 'not-applicable' : !valid ? 'manual' : size < 12 ? 'fail' : 'pass', ...((notApplicable || !valid) ? { reason: notApplicable ?? 'unknown-font-size' } : {}) };
}
export function evaluateRun(run: TextRun, target: ContrastTarget): TextRun {
  return { ...run, contrast: evaluateContrast({ foreground: run.foreground.rgba, background: run.effectiveBackground, backgroundRange: run.backgroundRange, fontSizeCssPx: run.fontSizeCssPx, fontWeight: run.fontWeight, target, reasons: run.reasons, notApplicable: run.notApplicable }), fontSize: evaluateFontSize(run.fontSizeCssPx, run.notApplicable) };
}
const emptyCounts = (): RuleCounts => ({ pass: 0, fail: 0, manual: 0, notApplicable: 0, assessed: 0 });
export function summarizeRuns(runs: TextRun[]): AuditCounts {
  const contrast = emptyCounts(), fontSize = emptyCounts();
  let findings = 0, affectedRuns = 0;
  for (const run of runs) {
    for (const [result, count] of [[run.contrast, contrast], [run.fontSize, fontSize]] as const) {
      count[result.status === 'not-applicable' ? 'notApplicable' : result.status]++;
      count.assessed++;
    }
    const count = Number(run.contrast.status === 'fail') + Number(run.fontSize.status === 'fail');
    findings += count; affectedRuns += Number(count > 0);
  }
  return { contrast, fontSize, findings, affectedRuns, checks: runs.length * 2 };
}
export function reassessAudit(audit: Audit, target: ContrastTarget): Audit {
  const runs = audit.runs.map(run => evaluateRun(run, target));
  return { ...audit, target, runs, counts: summarizeRuns(runs) };
}

/** Compare observed inputs, independently of AA/AAA and display preferences. */
export function auditMeasurementsChanged(audit: Audit, snapshot: Snapshot, completingScan = false, previousReferences?: ReadonlySet<string>): boolean {
  if (snapshot.stale
    || (['windowId', 'tabId', 'frameId', 'documentToken'] as const).some(key => audit.document[key] !== snapshot.document[key])) return false;
  const observed = new Map(snapshot.textRuns.map(run => [run.id, run]));
  const channels = (color: RGBA | null | undefined) => color ? [color.r, color.g, color.b, color.a] : null;
  const inputs = (run: TextRun, compareGeometry = true) => JSON.stringify([
    run.elementRef, run.textSource ?? null, run.foregroundSource ?? null, run.textFillPresent ?? false, run.fontSizeCssPx, run.fontWeight,
    run.fontFamily ?? null, run.lineHeight ?? null,
    channels(run.foreground.rgba), run.foreground.rgba ? null : run.foreground.raw,
    channels(run.background.rgba), run.background.rgba ? null : run.background.raw,
    run.ownOpaqueBackground, run.notApplicable ?? null,
    ...(compareGeometry ? [channels(run.effectiveBackground), channels(run.backgroundRange?.min), channels(run.backgroundRange?.max), [...new Set(run.reasons)].sort()] : []),
  ]);
  let directCount = 0, missingDirect = false;
  for (const previous of audit.runs) {
    const current = observed.get(previous.id);
    if (previous.elementRef === snapshot.elementRef) { directCount++; missingDirect ||= !current; }
    // A viewport-only fragment and the whole Text node share CSS inputs but
    // can legitimately have different overlap and background evidence.
    const compareGeometry = !(audit.scope === 'viewport' && previous.viewportPartial === true);
    if (current && inputs(previous, compareGeometry) !== inputs(current, compareGeometry)) return true;
  }
  // Viewport scans intentionally omit offscreen Text nodes, including further
  // direct nodes in an otherwise visible element. Inspection measures the
  // whole element: added nodes alone prove nothing, but the disappearance of
  // an actually audited node from a complete inspection still contradicts it.
  if (audit.scope === 'viewport') return audit.status !== 'running'
    && !snapshot.reasons.includes('selection-text-limit') && missingDirect;
  // A complete follow-up can also disprove a selected descendant's measured
  // Text identity. Require evidence that its owner belonged to the preceding
  // page audit: an omitted/shadow-root selection is not a missing page run.
  // Only inspect rows actually observed in the selection, never infer which
  // descendants might be absent from its bounded subtree measurement.
  if (completingScan && audit.status === 'complete' && !snapshot.reasons.includes('selection-text-limit') && previousReferences) {
    const scanned = new Set(audit.runs.map(run => run.id));
    if (snapshot.textRuns.some(run => run.elementRef !== snapshot.elementRef
      && previousReferences.has(run.elementRef) && !scanned.has(run.id))) return true;
  }
  // The selected element's own runs are measured before descendants. Do not
  // infer removal from absent descendant runs in a bounded subtree snapshot.
  // A running scan has not necessarily reached every run yet. Matching inputs
  // can already contradict it, but an incomplete inventory cannot prove loss.
  const direct = snapshot.textRuns.filter(run => run.elementRef === snapshot.elementRef);
  return audit.status !== 'running' && (directCount > 0 || completingScan && audit.status === 'complete')
    && !snapshot.reasons.includes('selection-text-limit')
    && (directCount !== direct.length || missingDirect);
}
