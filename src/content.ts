import { auditMeasurementsChanged, summarizeRuns } from './core/contrast';
import { parseColor } from './core/colors';
import type { Audit, DocumentIdentity, Settings, Snapshot, Viewport } from './core/types';
import type { ContentCommand, ContentEvent } from './runtime/protocol';
import { DEFAULT_SETTINGS } from './runtime/settings';
import { randomId } from './runtime/id';
import { directTextCount, elementLabel, ElementRegistry, isOwnElement, measureRuns, measureSnapshot, OVERLAY_ATTRIBUTE, registerOwnElement, viewport, type TextRunGeometry } from './runtime/dom';

interface Capture { requestId: string; element: Element | null }
const globals = globalThis as typeof globalThis & { __styleInspectorInstalled?: boolean; __styleInspectorContext?: Capture };

if (!globals.__styleInspectorInstalled) {
  globals.__styleInspectorInstalled = true;
  let documentToken = randomId();
  let registry = new ElementRegistry(documentToken);
  let identity: DocumentIdentity = { windowId: -1, tabId: -1, frameId: 0, documentToken };
  let settings: Settings = { ...DEFAULT_SETTINGS };
  // The first hello establishes the session generation. Later increases are a
  // data-clear boundary even if its dedicated clear-data command is delayed.
  let epoch = -1;
  let selection: Element | null = null;
  let selectionRequest = '';
  let lastSnapshot: Snapshot | null = null;
  let lastPreview: Snapshot | null = null;
  let picker = false;
  let pickerRequest = '';
  let hover: Element | null = null;
  let animation = 0;
  let flashTimer = 0;
  let resizeTimer = 0;
  let overlay: HTMLDivElement | null = null;
  let outline: HTMLDivElement | null = null;
  let label: HTMLDivElement | null = null;
  let highlighted: Element | null = null;
  let showLabel = false;
  let auditJob: { cancelled: boolean; changed: boolean; audit: Audit; requestId: string; epoch: number; previousReferences: ReadonlySet<string> } | null = null;
  let lastAudit: Audit | null = null;
  let active = true;

  function pruneReferences() {
    const references = new Set(lastAudit?.runs.map(run => run.elementRef));
    // An automatic scan reuses live IDs from the bounded preceding audit until
    // it has reached those nodes. Its final dataset then replaces this reserve.
    for (const reference of auditJob?.previousReferences ?? []) references.add(reference);
    for (const snapshot of [lastSnapshot, lastPreview]) {
      if (!snapshot) continue;
      references.add(snapshot.elementRef);
      for (const run of snapshot.textRuns) references.add(run.elementRef);
    }
    registry.retain(references);
  }

  function emit(type: ContentEvent['type'], requestId: string, detail: Partial<ContentEvent> = {}, eventEpoch = epoch) {
    if (identity.tabId < 0) return;
    const event: ContentEvent = { channel: 'sil-event', type, documentToken, requestId, epoch: eventEpoch, ...detail };
    void browser.runtime.sendMessage(event).catch(() => { stopPicker(false); });
  }

  function ensureOverlay() {
    if (overlay?.isConnected) return;
    overlay = document.createElement('div');
    registerOwnElement(overlay);
    overlay.setAttribute(OVERLAY_ATTRIBUTE, '');
    overlay.lang = browser.i18n.getUILanguage();
    overlay.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;contain:layout style!important;';
    const root = overlay.attachShadow({ mode: 'closed' });
    outline = document.createElement('div');
    outline.style.cssText = 'position:fixed;box-sizing:border-box;border:3px solid #0674ff;box-shadow:0 0 0 2px #fff,0 0 0 4px #111827;background:rgb(0 117 255 / .13);pointer-events:none;';
    label = document.createElement('div');
    label.textContent = browser.i18n.getMessage('pickerHint');
    label.style.cssText = 'position:fixed;left:12px;bottom:12px;box-sizing:border-box;width:max-content;max-width:calc(100vw - 16px);padding:9px 12px;border:2px solid #fff;border-radius:8px;background:#172238;color:#fff;font:600 13px/1.4 system-ui,sans-serif;overflow-wrap:anywhere;box-shadow:0 0 0 1px #111827,0 2px 12px #0005;pointer-events:none;';
    root.append(outline, label);
    document.documentElement.append(overlay);
    window.addEventListener('keydown', keydown, true);
    window.addEventListener('scroll', updateOverlay, true);
  }

  function highlightRect(element: Element) {
    const box = element.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) return box;
    // display:contents and zero-box wrappers can still contain visible text or
    // children. Range geometry reads their painted bounds, never their values.
    const range = document.createRange();
    range.selectNodeContents(element);
    let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      left = Math.min(left, rect.left); top = Math.min(top, rect.top);
      right = Math.max(right, rect.right); bottom = Math.max(bottom, rect.bottom);
    }
    if (!Number.isFinite(left)) return box;
    return { left, top, right, bottom, width: right - left, height: bottom - top };
  }

  function draw(element: Element | null) {
    if (!element?.isConnected) { if (!picker) removeOverlay(); return; }
    ensureOverlay();
    const rect = highlightRect(element);
    if (outline) Object.assign(outline.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    if (label) {
      label.hidden = !picker && !showLabel;
      label.textContent = browser.i18n.getMessage(picker ? 'pickerHint' : 'highlightHint', elementLabel(element));
      if (picker) Object.assign(label.style, { left: '12px', top: 'auto', bottom: '12px' });
      else if (showLabel) {
        const size = label.getBoundingClientRect();
        const above = rect.top - size.height - 10;
        const below = rect.bottom + 10;
        const top = above >= 8 ? above : below + size.height <= window.innerHeight - 8 ? below : 8;
        const left = Math.max(8, Math.min(rect.left, window.innerWidth - size.width - 8));
        Object.assign(label.style, { left: `${left}px`, top: `${Math.max(8, Math.min(top, window.innerHeight - size.height - 8))}px`, bottom: 'auto' });
      }
    }
  }

  function removeOverlay() {
    window.clearTimeout(flashTimer); flashTimer = 0;
    highlighted = null; showLabel = false;
    window.removeEventListener('keydown', keydown, true);
    window.removeEventListener('scroll', updateOverlay, true);
    overlay?.remove(); overlay = null; outline = null; label = null;
  }

  function flash(element: Element, scroll = false) {
    stopPicker(false);
    highlighted = element; showLabel = scroll;
    if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    draw(element);
    flashTimer = window.setTimeout(removeOverlay, scroll ? 8000 : 1000);
  }

  function measureSelection(element: Element, invalidateAudit = true): Snapshot {
    const snapshot = measureSnapshot(element, identity, registry, settings, { includeText: true });
    // Paint may change without DOM mutations (hover, scrolling, fonts or CSSOM).
    // Keep the audit's original rows, totals and timestamp together, but stop
    // presenting them as current when an explicit measurement contradicts them.
    if (invalidateAudit && lastAudit && !lastAudit.stale && auditMeasurementsChanged(lastAudit, snapshot)) {
      if (auditJob) auditJob.changed = true;
      else {
        lastAudit.stale = true;
        emit('audit', lastAudit.id, { audit: lastAudit });
      }
    }
    return snapshot;
  }

  function select(element: Element, requestId: string) {
    stopPicker(false);
    if (!element.isConnected) throw new Error('element-removed');
    selection = element;
    selectionRequest = requestId;
    lastSnapshot = measureSelection(element, false);
    pruneReferences();
    emit('selected', requestId, { snapshot: lastSnapshot });
    flash(element);
    // An explicit fresh measurement can contradict an earlier page scan after
    // scrolling or CSSOM/paint changes. Rebuild the complete audit at this page
    // state, keeping the confirmed selection and registry. Rebuild the whole
    // dataset so row measurements, counts and page styles share one scan.
    if (active && lastAudit && auditMeasurementsChanged(lastAudit, lastSnapshot)) {
      if (auditJob) auditJob.changed = true;
      else if (lastAudit.status !== 'cancelled') void runAudit(lastAudit.id, true);
    }
    return lastSnapshot;
  }

  function preview() {
    animation = 0;
    if (!picker || !hover?.isConnected) return;
    draw(hover);
    if (settings.livePreview) {
      lastPreview = measureSnapshot(hover, identity, registry, settings);
      pruneReferences();
      emit('preview', pickerRequest, { snapshot: lastPreview });
    }
  }

  function pointerMove(event: PointerEvent) {
    const element = event.composedPath().find(item => item instanceof Element && !isOwnElement(item)) as Element | undefined;
    if (!element || element === hover) return;
    hover = element;
    if (!animation) animation = requestAnimationFrame(preview);
  }

  function updateOverlay() { if (picker && hover) draw(hover); else if (highlighted) draw(highlighted); }

  // Retain every capture listener through the terminal click: removing at pointerdown leaks page actions.
  function suppress(event: Event) {
    if (!picker) return;
    if (event instanceof MouseEvent && event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type !== 'click') return;
    const element = event.composedPath().find(item => item instanceof Element && !isOwnElement(item)) as Element | undefined;
    if (element) select(element, pickerRequest);
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || (!picker && !highlighted)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    stopPicker(true);
  }

  const guardedEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'];

  function startPicker(requestId: string) {
    stopPicker(false);
    pickerRequest = requestId; picker = true;
    ensureOverlay();
    if (outline) outline.style.display = 'none';
    window.addEventListener('pointermove', pointerMove, true);
    for (const type of guardedEvents) window.addEventListener(type, suppress, { capture: true, passive: false });
  }

  function stopPicker(notify: boolean) {
    const previous = picker;
    picker = false; hover = null; lastPreview = null;
    cancelAnimationFrame(animation); animation = 0;
    window.removeEventListener('pointermove', pointerMove, true);
    for (const type of guardedEvents) window.removeEventListener(type, suppress, true);
    removeOverlay();
    pruneReferences();
    if (notify && previous) {
      // The coordinator tracks the picker request after starting selection.
      // Keep the restored confirmed element attached to that request so future
      // resize/removal/staleness events continue to pass its freshness check.
      selectionRequest = pickerRequest;
      emit('picker-cancelled', pickerRequest, lastSnapshot ? { snapshot: lastSnapshot } : {});
    }
  }

  function resetAnalysis() {
    stopPicker(false);
    clearTimeout(resizeTimer); resizeTimer = 0;
    if (auditJob) auditJob.cancelled = true;
    auditJob = null;
    selection = null; lastSnapshot = null; lastAudit = null;
    selectionRequest = ''; pickerRequest = '';
    registry.clear();
    delete globals.__styleInspectorContext;
    // A new scan observes the current DOM, including changes already queued
    // before it started. Do not replay those old records against fresh data.
    observer.takeRecords();
  }

  async function runAudit(requestId: string, preserveSelection = false) {
    const previousReferences = new Set(preserveSelection ? lastAudit?.runs.map(run => run.elementRef) : []);
    if (preserveSelection) {
      // This internal follow-up shares the coordinator's existing audit token.
      // Running work is never queued/retried; a manual scan still resets it.
      if (auditJob || !active) return;
      observer.takeRecords();
    } else resetAnalysis();
    const audit: Audit = {
      id: requestId, document: { ...identity }, measuredAt: new Date().toISOString(), viewport: viewport(),
      target: settings.contrastTarget, status: 'running', stale: false, scanned: 0, skipped: 0, total: 0,
      reasons: ['main-document-only', 'images-canvas-not-tested', 'shadow-dom-not-tested', 'dynamic-content-snapshot'],
      runs: [], palette: [], fonts: [], counts: summarizeRuns([]),
    };
    const job = { cancelled: false, changed: false, audit, requestId, epoch, previousReferences };
    auditJob = job; lastAudit = audit;
    pruneReferences();
    emit('audit', requestId, { audit: structuredClone(audit) }, job.epoch);
    const capturedSettings = { ...settings };
    const palette = new Map<string, ReturnType<typeof parseColor>>();
    const fonts = new Set<string>();
    let current: Element | null = document.documentElement;
    let examined = 0, lastSent = performance.now();
    let truncatedText = false;
    try {
      const walker = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
      while (current && !job.cancelled && active && audit.runs.length < 1000 && examined < 20000) {
        for (let batch = 0; batch < 32 && current && audit.runs.length < 1000 && examined < 20000; batch++) {
          examined++;
          if (!isOwnElement(current)) {
            if (current.tagName === 'IFRAME' || current.shadowRoot || ['CANVAS', 'TEXTAREA'].includes(current.tagName)) audit.skipped++;
            // directTextCount already checks visibility through all ancestors.
            const remaining = 1000 - audit.runs.length;
            const geometry: TextRunGeometry[] = [];
            const count = directTextCount(current, remaining + 1, geometry);
            if (count) {
              truncatedText ||= count > remaining;
              const runs = measureRuns(current, registry, capturedSettings, Math.min(count, remaining), geometry);
              audit.runs.push(...runs);
              const style = getComputedStyle(current);
              for (const raw of [style.color, style.backgroundColor]) if (palette.size < 128) palette.set(raw, parseColor(raw));
              if (fonts.size < 64) fonts.add(style.fontFamily.slice(0, 512));
            }
          }
          current = walker.nextNode() as Element | null;
        }
        audit.scanned = audit.runs.length;
        audit.total = audit.scanned + audit.skipped;
        if (auditJob === job && performance.now() - lastSent > 200) {
          audit.counts = summarizeRuns(audit.runs);
          emit('audit', requestId, { audit: structuredClone(audit) }, job.epoch);
          lastSent = performance.now();
        }
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      audit.status = job.cancelled || !active ? 'cancelled' : current || truncatedText || job.changed ? 'partial' : 'complete';
      if ((current || truncatedText) && !job.cancelled) audit.reasons.push('scan-limit');
    } catch {
      audit.status = 'partial';
      audit.reasons.push('measurement-failed');
    }
    // A scan can reach the selected element several batches after inspection.
    // CSSOM/hover paint changes need not produce a mutation or a new selection
    // event. Neither of two conflicting measurements is proven current.
    if (auditJob === job && active && job.epoch === epoch && !job.cancelled
      && audit.document.documentToken === documentToken && lastSnapshot
      && auditMeasurementsChanged(audit, lastSnapshot, true, job.previousReferences)) {
      job.changed = true;
      if (audit.status === 'complete') audit.status = 'partial';
      lastSnapshot.stale = true;
      emit('stale', selectionRequest, { snapshot: lastSnapshot }, job.epoch);
    }
    if (job.changed) { audit.reasons.push('document-changed-during-scan'); audit.stale = true; }
    audit.palette = [...palette.values()]; audit.fonts = [...fonts];
    audit.scanned = audit.runs.length; audit.total = audit.scanned + audit.skipped;
    audit.counts = summarizeRuns(audit.runs);
    if (auditJob === job && active && job.epoch === epoch && audit.document.documentToken === documentToken) {
      auditJob = null; lastAudit = audit;
      pruneReferences();
      emit('audit', requestId, { audit }, job.epoch);
    }
  }

  const observer = new MutationObserver(records => {
    if (highlighted && !highlighted.isConnected) removeOverlay();
    if (!records.some(record => {
      if (isOwnElement(record.target instanceof Element ? record.target : record.target.parentElement ?? document.documentElement)) return false;
      const changed = [...record.addedNodes, ...record.removedNodes];
      return record.type !== 'childList' || !changed.length || !changed.every(node => node instanceof Element && isOwnElement(node));
    })) return;
    if (auditJob) auditJob.changed = true;
    if (selection && !selection.isConnected) {
      selection = null; lastSnapshot = null; emit('removed', selectionRequest);
    } else if (lastSnapshot && !lastSnapshot.stale) {
      lastSnapshot.stale = true;
      emit('stale', selectionRequest, { snapshot: lastSnapshot });
    }
    if (lastAudit && !lastAudit.stale && !auditJob) {
      lastAudit.stale = true;
      emit('audit', lastAudit.id, { audit: lastAudit });
    }
    pruneReferences();
  });
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });

  // Scroll positions can change paint without a DOM mutation, including inside
  // nested message panes. Do not publish a multi-position scan as complete.
  window.addEventListener('scroll', () => { if (auditJob) auditJob.changed = true; }, { capture: true, passive: true });

  window.addEventListener('resize', () => {
    updateOverlay();
    const now = viewport();
    const sameViewport = (previous: Viewport) => previous.width === now.width && previous.height === now.height && previous.devicePixelRatio === now.devicePixelRatio;
    if (auditJob && !sameViewport(auditJob.audit.viewport)) auditJob.changed = true;
    if (lastAudit && !lastAudit.stale && !sameViewport(lastAudit.viewport)) { lastAudit.stale = true; emit('audit', lastAudit.id, { audit: lastAudit }); }
    if (lastSnapshot && sameViewport(lastSnapshot.viewport)) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      if (selection?.isConnected) {
        lastSnapshot = measureSelection(selection);
        pruneReferences();
        emit('selected', selectionRequest, { snapshot: lastSnapshot });
      }
    }, 150);
  });

  window.addEventListener('pagehide', () => {
    active = false; stopPicker(false); clearTimeout(resizeTimer);
    if (auditJob) auditJob.cancelled = true;
    emit('unloaded', selectionRequest);
  });
  window.addEventListener('pageshow', event => {
    active = true;
    if (event.persisted) {
      // A suspended old scan must not repopulate lastAudit after this restored
      // document has obtained a new token and a fresh activation handshake.
      resetAnalysis();
      documentToken = randomId(); registry = new ElementRegistry(documentToken);
      identity = { ...identity, documentToken };
    }
  });

  browser.runtime.onMessage.addListener((message: unknown, sender) => {
    if (sender.id !== browser.runtime.id || !message || typeof message !== 'object') return undefined;
    const command = message as ContentCommand;
    if (command.channel !== 'sil-content' || typeof command.requestId !== 'string') return undefined;
    if (command.documentToken && command.documentToken !== documentToken) return Promise.resolve({ error: 'stale-document' });
    if (command.epoch < epoch) return Promise.resolve({ error: 'stale-document' });
    if (!Number.isSafeInteger(command.epoch) || command.epoch < 0) return Promise.resolve({ error: 'invalid-message' });
    const reassigned = identity.tabId >= 0 && (command.windowId !== identity.windowId || command.tabId !== identity.tabId);
    if (reassigned && command.type !== 'hello') return Promise.resolve({ error: 'stale-document' });
    // A context-menu target is captured immediately before its handshake. Keep
    // only that exact new request across a window move, never across data clear.
    const capture = reassigned && command.epoch === epoch
      && globals.__styleInspectorContext?.requestId === command.requestId ? globals.__styleInspectorContext : undefined;
    // Moving a tab to another window is a fresh coordinator ownership boundary.
    // Old snapshots and pending jobs must not keep emitting the former identity.
    if (reassigned || epoch >= 0 && command.epoch > epoch) resetAnalysis();
    if (capture) globals.__styleInspectorContext = capture;
    epoch = command.epoch;
    settings = command.settings;
    identity = { windowId: command.windowId, tabId: command.tabId, frameId: 0, documentToken };
    try {
      switch (command.type) {
        case 'hello':
          if (selection?.isConnected) {
            lastSnapshot = measureSelection(selection);
            pruneReferences();
          }
          return Promise.resolve({ documentToken, selected: lastSnapshot, audit: lastAudit, picker, selectionRequest: picker ? pickerRequest : selectionRequest, auditRequest: lastAudit?.id ?? '' });
        case 'capture-context': {
          const capture = globals.__styleInspectorContext;
          delete globals.__styleInspectorContext;
          if (!capture || capture.requestId !== command.requestId || !capture.element?.isConnected) throw new Error('target-expired');
          return Promise.resolve({ snapshot: select(capture.element, command.requestId), documentToken });
        }
        case 'start-picker': startPicker(command.requestId); break;
        case 'cancel-picker': stopPicker(true); break;
        case 'start-audit': void runAudit(command.requestId); break;
        case 'cancel-audit': if (auditJob) auditJob.cancelled = true; break;
        case 'refresh-selection':
          if (!selection?.isConnected) throw new Error('element-removed');
          select(selection, command.requestId); break;
        case 'show-node':
        case 'select-node': {
          const element = registry.get(command.referenceId ?? '');
          if (!element) throw new Error('element-removed');
          if (command.type === 'show-node') {
            if (picker) stopPicker(true);
            flash(element, true);
          } else select(element, command.requestId);
          break;
        }
        case 'clear-data':
          resetAnalysis();
          break;
        case 'settings': break;
        default: return Promise.resolve({ error: 'invalid-message' });
      }
      return Promise.resolve({ ok: true, documentToken });
    } catch (error) { return Promise.resolve({ error: error instanceof Error ? error.message : 'measurement-failed' }); }
  });
}
