import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, root, defaults, message } from './support.mjs';

const { fixtureRun, fixtureAudit, fixtureSnapshot } = await tsImport('../fixtures/export/data.ts', import.meta.url);
const run = (id, color = '#000000') => ({ ...fixtureRun(color, '#ffffff', 16), id, elementRef: `element-${id}`, selector: `p.${id}` });
const persistent = Array.from({ length: 40 }, (_, index) => `persistent-${index}`);
const previous = { ...fixtureAudit([...persistent.map(id => run(id, '#aaaaaa')), run('resolved', '#aaaaaa'), run('new'), run('removed', '#aaaaaa'), run('threshold', '#767676')]), id: 'previous', scope: 'page', stale: true };
const current = { ...fixtureAudit([...persistent.map(id => run(id, '#999999')), run('resolved'), run('new', '#aaaaaa'), run('threshold')]), id: 'current', scope: 'page', measuredAt: '2026-10-21T12:00:00.000Z', inventoryLimits: { maxColors: 128, maxFontFamilies: 64, maxFontSizes: 1000, maxFontVariants: 1000, maxElements: 1000, reached: ['colors', 'font-families', 'font-sizes', 'font-variants'] } };
const title = '<img src=x onerror="window.__unsafe=true"> A long page title';
const summaries = [
  { tabId: 88, windowId: 42, documentToken: current.document.documentToken, touchedAt: 200, estimatedBytes: 80000, selected: false, auditStatus: 'complete', auditRuns: current.runs.length, previousAudit: true, measuredAt: current.measuredAt, title },
  { tabId: 99, windowId: 43, documentToken: 'other-document', touchedAt: 100, estimatedBytes: 10000, selected: true, auditStatus: null, auditRuns: 0, previousAudit: false, measuredAt: current.measuredAt },
];
const host = await serve(), browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
const errors = [], checks = [];
await mkdir(path.join(root, 'test-results'), { recursive: true });
try {
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    const catalog = JSON.parse(await readFile(path.join(root, `_locales/${locale}/messages.json`), 'utf8'));
    const label = (key, values = []) => message(catalog, key, values);
    const state = { windowId: 42, tabId: 88, documentToken: current.document.documentToken, documentRevision: 1, access: 'ready', selected: null, preview: null, picker: false, audit: current, previousAudit: previous, progress: null, lastEvent: 'ready', settings: { ...defaults, appearance: theme } };
    const context = await browser.newContext({ viewport: { width: 380, height: 850 }, locale, colorScheme: theme });
    await context.addInitScript(({ state, catalog, locale }) => {
      window.__state = structuredClone(state); window.__commands = []; window.__listeners = [];
      window.__reply = reply => window.__listeners.forEach(listener => listener(structuredClone(reply)));
      window.__emit = patch => { Object.assign(window.__state, patch); window.__reply({ type: 'state', state: window.__state }); };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => { window.__copied = text; } } });
      const getMessage = (key, substitutions = []) => {
        const entry = catalog[key], values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry?.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '') ?? '';
      };
      window.browser = { i18n: { getUILanguage: () => locale, getMessage }, runtime: { getManifest: () => ({ version: '1.0.2' }), connect: () => ({
        onMessage: { addListener: listener => window.__listeners.push(listener) }, onDisconnect: { addListener() {} }, disconnect() {},
        postMessage(command) {
          window.__commands.push(structuredClone(command));
          if (command.type === 'ready') window.__emit({ lastEvent: 'ready' });
          if (command.type === 'update-settings') window.__emit({ settings: { ...window.__state.settings, ...command.settings }, lastEvent: 'settings' });
        },
      }) }, windows: { getCurrent: async () => ({ id: 42 }) }, commands: { getAll: async () => [] }, permissions: { request: async () => true } };
    }, { state, catalog, locale });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${host.url}/dist/sidebar/index.html`); await page.locator('.metrics').waitFor();
    const emit = patch => page.evaluate(patch => window.__emit(patch), patch);
    const reply = value => page.evaluate(value => window.__reply(value), value);
    const lastCommand = type => page.evaluate(type => window.__commands.filter(command => command.type === type).at(-1), type);
    const commandCount = type => page.evaluate(type => window.__commands.filter(command => command.type === type).length, type);
    const overviewReply = (requestId, entries) => reply({ type: 'analyses', requestId, entries, maximumBytes: 6000000, maximumRecords: 12 });
    const openComparison = async () => {
      if (!await page.locator('.audit-diff').evaluate(node => node.open)) await page.locator('.audit-diff > summary').click();
      await page.locator('.audit-diff-content > *').first().waitFor();
    };
    const openSettings = () => page.locator('.header button').click();
    const back = () => page.locator('main .section-title > .back').click();
    const fits = async name => assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${locale}/${theme}/${name}: no horizontal overflow`);
    const afterPaint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    for (const key of ['Enter', 'Space']) {
      await page.locator('#audit-filter-contrast').focus(); await page.keyboard.press(key);
      assert.equal(await page.locator('#audit-filter-contrast').evaluate(node => document.activeElement === node), true, 'Replacing filtered rows retains keyboard focus');
      assert.equal(await page.locator('#audit-filter-contrast').getAttribute('aria-pressed'), 'true');
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('#audit-filter-small').evaluate(node => document.activeElement === node), true, 'Tab continues through filters rather than restarting at the scan button');
    }
    await page.locator('#audit-filter-all').click();
    checks.push({ locale, theme, checks: ['audit filters retain keyboard focus and natural Tab order after Enter and Space activation'] });

    assert.equal(await page.locator('.audit-diff-item').count(), 0, 'Comparison details start collapsed without rendering all findings');
    assert.equal(await commandCount('start-audit'), 0, 'Displaying the baseline never starts another scan');
    await openComparison();
    assert.equal(await page.locator('.audit-diff-item').count(), 30);
    for (const [kind, count] of [['new', 1], ['resolved', 1], ['persistent', 40], ['unassessed', 1]]) {
      assert.ok((await page.locator(`[data-change-filter="${kind}"]`).textContent()).endsWith(`(${count})`));
    }
    await page.locator('.audit-diff-content > button').click(); await afterPaint();
    assert.equal(await page.locator('.audit-diff-item').count(), 43);
    assert.equal(await page.locator('.audit-diff-item').nth(30).evaluate(node => document.activeElement === node), true);
    await page.locator('[data-change-filter="unassessed"]').click();
    assert.equal(await page.locator('.audit-diff-item').count(), 1);
    assert.equal(await page.locator('.audit-diff-item button').count(), 0, 'Removed text has no current inspect target');
    await page.locator('[data-change-filter="new"]').click();
    await page.locator('.audit-diff-item button').click();
    assert.equal((await lastCommand('select-node')).referenceId, 'element-new');
    if (locale === 'de') for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator('.audit-diff').screenshot({ path: path.join(root, `test-results/audit-tools-comparison-${locale}-${theme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 380, height: 850 });
    await page.locator('[data-change-filter="all"]').click();

    await openSettings(); await page.getByLabel(label('contrastTarget'), { exact: true }).selectOption('AAA'); await back();
    await openComparison();
    assert.ok((await page.locator('[data-change-filter="resolved"]').textContent()).endsWith('(2)'), 'Both historical and current measurements use the selected AA/AAA target');
    await emit({ settings: { ...state.settings, contrastTarget: 'AA' }, audit: { ...current, stale: true }, lastEvent: 'stale' });
    await openComparison();
    assert.equal(await page.locator('.audit-diff .notice.warning').textContent(), label('comparisonUnavailable_stale_current'));
    assert.equal(await page.locator('.audit-diff-item').count(), 0);
    for (const status of ['partial', 'cancelled']) {
      await emit({ audit: { ...current, status }, lastEvent: 'audit' }); await openComparison();
      assert.equal(await page.locator('.audit-diff .notice.warning').textContent(), label('comparisonUnavailable_incomplete'));
    }
    await emit({ audit: { ...current, scope: 'viewport' }, lastEvent: 'audit' }); await openComparison();
    assert.equal(await page.locator('.audit-diff .notice.warning').textContent(), label('comparisonUnavailable_scope'));
    await emit({ audit: current, lastEvent: 'audit' });

    await page.getByRole('button', { name: label('actionRescan'), exact: true }).click();
    const rejected = await lastCommand('start-audit');
    assert.equal(await page.locator('.metrics').count(), 1, 'Pending validation leaves the current audit visible');
    assert.equal(await page.getByText(label('auditStartPreserve'), { exact: true }).count(), 1);
    for (const patch of [{ stale: true }, { stale: true, measuredAt: '2026-10-21T12:00:01.000Z' }]) {
      await emit({ audit: { ...current, ...patch }, lastEvent: 'audit' });
      assert.equal(await page.locator('.metrics').count(), 1, 'A preceding audit update remains visible while a newer start is pending');
      assert.equal(await page.getByRole('button', { name: label('actionRescan'), exact: true }).isDisabled(), true, 'An older audit event cannot release the newer start request');
      assert.equal(await page.getByText(label('auditStartPreserve'), { exact: true }).count(), 1);
    }
    await reply({ type: 'error', code: 'storage-failed' });
    assert.equal(await page.getByRole('button', { name: label('actionRescan'), exact: true }).isDisabled(), true, 'An unrelated storage error cannot release the pending scan request');
    await reply({ type: 'error', requestId: rejected.requestId, code: 'element-removed' });
    assert.equal(await page.locator('.metrics').count(), 1);
    assert.equal(await page.getByRole('button', { name: label('actionRescan'), exact: true }).isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__state.previousAudit.id), 'previous');
    await emit({ audit: current, lastEvent: 'audit' });
    await page.getByRole('button', { name: label('actionRescan'), exact: true }).click();
    const accepted = await lastCommand('start-audit');
    await reply({ type: 'error', requestId: rejected.requestId, code: 'element-removed' });
    assert.equal(await page.getByRole('button', { name: label('actionRescan'), exact: true }).isDisabled(), true, 'A preceding rejected request cannot release a newer start');
    await emit({ audit: null, previousAudit: current, lastEvent: 'audit-reset' });
    assert.equal(await page.locator('.metrics').count(), 0, 'Accepted starts retire the visible old audit');
    await emit({ audit: { ...current, id: accepted.requestId, status: 'cancelled' }, previousAudit: current, lastEvent: 'audit' });
    assert.equal(await page.getByRole('button', { name: label('actionRescan'), exact: true }).isEnabled(), true, 'Only the matching accepted audit releases the start request');
    await openComparison();
    assert.equal(await page.locator('.audit-diff .notice.warning').textContent(), label('comparisonUnavailable_incomplete'));
    await emit({ audit: current, previousAudit: previous, lastEvent: 'audit' });
    await page.getByRole('button', { name: label('actionRescan'), exact: true }).click();
    await emit({ selected: null, audit: null, previousAudit: null, lastEvent: 'data-cleared' });
    assert.equal(await page.getByRole('button', { name: label('actionScanPage'), exact: true }).isEnabled(), true, 'Clearing the current analysis also retires its unfinished start request');
    await emit({ audit: current, previousAudit: previous, lastEvent: 'audit' });
    checks.push({ locale, theme, checks: ['lazy comparison with classified counts, pagination focus and current-only inspect actions', 'common contrast target, stale current and incompatible scope guards', 'pending/rejected scan retains audit and baseline; accepted cancelled scan remains explicitly incomparable'] });

    for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator('#tab-colors').click();
      assert.equal(await page.locator('.inventory-limit').count(), 1);
      assert.ok((await page.locator('.inventory-limit').textContent()).includes(label('inventoryLimitColors', ['128'])));
      assert.ok(!(await page.locator('.inventory-limit').textContent()).includes(label('inventoryLimitFamilies', ['64'])));
      await fits('color inventory limits');
      await page.locator('#tab-typography').click();
      assert.equal(await page.locator('.inventory-limit').count(), 1);
      assert.ok((await page.locator('.inventory-limit').textContent()).includes(label('inventoryLimitFamilies', ['64'])));
      await fits('font inventory limits');
      await emit({ audit: { ...current, inventoryLimits: undefined }, lastEvent: 'audit' });
      assert.equal(await page.locator('.inventory-limit').count(), 0, 'Older snapshots do not invent a reached limit');
      await emit({ audit: current, lastEvent: 'audit' });
    }
    checks.push({ locale, theme, checks: ['color/font limit notices are relevant to their view, fit narrow sidebars, and stay absent for legacy snapshots'] });

    await page.setViewportSize({ width: 280, height: 850 });
    await openSettings();
    assert.equal(await commandCount('list-analyses'), 0, 'Settings do not fetch an overview automatically');
    await page.locator('.analyses-overview > button').click();
    let request = await lastCommand('list-analyses');
    assert.equal(await page.locator('.analyses-overview > button').isDisabled(), true);
    await overviewReply(request.requestId, summaries);
    assert.equal(await page.locator('.analysis-entry').count(), 2);
    assert.equal(await page.locator('[data-tab-id="88"] .analysis-title').textContent(), title);
    assert.equal(await page.locator('.analysis-entry img').count(), 0, 'Live tab titles are rendered as plain text');
    assert.equal(await page.evaluate(() => window.__unsafe), undefined);
    assert.equal(await page.locator('[data-tab-id="99"] .analysis-title').textContent(), label('analysesTab', ['99']));
    await fits('analysis overview');
    if (locale === 'de') for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 850 });
      await page.locator('.analyses-overview').screenshot({ path: path.join(root, `test-results/audit-tools-overview-${locale}-${theme}-${width}.png`) });
    }
    await page.setViewportSize({ width: 280, height: 850 });
    const other = page.locator('[data-tab-id="99"]');
    await other.getByRole('button', { name: label('analysesDelete'), exact: true }).click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.analyses-overview').count(), 1, 'Escape dismisses only the per-tab confirmation and keeps settings open');
    assert.equal(await other.locator('.confirm-box').count(), 0);
    assert.equal(await commandCount('clear-tab-analysis'), 0, 'Escape changes no retained data');
    await other.getByRole('button', { name: label('analysesDelete'), exact: true }).click();
    await other.getByRole('button', { name: label('actionCancel'), exact: true }).click();
    assert.equal(await commandCount('clear-tab-analysis'), 0, 'Canceling the confirmation changes no retained data');
    await other.getByRole('button', { name: label('analysesDelete'), exact: true }).click();
    await other.getByRole('button', { name: label('actionConfirm'), exact: true }).click();
    request = await lastCommand('clear-tab-analysis');
    assert.equal(request.targetTabId, 99); assert.equal(request.documentToken, 'other-document');
    await overviewReply(request.requestId, [summaries[0]]);
    assert.equal(await page.locator('.analysis-entry').count(), 1);
    assert.equal(await page.evaluate(() => window.__state.audit.id), current.id, 'Deleting an unrelated tab leaves the current audit intact');
    assert.equal(await page.evaluate(() => window.__state.previousAudit.id), previous.id);
    const selected = page.locator('[data-tab-id="88"]');
    await selected.getByRole('button', { name: label('analysesDelete'), exact: true }).click();
    await selected.getByRole('button', { name: label('actionConfirm'), exact: true }).click();
    request = await lastCommand('clear-tab-analysis');
    await emit({ selected: null, preview: null, audit: null, previousAudit: null, lastEvent: 'data-cleared' });
    await overviewReply(request.requestId, [summaries[1]]);
    assert.equal(await page.locator('[data-tab-id="99"]').count(), 1, 'The active-tab cleared event does not discard its pending overview response');
    assert.equal(await page.locator('.analyses-overview > button').isEnabled(), true);
    await back(); await page.locator('#tab-audit').click();
    assert.equal(await page.locator('.audit-diff').count(), 0); assert.equal(await page.locator('.metrics').count(), 0);
    checks.push({ locale, theme, checks: ['explicit overview only, escaped/fallback titles and bounded-size explanation', 'cancel/delete confirmation targets exact tab document; unrelated-tab and current-tab response ordering preserve correct state'] });

    await openSettings(); await page.locator('.analyses-overview > button').click();
    const obsolete = await lastCommand('list-analyses');
    await page.locator('#tab-colors').click();
    await overviewReply(obsolete.requestId, [{ ...summaries[0], tabId: 77 }]);
    await openSettings();
    assert.equal(await page.locator('[data-tab-id="77"]').count(), 0, 'A response from a left view cannot restore obsolete overview entries');
    await page.locator('.analyses-overview > button').click();
    const failed = await lastCommand('list-analyses');
    await reply({ type: 'error', requestId: failed.requestId, code: 'page-changed' });
    assert.equal(await page.locator('.analyses-overview > button').isEnabled(), true);
    await page.locator('.analyses-overview > button').click();
    const newest = await lastCommand('list-analyses');
    await reply({ type: 'error', requestId: failed.requestId, code: 'page-changed' });
    assert.equal(await page.locator('.analyses-overview > button').isDisabled(), true, 'An old failure cannot cancel a newer request');
    await overviewReply(newest.requestId, []);
    assert.equal(await page.getByText(label('analysesEmpty'), { exact: true }).count(), 1);
    for (const mode of ['pending', 'confirmation']) {
      await page.locator('.analyses-overview > button').click();
      await overviewReply((await lastCommand('list-analyses')).requestId, summaries);
      let interrupted;
      if (mode === 'pending') {
        await page.locator('.analyses-overview > button').click(); interrupted = await lastCommand('list-analyses');
      } else await page.locator('[data-tab-id="99"]').getByRole('button', { name: label('analysesDelete'), exact: true }).click();
      await emit({ selected: { ...fixtureSnapshot(run('context')), id: `context-${mode}` }, selectionOrigin: 'context', selectionTab: 'contrast', lastEvent: 'selected' });
      assert.equal(await page.locator('.analyses-overview').count(), 0);
      if (interrupted) await overviewReply(interrupted.requestId, [{ ...summaries[0], tabId: 77 }]);
      await openSettings();
      assert.equal(await page.locator('[data-tab-id="77"]').count(), 0, 'A context selection retires an unfinished overview request');
      assert.equal(await page.locator('.analyses-overview .confirm-box').count(), 0, 'A context selection retires an unfinished deletion confirmation');
      assert.equal(await page.locator('.analyses-overview > button').isEnabled(), true);
    }
    assert.equal(await commandCount('start-audit'), 3, 'Comparison, settings and data management cause no additional page scans');
    checks.push({ locale, theme, checks: ['stale overview responses and errors are ignored; failed requests can be retried explicitly', 'Escape cancels only deletion confirmation; context selections retire pending overview requests and confirmations'] });

    await back(); await page.locator('#tab-audit').click();
    const first = { ...fixtureAudit([{ ...run('minimum', '#aaaaaa'), fontSizeCssPx: 11 }]), id: 'minimum-before', scope: 'page' };
    const minimumRun = { ...run('minimum'), fontSizeCssPx: 12, effectiveBackground: null, backgroundRange: { min: { r: 230, g: 230, b: 230, a: 1 }, max: { r: 255, g: 255, b: 255, a: 1 } } };
    const second = { ...fixtureAudit([minimumRun]), id: 'minimum-after', scope: 'page' };
    await emit({ selected: null, preview: null, audit: second, previousAudit: first, lastEvent: 'audit' });
    await openComparison(); await page.locator('[data-change-filter="all"]').click();
    const difference = await page.locator('.audit-diff-content').textContent();
    assert.ok(difference.includes(locale === 'de' ? '≥ 16,82 : 1' : '≥ 16.82 : 1'), 'A conservative minimum is floored and explicitly qualified');
    assert.ok(difference.includes(label('contrastMinimum')));
    assert.ok(difference.includes(label('statusThresholdMet')) && difference.includes(label('findingSmallText')), 'Font findings retain readability terminology');
    await fits('qualified comparison');
    checks.push({ locale, theme, checks: ['comparison preserves minimum prefixes and downward rounding; font findings use readability labels'] });

    const overview = { ...current, id: 'export-basis', palette: [run('raw').foreground], fonts: ['Arial, sans-serif'],
      paletteUsage: [{ color: run('placeholder', '#ff0000').foreground, count: 1, roles: { text: 1 } }],
      fontUsage: [{ family: 'Georgia, serif', count: 1, sizes: [{ sizeCssPx: 16, count: 1 }] }] };
    await emit({ audit: overview, previousAudit: null, lastEvent: 'audit' }); await page.locator('#tab-colors').click();
    await page.locator('.footer button').first().click();
    assert.match(await page.evaluate(() => window.__copied), /#FF0000/);
    assert.match(await page.evaluate(() => window.__copied), /Georgia/);
    await page.locator('.footer button').last().click();
    assert.equal(await page.getByLabel(label('exportInventory'), { exact: true }).inputValue(), 'measured');
    await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
    let exported = JSON.parse(await page.locator('.code-preview').textContent());
    assert.equal(exported.inventory, 'measured');
    assert.deepEqual(exported.generatedTokens.map(token => token.value), ['#FF0000', 'Georgia, serif']);
    await emit({ audit: { ...overview, palette: [], fonts: [], paletteUsage: [], fontUsage: [] }, lastEvent: 'audit' });
    await page.getByLabel(label('exportInventory'), { exact: true }).selectOption('css');
    exported = JSON.parse(await page.locator('.code-preview').textContent());
    assert.equal(exported.inventory, 'css');
    assert.deepEqual(exported.generatedTokens.map(token => token.value), ['#000000', 'Arial, sans-serif'], 'Switching the basis uses the frozen reviewed audit');
    await page.getByLabel(label('exportInventory'), { exact: true }).selectOption('measured');
    assert.match(await page.locator('.code-preview').textContent(), /Georgia/);
    await fits('export basis');
    assert.equal(await commandCount('start-audit'), 3, 'Changing export basis does not measure the page');
    checks.push({ locale, theme, checks: ['overview quick-copy and export include measured placeholder styles; explicit raw-CSS alternative, frozen source and narrow layouts'] });
    await context.close();
  }
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), checks, errors };
  await writeFile(path.join(root, 'test-results/audit-tools.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally { await browser.close(); await host.close(); }
