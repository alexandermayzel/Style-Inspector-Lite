import type { Settings } from '../core/types';
export type { Settings } from '../core/types';

export const SETTINGS_KEY = 'preferences';
export const SETTINGS_VERSION = 1;
export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  schemaVersion: 1,
  appearance: 'system', colorFormat: 'hex', contrastTarget: 'AA',
  livePreview: true, contextMenuEnabled: true, showDiagnostics: false,
});

export function validateSettings(value: unknown): Settings {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const data = raw.values && typeof raw.values === 'object' ? raw.values as Record<string, unknown> : raw;
  const target = data.contrastTarget ?? data.target;
  return {
    schemaVersion: 1,
    appearance: typeof data.appearance === 'string' && ['system', 'light', 'dark'].includes(data.appearance) ? data.appearance as Settings['appearance'] : 'system',
    colorFormat: typeof data.colorFormat === 'string' && ['hex', 'rgb', 'hsl'].includes(data.colorFormat) ? data.colorFormat as Settings['colorFormat'] : 'hex',
    contrastTarget: target === 'AA' || target === 'AAA' ? target : 'AA',
    livePreview: typeof data.livePreview === 'boolean' ? data.livePreview : true,
    contextMenuEnabled: typeof data.contextMenuEnabled === 'boolean' ? data.contextMenuEnabled : true,
    showDiagnostics: data.showDiagnostics === true,
  };
}

export function settingsRecord(settings: Settings) {
  return { schemaVersion: SETTINGS_VERSION, values: validateSettings(settings) };
}
