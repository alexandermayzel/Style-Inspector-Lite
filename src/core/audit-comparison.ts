import { evaluateRun } from './contrast';
import type { Audit, ContrastTarget, RuleStatus, TextRun } from './types';

export type AuditChangeKind = 'new' | 'resolved' | 'persistent' | 'unassessed';
export type AuditComparisonReason = 'incomplete' | 'stale-current' | 'document' | 'scope' | 'viewport' | 'selection-root' | 'run-identity';
export interface AuditChangeMeasurement { status: RuleStatus; ratio: number | null; ratioKind?: 'minimum'; sizeCssPx: number | null }
export interface AuditChange {
  runId: string; elementRef: string; ruleId: 'text.contrast' | 'text.font-size-min'; kind: AuditChangeKind;
  before: AuditChangeMeasurement | null; after: AuditChangeMeasurement | null;
}
export type AuditComparison = { comparable: false; reason: AuditComparisonReason } | {
  comparable: true; target: ContrastTarget; previousId: string; currentId: string;
  previousMeasuredAt: string; currentMeasuredAt: string;
  counts: Record<AuditChangeKind, number>; changes: AuditChange[];
};

function comparisonReason(previous: Audit, current: Audit): AuditComparisonReason | null {
  if (previous.status !== 'complete' || current.status !== 'complete' || previous.runs.length > 1000 || current.runs.length > 1000) return 'incomplete';
  // The old result is historical evidence. It normally becomes stale when the
  // page is edited before the next explicit scan, which does not erase it.
  if (current.stale) return 'stale-current';
  if ((['windowId', 'tabId', 'frameId', 'documentToken'] as const).some(key => previous.document[key] !== current.document[key])) return 'document';
  if (!previous.scope || !current.scope || !['page', 'viewport', 'selection'].includes(previous.scope) || previous.scope !== current.scope) return 'scope';
  if ((['width', 'height'] as const).some(key => !Number.isFinite(previous.viewport[key]) || previous.viewport[key] <= 0
    || previous.viewport[key] !== current.viewport[key]) || (previous.viewport.devicePixelRatio ?? 1) !== (current.viewport.devicePixelRatio ?? 1)) return 'viewport';
  if (previous.scope === 'viewport') {
    const a = previous.scopeViewport, b = current.scopeViewport;
    if (!a || !b || (['left', 'top', 'width', 'height'] as const).some(key => !Number.isFinite(a[key]) || a[key] !== b[key])
      || a.width <= 0 || a.height <= 0) return 'viewport';
  }
  if (previous.scope === 'selection' && (!previous.rootElementRef || previous.rootElementRef !== current.rootElementRef)) return 'selection-root';
  return null;
}

function indexedRuns(audit: Audit, target: ContrastTarget): Map<string, TextRun> | null {
  const runs = new Map<string, TextRun>();
  for (const run of audit.runs) {
    if (typeof run.id !== 'string' || !run.id || typeof run.elementRef !== 'string' || !run.elementRef || runs.has(run.id)) return null;
    runs.set(run.id, evaluateRun(run, target));
  }
  return runs;
}
function classify(before: RuleStatus | undefined, after: RuleStatus | undefined): AuditChangeKind | null {
  if (before === 'fail' && after === 'fail') return 'persistent';
  if (before === 'fail' && after === 'pass') return 'resolved';
  // "New" means newly observed as failing, not proof of when it was caused.
  if (after === 'fail') return 'new';
  // A removed node, hidden text, unavailable measurement or exemption is never
  // evidence that a former failure has been repaired.
  if (before === 'fail' || before === 'manual' || after === 'manual') return 'unassessed';
  return null;
}

/** Compare two bounded manual snapshots without text, selectors or DOM access. */
export function compareAudits(previous: Audit, current: Audit, target: ContrastTarget = current.target): AuditComparison {
  const reason = comparisonReason(previous, current);
  if (reason) return { comparable: false, reason };
  const beforeRuns = indexedRuns(previous, target), afterRuns = indexedRuns(current, target);
  if (!beforeRuns || !afterRuns) return { comparable: false, reason: 'run-identity' };
  for (const [id, before] of beforeRuns) {
    const after = afterRuns.get(id);
    if (after && (before.elementRef !== after.elementRef || before.textSource !== after.textSource)) return { comparable: false, reason: 'run-identity' };
  }
  const counts: Record<AuditChangeKind, number> = { new: 0, resolved: 0, persistent: 0, unassessed: 0 }, changes: AuditChange[] = [];
  // Current reading order first, then text missing from the current snapshot.
  for (const id of new Set([...afterRuns.keys(), ...beforeRuns.keys()])) {
    const before = beforeRuns.get(id), after = afterRuns.get(id);
    for (const property of ['contrast', 'fontSize'] as const) {
      const kind = classify(before?.[property].status, after?.[property].status);
      if (!kind) continue;
      const measurement = (run: TextRun | undefined): AuditChangeMeasurement | null => run ? {
        status: run[property].status, ratio: property === 'contrast' ? run.contrast.ratio : null,
        ...(property === 'contrast' && run.contrast.ratioKind === 'minimum' ? { ratioKind: 'minimum' as const } : {}),
        sizeCssPx: run.fontSize.fontSizeCssPx,
      } : null;
      counts[kind]++;
      changes.push({ runId: id, elementRef: (after ?? before)!.elementRef,
        ruleId: property === 'contrast' ? 'text.contrast' : 'text.font-size-min', kind,
        before: measurement(before), after: measurement(after) });
    }
  }
  return { comparable: true, target, previousId: previous.id, currentId: current.id,
    previousMeasuredAt: previous.measuredAt, currentMeasuredAt: current.measuredAt, counts, changes };
}
