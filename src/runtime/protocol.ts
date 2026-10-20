import type { Audit, Settings, Snapshot } from '../core/types';

export type Access = 'ready' | 'needs-activation' | 'unsupported' | 'error';
export type StateEvent = 'ready' | 'activated' | 'document-changed' | 'selected' | 'preview' | 'picker-cancelled' | 'data-cleared' | 'settings' | 'audit' | 'audit-reset' | 'stale';
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
  progress: { scanned: number; total: number } | null;
  lastEvent: StateEvent;
  error?: string;
  settings: Settings;
  selectionTab?: 'contrast' | 'typography';
  selectionOrigin?: 'context' | 'picker' | 'audit' | 'refresh';
}

export type SidebarCommand =
  | { type: 'ready'; windowId: number; requestId: string }
  | { type: 'start-audit'; requestId: string; expectedTabId?: number; expectedDocumentToken?: string | null; expectedRevision?: number }
  | { type: 'start-picker' | 'cancel-picker' | 'cancel-audit' | 'refresh-selection' | 'clear-data' | 'reset-settings'; requestId: string }
  | { type: 'show-node' | 'select-node'; referenceId: string; requestId: string; tab?: 'contrast' | 'typography' }
  | { type: 'update-settings'; settings: Partial<Settings>; requestId: string }
  | { type: 'save-export'; text: string; mime: string; filename: string; requestId: string };
export type SidebarMessage =
  | { type: 'state'; state: SidebarState }
  | { type: 'error'; requestId?: string; code: string }
  | { type: 'saved'; requestId: string; status: 'started' | 'complete' | 'cancelled' | 'failed'; downloadId?: number };

export interface ContentCommand {
  channel: 'sil-content'; type: 'hello' | 'capture-context' | 'start-picker' | 'cancel-picker' | 'start-audit' | 'cancel-audit' | 'refresh-selection' | 'show-node' | 'select-node' | 'clear-data' | 'settings';
  requestId: string; epoch: number; documentToken?: string;
  windowId: number; tabId: number; settings: Settings; referenceId?: string;
}
export interface ContentEvent {
  channel: 'sil-event'; type: 'selected' | 'preview' | 'picker-cancelled' | 'audit' | 'stale' | 'unloaded' | 'removed';
  documentToken: string; requestId: string; epoch: number;
  snapshot?: Snapshot; audit?: Audit;
}

export function isSidebarCommand(value: unknown): value is SidebarCommand {
  if (!value || typeof value !== 'object') return false;
  const data = value as Record<string, unknown>;
  if (typeof data.requestId !== 'string' || data.requestId.length > 120) return false;
  return ['ready', 'start-picker', 'cancel-picker', 'start-audit', 'cancel-audit', 'refresh-selection', 'clear-data', 'reset-settings', 'show-node', 'select-node', 'update-settings', 'save-export'].includes(String(data.type));
}
