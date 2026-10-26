import type { Audit, Snapshot } from '../core/types';

export interface DocumentRecord {
  windowId: number; tabId: number; documentToken: string; touchedAt: number;
  selected: Snapshot | null; audit: Audit | null; selectionRequest: string; auditRequest: string; picker: boolean;
  previousAudit?: Audit | null;
  pendingContextSelection?: boolean;
}
export interface SessionData { schemaVersion: 1; epoch: number; documents: Record<string, DocumentRecord> }
export interface AuthorizationSession {
  schemaVersion: 2; epoch: number;
  documents: Record<string, Pick<DocumentRecord, 'windowId' | 'tabId' | 'documentToken' | 'touchedAt'>>;
}
export const SESSION_KEY = 'analysisSession';
export const MAX_ANALYSIS_BYTES = 6_000_000;
export const MAX_ANALYSIS_RECORDS = 12;
export const MAX_AUTHORIZED_DOCUMENTS = 160;
export function emptySession(): SessionData { return { schemaVersion: 1, epoch: 0, documents: {} }; }
export function identityMatches(record: DocumentRecord | undefined, windowId: number, tabId: number, token: string): boolean {
  return Boolean(record && record.windowId === windowId && record.tabId === tabId && record.documentToken === token);
}
export function safeFilename(filename: string): boolean {
  return /^style-inspector-lite-[a-z0-9-]{1,120}\.(css|scss|json|txt|theme\.css|tailwind\.txt)$/.test(filename);
}
const encoder = new TextEncoder();
const newestRecords = (session: SessionData) => Object.values(session.documents).sort((a, b) => b.touchedAt - a.touchedAt || b.tabId - a.tabId);

/** Bound live analysis while retaining the document identities that authorize access. */
export class AnalysisBudget {
  private sizes = new WeakMap<Snapshot | Audit, { runs: readonly unknown[]; bytes: number }>();
  private bytes(value: Snapshot | Audit | null): number {
    if (!value) return 0;
    const runs = 'textRuns' in value ? value.textRuns : value.runs;
    const cached = this.sizes.get(value);
    if (cached?.runs === runs) return cached.bytes;
    // Reserve headroom for small in-place metadata changes (stale flags etc.).
    // Reassessments replace the run array and therefore invalidate this entry.
    const bytes = encoder.encode(JSON.stringify(value)).byteLength + 1024;
    this.sizes.set(value, { runs, bytes });
    return bytes;
  }
  estimate(record: DocumentRecord): number {
    return this.bytes(record.selected) + this.bytes(record.audit) + this.bytes(record.previousAudit ?? null);
  }
  trim(session: SessionData, maximumBytes = MAX_ANALYSIS_BYTES, maximumRecords = MAX_ANALYSIS_RECORDS, protectedRecord: (record: DocumentRecord) => boolean = () => false): DocumentRecord[] {
    let bytes = 0, count = 0, exhausted = false;
    const removed: DocumentRecord[] = [];
    const records = newestRecords(session).sort((a, b) => Number(protectedRecord(b)) - Number(protectedRecord(a)));
    for (const record of records) {
      if (!record.selected && !record.audit && !record.previousAudit) continue;
      // Active work must finish before its result can be considered for eviction.
      if (protectedRecord(record)) { count++; bytes += this.estimate(record); continue; }
      if (!exhausted && count < maximumRecords) {
        let size = this.estimate(record);
        // Keep current results ahead of their comparison baseline when space is tight.
        if (bytes + size > maximumBytes && record.previousAudit) {
          record.previousAudit = null; removed.push(record); size = this.estimate(record);
        }
        if (bytes + size <= maximumBytes) { count++; bytes += size; continue; }
      }
      exhausted = true;
      record.selected = null; record.audit = null; record.previousAudit = null;
      if (!removed.includes(record)) removed.push(record);
    }
    return removed;
  }
}

/** Persist only authorization metadata. Measurements never enter either storage area. */
export function boundedSession(session: SessionData, maximumBytes = 100_000): AuthorizationSession {
  const copy: AuthorizationSession = { schemaVersion: 2, epoch: session.epoch, documents: {} };
  let bytes = encoder.encode(JSON.stringify(copy)).byteLength;
  let count = 0;
  for (const record of newestRecords(session).slice(0, MAX_AUTHORIZED_DOCUMENTS)) {
    const { windowId, tabId, documentToken, touchedAt } = record;
    const json = JSON.stringify({ windowId, tabId, documentToken, touchedAt });
    const key = JSON.stringify(String(record.tabId));
    const size = encoder.encode(key).byteLength + 1 + encoder.encode(json).byteLength + (count ? 1 : 0);
    if (bytes + size > maximumBytes) break;
    copy.documents[String(record.tabId)] = JSON.parse(json) as AuthorizationSession['documents'][string];
    bytes += size; count++;
  }
  return copy;
}

/** Migrate earlier session payloads without restoring their page data or request IDs. */
export function restoreAuthorizations(value: unknown): SessionData {
  const session = emptySession();
  if (!value || typeof value !== 'object') return session;
  const saved = value as Partial<AuthorizationSession>;
  if (![1, 2].includes(saved.schemaVersion ?? 0) || !Number.isSafeInteger(saved.epoch) || saved.epoch! < 0
    || !saved.documents || typeof saved.documents !== 'object' || Array.isArray(saved.documents)) return session;
  session.epoch = saved.epoch!;
  const records = Object.values(saved.documents).filter(record => record && typeof record === 'object'
    && Number.isSafeInteger(record.tabId) && record.tabId >= 0 && Number.isSafeInteger(record.windowId) && record.windowId >= 0
    && typeof record.documentToken === 'string' && record.documentToken.length > 0 && record.documentToken.length <= 240
    && typeof record.touchedAt === 'number' && Number.isFinite(record.touchedAt))
    .sort((a, b) => b.touchedAt - a.touchedAt).slice(0, MAX_AUTHORIZED_DOCUMENTS);
  for (const { windowId, tabId, documentToken, touchedAt } of records) session.documents[String(tabId)] = {
    windowId, tabId, documentToken, touchedAt, selected: null, audit: null, previousAudit: null, picker: false, selectionRequest: '', auditRequest: '',
  };
  return session;
}
