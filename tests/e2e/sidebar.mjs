import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, root, defaults } from './support.mjs';
import { resolveExternal } from '../../internal/scripts/package.mjs';

const host = await serve();
const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
const findings = [];
const pageErrors = [];
const artifactRoot = await resolveExternal(root, process.env.ARTIFACTS_DIR ?? path.join(root, '../Style-Inspector-Lite-artifacts'));
const en = JSON.parse(await readFile(path.join(root, '_locales/en/messages.json'), 'utf8'));
const de = JSON.parse(await readFile(path.join(root, '_locales/de/messages.json'), 'utf8'));
async function assertMeasurementEventsTextFree(page, contentPattern) {
  // Confirmed selections may contain the explicitly requested bounded excerpt.
  // Audits and hover previews retain the original text-free data boundary.
  const serialized = JSON.stringify(await page.evaluate(() => window.__events.filter(event => event.audit || event.type === 'preview')));
  assert.doesNotMatch(serialized, /"textExcerpt"\s*:/);
  assert.doesNotMatch(serialized, contentPattern);
}
try {
  const fixture = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await fixture.goto(`${host.url}/tests/fixtures/page.html`);
  await fixture.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    // Observe the actual closed root only in this fixture; production keeps it private.
    const attachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function(options) { const root = attachShadow.call(this, options); if (this.hasAttribute('data-style-inspector-overlay')) window.__overlayRoot = root; return root; };
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: (key, value = '') => en[key]?.message.replace(/\$value1\$/g, value) ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `test-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await fixture.addScriptTag({ url: `${host.url}/dist/content.js` });
  await fixture.addScriptTag({ url: `${host.url}/dist/content.js` });
  assert.equal(await fixture.evaluate(() => window.__handlers.length), 1, 'Idempotent injection');
  const hello = await fixture.evaluate(() => window.__command('hello'));
  assert.equal(hello.picker, false);
  assert.equal(hello.selected, null);
  assert.equal(hello.audit, null);
  await fixture.evaluate(() => { window.__styleInspectorContext = { requestId: 'test-capture-context', element: document.querySelector('#sample') }; return window.__command('capture-context'); });
  const selected = await fixture.evaluate(() => window.__events.filter(e => e.type === 'selected').at(-1).snapshot);
  assert.equal(selected.textRuns[0].fontSize.status, 'fail');
  assert.equal(selected.textRuns[0].contrast.status, 'fail');
  assert.equal(selected.textRuns[0].fontSizeCssPx, 11);
  await fixture.evaluate(() => window.__command('start-audit'));
  await fixture.waitForFunction(() => window.__events.some(e => e.audit?.status === 'complete'));
  const audit = await fixture.evaluate(() => window.__events.filter(e => e.audit?.status === 'complete').at(-1).audit);
  assert.ok(audit.counts.contrast.fail > 0 && audit.counts.fontSize.fail > 0);
  assert.equal(audit.counts.checks, audit.runs.length * 2);
  assert.ok(audit.runs.some(run => run.contrast.status === 'manual' && run.fontSize.status === 'fail'), 'Gradient remains manual while small size is assessed');
  assert.ok(!JSON.stringify({ selected, audit }).includes('PRIVATE_INPUT_SENTINEL'));
  findings.push({ check: 'actual DOM measurement, separate counters, privacy, idempotent injection', runs: audit.runs.length, contrastFailures: audit.counts.contrast.fail, smallText: audit.counts.fontSize.fail });
  const sampleRun = audit.runs.find(run => run.fontSizeCssPx === 11 && run.contrast.status === 'fail');
  assert.ok(sampleRun, 'Fixture problem has a live audit reference');
  const originalStyle = await fixture.locator('#sample').getAttribute('style');
  for (let i = 0; i < 2; i++) {
    const result = await fixture.evaluate(referenceId => window.__command('show-node', { referenceId }), sampleRun.elementRef);
    assert.equal(result.ok, true, 'Repeated show succeeds');
    await fixture.waitForTimeout(1100);
    assert.equal(await fixture.locator('[data-style-inspector-overlay]').count(), 1, 'Explicit highlights last longer than the old one-second flash');
    const mark = await fixture.evaluate(() => {
      const [outline, label] = window.__overlayRoot.children;
      const bounds = label.getBoundingClientRect();
      return { label: label.textContent, visible: !label.hidden, width: outline.getBoundingClientRect().width, border: getComputedStyle(outline).borderTopWidth, pointerEvents: getComputedStyle(outline).pointerEvents,
        labelInView: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight };
    });
    assert.ok(mark.label.includes(sampleRun.selector)); assert.ok(mark.visible && mark.labelInView && mark.width > 0);
    assert.equal(mark.border, '3px'); assert.equal(mark.pointerEvents, 'none');
    assert.equal(await fixture.locator('#sample').getAttribute('style'), originalStyle, 'Highlight does not modify target styles');
    assert.equal((await fixture.evaluate(() => window.__command('hello'))).audit.stale, false, 'Overlay insertion/removal does not stale the audit');
  }
  await fixture.keyboard.press('Escape');
  assert.equal(await fixture.locator('[data-style-inspector-overlay]').count(), 0, 'Escape dismisses the page highlight');
  await fixture.evaluate(referenceId => window.__command('select-node', { referenceId }), sampleRun.elementRef);
  await fixture.evaluate(() => { document.querySelector('#sample').style.color = '#111'; document.querySelector('#sample').style.fontSize = '16px'; });
  await fixture.waitForFunction(() => window.__events.some(e => e.audit?.stale));
  assert.equal((await fixture.evaluate(referenceId => window.__command('show-node', { referenceId }), sampleRun.elementRef)).ok, true, 'Stale measurement retains live target');
  await fixture.evaluate(() => window.__command('start-audit', { requestId: 'fresh-rescan' }));
  await fixture.waitForFunction(() => window.__events.some(e => e.requestId === 'fresh-rescan' && e.audit?.status === 'complete'));
  const fresh = await fixture.evaluate(() => window.__command('hello'));
  assert.equal(fresh.selected, null); assert.equal(fresh.picker, false); assert.equal(fresh.audit.stale, false);
  const changedRun = fresh.audit.runs.find(run => run.selector === sampleRun.selector);
  assert.equal(changedRun.contrast.status, 'pass'); assert.equal(changedRun.fontSize.status, 'pass');
  assert.equal(changedRun.elementRef, sampleRun.elementRef, 'A manual rescan preserves the same live DOM element identity');
  assert.equal(changedRun.id, sampleRun.id, 'The actual surviving Text node keeps its comparison identity');
  assert.equal((await fixture.evaluate(referenceId => window.__command('select-node', { referenceId }), sampleRun.elementRef)).ok, true);
  const reselectedSample = (await fixture.evaluate(() => window.__command('hello'))).selected;
  assert.equal(reselectedSample.elementRef, changedRun.elementRef);
  assert.equal(reselectedSample.textExcerpt.value, await fixture.locator('#sample').textContent(), 'The retained reference selects the current DOM element');
  assert.equal(reselectedSample.textRuns[0].fontSizeCssPx, 16);
  assert.equal(reselectedSample.textRuns[0].contrast.status, 'pass', 'Reselection reads the updated paint instead of a former snapshot');
  findings.push({ check: 'repeated show/inspect, overlay immunity, real mutation stale, fresh rescan resets selection and remeasures changed styles', passed: true });
  // A real browser event chain must be suppressed during picking and work again afterward.
  await fixture.evaluate(() => window.__command('start-picker'));
  await fixture.locator('#event-button').click();
  assert.deepEqual(await fixture.evaluate(() => window.fixtureEvents), { pointerdown: 0, mousedown: 0, click: 0, submit: 0 });
  await fixture.waitForFunction(() => !document.querySelector('[data-style-inspector-overlay]'));
  await fixture.locator('#event-button').click();
  assert.deepEqual(await fixture.evaluate(() => window.fixtureEvents), { pointerdown: 1, mousedown: 1, click: 1, submit: 0 });
  await fixture.evaluate(() => window.__command('start-picker', { settings: { ...window.__unused, schemaVersion: 1, appearance: 'system', colorFormat: 'hex', contrastTarget: 'AA', livePreview: false, contextMenuEnabled: true } }));
  const previews = await fixture.evaluate(() => window.__events.filter(e => e.type === 'preview').length);
  await fixture.locator('#good').hover();
  await fixture.waitForTimeout(100);
  assert.equal(await fixture.evaluate(() => window.__events.filter(e => e.type === 'preview').length), previews);
  await fixture.keyboard.press('Escape');
  assert.equal(await fixture.locator('[data-style-inspector-overlay]').count(), 0);
  findings.push({ check: 'picker pointer/mouse/click suppression, normal click restoration, preview off, Escape cleanup', passed: true });
  // A button inside a nested scroll container stays associated with its marker.
  const nestedRef = await fixture.evaluate(async () => {
    const scroller = document.createElement('div'); scroller.id = 'highlight-scroller';
    scroller.style.cssText = 'height:240px;overflow:auto;border:1px solid #222;margin:20px;';
    const inner = document.createElement('div'); inner.style.cssText = 'height:1000px;padding-top:400px;';
    const button = document.createElement('button'); button.id = 'highlight-target'; button.textContent = 'Nested scroll target';
    inner.append(button); scroller.append(inner); document.body.append(scroller);
    window.__styleInspectorContext = { requestId: 'test-capture-context', element: button };
    await window.__command('capture-context');
    return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.elementRef;
  });
  assert.equal((await fixture.evaluate(referenceId => window.__command('show-node', { referenceId }), nestedRef)).ok, true);
  const followsTarget = () => fixture.evaluate(() => {
    const target = document.querySelector('#highlight-target').getBoundingClientRect(), outline = window.__overlayRoot.firstElementChild.getBoundingClientRect();
    return Math.abs(target.top - outline.top) < 1 && Math.abs(target.left - outline.left) < 1 && Math.abs(target.width - outline.width) < 1;
  });
  assert.equal(await followsTarget(), true);
  await fixture.locator('#highlight-scroller').evaluate(node => { node.scrollTop += 35; });
  await fixture.waitForFunction(() => Math.abs(document.querySelector('#highlight-target').getBoundingClientRect().top - window.__overlayRoot.firstElementChild.getBoundingClientRect().top) < 1);
  assert.equal(await followsTarget(), true);
  await fixture.setViewportSize({ width: 900, height: 750 });
  await fixture.waitForFunction(() => Math.abs(document.querySelector('#highlight-target').getBoundingClientRect().left - window.__overlayRoot.firstElementChild.getBoundingClientRect().left) < 1);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await fixture.screenshot({ path: path.join(root, 'test-results/show-on-page.png') });
  await fixture.keyboard.press('Escape');
  assert.equal(await fixture.locator('[data-style-inspector-overlay]').count(), 0);
  findings.push({ check: 'labeled page highlight, visible duration, unchanged target CSS, nested scroll/resize tracking and Escape dismissal', passed: true });
  const inventoryPage = await browser.newPage({ viewport: { width: 1000, height: 1100 } });
  await inventoryPage.goto(`${host.url}/tests/fixtures/style-inventory.html`);
  await inventoryPage.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `inventory-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await inventoryPage.addScriptTag({ url: `${host.url}/dist/content.js` });
  const scanInventory = async requestId => {
    await inventoryPage.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await inventoryPage.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await inventoryPage.evaluate(() => window.__command('hello'))).audit;
  };
  const initialInventory = await scanInventory('inventory-first');
  const inventoryIds = ['body-a', 'split', 'caption-a', 'caption-b', 'heading-small', 'heading-large', 'link', 'button', 'nested-button', 'glyph', 'alpha'];
  const inventorySelections = await inventoryPage.evaluate(async ids => {
    const result = {};
    for (const id of ids) {
      window.__styleInspectorContext = { requestId: 'inventory-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      result[id] = window.__events.filter(event => event.type === 'selected').at(-1).snapshot;
    }
    return result;
  }, inventoryIds);
  assert.equal(new Set(initialInventory.runs.map(run => run.elementRef)).size, 11);
  assert.equal(initialInventory.runs.length, 12, 'Two direct text fragments in one element remain two measured runs');
  assert.equal(inventorySelections.split.textRuns.length, 2);
  for (const selection of Object.values(inventorySelections)) for (const run of selection.textRuns) {
    const audited = initialInventory.runs.find(item => item.id === run.id);
    assert.ok(audited, 'An independently inspected fixture element was actually collected');
    assert.deepEqual(audited.foreground, run.foreground);
    assert.deepEqual(audited.effectiveBackground, run.effectiveBackground);
  }
  const byRGBA = (audit, r, g, b, a = 1) => audit.paletteUsage.find(entry => entry.color.rgba?.r === r && entry.color.rgba?.g === g && entry.color.rgba?.b === b && entry.color.rgba?.a === a);
  assert.equal(byRGBA(initialInventory, 102, 102, 102).count, 2, 'Repeated caption elements each count once');
  assert.deepEqual(byRGBA(initialInventory, 102, 102, 102).roles, { text: 2 });
  assert.equal(byRGBA(initialInventory, 153, 0, 0).count, 1, 'Inventory includes actual painted glyph color');
  assert.equal(byRGBA(initialInventory, 0, 0, 0).count, 3, 'Two text fragments do not inflate black usage; the separate CSS fallback is retained once');
  assert.deepEqual(byRGBA(initialInventory, 0, 102, 204).roles, { accent: 2, background: 1 }, 'Links and nested button labels retain meaningful roles without duplicating matching backgrounds');
  assert.equal(byRGBA(initialInventory, 240, 240, 240).roles.background, 3, 'Ancestor surfaces are counted for the three measured text elements');
  assert.ok(byRGBA(initialInventory, 255, 255, 255).roles.background > 0, 'The resolved browser canvas is represented as a background');
  assert.ok(initialInventory.palette.some(color => color.rgba?.a === 0), 'Legacy raw palette retains its transparent CSS values');
  assert.ok(!initialInventory.palette.some(color => color.rgba?.r === 153 && color.rgba?.g === 0 && color.rgba?.b === 0), 'Additional measured glyph colors do not rewrite legacy token exports');
  const arial = initialInventory.fontUsage.find(font => font.family === 'Arial, sans-serif');
  const georgia = initialInventory.fontUsage.find(font => font.family === 'Georgia, serif');
  assert.equal(arial.count, 9); assert.equal(georgia.count, 2);
  const sizeCounts = font => [...font.sizes].sort((a, b) => a.sizeCssPx - b.sizeCssPx).map(({ sizeCssPx, count }) => ({ sizeCssPx, count }));
  assert.deepEqual(sizeCounts(arial), [{ sizeCssPx: 12, count: 2 }, { sizeCssPx: 14, count: 1 }, { sizeCssPx: 16, count: 6 }]);
  assert.deepEqual(sizeCounts(georgia), [{ sizeCssPx: 24, count: 1 }, { sizeCssPx: 32, count: 1 }]);
  assert.deepEqual([...arial.variants].sort((a, b) => a.sizeCssPx - b.sizeCssPx).map(({ sizeCssPx, fontWeight, lineHeight, count }) => ({ sizeCssPx, fontWeight, lineHeight, count })), [
    { sizeCssPx: 12, fontWeight: 400, lineHeight: '18px', count: 2 },
    { sizeCssPx: 14, fontWeight: 400, lineHeight: '21px', count: 1 },
    { sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 6 },
  ]);
  const byReference = ref => initialInventory.runs.filter(run => run.elementRef === ref);
  for (const entry of initialInventory.paletteUsage) {
    assert.equal(new Set(entry.elementRefs).size, entry.count, 'Color associations count each measured element once');
    assert.ok(entry.elementRefs.every(ref => byReference(ref).length > 0), 'Color references belong to this audit');
  }
  for (const font of initialInventory.fontUsage) {
    assert.equal(new Set(font.elementRefs).size, font.count);
    assert.ok(font.elementRefs.every(ref => byReference(ref).some(run => run.fontFamily === font.family)));
    for (const variant of font.variants) {
      assert.equal(new Set(variant.elementRefs).size, variant.count);
      assert.ok(variant.elementRefs.every(ref => byReference(ref).some(run => run.fontFamily === font.family && run.fontSizeCssPx === variant.sizeCssPx && run.fontWeight === variant.fontWeight && run.lineHeight === variant.lineHeight)), 'Variant associations preserve the measured family, size, weight and line height together');
    }
  }
  assert.equal(initialInventory.fontUsage.reduce((sum, font) => sum + font.count, 0), 11, 'Font frequency counts elements rather than text fragments');
  await inventoryPage.evaluate(() => {
    document.getElementById('caption-b').remove();
    document.getElementById('split').style.fontSize = '18px';
  });
  const rescannedInventory = await scanInventory('inventory-rescan');
  assert.equal(byRGBA(rescannedInventory, 102, 102, 102).count, 1);
  assert.equal(rescannedInventory.fontUsage.find(font => font.family === 'Arial, sans-serif').count, 8);
  assert.equal(rescannedInventory.fontUsage.find(font => font.family === 'Arial, sans-serif').sizes.some(size => size.sizeCssPx === 14), false);
  assert.equal(rescannedInventory.fontUsage.find(font => font.family === 'Arial, sans-serif').sizes.find(size => size.sizeCssPx === 18).count, 1);
  const resetInventory = await inventoryPage.evaluate(() => window.__events.find(event => event.requestId === 'inventory-rescan' && event.audit?.status === 'running').audit);
  assert.deepEqual(resetInventory.paletteUsage, []); assert.deepEqual(resetInventory.fontUsage, []);
  assert.equal(initialInventory.fontUsage.find(font => font.family === 'Arial, sans-serif').count, 9, 'Published metadata snapshots stay detached from later scans');
  await assertMeasurementEventsTextFree(inventoryPage, /Inventory plain text|First fragment|Inventory nested label/);
  assert.ok(rescannedInventory.palette.length <= 128 && rescannedInventory.paletteUsage.length <= 128 && rescannedInventory.fonts.length <= 64 && rescannedInventory.fontUsage.length <= 64);
  findings.push({ check: 'style inventories count unique measured text elements, preserve actual glyph and inherited/canvas backgrounds, classify nested interactive controls, list font sizes and fully replace counts on rescan without changing raw tokens or leaking text', passed: true });
  await inventoryPage.close();
  const freshness = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await freshness.goto(`${host.url}/tests/fixtures/audit-freshness.html`);
  await freshness.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `freshness-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await freshness.addScriptTag({ url: `${host.url}/dist/content.js` });
  await freshness.evaluate(() => window.__command('hello'));
  const scanFreshness = async requestId => {
    await freshness.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await freshness.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await freshness.evaluate(() => window.__command('hello'))).audit;
  };
  const freshnessAudit = await scanFreshness('freshness-initial');
  assert.equal(freshnessAudit.stale, false);
  assert.deepEqual(freshnessAudit.counts.contrast, { pass: 1, fail: 0, manual: 1, notApplicable: 0, assessed: 2 });
  const coveredRun = freshnessAudit.runs.find(run => run.contrast.status === 'manual');
  const stableRun = freshnessAudit.runs.find(run => run.contrast.status === 'pass');
  assert.equal(coveredRun.contrast.ratio, null);
  assert.ok(coveredRun.reasons.includes('overlapping-element'), 'The initial audit uncertainty must come from actual overlapping paint');
  const inspectFreshness = (referenceId, target = 'AA') => freshness.evaluate(async ({ referenceId, target, defaults }) => {
    const result = await window.__command('select-node', { referenceId, settings: { ...defaults, contrastTarget: target } });
    if (!result.ok) throw new Error(`Fresh inspection failed: ${result.error}`);
    return window.__events.filter(event => event.type === 'selected').at(-1).snapshot;
  }, { referenceId, target, defaults });
  const freshnessEvents = () => freshness.evaluate(() => window.__events);
  const freshnessStarts = () => freshness.evaluate(() => window.__events.filter(event => event.audit?.status === 'running' && event.audit.scanned === 0).length);
  const assertHistoricalAudit = async (previous, starts, stale = true) => {
    const state = await freshness.evaluate(() => window.__command('hello'));
    assert.deepEqual(state.audit, { ...previous, stale }, 'Rows, counts, fonts, palette and timestamp remain the original snapshot');
    assert.equal(await freshnessStarts(), starts, 'No automatic full audit starts');
    return state;
  };
  assert.equal((await inspectFreshness(coveredRun.elementRef)).textRuns[0].contrast.status, 'manual');
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.stale, false, 'Unchanged uncertain inspection keeps the audit fresh');
  assert.equal((await inspectFreshness(stableRun.elementRef)).textRuns[0].contrast.status, 'pass');
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.stale, false, 'Unchanged measured inspection keeps the audit fresh');
  const aaaSelection = await inspectFreshness(stableRun.elementRef, 'AAA');
  assert.equal(aaaSelection.textRuns[0].contrast.target, 'AAA');
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.stale, false, 'A target-only reassessment changes no measured page data');
  await freshness.evaluate(() => {
    // CSSOM rule edits do not generate MutationObserver records. Keep the DOM
    // untouched so this exercises evidence discovered by explicit measurement.
    document.getElementById('dynamic-rules').sheet.cssRules[1].style.display = 'block';
  });
  await freshness.evaluate(async () => {
    window.__styleInspectorContext = { requestId: 'freshness-capture-context', element: document.getElementById('unrelated') };
    await window.__command('capture-context');
  });
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.stale, false, 'Inspecting a newly rendered unrelated element does not alter existing audit evidence');
  await freshness.evaluate(() => { document.getElementById('dynamic-rules').sheet.cssRules[0].style.display = 'none'; });
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.stale, false, 'The CSSOM-only paint change must reach no DOM-mutation invalidation path');
  assert.equal((await freshness.evaluate(() => window.__command('start-picker'))).ok, true);
  await freshness.locator('#covered').hover();
  await freshness.waitForFunction(() => window.__events.some(event => event.type === 'preview' && event.snapshot?.textRuns.some(run => run.contrast.status === 'pass')));
  await freshness.evaluate(() => window.__command('cancel-picker'));
  assert.equal(await freshnessStarts(), 1, 'Unchanged, target-only and unrelated inspections, plus a conflicting picker preview, start no new audit');
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).audit.measuredAt, freshnessAudit.measuredAt);
  await freshness.evaluate(() => {
    // A newly rendered element, its different color and a changed shared font
    // must all appear in the follow-up: replacing only the inspected row would
    // preserve the wrong totals and page inventories.
    document.styleSheets[0].cssRules[2].style.fontFamily = 'Georgia, serif';
    document.getElementById('dynamic-rules').sheet.cssRules[1].style.color = '#00FF00';
  });
  const freshCovered = (await inspectFreshness(coveredRun.elementRef)).textRuns.find(run => run.id === coveredRun.id);
  assert.equal(freshCovered.contrast.status, 'pass');
  assert.ok(Math.abs(freshCovered.contrast.ratio - 13.569124702898852) < 1e-12);
  const historicalState = await assertHistoricalAudit(freshnessAudit, 1);
  assert.equal(historicalState.selected.elementRef, coveredRun.elementRef);
  assert.equal(historicalState.selectionRequest, 'freshness-select-node');
  assert.equal(historicalState.auditRequest, freshnessAudit.id);
  await inspectFreshness(coveredRun.elementRef);
  await inspectFreshness(stableRun.elementRef, 'AAA');
  await freshness.evaluate(() => window.__command('refresh-selection'));
  await freshness.waitForTimeout(250);
  await assertHistoricalAudit(freshnessAudit, 1);

  const refreshedAudit = await scanFreshness('freshness-user-rescan');
  assert.equal(refreshedAudit.stale, false);
  assert.deepEqual(refreshedAudit.counts.contrast, { pass: 3, fail: 0, manual: 0, notApplicable: 0, assessed: 3 });
  assert.deepEqual(refreshedAudit.fonts, ['Georgia, serif']);
  assert.ok(!freshnessAudit.fonts.includes(refreshedAudit.fonts[0]), 'The user-requested scan replaces the font inventory');
  assert.ok(refreshedAudit.palette.some(color => color.rgba?.r === 0 && color.rgba.g === 255 && color.rgba.b === 0));
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).selected, null);
  const currentCovered = refreshedAudit.runs.find(run => run.selector === coveredRun.selector);
  assert.ok(currentCovered);
  assert.equal(currentCovered.id, coveredRun.id, 'An explicit rescan preserves the actual Text identity for comparison');
  assert.equal((await freshness.evaluate(referenceId => window.__command('select-node', { referenceId }), coveredRun.elementRef)).ok, true, 'Remeasured DOM references remain selectable');
  const reselectedCovered = (await freshness.evaluate(() => window.__command('hello'))).selected;
  assert.equal(reselectedCovered.textRuns[0].id, currentCovered.id);
  assert.equal(reselectedCovered.textRuns[0].contrast.ratio, currentCovered.contrast.ratio, 'The retained reference measures the current element paint');
  await inspectFreshness(currentCovered.elementRef);
  await freshness.evaluate(() => { document.getElementById('dynamic-rules').sheet.insertRule('#covered { color: #232F3E; }', 2); });
  assert.equal((await inspectFreshness(currentCovered.elementRef)).textRuns[0].contrast.status, 'fail');
  await assertHistoricalAudit(refreshedAudit, 2);

  await freshness.locator('#covered').evaluate(node => { node.style.color = '#FFFFFF'; });
  await freshness.waitForFunction(() => window.__events.some(event => event.type === 'stale'));
  await freshness.evaluate(() => window.__command('refresh-selection'));
  const recoveredSelection = (await freshness.evaluate(() => window.__command('hello'))).selected;
  assert.equal(recoveredSelection.textRuns[0].contrast.status, 'pass');
  assert.equal(recoveredSelection.stale, false);
  await assertHistoricalAudit(refreshedAudit, 2);

  const burstAudit = await scanFreshness('freshness-before-mutation-burst');
  const burstCovered = burstAudit.runs.find(run => run.selector === coveredRun.selector);
  const burstSelection = await inspectFreshness(burstCovered.elementRef);
  const burstOffset = (await freshnessEvents()).length;
  // Repeated mutation deliveries and viewport changes used to schedule new
  // measurements. These real browser events must only mark the snapshot stale.
  await freshness.evaluate(async () => {
    const target = document.getElementById('covered');
    target.style.color = '#232F3E';
    for (let batch = 0; batch < 40; batch++) {
      for (let index = 0; index < 100; index++) target.dataset.testMutation = String(batch * 100 + index);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  });
  await freshness.setViewportSize({ width: 980, height: 850 });
  await freshness.evaluate(() => window.dispatchEvent(new Event('scroll')));
  await freshness.waitForTimeout(350);
  const burstState = await assertHistoricalAudit(burstAudit, 3);
  assert.deepEqual(burstState.selected, { ...burstSelection, stale: true }, 'Mutations, scrolling, resize and hello keep the previous selected measurement');
  const burstEvents = (await freshnessEvents()).slice(burstOffset);
  assert.equal(burstEvents.filter(event => event.type === 'selected').length, 0, 'The selected element is never automatically remeasured');
  assert.equal(burstEvents.filter(event => event.audit).length, 1, 'The audit publishes one stale notice and then stays idle across 4,000 mutations');
  assert.equal(burstEvents.filter(event => event.type === 'stale').length, 1, 'The selection publishes one stale notice and then stays idle');
  await freshness.evaluate(() => window.__command('refresh-selection'));
  const explicitRefresh = (await freshness.evaluate(() => window.__command('hello'))).selected;
  assert.equal(explicitRefresh.stale, false);
  assert.equal(explicitRefresh.textRuns[0].contrast.status, 'fail');
  assert.ok(Date.parse(explicitRefresh.measuredAt) > Date.parse(burstSelection.measuredAt));
  await assertHistoricalAudit(burstAudit, 3);
  await freshness.evaluate(() => { document.getElementById('covered').style.color = '#FFFFFF'; });
  await freshness.waitForFunction(measuredAt => window.__events.some(event => event.type === 'stale' && event.snapshot?.measuredAt === measuredAt), explicitRefresh.measuredAt);
  assert.equal((await freshness.evaluate(() => window.__command('hello'))).selected.textRuns[0].contrast.status, 'fail', 'Monitoring rearms after explicit refresh without automatically measuring the next change');

  const finalAudit = await scanFreshness('freshness-final-user-scan');
  const finalState = await freshness.evaluate(() => window.__command('hello'));
  assert.equal(finalAudit.stale, false);
  assert.deepEqual(finalAudit.counts.contrast, { pass: 3, fail: 0, manual: 0, notApplicable: 0, assessed: 3 });
  assert.equal(finalState.selected, null);
  assert.equal(finalState.selectionRequest, '');
  assert.equal(finalState.auditRequest, finalAudit.id);
  await assertMeasurementEventsTextFree(freshness, /Covered navigation link|Stable navigation link|Unrelated fresh selection/);
  await freshness.close();
  findings.push({ check: 'Explicit inspection and selection refresh never rescan the page; contradictory measurements mark historical audit data stale, 4,000 DOM mutations plus resize/scroll produce only one stale notice per snapshot, cached hello never remeasures, and only explicit scans replace counts, palette and fonts while preserving surviving Text identities', passed: true });
  const visibility = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await visibility.goto(`${host.url}/tests/fixtures/text-visibility.html`);
  await visibility.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `visibility-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await visibility.addScriptTag({ url: `${host.url}/dist/content.js` });
  await visibility.evaluate(() => window.__command('hello'));
  assert.ok(await visibility.locator('#modern').evaluate(node => { const r = document.createRange(); r.selectNodeContents(node); return [...r.getClientRects()].some(rect => rect.width > 0 && rect.height > 0); }), 'Clipped text still has positive layout boxes: original false-positive trigger');
  assert.ok(await visibility.locator('#offscreen').evaluate(node => node.getBoundingClientRect().top > innerHeight));
  for (const { id, expected } of await visibility.locator('label').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.expected })))) {
    const runs = await visibility.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'visibility-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
    }, id);
    assert.equal(runs.length, expected === 'hidden' ? 0 : 1, id);
  }
  const scanVisibility = async requestId => {
    await visibility.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await visibility.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return visibility.evaluate(() => window.__command('hello'));
  };
  const hiddenAudit = (await scanVisibility('clipped-audit')).audit;
  assert.equal(hiddenAudit.scanned, 7, 'Six visible labels and one shown placeholder');
  assert.equal(hiddenAudit.runs.filter(run => run.tagName === 'label').length, 6);
  assert.equal(hiddenAudit.counts.contrast.fail, 0, 'Invisible black labels do not become contrast failures');
  await visibility.locator('#modern').evaluate(node => { node.className = ''; node.style.color = '#0A0A0A'; });
  const revealedAudit = (await scanVisibility('revealed-audit')).audit;
  assert.equal(revealedAudit.scanned, 8);
  assert.equal(revealedAudit.counts.contrast.fail, 1, 'Revealed black text is assessed again after a rescan');
  await visibility.close();
  findings.push({ check: 'fully clipped labels and ancestors excluded; partial clipping, small boxes, offscreen text and revealed labels retained', passed: true });
  const placeholders = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await placeholders.goto(`${host.url}/tests/fixtures/placeholder-contrast.html`);
  await placeholders.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `placeholder-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input')) {
      for (const property of ['value', 'placeholder']) Object.defineProperty(input, property, { get() { throw new Error('Input text must not be read'); } });
      const get = input.getAttribute.bind(input);
      input.getAttribute = name => { if (/^(value|placeholder)$/i.test(name)) throw new Error('Input attributes must not be read'); return get(name); };
    }
  }, { defaults, en });
  await placeholders.addScriptTag({ url: `${host.url}/dist/content.js` });
  await placeholders.evaluate(() => window.__command('hello'));
  const captureText = id => placeholders.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'placeholder-capture-context', element: document.getElementById(id) };
    await window.__command('capture-context');
    return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns[0];
  }, id);
  const placeholder = await captureText('placeholder');
  assert.equal(placeholder.textSource, 'placeholder'); assert.equal(placeholder.contrast.status, 'pass');
  assert.deepEqual(placeholder.foreground.rgba, { r: 170, g: 170, b: 170, a: 1 });
  assert.deepEqual(placeholder.effectiveBackground, { r: 18, g: 18, b: 18, a: 1 });
  const translucent = await captureText('translucent');
  assert.equal(translucent.textSource, 'placeholder'); assert.equal(translucent.foreground.rgba.a, .54);
  assert.equal(translucent.fontSizeCssPx, 24); assert.equal(translucent.fontWeight, 700);
  const linear = channel => { const s = channel / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; };
  const expectedRatio = (linear(255 * .54 + 18 * .46) + .05) / (linear(18) + .05);
  assert.ok(Math.abs(translucent.contrast.ratio - expectedRatio) < 1e-8, 'Placeholder opacity is composed once against the real background');
  assert.equal(translucent.contrast.category, 'large');
  const nativePlaceholder = await captureText('native');
  assert.equal(nativePlaceholder.textSource, 'placeholder');
  assert.ok(nativePlaceholder.contrast.ratio !== null, 'Native browser placeholder colors are supported');
  assert.equal(await captureText('empty'), undefined, 'An exactly empty shown placeholder contributes no text run');
  const populated = await captureText('populated');
  assert.equal(populated.textSource, undefined); assert.equal(populated.contrast.status, 'manual');
  assert.ok(populated.reasons.includes('control-text-availability-unknown'));
  const gradientPlaceholder = await captureText('gradient');
  assert.equal(gradientPlaceholder.contrast.status, 'pass', 'An opaque placeholder on a supported gradient can meet AA conservatively');
  assert.equal(gradientPlaceholder.contrast.ratioKind, 'minimum');
  for (const [id, reason] of [['group', 'group-opacity'], ['painted-text', 'pseudo-element'], ['border-text', 'pseudo-element']]) {
    const run = await captureText(id); assert.equal(run.contrast.status, 'manual', id); assert.ok(run.reasons.includes(reason), id);
  }
  assert.equal((await captureText('disabled')).contrast.status, 'not-applicable');
  const button = await captureText('button-text');
  assert.equal(button.contrast.status, 'pass'); assert.ok(!button.reasons.includes('pseudo-element'), 'Invisible masthead decoration does not block ordinary button text');
  assert.doesNotMatch(JSON.stringify(await placeholders.evaluate(() => window.__events)), /PRIVATE_.*_SENTINEL/);
  await placeholders.close();
  findings.push({ check: 'shown placeholder color/opacity/font measured without reading input text; invisible decoration ignored; painted pseudo-elements and uncertain controls remain unassessed', passed: true });
  const overlaps = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await overlaps.goto(`${host.url}/tests/fixtures/text-overlap.html`);
  await overlaps.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `overlap-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input')) {
      for (const property of ['value', 'placeholder']) Object.defineProperty(input, property, { get() { throw new Error('Input text must not be read'); } });
    }
  }, { defaults, en });
  await overlaps.addScriptTag({ url: `${host.url}/dist/content.js` });
  await overlaps.evaluate(() => window.__command('hello'));
  assert.equal(await overlaps.evaluate(() => {
    const country = document.getElementById('country'), box = country.getBoundingClientRect(), logo = document.getElementById('logo-paint').getBoundingClientRect();
    return document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2).indexOf(document.getElementById('logo-wrap')) < document.elementsFromPoint(box.x + box.width / 2, box.y + box.height / 2).indexOf(country)
      && logo.right < box.left && box.height === 44;
  }), true, 'The logo hit box covers DE while the clipped SVG paint ends before it');
  for (const { id, expected } of await overlaps.locator('[data-overlap]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.overlap.split(',') })))) {
    const runs = await overlaps.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'overlap-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
    }, id);
    assert.deepEqual(runs.map(run => run.contrast.status), expected, `${id}: only actual text coverage introduces uncertainty`);
    if (id === 'country') {
      assert.ok(Math.abs(runs[0].contrast.ratio - 8.251239820985964) < 1e-8, 'DE has AA and AAA contrast on its dark background');
      assert.equal(runs[0].fontSize.status, 'fail', 'The separate 10px readability hint is retained');
    }
    if (id === 'many-lines') assert.ok(runs[0].reasons.includes('overlap-sampling-limit'), 'More than 32 text fragments remains unassessed');
    else for (const run of runs.filter(run => run.contrast.status === 'manual')) assert.ok(run.reasons.includes('overlapping-element'), id);
    if (id.startsWith('placeholder')) assert.equal(runs[0].textSource, 'placeholder', 'Controls retain their box sample without reading input text');
  }
  const scanOverlap = async requestId => {
    await overlaps.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await overlaps.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await overlaps.evaluate(() => window.__command('hello'))).audit;
  };
  const coveredAudit = await scanOverlap('overlap-initial');
  assert.equal(coveredAudit.scanned, 12);
  assert.deepEqual(coveredAudit.counts.contrast, { pass: 4, fail: 0, manual: 8, notApplicable: 0, assessed: 12 });
  await overlaps.locator('#solid-overlay').evaluate(node => node.remove());
  const uncoveredAudit = await scanOverlap('overlap-uncovered');
  assert.deepEqual(uncoveredAudit.counts.contrast, { pass: 5, fail: 0, manual: 7, notApplicable: 0, assessed: 12 }, 'Removing actual paint restores a measured contrast on rescan');
  assert.doesNotMatch(JSON.stringify(await overlaps.evaluate(() => window.__events)), /PRIVATE_.*_PLACEHOLDER/);
  await overlaps.close();
  findings.push({ check: 'transparent logo padding and tall boxes do not obscure text; painted SVG/pseudo/shadow overlays, later fragments and geometry limits remain unassessed; per-run sampling and controls preserved', passed: true });
  const gradients = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await gradients.goto(`${host.url}/tests/fixtures/gradient-contrast.html`);
  await gradients.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `gradient-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await gradients.addScriptTag({ url: `${host.url}/dist/content.js` });
  await gradients.evaluate(() => window.__command('hello'));
  const captureGradient = id => gradients.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'gradient-capture-context', element: document.getElementById(id) };
    await window.__command('capture-context');
    return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns[0];
  }, id);
  for (const { id, expected } of await gradients.locator('[data-contrast]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.contrast })))) {
    const run = await captureGradient(id);
    assert.equal(run.contrast.status, expected, `${id}: supported gradients use a conservative bound; unsupported paint stays unassessed`);
    assert.equal(run.fontSize.status, 'pass', `${id}: contrast uncertainty does not block the independent font-size check`);
    if (expected === 'pass' && id !== 'solid') {
      assert.equal(run.contrast.ratioKind, 'minimum', id);
      assert.ok(run.contrast.ratio >= 7.94, `${id}: the lower bound meets AA and AAA`);
      assert.equal(run.contrast.AA.status, 'pass', id); assert.equal(run.contrast.AAA.status, 'pass', id);
      assert.ok(run.backgroundRange, id); assert.equal(run.effectiveBackground, null, 'A gradient is never presented as one measured solid color');
    }
    if (id === 'solid') {
      assert.notEqual(run.contrast.ratioKind, 'minimum', 'Solid-color contrast retains its exact measurement');
      assert.deepEqual(run.effectiveBackground, { r: 255, g: 255, b: 255, a: 1 });
    }
    if (id === 'crossing') {
      assert.equal(run.contrast.ratioKind, 'minimum'); assert.equal(run.contrast.ratio, 1);
      assert.equal(run.contrast.AA.status, 'manual'); assert.equal(run.contrast.AAA.status, 'manual');
    }
    if (expected === 'manual' && id !== 'crossing') assert.equal(run.contrast.ratio, null, `${id}: unsupported composition has no invented ratio`);
  }
  const scanGradient = async requestId => {
    await gradients.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await gradients.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await gradients.evaluate(() => window.__command('hello'))).audit;
  };
  const initialGradientAudit = await scanGradient('gradient-initial');
  assert.equal(initialGradientAudit.scanned, 12);
  assert.deepEqual(initialGradientAudit.counts.contrast, { pass: 5, fail: 0, manual: 7, notApplicable: 0, assessed: 12 });
  await gradients.locator('#dynamic-background').evaluate(node => { node.style.backgroundImage = 'linear-gradient(to right, #000, #FFF)'; });
  const changedGradientAudit = await scanGradient('gradient-changed');
  assert.deepEqual(changedGradientAudit.counts.contrast, { pass: 4, fail: 0, manual: 8, notApplicable: 0, assessed: 12 }, 'A lower bound below the target becomes uncertain, never a fabricated contrast failure');
  assert.equal((await captureGradient('dynamic')).contrast.ratio, 1);
  await gradients.close();
  findings.push({ check: 'supported near-white, hard-stop and nested translucent gradients yield labeled AA/AAA minimum ratios; intermediate color matches, unsupported paint and effects stay unassessed; rescan refreshes bounds', passed: true });
  const decorations = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await decorations.goto(`${host.url}/tests/fixtures/pseudo-decoration.html`);
  await decorations.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `pseudo-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input')) {
      Object.defineProperty(input, 'value', { get() { throw new Error('Input text must not be read'); } });
      const get = input.getAttribute.bind(input);
      input.getAttribute = name => { if (name.toLowerCase() === 'value') throw new Error('Input attributes must not be read'); return get(name); };
    }
  }, { defaults, en });
  await decorations.addScriptTag({ url: `${host.url}/dist/content.js` });
  await decorations.evaluate(() => window.__command('hello'));
  const captureDecoration = id => decorations.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'pseudo-capture-context', element: document.getElementById(id) };
    await window.__command('capture-context');
    return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
  }, id);
  for (const { id, expected } of await decorations.locator('[data-pseudo]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.pseudo.split(',') })))) {
    const runs = await captureDecoration(id);
    assert.deepEqual(runs.map(run => run.contrast.status), expected, `${id}: separated trailing decoration is assessed, uncertain paint remains manual`);
    for (const run of runs) {
      assert.equal(run.fontSizeCssPx, 11, id); assert.equal(run.fontSize.status, 'fail', `${id}: contrast and the small-text hint remain independent`);
      if (run.contrast.status === 'pass') {
        assert.ok(run.contrast.ratio > 7, `${id}: actual light text on the dark background passes AA and AAA`);
        assert.equal(run.contrast.AA.status, 'pass', id); assert.equal(run.contrast.AAA.status, 'pass', id);
        assert.ok(!run.reasons.includes('pseudo-element'), id);
      } else {
        assert.equal(run.contrast.ratio, null, `${id}: unsupported paint does not invent a contrast ratio`);
        assert.ok(run.reasons.includes(id === 'layered-hint' ? 'layered-background' : 'pseudo-element'), id);
        if (id === 'layered-hint') assert.equal(run.effectiveBackground, null, 'A hit-transparent hint cannot claim its ancestor color as the separately painted input background');
      }
    }
  }
  const scanDecorations = async requestId => {
    await decorations.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await decorations.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await decorations.evaluate(() => window.__command('hello'))).audit;
  };
  const initialDecorationAudit = await scanDecorations('pseudo-initial');
  assert.equal(initialDecorationAudit.scanned, 18);
  assert.deepEqual(initialDecorationAudit.counts.contrast, { pass: 6, fail: 0, manual: 12, notApplicable: 0, assessed: 18 });
  assert.equal(initialDecorationAudit.counts.fontSize.fail, 18);
  await decorations.locator('#layered-hint').evaluate(node => { node.parentElement.style.transform = 'translateY(2000px)'; });
  const offscreenHint = (await captureDecoration('layered-hint'))[0];
  assert.ok(offscreenHint.reasons.includes('layered-background'), 'Moving a pointer-transparent label offscreen must not manufacture a known background');
  assert.equal(offscreenHint.effectiveBackground, null);
  assert.equal(offscreenHint.contrast.ratio, null);
  await decorations.locator('#layered-hint').evaluate(node => { node.parentElement.style.transform = ''; });
  await decorations.locator('#search').evaluate(node => node.classList.add('overlap'));
  const overlappingDecorationAudit = await scanDecorations('pseudo-overlapping');
  assert.deepEqual(overlappingDecorationAudit.counts.contrast, { pass: 5, fail: 0, manual: 13, notApplicable: 0, assessed: 18 }, 'A decorative key moved into the text is unassessed again after rescanning');
  assert.equal(overlappingDecorationAudit.counts.fontSize.fail, 18, 'Changing decoration never clears the independent small-text hints');
  assert.ok((await captureDecoration('search'))[0].reasons.includes('pseudo-element'));
  assert.doesNotMatch(JSON.stringify(await decorations.evaluate(() => window.__events)), /PRIVATE_INPUT_VALUE_SENTINEL/);
  await decorations.close();
  findings.push({ check: 'separate static keyboard hints, inline separators, breadcrumbs, multiple flex children and translations retain measured contrast; tight gaps, shadows, transforms, flow changes, images, overflowing glyphs and multiline layouts stay unassessed; rescan detects moved paint while preserving small-text hints', passed: true });
  const flow = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await flow.goto(`${host.url}/tests/fixtures/pseudo-flow.html`);
  await flow.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `flow-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await flow.addScriptTag({ url: `${host.url}/dist/content.js` });
  await flow.evaluate(() => window.__command('hello'));
  for (const { id, expected } of await flow.locator('[data-flow]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.flow.split(',') })))) {
    const runs = await flow.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'flow-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
    }, id);
    assert.deepEqual(runs.map(run => run.contrast.status), expected, `${id}: leading/trailing generated text must be separated by supported real flow`);
    for (const run of runs) {
      assert.equal(run.fontSize.status, 'pass', id);
      if (run.contrast.status === 'pass') {
        assert.ok(run.contrast.ratio > 7, id);
        assert.equal(run.contrast.AAA.status, 'pass', id);
        assert.deepEqual(run.foreground.rgba, { r: 170, g: 170, b: 170, a: 1 });
        assert.deepEqual(run.effectiveBackground, { r: 15, g: 15, b: 15, a: 1 });
      } else {
        assert.equal(run.contrast.ratio, null, id);
        assert.ok(run.reasons.includes('pseudo-element'), id);
      }
    }
  }
  const scanFlow = async requestId => {
    await flow.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await flow.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await flow.evaluate(() => window.__command('hello'))).audit;
  };
  assert.deepEqual((await scanFlow('flow-initial')).counts.contrast, { pass: 12, fail: 0, manual: 15, notApplicable: 0, assessed: 27 });
  await flow.locator('#timestamp').evaluate(node => node.classList.add('negative'));
  assert.deepEqual((await scanFlow('flow-changed')).counts.contrast, { pass: 11, fail: 0, manual: 16, notApplicable: 0, assessed: 27 });
  await assertMeasurementEventsTextFree(flow, /2 hours ago|Inline time|Second label/);
  await flow.close();
  findings.push({ check: 'leading Unicode metadata separators, inline generated text and multiple flex children retain exact AA/AAA contrast; moved, reordered, wrapping, clipped and overflowing paint stays unassessed; rescan and text privacy hold', passed: true });
  const offscreen = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await offscreen.goto(`${host.url}/tests/fixtures/offscreen-flow.html`);
  await offscreen.evaluate(({ defaults, en }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: key => en[key]?.message ?? '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `offscreen-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults, en });
  await offscreen.addScriptTag({ url: `${host.url}/dist/content.js` });
  await offscreen.evaluate(() => window.__command('hello'));
  for (const { id, expected, reason, reasons } of await offscreen.locator('[data-offscreen]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.offscreen, reason: node.dataset.reason ?? 'layered-background', reasons: node.dataset.reasons?.split(' ') })))) {
    if (!['emphasis', 'touch-label'].includes(id)) assert.ok(await offscreen.locator(`#${id}`).evaluate(node => node.getBoundingClientRect().top > innerHeight), `${id}: test text remains outside the viewport`);
    const runs = await offscreen.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'offscreen-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
    }, id);
    assert.equal(runs.length, 1, id);
    const [run] = runs;
    assert.equal(run.contrast.status, expected, id);
    assert.equal(run.fontSize.status, 'pass', id);
    assert.deepEqual(run.foreground.rgba, { r: 170, g: 170, b: 170, a: 1 }, id);
    if (expected === 'pass') {
      assert.deepEqual(run.effectiveBackground, { r: 15, g: 15, b: 15, a: 1 }, id);
      assert.ok(Math.abs(run.contrast.ratio - 8.251239820985964) < 1e-12, id);
      assert.equal(run.contrast.AA.status, 'pass', id); assert.equal(run.contrast.AAA.status, 'pass', id);
      assert.deepEqual(run.reasons, [], id);
    } else {
      assert.equal(run.contrast.ratio, null, id);
      assert.equal(run.contrast.reason, reason, id);
      assert.deepEqual(run.reasons, reasons ?? [reason], id);
      if (['absolute-parent', 'relative-moved', 'transformed-parent', 'negative-margin', 'floated-parent'].includes(id)) {
        assert.deepEqual(run.effectiveBackground, { r: 15, g: 15, b: 15, a: 1 }, `${id}: enclosing CSS surface remains available`);
        assert.equal(run.contrast.AA.status, 'manual', `${id}: the CSS pair does not certify page paint`);
      } else if (reason === 'layered-background' || reason === 'unresolved-background') assert.equal(run.effectiveBackground, null, id);
    }
  }
  const scanOffscreen = async requestId => {
    await offscreen.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await offscreen.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await offscreen.evaluate(() => window.__command('hello'))).audit;
  };
  const offscreenAudit = await scanOffscreen('offscreen-initial');
  assert.equal(offscreenAudit.scanned, 12);
  assert.deepEqual(offscreenAudit.counts.contrast, { pass: 4, fail: 0, manual: 8, notApplicable: 0, assessed: 12 });
  await offscreen.locator('#static-flow').evaluate(node => node.classList.add('transformed'));
  assert.deepEqual((await scanOffscreen('offscreen-changed')).counts.contrast, { pass: 3, fail: 0, manual: 9, notApplicable: 0, assessed: 12 });
  await offscreen.locator('.touch-effect > div').first().evaluate(node => { node.style.opacity = '1'; });
  assert.deepEqual((await scanOffscreen('touch-painted')).counts.contrast, { pass: 2, fail: 0, manual: 10, notApplicable: 0, assessed: 12 }, 'A real painted feedback overlay must still block the measurement');
  await assertMeasurementEventsTextFree(offscreen, /Ordinary offscreen reply label|Opaque positioned label/);
  await offscreen.close();
  findings.push({ check: 'ordinary offscreen pointer-transparent text uses its enclosing opaque surface; empty touch-feedback wrappers are harmless; displaced, floating, negative-margin, contents-only or overflowing backgrounds and painted emphasis remain unassessed; rescan notices displacement and actual overlay paint', passed: true });
  const negative = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await negative.goto(`${host.url}/tests/fixtures/negative-background.html`);
  await negative.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getUILanguage: () => 'en', getMessage: () => '' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `negative-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await negative.addScriptTag({ url: `${host.url}/dist/content.js` });
  await negative.evaluate(() => window.__command('hello'));
  for (const { id, expected } of await negative.locator('[data-background]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.background })))) {
    const runs = await negative.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'negative-capture-context', element: document.getElementById(id) };
      await window.__command('capture-context');
      return window.__events.filter(event => event.type === 'selected').at(-1).snapshot.textRuns;
    }, id);
    assert.equal(runs.length, 1, id); const [run] = runs;
    assert.equal(run.contrast.status, expected, id);
    if (expected === 'pass') {
      const gray = id === 'different' ? 71.4 : 39;
      assert.deepEqual(run.effectiveBackground, { r: gray, g: gray, b: gray, a: 1 }, id);
      assert.equal(run.contrast.AAA.status, 'pass', id);
      if (id === 'create') assert.ok(Math.abs(run.contrast.ratio - 13.225798856331128) < 1e-12);
    } else {
      assert.equal(run.effectiveBackground, null, id); assert.equal(run.contrast.ratio, null, id);
      assert.ok(run.reasons.includes('layered-background'), id);
    }
  }
  const scanNegative = async requestId => {
    await negative.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await negative.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await negative.evaluate(() => window.__command('hello'))).audit;
  };
  assert.deepEqual((await scanNegative('negative-initial')).counts.contrast, { pass: 4, fail: 0, manual: 12, notApplicable: 0, assessed: 16 });
  await negative.locator('#create').evaluate(node => { node.parentElement.parentElement.querySelector('.backdrop').style.zIndex = '3'; });
  assert.deepEqual((await scanNegative('negative-changed')).counts.contrast, { pass: 3, fail: 0, manual: 13, notApplicable: 0, assessed: 16 });
  await assertMeasurementEventsTextFree(negative, /Create diagnostic/);
  await negative.close();
  findings.push({ check: 'opaque negative-z background siblings compose with translucent buttons in a shared stacking context; foreground paint, different contexts, negative text, incomplete coverage, gradients, masks and effects remain uncertain; rescan catches changed stacking order', passed: true });
  const overflow = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await overflow.goto(`${host.url}/tests/fixtures/overflow-text.html`);
  await overflow.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `overflow-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await overflow.addScriptTag({ url: `${host.url}/dist/content.js` });
  await overflow.evaluate(() => window.__command('hello'));
  const inspectOverflow = id => overflow.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'overflow-capture-context', element: document.getElementById(id) };
    const result = await window.__command('capture-context');
    if (!result.snapshot) throw new Error(result.error);
    return result.snapshot;
  }, id);
  for (const { id, expected } of await overflow.locator('[data-overflow]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.overflow })))) {
    const snapshot = await inspectOverflow(id);
    assert.equal(snapshot.textRuns.length, expected === 'hidden' ? 0 : 1, id);
    if (id === 'visible-row') {
      assert.equal(snapshot.textRuns[0].contrast.AAA.status, 'pass');
      assert.ok(Math.abs(snapshot.textRuns[0].contrast.ratio - 13.569124702898852) < 1e-12);
    }
  }
  const scanOverflow = async requestId => {
    await overflow.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await overflow.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await overflow.evaluate(() => window.__command('hello'))).audit;
  };
  const overflowAudit = await scanOverflow('overflow-initial');
  assert.equal(overflowAudit.runs.length, 11, 'Only fully proven clipped text is excluded; partial, offscreen, escaping and unsupported text remains');
  // Showing a previously hidden selection may scroll its overflow:hidden parent.
  const hiddenSelection = await inspectOverflow('hidden-row');
  assert.equal(hiddenSelection.textRuns.length, 0);
  assert.equal((await overflow.evaluate(async referenceId => {
    const scroller = document.querySelector('.nav');
    const scrolled = new Promise(resolve => scroller.addEventListener('scroll', resolve, { once: true }));
    const result = await window.__command('show-node', { referenceId });
    await scrolled;
    return result;
  }, hiddenSelection.elementRef)).ok, true);
  await overflow.waitForFunction(() => document.querySelector('.nav').scrollTop > 0);
  const revealedRow = (await inspectOverflow('hidden-row')).textRuns[0];
  assert.ok(revealedRow); assert.equal(revealedRow.contrast.AAA.status, 'pass');
  assert.ok(Math.abs(revealedRow.contrast.ratio - 13.569124702898852) < 1e-12);
  await overflow.locator('.nav').evaluate(async node => {
    if (node.scrollTop <= 0) throw new Error('The preceding page highlight must have scrolled the navigation');
    const scrolled = new Promise(resolve => node.addEventListener('scroll', resolve, { once: true }));
    node.style.height = '78px'; node.scrollTop = 0;
    // Native scroll events are delivered asynchronously. The scan should start
    // after this completed movement, not while a queued event invalidates it.
    await scrolled;
  });
  const revealedOverflowAudit = await scanOverflow('overflow-revealed');
  assert.equal(revealedOverflowAudit.runs.length, 12, 'Rescan measures both navigation rows once the container exposes them');
  const navRefs = [await inspectOverflow('visible-row'), await inspectOverflow('hidden-row')].map(snapshot => snapshot.elementRef);
  const navRuns = revealedOverflowAudit.runs.filter(run => navRefs.includes(run.elementRef));
  assert.equal(navRuns.length, 2); assert.ok(navRuns.every(run => run.contrast.AAA.status === 'pass'));
  await assertMeasurementEventsTextFree(overflow, /Hidden second row|Document text outside the viewport/);
  await overflow.close();
  findings.push({ check: 'fully clipped overflow text is excluded using bounded glyph measurements; partial, offscreen, escaping, decorated and uncertain text remains; showing a hidden navigation row and rescanning exposes its exact AA/AAA contrast without storing page text', passed: true });
  const clippedPreviews = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await clippedPreviews.goto(`${host.url}/tests/fixtures/clipped-preview.html`);
  await clippedPreviews.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `preview-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await clippedPreviews.addScriptTag({ url: `${host.url}/dist/content.js` });
  await clippedPreviews.evaluate(() => window.__command('hello'));
  const previewCases = await clippedPreviews.locator('[data-preview]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, status: node.dataset.preview })));
  for (const { id, status } of previewCases) {
    const result = await clippedPreviews.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'preview-capture-context', element: document.getElementById(id) };
      return window.__command('capture-context');
    }, id);
    assert.equal(result.snapshot.textRuns.length, 1, id);
    const run = result.snapshot.textRuns[0];
    assert.equal(run.contrast.status, status, id);
    assert.deepEqual(run.foreground.rgba, { r: 255, g: 255, b: 255, a: .6 }, id);
    if (status === 'pass') {
      assert.deepEqual(run.effectiveBackground, { r: 22, g: 23, b: 23, a: 1 }, id);
      assert.ok(Math.abs(run.contrast.ratio - 7.046327883257104) < 1e-12, id);
      assert.equal(run.contrast.AAA.status, 'pass', id);
    }
  }
  const scanPreviews = async requestId => {
    await clippedPreviews.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await clippedPreviews.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await clippedPreviews.evaluate(() => window.__command('hello'))).audit;
  };
  const previewAudit = await scanPreviews('preview-initial');
  assert.deepEqual({ total: previewAudit.runs.length, pass: previewAudit.counts.contrast.pass, manual: previewAudit.counts.contrast.manual }, { total: 9, pass: 5, manual: 4 });
  await clippedPreviews.locator('#ellipsis').evaluate(node => { node.style.overflow = 'visible'; });
  const changedPreviewAudit = await scanPreviews('preview-unclipped');
  assert.deepEqual({ total: changedPreviewAudit.runs.length, pass: changedPreviewAudit.counts.contrast.pass, manual: changedPreviewAudit.counts.contrast.manual }, { total: 9, pass: 4, manual: 5 });
  await assertMeasurementEventsTextFree(clippedPreviews, /synthetic message preview/);
  await clippedPreviews.close();
  findings.push({ check: 'clipped message previews sample the visible overflow area and retain precise alpha contrast in inspection and audit; visible overflow, actual overlays, escaping text and unsupported transforms remain uncertain, and removing clipping changes the rescan result without storing text', passed: true });
  const splitPreviews = await browser.newPage({ viewport: { width: 1846, height: 900 } });
  await splitPreviews.goto(`${host.url}/tests/fixtures/split-text-preview.html`);
  await splitPreviews.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `split-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await splitPreviews.addScriptTag({ url: `${host.url}/dist/content.js` });
  await splitPreviews.evaluate(() => window.__command('hello'));
  const inspectSplit = id => splitPreviews.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'split-capture-context', element: document.getElementById(id) };
    return (await window.__command('capture-context')).snapshot;
  }, id);
  const splitCases = await splitPreviews.locator('[data-split-count]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, count: Number(node.dataset.splitCount), uncertain: node.dataset.uncertain === 'true' })));
  for (const { id, count, uncertain } of splitCases) {
    const snapshot = await inspectSplit(id);
    assert.equal(snapshot.textRuns.length, count, `${id}: only proven hidden text is omitted`);
    if (!uncertain) for (const run of snapshot.textRuns) {
      assert.equal(run.contrast.AAA.status, 'pass', id);
      assert.deepEqual(run.foreground.rgba, { r: 255, g: 255, b: 255, a: .6 }, id);
      assert.deepEqual(run.effectiveBackground, { r: 22, g: 23, b: 23, a: 1 }, id);
      assert.ok(Math.abs(run.contrast.ratio - 7.046327883257104) < 1e-12, id);
    }
  }
  const scanSplit = async requestId => {
    await splitPreviews.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await splitPreviews.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await splitPreviews.evaluate(() => window.__command('hello'))).audit;
  };
  const splitAudit = await scanSplit('split-initial');
  assert.equal(splitAudit.runs.length, 21);
  for (const { id, count, uncertain } of splitCases) {
    // Match actual live DOM identities without depending on generated labels.
    const snapshot = await inspectSplit(id);
    const runs = splitAudit.runs.filter(run => run.elementRef === snapshot.elementRef);
    assert.equal(runs.length, count, id);
    if (!uncertain) assert.ok(runs.every(run => run.contrast.AAA.status === 'pass'), id);
  }
  const shadowRuns = (await inspectSplit('split-shadow')).textRuns;
  assert.ok(shadowRuns.every(run => run.contrast.status === 'manual' && run.contrast.reason === 'text-shadow'), 'Text shadows remain unassessed even when box shadows no longer block clipping');
  await splitPreviews.locator('#split-box-shadow').evaluate(node => { node.style.filter = 'drop-shadow(-160px 0 white)'; });
  const filteredRuns = (await inspectSplit('split-box-shadow')).textRuns;
  assert.equal(filteredRuns.length, 12, 'Filters can move glyph paint into view and must retain all uncertain fragments');
  assert.ok(filteredRuns.every(run => run.contrast.status === 'manual' && run.contrast.reason === 'filter'));
  await splitPreviews.locator('#split-box-shadow').evaluate(node => { node.style.filter = ''; });
  await splitPreviews.locator('#split-latin').evaluate(node => { node.style.overflow = 'visible'; });
  assert.equal((await inspectSplit('split-latin')).textRuns.length, 12, 'Removing clipping restores every direct text node');
  assert.equal((await scanSplit('split-revealed')).runs.length, 32);
  await assertMeasurementEventsTextFree(splitPreviews, /synthetic preview|Пример текста|Hidden.sample|L’exemple/);
  await splitPreviews.close();
  findings.push({ check: 'adjacent clipped text nodes retain boundary-space metrics; supported Latin/Cyrillic, typographic punctuation, long bounded nodes and NBSP are omitted only when hidden, including boxes and ancestors with box shadows; visible fragments retain exact alpha contrast, unknown marks/bidi/text shadows/filters/context shaping/budget remain, rescan restores revealed nodes and exports no text', passed: true });
  const surfaces = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await surfaces.goto(`${host.url}/tests/fixtures/uniform-gradient-surface.html`);
  await surfaces.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `surface-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await surfaces.addScriptTag({ url: `${host.url}/dist/content.js` });
  await surfaces.evaluate(() => window.__command('hello'));
  const inspectSurface = id => surfaces.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'surface-capture-context', element: document.getElementById(id) };
    return (await window.__command('capture-context')).snapshot;
  }, id);
  const surfaceCases = await surfaces.locator('[data-solid]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, solid: node.dataset.solid === 'true', verdict: node.dataset.verdict })));
  for (const { id, solid, verdict } of surfaceCases) {
    const [run] = (await inspectSurface(id)).textRuns;
    assert.equal(run.contrast.status, verdict, id);
    assert.equal(run.fontSize.status, 'fail', `${id}: the independent 10px readability hint remains`);
    if (solid) {
      assert.deepEqual(run.effectiveBackground, { r: 255, g: 255, b: 255, a: 1 }, id);
      assert.equal(run.backgroundRange, undefined, `${id}: covered border colors do not describe the text background`);
      if (verdict === 'pass') {
        assert.ok(Math.abs(run.contrast.ratio - 7.0733461612626805) < 1e-12, id);
        assert.equal(run.contrast.AAA.status, 'pass'); assert.equal(run.contrast.ratioKind, undefined);
      } else {
        assert.equal(run.contrast.ratio, null); assert.ok(run.reasons.includes('overlapping-element'));
        assert.ok(run.reasons.includes('pseudo-element'), 'Strike paint and faint native controls remain explicit');
      }
    } else assert.ok(run.backgroundRange, `${id}: incomplete or unknown coverage retains the conservative bounds`);
  }
  const scanSurfaces = async requestId => {
    await surfaces.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await surfaces.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await surfaces.evaluate(() => window.__command('hello'))).audit;
  };
  const surfaceAudit = await scanSurfaces('surface-initial');
  assert.equal(surfaceAudit.runs.length, 9);
  assert.deepEqual({ pass: surfaceAudit.counts.contrast.pass, manual: surfaceAudit.counts.contrast.manual, small: surfaceAudit.counts.fontSize.fail }, { pass: 2, manual: 7, small: 9 });
  for (const { id } of surfaceCases) {
    const snapshot = await inspectSurface(id);
    const auditRun = surfaceAudit.runs.find(run => run.elementRef === snapshot.elementRef);
    assert.deepEqual(auditRun.effectiveBackground, snapshot.textRuns[0].effectiveBackground, id);
    assert.deepEqual(auditRun.contrast, snapshot.textRuns[0].contrast, id);
  }
  await surfaces.locator('#dynamic').evaluate(node => { node.closest('.inner').style.backgroundImage = 'linear-gradient(#FFF, #000), linear-gradient(#888C8C, #888C8C)'; });
  const changedSurfaceAudit = await scanSurfaces('surface-changed');
  assert.deepEqual({ pass: changedSurfaceAudit.counts.contrast.pass, manual: changedSurfaceAudit.counts.contrast.manual }, { pass: 1, manual: 8 });
  assert.doesNotMatch(JSON.stringify(await surfaces.evaluate(() => window.__events)), /PRIVATE_SWATCH_CONTROL_SENTINEL/);
  await surfaces.close();
  findings.push({ check: 'opaque uniform gradient surfaces hide lower border colors only with proven text coverage; exact 7.07:1 or CSS-only pairs remain separate from native overlays and strike paint, unsupported coverage stays bounded, and rescan restores actual gradient uncertainty without reading control values', passed: true });
  const icons = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await icons.goto(`${host.url}/tests/fixtures/indented-icon-labels.html`);
  await icons.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `icon-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await icons.addScriptTag({ url: `${host.url}/dist/content.js` });
  await icons.evaluate(() => window.__command('hello'));
  const inspectIcon = id => icons.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'icon-capture-context', element: document.getElementById(id) };
    return (await window.__command('capture-context')).snapshot;
  }, id);
  const iconCases = await icons.locator('[data-runs]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, count: Number(node.dataset.runs) })));
  for (const { id, count } of iconCases) assert.equal((await inspectIcon(id)).textRuns.length, count, id);
  await icons.locator('#reported').hover();
  assert.equal(await icons.locator('#reported').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(221, 221, 221)');
  assert.equal((await inspectIcon('reported')).textRuns.length, 0, 'A highlighted image icon does not reveal its clipped label');
  await icons.mouse.down();
  try {
    assert.equal(await icons.locator('#reported').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(187, 187, 187)');
    assert.equal((await inspectIcon('reported')).textRuns.length, 0, 'The active icon is still not visible text');
  } finally { await icons.mouse.up(); }
  const scanIcons = async requestId => {
    await icons.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await icons.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await icons.evaluate(() => window.__command('hello'))).audit;
  };
  assert.equal((await scanIcons('icons-initial')).runs.length, 5);
  await icons.locator('#reported').evaluate(node => { node.style.textIndent = '0px'; });
  assert.equal((await inspectIcon('reported')).textRuns.length, 1);
  assert.equal((await scanIcons('icons-revealed')).runs.length, 6, 'Revealing a formerly clipped label restores its text check');
  await icons.close();
  findings.push({ check: 'Image icons omit fully clipped positive/negative pixel-indented labels through hover and active states; partial, unclipped, offscreen and uncertain text remain, and revealing a label restores inspection and audit', passed: true });
  const comparison = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await comparison.goto(`${host.url}/tests/fixtures/comparison-colors.html`);
  await comparison.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `comparison-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input')) {
      Object.defineProperty(input, 'value', { get() { throw new Error('Do not read input values'); } });
      Object.defineProperty(input, 'placeholder', { get() { throw new Error('Do not read placeholder text'); } });
    }
  }, { defaults });
  await comparison.addScriptTag({ url: `${host.url}/dist/content.js` });
  await comparison.evaluate(() => window.__command('hello'));
  const inspectComparison = id => comparison.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'comparison-capture-context', element: document.getElementById(id) };
    return (await window.__command('capture-context')).snapshot;
  }, id);
  const gradientRun = (await inspectComparison('gradient')).textRuns[0];
  assert.equal(gradientRun.contrast.AAA.status, 'pass');
  assert.equal(gradientRun.contrast.ratioKind, 'minimum');
  assert.deepEqual(gradientRun.backgroundRange, { min: { r: 247, g: 216, b: 82, a: 1 }, max: { r: 250, g: 232, b: 110, a: 1 } });
  for (const id of ['partial-gradient', 'offset-gradient', 'alpha-gradient', 'modern-gradient']) {
    assert.equal((await inspectComparison(id)).textRuns[0].contrast.status, 'manual', id);
  }
  const modernRun = (await inspectComparison('oklch')).textRuns[0];
  assert.equal(modernRun.contrast.AAA.status, 'pass');
  assert.equal(modernRun.contrast.ratioKind, undefined);
  assert.ok(modernRun.contrast.ratio > 14 && modernRun.contrast.ratio < 16);
  assert.deepEqual(['r', 'g', 'b'].map(key => Math.round(modernRun.foreground.rgba[key])), [50, 36, 0]);
  assert.deepEqual(['r', 'g', 'b'].map(key => Math.round(modernRun.effectiveBackground[key])), [255, 255, 204]);
  const hintRun = (await inspectComparison('control-hint')).textRuns[0];
  assert.equal(hintRun.contrast.status, 'manual'); assert.equal(hintRun.contrast.ratio, null);
  assert.ok(hintRun.reasons.includes('layered-background'));
  assert.deepEqual(hintRun.effectiveBackground, { r: 41, g: 50, b: 61, a: 1 });
  for (const id of ['content-hint', 'unknown-hint']) {
    const run = (await inspectComparison(id)).textRuns[0];
    assert.equal(run.effectiveBackground, null, id); assert.equal(run.contrast.status, 'manual', id);
  }
  const scanComparison = async requestId => {
    await comparison.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await comparison.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await comparison.evaluate(() => window.__command('hello'))).audit;
  };
  const comparisonAudit = await scanComparison('comparison-initial');
  assert.equal(comparisonAudit.runs.length, 12); assert.equal(comparisonAudit.counts.contrast.pass, 2);
  for (const id of ['gradient', 'oklch', 'control-hint']) {
    const snapshot = await inspectComparison(id);
    const auditRun = comparisonAudit.runs.find(run => run.elementRef === snapshot.elementRef);
    assert.deepEqual(auditRun.contrast, snapshot.textRuns[0].contrast, id);
    assert.deepEqual(auditRun.effectiveBackground, snapshot.textRuns[0].effectiveBackground, id);
  }
  await comparison.locator('#gradient').evaluate(node => { node.style.backgroundSize = '50% 100%'; node.style.backgroundRepeat = 'no-repeat'; });
  await comparison.locator('#control-hint').evaluate(node => { node.parentElement.querySelector('input').style.paddingRight = '12px'; });
  const changedComparison = await scanComparison('comparison-changed');
  assert.equal(changedComparison.counts.contrast.pass, 1);
  assert.equal((await inspectComparison('control-hint')).textRuns[0].effectiveBackground, null);
  assert.doesNotMatch(JSON.stringify(await comparison.evaluate(() => window.__events)), /PRIVATE_COMPARISON_INPUT_SENTINEL/);
  await comparison.close();
  findings.push({ check: 'Covered yellow gradients exclude hidden dark backgrounds, Firefox-compatible OKLCH colors retain precise AA/AAA, sibling control padding provides CSS-only color pairs without reading values, and unsupported paint plus rescan changes remain explicit', passed: true });
  const clamped = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await clamped.goto(`${host.url}/tests/fixtures/clamped-return-link.html`);
  await clamped.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const request = { channel: 'sil-content', type, requestId: `clamped-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(request, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
  }, { defaults });
  await clamped.addScriptTag({ url: `${host.url}/dist/content.js` });
  await clamped.evaluate(() => window.__command('hello'));
  const inspectClamped = id => clamped.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'clamped-capture-context', element: document.getElementById(id) };
    return (await window.__command('capture-context')).snapshot;
  }, id);
  const scanClamped = async requestId => {
    await clamped.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await clamped.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await clamped.evaluate(() => window.__command('hello'))).audit;
  };
  const clampedAudit = await scanClamped('clamped-initial');
  assert.equal(clampedAudit.runs.length, 7, 'Clamping retains visible text, split descendants and offscreen content');
  // Chromium emits extra ellipsis rectangles and ambiguous wrap-space ranges.
  // Its conservative fallback is intentional; native Firefox proves the fix.
  assert.equal((await inspectClamped('reported')).textRuns[0].contrast.status, 'manual');
  assert.equal((await inspectClamped('shadow')).textRuns[0].contrast.reason, 'text-shadow');
  assert.equal((await inspectClamped('split')).textRuns.length, 2);
  const offscreenClamped = (await inspectClamped('offscreen')).textRuns[0];
  assert.equal(offscreenClamped.contrast.AA.status, 'pass');
  assert.equal(offscreenClamped.contrast.AAA.status, 'fail');
  assert.ok(Math.abs(offscreenClamped.contrast.ratio - 6.313166596100774) < 1e-9);
  await clamped.locator('#reported').hover();
  assert.deepEqual((await inspectClamped('reported')).textRuns[0].foreground.rgba, { r: 12, g: 51, b: 83, a: 1 });
  await clamped.mouse.move(999, 899);
  await clamped.locator('#popup').evaluate(node => { node.style.display = 'block'; });
  assert.equal((await inspectClamped('reported')).textRuns[0].contrast.reason, 'overlapping-element');
  await clamped.locator('#partial-cover').evaluate(node => { node.style.display = 'block'; });
  assert.equal((await inspectClamped('partial')).textRuns[0].contrast.reason, 'overlapping-element', 'A partly visible last line remains sampled');
  await clamped.evaluate(() => {
    document.querySelectorAll('.popup').forEach(node => { node.style.display = 'none'; });
    Object.assign(document.getElementById('reported').style, { display: 'flow-root', webkitLineClamp: 'unset', height: '48px', overflow: 'visible' });
  });
  assert.equal((await inspectClamped('reported')).textRuns[0].contrast.status, 'manual', 'Revealed lines intersect the painted following row');
  await clamped.locator('#reported').evaluate(node => { node.style.height = 'auto'; });
  const expandedClamped = (await inspectClamped('reported')).textRuns[0];
  assert.equal(expandedClamped.contrast.AA.status, 'pass'); assert.equal(expandedClamped.contrast.AAA.status, 'fail');
  assert.ok(Math.abs(expandedClamped.contrast.ratio - 6.313166596100774) < 1e-9);
  const expandedAudit = await scanClamped('clamped-expanded');
  const expandedSnapshot = await inspectClamped('reported');
  assert.deepEqual(expandedAudit.runs.find(run => run.elementRef === expandedSnapshot.elementRef).contrast, expandedSnapshot.textRuns[0].contrast);
  await assertMeasurementEventsTextFree(clamped, /Returns can be requested/);
  await clamped.close();
  findings.push({ check: 'Multiline clipping preserves offscreen and split text, ambiguous Chromium wrap/ellipsis geometry stays conservative, hover colors update, genuine overlays and partly visible lines remain sampled, and expansion restores measured AA/AAA without exporting text', passed: true });
  const controls = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await controls.goto(`${host.url}/tests/fixtures/transparent-controls.html`);
  await controls.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `controls-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const fn of window.__handlers) { const result = fn(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input')) {
      for (const property of ['value', 'placeholder']) Object.defineProperty(input, property, { get() { throw new Error('Form contents must not be read'); } });
    }
  }, { defaults });
  await controls.addScriptTag({ url: `${host.url}/dist/content.js` });
  await controls.evaluate(() => window.__command('hello'));
  for (const { id, expected } of await controls.locator('[data-control]').evaluateAll(nodes => nodes.map(node => ({ id: node.id, expected: node.dataset.control })))) {
    const snapshot = await controls.evaluate(async id => {
      window.__styleInspectorContext = { requestId: 'controls-capture-context', element: document.getElementById(id) };
      const result = await window.__command('capture-context');
      if (!result.snapshot) throw new Error(result.error);
      return result.snapshot;
    }, id);
    assert.equal(snapshot.textRuns.length, expected === 'hidden' ? 0 : 1, id);
    if (id === 'overlay-label') {
      const [run] = snapshot.textRuns;
      assert.equal(run.contrast.reason, 'overlapping-element');
      assert.equal(run.contrast.ratio, null); assert.equal(run.contrast.AAA.status, 'manual');
      assert.deepEqual(run.foreground.rgba, { r: 15, g: 17, b: 17, a: 1 });
      assert.deepEqual(run.effectiveBackground, { r: 255, g: 164, b: 28, a: 1 });
    }
  }
  const scanControls = async requestId => {
    await controls.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await controls.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await controls.evaluate(() => window.__command('hello'))).audit;
  };
  assert.equal((await scanControls('controls-initial')).runs.length, 9);
  await controls.locator('#hidden-button').evaluate(node => { node.style.color = '#111111'; });
  assert.equal((await scanControls('controls-revealed')).runs.length, 10);
  assert.doesNotMatch(JSON.stringify(await controls.evaluate(() => window.__events)), /Hidden button label|Visible placeholder|Invisible native target/);
  await controls.close();
  findings.push({ check: 'fully transparent native button labels are excluded without reading form contents; visible fills, low opacity, effects and placeholders remain; native overlays still require review and newly visible glyphs return on rescan', passed: true });
  const excerpts = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  await excerpts.goto(`${host.url}/tests/fixtures/text-excerpts.html`);
  await excerpts.evaluate(({ defaults }) => {
    window.__events = []; window.__handlers = [];
    window.browser = { runtime: { id: 'sil-test', onMessage: { addListener(fn) { window.__handlers.push(fn); } }, sendMessage: async event => { window.__events.push(structuredClone(event)); } }, i18n: { getMessage: () => '', getUILanguage: () => 'en' } };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `excerpt-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) { const result = handler(message, { id: 'sil-test' }); if (result !== undefined) return await result; }
    };
    for (const input of document.querySelectorAll('input,textarea,select')) {
      for (const property of ['value', 'placeholder']) Object.defineProperty(input, property, { get() { throw new Error('Excerpt capture must not read form properties'); } });
    }
  }, { defaults });
  await excerpts.addScriptTag({ url: `${host.url}/dist/content.js` });
  assert.equal((await excerpts.evaluate(() => window.__command('hello'))).selected, null);
  const inspectExcerpt = id => excerpts.evaluate(async id => {
    window.__styleInspectorContext = { requestId: 'excerpt-capture-context', element: document.getElementById(id) };
    const result = await window.__command('capture-context');
    if (!result.snapshot) throw new Error(result.error ?? 'No selected snapshot');
    return result.snapshot;
  }, id);
  const scanExcerpts = async requestId => {
    await excerpts.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
    await excerpts.waitForFunction(requestId => window.__events.some(event => event.requestId === requestId && event.audit?.status === 'complete'), requestId);
    return (await excerpts.evaluate(() => window.__command('hello'))).audit;
  };
  const noExcerpt = value => assert.doesNotMatch(JSON.stringify(value), /"textExcerpt"\s*:/);
  noExcerpt(await scanExcerpts('excerpts-initial'));
  await excerpts.evaluate(() => window.__command('start-picker'));
  await excerpts.locator('#simple').hover();
  await excerpts.waitForFunction(() => window.__events.some(event => event.type === 'preview'));
  noExcerpt(await excerpts.evaluate(() => window.__events.filter(event => event.type === 'preview').at(-1).snapshot));
  await excerpts.locator('#simple').click();
  const pickedExcerpt = await excerpts.evaluate(() => window.__events.filter(event => event.type === 'selected').at(-1).snapshot);
  assert.deepEqual(pickedExcerpt.textExcerpt, { value: 'Selected text <em> stays plain & safe.', truncated: false });
  assert.deepEqual(pickedExcerpt.textRuns[0].textExcerpt, pickedExcerpt.textExcerpt);
  const mixedExcerpt = await inspectExcerpt('choice');
  assert.deepEqual(mixedExcerpt.textRuns.map(run => run.textExcerpt.value), ['First visible excerpt.', 'Second visible excerpt.']);
  assert.equal(mixedExcerpt.textExcerpt.value, 'First visible excerpt. Second visible excerpt.');
  assert.equal((await inspectExcerpt('ordinary')).textExcerpt.value, 'Ordinary nested text.', 'The combined excerpt follows DOM order, not element-grouped run order');
  const safeRootExcerpt = await inspectExcerpt('excerpt-root');
  assert.match(safeRootExcerpt.textExcerpt.value, /Selected text <em> stays plain & safe\./);
  assert.doesNotMatch(JSON.stringify(safeRootExcerpt), /PRIVATE_[A-Z_]+_SENTINEL/);
  for (const id of ['hidden', 'invisible', 'transparent', 'input', 'password', 'textarea', 'select', 'editable', 'plaintext', 'uppercase-editable', 'noneditable', 'textbox', 'combobox', 'fallback-role', 'vector', 'canvas']) {
    const excluded = await inspectExcerpt(id);
    assert.equal(excluded.textExcerpt?.value ?? '', '', `${id}: no excerpt from excluded content`);
    assert.ok(excluded.textRuns.every(run => !run.textExcerpt?.value), id);
  }
  const longExcerpt = await inspectExcerpt('long');
  assert.ok(longExcerpt.textRuns[0].textExcerpt.value.length <= 500);
  assert.equal(longExcerpt.textRuns[0].textExcerpt.truncated, true);
  assert.equal(longExcerpt.textRuns[0].textExcerpt.value.isWellFormed(), true, 'Truncation never splits the surrogate pair at the 500-unit boundary');
  assert.ok(longExcerpt.textExcerpt.value.length <= 2000); assert.equal(longExcerpt.textExcerpt.truncated, true);
  const combinedExcerpt = await inspectExcerpt('many');
  assert.equal(combinedExcerpt.textExcerpt.value.length, 2000); assert.equal(combinedExcerpt.textExcerpt.truncated, true);
  assert.ok(combinedExcerpt.textRuns.every(run => run.textExcerpt.value.length <= 500));
  await excerpts.evaluate(() => { document.designMode = 'on'; });
  assert.equal((await inspectExcerpt('simple')).textExcerpt?.value ?? '', '', 'Design-mode documents do not supply editable contents');
  await excerpts.evaluate(() => { document.designMode = 'off'; });
  await inspectExcerpt('simple');
  await excerpts.locator('#simple').evaluate(node => { node.textContent = 'Updated selection excerpt.'; });
  await excerpts.evaluate(() => window.__command('refresh-selection'));
  const refreshedExcerpt = await excerpts.evaluate(() => window.__events.filter(event => event.type === 'selected').at(-1).snapshot);
  assert.equal(refreshedExcerpt.textExcerpt.value, 'Updated selection excerpt.');
  noExcerpt(await scanExcerpts('excerpts-rescan'));
  assert.equal((await excerpts.evaluate(() => window.__command('hello'))).selected, null, 'Rescan clears the old excerpt with its selection');
  const beforeClearExcerpt = await inspectExcerpt('simple');
  await excerpts.evaluate(() => window.__command('clear-data'));
  const clearedExcerpts = await excerpts.evaluate(() => window.__command('hello'));
  assert.equal(clearedExcerpts.selected, null); assert.equal(clearedExcerpts.audit, null);
  assert.equal((await excerpts.evaluate(referenceId => window.__command('select-node', { referenceId }), beforeClearExcerpt.elementRef)).error, 'element-removed', 'Explicit data clearing permanently retires former selectable references');
  const afterClearExcerpt = await inspectExcerpt('simple');
  assert.notEqual(afterClearExcerpt.elementRef, beforeClearExcerpt.elementRef);
  assert.notEqual(afterClearExcerpt.textRuns[0].id, beforeClearExcerpt.textRuns[0].id, 'New inspection after clearing starts fresh comparison identities');
  assert.equal(afterClearExcerpt.textExcerpt.value, 'Updated selection excerpt.');
  assert.doesNotMatch(JSON.stringify(await excerpts.evaluate(() => window.__events)), /PRIVATE_[A-Z_]+_SENTINEL/);
  await assertMeasurementEventsTextFree(excerpts, /Selected text|Updated selection|First visible excerpt/);
  await excerpts.close();
  findings.push({ check: 'Only confirmed selections contain bounded plain-text excerpts with DOM-order aggregation, correct text-run mapping and intact UTF-16 boundaries; audit and hover stay text-free, hidden/form/editable/role/SVG contents and attributes are excluded, refresh replaces text, and rescan/clear remove it', passed: true });
  const state = { windowId: 1, tabId: 1, documentToken: hello.documentToken, access: 'ready', selected, preview: null, picker: false, audit, progress: null, lastEvent: 'ready', settings: defaults };
  const names = ['01-seiten-audit.png', '02-kontrast.png', '03-farben.png', '04-typografie.png', '05-layout.png'];
  for (const locale of ['en', 'en-US', 'de', 'de-DE', 'fr']) {
    const language = locale.startsWith('de') ? 'de' : 'en';
    const catalog = language === 'de' ? de : en;
    const context = await browser.newContext({ locale, viewport: { width: 380, height: 800 }, deviceScaleFactor: 1 });
    await context.addInitScript(({ state, catalog, locale }) => {
      window.__state = structuredClone(state); window.__commands = []; window.__copied = ''; window.__listeners = [];
      const emit = () => window.__listeners.forEach(fn => fn({ type: 'state', state: structuredClone(window.__state) }));
      window.__emit = (patch) => { Object.assign(window.__state, patch); emit(); };
      const getMessage = (key, substitutions = []) => { const entry = catalog[key]; const values = Array.isArray(substitutions) ? substitutions : [substitutions]; return entry?.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '') ?? ''; };
      window.browser = { i18n: { getUILanguage: () => locale, getMessage }, runtime: {
        getManifest: () => ({ version: '1.0.0' }), connect: () => ({ onMessage: { addListener: fn => window.__listeners.push(fn) }, onDisconnect: { addListener() {} }, postMessage(command) {
          window.__commands.push(command);
          if (command.type === 'ready') emit();
          if (command.type === 'update-settings') { Object.assign(window.__state.settings, command.settings); window.__state.lastEvent = 'settings'; emit(); }
          if (command.type === 'start-picker') { window.__state.picker = true; window.__state.lastEvent = 'preview'; emit(); }
          if (command.type === 'cancel-picker') { window.__state.picker = false; window.__state.preview = null; window.__state.lastEvent = 'picker-cancelled'; emit(); }
        } }) }, windows: { getCurrent: async () => ({ id: 1 }) }, commands: { getAll: async () => [] }, permissions: { request: async () => false } };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } });
    }, { state, catalog, locale });
    const page = await context.newPage(); page.on('pageerror', error => pageErrors.push(String(error)));
    await page.goto(`${host.url}/dist/sidebar/index.html`);
    await page.waitForSelector('.metrics');
    assert.equal(await page.locator('html').getAttribute('lang'), language);
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-audit');
    assert.deepEqual(await page.evaluate(() => window.__commands.map(c => c.type)), ['ready']);
    const geometry = () => page.evaluate(() => Object.fromEntries(['.shell', '.header', '.brand-icon', '.brand-title', '.header button', '.toolbar', '.picker', '.tabs', '.footer', '.footer button:first-child', '.footer button:last-child'].map(selector => { const r = document.querySelector(selector).getBoundingClientRect(); return [selector, [r.x, r.y, r.width, r.height]]; })));
    const screenshots = path.join(artifactRoot, 'screenshots', language); await mkdir(screenshots, { recursive: true });
    for (const size of [{ width: 280, height: 480 }, { width: 320, height: 600 }, { width: 380, height: 800 }, { width: 480, height: 720 }]) {
      await page.setViewportSize(size);
      const base = await geometry();
      for (const [index, tab] of ['audit', 'contrast', 'colors', 'typography', 'layout'].entries()) {
        await page.locator(`#tab-${tab}`).click();
        assert.deepEqual(await geometry(), base, `${locale} ${size.width} ${tab}: shell geometry`);
        const overflow = await page.evaluate(() => ({ body: document.body.scrollWidth, panel: document.querySelector('#panel').scrollWidth, width: document.querySelector('#panel').clientWidth, height: document.documentElement.scrollHeight }));
        assert.ok(overflow.body <= size.width && overflow.panel <= overflow.width + 1 && overflow.height <= size.height, `${locale} ${size.width} ${tab} overflow: ${JSON.stringify(overflow)}`);
        if (size.width === 380 && (locale === 'en' || locale === 'de')) {
          if (tab === 'audit') await page.locator('.filter-bar button[data-filter="contrast"]').click();
          await page.locator('.toast').evaluate(node => { node.textContent = ''; });
          await page.screenshot({ path: path.join(screenshots, names[index]) });
        }
      }
      await page.locator('.header button').click(); assert.deepEqual(await geometry(), base);
      assert.equal(await page.locator('.footer button:disabled').count(), 2);
      if (size.width === 380 && (locale === 'en' || locale === 'de')) await page.screenshot({ path: path.join(screenshots, '06-einstellungen.png') });
      await page.locator('#tab-colors').click(); await page.locator('.footer button:last-child').click(); assert.deepEqual(await geometry(), base);
      assert.ok((await page.locator('.code-preview').textContent()).includes('.sil-inspected-element'));
      await page.locator('.footer button:first-child').click();
      assert.equal(await page.evaluate(() => window.__copied), await page.locator('.code-preview').textContent());
      if (size.width === 380 && (locale === 'en' || locale === 'de')) { await page.locator('.toast').evaluate(node => { node.textContent = ''; }); await page.screenshot({ path: path.join(screenshots, '07-export.png') }); }
    }
    await page.setViewportSize({ width: 380, height: 800 });
    await page.locator('#tab-contrast').click();
    if (locale === 'en' || locale === 'de') {
      const suggestion = page.locator('.suggestion-card').first();
      assert.ok(await suggestion.count(), 'Real failing fixture has valid contrast suggestions');
      await suggestion.scrollIntoViewIfNeeded();
      await page.locator('.toast').evaluate(node => { node.textContent = ''; });
      await page.screenshot({ path: path.join(screenshots, '08-kontrastvorschlaege.png') });
      const simulation = page.locator('details').filter({ has: page.locator('summary', { hasText: catalog.simulation.message }) });
      assert.equal(await simulation.count(), 1);
      await simulation.locator('summary').click(); await simulation.locator('select').selectOption('deuteranopia'); await page.locator('details[open]').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(screenshots, '09-farbsehsimulation.png') });
    }
    await page.locator('#tab-audit').focus(); await page.keyboard.press('End'); assert.equal(await page.locator(':focus').getAttribute('id'), 'tab-layout');
    await page.keyboard.press('Home'); assert.equal(await page.locator(':focus').getAttribute('id'), 'tab-audit');
    await page.emulateMedia({ colorScheme: 'dark' });
    assert.notEqual(await page.locator('body').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(255, 255, 255)');
    await page.evaluate(() => window.__emit({ access: 'needs-activation', selected: null, audit: null, documentToken: 'new-document', lastEvent: 'document-changed' }));
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-audit');
    assert.equal(await page.locator('.picker').isDisabled(), true);
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    const commandsBeforeManual = await page.evaluate(() => window.__commands.length);
    await page.locator('#tab-contrast').click();
    assert.equal(await page.locator('.manual-contrast').count(), 1, `${locale}: local contrast remains available without page access`);
    assert.equal((await page.locator('.manual-ratio').textContent()).replace(/\s/g, ''), '21:1');
    assert.equal(await page.locator('.footer button:first-child').isEnabled(), true);
    assert.equal(await page.locator('.footer button:last-child').isDisabled(), true);
    await page.locator('#manual-foreground-picker').click();
    assert.equal(await page.locator('#manual-foreground-hex').inputValue(), '#000000', 'Opening the inline picker preserves the original black color');
    const inlinePlane = page.locator('#manual-foreground-sv');
    await inlinePlane.scrollIntoViewIfNeeded();
    const pickerBounds = await inlinePlane.boundingBox();
    assert.ok(pickerBounds);
    await page.mouse.click(pickerBounds.x + pickerBounds.width * .7, pickerBounds.y + pickerBounds.height * .3);
    assert.notEqual(await page.locator('#manual-foreground-hex').inputValue(), '#000000', 'The inline saturation/value plane can choose a visible color from black');
    assert.equal(await page.locator('.manual-contrast input[type="color"]').count(), 0);
    await page.locator('#manual-foreground-hue').press('Escape');
    assert.equal(await page.locator('#manual-foreground-picker-panel').isVisible(), false);
    await page.locator('.footer button:first-child').click();
    assert.ok((await page.evaluate(() => window.__copied)).startsWith(catalog.manualContrastTitle.message));
    assert.ok((await page.evaluate(() => window.__copied)).includes(catalog.manualContrastScope.message));
    assert.equal(await page.evaluate(() => window.__commands.length), commandsBeforeManual);
    assert.equal(await page.evaluate(() => window.__state.selected), null);
    findings.push({ check: 'sidebar layout, navigation, frozen export bytes, empty access, locale fallback', locale, viewports: 4, tabs: 5, passed: true });
    findings.push({ check: 'manual color contrast is available without page access; its inline saturation/value picker preserves black on opening and selects a visible color; copying remains clearly local without an invented page snapshot', locale, passed: true });
    await context.close();
  }
  assert.deepEqual(pageErrors, []);
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results/ui.json'), JSON.stringify({ browser: browser.version(), fixture: 'tests/fixtures/page.html', note: 'Real rendered UI with browser API fakes; actual content DOM measurements. Firefox integration is tested separately.', findings }, null, 2));
  console.log(JSON.stringify(findings, null, 2));
} finally { await browser.close(); await host.close(); }
