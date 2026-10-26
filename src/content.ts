import { auditMeasurementsChanged, summarizeRuns } from './core/contrast';
import { hasInteractiveAncestor, StyleInventory } from './core/style-inventory';
import type { Audit, AuditScope, DocumentIdentity, Settings, Snapshot, TextRun, Viewport } from './core/types';
import type { ContentCommand, ContentEvent } from './runtime/protocol';
import { DEFAULT_SETTINGS } from './runtime/settings';
import { randomId } from './runtime/id';
import { captureDiagnostic } from './runtime/diagnostics';
import { createMeasurementStyleCache, elementLabel, ElementRegistry, isOwnElement, iterateDirectText, iterateMeasurementSteps, iterateSnapshot, OVERLAY_ATTRIBUTE, registerOwnElement, viewport, withMeasurementBatch, type TextRunGeometry } from './runtime/dom';

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
  let coordinatorToken: string | undefined;
  let selection: Element | null = null;
  let selectionRequest = '';
  let lastSnapshot: Snapshot | null = null;
  let lastPreview: Snapshot | null = null;
  let picker = false;
  let pickerRequest = '';
  let hover: Element | null = null;
  let animation = 0;
  let previewTimer = 0;
  let flashTimer = 0;
  let observing = false;
  let overlay: HTMLDivElement | null = null;
  let outline: HTMLDivElement | null = null;
  let label: HTMLDivElement | null = null;
  let labelledElement: Element | null = null;
  let highlighted: Element | null = null;
  let showLabel = false;
  let auditJob: { cancelled: boolean; changed: boolean; audit: Audit; requestId: string; epoch: number } | null = null;
  let lastAudit: Audit | null = null;
  let active = true;
  interface SnapshotJob {
    kind: 'selection' | 'preview'; cancelled: boolean; changed: boolean; epoch: number;
    documentToken: string; viewport: Viewport; references: Set<string>; pickerCapture?: boolean;
    styleCache: ReturnType<typeof createMeasurementStyleCache> | undefined;
  }
  let snapshotJob: SnapshotJob | null = null;

  function pruneReferences() {
    const references = new Set(lastAudit?.runs.map(run => run.elementRef));
    if (lastAudit?.rootElementRef) references.add(lastAudit.rootElementRef);
    for (const snapshot of [lastSnapshot, lastPreview]) {
      if (!snapshot) continue;
      references.add(snapshot.elementRef);
      for (const run of snapshot.textRuns) references.add(run.elementRef);
    }
    for (const reference of snapshotJob?.references ?? []) references.add(reference);
    registry.retain(references);
  }

  function emit(type: ContentEvent['type'], requestId: string, detail: Partial<ContentEvent> = {}, eventEpoch = epoch) {
    if (identity.tabId < 0) return;
    const event: ContentEvent = { channel: 'sil-event', type, documentToken, requestId, epoch: eventEpoch, coordinatorToken, ...detail };
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
    window.addEventListener('resize', updateOverlay);
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
      if (labelledElement !== element) {
        label.textContent = browser.i18n.getMessage(picker ? 'pickerHint' : 'highlightHint', elementLabel(element));
        labelledElement = element;
      }
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
    window.removeEventListener('resize', updateOverlay);
    overlay?.remove(); overlay = null; outline = null; label = null; labelledElement = null;
  }

  function flash(element: Element, scroll = false) {
    stopPicker(false);
    highlighted = element; showLabel = scroll;
    if (scroll) element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    draw(element);
    flashTimer = window.setTimeout(removeOverlay, scroll ? 8000 : 1000);
  }

  function cancelSnapshot(kind?: SnapshotJob['kind']) {
    if (snapshotJob && (!kind || snapshotJob.kind === kind)) {
      snapshotJob.cancelled = true;
      snapshotJob = null;
    }
  }

  function snapshotCurrent(job: SnapshotJob) {
    return snapshotJob === job && !job.cancelled && active && job.epoch === epoch && job.documentToken === documentToken;
  }

  function startSnapshot(kind: SnapshotJob['kind']): SnapshotJob {
    cancelSnapshot();
    const job: SnapshotJob = { kind, cancelled: false, changed: false, epoch, documentToken, viewport: viewport(), references: new Set(), styleCache: createMeasurementStyleCache() };
    snapshotJob = job;
    updateObservation();
    return job;
  }

  async function captureSnapshot(element: Element, job: SnapshotJob, includeText = false) {
    const capture = iterateSnapshot(element, { ...identity }, registry, { ...settings }, {
      includeText, onRun: run => job.references.add(run.elementRef),
    });
    try {
      while (snapshotCurrent(job)) {
        if (!element.isConnected) throw new Error('element-removed');
        const started = performance.now();
        const result = withMeasurementBatch(() => {
          for (let step = 0; step < 128; step++) {
            const item = capture.next();
            if (item.done) return item.value;
            if (performance.now() - started >= 8) break;
          }
          return null;
        }, job.styleCache);
        if (result) {
          flushMutations();
          result.stale ||= job.changed;
          return result;
        }
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      throw new Error('request-cancelled');
    } finally {
      // Release the generator's DOM/geometry references on cancellation too.
      capture.return(undefined as never);
    }
  }

  async function select(element: Element, requestId: string, pickerCapture = false) {
    stopPicker(false);
    flushMutations();
    if (!element.isConnected) throw new Error('element-removed');
    const job = startSnapshot('selection');
    job.pickerCapture = pickerCapture;
    if (pickerCapture) window.addEventListener('keydown', keydown, true);
    try {
      const snapshot = await captureSnapshot(element, job, true);
      flushMutations();
      if (!snapshotCurrent(job)) throw new Error('request-cancelled');
      if (!element.isConnected) throw new Error('element-removed');
      snapshot.stale ||= job.changed;
      selection = element;
      selectionRequest = requestId;
      lastSnapshot = snapshot;
      pruneReferences();
      emit('selected', requestId, { snapshot: lastSnapshot });
      flash(element);
      // Inspecting one element does not authorize another complete page scan.
      // Preserve the original audit and mark a conflicting measurement stale.
      if (active && lastAudit && auditMeasurementsChanged(lastAudit, lastSnapshot)) {
        if (auditJob) auditJob.changed = true;
        else if (!lastAudit.stale) { lastAudit.stale = true; emit('audit', lastAudit.id, { audit: lastAudit }); }
      }
      updateObservation();
      return lastSnapshot;
    } finally {
      if (snapshotJob === job) snapshotJob = null;
      if (!picker && !highlighted && !snapshotJob?.pickerCapture) window.removeEventListener('keydown', keydown, true);
      pruneReferences(); updateObservation();
    }
  }

  function preview() {
    animation = 0;
    if (!picker || !hover?.isConnected) return;
    draw(hover);
  }

  function pointerMove(event: PointerEvent) {
    const element = event.composedPath().find(item => item instanceof Element && !isOwnElement(item)) as Element | undefined;
    if (!element || element === hover) return;
    cancelSnapshot('preview');
    hover = element;
    if (!animation) animation = requestAnimationFrame(preview);
    window.clearTimeout(previewTimer);
    // The outline follows immediately. Analyze only a target the pointer has
    // settled on; moving across large containers must not scan each subtree.
    previewTimer = window.setTimeout(async () => {
      previewTimer = 0;
      if (!picker || hover !== element || !element.isConnected || !settings.livePreview) return;
      const requestId = pickerRequest;
      const job = startSnapshot('preview');
      try {
        const snapshot = await captureSnapshot(element, job);
        flushMutations();
        if (!snapshotCurrent(job) || !picker || hover !== element || !element.isConnected || pickerRequest !== requestId) return;
        snapshot.stale ||= job.changed;
        lastPreview = snapshot;
        pruneReferences();
        emit('preview', requestId, { snapshot: lastPreview });
      } catch {
        // Event callbacks have no command response through which to report a
        // failed measurement. End this pick, release guards/references and
        // restore the confirmed selection without automatically retrying.
        if (snapshotCurrent(job)) stopPicker(true);
      } finally {
        if (snapshotJob === job) snapshotJob = null;
        pruneReferences(); updateObservation();
      }
    }, 120);
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
    if (element) {
      const requestId = pickerRequest;
      void select(element, requestId, true).catch(error => {
        // select() already ends local picking before measuring. Its failure
        // must also end the coordinator's picker, using that picker request.
        if (error instanceof Error && error.message !== 'request-cancelled' && pickerRequest === requestId && !snapshotJob && active) {
          stopPicker(false);
          restoreConfirmedSelection();
        }
      });
    }
  }

  function keydown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || (!picker && !highlighted && !snapshotJob?.pickerCapture)) return;
    event.preventDefault(); event.stopImmediatePropagation();
    stopPicker(true);
  }

  const guardedEvents = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick', 'auxclick'];

  function startPicker(requestId: string) {
    cancelSnapshot();
    stopPicker(false);
    pickerRequest = requestId; picker = true;
    ensureOverlay();
    if (outline) outline.style.display = 'none';
    window.addEventListener('pointermove', pointerMove, true);
    for (const type of guardedEvents) window.addEventListener(type, suppress, { capture: true, passive: false });
  }

  function stopPicker(notify: boolean) {
    const previous = picker || Boolean(snapshotJob?.pickerCapture);
    if (notify && snapshotJob?.pickerCapture) cancelSnapshot();
    cancelSnapshot('preview');
    picker = false; hover = null; lastPreview = null;
    cancelAnimationFrame(animation); animation = 0;
    window.clearTimeout(previewTimer); previewTimer = 0;
    window.removeEventListener('pointermove', pointerMove, true);
    for (const type of guardedEvents) window.removeEventListener(type, suppress, true);
    removeOverlay();
    pruneReferences();
    if (notify && previous) restoreConfirmedSelection();
  }

  function restoreConfirmedSelection() {
    // The coordinator tracks the picker request after starting selection.
    // Keep the restored confirmed element attached to that request so future
    // resize/removal/staleness events continue to pass its freshness check.
    selectionRequest = pickerRequest;
    emit('picker-cancelled', pickerRequest, lastSnapshot ? { snapshot: lastSnapshot } : {});
  }

  function resetAnalysis(preserveIdentity = false) {
    cancelSnapshot();
    stopPicker(false);
    if (auditJob) auditJob.cancelled = true;
    auditJob = null;
    selection = null; lastSnapshot = null; lastAudit = null;
    selectionRequest = ''; pickerRequest = '';
    registry.clear(preserveIdentity);
    delete globals.__styleInspectorContext;
    // A new scan observes the current DOM, including changes already queued
    // before it started. Do not replay those old records against fresh data.
    updateObservation();
  }

  async function runAudit(requestId: string, root: Element, scope: AuditScope) {
    resetAnalysis(true);
    const started = performance.now();
    const audit: Audit = {
      id: requestId, document: { ...identity }, measuredAt: new Date().toISOString(), viewport: viewport(),
      target: settings.contrastTarget, status: 'running', stale: false, scanned: 0, skipped: 0, total: 0,
      reasons: ['main-document-only', 'images-canvas-not-tested', 'shadow-dom-not-tested', 'dynamic-content-snapshot'],
      runs: [], palette: [], fonts: [], paletteUsage: [], fontUsage: [], counts: summarizeRuns([]),
      scope, durationMs: 0, examined: 0, limits: { maxRuns: 1000, maxElements: 20000 }, reachedLimits: [],
      ...(scope === 'selection' ? { rootElementRef: registry.reference(root) } : {}),
    };
    if (scope === 'viewport') audit.scopeViewport = { left: window.scrollX, top: window.scrollY, width: audit.viewport.width, height: audit.viewport.height };
    const job = { cancelled: false, changed: false, audit, requestId, epoch };
    auditJob = job; lastAudit = audit;
    updateObservation();
    pruneReferences();
    emit('audit', requestId, { audit: structuredClone(audit) }, job.epoch);
    const capturedSettings = { ...settings };
    const inventory = new StyleInventory();
    let retainedStyles: ReturnType<typeof createMeasurementStyleCache> | undefined = createMeasurementStyleCache();
    let current: Element | null = root;
    let examined = 0, lastSent = performance.now();
    let truncatedText = false;
    let pending: {
      element: Element; collect: ReturnType<typeof iterateDirectText>; geometry: TextRunGeometry[]; count: number; remaining: number;
      measure?: ReturnType<typeof iterateMeasurementSteps>; measured: number; style?: CSSStyleDeclaration; interactive?: boolean;
    } | null = null;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      while (current && !job.cancelled && active && audit.runs.length < 1000 && (pending || examined < 20000)) {
        if (job.changed) retainedStyles = undefined;
        const batchStarted = performance.now();
        withMeasurementBatch(() => {
          let elements = 0;
          type RecordedRuns = { element: Element; style: CSSStyleDeclaration; interactive: boolean; runs: TextRun[] };
          const batch: { recorded: RecordedRuns | null } = { recorded: null };
          const record = (entry: RecordedRuns | null) => {
            if (entry?.runs.length) inventory.record(entry.runs[0]!.elementRef, entry.style, entry.runs, entry.interactive);
          };
          try { for (let step = 0; step < 128 && current && audit.runs.length < 1000; step++) {
            if (step > 0 && performance.now() - batchStarted >= 8) break;
            if (!pending) {
              if (elements >= 32 || examined >= 20000) break;
              examined++; elements++;
              if (isOwnElement(current)) { current = walker.nextNode() as Element | null; continue; }
              if (current.tagName === 'IFRAME' || current.shadowRoot || ['CANVAS', 'TEXTAREA'].includes(current.tagName)) audit.skipped++;
              const remaining = 1000 - audit.runs.length;
              pending = { element: current, remaining, count: 0, measured: 0, geometry: [],
                collect: iterateDirectText(current, remaining + 1, false, scope === 'viewport' ? audit.viewport : undefined) };
            }
            if (!pending.measure) {
              const item = pending.collect.next();
              if (!item.done) {
                if (item.value) { pending.count++; if (item.value !== 'control') pending.geometry.push(item.value); }
                continue;
              }
              truncatedText ||= pending.count > pending.remaining;
              if (!pending.count) { pending = null; current = walker.nextNode() as Element | null; continue; }
              pending.measure = iterateMeasurementSteps(pending.element, registry, capturedSettings, Math.min(pending.count, pending.remaining), pending.geometry);
            }
            const item = pending.measure.next();
            if (!item.done) {
              if (!item.value) continue;
              audit.runs.push(item.value); pending.measured++;
              pending.style ??= getComputedStyle(pending.element);
              pending.interactive ??= hasInteractiveAncestor(pending.element);
              if (batch.recorded?.element !== pending.element) {
                record(batch.recorded);
                batch.recorded = { element: pending.element, style: pending.style, interactive: pending.interactive, runs: [] };
              }
              batch.recorded.runs.push(item.value);
            }
            if (item.done || pending.measured >= Math.min(pending.count, pending.remaining)) {
              pending = null; current = walker.nextNode() as Element | null;
            }
          } } finally { record(batch.recorded); }
        }, retainedStyles);
        audit.scanned = audit.runs.length;
        audit.total = audit.scanned + audit.skipped;
        audit.examined = examined; audit.durationMs = Math.max(0, Math.round(performance.now() - started));
        if (auditJob === job && performance.now() - lastSent > 200) {
          Object.assign(audit, inventory.snapshot());
          audit.counts = summarizeRuns(audit.runs);
          emit('audit', requestId, { audit: structuredClone(audit) }, job.epoch);
          lastSent = performance.now();
        }
        await new Promise<void>(resolve => window.setTimeout(resolve, 0));
      }
      audit.status = job.cancelled || !active ? 'cancelled' : current || truncatedText || job.changed ? 'partial' : 'complete';
      if ((current || truncatedText) && !job.cancelled) audit.reasons.push('scan-limit');
      if (!job.cancelled) {
        if (truncatedText || current && audit.runs.length >= 1000) audit.reachedLimits!.push('text-runs');
        if (current && examined >= 20000) audit.reachedLimits!.push('elements');
      }
    } catch {
      audit.status = 'partial';
      audit.reasons.push('measurement-failed');
    }
    // A scan can reach the selected element several batches after inspection.
    // CSSOM/hover paint changes need not produce a mutation or a new selection
    // event. Neither of two conflicting measurements is proven current.
    // A section scan cannot prove that text inspected outside its root vanished.
    // Common measured runs still compare even for such an outside selection.
    if (auditJob === job && active && job.epoch === epoch && !job.cancelled
      && audit.document.documentToken === documentToken && lastSnapshot
      && auditMeasurementsChanged(audit, lastSnapshot, scope !== 'selection' || !!selection && root.contains(selection))) {
      job.changed = true;
      if (audit.status === 'complete') audit.status = 'partial';
      lastSnapshot.stale = true;
      emit('stale', selectionRequest, { snapshot: lastSnapshot }, job.epoch);
    }
    if (job.changed) { audit.reasons.push('document-changed-during-scan'); audit.stale = true; }
    if (audit.runs.some(run => run.reasons.includes('measurement-complexity-limit'))) {
      audit.reachedLimits!.push('complexity');
      audit.reasons.push('measurement-complexity-limit');
      if (audit.status === 'complete') audit.status = 'partial';
    }
    Object.assign(audit, inventory.snapshot());
    audit.scanned = audit.runs.length; audit.total = audit.scanned + audit.skipped;
    audit.examined = examined; audit.durationMs = Math.max(0, Math.round(performance.now() - started));
    audit.counts = summarizeRuns(audit.runs);
    if (auditJob === job && active && job.epoch === epoch && audit.document.documentToken === documentToken) {
      auditJob = null; lastAudit = audit;
      pruneReferences();
      updateObservation();
      emit('audit', requestId, { audit }, job.epoch);
    }
  }

  function mutationsChanged(records: MutationRecord[]) {
    if (!active || !observing) return;
    if (highlighted && !highlighted.isConnected) removeOverlay();
    if (!records.some(record => {
      if (isOwnElement(record.target instanceof Element ? record.target : record.target.parentElement ?? document.documentElement)) return false;
      if (record.type !== 'childList' || !record.addedNodes.length && !record.removedNodes.length) return true;
      for (const nodes of [record.addedNodes, record.removedNodes]) for (const node of nodes) {
        if (!(node instanceof Element) || !isOwnElement(node)) return true;
      }
      return false;
    })) return;
    invalidateMeasurements();
  }

  function invalidateMeasurements(selectionChanged = true, auditChanged = true, snapshotChanged = true) {
    if (snapshotJob && snapshotChanged) { snapshotJob.changed = true; snapshotJob.styleCache = undefined; }
    if (auditJob && auditChanged) auditJob.changed = true;
    if (selection && !selection.isConnected) {
      selection = null; lastSnapshot = null; emit('removed', selectionRequest);
      pruneReferences();
    } else if (selectionChanged && lastSnapshot && !lastSnapshot.stale) {
      lastSnapshot.stale = true;
      emit('stale', selectionRequest, { snapshot: lastSnapshot });
    }
    if (auditChanged && lastAudit && !lastAudit.stale && !auditJob) {
      lastAudit.stale = true;
      emit('audit', lastAudit.id, { audit: lastAudit });
    }
    updateObservation();
  }

  const observer = new MutationObserver(mutationsChanged);
  function flushMutations() { mutationsChanged(observer.takeRecords()); }

  // Once results are stale, further page activity cannot make them more stale.
  // Stop observing altogether until an explicit measurement creates fresh data.
  function updateObservation() {
    const needed = active && Boolean(snapshotJob && !snapshotJob.cancelled && !snapshotJob.changed || auditJob && !auditJob.cancelled && !auditJob.changed
      || lastSnapshot && !lastSnapshot.stale || !auditJob && lastAudit && !lastAudit.stale);
    if (needed === observing) return;
    observing = needed;
    if (needed) {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      window.addEventListener('scroll', invalidateOnScroll, { capture: true, passive: true });
      window.addEventListener('resize', invalidateOnResize);
    } else {
      observer.disconnect();
      window.removeEventListener('scroll', invalidateOnScroll, true);
      window.removeEventListener('resize', invalidateOnResize);
    }
  }

  function invalidateOnScroll() { invalidateMeasurements(); }

  function invalidateOnResize() {
    const now = viewport();
    const sameViewport = (previous: Viewport) => previous.width === now.width && previous.height === now.height && previous.devicePixelRatio === now.devicePixelRatio;
    invalidateMeasurements(Boolean(lastSnapshot && !sameViewport(lastSnapshot.viewport)), Boolean(lastAudit && !sameViewport(lastAudit.viewport)), Boolean(snapshotJob && !sameViewport(snapshotJob.viewport)));
  }

  window.addEventListener('pagehide', () => {
    active = false; cancelSnapshot(); stopPicker(false);
    if (auditJob) auditJob.cancelled = true;
    updateObservation();
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
    const coordinatorChanged = command.type === 'hello' && command.coordinatorToken !== undefined && command.coordinatorToken !== coordinatorToken;
    if (coordinatorToken !== undefined && command.coordinatorToken !== coordinatorToken && !coordinatorChanged) return Promise.resolve({ error: 'stale-document' });
    if (command.epoch < epoch && !coordinatorChanged) return Promise.resolve({ error: 'stale-document' });
    if (!Number.isSafeInteger(command.epoch) || command.epoch < 0) return Promise.resolve({ error: 'invalid-message' });
    const reassigned = identity.tabId >= 0 && (command.windowId !== identity.windowId || command.tabId !== identity.tabId);
    if (reassigned && command.type !== 'hello') return Promise.resolve({ error: 'stale-document' });
    // A context-menu target is captured immediately before its handshake. Keep
    // only that exact new request across a window move, never across data clear.
    const capture = (reassigned && command.epoch === epoch || coordinatorChanged)
      && globals.__styleInspectorContext?.requestId === command.requestId ? globals.__styleInspectorContext : undefined;
    // Moving a tab to another window is a fresh coordinator ownership boundary.
    // Old snapshots and pending jobs must not keep emitting the former identity.
    if (reassigned || coordinatorChanged || epoch >= 0 && command.epoch > epoch) resetAnalysis();
    if (capture) globals.__styleInspectorContext = capture;
    coordinatorToken = command.coordinatorToken;
    epoch = command.epoch;
    settings = command.settings;
    identity = { windowId: command.windowId, tabId: command.tabId, frameId: 0, documentToken };
    try {
      switch (command.type) {
        case 'hello':
          flushMutations();
          if (selection && !selection.isConnected) {
            selection = null; lastSnapshot = null;
            pruneReferences();
            emit('removed', selectionRequest);
            updateObservation();
          }
          return Promise.resolve({ documentToken, selected: lastSnapshot, audit: lastAudit, picker, selectionRequest: picker ? pickerRequest : selectionRequest, auditRequest: lastAudit?.id ?? '' });
        case 'capture-context': {
          const capture = globals.__styleInspectorContext;
          delete globals.__styleInspectorContext;
          if (!capture || capture.requestId !== command.requestId || !capture.element?.isConnected) throw new Error('target-expired');
          return select(capture.element, command.requestId).then(snapshot => ({ snapshot, documentToken }), measurementError);
        }
        case 'start-picker': startPicker(command.requestId); break;
        case 'cancel-picker': stopPicker(true); break;
        case 'start-audit': {
          const scope = command.scope ?? 'page';
          if (!['page', 'viewport', 'selection'].includes(scope)) throw new Error('invalid-message');
          // Resolve before resetAnalysis discards the preceding registry. A
          // missing saved section must never silently expand to the whole page.
          const root = scope === 'selection' ? command.referenceId ? registry.get(command.referenceId) : selection : document.documentElement;
          if (!root?.isConnected) throw new Error('element-removed');
          void runAudit(command.requestId, root, scope); break;
        }
        case 'cancel-audit': if (auditJob) auditJob.cancelled = true; updateObservation(); break;
        case 'refresh-selection':
          if (!selection?.isConnected) throw new Error('element-removed');
          return select(selection, command.requestId).then(snapshot => ({ ok: true, snapshot, documentToken }), measurementError);
        case 'show-node':
        case 'select-node': {
          const element = registry.get(command.referenceId ?? '');
          if (!element) throw new Error('element-removed');
          if (command.type === 'show-node') {
            if (picker) stopPicker(true);
            flash(element, true);
          } else return select(element, command.requestId).then(snapshot => ({ ok: true, snapshot, documentToken }), measurementError);
          break;
        }
        case 'diagnose-node': {
          if (!active || picker || auditJob || snapshotJob) throw new Error('page-changed');
          const target = command.diagnosticTarget;
          if (!target || !['audit', 'selection'].includes(target.source?.kind)) throw new Error('invalid-message');
          const data = target.source.kind === 'audit' ? lastAudit : lastSnapshot;
          const element = registry.get(target.referenceId);
          if (!data || !element) throw new Error('target-expired');
          return Promise.resolve({ documentToken, report: captureDiagnostic(element, target, data) });
        }
        case 'clear-data':
          resetAnalysis();
          break;
        case 'release-analysis':
          if (auditJob || snapshotJob || picker || command.expectedSelectionRequest !== selectionRequest
            || command.expectedAuditRequest !== (lastAudit?.id ?? '')) return Promise.resolve({ released: false, documentToken });
          resetAnalysis();
          return Promise.resolve({ released: true, documentToken });
        case 'settings':
          if (!settings.livePreview) { cancelSnapshot('preview'); lastPreview = null; pruneReferences(); updateObservation(); }
          break;
        default: return Promise.resolve({ error: 'invalid-message' });
      }
      return Promise.resolve({ ok: true, documentToken });
    } catch (error) { return Promise.resolve(measurementError(error)); }
  });

  function measurementError(error: unknown) { return { error: error instanceof Error ? error.message : 'measurement-failed' }; }
}
