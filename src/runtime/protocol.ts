import type { Audit, AuditScope, Settings, Snapshot } from '../core/types';
import type { DiagnosticReport, DiagnosticTarget } from '../core/diagnostics';

export type Access = 'ready' | 'needs-activation' | 'unsupported' | 'error';
export type StateEvent = 'ready' | 'activated' | 'document-changed' | 'selected' | 'preview' | 'picker-cancelled' | 'data-cleared' | 'settings' | 'audit' | 'audit-reset' | 'stale';
export interface AnalysisSummary {
  tabId: number; windowId: number; documentToken: string; touchedAt: number; estimatedBytes: number;
  selected: boolean; auditStatus: Audit['status'] | null; auditRuns: number; previousAudit: boolean; measuredAt: string | null;
  /** Live browser metadata for the explicit overview, never stored with analysis. */
  title?: string;
}
export interface SidebarState {
  windowId: number;
  tabId: number | null;
  documentToken: string | null;
  documentRevision: number;
  access: Access;
  selected: Snapshot | null;
  preview: Snapshot | null;
  picker: boolean;
  audit: Audit | null;
  previousAudit?: Audit | null;
  progress: { scanned: number; total: number } | null;
  lastEvent: StateEvent;
  error?: string;
  settings: Settings;
  selectionTab?: 'contrast' | 'typography';
  selectionOrigin?: 'context' | 'picker' | 'audit' | 'refresh';
}

export type SidebarCommand =
  | { type: 'ready'; windowId: number; requestId: string }
  | { type: 'list-analyses'; requestId: string }
  | { type: 'clear-tab-analysis'; targetTabId: number; documentToken: string; requestId: string }
  | { type: 'start-audit'; requestId: string; scope?: AuditScope; referenceId?: string; expectedTabId?: number; expectedDocumentToken?: string | null; expectedRevision?: number }
  | { type: 'start-picker' | 'cancel-picker' | 'cancel-audit' | 'refresh-selection' | 'clear-data' | 'reset-settings'; requestId: string }
  | { type: 'show-node' | 'select-node'; referenceId: string; requestId: string; tab?: 'contrast' | 'typography' }
  | ({ type: 'diagnose-node'; requestId: string; expectedTabId: number; expectedDocumentToken: string; expectedRevision: number } & DiagnosticTarget)
  | { type: 'update-settings'; settings: Partial<Settings>; requestId: string }
  | { type: 'save-export'; text: string; mime: string; filename: string; requestId: string };
export type SidebarMessage =
  | { type: 'state'; state: SidebarState }
  | { type: 'analyses'; requestId: string; entries: AnalysisSummary[]; maximumBytes: number; maximumRecords: number }
  | { type: 'error'; requestId?: string; code: string }
  | { type: 'diagnostic'; requestId: string; report: DiagnosticReport }
  | { type: 'saved'; requestId: string; status: 'started' | 'complete' | 'cancelled' | 'failed'; downloadId?: number };

export interface ContentCommand {
  channel: 'sil-content'; type: 'hello' | 'capture-context' | 'start-picker' | 'cancel-picker' | 'start-audit' | 'cancel-audit' | 'refresh-selection' | 'show-node' | 'select-node' | 'diagnose-node' | 'clear-data' | 'release-analysis' | 'settings';
  requestId: string; epoch: number; documentToken?: string;
  coordinatorToken?: string;
  expectedSelectionRequest?: string; expectedAuditRequest?: string;
  windowId: number; tabId: number; settings: Settings; referenceId?: string;
  diagnosticTarget?: DiagnosticTarget;
  scope?: AuditScope;
}
export interface ContentEvent {
  channel: 'sil-event'; type: 'selected' | 'preview' | 'picker-cancelled' | 'audit' | 'stale' | 'unloaded' | 'removed';
  documentToken: string; requestId: string; epoch: number;
  coordinatorToken?: string;
  snapshot?: Snapshot; audit?: Audit;
}

export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (typeof data.requestId !== 'string' || data.requestId.length > 120) return false;
  if (data.type === 'list-analyses') return true;
  if (data.type === 'clear-tab-analysis') return Number.isSafeInteger(data.targetTabId) && (data.targetTabId as number) >= 0
    && typeof data.documentToken === 'string' && data.documentToken.length > 0 && data.documentToken.length <= 240;
  if (data.type === 'start-audit' && (data.scope !== undefined && !['page', 'viewport', 'selection'].includes(String(data.scope))
    || data.referenceId !== undefined && (typeof data.referenceId !== 'string' || !data.referenceId.length || data.referenceId.length > 240))) return false;
  if (data.type === 'diagnose-node') {
    const source = data.source as Record<string, unknown> | undefined;
    return typeof data.referenceId === 'string' && data.referenceId.length > 0 && data.referenceId.length <= 240
      && typeof data.runId === 'string' && data.runId.length > 0 && data.runId.length <= 300
      && Boolean(source && typeof source === 'object' && ['audit', 'selection'].includes(source.kind as string) && typeof source.id === 'string' && source.id.length > 0 && source.id.length <= 240)
      && Number.isSafeInteger(data.expectedTabId) && Number.isSafeInteger(data.expectedRevision) && (data.expectedRevision as number) >= 0
      && typeof data.expectedDocumentToken === 'string' && data.expectedDocumentToken.length > 0 && data.expectedDocumentToken.length <= 240;
  }
  return ['ready', 'start-picker', 'cancel-picker', 'start-audit', 'cancel-audit', 'refresh-selection', 'clear-data', 'reset-settings', 'show-node', 'select-node', 'update-settings', 'save-export'].includes(String(data.type));
}
