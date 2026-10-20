import type { Audit, Snapshot } from '../core/types';

export interface DocumentRecord {
  windowId: number; tabId: number; documentToken: string; touchedAt: number;
  selected: Snapshot | null; audit: Audit | null; selectionRequest: string; auditRequest: string; picker: boolean;
  pendingContextSelection?: boolean;
}
export interface SessionData { schemaVersion: 1; epoch: number; documents: Record<string, DocumentRecord> }
export const SESSION_KEY = 'analysisSession';
export function emptySession(): SessionData { return { schemaVersion: 1, epoch: 0, documents: {} }; }
export function identityMatches(record: DocumentRecord | undefined, windowId: number, tabId: number, token: string): boolean {
  return Boolean(record && record.windowId === windowId && record.tabId === tabId && record.documentToken === token);
}
export function safeFilename(filename: string): boolean {
  return /^style-inspector-lite-[a-z0-9-]{1,120}\.(css|scss|json|txt|theme\.css|tailwind\.txt)$/.test(filename);
}
/** Evict old session snapshots to stay below storage.session's bounded memory budget. */
export function boundedSession(session: SessionData, maximumBytes = 6_000_000): SessionData {
  const copy = structuredClone(session);
  // Diagnostic excerpts stay in live selection memory, never storage.session.
  for (const record of Object.values(copy.documents)) {
    if (record.selected) {
      delete record.selected.textExcerpt;
      for (const run of record.selected.textRuns) delete run.textExcerpt;
    }
    if (record.audit) for (const run of record.audit.runs) delete run.textExcerpt;
  }
  const oldest = Object.values(copy.documents).sort((a, b) => a.touchedAt - b.touchedAt);
  while (oldest.length > 12 || new TextEncoder().encode(JSON.stringify(copy)).byteLength > maximumBytes) {
    const item = oldest.shift();
    if (!item) break;
    delete copy.documents[String(item.tabId)];
  }
  return copy;
}
