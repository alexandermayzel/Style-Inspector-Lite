import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, root, defaults, message } from './support.mjs';

const { fixtureRun, fixtureSnapshot, fixtureAudit } = await tsImport('../fixtures/export/data.ts', import.meta.url);
const { evaluateRun } = await tsImport('../../src/core/contrast.ts', import.meta.url);
const { parseColor, formatColor } = await tsImport('../../src/core/colors.ts', import.meta.url);
const { StyleInventory } = await tsImport('../../src/core/style-inventory.ts', import.meta.url);
const { diagnosticMeasurement, serializeDiagnostic } = await tsImport('../../src/core/diagnostics.ts', import.meta.url);
const { serializeExport } = await tsImport('../../src/core/exports.ts', import.meta.url);

const run = (ref, changes = {}) => evaluateRun({ ...fixtureRun('#111111', '#FFFFFF', 16), id: `${ref}:text`, elementRef: ref, selector: `p.${ref}`, fontFamily: 'Example Sans, sans-serif', lineHeight: '24px', ...changes }, 'AA');
const first = run('first'), second = run('second');
const variant = run('first', { id: 'first:variant', fontSizeCssPx: 20, fontWeight: 700, lineHeight: 'normal' });
const precise = parseColor('rgb(17.0000085 17.0000085 17.0000085 / .54)');
const alphaBackground = parseColor('rgb(10 20 30 / .4)');
const alpha = run('alpha', { foreground: precise, background: alphaBackground, effectiveBackground: null, reasons: ['layered-background'], fontFamily: 'Example Serif, serif', fontSizeCssPx: 14, fontWeight: 600, lineHeight: '21px' });
const audit = fixtureAudit([first, variant, second, alpha]); audit.id = 'workflow-inventory';
const inventory = new StyleInventory();
for (const ref of [...new Set(audit.runs.map(item => item.elementRef))]) {
  const runs = audit.runs.filter(item => item.elementRef === ref), measured = runs[0];
  inventory.record(ref, { color: measured.foreground.raw, backgroundColor: measured.background.raw, fontFamily: measured.fontFamily, lineHeight: measured.lineHeight }, runs, false);
}
Object.assign(audit, inventory.snapshot());
audit.paletteUsage.push({ color: parseColor('color(display-p3 1 0 0)'), count: 0, roles: {} });
const selections = Object.fromEntries([...new Set(audit.runs.map(item => item.elementRef))].map(ref => {
  const runs = audit.runs.filter(item => item.elementRef === ref), selected = fixtureSnapshot(runs[0]);
  selected.id = `selection-${ref}`; selected.textRuns = runs;
  return [ref, selected];
}));
const passed = Array.from({ length: 33 }, (_, index) => run(`passed-${index}`));
const css = ['css-1', 'css-2'].map(ref => run(ref, { reasons: ['layered-background'] }));
const missing = ['missing-1', 'missing-2'].map(ref => run(ref, { effectiveBackground: null, reasons: ['layered-background'] }));
const grouped = fixtureAudit([...passed, ...css, ...missing]); grouped.id = 'workflow-groups';
for (const measured of grouped.runs) selections[measured.elementRef] = { ...fixtureSnapshot(measured), id: `selection-${measured.elementRef}` };
const sortingRuns = [10, 12, 12, 12, 14, 14, 14, 14, 16, 16, 16, null, null, null, null, null].map((size, index) => run(`sort-${index}`, { fontSizeCssPx: size }));
sortingRuns.push(run('sort-other', { fontFamily: 'Other Font, serif', fontSizeCssPx: 20 }));
const sortingAudit = fixtureAudit(sortingRuns), sortingInventory = new StyleInventory(); sortingAudit.id = 'workflow-font-sort';
for (const measured of sortingRuns) {
  sortingInventory.record(measured.elementRef, { color: measured.foreground.raw, backgroundColor: measured.background.raw, fontFamily: measured.fontFamily, lineHeight: measured.lineHeight }, [measured], false);
  selections[measured.elementRef] = { ...fixtureSnapshot(measured), id: `selection-${measured.elementRef}` };
}
Object.assign(sortingAudit, sortingInventory.snapshot());
const report = (measured, source, snapshot) => ({ schemaVersion: 1, kind: 'contrast-diagnostic', capturedAt: '2026-10-20T12:00:00.000Z', generator: { name: 'Style Inspector Lite', version: '1.0.2' }, browser: { name: 'Firefox', version: '158.0' }, measurement: diagnosticMeasurement(measured, source, snapshot.measuredAt, snapshot.stale, 1, snapshot.viewport, []), currentViewport: snapshot.viewport, layers: [], samples: [], limitations: ['current-styles-not-a-new-measurement', 'no-text-or-page-address'] });

const host = await serve(), browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
const errors = [], checks = [];
await mkdir(path.join(root, 'test-results'), { recursive: true });
try {
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    const catalog = JSON.parse(await readFile(path.join(root, `_locales/${locale}/messages.json`), 'utf8'));
    const label = key => message(catalog, key);
    const state = { windowId: 42, tabId: 88, documentToken: audit.document.documentToken, documentRevision: 1, access: 'ready', selected: null, preview: null, picker: false, audit, progress: null, lastEvent: 'ready', settings: { ...defaults, appearance: theme } };
    const context = await browser.newContext({ viewport: { width: 380, height: 850 }, locale, colorScheme: theme });
    await context.addInitScript(({ state, catalog, locale, selections }) => {
      window.__state = structuredClone(state); window.__commands = []; window.__ports = []; window.__copied = ''; window.__failClipboard = false;
      window.__selections = selections;
      const emit = message => window.__ports.at(-1)?.listeners.forEach(listener => listener(structuredClone(message)));
      window.__emit = patch => { Object.assign(window.__state, patch); emit({ type: 'state', state: window.__state }); };
      window.__reply = (requestId, report, portIndex = window.__ports.length - 1) => window.__ports[portIndex].listeners.forEach(listener => listener({ type: 'diagnostic', requestId, report: structuredClone(report) }));
      window.__disconnect = () => window.__ports.at(-1).disconnectListeners.forEach(listener => listener());
      const getMessage = (key, substitutions = []) => {
        const entry = catalog[key], values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry?.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '') ?? '';
      };
      window.browser = { i18n: { getUILanguage: () => locale, getMessage }, runtime: { getManifest: () => ({ version: '1.0.2' }), connect: () => {
        const connection = { listeners: [], disconnectListeners: [] }; window.__ports.push(connection);
        return { onMessage: { addListener: listener => connection.listeners.push(listener) }, onDisconnect: { addListener: listener => connection.disconnectListeners.push(listener) }, disconnect() {}, postMessage(command) {
          window.__commands.push(command);
          if (command.type === 'ready') window.__emit({ lastEvent: 'ready' });
          if (command.type === 'select-node' && window.__selections[command.referenceId]) window.__emit({ selected: structuredClone(window.__selections[command.referenceId]), selectionTab: command.tab, selectionOrigin: 'audit', lastEvent: 'selected' });
          if (command.type === 'start-audit') window.__emit({ selected: null, preview: null, audit: null, lastEvent: 'audit-reset' });
          if (command.type === 'clear-data') window.__emit({ selected: null, preview: null, audit: null, picker: false, lastEvent: 'data-cleared' });
          if (command.type === 'update-settings') window.__emit({ settings: { ...window.__state.settings, ...command.settings }, lastEvent: 'settings' });
        } };
      } }, windows: { getCurrent: async () => ({ id: 42 }) }, commands: { getAll: async () => [] }, permissions: { request: async () => window.__downloadPermission === true } };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (window.__deferClipboard) await new Promise((resolve, reject) => { window.__settleClipboard = { resolve, reject }; });
        if (window.__failClipboard) throw Error('Fixture clipboard denial'); window.__copied = text;
      } } });
    }, { state, catalog, locale, selections });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${host.url}/dist/sidebar/index.html`); await page.locator('.metrics').waitFor();
    const emit = patch => page.evaluate(patch => window.__emit(patch), patch);
    const lastCommand = type => page.evaluate(type => window.__commands.filter(command => command.type === type).at(-1), type);
    const assertFits = async name => assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${locale}/${theme}/${name}: no horizontal overflow`);
    const palette = value => page.locator('.palette-item').filter({ has: page.locator('.palette-value', { hasText: new RegExp(`^${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }) });
    const openActions = async tile => { if (!await tile.locator('.palette-actions').evaluate(node => node.open)) await tile.locator('.palette-actions > summary').click(); };
    const openOccurrences = async () => { await page.locator('#tab-colors').click(); const tile = palette('#111111'); await openActions(tile); await tile.locator('.inventory-matches').click(); };
    const setDiagnostics = async enabled => {
      await page.locator('.header button').click();
      await page.locator('#show-diagnostics').setChecked(enabled);
      assert.deepEqual((await lastCommand('update-settings')).settings, { showDiagnostics: enabled });
      await page.locator('main .section-title > .back').click();
    };
    assert.equal(await page.locator('.diagnostic-copy').count(), 0, 'Ordinary audit cards hide diagnosis controls by default');
    await emit({ selected: selections.first, selectionTab: 'contrast', selectionOrigin: 'context', lastEvent: 'selected' });
    assert.equal(await page.locator('.diagnostic-copy').count(), 0, 'Selected text hides diagnosis controls by default');
    await page.locator('.header button').click();
    assert.equal(await page.locator('#show-diagnostics').isChecked(), false, 'Diagnosis is an explicit opt-in');
    await page.locator('main .section-title > .back').click();

    for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 850 });
      await emit({ selected: null, preview: null, audit, lastEvent: 'ready' });
      await openOccurrences();
      assert.deepEqual(await page.locator('.inventory-occurrences .occurrence-item').evaluateAll(nodes => nodes.map(node => node.dataset.reference)), ['first', 'second']);
      await page.locator('.inventory-occurrences .occurrence-item').first().locator('.show-node').click();
      assert.equal((await lastCommand('show-node')).referenceId, 'first');
      await page.locator('.inventory-occurrences .occurrence-item').first().getByRole('button', { name: label('actionInspect'), exact: true }).click();
      assert.equal((await lastCommand('select-node')).referenceId, 'first');
      assert.equal(await page.getByLabel(label('textContrast'), { exact: true }).inputValue(), '0');
      await page.getByRole('button', { name: label('inventoryReturnOccurrences'), exact: true }).click();
      assert.equal(await page.locator('.inventory-occurrences .occurrence-item').count(), 2);
      await page.locator('.section-title > .back').click();
      assert.equal(await page.locator('.palette-overview').count(), 1);
      await emit({ selected: null, lastEvent: 'ready' }); await page.locator('#tab-typography').click();
      const font = page.locator('.font-usage-item').filter({ has: page.locator('.font-chip', { hasText: /^Example Sans, sans-serif$/ }) });
      await font.locator(':scope > .inventory-matches').click();
      assert.equal(await page.locator('.inventory-occurrences .occurrence-item').count(), 2);
      await page.locator('.section-title > .back').click();
      const size = font.locator('.font-size-row').filter({ hasText: '20' });
      await size.locator('.inventory-matches').click();
      assert.equal(await page.locator('.inventory-occurrences .occurrence-item').count(), 1);
      await page.locator('.inventory-occurrences .occurrence-item').getByRole('button', { name: label('actionInspect'), exact: true }).click();
      assert.equal((await lastCommand('select-node')).tab, 'typography');
      assert.equal(await page.getByLabel(label('textContrast'), { exact: true }).inputValue(), '1', 'A size drill-down preserves its matching text run');
      await page.getByRole('button', { name: label('inventoryReturnOccurrences'), exact: true }).click();
      await page.locator('.section-title > .back').click();
      await emit({ selected: null, lastEvent: 'ready' });
      await font.locator('.font-variants > summary').click();
      const variantRow = font.locator('.font-variant-row').filter({ hasText: '700' });
      assert.ok((await variantRow.textContent()).includes(label('fontLineHeightNormal')));
      await assertFits('font-variants');
      if (width === 280) await page.screenshot({ path: path.join(root, `test-results/workflows-typography-${locale}-${theme}.png`) });
      await variantRow.locator('.inventory-matches').click();
      await page.locator('.inventory-occurrences .occurrence-item').getByRole('button', { name: label('actionInspect'), exact: true }).click();
      assert.equal(await page.getByLabel(label('textContrast'), { exact: true }).inputValue(), '1', 'A variant drill-down preserves size, weight and line-height association');
      await page.getByRole('button', { name: label('inventoryReturnOccurrences'), exact: true }).click();
      await emit({ audit: { ...audit, stale: true }, lastEvent: 'stale' });
      assert.equal(await page.locator('.inventory-occurrences .notice.warning').count(), 1);
      await assertFits('occurrences');
      await emit({ selected: null, audit: { ...audit, id: `replaced-${width}` }, lastEvent: 'audit' });
      assert.equal(await page.locator('.inventory-occurrences').count(), 0, 'A replacement scan invalidates old associations');
      await emit({ audit, lastEvent: 'ready' }); await openOccurrences();
      await emit({ audit: { ...audit, measuredAt: '2026-10-20T13:00:00.000Z', paletteUsage: [] }, lastEvent: 'audit' });
      assert.equal(await page.locator('.inventory-occurrences').count(), 0, 'An automatic rescan with the same request ID also retires old associations');
      await emit({ audit, lastEvent: 'ready' }); await openOccurrences();
      await emit({ documentToken: `other-${width}`, documentRevision: 2, selected: null, audit: null, lastEvent: 'document-changed' });
      assert.equal(await page.locator('.inventory-occurrences').count(), 0, 'Navigation cannot retain targets from another document');
      await emit({ documentToken: state.documentToken, documentRevision: 1, audit, lastEvent: 'ready' });
    }

    // Typography prioritizes frequent sizes, preserves numeric tie ordering,
    // and keeps unknown sizes last even when they have the largest count.
    for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 850 });
      await emit({ selected: null, audit: sortingAudit, lastEvent: 'ready' }); await page.locator('#tab-typography').click();
      const font = page.locator('.font-usage-item').filter({ has: page.locator('.font-chip', { hasText: /^Example Sans, sans-serif$/ }) });
      if (!await font.locator('.font-variants').evaluate(node => node.open)) await font.locator('.font-variants > summary').click();
      const sizeLabel = size => size === null ? label('fontSizeUnknown') : message(catalog, 'fontCssSize', [String(size)]);
      const order = async () => ({
        sizes: await font.locator('.font-size-row > span:first-child').allTextContents(),
        variants: (await font.locator('.font-variant-row > span:first-child').allTextContents()).map(text => text.split(' · ')[0]),
      });
      const assertOrder = async sizes => { await font.locator('.font-variant-row').first().waitFor({ state: 'attached' }); assert.deepEqual(await order(), { sizes: sizes.map(sizeLabel), variants: sizes.map(sizeLabel) }); };
      assert.equal(await page.locator('#font-sort').inputValue(), 'frequency');
      await assertOrder([14, 12, 16, 10, null]);
      for (const [mode, sizes] of [['size-asc', [10, 12, 14, 16, null]], ['size-desc', [16, 14, 12, 10, null]]]) {
        await page.locator('#font-sort').selectOption(mode); await assertOrder(sizes);
        assert.deepEqual(await page.locator('.font-usage-heading .font-chip').allTextContents(), ['Example Sans, sans-serif', 'Other Font, serif'], 'Changing size order retains family frequency order');
        await emit({ lastEvent: 'settings' });
        assert.equal(await page.locator('#font-sort').inputValue(), mode); await assertOrder(sizes);
      }
      const compactButtons = await font.locator('.inventory-matches').evaluateAll(nodes => nodes.filter(node => node.checkVisibility()).map(node => ({ button: node.getBoundingClientRect().width, available: node.parentElement.getBoundingClientRect().width })));
      assert.ok(compactButtons.length > 5);
      assert.ok(compactButtons.every(({ button, available }) => button < available - 16), `${locale}/${theme}/${width}: occurrence buttons keep compact widths for family, size and variant rows`);
      await assertFits('font-sort');
      if (width === 280) await page.screenshot({ path: path.join(root, `test-results/workflows-typography-sort-${locale}-${theme}.png`) });
      await font.locator('.font-size-row').first().locator('.inventory-matches').click();
      assert.equal(await page.locator('.inventory-occurrences .occurrence-item').count(), 3);
      await page.locator('.inventory-occurrences .occurrence-item').first().getByRole('button', { name: label('actionInspect'), exact: true }).click();
      await page.getByRole('button', { name: label('inventoryReturnOccurrences'), exact: true }).click();
      await page.locator('.section-title > .back').click();
      assert.equal(await page.locator('#font-sort').inputValue(), 'size-desc'); await assertOrder([16, 14, 12, 10, null]);
      assert.deepEqual(await page.evaluate(() => window.__state.audit), sortingAudit, 'Sorting changes the overview without rewriting measured inventory');
      await page.locator('#font-sort').selectOption('frequency'); await assertOrder([14, 12, 16, 10, null]);
    }

    // Color transfer is local, retains the inspected snapshot, and preserves
    // channels/alpha beyond the rounded HEX swatch label.
    await emit({ selected: selections.first, audit, lastEvent: 'ready' }); await page.locator('#tab-colors').click();
    const selectionBefore = await page.evaluate(() => structuredClone(window.__state.selected));
    const preciseTile = palette('#1111118A'); await openActions(preciseTile); await preciseTile.locator('.palette-use-text').click();
    assert.equal(await page.locator('#manual-foreground-hex').inputValue(), formatColor(precise.rgba, 'hex'));
    assert.deepEqual(await page.evaluate(() => window.__state.selected), selectionBefore);
    await page.locator('.manual-return').click();
    const alphaTile = palette('#0A141E66'); await openActions(alphaTile); await alphaTile.locator('.palette-use-background').click();
    assert.equal(await page.locator('#manual-background-hex').inputValue(), '#0A141E66');
    assert.equal(await page.locator('#manual-underlay-hex').inputValue(), '', 'No white canvas is silently invented for transparent backgrounds');
    assert.equal(await page.locator('.manual-ratio').count(), 0); assert.equal(await page.locator('.footer button').first().isDisabled(), true);
    await page.locator('#manual-underlay-hex').fill('#FFFFFF');
    assert.equal(await page.locator('.manual-ratio').count(), 1);
    await page.locator('.footer button').first().click();
    const copied = await page.evaluate(() => window.__copied);
    assert.ok(copied.includes(formatColor(precise.rgba, 'hex'))); assert.ok(copied.includes('#0A141E66'));
    assert.ok(copied.includes(label('manualUnderlay'))); assert.ok(copied.includes(label('effectiveBackground')));
    assert.ok(copied.includes(label('manualContrastScope'))); assert.equal(copied.split('\n').filter(line => /^(AA|AAA):/.test(line)).length, 4);
    await assertFits('manual-alpha');
    await page.screenshot({ path: path.join(root, `test-results/workflows-manual-${locale}-${theme}.png`) });
    await page.locator('#manual-underlay-hex').fill('rgb(0 0 0 / .5)');
    assert.equal(await page.locator('.manual-ratio').count(), 0); assert.equal(await page.locator('#manual-underlay-hex').getAttribute('aria-invalid'), 'true');
    await page.locator('#manual-underlay-hex').fill('#FFFFFF');
    await page.evaluate(() => { window.__failClipboard = true; });
    await page.locator('.footer button').first().click(); await page.locator('.clipboard-fallback').waitFor();
    await page.locator('#tab-contrast').click();
    assert.equal(await page.locator('.manual-contrast').count(), 0, 'Clicking the contrast tab leaves the explicit calculator and restores selection');
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'The explicit-calculator report cannot remain beside selected page measurements');
    await page.evaluate(() => { window.__failClipboard = false; }); await page.locator('#tab-colors').click();
    const unknown = palette('color(display-p3 1 0 0)'); await openActions(unknown);
    assert.equal(await unknown.locator('.palette-use-text').isDisabled(), true); assert.equal(await unknown.locator('.palette-use-background').isDisabled(), true);
    assert.equal(await unknown.locator('.inventory-matches').isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__state.selected), selectionBefore);

    // Equal findings may collapse, but measured results, CSS pairs and missing
    // values retain separate groups and the original summary counts.
    await emit({ selected: null, audit: grouped, lastEvent: 'ready' }); await page.locator('#tab-audit').click();
    const countsBefore = await page.locator('.metrics').textContent(), filtersBefore = await page.locator('.filter-bar').textContent();
    await page.locator('#audit-group-results').check();
    assert.equal(await page.locator('.audit-group').count(), 3);
    assert.equal(await page.locator('.metrics').textContent(), countsBefore); assert.equal(await page.locator('.filter-bar').textContent(), filtersBefore);
    const groups = page.locator('.audit-group');
    assert.ok((await groups.nth(0).locator(':scope > summary').textContent()).includes('33'));
    assert.ok((await groups.nth(1).locator(':scope > summary').textContent()).includes(label('cssColorContrast')));
    assert.ok((await groups.nth(2).locator(':scope > summary').textContent()).includes(label('ratioUnavailable')));
    await groups.first().locator(':scope > summary').click();
    await groups.first().locator('.occurrence-item').first().waitFor();
    assert.equal(await groups.first().locator('.occurrence-item').count(), 30);
    await groups.first().locator('.list-more').click(); assert.equal(await groups.first().locator('.occurrence-item').count(), 33);
    await groups.first().locator('.occurrence-item').last().locator('.show-node').click(); assert.equal((await lastCommand('show-node')).referenceId, 'passed-32');
    await assertFits('groups');
    await page.screenshot({ path: path.join(root, `test-results/workflows-groups-${locale}-${theme}.png`) });
    assert.deepEqual(await page.evaluate(() => window.__state.audit), grouped);
    await page.locator('[data-filter="manual"]').click(); assert.equal(await page.locator('.audit-group').count(), 1);
    await page.locator('.audit-group > summary').click(); await page.locator('.audit-group .occurrence-item').first().waitFor();
    assert.equal(await page.locator('.diagnostic-copy').count(), 0, 'Expanded grouped audit members hide diagnosis controls by default');
    assert.equal(await lastCommand('diagnose-node'), undefined, 'Normal audit and inspection do not request diagnostics');
    await setDiagnostics(true);
    await page.locator('.audit-group .diagnostic-copy').first().waitFor();
    await page.locator('.header button').click();
    assert.equal(await page.locator('#show-diagnostics').isChecked(), true, 'Reopening settings retains the enabled preference');
    await page.locator('main .section-title > .back').click();
    await page.locator('.audit-group .diagnostic-copy').first().click();
    const auditRequest = await lastCommand('diagnose-node');
    assert.deepEqual(auditRequest.source, { kind: 'audit', id: grouped.id }); assert.equal(auditRequest.referenceId, missing[0].elementRef); assert.equal(auditRequest.runId, missing[0].id);
    assert.equal(auditRequest.expectedTabId, 88); assert.equal(auditRequest.expectedDocumentToken, state.documentToken); assert.equal(auditRequest.expectedRevision, 1);
    const auditReport = report(missing[0], 'audit', grouped);
    await page.evaluate(({ requestId, report }) => window.__reply(requestId, report), { requestId: auditRequest.requestId, report: auditReport });
    assert.equal(await page.evaluate(() => window.__copied), serializeDiagnostic(auditReport));

    // A selected diagnostic is opt-in, has its exact source identity, and falls
    // back to a selectable local report when the clipboard is unavailable.
    await emit({ selected: selections.first, audit, selectionTab: 'contrast', lastEvent: 'selected', selectionOrigin: 'context' });
    await page.locator('.diagnostic-copy').click();
    const selectionRequest = await lastCommand('diagnose-node');
    assert.deepEqual(selectionRequest.source, { kind: 'selection', id: selections.first.id });
    assert.equal(selectionRequest.runId, first.id);
    const selectionReport = report(first, 'selection', selections.first);
    await page.evaluate(({ requestId, report }) => { window.__failClipboard = true; window.__reply(requestId, report); }, { requestId: selectionRequest.requestId, report: selectionReport });
    await page.locator('.clipboard-fallback').waitFor();
    assert.equal(await page.locator('.clipboard-fallback').inputValue(), serializeDiagnostic(selectionReport));
    assert.equal(await page.locator('.clipboard-fallback').getAttribute('readonly'), '');
    await setDiagnostics(false);
    assert.equal(await page.locator('.diagnostic-copy').count(), 0, 'Disabling removes the selected diagnostic action');
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'Disabling removes a copyable diagnostic fallback');
    await page.locator('#tab-audit').click();
    assert.equal(await page.locator('.diagnostic-copy').count(), 0, 'Disabling also removes audit actions');
    await setDiagnostics(true); await page.evaluate(() => { window.__failClipboard = false; });

    // Delayed diagnosis replies must never copy a report for an obsolete UI
    // source, run, document, scan, or port connection.
    for (const change of ['run', 'selection', 'revision', 'stale', 'rescan', 'navigation', 'clear', 'view', 'connection', 'disabled', 'disabled-and-enabled']) {
      const selected = { ...selections.first, id: `race-${change}` };
      await emit({ documentToken: state.documentToken, documentRevision: 1, tabId: 88, access: 'ready', selected, preview: null, picker: false, audit, settings: { ...state.settings, showDiagnostics: true }, selectionTab: 'contrast', selectionOrigin: 'context', lastEvent: 'selected' });
      await page.locator('.diagnostic-copy').click(); const pending = await lastCommand('diagnose-node');
      const portIndex = await page.evaluate(() => window.__ports.length - 1);
      await page.evaluate(() => { window.__copied = 'sentinel'; });
      if (change === 'run') await page.getByLabel(label('textContrast'), { exact: true }).selectOption('1');
      if (change === 'selection') await emit({ selected: { ...selected, id: 'replacement-selection' }, lastEvent: 'selected' });
      if (change === 'revision') await emit({ documentRevision: 2, lastEvent: 'ready' });
      if (change === 'stale') { await emit({ selected: { ...selected, stale: true }, lastEvent: 'stale' }); assert.equal(await page.locator('.diagnostic-copy').isEnabled(), true, 'A stale-only update retires the pending request instead of leaving its button disabled'); }
      if (change === 'rescan') await emit({ selected: null, audit: null, lastEvent: 'audit-reset' });
      if (change === 'navigation') await emit({ documentToken: 'different-document', documentRevision: 2, selected: null, audit: null, lastEvent: 'document-changed' });
      if (change === 'clear') await emit({ selected: null, audit: null, lastEvent: 'data-cleared' });
      if (change === 'view') await page.locator('#tab-typography').click();
      if (change === 'connection') { await page.evaluate(() => window.__disconnect()); await page.waitForFunction(previous => window.__ports.length > previous + 1, portIndex); }
      if (change.startsWith('disabled')) {
        // A different open sidebar may change preferences without changing this
        // sidebar's view. A disable/re-enable must not revive its old request.
        await emit({ settings: { ...state.settings, showDiagnostics: false }, lastEvent: 'settings' });
        assert.equal(await page.locator('.diagnostic-copy').count(), 0);
        if (change === 'disabled-and-enabled') await emit({ settings: { ...state.settings, showDiagnostics: true }, lastEvent: 'settings' });
      }
      await page.evaluate(({ requestId, report, portIndex }) => window.__reply(requestId, report, portIndex), { requestId: pending.requestId, report: selectionReport, portIndex });
      assert.equal(await page.evaluate(() => window.__copied), 'sentinel', `${locale}/${theme}/${change}: stale diagnostic reply cannot overwrite the clipboard`);
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${change}: stale report is not exposed as fallback`);
      const toastBefore = await page.locator('.toast').textContent();
      await page.evaluate(({ requestId, portIndex }) => window.__ports[portIndex].listeners.forEach(listener => listener({ type: 'error', requestId, code: 'target-expired' })), { requestId: pending.requestId, portIndex });
      assert.equal(await page.locator('.toast').textContent(), toastBefore, `${change}: cancelled diagnosis errors cannot replace the current UI notification`);
    }
    // A clipboard permission rejection can arrive after diagnosis was validly
    // returned. Disabling and re-enabling must not reveal that old fallback.
    await emit({ selected: selections.first, audit, settings: { ...state.settings, showDiagnostics: true }, selectionTab: 'contrast', selectionOrigin: 'context', lastEvent: 'selected' });
    await page.evaluate(() => { window.__deferClipboard = true; window.__copied = 'clipboard-pending'; });
    await page.locator('.diagnostic-copy').click();
    const clipboardRequest = await lastCommand('diagnose-node');
    await page.evaluate(({ requestId, report }) => window.__reply(requestId, report), { requestId: clipboardRequest.requestId, report: selectionReport });
    await page.waitForFunction(() => !!window.__settleClipboard);
    await emit({ settings: { ...state.settings, showDiagnostics: false }, lastEvent: 'settings' });
    await emit({ settings: { ...state.settings, showDiagnostics: true }, lastEvent: 'settings' });
    await page.evaluate(() => { window.__settleClipboard.reject(Error('Delayed fixture clipboard denial')); window.__deferClipboard = false; });
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'An obsolete clipboard rejection cannot expose diagnostics after disabling');
    assert.equal(await page.evaluate(() => window.__copied), 'clipboard-pending');
    checks.push({ locale, theme, checks: ['inventory references and exact run association', 'font weight and line-height variants', 'frequency/numeric typography order, ties, unknown sizes and return-state preservation', 'compact occurrence buttons at 280/380 px', 'stale/rescan/navigation boundaries', 'precise alpha palette transfer and explicit underlying surface', 'grouping and member pagination', 'diagnostics hidden by default, settings opt-in and retained preference, disabling removes controls and fallback', 'diagnostic source qualifications, fallback and eleven late-reply boundaries including disable and disable/re-enable', 'a delayed clipboard rejection cannot restore a disabled diagnostic fallback'] });
    // Scope changes are drafts; only the explicit scan action sends a command.
    const scoped = { ...audit, id: 'scope-workflow', scope: 'selection', rootElementRef: 'saved-section', durationMs: 234, examined: 120, limits: { maxRuns: 1000, maxElements: 20000 }, reachedLimits: ['text-runs'], status: 'partial' };
    await emit({ selected: null, preview: null, audit: scoped, lastEvent: 'audit' }); await page.locator('#tab-audit').click();
    const commandCount = await page.evaluate(() => window.__commands.length);
    await page.locator('#audit-scope').selectOption('viewport');
    assert.equal(await page.evaluate(() => window.__commands.length), commandCount);
    assert.ok((await page.locator('.audit-runtime').textContent()).includes(label('auditLimitRuns')));
    const runtimeLines = await page.locator('.audit-runtime > *').allTextContents();
    await page.locator('footer .primary').click();
    const copiedAudit = await page.evaluate(() => window.__copied);
    for (const line of runtimeLines) assert.ok(copiedAudit.includes(line), `The copied report retains measured scope and limits: ${line}`);
    assert.ok(copiedAudit.includes(label('auditScopeSelection')), 'A viewport draft does not relabel the saved section audit');
    await page.locator('#audit-scope').selectOption('selection');
    await page.locator('main .section-title button.primary').click();
    assert.equal((await lastCommand('start-audit')).scope, 'selection');
    assert.equal((await lastCommand('start-audit')).referenceId, 'saved-section');

    const unresolved = fixtureAudit([
      run('missing-layer', { background: parseColor('transparent'), effectiveBackground: null, reasons: ['layered-background'] }),
      run('missing-color', { foreground: parseColor('unknown'), background: parseColor('transparent'), effectiveBackground: null, reasons: ['unsupported-color'] }),
    ]); unresolved.id = 'reason-filter';
    await emit({ audit: unresolved, selected: null, lastEvent: 'audit' });
    await page.locator('[data-filter="manual"]').click();
    assert.equal(await page.locator('.finding').count(), 2);
    await page.locator('#audit-missing-reason').selectOption('layered-background');
    assert.equal(await page.locator('.finding').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__state.audit), unresolved, 'Filtering never rewrites audit totals');
    await assertFits('missing-reason');

    const changedRun = run(first.elementRef, { foreground: parseColor('#AAAAAA') });
    const later = { ...fixtureSnapshot(changedRun), measuredAt: '2026-10-21T12:00:05.000Z' };
    await emit({ audit, selected: later, selectionTab: 'contrast', selectionOrigin: 'audit', lastEvent: 'selected' });
    assert.equal(await page.locator('.measurement-comparison').getAttribute('data-changed'), 'true');
    await page.locator('.measurement-comparison > summary').click();
    assert.equal(await page.locator('.measurement-comparison-item').count(), 2);
    assert.equal(await page.locator('.audit-viewport-partial').count(), 0, 'Whole text areas do not receive a viewport-partial explanation');
    await assertFits('comparison');
    const viewportAudit = { ...fixtureAudit([{ ...first, viewportPartial: true }]), id: 'partial-viewport-comparison', scope: 'viewport' };
    const fullArea = run(first.elementRef, { effectiveBackground: null, reasons: ['layered-background'] });
    await emit({ audit: viewportAudit, selected: { ...later, textRuns: [fullArea] }, lastEvent: 'selected' });
    await page.locator('.measurement-comparison > summary').click();
    assert.equal(await page.locator('.audit-viewport-partial').textContent(), label('auditViewportPartial'));
    assert.equal(await page.locator('[data-measurement="audit"]').getAttribute('data-status'), 'pass');
    assert.equal(await page.locator('[data-measurement="selection"]').getAttribute('data-status'), 'manual');
    assert.ok((await page.locator('[data-measurement="audit"] .comparison-ratio').textContent()).includes(new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(first.contrast.ratio)), 'The earlier visible-part ratio remains unchanged');
    assert.equal(await page.locator('[data-measurement="selection"] .comparison-ratio').textContent(), label('ratioUnavailable'));
    assert.deepEqual(await page.evaluate(() => window.__state.audit), viewportAudit, 'Explaining measurement scope does not overwrite audit outcomes');
    await assertFits('partial-viewport-comparison');
    await page.locator('#tab-audit').click(); await page.locator('footer .primary').click();
    await page.locator('[data-filter="all"]').click();
    assert.equal(await page.locator('.finding .audit-viewport-partial').textContent(), label('auditViewportPartial'), 'Visible-part qualifications appear directly on audit cards');
    const mixedCoverage = { ...viewportAudit, runs: [{ ...first, viewportPartial: true }, { ...first, id: 'partial-repeat', elementRef: 'partial-repeat', viewportPartial: true }, { ...first, id: 'whole-repeat', elementRef: 'whole-repeat' }] };
    await emit({ audit: mixedCoverage, lastEvent: 'audit' });
    await page.locator('#audit-group-results').check();
    assert.equal(await page.locator('.audit-group').count(), 1);
    assert.equal(await page.locator('.finding').count(), 1, 'Whole and partial text areas cannot share a group');
    await page.locator('.audit-group > summary').click();
    assert.equal(await page.locator('.audit-group .audit-viewport-partial').textContent(), label('auditViewportPartial'));
    await page.locator('#audit-group-results').uncheck();
    assert.ok((await page.evaluate(() => window.__copied)).includes(label('auditViewportPartial')), 'Copied audit rows retain the visible-part qualification');
    await emit({ selected: { ...later, textRuns: [{ ...changedRun, id: 'different-text-node' }] }, lastEvent: 'selected' });
    assert.equal(await page.locator('.measurement-comparison').count(), 0, 'A different text node is never substituted for the historical run');

    const many = fixtureAudit(Array.from({ length: 25 }, (_, index) => run(`many-${index}`, { fontSizeCssPx: 10 + index / 100 })));
    many.id = 'lazy-fonts'; many.fontUsage = [{ family: 'Example Sans, sans-serif', count: 25, elementRefs: many.runs.map(run => run.elementRef), sizes: many.runs.map(run => ({ sizeCssPx: run.fontSizeCssPx, count: 1, elementRefs: [run.elementRef] })), variants: many.runs.map(run => ({ sizeCssPx: run.fontSizeCssPx, fontWeight: 400, lineHeight: '24px', count: 1, elementRefs: [run.elementRef] })) }];
    await emit({ selected: null, audit: many, lastEvent: 'audit' }); await page.locator('#tab-typography').click();
    assert.equal(await page.locator('.font-size-row').count(), 12); assert.equal(await page.locator('.font-variant-row').count(), 0);
    const keyboardMore = async (button, rowSelector, expectedRows, firstNewRow) => {
      await button.focus(); await page.keyboard.press('Enter');
      assert.equal(await page.locator(rowSelector).count(), expectedRows);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.locator(rowSelector).nth(firstNewRow).evaluate(row => row.contains(document.activeElement)), 'Loading more retains keyboard focus at the newly revealed content');
    };
    await keyboardMore(page.locator('.font-more-sizes'), '.font-size-row', 24, 12);
    await keyboardMore(page.locator('.font-more-sizes'), '.font-size-row', 25, 24);
    assert.equal(await page.locator('.font-more-sizes').count(), 0);
    await page.locator('.font-variants > summary').click(); await page.locator('.font-variant-row').first().waitFor({ state: 'attached' });
    assert.equal(await page.locator('.font-variant-row').count(), 12);
    await keyboardMore(page.locator('.font-more-variants'), '.font-variant-row', 24, 12);
    await keyboardMore(page.locator('.font-more-variants'), '.font-variant-row', 25, 24);
    assert.equal(await page.locator('.font-more-variants').count(), 0);
    await assertFits('lazy-fonts');
    const families = { ...many, id: 'lazy-font-families', fontUsage: Array.from({ length: 25 }, (_, index) => ({ ...many.fontUsage[0], family: `Font ${String(index).padStart(2, '0')}` })) };
    await emit({ audit: families, lastEvent: 'audit' });
    assert.equal(await page.locator('.font-usage-item').count(), 12);
    await keyboardMore(page.locator('.font-more-families'), '.font-usage-item', 24, 12);
    await keyboardMore(page.locator('.font-more-families'), '.font-usage-item', 25, 24);
    assert.equal(await page.locator('.font-more-families').count(), 0);
    await emit({ audit: { ...families, id: 'legacy-font-families', fontUsage: families.fontUsage.map(entry => ({ family: entry.family, count: 0, sizes: [] })) }, lastEvent: 'audit' });
    await keyboardMore(page.locator('.font-more-families'), '.font-usage-item', 24, 12);
    assert.ok(await page.locator('.font-usage-item').nth(12).evaluate(row => row === document.activeElement), 'Older inventories without occurrence actions focus the new font row itself');
    const largeAudit = fixtureAudit(Array.from({ length: 1000 }, (_, index) => run(`large-export-${index}`)));
    largeAudit.id = 'large-export';
    const completeExport = serializeExport({ kind: 'audit', audit: largeAudit }, { version: '1.0.2', format: 'json', scope: 'all', colorFormat: 'hex', target: 'AA' });
    await emit({ audit: largeAudit, lastEvent: 'audit' }); await page.locator('#tab-audit').click();
    await page.locator('footer button').last().click();
    await page.getByLabel(label('exportSource'), { exact: true }).selectOption('audit');
    const preview = page.locator('.code-preview');
    const previewMetrics = await preview.evaluate(node => ({ characters: node.textContent.length, nodes: node.querySelectorAll('*').length }));
    assert.ok(completeExport.text.length > 65536, 'The fixture exercises a large complete audit export');
    assert.ok(previewMetrics.characters <= 65536, `Large exports keep their preview bounded: ${JSON.stringify(previewMetrics)}`);
    assert.ok(previewMetrics.nodes <= 768, 'Decorative color swatches cannot grow without bound');
    assert.equal(await page.locator('.export-preview-truncated').textContent(), label('exportPreviewTruncated'));
    assert.ok(completeExport.text.startsWith(await preview.textContent()), 'The shortened preview contains the original prefix unchanged');
    await preview.focus();
    const previewScroll = await preview.evaluate(node => { window.__largePreview = node; node.closest('.content').scrollTop = 150; return node.closest('.content').scrollTop; });
    assert.ok(previewScroll > 0, 'The preview has a nonzero reading position');
    await emit({ settings: { ...defaults, appearance: theme === 'dark' ? 'light' : 'dark' }, lastEvent: 'settings' });
    assert.deepEqual(await preview.evaluate(node => ({ same: node === window.__largePreview, focused: document.activeElement === node, scroll: node.closest('.content').scrollTop })), { same: true, focused: true, scroll: previewScroll }, 'Unrelated updates retain the unchanged preview and its reading position');
    await page.locator('footer .primary').click();
    assert.equal(await page.evaluate(() => window.__copied), completeExport.text, 'Copy includes the complete audit beyond the visible preview');
    await page.evaluate(() => { window.__downloadPermission = true; });
    await page.locator('footer button').last().click();
    assert.equal((await lastCommand('save-export')).text, completeExport.text, 'Download includes the complete audit beyond the visible preview');
    await page.getByLabel(label('exportSource'), { exact: true }).selectOption('page-tokens');
    assert.equal(await page.locator('.export-preview-truncated').count(), 0, 'Small exports display their complete preview');
    assert.equal(await preview.evaluate(node => node === window.__largePreview), false, 'Changing the source invalidates the preview cache');
    assert.equal(await preview.evaluate(node => node.scrollTop), 0, 'A new export starts at its beginning');
    await assertFits('large-export');
    checks.push({ locale, theme, checks: ['large audit previews have bounded text and swatches while copies and saves retain complete bytes', 'unchanged export previews retain their DOM, focus and reading position; changed sources reset them'] });
    checks.push({ locale, theme, checks: ['explicit scope drafts and saved section roots', 'duration and reached limits, including copied reports and unchanged scope drafts', 'missing-measurement reasons preserve totals', 'exact-run historical comparison, visible-part qualifications and unrelated-run exclusion', 'font size, variant and family pagination preserve keyboard focus through the final page'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), checks, errors };
  await writeFile(path.join(root, 'test-results/sidebar-workflows.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await host.close(); }
