import { cssColorContrast } from './contrast';
import { isRGBA } from './colors';
import type { ColorValue, RGBA, TextRun } from './types';

export interface AuditRunGroup { id: string; representative: TextRun; runs: TextRun[] }
const channels = (rgba: RGBA | null | undefined) => isRGBA(rgba) ? [rgba.r, rgba.g, rgba.b, rgba.a] : null;
const color = (value: ColorValue) => channels(value.rgba) ?? ['unresolved', value.raw];

/** Group only equal measured inputs and outcomes. Never use rounded labels or selectors. */
function groupIdentity(run: TextRun): string {
  const contrast = run.contrast, css = cssColorContrast(run);
  return JSON.stringify([
    run.textSource ?? 'text', run.foregroundSource ?? 'color', run.textFillPresent ?? false, run.viewportPartial === true,
    color(run.foreground), color(run.background), channels(run.effectiveBackground),
    channels(run.backgroundRange?.min), channels(run.backgroundRange?.max),
    run.fontSizeCssPx, run.fontWeight, run.ownOpaqueBackground, run.notApplicable ?? null,
    [...new Set(run.reasons)].sort(),
    contrast.status, contrast.ratio, contrast.ratioKind ?? 'exact', contrast.category,
    contrast.target, contrast.threshold, contrast.reason ?? null,
    contrast.AA.status, contrast.AA.threshold, contrast.AA.reason ?? null,
    contrast.AAA.status, contrast.AAA.threshold, contrast.AAA.reason ?? null,
    css ? [css.ratio, css.category, css.AA?.status, css.AAA?.status] : null,
    run.fontSize.status, run.fontSize.reason ?? null,
  ]);
}

export function groupAuditRuns(runs: readonly TextRun[]): AuditRunGroup[] {
  const groups = new Map<string, AuditRunGroup>();
  for (const run of runs) {
    const id = groupIdentity(run);
    const existing = groups.get(id);
    if (existing) existing.runs.push(run);
    else groups.set(id, { id, representative: run, runs: [run] });
  }
  return [...groups.values()];
}
