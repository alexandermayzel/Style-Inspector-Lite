import { evaluateRun, reassessAudit } from './core/contrast';
import type { Audit, Settings, Snapshot } from './core/types';
import { DEFAULT_SETTINGS, SETTINGS_KEY, settingsRecord, validateSettings } from './runtime/settings';
import { boundedSession, emptySession, identityMatches, safeFilename, SESSION_KEY, type DocumentRecord, type SessionData } from './runtime/state';
import { isSidebarCommand, type ContentCommand, type ContentEvent, type SidebarCommand, type SidebarMessage, type SidebarState, type StateEvent } from './runtime/protocol';

const MENU_ID = 'style-inspector-lite-inspect';
let settings: Settings = { ...DEFAULT_SETTINGS };
let session = emptySession();
const windows = new Map<number, SidebarState>();
const ports = new Map<browser.runtime.Port, number>();
const attempts = new Map<number, string>();
const activationJobs = new Map<number, Promise<DocumentRecord | null>>();
const contextRequests = new Map<number, string>();
const windowRevisions = new Map<number, number>();
// Handshakes may return after newer commands or content events. These revisions
// protect live analysis without changing the persisted document/request IDs.
const recordRevisions = new WeakMap<DocumentRecord, number>();
const recordChanged = (record: DocumentRecord) => recordRevisions.set(record, (recordRevisions.get(record) ?? 0) + 1);
const downloadOwners = new Map<number, { url: string; requestId: string; windowId: number; persisted: Promise<void> }>();
const downloadFinalizations = new Map<number, Promise<void>>();
let storageQueue: Promise<void> = Promise.resolve();
let menuQueue: Promise<void> = Promise.resolve();
let settingsQueue: Promise<void> = Promise.resolve();

const loaded = Promise.all([browser.storage.local.get(SETTINGS_KEY), browser.storage.session.get(SESSION_KEY)]).then(([local, temporary]) => {
  settings = validateSettings(local[SETTINGS_KEY]);
  const previous = temporary[SESSION_KEY] as SessionData | undefined;
  if (previous?.schemaVersion === 1 && Number.isSafeInteger(previous.epoch) && previous.documents && typeof previous.documents === 'object') session = previous;
  for (const record of Object.values(session.documents)) record.picker = false;
}).catch(() => { broadcastError('storage-failed'); });

function post(port: browser.runtime.Port, message: SidebarMessage) { try { port.postMessage(message); } catch { ports.delete(port); } }
function broadcastError(code: string) { for (const port of ports.keys()) post(port, { type: 'error', code }); }
function stateFor(windowId: number): SidebarState {
  let state = windows.get(windowId);
  if (!state) {
    state = { windowId, tabId: null, documentToken: null, documentRevision: windowRevisions.get(windowId) ?? 0, access: 'needs-activation', selected: null, preview: null, picker: false, audit: null, progress: null, lastEvent: 'ready', settings: { ...settings } };
    windows.set(windowId, state);
  }
  return state;
}
function publish(windowId: number, event: StateEvent) {
  const state = stateFor(windowId); state.lastEvent = event; state.settings = { ...settings }; state.documentRevision = windowRevisions.get(windowId) ?? 0;
  for (const [port, owner] of ports) if (owner === windowId) post(port, { type: 'state', state });
}
function persist() {
  const snapshot = boundedSession(session);
  storageQueue = storageQueue.then(() => browser.storage.session.set({ [SESSION_KEY]: snapshot })).catch(() => { broadcastError('storage-failed'); });
  return storageQueue;
}
function applyRecord(record: DocumentRecord, event: StateEvent) {
  const state = stateFor(record.windowId);
  if (state.tabId !== record.tabId) return;
  Object.assign(state, { documentToken: record.documentToken, selected: record.selected, audit: record.audit, picker: record.picker, access: 'ready', progress: record.audit?.status === 'running' ? { scanned: record.audit.scanned, total: record.audit.total } : null });
  if (record.pendingContextSelection && record.selected) {
    event = 'selected'; state.selectionOrigin = 'context'; delete state.selectionTab;
    if ([...ports.values()].includes(record.windowId)) record.pendingContextSelection = false;
  }
  if (event !== 'stale') delete state.error;
  publish(record.windowId, event);
}
function syncMenu() {
  menuQueue = menuQueue.then(async () => {
    await loaded;
    await browser.menus.remove(MENU_ID).catch(() => undefined);
    if (settings.contextMenuEnabled) browser.menus.create({ id: MENU_ID, title: browser.i18n.getMessage('contextInspect'), contexts: ['page', 'link', 'image', 'video', 'audio', 'editable', 'selection', 'frame'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
  }).catch(() => broadcastError('settings-failed'));
}
class ContentOperationError extends Error {}
function commandFor(record: DocumentRecord, type: ContentCommand['type'], requestId: string, extra: Partial<ContentCommand> = {}): ContentCommand {
  return { channel: 'sil-content', type, requestId, epoch: session.epoch, windowId: record.windowId, tabId: record.tabId, documentToken: record.documentToken, settings, ...extra };
}
async function send(record: DocumentRecord, type: ContentCommand['type'], requestId: string, extra: Partial<ContentCommand> = {}) {
  const reply = await browser.tabs.sendMessage(record.tabId, commandFor(record, type, requestId, extra), { frameId: 0 });
  if (reply?.error) throw new ContentOperationError(reply.error);
  return reply;
}
function clearVisible(windowId: number, tabId: number | null, access: SidebarState['access'], error?: string) {
  const state = stateFor(windowId);
  Object.assign(state, { tabId, documentToken: null, access, selected: null, preview: null, picker: false, audit: null, progress: null, error });
}
async function attach(tab: browser.tabs.Tab, inject: boolean, requestId: string, event: StateEvent = 'activated') {
  const revision = windowRevisions.get(tab.windowId ?? -1) ?? 0;
  await loaded;
  if (tab.id === undefined || tab.windowId === undefined) return null;
  const tabId = tab.id, windowId = tab.windowId;
  if ((windowRevisions.get(windowId) ?? 0) !== revision) return null;
  if (!inject && !session.documents[String(tabId)]) {
    // A surviving receiver is not proof of current access: it can outlive a
    // revoked host grant. Passive tab/sidebar refreshes only restore a record
    // established by an explicit injection, never authorize a new one.
    const unsupported = Boolean(tab.url && !/^https?:\/\//i.test(tab.url));
    clearVisible(windowId, tabId, unsupported ? 'unsupported' : 'needs-activation', unsupported ? 'unsupported-page' : 'activation-required');
    publish(windowId, event);
    return null;
  }
  const generation = session.epoch;
  attempts.set(tabId, requestId);
  const state = stateFor(windowId);
  const stillCurrent = () => attempts.get(tabId) === requestId && session.epoch === generation
    && (windowRevisions.get(windowId) ?? 0) === revision && state.tabId === tabId;
  if (state.tabId !== tabId) clearVisible(windowId, tabId, 'needs-activation');
  if (tab.url && !/^https?:\/\//i.test(tab.url)) {
    clearVisible(windowId, tabId, 'unsupported', 'unsupported-page'); publish(windowId, event); return null;
  }
  let beforeHello: DocumentRecord | undefined;
  let analysisRevision = 0;
  const newerAnalysis = () => beforeHello && session.documents[String(tabId)] === beforeHello
    && (recordRevisions.get(beforeHello) ?? 0) !== analysisRevision;
  try {
    if (inject) await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['content.js'] });
    if (!stillCurrent()) return null;
    beforeHello = session.documents[String(tabId)];
    analysisRevision = beforeHello ? recordRevisions.get(beforeHello) ?? 0 : 0;
    const hello: ContentCommand = { channel: 'sil-content', type: 'hello', requestId, epoch: session.epoch, windowId, tabId, settings };
    const result = await browser.tabs.sendMessage(tabId, hello, { frameId: 0 });
    if (!stillCurrent() || typeof result?.documentToken !== 'string') return null;
    const old = session.documents[String(tabId)];
    const same = identityMatches(old, windowId, tabId, result.documentToken);
    if (same && newerAnalysis()) {
      // The receiver still confirms this document, but its captured analysis
      // cannot replace a later selection, audit event or cancellation.
      return old!;
    }
    const record: DocumentRecord = same ? old! : { windowId, tabId, documentToken: result.documentToken, touchedAt: Date.now(), selected: null, audit: null, selectionRequest: '', auditRequest: '', picker: false };
    record.selected = 'selected' in result ? result.selected : same ? record.selected : null;
    record.audit = 'audit' in result ? result.audit ? reassessAudit(result.audit, settings.contrastTarget) : null : same ? record.audit : null;
    record.picker = Boolean(result.picker);
    if (typeof result.selectionRequest === 'string') record.selectionRequest = result.selectionRequest;
    if (typeof result.auditRequest === 'string') record.auditRequest = result.auditRequest;
    record.touchedAt = Date.now();
    recordChanged(record);
    session.documents[String(tabId)] = record;
    if (state.tabId === tabId) applyRecord(record, same ? event : event === 'ready' ? 'ready' : 'document-changed');
    void persist();
    return record;
  } catch {
    if (!stillCurrent()) return null;
    if (newerAnalysis()) return beforeHello!;
    delete session.documents[String(tabId)];
    clearVisible(windowId, tabId, 'needs-activation', 'activation-required');
    publish(windowId, event);
    void persist();
    return null;
  }
}

function openFromAction(tab: browser.tabs.Tab) {
  // Must precede ALL async work: opening is bound to this exact browser user action.
  void browser.sidebarAction.open().catch(() => broadcastError('sidebar-open-failed'));
  if (tab.id === undefined) return;
  const job = attach(tab, true, crypto.randomUUID());
  activationJobs.set(tab.id, job);
  void job.finally(() => { if (activationJobs.get(tab.id!) === job) activationJobs.delete(tab.id!); });
}
browser.action.onClicked.addListener(openFromAction);

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab || tab.id === undefined || tab.windowId === undefined) return;
  void browser.sidebarAction.open().catch(() => broadcastError('sidebar-open-failed'));
  const requestId = crypto.randomUUID(), tabId = tab.id, windowId = tab.windowId;
  const revision = windowRevisions.get(windowId) ?? 0;
  contextRequests.set(tabId, requestId);
  const stillCurrent = () => contextRequests.get(tabId) === requestId && (windowRevisions.get(windowId) ?? 0) === revision;
  if ((info.frameId ?? 0) !== 0 || typeof info.targetElementId !== 'number') {
    void loaded.then(() => { if (!stillCurrent()) return; const state = stateFor(windowId); state.error = (info.frameId ?? 0) !== 0 ? 'unsupported-frame' : 'target-expired'; publish(windowId, 'activated'); });
    return;
  }
  // Capture the DOM identity immediately, independently of sidebar load/storage/injection.
  const capture = browser.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func: (targetElementId: number, request: string) => {
      const target = browser.menus.getTargetElement(targetElementId) || null;
      (globalThis as typeof globalThis & { __styleInspectorContext?: { requestId: string; element: Element | null } }).__styleInspectorContext = { requestId: request, element: target };
      return Boolean(target);
    }, args: [info.targetElementId, requestId],
  });
  void capture.then(async results => {
    // Capturing a context target is asynchronous. A tab switch must retire the
    // original intent before attach() can sample the newer window revision.
    if (!stillCurrent()) return;
    if (!results[0]?.result) throw new Error('target-expired');
    const record = await attach(tab, true, requestId);
    if (!record || !stillCurrent()) return;
    record.selectionRequest = requestId;
    record.pendingContextSelection = true;
    recordChanged(record);
    delete stateFor(windowId).selectionTab;
    stateFor(windowId).selectionOrigin = 'context';
    await send(record, 'capture-context', requestId);
  }).catch(error => { if (!stillCurrent()) return; stateFor(windowId).error = error instanceof Error && error.message === 'target-expired' ? 'target-expired' : 'unsupported-page'; publish(windowId, 'activated'); });
});

async function refreshWindow(windowId: number, event: StateEvent) {
  const revision = windowRevisions.get(windowId) ?? 0;
  await loaded;
  const tabs = await browser.tabs.query({ windowId, active: true });
  if ((windowRevisions.get(windowId) ?? 0) !== revision) return;
  const tab = tabs[0];
  if (!tab) { clearVisible(windowId, null, 'unsupported'); publish(windowId, event); return; }
  const activation = tab.id === undefined ? undefined : activationJobs.get(tab.id);
  if (activation) { await activation; if ((windowRevisions.get(windowId) ?? 0) === revision) publish(windowId, event); return; }
  await attach(tab, false, crypto.randomUUID(), event);
}

async function activateAudit(windowId: number, command: Extract<SidebarCommand, { type: 'start-audit' }>) {
  const state = stateFor(windowId);
  const originalRevision = windowRevisions.get(windowId) ?? 0;
  if (command.expectedTabId !== undefined && (!Number.isSafeInteger(command.expectedTabId) || command.expectedTabId !== state.tabId)
    || command.expectedDocumentToken !== undefined && command.expectedDocumentToken !== state.documentToken
    || command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision !== originalRevision)) throw new Error('page-changed');
  if (state.tabId === null) throw new Error('activation-required');
  const tabId = state.tabId, epoch = session.epoch, revision = originalRevision + 1;
  // Reserve this explicit request before any browser await. Navigation, another
  // scan or revoked access invalidates it even when the tab and URL stay equal.
  windowRevisions.set(windowId, revision);
  attempts.delete(tabId); contextRequests.delete(tabId); activationJobs.delete(tabId);
  const stillCurrent = () => session.epoch === epoch && (windowRevisions.get(windowId) ?? 0) === revision && state.tabId === tabId;
  const activeTab = async () => {
    const [tab] = await browser.tabs.query({ windowId, active: true });
    if (!stillCurrent() || tab?.id !== tabId || tab.windowId !== windowId) throw new Error('page-changed');
    return tab;
  };
  try {
    const tab = await activeTab();
    // Idempotent injection also checks current page permission. An old receiver
    // may survive revocation and must not itself be treated as authorization.
    const record = await attach(tab, true, command.requestId);
    if (!stillCurrent()) return null;
    if (!record) throw new Error(state.error ?? 'activation-required');
    await activeTab();
    if (session.documents[String(tabId)] !== record || state.documentToken !== record.documentToken) throw new Error('page-changed');
    return record;
  } catch (error) {
    // After navigation or a newer scan, even an activation failure belongs to
    // the obsolete request. Initial invalid intents and current errors remain visible.
    if (!stillCurrent()) return null;
    throw error;
  }
}

function validatedEvent(message: unknown, sender: browser.runtime.MessageSender): ContentEvent | null {
  if (sender.id !== browser.runtime.id || sender.tab?.id === undefined || sender.tab.windowId === undefined || sender.frameId !== 0 || !message || typeof message !== 'object') return null;
  const event = message as ContentEvent;
  if (event.channel !== 'sil-event' || typeof event.requestId !== 'string' || event.epoch !== session.epoch) return null;
  if (!['selected', 'preview', 'picker-cancelled', 'audit', 'stale', 'unloaded', 'removed'].includes(event.type)) return null;
  const record = session.documents[String(sender.tab.id)];
  if (!identityMatches(record, sender.tab.windowId, sender.tab.id, event.documentToken)) return null;
  const data = event.snapshot ?? event.audit;
  if (data && (!identityMatches(record, data.document?.windowId, data.document?.tabId, data.document?.documentToken) || data.document.frameId !== 0)) return null;
  if (event.snapshot && (event.snapshot.textRuns?.length > 100 || !event.snapshot.styles)) return null;
  if (event.audit && event.audit.runs?.length > 1000) return null;
  return event;
}
function currentSnapshot(snapshot: Snapshot | undefined): Snapshot | null {
  return snapshot ? { ...snapshot, textRuns: snapshot.textRuns.map(run => evaluateRun(run, settings.contrastTarget)) } : null;
}

browser.runtime.onMessage.addListener((message: unknown, sender) => {
  if (!message || typeof message !== 'object' || (message as { channel?: string }).channel !== 'sil-event') return undefined;
  return loaded.then(() => {
    const event = validatedEvent(message, sender);
    if (!event || sender.tab?.id === undefined) return { ignored: true };
    const record = session.documents[String(sender.tab.id)]!;
    const state = stateFor(record.windowId);
    if (event.type === 'unloaded') {
      delete session.documents[String(record.tabId)]; attempts.delete(record.tabId);
      if (state.tabId === record.tabId) { windowRevisions.set(record.windowId, (windowRevisions.get(record.windowId) ?? 0) + 1); clearVisible(record.windowId, record.tabId, 'needs-activation'); publish(record.windowId, 'document-changed'); }
      void persist(); return { ok: true };
    }
    if (['selected', 'preview', 'picker-cancelled', 'removed', 'stale'].includes(event.type) && event.requestId !== record.selectionRequest) return { ignored: true };
    if (event.type === 'audit' && event.requestId !== record.auditRequest) return { ignored: true };
    recordChanged(record);
    switch (event.type) {
      case 'selected': record.selected = currentSnapshot(event.snapshot); record.picker = false; if (state.tabId === record.tabId) state.preview = null; break;
      case 'preview': if (state.tabId === record.tabId && record.picker) { state.preview = currentSnapshot(event.snapshot); publish(record.windowId, 'preview'); } return { ok: true };
      case 'picker-cancelled': record.picker = false; record.selected = currentSnapshot(event.snapshot); if (state.tabId === record.tabId) state.preview = null; break;
      case 'removed': record.selected = null; if (state.tabId === record.tabId) { state.preview = null; state.error = 'element-removed'; } break;
      case 'stale': if (record.selected) record.selected.stale = true; break;
      case 'audit': record.audit = event.audit ? reassessAudit(event.audit, settings.contrastTarget) : null; break;
    }
    record.touchedAt = Date.now();
    applyRecord(record, event.type === 'removed' ? 'stale' : event.type);
    void persist(); return { ok: true };
  });
});

function applySettings(next: Settings) {
  settings = next;
  for (const record of Object.values(session.documents)) {
    recordChanged(record);
    if (record.audit) record.audit = reassessAudit(record.audit, next.contrastTarget);
    if (record.selected) record.selected.textRuns = record.selected.textRuns.map(run => evaluateRun(run, next.contrastTarget));
    void send(record, 'settings', crypto.randomUUID()).catch(() => undefined);
    applyRecord(record, 'settings');
  }
  for (const [windowId, state] of windows) { state.preview = currentSnapshot(state.preview ?? undefined); publish(windowId, 'settings'); }
  syncMenu(); void persist();
}
function updateSettings(patch: Partial<Settings>, reset = false) {
  const operation = settingsQueue.then(async () => {
    // Merge after preceding writes have completed; rapid independent changes cannot overwrite each other.
    const next = validateSettings({ ...(reset ? DEFAULT_SETTINGS : settings), ...patch });
    await browser.storage.local.set({ [SETTINGS_KEY]: settingsRecord(next) });
    applySettings(next);
  });
  settingsQueue = operation.catch(() => undefined);
  return operation;
}

async function clearData() {
  session.epoch++;
  attempts.clear(); contextRequests.clear(); activationJobs.clear();
  for (const windowId of windows.keys()) windowRevisions.set(windowId, (windowRevisions.get(windowId) ?? 0) + 1);
  const records = Object.values(session.documents);
  for (const record of records) {
    record.selected = null; record.audit = null; record.picker = false; record.selectionRequest = ''; record.auditRequest = ''; record.pendingContextSelection = false;
  }
  for (const windowId of windows.keys()) {
    const state = stateFor(windowId);
    state.selected = null; state.preview = null; state.picker = false; state.audit = null; state.progress = null;
    publish(windowId, 'data-cleared');
  }
  const cleanup = Promise.allSettled(records.map(record => send(record, 'clear-data', crypto.randomUUID())));
  await persist();
  await cleanup;
}

async function saveExport(command: Extract<SidebarCommand, { type: 'save-export' }>, windowId: number) {
  if (typeof command.text !== 'string' || command.text.length > 4_000_000 || !safeFilename(command.filename) || !['text/css', 'text/x-scss', 'application/json', 'text/plain'].some(mime => command.mime === mime || command.mime === `${mime};charset=utf-8` || command.mime === `${mime}; charset=utf-8`)) throw new Error('invalid-message');
  if (!await browser.permissions.contains({ permissions: ['downloads'] })) throw new Error('download-permission');
  registerDownloadListener();
  const url = URL.createObjectURL(new Blob([command.text], { type: command.mime }));
  let id: number;
  try {
    id = await browser.downloads.download({ url, filename: command.filename, saveAs: true, conflictAction: 'uniquify' });
  } catch (error) { URL.revokeObjectURL(url); throw error; }
  const owner = { url, requestId: command.requestId, windowId, persisted: Promise.resolve() };
  downloadOwners.set(id, owner);
  owner.persisted = browser.storage.session.set({ [`download:${id}`]: { requestId: command.requestId, windowId } }).catch(() => broadcastError('storage-failed'));
  // Completion may arrive while ownership is being persisted. Announce the
  // start first; finalization waits for this write before removing its record.
  for (const [port, window] of ports) if (window === windowId) post(port, { type: 'saved', requestId: command.requestId, status: 'started', downloadId: id });
  await owner.persisted;
  try {
    // Reconcile completion that happened before download() returned its ID.
    // Only inspect our newly created ID, never the user's download history.
    const item = (await browser.downloads.search({ id }))[0];
    if (item?.state === 'complete' || item?.state === 'interrupted') finishDownload(id, item.state, item.error);
  } catch { /* onChanged can still complete the owned transfer if lookup fails. */ }
}

function finishDownload(id: number, state: string, error?: string) {
  if (downloadFinalizations.has(id)) return;
  const operation = (async () => {
    let owner = downloadOwners.get(id);
    try {
      const stored = owner ? undefined : (await browser.storage.session.get(`download:${id}`))[`download:${id}`] as { requestId: string; windowId: number } | undefined;
      // download() may have resolved while the restart-recovery lookup waited.
      owner ??= downloadOwners.get(id);
      const data = owner ?? stored;
      if (!data) return;
      await owner?.persisted;
      if (state === 'interrupted' && !error) {
        try { error = (await browser.downloads.search({ id }))[0]?.error; } catch { /* Unknown interruption remains a failure. */ }
      }
      const status = state === 'complete' ? 'complete' : error === 'USER_CANCELED' ? 'cancelled' : 'failed';
      await browser.storage.session.remove(`download:${id}`).catch(() => broadcastError('storage-failed'));
      for (const [port, windowId] of ports) if (windowId === data.windowId) post(port, { type: 'saved', requestId: data.requestId, status, downloadId: id });
    } finally {
      if (owner) { URL.revokeObjectURL(owner.url); downloadOwners.delete(id); }
    }
  })().catch(() => broadcastError('storage-failed')).finally(() => { downloadFinalizations.delete(id); });
  downloadFinalizations.set(id, operation);
}
const downloadChanged = (delta: browser.downloads._OnChangedDownloadDelta) => { if (delta.state?.current === 'complete' || delta.state?.current === 'interrupted') finishDownload(delta.id, delta.state.current, delta.error?.current); };
function registerDownloadListener() {
  if (browser.downloads?.onChanged && !browser.downloads.onChanged.hasListener(downloadChanged)) browser.downloads.onChanged.addListener(downloadChanged);
}
registerDownloadListener();
browser.permissions.onAdded.addListener(() => registerDownloadListener());
browser.permissions.onRemoved.addListener(removed => {
  if (!removed.origins?.length) return;
  // Retire all live page records on a host-access change. This conservative
  // reset also covers wildcard grants and same-host documents in other windows.
  attempts.clear(); contextRequests.clear(); activationJobs.clear();
  for (const windowId of windows.keys()) windowRevisions.set(windowId, (windowRevisions.get(windowId) ?? 0) + 1);
  void loaded.then(async () => {
    const records = Object.values(session.documents);
    session.epoch++;
    session.documents = {};
    for (const [windowId, state] of windows) {
      clearVisible(windowId, state.tabId, 'needs-activation', 'activation-required');
      publish(windowId, 'document-changed');
    }
    const cleanup = Promise.allSettled(records.map(record => send(record, 'clear-data', crypto.randomUUID())));
    await persist();
    await cleanup;
  });
});

async function handleCommand(port: browser.runtime.Port, command: SidebarCommand) {
  await loaded;
  if (command.type === 'ready') {
    if (!Number.isSafeInteger(command.windowId)) throw new Error('invalid-message');
    await browser.windows.get(command.windowId);
    ports.set(port, command.windowId);
    await refreshWindow(command.windowId, 'ready');
    return;
  }
  const windowId = ports.get(port);
  if (windowId === undefined) throw new Error('invalid-message');
  if (command.type === 'clear-data') return clearData();
  if (command.type === 'reset-settings') return updateSettings({}, true);
  if (command.type === 'update-settings') return updateSettings(command.settings);
  if (command.type === 'save-export') return saveExport(command, windowId);
  const state = stateFor(windowId);
  const record = command.type === 'start-audit' ? await activateAudit(windowId, command)
    : state.tabId === null ? undefined : session.documents[String(state.tabId)];
  if (command.type === 'start-audit' && !record) return;
  if (state.access !== 'ready' || !record || record.documentToken !== state.documentToken) throw new Error('activation-required');
  if (['start-picker', 'cancel-picker', 'refresh-selection', 'select-node'].includes(command.type)) {
    // A newer explicit selection intent retires an unfinished context capture,
    // including its late failure. It must not take control back from the user.
    contextRequests.delete(record.tabId);
  }
  if (['start-picker', 'cancel-picker', 'refresh-selection', 'select-node', 'start-audit', 'cancel-audit'].includes(command.type)) recordChanged(record);
  if (['start-picker', 'refresh-selection', 'select-node'].includes(command.type)) {
    record.selectionRequest = command.requestId;
    state.preview = null;
    delete state.selectionTab;
    state.selectionOrigin = command.type === 'start-picker' ? 'picker' : command.type === 'refresh-selection' ? 'refresh' : 'audit';
  }
  if (command.type === 'start-picker') record.picker = true;
  if (command.type === 'cancel-picker') { record.picker = false; state.preview = null; }
  if (command.type === 'start-audit') {
    // A new scan is a fresh analysis of this document only. Retire outstanding
    // captures/replies before dispatching work so old results cannot return.
    attempts.delete(record.tabId); contextRequests.delete(record.tabId); activationJobs.delete(record.tabId);
    record.selected = null; record.audit = null; record.picker = false;
    record.pendingContextSelection = false;
    record.selectionRequest = command.requestId; record.auditRequest = command.requestId;
    state.selected = null; state.preview = null; state.picker = false; state.audit = null; state.progress = null;
    delete state.selectionTab; delete state.selectionOrigin; delete state.error;
    publish(windowId, 'audit-reset');
    void persist();
  }
  if (command.type === 'select-node') state.selectionTab = command.tab ?? 'contrast';
  const revision = windowRevisions.get(windowId) ?? 0;
  const selectionRequest = record.selectionRequest, auditRequest = record.auditRequest;
  const stillCurrent = () => session.documents[String(record.tabId)] === record && state.tabId === record.tabId
    && state.documentToken === record.documentToken && (windowRevisions.get(windowId) ?? 0) === revision
    // A newer picker or inspected element supersedes pending replies even
    // when the document stays unchanged. Cancellation keeps its request ID.
    && record.selectionRequest === selectionRequest && record.auditRequest === auditRequest;
  try {
    await send(record, command.type, command.requestId, 'referenceId' in command ? { referenceId: command.referenceId } : {});
    if (!stillCurrent()) return;
    applyRecord(record, command.type === 'cancel-picker' ? 'picker-cancelled' : 'activated');
    void persist();
  } catch (error) {
    if (!stillCurrent()) return;
    recordChanged(record);
    record.picker = false; state.preview = null;
    // A connected content script can reject one expired/unsupported operation
    // without losing page access. Only transport failures require activation.
    if (!(error instanceof ContentOperationError)) state.access = 'needs-activation';
    publish(windowId, 'activated'); throw error;
  }
}

browser.runtime.onConnect.addListener(port => {
  if (port.name !== 'sidebar' || port.sender?.id !== browser.runtime.id || port.sender.url !== browser.runtime.getURL('sidebar/index.html')) return;
  port.onMessage.addListener((value: unknown) => {
    if (!isSidebarCommand(value)) { post(port, { type: 'error', code: 'invalid-message' }); return; }
    void handleCommand(port, value).catch(error => post(port, { type: 'error', requestId: value.requestId, code: error instanceof Error ? error.message : 'operation-failed' }));
  });
  port.onDisconnect.addListener(() => {
    const windowId = ports.get(port); ports.delete(port);
    if (windowId === undefined || [...ports.values()].includes(windowId)) return;
    const state = stateFor(windowId);
    const record = state.tabId === null ? undefined : session.documents[String(state.tabId)];
    if (record) { recordChanged(record); record.picker = false; void send(record, 'cancel-picker', crypto.randomUUID()).catch(() => undefined); void persist(); }
    state.preview = null; state.picker = false;
  });
});

browser.tabs.onActivated.addListener(info => {
  const revision = (windowRevisions.get(info.windowId) ?? 0) + 1;
  windowRevisions.set(info.windowId, revision);
  void loaded.then(async () => {
  if (windowRevisions.get(info.windowId) !== revision) return;
  const oldState = stateFor(info.windowId);
  const previous = oldState.tabId === null ? undefined : session.documents[String(oldState.tabId)];
  if (previous) { recordChanged(previous); previous.picker = false; void send(previous, 'cancel-picker', crypto.randomUUID()).catch(() => undefined); }
  clearVisible(info.windowId, info.tabId, 'needs-activation'); publish(info.windowId, 'document-changed');
  await refreshWindow(info.windowId, 'document-changed');
}); });
browser.tabs.onUpdated.addListener((tabId, changes, tab) => {
  if (changes.status !== 'loading') return;
  const windowId = tab.windowId;
  if (windowId === undefined) return;
  if (windows.get(windowId)?.tabId === tabId) windowRevisions.set(windowId, (windowRevisions.get(windowId) ?? 0) + 1);
  contextRequests.delete(tabId);
  void loaded.then(() => {
    const record = session.documents[String(tabId)];
    if (record) void send(record, 'cancel-picker', crypto.randomUUID()).catch(() => undefined);
    delete session.documents[String(tabId)]; attempts.delete(tabId);
    const state = windows.get(windowId);
    if (state?.tabId === tabId) { clearVisible(windowId, tabId, 'needs-activation'); publish(windowId, 'document-changed'); }
    void persist();
  });
});
browser.tabs.onRemoved.addListener(tabId => {
  attempts.delete(tabId); contextRequests.delete(tabId); activationJobs.delete(tabId);
  for (const [windowId, state] of windows) if (state.tabId === tabId) {
    windowRevisions.set(windowId, (windowRevisions.get(windowId) ?? 0) + 1);
    clearVisible(windowId, null, 'needs-activation'); publish(windowId, 'document-changed');
  }
  void loaded.then(() => { delete session.documents[String(tabId)]; void persist(); });
});
browser.windows.onRemoved.addListener(windowId => {
  windowRevisions.set(windowId, (windowRevisions.get(windowId) ?? 0) + 1);
  for (const [port, owner] of ports) if (owner === windowId) ports.delete(port);
  void loaded.then(() => { windows.delete(windowId); for (const record of Object.values(session.documents)) if (record.windowId === windowId) { delete session.documents[String(record.tabId)]; attempts.delete(record.tabId); contextRequests.delete(record.tabId); activationJobs.delete(record.tabId); } void persist(); });
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[SETTINGS_KEY]) return;
  const next = validateSettings(changes[SETTINGS_KEY].newValue);
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  applySettings(next);
});
browser.runtime.onInstalled.addListener(() => syncMenu());
browser.runtime.onStartup.addListener(() => syncMenu());
void loaded.then(() => syncMenu());
