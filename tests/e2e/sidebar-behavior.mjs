import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { serve, root, defaults, message } from './support.mjs';

// These are explicit test fixtures; production state always comes from runtime.
const { fixtureRun, fixtureSnapshot, fixtureAudit } = await tsImport('../fixtures/export/data.ts', import.meta.url);
const { serializeExport } = await tsImport('../../src/core/exports.ts', import.meta.url);
const { cssColorContrast, evaluateRun } = await tsImport('../../src/core/contrast.ts', import.meta.url);
const host = await serve();
const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
const errors = [];
try {
  for (const locale of ['en', 'de']) {
    const catalog = JSON.parse(await readFile(path.join(root, `_locales/${locale}/messages.json`), 'utf8'));
    const label = (key) => message(catalog, key);
    const snapshot = fixtureSnapshot();
    const passRun = { ...fixtureRun('#707070', '#ffffff', 16), id: 'pass-run', elementRef: 'pass-element' };
    const manualRun = { ...fixtureRun('#888888', '#ffffff', 11), id: 'manual-run', elementRef: 'manual-element', reasons: ['background-image-or-gradient'] };
    const excludedRun = { ...fixtureRun('#111111', '#ffffff', 16), id: 'excluded-run', elementRef: 'excluded-element', notApplicable: 'inactive-control' };
    const audit = fixtureAudit([snapshot.textRuns[0], passRun, manualRun, excludedRun]);
    audit.palette.push({ raw: '#00000000', rgba: { r: 0, g: 0, b: 0, a: 0 } });
    const state = { windowId: 42, tabId: 88, documentToken: snapshot.document.documentToken, documentRevision: 1, access: 'ready', selected: snapshot, preview: null, picker: false, audit, progress: null, lastEvent: 'ready', settings: defaults };
    const context = await browser.newContext({ viewport: { width: 380, height: 800 }, locale });
    await context.addInitScript(({ state, catalog, locale, defaults, passSnapshot }) => {
      window.__state = structuredClone(state); window.__commands = []; window.__listeners = []; window.__disconnectListeners = []; window.__connectionCount = 0;
      window.__copied = ''; window.__failClipboard = false; window.__downloadPermission = false;
      window.__deferDownloadPermission = false;
      window.__deferClipboard = false; window.__clipboardRequests = [];
      window.__pagePermission = false; window.__deferPagePermission = false; window.__permissionRequests = [];
      window.__removeTarget = false; window.__deferSelection = false;
      window.__selectionSnapshots = { [passSnapshot.elementRef]: passSnapshot };
      const emit = () => window.__listeners.forEach(fn => fn({ type: 'state', state: structuredClone(window.__state) }));
      window.__emit = patch => { Object.assign(window.__state, patch); emit(); };
      window.__disconnect = () => window.__disconnectListeners.at(-1)();
      const getMessage = (key, substitutions = []) => {
        const entry = catalog[key], values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry?.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '') ?? '';
      };
      window.browser = {
        i18n: { getUILanguage: () => locale, getMessage },
        runtime: { getManifest: () => ({ version: '1.0.0' }), connect: () => { window.__connectionCount++; return ({
          onMessage: { addListener: fn => window.__listeners.push(fn) }, onDisconnect: { addListener: fn => window.__disconnectListeners.push(fn) }, disconnect() {},
          postMessage(command) {
            window.__commands.push(command);
            if (command.type === 'ready') { window.__state.lastEvent = 'ready'; emit(); }
            if (command.type === 'show-node') {
              if (window.__removeTarget) window.__listeners.forEach(fn => fn({ type: 'error', requestId: command.requestId, code: 'element-removed' }));
              else { window.__state.audit.stale = true; window.__state.lastEvent = 'stale'; emit(); }
            }
            if (command.type === 'select-node' && !window.__deferSelection && window.__selectionSnapshots[command.referenceId]) {
              window.__state.selected = structuredClone(window.__selectionSnapshots[command.referenceId]);
              window.__state.selectionTab = command.tab; window.__state.selectionOrigin = 'audit'; window.__state.lastEvent = 'selected'; emit();
            }
            if (command.type === 'start-audit') { window.__state.selected = null; window.__state.preview = null; window.__state.audit = null; window.__state.picker = false; window.__state.lastEvent = 'audit-reset'; emit(); }
            if (command.type === 'update-settings') { Object.assign(window.__state.settings, command.settings); window.__state.lastEvent = 'settings'; emit(); }
            if (command.type === 'reset-settings') { window.__state.settings = structuredClone(defaults); window.__state.lastEvent = 'settings'; emit(); }
            if (command.type === 'start-picker') { window.__state.picker = true; window.__state.selectionOrigin = 'picker'; window.__state.selectionTab = undefined; window.__state.lastEvent = 'preview'; emit(); }
            if (command.type === 'cancel-picker') { window.__state.picker = false; window.__state.preview = null; window.__state.lastEvent = 'picker-cancelled'; emit(); }
            if (command.type === 'clear-data') { window.__state.selected = null; window.__state.preview = null; window.__state.audit = null; window.__state.picker = false; window.__state.lastEvent = 'data-cleared'; emit(); }
          }
        }); } },
        windows: { getCurrent: async () => ({ id: 42 }) },
        commands: { getAll: async () => [{ name: '_execute_action', shortcut: '' }] },
        permissions: { request: options => {
          window.__permissionRequests.push({ ...options, userActivation: navigator.userActivation.isActive });
          if (options.origins) return window.__deferPagePermission ? new Promise(resolve => { window.__resolvePagePermission = resolve; }) : Promise.resolve(window.__pagePermission);
          return window.__deferDownloadPermission ? new Promise(resolve => { window.__resolveDownloadPermission = resolve; }) : Promise.resolve(window.__downloadPermission);
        } }
      };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async text => {
        if (window.__deferClipboard) await new Promise((resolve, reject) => window.__clipboardRequests.push({ text, resolve, reject }));
        if (window.__failClipboard) throw new Error('Fixture denied clipboard'); window.__copied = text;
      } } });
    }, { state, catalog, locale, defaults, passSnapshot: fixtureSnapshot(passRun) });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${host.url}/dist/sidebar/index.html`); await page.locator('.metrics').waitFor();
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-audit');
    assert.deepEqual(await page.evaluate(() => window.__commands.map(command => command.type)), ['ready']);
    assert.equal(await page.locator('#tab-contrast svg path[fill="currentColor"]').count(), 1, 'The contrast symbol must include a filled semicircle');
    assert.equal(await page.locator('#tab-contrast svg').getAttribute('fill'), 'none', 'The other semicircle uses the current theme background');

    // Short white and longer alpha values must keep copy controls on their own row.
    for (const width of [280, 380, 550]) {
      await page.setViewportSize({ width, height: 800 });
      const tiles = await page.locator('.page-palette .palette-item').evaluateAll(nodes => nodes.map(node => {
        const swatch = node.querySelector('.swatch').getBoundingClientRect(), value = node.querySelector(':scope > span:not(.swatch)').getBoundingClientRect(), copy = node.querySelector('button').getBoundingClientRect();
        return { text: node.querySelector(':scope > span:not(.swatch)').textContent, separateRows: value.top >= swatch.bottom && copy.top >= value.bottom, aligned: Math.abs(copy.left - swatch.left) < 1 };
      }));
      assert.ok(tiles.some(tile => tile.text === '#FFFFFF'));
      assert.ok(tiles.some(tile => tile.text === '#00000000'));
      assert.ok(tiles.every(tile => tile.separateRows && tile.aligned), `${locale}/${width}: each palette copy button is below its value`);
      assert.ok(tiles.every(tile => /^#[0-9A-F]{6}(?:[0-9A-F]{2})?$/.test(tile.text)), 'Palette HEX values use uppercase');
    }
    await page.locator('.page-palette').screenshot({ path: path.join(root, `test-results/palette-layout-${locale}.png`) });
    for (const value of ['#FFFFFF', '#00000000']) {
      await page.locator('.page-palette .palette-item').filter({ hasText: value }).getByRole('button').click();
      assert.equal(await page.evaluate(() => window.__copied), value, 'Copy matches the uppercase visible value');
    }
    await page.setViewportSize({ width: 380, height: 800 });
    await page.locator('.content').evaluate(node => { node.scrollTop = 0; });

    // Every compact color preview retains the exact measured color. Rounded HEX
    // displays expose the precise CSS color in their tooltip, including alpha.
    // Unsupported spaces stay explicit instead of displaying a guessed sRGB color.
    const assertColorChips = async (scope = page.locator('.content')) => {
      const chips = await scope.locator('.color-chip').evaluateAll(nodes => nodes.map(node => {
        const value = node.querySelector('.color-value-text').textContent, swatch = node.querySelector('.swatch-small');
        const fill = swatch.querySelector('span'), rect = swatch.getBoundingClientRect(), chipRect = node.getBoundingClientRect();
        const panel = document.querySelector('.content').getBoundingClientRect();
        const precise = node.querySelector('.color-value-text').title.match(/rgb\([^)]*\)/)?.[0];
        const probe = document.createElement('span'); probe.style.backgroundColor = precise ?? value; document.body.append(probe);
        const expected = getComputedStyle(probe).backgroundColor; probe.remove();
        return { value, precise, actual: getComputedStyle(fill).backgroundColor, expected, unknown: swatch.classList.contains('swatch-unknown'), fill: fill.style.backgroundColor,
          width: rect.width, height: rect.height, checkerboard: getComputedStyle(swatch).backgroundImage !== 'none', decorative: swatch.getAttribute('aria-hidden') === 'true' && swatch.textContent === '',
          fits: chipRect.left >= panel.left - 1 && chipRect.right <= panel.right + 1 };
      }));
      assert.ok(chips.length, 'The color-bearing view contains compact previews');
      for (const chip of chips) {
        assert.equal(chip.width, 28, `${chip.value}: compact size matches the copy-control scale`);
        assert.equal(chip.height, chip.width, `${chip.value}: the swatch is square`);
        assert.ok(chip.decorative && chip.fits, `${chip.value}: decoration stays accessible and inside the panel`);
        if (chip.unknown) assert.equal(chip.fill, '', 'An unsupported color has no fabricated fill');
        else assert.equal(chip.actual, chip.expected, `${chip.value}: swatch paint matches its adjacent CSS value`);
      }
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Compact color rows cannot create horizontal overflow');
      return chips;
    };
    // Native Firefox placeholders can serialize fractional sRGB channels and an
    // alpha that cannot be represented exactly in 8-bit HEX (Amazon search).
    const amazonRaw = 'color(srgb 0.0666667 0.0666667 0.0666667 / 0.54)';
    const amazonRun = { ...fixtureRun(amazonRaw, '#ffffff', 15), id: 'amazon-placeholder-run', elementRef: 'amazon-placeholder-element', tagName: 'input', textSource: 'placeholder' };
    const amazonSnapshot = fixtureSnapshot(amazonRun);
    const amazonAudit = fixtureAudit([amazonRun]);
    amazonAudit.palette = [amazonRun.foreground, amazonRun.background];
    const amazonRGBA = { r: 17.0000085, g: 17.0000085, b: 17.0000085, a: 0.54 };
    const exactAmazonRGB = 'rgb(17.0000085 17.0000085 17.0000085 / 0.54)';
    assert.deepEqual(amazonRun.foreground.rgba, amazonRGBA);
    assert.equal(amazonRun.contrast.ratio, 4.032916523267044);
    await page.setViewportSize({ width: 280, height: 800 });
    let amazonExport;
    for (const [colorFormat, expected] of [['hex', '#1111118A'], ['rgb', exactAmazonRGB], ['hsl', 'hsl(0 0% 6.66667% / 0.54)']]) {
      await page.evaluate(({ selected, audit, colorFormat }) => window.__emit({ selected, audit, settings: { ...window.__state.settings, colorFormat }, selectionTab: 'contrast', lastEvent: 'selected' }), { selected: amazonSnapshot, audit: amazonAudit, colorFormat });
      await page.locator('#tab-contrast').click();
      const foreground = page.locator('.color-detail').filter({ has: page.locator('.color-name', { hasText: label('foreground') }) });
      assert.equal(await foreground.locator('.color-value-text').textContent(), expected, locale + ': fractional placeholder color honors ' + colorFormat);
      const title = await foreground.locator('.color-value-text').getAttribute('title');
      assert.equal(title ?? '', colorFormat === 'hex' ? message(catalog, 'colorRoundedHex', [exactAmazonRGB]) : '', 'Only rounded HEX explains the precise measured value');
      assert.equal(await foreground.locator('.swatch span').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(17, 17, 17, 0.54)', 'Measured placeholder alpha is not replaced with the rounded HEX alpha');
      assert.equal(await page.locator('.color-preview').first().evaluate(node => getComputedStyle(node).color), 'rgba(17, 17, 17, 0.54)');
      assert.match(await page.locator('.ratio').textContent(), /4[.,]03/);
      assert.equal(await page.locator('.contrast-value').getAttribute('data-status'), 'fail');
      await assertColorChips();
      await page.locator('.footer button:first-child').click();
      assert.ok((await page.evaluate(() => window.__copied)).includes(label('foreground') + ': ' + expected), 'Contrast reports use the same displayed color');
      await page.locator('#tab-colors').click();
      const colorRow = page.locator('.color-row').filter({ has: page.locator('.color-name', { hasText: /^color$/ }) });
      assert.equal(await colorRow.locator('.color-value-text').textContent(), expected);
      await colorRow.getByRole('button').click();
      assert.equal(await page.evaluate(() => window.__copied), expected, 'A direct color copy matches the displayed value');
      const paletteTile = page.locator('.page-palette .palette-item').filter({ hasText: expected });
      assert.equal(await paletteTile.count(), 1);
      assert.equal(await paletteTile.locator(':scope > span:not(.swatch)').getAttribute('title'), colorFormat === 'hex' ? message(catalog, 'colorRoundedHex', [exactAmazonRGB]) : '', 'Palette colors explain the same rounded HEX value');
      await paletteTile.getByRole('button').click();
      assert.equal(await page.evaluate(() => window.__copied), expected, 'A palette copy matches the displayed value');
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Fractional colors fit a 280px sidebar');
      assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit })), { selected: amazonSnapshot, audit: amazonAudit }, 'Display formats and copying do not mutate numeric measurements');
      // Freeze a HEX export: its exact RGB fallback and raw JSON measurements
      // must survive later display changes rather than adopting rounded HEX.
      if (colorFormat === 'hex') {
        await page.locator('.footer button:last-child').click();
        await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
        amazonExport = await page.locator('.code-preview').textContent();
        const exported = JSON.parse(amazonExport);
        assert.deepEqual(exported.textRuns[0].foreground.rgba, amazonRGBA);
        assert.equal(exported.textRuns[0].contrast.ratio, 4.032916523267044);
        assert.equal(exported.styles.find(entry => entry.property === 'color').formatted, exactAmazonRGB);
        assert.ok(exported.warnings.some(warning => warning.code === 'precise-color-fallback'));
        await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, colorFormat: 'rgb' }, lastEvent: 'settings' }));
        assert.equal(await page.locator('.code-preview').textContent(), amazonExport);
        await page.locator('.footer button:first-child').click();
        assert.equal(await page.evaluate(() => window.__copied), amazonExport);
      }
    }
    await page.evaluate(({ selected, audit, settings }) => window.__emit({ selected, audit, settings, selectionTab: undefined, lastEvent: 'ready' }), { selected: snapshot, audit, settings: defaults });
    const chipSnapshot = fixtureSnapshot(fixtureRun('#aabbcc', '#ffffff', 16));
    chipSnapshot.id = 'color-chip-snapshot';
    Object.assign(chipSnapshot.styles.colors, { 'background-color': '#01020380', 'border-top-color': 'rgb(12 34 56 / 0.5)', 'border-right-color': 'color(display-p3 1 0 0)' });
    chipSnapshot.styles.typography['text-decoration-color'] = '#123456';
    chipSnapshot.styles.layout['border-bottom-color'] = '#abcdef';
    await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), chipSnapshot);
    for (const width of [280, 380]) {
      await page.setViewportSize({ width, height: 800 });
      for (const tab of ['contrast', 'colors', 'typography', 'layout']) {
        await page.locator(`#tab-${tab}`).click();
        const chips = await assertColorChips();
        const expected = { contrast: '#AABBCC', colors: '#01020380', typography: '#123456', layout: '#ABCDEF' }[tab];
        assert.ok(chips.some(chip => chip.value === expected), `${locale}/${width}/${tab}: the actual color has an adjacent preview`);
        if (tab === 'colors') {
          assert.ok(chips.some(chip => chip.value === '#0C223880' && chip.precise === 'rgb(12 34 56 / 0.5)' && !chip.unknown && chip.checkerboard), 'Rounded HEX retains its precise alpha in the measured swatch and tooltip');
          assert.ok(chips.some(chip => chip.value === 'color(display-p3 1 0 0)' && chip.unknown), 'Unsupported color space remains visibly unknown');
          for (const property of ['background-color', 'border-top-color', 'border-right-color']) {
            const row = page.locator('.color-row').filter({ has: page.locator('.color-name', { hasText: new RegExp(`^${property}$`) }) });
            const value = await row.locator('.color-value-text').textContent();
            await row.getByRole('button').click();
            assert.equal(await page.evaluate(() => window.__copied), value, `${property}: the copied text is exactly the value beside the swatch`);
          }
        }
      }
      await page.locator('#tab-colors').click(); await page.locator('.footer button:last-child').click();
      for (const format of ['css', 'scss', 'json', 'tailwind']) {
        await page.getByLabel(label('exportFormat'), { exact: true }).selectOption(format);
        const code = page.locator('.code-preview'), text = await code.textContent();
        assert.ok(await code.locator('.code-color .swatch-small').count(), `${format}: export HEX tokens have decorative previews`);
        assert.equal(await code.locator('.swatch').evaluateAll(nodes => nodes.every(node => node.getAttribute('aria-hidden') === 'true' && node.textContent === '')), true, 'Export swatches contribute no text');
        const selection = await code.evaluate(node => {
          const select = element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); const text = selection.toString(); selection.removeAllRanges(); return text; };
          const decorated = select(node), plain = node.cloneNode(false); plain.textContent = node.textContent; node.after(plain);
          const baseline = select(plain); plain.remove(); return { decorated, baseline };
        });
        assert.equal(selection.decorated, selection.baseline, 'Decorative swatches preserve native plain-code selection without inserting line breaks');
        await page.locator('.footer button:first-child').click();
        assert.equal(await page.evaluate(() => window.__copied), text, 'Copying decorated code preserves the exact raw export');
        assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${format}: export preview fits the narrow sidebar`);
      }
    }
    await page.locator('#tab-audit').click();
    const chipSimulation = page.locator('details').filter({ has: page.locator('summary', { hasText: label('simulation') }) });
    await chipSimulation.locator('summary').click();
    await chipSimulation.getByLabel(label('simulationMode')).selectOption('tritanopia');
    const simulationChips = await assertColorChips(chipSimulation);
    assert.ok(simulationChips.some(chip => chip.value === '#00000000'), 'The original transparent value remains independently visible during simulation');
    await chipSimulation.getByLabel(label('simulationMode')).selectOption('original');
    await chipSimulation.locator('summary').click();
    await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), snapshot);
    await page.setViewportSize({ width: 380, height: 800 });
    await page.locator('.content').evaluate(node => { node.scrollTop = 0; });

    // Each rule keeps its own complete denominator and visible pass/fail/unknown counts.
    const contrastOverview = page.locator('.audit-metric[data-rule="contrast"]');
    const fontOverview = page.locator('.audit-metric[data-rule="font-size"]');
    for (const status of ['pass', 'fail', 'manual', 'not-applicable']) assert.equal(await contrastOverview.locator(`.metric-count[data-status="${status}"] .metric-count-value`).textContent(), '1');
    assert.equal(await fontOverview.locator('.metric-count.pass .metric-count-value').textContent(), '1');
    assert.equal(await fontOverview.locator('.metric-count.fail .metric-count-value').textContent(), '2');
    assert.equal(await fontOverview.locator('.metric-count.manual .metric-count-value').textContent(), '0');
    assert.equal(await contrastOverview.locator('.metric-total').textContent(), message(catalog, 'auditRuleTotal', ['4']));
    assert.equal(await fontOverview.locator('.metric-total').textContent(), message(catalog, 'auditRuleTotal', ['4']));

    // Both standards remain visible, including the common AA-pass / AAA-fail case.
    // The selected target controls the numeric color, without silently rescanning.
    const assertAssessment = async (scope, target, status, aa, aaa, thresholds = [4.5, 7]) => {
      const value = scope.locator('.contrast-value');
      assert.equal(await value.getAttribute('data-target'), target);
      assert.equal(await value.getAttribute('data-status'), status);
      if (await value.getAttribute('data-source') === 'css-colors') {
        assert.equal(status, 'manual', 'The real page remains unverified even when the CSS color pair reaches a threshold');
        assert.equal(await value.locator('.contrast-target').count(), 0, 'CSS-only results do not repeat an actual-page status badge');
        assert.equal(await scope.locator('.assessment:not(.css-assessment)').count(), 0, 'Actual WCAG verdicts are not inferred from the CSS sample');
        assert.equal(await scope.locator('.css-page-unverified').count(), 1);
        assert.ok((await scope.locator('.css-page-unverified').textContent()).includes(label('cssPageUnverified')));
        return value.evaluate(node => ({ color: getComputedStyle(node.querySelector('.ratio,.audit-ratio')).color, unitColor: getComputedStyle(node.querySelector('.ratio-unit')).color }));
      }
      assert.ok((await value.locator('.contrast-target').textContent()).includes(message(catalog, 'contrastValueTarget', [target])), 'The meaning of the numeric color is visibly labeled');
      assert.equal(await value.locator(`.contrast-target .badge.${status}`).count(), 1, 'Status is conveyed in text and symbol as well as color');
      assert.equal(await scope.locator('.assessment').count(), 2);
      for (const [index, level] of ['AA', 'AAA'].entries()) {
        const assessment = scope.locator(`.assessment[data-level="${level}"]`);
        assert.equal(await assessment.locator(`.badge.${index ? aaa : aa}`).count(), 1);
        const thresholdText = await assessment.locator('small').textContent();
        assert.match(thresholdText.replace(',', '.'), new RegExp(`${thresholds[index]}\\s*:\\s*1`));
      }
      return value.evaluate(node => ({ color: getComputedStyle(node.querySelector('.ratio,.audit-ratio')).color, unitColor: node.querySelector('.ratio-unit') ? getComputedStyle(node.querySelector('.ratio-unit')).color : null }));
    };
    const assertNoMeasurement = async scope => {
      const value = scope.locator('.contrast-value');
      assert.equal(await value.locator('.ratio-unavailable').textContent(), label('ratioUnavailable'), 'Missing contrast is explained in words rather than shown as a fake ratio');
      assert.equal(await value.locator('.ratio-unit').count(), 0, 'A missing measurement has no : 1 unit');
      assert.ok(await value.locator('.ratio-unavailable').evaluate(node => Number.parseFloat(getComputedStyle(node).fontSize) <= 18), 'The explanatory label uses compact type');
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'The missing-value label fits a narrow sidebar');
    };
    const assertCSSMeasurement = async (scope, run) => {
      const value = scope.locator('.contrast-value'), target = await value.getAttribute('data-target'), sample = cssColorContrast(evaluateRun(run, target));
      assert.ok(sample);
      assert.equal(await value.getAttribute('data-source'), 'css-colors');
      assert.equal(await value.getAttribute('data-status'), 'manual', 'CSS samples cannot imply a page pass or fail');
      assert.equal(await value.locator('.css-contrast-label').textContent(), label('cssColorContrast'));
      assert.equal(await value.locator('.css-contrast-notice').textContent(), label('cssColorContrastNotice'));
      assert.equal(await value.locator('.ratio-unavailable').count(), 0);
      const expected = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(sample.ratio);
      assert.equal((await value.locator('.ratio,.audit-ratio').textContent()).trim(), expected + ' : 1');
      assert.equal(await value.locator('.contrast-target').count(), 0);
      assert.equal(await scope.locator('.assessment:not(.css-assessment)').count(), 0);
      const comparisons = scope.locator('.css-assessments[data-source="css-colors"]');
      assert.equal(await comparisons.count(), 1);
      assert.ok((await comparisons.textContent()).includes(label('cssColorsOnly')));
      assert.equal(await scope.locator('.css-page-unverified').count(), 1);
      assert.ok((await scope.locator('.css-page-unverified').textContent()).includes(label('cssPageUnverified')));
      if (sample.category === 'unknown') {
        assert.equal(await comparisons.locator('.css-assessment').count(), 0);
        assert.ok((await comparisons.textContent()).includes(label('cssThresholdUnknown')));
        assert.equal(await value.getAttribute('data-css-status'), null, 'Unknown font size cannot yield a threshold verdict');
      } else {
        assert.equal(await comparisons.locator('.css-assessment').count(), 2);
        assert.equal(await value.getAttribute('data-css-status'), sample[target].status);
        assert.ok((await value.textContent()).includes(message(catalog, 'cssColorTarget', [target])), 'Numeric color is explicitly scoped to the selected CSS color-pair target');
        for (const level of ['AA', 'AAA']) {
          const row = comparisons.locator(`.css-assessment[data-level="${level}"]`), expectedResult = sample[level];
          assert.equal(await row.getAttribute('data-comparison'), expectedResult.status);
          assert.ok((await row.textContent()).includes(message(catalog, 'cssThreshold', [level])));
          assert.ok((await row.textContent()).includes(label(expectedResult.status === 'pass' ? 'cssThresholdReached' : 'cssThresholdBelow')));
          assert.equal(await row.locator(`.badge.css-threshold.${expectedResult.status}`).count(), 1);
          assert.match((await row.locator('small').textContent()).replace(',', '.'), new RegExp(`${expectedResult.threshold}\\s*:\\s*1`));
        }
        const numericColor = await value.locator('.ratio,.audit-ratio').evaluate(node => getComputedStyle(node).color);
        const targetColor = await comparisons.locator(`.css-assessment[data-level="${target}"] .css-threshold`).evaluate(node => getComputedStyle(node).color);
        assert.equal(numericColor, targetColor, 'The labeled CSS ratio color follows only the selected CSS threshold');
        assert.equal(await value.locator('.ratio-unit').evaluate(node => getComputedStyle(node).color), numericColor);
      }
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'CSS contrast and its explanation fit a narrow sidebar');
    };
    const assertCSSCopy = (text, run, target = 'AAA') => {
      const sample = cssColorContrast(evaluateRun(run, target));
      assert.ok(sample);
      const line = text.split('\n').find(entry => entry.startsWith(label('cssColorContrast') + ': '));
      assert.ok(line);
      assert.ok(Math.abs(Number.parseFloat(line.slice(label('cssColorContrast').length + 2)) - sample.ratio) < 1e-12);
      assert.ok(text.includes(label('cssColorsOnly')));
      assert.ok(text.includes(label('cssColorContrastNotice')));
      assert.ok(text.includes(label('cssPageUnverified')));
      if (sample.category === 'unknown') {
        assert.ok(text.includes(label('cssThresholdUnknown')));
        for (const level of ['AA', 'AAA']) assert.ok(!text.includes(message(catalog, 'cssThreshold', [level]) + ':'));
      } else for (const level of ['AA', 'AAA']) {
        assert.ok(text.includes(`${message(catalog, 'cssThreshold', [level])}: ${label(sample[level].status === 'pass' ? 'cssThresholdReached' : 'cssThresholdBelow')} (≥ ${sample[level].threshold} : 1)`));
      }
    };
    const passFinding = page.locator('.finding[data-reference="pass-element"]');
    const normalGreen = await assertAssessment(passFinding, 'AA', 'pass', 'pass', 'fail');
    assert.equal(normalGreen.color, normalGreen.unitColor, 'The entire ratio, including : 1, conveys the target status');
    assert.match(await passFinding.locator('.audit-ratio').textContent(), /4[.,]95/);
    await assertAssessment(page.locator('.finding[data-reference="manual-element"]'), 'AA', 'manual', 'manual', 'manual');
    await assertAssessment(page.locator('.finding[data-reference="excluded-element"]'), 'AA', 'not-applicable', 'not-applicable', 'not-applicable');
    await page.setViewportSize({ width: 280, height: 800 });
    await assertCSSMeasurement(page.locator('.finding[data-reference="manual-element"]'), manualRun);
    await assertNoMeasurement(page.locator('.finding[data-reference="excluded-element"]'));
    await page.setViewportSize({ width: 380, height: 800 });
    const scansBeforeTargetChange = await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length);
    await passFinding.getByRole('button', { name: label('actionInspect'), exact: true }).click();
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-contrast');
    const mainAssessment = page.locator('.card').filter({ has: page.locator('.ratio') });
    assert.deepEqual(await assertAssessment(mainAssessment, 'AA', 'pass', 'pass', 'fail'), normalGreen);
    const normalRatio = await mainAssessment.locator('.ratio').textContent();
    await page.locator('.header button').click();
    await page.getByLabel(label('contrastTarget'), { exact: true }).selectOption('AAA');
    await page.locator('#tab-contrast').click();
    const normalRed = await assertAssessment(mainAssessment, 'AAA', 'fail', 'pass', 'fail');
    assert.notEqual(normalRed.color, normalGreen.color);
    assert.equal(normalRed.color, normalRed.unitColor);
    assert.equal(await mainAssessment.locator('.ratio').textContent(), normalRatio, 'A target change reassesses the same unmodified measurement');
    await page.locator('#tab-audit').click();
    assert.deepEqual(await assertAssessment(passFinding, 'AAA', 'fail', 'pass', 'fail'), normalRed);
    await page.locator('.footer button:first-child').click();
    assert.ok((await page.evaluate(() => window.__copied)).includes(`AA: ${label('statusPass')} (≥ 4.5 : 1)\nAAA: ${label('statusFail')} (≥ 7 : 1)`), 'The copied audit preserves both individual WCAG judgments');
    const copiedAudit = await page.evaluate(() => window.__copied);
    assert.ok(copiedAudit.includes(`${label('textContrast')}: ${label('statusNotApplicable')} · ${label('ratioUnavailable')}`), 'Excluded outcomes remain distinct from CSS-only comparisons');
    assertCSSCopy(copiedAudit, manualRun);
    assert.ok(copiedAudit.includes(label('cssColorContrast') + ': '));
    assert.ok(copiedAudit.includes(label('cssColorContrastNotice')));
    assert.doesNotMatch(copiedAudit, /[—-]\s*:\s*1/);

    const largeSnapshot = fixtureSnapshot({ ...fixtureRun('#707070', '#ffffff', 24), id: 'large-run' });
    await page.evaluate(selected => window.__emit({ selected: { ...selected, id: 'large-snapshot' }, selectionTab: 'contrast', lastEvent: 'selected' }), largeSnapshot);
    await assertAssessment(mainAssessment, 'AAA', 'pass', 'pass', 'pass', [3, 4.5]);
    assert.equal(await mainAssessment.locator('.ratio').textContent(), normalRatio, 'Large text changes thresholds, not the measured ratio');
    await page.evaluate(selected => window.__emit({ selected: { ...selected, id: 'manual-snapshot' }, selectionTab: 'contrast', lastEvent: 'selected' }), fixtureSnapshot(manualRun));
    await assertAssessment(mainAssessment, 'AAA', 'manual', 'manual', 'manual');
    await page.setViewportSize({ width: 280, height: 800 });
    await assertCSSMeasurement(mainAssessment, manualRun);
    for (const [run, status] of [[manualRun, 'statusManualReview'], [excludedRun, 'statusNotApplicable']]) {
      await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), fixtureSnapshot(run));
      if (run === manualRun) await assertCSSMeasurement(mainAssessment, run); else await assertNoMeasurement(mainAssessment);
      await page.locator('.footer button:first-child').click();
      const copied = await page.evaluate(() => window.__copied);
      if (run === manualRun) {
        assertCSSCopy(copied, run);
        assert.ok(!copied.includes(`${label('ratio')}: ${label('ratioUnavailable')}`));
        assert.ok(!copied.includes(`AA: ${label(status)}`));
        assert.ok(!copied.includes(`AAA: ${label(status)}`));
      } else {
        assert.ok(copied.includes(`${label('ratio')}: ${label('ratioUnavailable')}`));
        assert.ok(copied.includes(`AA: ${label(status)}`));
        assert.ok(copied.includes(`AAA: ${label(status)}`));
      }
      assert.doesNotMatch(copied, /[—-]\s*:\s*1/);
    }
    // CSS colors can produce a readable sample even while unmodeled page paint
    // prevents assessment. The sample must not imply that the real page passes.
    for (const cause of ['pseudo-element', 'filter', 'overlapping-element']) {
      const selected = fixtureSnapshot({ ...fixtureRun('#AAAAAA', '#0F0F0F', 14), reasons: [cause] });
      await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), selected);
      assert.equal(await page.getByRole('heading', { name: label('previewCSS'), exact: true }).count(), 1, 'Unverified colors are explicitly a CSS sample, not a verified page preview');
      const sample = page.locator('.card').filter({ has: page.getByRole('heading', { name: label('previewCSS'), exact: true }) });
      assert.equal(await sample.getByText(label('previewCSSNotice'), { exact: true }).count(), 1);
      assert.equal(await sample.getByText(label('previewCSSBackground'), { exact: true }).count(), 1);
      assert.equal(await sample.getByText(label('effectiveBackground'), { exact: true }).count(), 0);
      assert.deepEqual(await sample.locator('.color-preview').evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor })), { color: 'rgb(170, 170, 170)', background: 'rgb(15, 15, 15)' }, 'The CSS sample retains the measured CSS colors without pretending to reproduce page effects');
      await assertAssessment(mainAssessment, 'AAA', 'manual', 'manual', 'manual');
      await assertCSSMeasurement(mainAssessment, selected.textRuns[0]);
      assert.equal(await page.locator('.suggestion-card').count(), 0);
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Uncertainty explanation fits the 280px sidebar');
      await page.locator('.footer button:first-child').click();
      const report = await page.evaluate(() => window.__copied);
      assertCSSCopy(report, selected.textRuns[0]);
      assert.ok(!report.includes(label('ratio') + ': ' + label('ratioUnavailable')));
      assert.ok(report.includes(label('reason_' + cause.replaceAll('-', '_'))));
      await page.locator('.footer button:last-child').click();
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      const actualJSON = await page.locator('.code-preview').textContent();
      const exported = JSON.parse(actualJSON).textRuns[0];
      const expectedJSON = JSON.parse(serializeExport({ kind: 'element', snapshot: selected }, { version: '1.0.0', format: 'json', scope: 'all', colorFormat: 'hex', target: 'AAA' }).text);
      // Node and browser Math.pow may differ at the last floating-point bit.
      assert.ok(Math.abs(exported.cssColorContrast.ratio - expectedJSON.textRuns[0].cssColorContrast.ratio) < 1e-12);
      expectedJSON.textRuns[0].cssColorContrast.ratio = exported.cssColorContrast.ratio;
      assert.equal(actualJSON, JSON.stringify(expectedJSON, null, 2) + '\n', 'The preview and serializer preserve all raw measurements and explicitly separate the CSS ratio');
      assert.deepEqual(exported.foreground.rgba, selected.textRuns[0].foreground.rgba);
      assert.deepEqual(exported.effectiveBackground, selected.textRuns[0].effectiveBackground);
      assert.equal(exported.contrast.ratio, null); assert.equal(exported.contrast.reason, cause);
      assert.equal(exported.contrast.AA.status, 'manual'); assert.equal(exported.contrast.AAA.status, 'manual');
      assert.equal(exported.contrast.ratioKind, undefined, 'No speculative ratio or minimum is exported');
      assert.deepEqual({ ...exported.cssColorContrast, ratio: 0 }, { ...cssColorContrast(evaluateRun(selected.textRuns[0], 'AAA')), ratio: 0 }, 'The CSS-only ratio has its own explicitly unverified JSON field');
      await page.locator('.footer button:first-child').click();
      assert.equal(await page.evaluate(() => window.__copied), actualJSON);
      assert.deepEqual(await page.evaluate(() => window.__state.selected), selected);
    }
    const alphaSampleRun = evaluateRun({ ...amazonRun, reasons: ['filter'] }, 'AAA');
    await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), fixtureSnapshot(alphaSampleRun));
    await assertCSSMeasurement(mainAssessment, alphaSampleRun);
    assert.match(await mainAssessment.locator('.ratio').textContent(), /4[.,]03/);
    assert.equal(await page.locator('.color-preview').first().evaluate(node => getComputedStyle(node).color), 'rgba(17, 17, 17, 0.54)', 'The CSS-only contrast uses the original alpha shown by its sample');
    await page.locator('.footer button:first-child').click();
    const alphaReport = await page.evaluate(() => window.__copied);
    const alphaLine = alphaReport.split('\n').find(line => line.startsWith(label('cssColorContrast') + ': '));
    assert.ok(Math.abs(Number.parseFloat(alphaLine.slice(label('cssColorContrast').length + 2)) - 4.032916523267044) < 1e-12);
    assertCSSCopy(alphaReport, alphaSampleRun);
    assert.ok(!alphaReport.includes(label('ratio') + ': ' + label('ratioUnavailable')));
    await page.locator('.footer button:last-child').click();
    await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
    const alphaExport = JSON.parse(await page.locator('.code-preview').textContent()).textRuns[0];
    assert.deepEqual(alphaExport.foreground.rgba, amazonRGBA);
    assert.ok(Math.abs(alphaExport.cssColorContrast.ratio - 4.032916523267044) < 1e-12);
    assert.equal(alphaExport.contrast.ratio, null);
    assert.equal(alphaExport.contrast.AA.status, 'manual');
    assert.equal(alphaExport.contrast.AAA.status, 'manual');
    // The user's orange Amazon Buy Now pair is numerically useful even while
    // an uncertain overlay keeps the actual WCAG result unassessed.
    const amazonBuyRun = evaluateRun({ ...fixtureRun('#0F1111', '#FFA41C', 13), id: 'amazon-buy-run', elementRef: 'amazon-buy-element', reasons: ['overlapping-element'] }, 'AAA');
    const amazonBuySnapshot = fixtureSnapshot(amazonBuyRun), amazonBuyAudit = fixtureAudit([amazonBuyRun]);
    for (const width of [280, 380]) for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      await page.evaluate(({ selected, audit, appearance }) => window.__emit({ selected, audit, settings: { ...window.__state.settings, appearance }, selectionTab: 'contrast', lastEvent: 'selected' }), { selected: amazonBuySnapshot, audit: amazonBuyAudit, appearance });
      await assertCSSMeasurement(mainAssessment, amazonBuyRun);
      await assertAssessment(mainAssessment, 'AAA', 'manual', 'manual', 'manual');
      if (width === 380) await page.locator('main').screenshot({ path: path.join(root, `test-results/css-color-contrast-${locale}-${appearance}.png`) });
      assert.equal(await page.locator('.suggestion-card').count(), 0);
      await page.locator('#tab-audit').click();
      const row = page.locator('.finding[data-reference="amazon-buy-element"]');
      await assertCSSMeasurement(row, amazonBuyRun);
      await assertAssessment(row, 'AAA', 'manual', 'manual', 'manual');
      assert.equal(await contrastOverview.locator('.metric-count.pass .metric-count-value').textContent(), '0');
      assert.equal(await contrastOverview.locator('.metric-count.manual .metric-count-value').textContent(), '1');
      await page.locator('.footer button:first-child').click();
      const copied = await page.evaluate(() => window.__copied);
      const cssLine = copied.split('\n').find(line => line.startsWith(label('cssColorContrast') + ': '));
      assert.ok(Math.abs(Number.parseFloat(cssLine.slice(label('cssColorContrast').length + 2)) - 9.54274942553824) < 1e-12);
      assertCSSCopy(copied, amazonBuyRun);
      assert.ok(!copied.includes(`${label('textContrast')}: ${label('statusManualReview')} · ${label('ratioUnavailable')}`));
      assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit })), { selected: amazonBuySnapshot, audit: amazonBuyAudit });
    }
    // A CSS-only threshold result is useful without becoming a confirmed page
    // finding. Exercise split outcomes, both targets and unknown typography.
    const cssCases = [
      ['pass', fixtureRun('#0F1111', '#FFA41C', 13), 'pass', 'pass', [4.5, 7]],
      ['split', fixtureRun('#707070', '#FFFFFF', 16), 'pass', 'fail', [4.5, 7]],
      ['fail', fixtureRun('#AAAAAA', '#FFFFFF', 16), 'fail', 'fail', [4.5, 7]],
      ['large', fixtureRun('#888888', '#FFFFFF', 24), 'pass', 'fail', [3, 4.5]],
      ['unknown', { ...fixtureRun('#0F1111', '#FFA41C', 13), fontSizeCssPx: null }, undefined, undefined, undefined],
    ].map(([name, raw, AA, AAA, thresholds]) => ({ name, run: evaluateRun({ ...raw, id: `css-${name}-run`, elementRef: `css-${name}-element`, reasons: ['overlapping-element'] }, 'AA'), AA, AAA, thresholds }));
    const confirmedFail = { ...fixtureRun('#AAAAAA', '#FFFFFF', 16), id: 'confirmed-fail', elementRef: 'confirmed-fail' };
    const confirmedPass = { ...fixtureRun('#000000', '#FFFFFF', 16), id: 'confirmed-pass', elementRef: 'confirmed-pass' };
    const noPair = evaluateRun({ ...fixtureRun('#000000', '#FFFFFF', 16), id: 'no-pair', elementRef: 'no-pair', effectiveBackground: null, reasons: ['layered-background'] }, 'AA');
    const mixedAudit = fixtureAudit([...cssCases.map(item => item.run), confirmedFail, confirmedPass, excludedRun, noPair]);
    const scanCountBeforeCSS = await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length);
    for (const width of [280, 380]) for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 800 });
      for (const { name, run, AA, AAA, thresholds } of cssCases) for (const target of ['AA', 'AAA']) {
        const selected = fixtureSnapshot(run);
        await page.evaluate(({ selected, audit, appearance, target }) => window.__emit({ selected, audit, settings: { ...window.__state.settings, appearance, contrastTarget: target }, selectionTab: 'contrast', lastEvent: 'selected' }), { selected, audit: mixedAudit, appearance, target });
        await assertCSSMeasurement(mainAssessment, run);
        await assertAssessment(mainAssessment, target, 'manual', 'manual', 'manual');
        const comparisons = mainAssessment.locator('.css-assessments');
        if (name !== 'unknown') for (const [index, level] of ['AA', 'AAA'].entries()) {
          assert.equal(await comparisons.locator(`.css-assessment[data-level="${level}"]`).getAttribute('data-comparison'), level === 'AA' ? AA : AAA);
          assert.match((await comparisons.locator(`.css-assessment[data-level="${level}"] small`).textContent()).replace(',', '.'), new RegExp(`${thresholds[index]}\\s*:\\s*1`));
        }
        assert.equal(await page.locator('.suggestion-card').count(), 0, 'CSS-only failures cannot produce page-change suggestions');
        await page.locator('.footer button:first-child').click();
        const copied = await page.evaluate(() => window.__copied);
        assertCSSCopy(copied, run, target);
        assert.ok(!copied.includes(`AA: ${label('statusManualReview')}`));
        assert.ok(!copied.includes(`AAA: ${label('statusManualReview')}`));
        if (width === 280 && appearance === 'light' && target === 'AAA') {
          await page.locator('.footer button:last-child').click();
          await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
          const exported = JSON.parse(await page.locator('.code-preview').textContent()).textRuns[0];
          assert.equal(exported.contrast.ratio, null);
          assert.equal(exported.contrast.status, 'manual');
          assert.equal(exported.contrast.AA.status, 'manual');
          assert.equal(exported.contrast.AAA.status, 'manual');
          assert.equal(exported.cssColorContrast.verified, false);
          for (const [index, level] of ['AA', 'AAA'].entries()) assert.deepEqual(exported.cssColorContrast[level], name === 'unknown' ? undefined : { threshold: thresholds[index], status: level === 'AA' ? AA : AAA });
          await page.locator('#tab-contrast').click();
        }
        assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit })), { selected, audit: mixedAudit }, 'UI threshold comparisons never rewrite actual measurements or counts');
      }
      await page.locator('#tab-audit').click();
      assert.equal(await contrastOverview.locator('.metric-count.pass .metric-count-value').textContent(), '1');
      assert.equal(await contrastOverview.locator('.metric-count.fail .metric-count-value').textContent(), '1');
      assert.equal(await contrastOverview.locator('.metric-count.manual .metric-count-value').textContent(), '6');
      assert.equal(await contrastOverview.locator('.metric-count.not-applicable .metric-count-value').textContent(), '1');
      assert.equal(await fontOverview.locator('.metric-count.manual .metric-count-value').textContent(), '1', 'Unknown typography remains counted separately from missing contrast values');
      assert.equal(label('filterManual'), locale === 'de' ? 'Keine Messwerte' : 'No values');
      for (const [id,key,count] of [['all','all',9],['contrast','filterContrast',1],['small','filterSmall',0],['manual','filterManual',1],['css','filterCSSPairs',5]]) {
        assert.equal(await page.locator(`.filter-bar button[data-filter="${id}"]`).textContent(), `${label(key)} (${count})`);
      }
      assert.ok((await contrastOverview.locator('.metric-count.manual .metric-count-label').textContent()).includes(label('cssPageUnverified')));
      if (width === 380) {
        const aligned = await page.locator('.audit-overview').evaluate(node => ['.metric-label', '.metric-description', ...['pass','fail','manual','not-applicable'].map(status => `.metric-count.${status}`), '.metric-total'].every(selector => {
          const [left, right] = [...node.querySelectorAll('.audit-metric')].map(card => card.querySelector(selector).getBoundingClientRect());
          return Math.abs(left.top - right.top) < 1 && Math.abs(left.height - right.height) < 1;
        }));
        assert.ok(aligned, 'Both overview columns keep corresponding headings, wrapped labels, counts and totals aligned');
        await page.locator('.audit-overview').screenshot({ path: path.join(root, `test-results/audit-overview-${locale}-${appearance}.png`) });
      }
      await page.locator('.filter-bar button[data-filter="css"]').click();
      assert.equal(await page.locator('.finding').count(), 5);
      const cssReferences = await page.locator('.finding').evaluateAll(nodes => nodes.map(node => node.dataset.reference));
      assert.deepEqual(cssReferences.sort(), cssCases.map(item => item.run.elementRef).sort());
      assert.ok(cssReferences.includes('css-unknown-element'), 'A numeric CSS ratio with unassessable font size belongs to CSS pairs, not No values');
      await page.locator('.filter-bar button[data-filter="contrast"]').click();
      assert.equal(await page.locator('.finding').count(), 1);
      assert.equal(await page.locator('.finding').getAttribute('data-reference'), confirmedFail.elementRef, 'CSS-only failures stay out of the confirmed contrast-problem filter');
      await page.locator('.filter-bar button[data-filter="manual"]').click();
      const missingReferences = await page.locator('.finding').evaluateAll(nodes => nodes.map(node => node.dataset.reference));
      assert.deepEqual(missingReferences, [noPair.elementRef], 'No measurement excludes CSS pairs, actual pass/fail and not-applicable runs');
      assert.ok(missingReferences.every(reference => !cssReferences.includes(reference)), 'CSS pairs and absent measurements are disjoint');
      assert.equal(await page.locator('.finding .ratio-unavailable').textContent(), label('ratioUnavailable'));
      assert.equal(await page.locator('.finding .css-contrast-label').count(), 0);
      // Updating the snapshot while this filter is active must update its count
      // and empty state without hiding available CSS pairs or fabricating rows.
      await page.evaluate(audit => window.__emit({ audit, lastEvent: 'ready' }), fixtureAudit(mixedAudit.runs.filter(run => run.id !== noPair.id)));
      assert.equal(await page.locator('.filter-bar button[data-filter="manual"]').getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.filter-bar button[data-filter="manual"]').textContent(), `${label('filterManual')} (0)`);
      assert.equal(await page.locator('.finding').count(), 0);
      assert.equal(await page.getByText(label('noFindings'), { exact: true }).count(), 1);
      assert.equal(await page.locator('.filter-bar button[data-filter="css"]').textContent(), `${label('filterCSSPairs')} (5)`);
      await page.evaluate(audit => window.__emit({ audit, lastEvent: 'ready' }), mixedAudit);
      assert.equal(await page.locator('.finding').getAttribute('data-reference'), noPair.elementRef);
      await page.locator('.filter-bar button[data-filter="all"]').click();
      assert.equal(await page.locator('.finding').count(), 9);
    }
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scanCountBeforeCSS, 'Target switches and CSS filtering never trigger a hidden rescan');
    await page.evaluate(audit => window.__emit({ audit, settings: { ...window.__state.settings, appearance: 'system' }, lastEvent: 'ready' }), audit);
    await page.setViewportSize({ width: 280, height: 800 });
    for (const missing of ['background', 'foreground']) {
      const run = { ...fixtureRun('#AAAAAA', '#0F0F0F', 14), reasons: [missing === 'background' ? 'layered-background' : 'unsupported-color'] };
      if (missing === 'background') run.effectiveBackground = null;
      else run.foreground = { raw: 'color(display-p3 1 0 0)', rgba: null, reason: 'unsupported-color' };
      await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), fixtureSnapshot(run));
      const sample = page.locator('.card').filter({ has: page.getByRole('heading', { name: label('previewColor'), exact: true }) });
      assert.equal(await sample.locator('.color-preview').count(), 0, 'A missing color pair has no invented sample on the sidebar background');
      assert.equal(await sample.getByText(label('previewUnavailable'), { exact: true }).count(), 1);
      await assertNoMeasurement(mainAssessment);
    }
    await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), fixtureSnapshot(fixtureRun('#AAAAAA', '#0F0F0F', 14)));
    const verifiedPreview = page.locator('.card').filter({ has: page.getByRole('heading', { name: label('previewColor'), exact: true }) });
    assert.equal(await verifiedPreview.locator('.color-preview').count(), 1, 'Resolved contrast keeps its normal color preview');
    assert.equal(await page.getByText(label('previewCSSNotice'), { exact: true }).count(), 0);
    assert.equal(await verifiedPreview.getByText(label('effectiveBackground'), { exact: true }).count(), 1);
    await assertAssessment(mainAssessment, 'AAA', 'pass', 'pass', 'pass');
    // Placeholder measurements remain explicitly labeled and never suggest a
    // generic element-color edit that would fail to update ::placeholder.
    const placeholderRun = { ...fixtureRun('#aaaaaa', '#ffffff', 16), id: 'placeholder-run', elementRef: 'placeholder-element', tagName: 'input', textSource: 'placeholder' };
    const placeholderSnapshot = fixtureSnapshot(placeholderRun);
    placeholderSnapshot.styles.colors.color = '#000000';
    await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), placeholderSnapshot);
    await assertAssessment(mainAssessment, 'AAA', 'fail', 'fail', 'fail');
    assert.ok((await mainAssessment.locator('.contrast-value').textContent()).includes(label('placeholderText')));
    assert.equal(await page.getByText(label('placeholderSuggestionsUnavailable'), { exact: true }).count(), 1);
    assert.equal(await page.getByLabel(label('suggestions'), { exact: true }).count(), 0);
    assert.equal(await page.locator('.suggestion-card').count(), 0);
    await page.locator('.footer button:first-child').click();
    assert.ok((await page.evaluate(() => window.__copied)).includes(label('placeholderText')));
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'ready' }), fixtureAudit([placeholderRun]));
    await page.locator('#tab-audit').click();
    const placeholderFinding = page.locator('.finding[data-reference="placeholder-element"]');
    assert.ok((await placeholderFinding.locator('.contrast-value').textContent()).includes(label('placeholderText')));
    assert.equal(await placeholderFinding.getByRole('button', { name: label('actionSuggestions'), exact: true }).count(), 0);
    await page.locator('.footer button:first-child').click();
    assert.ok((await page.evaluate(() => window.__copied)).includes(label('placeholderText')));

    // A supported gradient gives a conservative lower bound, never an exact
    // flat background or a confirmed failure based only on that lower bound.
    const boundaryChannel = 255 * (1.055 * (4.499 * 0.05 - 0.05) ** (1 / 2.4) - 0.055);
    const gradientRuns = [
      ['both', '#000000', 238, 255],
      ['aa', '#555555', 238, 255],
      ['uncertain', '#777777', 0, 255],
      ['boundary', '#000000', boundaryChannel, 255],
    ].map(([id, foreground, min, max]) => ({
      ...fixtureRun(foreground, '#ffffff', 16), id: 'gradient-' + id, elementRef: 'gradient-' + id,
      effectiveBackground: null, ownOpaqueBackground: false,
      backgroundRange: { min: { r: min, g: min, b: min, a: 1 }, max: { r: max, g: max, b: max, a: 1 } },
    }));
    await page.setViewportSize({ width: 280, height: 800 });
    for (const target of ['AA', 'AAA']) {
      await page.locator('.header button').click();
      await page.getByLabel(label('contrastTarget'), { exact: true }).selectOption(target);
      for (const [index, run] of gradientRuns.entries()) {
        const selected = fixtureSnapshot(run);
        selected.styles.colors['background-color'] = 'transparent';
        await page.evaluate(selected => window.__emit({ selected, selectionTab: 'contrast', lastEvent: 'selected' }), selected);
        const ratio = mainAssessment.locator('.ratio');
        assert.match(await ratio.textContent(), /^≥ /, 'A gradient result explicitly displays a minimum, not an exact pixel measurement');
        assert.ok((await ratio.getAttribute('title')).startsWith('≥ '));
        assert.ok((await ratio.getAttribute('title')).includes(label('contrastMinimum')));
        assert.equal(await mainAssessment.getByText(label('contrastMinimum'), { exact: true }).count(), 1);
        const aa = index >= 2 ? 'manual' : 'pass';
        const aaa = index === 0 ? 'pass' : 'manual';
        const colors = await assertAssessment(mainAssessment, target, target === 'AA' ? aa : aaa, aa, aaa);
        if (index === 2) assert.equal(await ratio.textContent(), '≥ 1 : 1', 'A background range spanning the text luminance remains inconclusive');
        if (index === 3) assert.match(await ratio.textContent(), /^≥ 4[.,]49 : 1$/, 'A rounded lower-bound label cannot claim a higher guaranteed minimum');
        if (target === 'AAA' && index > 0) {
          assert.notEqual(colors.color, normalGreen.color, 'An inconclusive minimum is not shown as a pass');
          assert.notEqual(colors.color, normalRed.color, 'An inconclusive minimum is not shown as a failure');
        }
        assert.equal(await mainAssessment.locator('.badge.fail').count(), 0);
        const preview = page.locator('.card').filter({ has: page.getByRole('heading', { name: label('previewColor'), exact: true }) });
        assert.equal(await preview.locator('.color-preview').count(), 0, 'A gradient is never represented by a fabricated flat-color sample');
        assert.equal(await preview.locator('.color-detail').count(), 1, 'Only the actual foreground gets a color swatch');
        assert.equal(await preview.getByText(label('gradientBackground'), { exact: true }).count(), 1);
        assert.equal(await page.locator('.suggestion-card').count(), 0);
        assert.equal(await page.getByLabel(label('suggestions'), { exact: true }).count(), 0);
        assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Minimum labels fit a 280px sidebar');
        await page.locator('.footer button:first-child').click();
        const report = await page.evaluate(() => window.__copied);
        assert.ok(report.includes(label('ratio') + ': ≥ '));
        assert.ok(report.includes(label('contrastMinimum')));
        assert.ok(report.includes(label('gradientBackground')));
        await page.locator('#tab-colors').click();
        assert.equal(await page.getByText(label('gradientBackground'), { exact: true }).count(), 1);
        assert.equal(await page.locator('.color-row .color-name').filter({ hasText: label('effectiveBackground') }).count(), 0);
      }
      await page.evaluate(audit => window.__emit({ audit, lastEvent: 'ready' }), fixtureAudit(gradientRuns));
      await page.locator('#tab-audit').click();
      const counts = page.locator('.audit-metric[data-rule="contrast"]');
      assert.equal(await counts.locator('.metric-count.pass .metric-count-value').textContent(), target === 'AA' ? '2' : '1');
      assert.equal(await counts.locator('.metric-count.manual .metric-count-value').textContent(), target === 'AA' ? '2' : '3');
      assert.equal(await counts.locator('.metric-count.fail .metric-count-value').textContent(), '0');
      for (const run of gradientRuns) {
        const finding = page.locator('.finding[data-reference="' + run.elementRef + '"]');
        assert.match(await finding.locator('.audit-ratio').textContent(), /^≥ /);
        assert.equal(await finding.getByRole('button', { name: label('actionSuggestions'), exact: true }).count(), 0);
      }
      await page.locator('.footer button:first-child').click();
      const report = await page.evaluate(() => window.__copied);
      assert.ok(report.includes('≥ 1 : 1'));
      assert.ok(report.includes(label('contrastMinimum')));
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      // A measured conservative minimum is still a value, even when it cannot
      // establish AA/AAA. Neither the missing-value nor CSS-pair filter owns it.
      for (const [id, key] of [['manual', 'filterManual'], ['css', 'filterCSSPairs']]) {
        assert.equal(await page.locator(`.filter-bar button[data-filter="${id}"]`).textContent(), `${label(key)} (0)`);
        await page.locator(`.filter-bar button[data-filter="${id}"]`).click();
        assert.equal(await page.locator('.finding').count(), 0);
        assert.equal(await page.getByText(label('noFindings'), { exact: true }).count(), 1);
      }
      await page.locator('.filter-bar button[data-filter="all"]').click();
      assert.equal(await page.locator('.finding').count(), gradientRuns.length);
    }
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'ready' }), audit);
    await page.setViewportSize({ width: 380, height: 800 });
    await page.locator('.header button').click();
    await page.getByLabel(label('contrastTarget'), { exact: true }).selectOption('AA');
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scansBeforeTargetChange);
    await page.evaluate(selected => window.__emit({ selected, selectionTab: undefined, selectionOrigin: undefined, lastEvent: 'ready' }), snapshot);
    await page.locator('#tab-audit').click();

    // Unassessable contrast is not a failure and does not disable locating live nodes.
    await page.locator('.filter-bar button[data-filter="css"]').click();
    assert.equal(await page.locator('.finding').count(), 1);
    const manualFinding = page.locator('.finding[data-reference="manual-element"]');
    const showManual = manualFinding.getByRole('button', { name: label('actionShow'), exact: true });
    assert.equal(await showManual.isEnabled(), true);
    assert.equal(await showManual.evaluate(node => node.classList.contains('show-node')), true, 'Locating an audit result has a dedicated visual action');
    await showManual.click();
    assert.equal(await showManual.isEnabled(), true, 'A stale measurement must not disable its live node reference');
    await showManual.click();
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'show-node').length), 2);
    assert.ok(await page.evaluate(() => window.__commands.filter(command => command.type === 'show-node').every(command => command.referenceId === 'manual-element')), 'The prominent action locates the element belonging to its own finding');
    await page.evaluate(() => { window.__removeTarget = true; }); await showManual.click();
    assert.equal(await showManual.isDisabled(), true);
    assert.equal(await manualFinding.locator('.finding-actions-help').textContent(), label('auditActionsExpired'));
    await page.evaluate(() => { window.__removeTarget = false; });
    await page.locator('.filter-bar button[data-filter="all"]').click();

    // Settings persist immediately without losing keyboard focus or launching work.
    await page.locator('.header button').click();
    await page.getByLabel(label('appearance'), { exact: true }).focus();
    await page.getByLabel(label('appearance'), { exact: true }).selectOption('dark');
    assert.equal(await page.locator(':focus').getAttribute('id'), await page.getByLabel(label('appearance'), { exact: true }).getAttribute('id'));
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByLabel(label('livePreview'), { exact: false }).uncheck();
    assert.equal(await page.evaluate(() => window.__state.settings.livePreview), false);
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    await page.getByRole('button', { name: label('clearData'), exact: true }).click();
    await page.getByRole('button', { name: label('actionCancel'), exact: true }).click();
    assert.ok(await page.evaluate(() => window.__state.selected));
    assert.ok(!(await page.evaluate(() => window.__commands.map(command => command.type))).includes('start-audit'));

    // A dropped runtime connection recovers through ready only and preserves the open tab.
    await page.locator('#tab-colors').click();
    const commandsBeforeReconnect = await page.evaluate(() => window.__commands.length);
    await page.evaluate(() => window.__disconnect());
    assert.equal(await page.locator('.picker').isDisabled(), true);
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    await page.waitForFunction(() => window.__connectionCount === 2 && window.__commands.at(-1).type === 'ready');
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-colors');
    assert.equal(await page.locator('.footer button:disabled').count(), 0);
    assert.deepEqual(await page.evaluate(index => window.__commands.slice(index).map(command => command.type), commandsBeforeReconnect), ['ready']);

    // A preview cannot leak into element copy/export, while confirmed audits remain available.
    await page.locator('#tab-colors').click();
    await page.evaluate(snapshot => window.__emit({ picker: true, preview: { ...snapshot, id: 'preview-snapshot' }, lastEvent: 'preview' }), snapshot);
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    await page.locator('#tab-audit').click(); assert.equal(await page.locator('.footer button:disabled').count(), 0);
    await page.evaluate(() => window.__emit({ picker: false, preview: null, lastEvent: 'picker-cancelled' }));
    await page.locator('#tab-colors').click(); await page.locator('.footer button:first-child').click();
    assert.match(await page.evaluate(() => window.__copied), /--sil-color-001:/);

    // Clipboard denial produces a selectable fallback containing exactly the intended bytes.
    const expectedColors = await page.evaluate(() => window.__copied);
    await page.evaluate(() => { window.__failClipboard = true; });
    await page.locator('.footer button:first-child').click();
    assert.equal(await page.locator('.clipboard-fallback').inputValue(), expectedColors);
    assert.equal(await page.locator('.clipboard-fallback').evaluate(node => node.selectionEnd - node.selectionStart), expectedColors.length);
    await page.evaluate(() => { window.__failClipboard = false; });
    await page.locator('.footer button:first-child').click();
    assert.equal(await page.evaluate(() => window.__copied), expectedColors);
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'A successful retry removes the obsolete manual-copy fallback');

    // A late clipboard denial cannot resurrect discarded analysis or supersede a newer copy.
    for (const boundary of ['document-changed', 'audit-reset', 'data-cleared', 'new-copy']) {
      await page.evaluate(({ selected, audit }) => window.__emit({ selected, audit, documentToken: selected.document.documentToken, lastEvent: 'ready' }), { selected: snapshot, audit });
      await page.locator('#tab-colors').click();
      await page.evaluate(() => { window.__deferClipboard = true; });
      await page.locator('.footer button:first-child').click();
      assert.ok(await page.evaluate(() => window.__clipboardRequests.length > 0));
      await page.evaluate(() => { window.__deferClipboard = false; });
      if (boundary === 'new-copy') await page.locator('.footer button:first-child').click();
      else await page.evaluate(boundary => window.__emit({ selected: null, audit: null, ...(boundary === 'document-changed' ? { documentToken: 'clipboard-new-document' } : {}), lastEvent: boundary }), boundary);
      await page.evaluate(() => { window.__clipboardRequests.shift().reject(new Error('Delayed clipboard denial')); });
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${boundary}: discarded clipboard text must not reappear`);
      if (boundary === 'new-copy') assert.equal(await page.locator('.toast').textContent(), label('statusCopied'), 'An older rejected copy cannot replace the newer successful result');
    }
    await page.evaluate(({ selected, audit }) => window.__emit({ selected, audit, documentToken: selected.document.documentToken, lastEvent: 'ready' }), { selected: snapshot, audit });
    await page.locator('#tab-colors').click();

    // Leaving the copy's view discards both an existing fallback and a pending
    // denial, even if the user returns before that older request finishes.
    const leaveCopyView = async boundary => {
      if (boundary === 'tab') await page.locator('#tab-layout').click();
      else if (boundary === 'settings') await page.locator('.header button').click();
      else await page.locator('.footer button:last-child').click();
    };
    for (const boundary of ['tab', 'settings', 'export']) {
      await page.evaluate(() => { window.__failClipboard = true; });
      await page.locator('.footer button:first-child').click();
      assert.equal(await page.locator('.clipboard-fallback').count(), 1);
      await leaveCopyView(boundary);
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${boundary}: leaving the view removes its old manual-copy fallback`);
      await page.locator('#tab-colors').click();
      await page.evaluate(() => { window.__failClipboard = false; window.__deferClipboard = true; });
      await page.locator('.footer button:first-child').click();
      await leaveCopyView(boundary);
      await page.locator('#tab-colors').click();
      await page.evaluate(async () => { window.__clipboardRequests.at(-1).reject(new Error('Clipboard denied after leaving its view')); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${boundary}: returning to the view cannot revive a discarded copy request`);
      await page.evaluate(() => { window.__deferClipboard = false; });
    }

    // Source data and output preferences are frozen for a reviewed export draft.
    await page.locator('.footer button:last-child').click();
    await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
    const frozen = await page.locator('.code-preview').textContent();
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, colorFormat: 'hsl' }, lastEvent: 'settings' }));
    assert.equal(await page.locator('.code-preview').textContent(), frozen);
    await page.locator('.footer button:last-child').click();
    assert.ok(!(await page.evaluate(() => window.__commands.map(command => command.type))).includes('save-export'));
    assert.equal(await page.locator('.code-preview').textContent(), frozen);
    await page.locator('.footer button:first-child').click(); assert.equal(await page.evaluate(() => window.__copied), frozen);
    await page.evaluate(() => { window.__downloadPermission = true; }); await page.locator('.footer button:last-child').click();
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').at(-1).text), frozen);

    // The bytes remain frozen, but an explicit export-control change abandons
    // the old copy intent. Switching back must not resurrect a late fallback.
    for (const [key, alternate, original] of [['exportFormat', 'css', 'json'], ['exportScope', 'colors', 'all'], ['exportSource', 'page-tokens', 'element']]) {
      const control = page.getByLabel(label(key), { exact: true });
      await page.evaluate(() => { window.__failClipboard = true; });
      await page.locator('.footer button:first-child').click();
      assert.equal(await page.locator('.clipboard-fallback').inputValue(), frozen);
      await control.selectOption(alternate);
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${key}: an export change immediately removes obsolete fallback bytes`);
      await control.selectOption(original);
      assert.equal(await page.locator('.code-preview').textContent(), frozen);
      await page.evaluate(() => { window.__failClipboard = false; window.__deferClipboard = true; });
      await page.locator('.footer button:first-child').click();
      await control.selectOption(alternate); await control.selectOption(original);
      await page.evaluate(async () => { window.__clipboardRequests.at(-1).reject(new Error('Clipboard denied after changing export output')); await new Promise(resolve => setTimeout(resolve, 0)); });
      assert.equal(await page.locator('.clipboard-fallback').count(), 0, `${key}: restored controls cannot revive an old export-copy fallback`);
      assert.equal(await page.locator('.code-preview').textContent(), frozen, 'Decorated preview retains the exact reviewed export bytes');
      await page.evaluate(() => { window.__deferClipboard = false; });
    }

    // One save intent survives unrelated settings renders, but never changes its
    // bytes or survives a discarded draft/connection while permission is pending.
    await page.evaluate(() => { window.__deferDownloadPermission = true; });
    const savesBeforePermission = await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').length);
    await page.locator('.footer button:last-child').click();
    const permissionRequests = await page.evaluate(() => window.__permissionRequests.length);
    assert.equal(await page.locator('.footer button:last-child').isDisabled(), true);
    await page.locator('.footer button:last-child').evaluate(node => node.click());
    assert.equal(await page.evaluate(() => window.__permissionRequests.length), permissionRequests, 'A pending save cannot ask twice');
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, appearance: 'dark' }, lastEvent: 'settings' }));
    assert.equal(await page.locator('.code-preview').textContent(), frozen);
    assert.equal(await page.locator('.footer button:first-child').isEnabled(), true, 'Copy stays available while download permission is pending');
    await page.evaluate(() => window.__resolveDownloadPermission(true));
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').length), savesBeforePermission + 1);
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').at(-1).text), frozen, 'Theme updates cannot discard an unchanged save intent');
    for (const boundary of ['format-change', 'disconnect', 'data-cleared']) {
      await page.locator('#tab-colors').click();
      await page.locator('.footer button:last-child').click();
      const before = await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').length);
      await page.locator('.footer button:last-child').click();
      if (boundary === 'format-change') await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      else if (boundary === 'disconnect') {
        const connections = await page.evaluate(() => window.__connectionCount);
        await page.evaluate(() => window.__disconnect());
        await page.waitForFunction(count => window.__connectionCount > count, connections);
      } else await page.evaluate(() => window.__emit({ selected: null, audit: null, lastEvent: 'data-cleared' }));
      await page.evaluate(() => window.__resolveDownloadPermission(true));
      assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'save-export').length), before, `${boundary}: pending permission cannot save a discarded draft`);
    }
    await page.evaluate(({ selected, audit }) => { window.__deferDownloadPermission = false; window.__emit({ selected, audit, lastEvent: 'ready' }); }, { selected: snapshot, audit });

    // Suggestion tiles show and copy the same exact hex, independently of the
    // normal export preference. Reading/copying a recommendation cannot apply it.
    await page.locator('#tab-contrast').click(); const ratio = await page.locator('.ratio').textContent();
    let suggestionHex;
    for (const colorFormat of ['hex', 'rgb', 'hsl']) {
      await page.locator('.header button').click();
      await page.getByLabel(label('colorFormat'), { exact: true }).selectOption(colorFormat);
      await page.locator('#tab-contrast').click();
      await page.locator('.footer button:last-child').click();
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      const originalExport = await page.locator('.code-preview').textContent();
      await page.locator('#tab-contrast').click();
      const unchanged = await page.evaluate(() => ({ selected: structuredClone(window.__state.selected), audit: structuredClone(window.__state.audit), commands: window.__commands.length }));
      const card = page.locator('.suggestion-card').first();
      assert.equal(await card.locator('.suggestion-colors .suggestion-color').count(), 2);
      for (const side of ['before', 'after']) {
        const tile = card.locator(`.suggestion-color[data-side="${side}"]`);
        const hex = await tile.locator('code.suggestion-hex').textContent();
        assert.match(hex, /^#[A-F\d]{6}$/, `${locale}/${colorFormat}/${side}: the visible value is uppercase HEX`);
        if (side === 'before') assert.equal(hex, '#AAAAAA');
        else { suggestionHex ??= hex; assert.equal(hex, suggestionHex, 'The same recommendation remains visible across display preferences'); assert.notEqual(hex, '#AAAAAA'); }
        assert.ok((await tile.textContent()).includes(label(side === 'before' ? 'before' : 'suggestion')), 'Original and recommendation are labeled separately');
        const channels = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
        assert.equal(await tile.locator('.swatch span').evaluate(node => getComputedStyle(node).backgroundColor), `rgb(${channels.join(', ')})`, 'The swatch matches the adjacent hex code');
        const sample = await card.locator('.compare .color-preview').nth(side === 'before' ? 0 : 1).evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
        assert.deepEqual(sample, { color: `rgb(${channels.join(', ')})`, background: 'rgb(255, 255, 255)' }, 'The sample shows the matching original or proposed text color on the unchanged background');
        const copyColor = tile.getByRole('button', { name: message(catalog, 'actionCopyValue', [hex]), exact: true });
        assert.equal(await copyColor.isEnabled(), true);
        await copyColor.click();
        assert.equal(await page.evaluate(() => window.__copied), hex, `${locale}/${colorFormat}/${side}: copying preserves exactly the displayed hex`);
      }
      assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit, commands: window.__commands.length })), unchanged, 'Copying colors cannot change the measurement, start a scan or issue page commands');
      assert.equal(await page.locator('.ratio').textContent(), ratio);
      await page.locator('.footer button:last-child').click();
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      assert.equal(await page.locator('.code-preview').textContent(), originalExport, 'The normal element export still contains the original colors');
      await page.locator('#tab-contrast').click();
    }

    // A fixed fill can match the measured CSS color while ignoring a later
    // color correction. Explain the accompanying reset before exporting it.
    const beforeTextFill = await page.evaluate(() => structuredClone(window.__state.selected));
    assert.equal(await page.locator('.suggestion-card').getByText(label('suggestionTextFillReset'), { exact: true }).count(), 0, 'Ordinary recommendations have no fill-reset note');
    for (const textFillPresent of [true, false]) {
      const selected = { ...beforeTextFill, id: `same-color-fill-${textFillPresent}`, textRuns: beforeTextFill.textRuns.map(run => ({ ...run, foregroundSource: undefined, textFillPresent })) };
      await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), selected);
      const note = page.locator('.suggestion-card').getByText(label('suggestionTextFillReset'), { exact: true });
      assert.equal(await note.count(), textFillPresent ? await page.locator('.suggestion-card').count() : 0, 'The card explains only a required glyph-fill reset');
      if (textFillPresent) {
        await page.getByLabel(label('suggestions'), { exact: true }).selectOption('background-color');
        assert.equal(await note.count(), 0, 'Changing the background requires no glyph-fill reset');
        await page.getByLabel(label('suggestions'), { exact: true }).selectOption('color');
      }
      await page.locator('.suggestion-card').first().getByRole('button', { name: label('actionExportSuggestion'), exact: true }).click();
      assert.equal((await page.locator('.code-preview').textContent()).includes('-webkit-text-fill-color: currentColor;'), textFillPresent, 'CSS exports include exactly the reset explained by the card');
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      const exported = JSON.parse(await page.locator('.code-preview').textContent());
      assert.equal(exported.conditions.includes('text-fill-reset-to-currentcolor'), textFillPresent);
      assert.deepEqual(exported.additionalDeclarations, textFillPresent ? [{ property: '-webkit-text-fill-color', value: 'currentColor' }] : undefined);
      await page.locator('#tab-contrast').click();
    }
    await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), beforeTextFill);

    // Background recommendations refer to the changed background, never to
    // the unchanged foreground shown by the default text-color mode.
    const beforeBackgroundCopy = await page.evaluate(() => ({ selected: structuredClone(window.__state.selected), audit: structuredClone(window.__state.audit), commands: window.__commands.length }));
    await page.getByLabel(label('suggestions'), { exact: true }).selectOption('background-color');
    const backgroundCard = page.locator('.suggestion-card').first();
    assert.equal(await backgroundCard.locator('h3').textContent(), label('changeBackground'));
    for (const side of ['before', 'after']) {
      const tile = backgroundCard.locator(`.suggestion-color[data-side="${side}"]`);
      const hex = await tile.locator('code.suggestion-hex').textContent();
      assert.match(hex, /^#[a-f\d]{6}$/i);
      if (side === 'before') assert.equal(hex, '#FFFFFF', 'Original background is shown instead of the foreground');
      else { assert.notEqual(hex, '#FFFFFF'); assert.notEqual(hex, '#AAAAAA'); }
      const channels = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16));
      assert.equal(await tile.locator('.swatch span').evaluate(node => getComputedStyle(node).backgroundColor), `rgb(${channels.join(', ')})`);
      const sample = await backgroundCard.locator('.compare .color-preview').nth(side === 'before' ? 0 : 1).evaluate(node => ({ color: getComputedStyle(node).color, background: getComputedStyle(node).backgroundColor }));
      assert.deepEqual(sample, { color: 'rgb(170, 170, 170)', background: `rgb(${channels.join(', ')})` }, 'The sample shows the matching original or proposed background with unchanged text');
      await tile.getByRole('button', { name: message(catalog, 'actionCopyValue', [hex]), exact: true }).click();
      assert.equal(await page.evaluate(() => window.__copied), hex, 'Background tile copies exactly its own displayed value');
    }
    assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit, commands: window.__commands.length })), beforeBackgroundCopy);
    await page.getByLabel(label('suggestions'), { exact: true }).selectOption('color');
    assert.equal(await page.locator('.suggestion-card').first().locator('.suggestion-color[data-side="before"] .suggestion-hex').textContent(), '#AAAAAA');

    // Suggestion exports stay separate, and simulation cannot alter original evaluation.
    await page.locator('.suggestion-card').first().getByRole('button', { name: label('actionExportSuggestion'), exact: true }).click();
    await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
    const suggestion = JSON.parse(await page.locator('.code-preview').textContent());
    assert.equal(suggestion.kind, 'contrast-suggestion'); assert.equal(suggestion.applied, false);

    // A retained suggestion is invalidated even while a different export source
    // is selected; reconnect snapshots can change a selection without a click.
    await page.getByLabel(label('exportSource')).selectOption('element');
    const ordinaryDraft = await page.locator('.code-preview').textContent();
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, contrastTarget: 'AAA' }, lastEvent: 'settings' }));
    assert.equal(await page.getByLabel(label('exportSource')).locator('option[value="contrast-suggestion"]').isDisabled(), true, 'Old AA recommendation cannot be reselected after switching to AAA');
    assert.equal(await page.locator('.code-preview').textContent(), ordinaryDraft, 'Ordinary frozen sources remain usable');
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, contrastTarget: 'AA' }, lastEvent: 'settings' }));
    for (const boundary of ['selection', 'stale']) {
      await page.locator('#tab-contrast').click();
      await page.locator('.suggestion-card').first().getByRole('button', { name: label('actionExportSuggestion'), exact: true }).click();
      await page.evaluate(boundary => window.__emit({ selected: { ...window.__state.selected, ...(boundary === 'selection' ? { id: 'reconnected-selection' } : { stale: true }) }, lastEvent: 'ready' }), boundary);
      assert.equal(await page.locator('.code-preview').count(), 0, `${boundary}: ready state invalidates an obsolete recommendation`);
      assert.equal(await page.locator('.footer button:disabled').count(), 2);
      await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), snapshot);
    }
    await page.locator('#tab-contrast').click();
    const simulation = page.locator('details').filter({ has: page.locator('summary', { hasText: label('simulation') }) });
    await simulation.locator('summary').click(); await simulation.getByLabel(label('simulationMode')).selectOption('protanopia');
    assert.equal(await page.locator('.ratio').textContent(), ratio);
    await page.locator('.footer button:last-child').click();
    assert.equal(await page.getByLabel(label('exportSource')).inputValue(), 'element');

    // Context-menu selections preserve a current element tab but use Contrast from Audit.
    await page.locator('#tab-colors').click();
    await page.evaluate(snapshot => window.__emit({ selected: { ...snapshot, id: 'context-one' }, lastEvent: 'selected', selectionOrigin: 'context' }), snapshot);
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-colors');
    await page.locator('#tab-audit').click();
    await page.evaluate(snapshot => window.__emit({ selected: { ...snapshot, id: 'context-two' }, lastEvent: 'selected', selectionOrigin: 'context' }), snapshot);
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-contrast');

    // Rescan resets analysis views and drafts, while preserving all personal preferences.
    await page.locator('#tab-audit').click();
    await page.locator('.filter-bar button[data-filter="manual"]').click();
    assert.equal(await page.locator('.finding').count(), 0, 'This snapshot has a CSS pair but no missing contrast value');
    assert.equal(await page.getByText(label('noFindings'), { exact: true }).count(), 1);
    const auditSimulation = page.locator('details').filter({ has: page.locator('summary', { hasText: label('simulation') }) });
    if ((await auditSimulation.getAttribute('open')) === null) await auditSimulation.locator('summary').click();
    await auditSimulation.getByLabel(label('simulationMode')).selectOption('tritanopia');
    const settingsBeforeRescan = await page.evaluate(() => structuredClone(window.__state.settings));
    await page.getByRole('button', { name: label('actionRescan'), exact: true }).click();
    assert.equal(await page.evaluate(() => window.__permissionRequests.filter(request => request.origins).length), 0, 'An already activated page needs no additional host permission');
    assert.equal(await page.locator('.content').evaluate(node => node.scrollTop), 0);
    assert.equal(await page.evaluate(() => window.__state.selected), null);
    assert.equal(await page.evaluate(() => window.__state.audit), null);
    await page.evaluate(audit => window.__emit({ audit: { ...audit, id: 'refreshed-audit', stale: false }, lastEvent: 'audit' }), audit);
    assert.equal(await page.locator('.filter-bar button[data-filter="all"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('.finding').count(), 4);
    assert.equal(await auditSimulation.getAttribute('open'), null);
    assert.equal(await auditSimulation.getByLabel(label('simulationMode')).inputValue(), 'original');
    assert.equal(await page.locator('.finding[data-reference="manual-element"]').getByRole('button', { name: label('actionShow'), exact: true }).isEnabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__state.settings), settingsBeforeRescan);
    await page.evaluate(() => {
      // Opening schedules a native toggle event, then the rescan replaces that
      // node before its event fires. The detached event must not reopen the UI.
      const details = document.querySelector('.simulation-explanation').closest('details');
      details.open = true;
      window.__emit({ selected: null, audit: null, lastEvent: 'audit-reset' });
    });
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), audit);
    await page.waitForTimeout(50);
    await page.evaluate(() => window.__emit({ lastEvent: 'ready' }));
    assert.equal(await auditSimulation.getAttribute('open'), null, 'Detached simulation toggle cannot restore pre-rescan state');
    await page.locator('#tab-contrast').click();
    assert.equal(await page.locator('.manual-contrast').count(), 1, 'Contrast remains usable locally after the selected page element is cleared');
    assert.equal(await page.locator('.suggestion-card').count(), 0);
    await page.locator('#tab-audit').click();

    // Confirmed page styles are usable without first selecting an element.
    // Keep full CSS fallback stacks; they do not identify the rendered font.
    const overviewState = await page.evaluate(() => structuredClone(window.__state));
    const pageAudit = { ...audit, id: 'overview-audit', stale: false, fonts: [
      '"Example Sans", Arial, sans-serif', '"Example Mono", monospace',
      `"${'Long family '.repeat(18).trim()}", serif`,
    ] };
    const overviewCopy = page.locator('.footer button:first-child');
    const overviewExport = page.locator('.footer button:last-child');
    await page.evaluate(audit => window.__emit({ selected: null, preview: null, audit, lastEvent: 'audit' }), pageAudit);
    const overviewCommands = await page.evaluate(() => window.__commands.length);
    for (const tab of ['colors', 'typography']) {
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await page.locator('.selected-card,.fields,.font-preview').count(), 0, 'Page overview does not invent selected-element details');
      assert.equal(await page.locator('.page-overview').count(), 1);
      assert.ok((await page.locator('.page-overview').textContent()).includes(label('measuredAt')));
      assert.equal(await overviewCopy.isEnabled(), true);
      assert.equal(await overviewExport.isEnabled(), true);
      await page.setViewportSize({ width: 280, height: 800 });
      const overviewHeaderFits = await page.locator('.page-overview .section-title').evaluate(node => {
        const bounds = node.getBoundingClientRect();
        return [...node.children].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1; });
      });
      assert.equal(overviewHeaderFits, true, `${locale}/${tab}: the overview title and rescan button fit inside the narrow card`);
      await page.setViewportSize({ width: 380, height: 800 });
      if (tab === 'colors') {
        assert.equal(await page.locator('.page-palette .palette-item').count(), pageAudit.palette.length);
        const tile = page.locator('.page-palette .palette-item').first();
        await tile.getByRole('button').click();
        assert.equal(await page.evaluate(() => window.__copied), await tile.locator(':scope > span:not(.swatch)').textContent());
      } else {
        assert.deepEqual(await page.locator('.font-chip').allTextContents(), pageAudit.fonts);
        assert.ok((await page.locator('.content').textContent()).includes(label('pageFontsHelp')));
        await page.setViewportSize({ width: 280, height: 800 });
        assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'A long CSS fallback stack fits a narrow sidebar');
        await page.setViewportSize({ width: 380, height: 800 });
      }
      await overviewCopy.click();
      const settings = await page.evaluate(() => window.__state.settings);
      assert.equal(await page.evaluate(() => window.__copied), serializeExport({ kind: 'page-tokens', audit: pageAudit }, { version: '1.0.0', format: 'css', scope: 'all', colorFormat: settings.colorFormat, target: settings.contrastTarget }).text);
      await overviewExport.click();
      assert.equal(await page.getByLabel(label('exportSource')).inputValue(), 'page-tokens');
      assert.equal(await page.getByLabel(label('exportFormat'), { exact: true }).inputValue(), 'css');
      assert.equal(await page.getByLabel(label('exportSource')).locator('option[value="element"]').isDisabled(), true);
      assert.equal(await page.getByLabel(label('exportScope'), { exact: true }).count(), 0);
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      const exported = JSON.parse(await page.locator('.code-preview').textContent());
      assert.equal(exported.kind, 'page-tokens');
      assert.deepEqual(exported.generatedTokens.filter(token => token.group === 'typography').map(token => token.value).sort(), [...pageAudit.fonts].sort());
      assert.ok(exported.generatedTokens.some(token => token.group === 'colors'));
      assert.equal(exported.metadata.stale, false);
      assert.equal(exported.metadata.scanStatus, 'complete');
      await page.getByRole('button', { name: label('actionBack'), exact: true }).click();
    }
    assert.equal(await page.evaluate(() => window.__commands.length), overviewCommands, 'Viewing/copying/exporting page styles requests no scan or element selection');

    // A reviewed page-token draft stays frozen when a later audit arrives.
    await overviewExport.click();
    const frozenPageTokens = await page.locator('.code-preview').textContent();
    await page.evaluate(audit => window.__emit({ audit: { ...audit, id: 'overview-later', fonts: ['"Later Family", serif'] }, lastEvent: 'audit' }), pageAudit);
    assert.equal(await page.locator('.code-preview').textContent(), frozenPageTokens);
    await page.getByRole('button', { name: label('actionBack'), exact: true }).click();
    assert.deepEqual(await page.locator('.font-chip').allTextContents(), ['"Later Family", serif']);

    // Element detail and export retain priority; the page overview stays distinct.
    for (const tab of ['colors', 'typography']) {
      await page.evaluate(({ selected, audit, tab }) => window.__emit({ selected, audit, selectionTab: tab, lastEvent: 'selected' }), { selected: snapshot, audit: pageAudit, tab });
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await page.locator('.selected-card').count(), 1);
      assert.equal(await page.locator('.page-overview').count(), 1);
      assert.ok(await page.locator(tab === 'colors' ? '.color-row' : '.fields .field').count());
      await overviewCopy.click();
      const copiedElement = await page.evaluate(() => window.__copied);
      assert.ok(!copiedElement.includes('--sil-font-'), 'Element quick copy must not silently switch to page tokens');
      await overviewExport.click();
      assert.equal(await page.getByLabel(label('exportSource')).inputValue(), 'element');
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      assert.equal(JSON.parse(await page.locator('.code-preview').textContent()).kind, 'element');
      await page.getByRole('button', { name: label('actionBack'), exact: true }).click();
    }
    await page.evaluate(({ preview, audit }) => window.__emit({ selected: null, preview, audit, lastEvent: 'preview' }), { preview: snapshot, audit: pageAudit });
    assert.equal(await overviewCopy.isDisabled(), true, 'A hovered element preview cannot export as a confirmed element or page selection');
    assert.equal(await overviewExport.isDisabled(), true);

    // Historical and incomplete page styles remain useful, with their limits visible.
    for (const [status, stale, statusKey] of [['complete', true, 'statusStale'], ['partial', false, 'statusPartial'], ['cancelled', false, 'statusCancelled'], ['running', false, 'statusScanning']]) {
      const historical = { ...pageAudit, status, stale, reasons: status === 'partial' ? [...pageAudit.reasons, 'scan-limit'] : pageAudit.reasons };
      await page.evaluate(audit => window.__emit({ selected: null, preview: null, audit, lastEvent: 'audit' }), historical);
      for (const tab of ['colors', 'typography']) {
        await page.locator(`#tab-${tab}`).click();
        const expected = status === 'running' ? message(catalog, statusKey, [historical.scanned, historical.total]) : label(statusKey);
        assert.ok((await page.locator('.page-overview').textContent()).includes(expected), `${tab}/${status}: page overview exposes snapshot status`);
        assert.equal(await overviewCopy.isEnabled(), true);
      }
      await page.locator('#tab-audit').click();
      await overviewCopy.click();
      const copiedAudit = await page.evaluate(() => window.__copied);
      assert.ok(copiedAudit.includes(status === 'running' ? message(catalog, statusKey, [historical.scanned, historical.total]) : label(statusKey)), `${status}: the copied audit preserves its actual scan status`);
      assert.equal(copiedAudit.includes(label('statusStale')), stale, 'The copied audit keeps its freshness warning');
      assert.ok(copiedAudit.includes(label('reason_main_document_only')), 'The copied audit includes its scope limitations');
      if (status === 'partial') assert.ok(copiedAudit.includes(label('reason_scan_limit')), 'A scan-limit warning survives quick-copy');
      await overviewExport.click();
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption('json');
      const exported = JSON.parse(await page.locator('.code-preview').textContent());
      assert.equal(exported.metadata.stale, stale); assert.equal(exported.metadata.scanStatus, status);
      assert.equal(exported.warnings.some(item => item.code === 'stale-measurement'), stale);
      assert.equal(exported.warnings.some(item => item.code === 'partial-scan'), status !== 'complete');
      await page.getByRole('button', { name: label('actionBack'), exact: true }).click();
    }
    const emptyPageAudit = { ...fixtureAudit([]), palette: [], fonts: [] };
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), emptyPageAudit);
    for (const tab of ['colors', 'typography']) {
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await page.locator('.page-overview').count(), 1);
      assert.equal(await page.locator('.font-chip,.palette-item').count(), 0);
      assert.equal(await page.locator('.selected-card').count(), 0);
      assert.ok((await page.locator('.content').textContent()).includes(label('noPageValues')));
    }
    await page.evaluate(() => window.__emit({ audit: null, lastEvent: 'ready' }));
    for (const tab of ['colors', 'typography']) {
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await page.locator('.page-overview[data-status="empty"]').count(), 1);
      assert.equal(await page.locator('.font-chip,.page-palette').count(), 0);
      assert.equal(await overviewCopy.isDisabled(), true); assert.equal(await overviewExport.isDisabled(), true);
      assert.ok((await page.locator('.content').textContent()).includes(label('noPalette')));
      assert.equal(await page.locator('main button.primary').isEnabled(), true, 'Missing data offers an explicit scan');
    }
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), pageAudit);
    await page.locator('#tab-colors').click(); await overviewExport.click();
    await page.evaluate(() => window.__emit({ documentToken: 'overview-next-document', selected: null, preview: null, audit: null, lastEvent: 'document-changed' }));
    assert.equal(await page.locator('.code-preview,.page-overview,.font-chip,.page-palette').count(), 0, 'Navigation invalidates the draft and all old page styles');
    await page.locator('#tab-typography').click();
    await page.locator('main button.primary').click();
    assert.equal(await page.locator('.font-chip,.page-palette').count(), 0, 'Starting a new audit cannot show old page styles');
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), { ...pageAudit, fonts: ['"Fresh Family", sans-serif'] });
    await page.locator('#tab-typography').click();
    assert.deepEqual(await page.locator('.font-chip').allTextContents(), ['"Fresh Family", sans-serif']);
    await page.evaluate(state => window.__emit({ ...state, lastEvent: 'ready' }), overviewState);
    await page.locator('#tab-audit').click();

    // Text excerpts belong only to confirmed selections and are copied explicitly.
    // Contrast follows the selected text run; other element tabs show the root excerpt.
    const excerptState = await page.evaluate(() => structuredClone(window.__state));
    const rootText = 'EXCERPT_ROOT_SENTINEL ' + 'Long selected element text '.repeat(35);
    const firstText = 'EXCERPT_RUN_ONE_SENTINEL <img src=x onerror="window.__excerptMarkupRan=true"> & literal text';
    const secondText = 'EXCERPT_RUN_TWO_SENTINEL שלום مرحبا ' + 'Shortened text '.repeat(28);
    const excerptSnapshot = { ...snapshot, id: 'excerpt-selection', elementRef: 'excerpt-element', textExcerpt: { value: rootText, truncated: false }, textRuns: [
      { ...snapshot.textRuns[0], id: 'excerpt-run-one', textExcerpt: { value: firstText, truncated: false } },
      { ...passRun, id: 'excerpt-run-two', textExcerpt: { value: secondText, truncated: true } },
      { ...passRun, id: 'excerpt-run-empty' },
    ] };
    const excerptCard = page.locator('.element-text-card'), excerptValue = page.locator('.element-text-value');
    const excerptCopy = page.locator('.copy-element-text');
    const chooseExcerptRun = index => page.getByLabel(label('textContrast'), { exact: true }).selectOption(String(index));
    const selectExcerpt = async selected => {
      await page.evaluate(selected => window.__emit({ selected, preview: null, selectionTab: 'contrast', lastEvent: 'selected' }), selected);
      await page.locator('#tab-contrast').click();
    };
    await selectExcerpt(excerptSnapshot);
    assert.equal(await excerptCard.getAttribute('data-scope'), 'run');
    assert.equal(await excerptCard.locator('h2').textContent(), label('elementTextTitle'));
    assert.equal(await excerptValue.inputValue(), firstText);
    assert.equal(await excerptValue.getAttribute('aria-label'), label('textAreaContent'));
    assert.equal(await excerptValue.evaluate(node => node.readOnly), true);
    assert.equal(await excerptValue.getAttribute('dir'), 'auto');
    assert.equal(await page.locator('main > :last-child').evaluate(node => node.classList.contains('element-text-card')), true, 'The excerpt is below all measured details');
    assert.equal(await excerptCard.locator('img,script').count(), 0, 'Page text is displayed literally, never interpreted as markup');
    assert.equal(await page.evaluate(() => window.__excerptMarkupRan), undefined);
    assert.ok(!(await excerptCard.textContent()).includes(label('textExcerptTruncated')));
    await excerptCopy.click(); assert.equal(await page.evaluate(() => window.__copied), firstText);
    await chooseExcerptRun(1);
    assert.equal(await excerptValue.inputValue(), secondText);
    assert.ok((await excerptCard.textContent()).includes(label('textExcerptTruncated')));
    await excerptCopy.click(); assert.equal(await page.evaluate(() => window.__copied), secondText);
    await chooseExcerptRun(2);
    assert.equal(await excerptValue.count(), 0); assert.equal(await excerptCopy.count(), 0);
    assert.ok((await excerptCard.textContent()).includes(label('textExcerptUnavailable')), 'A run without text must not borrow the parent excerpt');
    await chooseExcerptRun(0);

    // Fresh measurements retain the chosen run, including after the audit
    // publishes. A disappeared run must not silently display its neighbour.
    await chooseExcerptRun(1);
    for (const lastEvent of ['audit', 'activated', 'selected']) {
      await page.evaluate(({ snapshot, lastEvent }) => window.__emit({ selected: { ...snapshot, id: `refreshed-${lastEvent}` }, lastEvent }), { snapshot: excerptSnapshot, lastEvent });
      assert.equal(await excerptValue.inputValue(), secondText, `${lastEvent}: refreshed selection retains the chosen text run`);
      assert.equal(await page.getByLabel(label('textContrast'), { exact: true }).inputValue(), '1');
    }
    const missingRunSnapshot = { ...excerptSnapshot, id: 'missing-run', textRuns: [excerptSnapshot.textRuns[0]] };
    await selectExcerpt(missingRunSnapshot);
    assert.equal(await page.locator('main .contrast-value').count(), 0, 'A missing run cannot borrow a neighbour’s contrast');
    assert.equal(await excerptValue.count(), 0, 'A missing run cannot borrow a neighbour’s text');
    assert.ok((await page.locator('main').textContent()).includes(label('textAreaUnavailable')));
    assert.equal(await page.getByLabel(label('textContrast'), { exact: true }).inputValue(), '-1');
    await chooseExcerptRun(0);
    assert.equal(await excerptValue.inputValue(), firstText, 'Another run remains available by explicit choice');
    const requestedRun = { ...passRun, id: 'retired-audit-run', elementRef: excerptSnapshot.elementRef };
    await page.evaluate(({ selected, audit }) => {
      window.__selectionSnapshots[selected.elementRef] = selected;
      window.__emit({ selected: null, audit, lastEvent: 'audit' });
    }, { selected: missingRunSnapshot, audit: fixtureAudit([requestedRun]) });
    await page.locator('#tab-audit').click();
    await page.locator('.filter-bar button[data-filter="all"]').click();
    await page.locator('.finding').getByRole('button', { name: label('actionInspect'), exact: true }).click();
    assert.equal(await page.locator('main .contrast-value').count(), 0, 'An expired requested audit run cannot select the first returned child instead');
    assert.equal(await excerptValue.count(), 0);
    await chooseExcerptRun(0);
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), excerptState.audit);
    await selectExcerpt(excerptSnapshot);

    // The audit's requested run belongs to that selection intent. A newer
    // picker or context selection cannot inherit it, and older action errors
    // cannot discard the currently requested run.
    const wantedRun = { ...excerptSnapshot.textRuns[1], elementRef: excerptSnapshot.elementRef };
    const selectionAudit = fixtureAudit([passRun, wantedRun]);
    const prepareDeferredInspect = async () => {
      await page.evaluate(({ audit, selected }) => {
        window.__deferSelection = true;
        window.__selectionSnapshots[selected.elementRef] = selected;
        window.__emit({ selected: null, preview: null, picker: false, audit, lastEvent: 'audit' });
      }, { audit: selectionAudit, selected: excerptSnapshot });
      await page.locator('#tab-audit').click();
      await page.locator('.filter-bar button[data-filter="all"]').click();
    };
    for (const origin of ['picker', 'context']) {
      await prepareDeferredInspect();
      await page.locator('.finding').nth(1).getByRole('button', { name: label('actionInspect'), exact: true }).click();
      if (origin === 'picker') await page.locator('.picker').click();
      await page.evaluate(({ selected, origin }) => window.__emit({ selected, picker: false, selectionOrigin: origin, selectionTab: undefined, lastEvent: 'selected' }), { selected: fixtureSnapshot(passRun), origin });
      assert.equal(await page.locator('main .contrast-value').count(), 1, `${origin}: the new selection retains its own contrast run`);
      assert.ok(!(await page.locator('main').textContent()).includes(label('textAreaUnavailable')), `${origin}: an older audit run cannot make valid text unavailable`);
    }
    await prepareDeferredInspect();
    await page.locator('.finding').first().getByRole('button', { name: label('actionInspect'), exact: true }).click();
    const olderInspect = await page.evaluate(() => window.__commands.at(-1).requestId);
    await page.locator('.finding').nth(1).getByRole('button', { name: label('actionInspect'), exact: true }).click();
    await page.evaluate(requestId => window.__listeners.forEach(listener => listener({ type: 'error', requestId, code: 'element-removed' })), olderInspect);
    await page.evaluate(selected => window.__emit({ selected, selectionOrigin: 'audit', selectionTab: 'contrast', lastEvent: 'selected' }), excerptSnapshot);
    assert.equal(await excerptValue.inputValue(), secondText, 'A late error from an older action cannot discard the newer requested run');
    await prepareDeferredInspect();
    await page.evaluate(() => { window.__deferSelection = false; });
    await page.locator('.finding').nth(1).getByRole('button', { name: label('actionInspect'), exact: true }).click();
    assert.equal(await excerptValue.inputValue(), secondText, 'A matching audit selection still opens the exact requested run');
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), excerptState.audit);
    await selectExcerpt(excerptSnapshot);

    await chooseExcerptRun(1);
    await page.locator('.picker').click();
    await page.locator('.picker').click();
    assert.equal(await excerptValue.inputValue(), secondText, 'Canceling a picker retains the previously selected text area');
    await selectExcerpt(missingRunSnapshot);
    await page.locator('.picker').click();
    await page.locator('.picker').click();
    assert.equal(await excerptValue.count(), 0, 'Canceling a picker also retains a previously missing text-area choice');
    assert.ok((await page.locator('main').textContent()).includes(label('textAreaUnavailable')));
    await page.locator('.picker').click();
    await page.evaluate(selected => window.__emit({ selected, picker: false, preview: null, selectionOrigin: 'picker', selectionTab: undefined, lastEvent: 'selected' }), missingRunSnapshot);
    assert.equal(await excerptValue.inputValue(), firstText, 'Explicitly reselecting the same element starts at its current first text area');
    assert.equal(await page.locator('main .contrast-value').count(), 1, 'A vanished previously chosen run cannot hide the reselected element’s remaining contrast');

    const limitedSelection = { ...excerptSnapshot, id: 'stale-limited-selection', stale: true, reasons: ['main-document-only', 'selection-text-limit'] };
    await selectExcerpt(limitedSelection);
    await page.locator('.footer button:first-child').click();
    const copiedContrast = await page.evaluate(() => window.__copied);
    assert.ok(copiedContrast.includes(label('statusStale')), 'The copied contrast report retains the visible stale-measurement warning');
    assert.ok(copiedContrast.includes(label('reason_selection_text_limit')), 'The copied contrast report retains the measured selection limit');
    await selectExcerpt({ ...excerptSnapshot, id: 'fresh-selection-report' });
    await page.locator('.footer button:first-child').click();
    assert.ok(!(await page.evaluate(() => window.__copied)).includes(label('statusStale')), 'A fresh measurement has no copied stale warning');
    await chooseExcerptRun(0);

    for (const appearance of ['light', 'dark']) {
      await page.evaluate(appearance => window.__emit({ settings: { ...window.__state.settings, appearance }, lastEvent: 'settings' }), appearance);
      await page.setViewportSize({ width: 280, height: 800 });
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${locale}/${appearance}: text excerpt fits a narrow sidebar`);
      assert.ok(await excerptCard.evaluate(node => {
        const outer = node.getBoundingClientRect();
        return [...node.children].every(child => { const rect = child.getBoundingClientRect(); return rect.left >= outer.left && rect.right <= outer.right; });
      }), 'The textarea and copy button stay inside the card');
      await page.locator('.toast').waitFor({ state: 'hidden' });
      await excerptCard.screenshot({ path: path.join(root, `test-results/element-text-${locale}-${appearance}.png`) });
    }
    await page.setViewportSize({ width: 380, height: 800 });
    for (const tab of ['colors', 'typography', 'layout']) {
      await page.locator(`#tab-${tab}`).click();
      assert.equal(await excerptCard.getAttribute('data-scope'), 'element');
      assert.equal(await excerptValue.inputValue(), rootText);
      assert.equal(await excerptValue.getAttribute('aria-label'), label('elementTextTitle'));
      await excerptCopy.click(); assert.equal(await page.evaluate(() => window.__copied), rootText);
      await page.locator('.footer button:first-child').click();
      assert.ok(!(await page.evaluate(() => window.__copied)).includes('EXCERPT_'), 'Existing style quick-copy never includes element text');
    }
    await page.locator('#tab-contrast').click();
    await page.locator('.footer button:first-child').click();
    assert.ok(!(await page.evaluate(() => window.__copied)).includes('EXCERPT_'), 'Contrast report copy remains free of page text');
    await page.locator('.footer button:last-child').click();
    assert.equal(await excerptCard.count(), 0);
    for (const format of ['css', 'scss', 'json', 'tailwind']) {
      await page.getByLabel(label('exportFormat'), { exact: true }).selectOption(format);
      assert.ok(!(await page.locator('.code-preview').textContent()).includes('EXCERPT_'), `${format}: style export excludes both run and root excerpts`);
    }
    await page.getByRole('button', { name: label('actionBack'), exact: true }).click();

    // A denied copy offers the existing selectable fallback; changing the run
    // clears it and also invalidates a denial that arrives after navigation.
    await page.evaluate(() => { window.__failClipboard = true; });
    await excerptCopy.click();
    assert.equal(await page.locator('.clipboard-fallback').inputValue(), firstText);
    await chooseExcerptRun(1);
    assert.equal(await page.locator('.clipboard-fallback').count(), 0);
    await page.evaluate(() => { window.__failClipboard = false; window.__deferClipboard = true; });
    await excerptCopy.click();
    await page.locator('#tab-layout').click(); await page.locator('#tab-contrast').click();
    await page.evaluate(async () => { window.__clipboardRequests.at(-1).reject(new Error('Late excerpt denial')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'Returning to the same run cannot revive an old text-copy fallback');
    await excerptCopy.click();
    await page.evaluate(selected => window.__emit({ selected, lastEvent: 'ready' }), { ...excerptSnapshot, textRuns: excerptSnapshot.textRuns.map(run => run.id === 'excerpt-run-two' ? { ...run, textExcerpt: { value: 'EXCERPT_REFRESHED_SENTINEL', truncated: false } } : run) });
    await page.evaluate(async () => { window.__clipboardRequests.at(-1).reject(new Error('Replaced excerpt denial')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.clipboard-fallback').count(), 0);
    assert.equal(await excerptValue.inputValue(), 'EXCERPT_REFRESHED_SENTINEL');
    await page.evaluate(() => { window.__deferClipboard = false; window.__clipboardRequests = []; });

    await page.evaluate(preview => window.__emit({ preview, picker: true, lastEvent: 'preview' }), excerptSnapshot);
    assert.equal(await excerptCard.count(), 0, 'Even a malformed preview carrying an excerpt must not expose a text card');
    await page.evaluate(() => window.__emit({ preview: null, picker: false, lastEvent: 'picker-cancelled' }));
    assert.equal(await excerptValue.inputValue(), 'EXCERPT_REFRESHED_SENTINEL');
    await page.locator('#tab-audit').click(); assert.equal(await excerptCard.count(), 0);
    await selectExcerpt({ ...excerptSnapshot, id: 'excerpt-empty-root', textExcerpt: { value: '', truncated: false }, textRuns: [] });
    assert.equal(await excerptValue.count(), 0); assert.equal(await excerptCopy.count(), 0);
    await page.locator('#tab-colors').click();
    assert.ok((await excerptCard.textContent()).includes(label('textExcerptUnavailable')));
    assert.equal(await excerptValue.count(), 0);
    for (const lastEvent of ['audit-reset', 'data-cleared', 'document-changed']) {
      await selectExcerpt({ ...excerptSnapshot, id: `excerpt-before-${lastEvent}` });
      await page.evaluate(lastEvent => window.__emit({ selected: null, preview: null, audit: null, ...(lastEvent === 'document-changed' ? { documentToken: 'excerpt-next-document' } : {}), lastEvent }), lastEvent);
      assert.equal(await excerptCard.count(), 0, `${lastEvent}: old element text is removed`);
      await page.locator('#tab-contrast').click();
      assert.equal(await excerptCard.count(), 0, 'Manual contrast never displays a historical page excerpt');
    }
    await page.evaluate(state => window.__emit({ ...state, lastEvent: 'ready' }), excerptState);
    await page.locator('#tab-audit').click();

    // The same open sidebar can start again after navigation; denial leaves a usable retry.
    const scansBeforeNavigation = await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length);
    await page.evaluate(() => window.__emit({ tabId: 88, documentToken: null, documentRevision: 2, access: 'needs-activation', audit: null, selected: null, lastEvent: 'document-changed' }));
    const rescan = page.getByRole('button', { name: label('actionRescan'), exact: true });
    assert.equal(await rescan.isEnabled(), true);
    await rescan.click();
    assert.equal(await page.locator('.toast').textContent(), label('error_page_permission'));
    assert.equal(await rescan.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scansBeforeNavigation);
    assert.deepEqual(await page.evaluate(() => window.__permissionRequests.at(-1)), { origins: ['http://*/*', 'https://*/*'], userActivation: true });

    // A still-open permission prompt cannot create duplicates or scan a different document.
    await page.evaluate(() => { window.__deferPagePermission = true; });
    await rescan.click();
    assert.equal(await rescan.isDisabled(), true);
    const permissionCount = await page.evaluate(() => window.__permissionRequests.length);
    await rescan.evaluate(node => node.click());
    assert.equal(await page.evaluate(() => window.__permissionRequests.length), permissionCount);
    await page.evaluate(() => { window.__emit({ documentRevision: 3, lastEvent: 'document-changed' }); window.__resolvePagePermission(true); });
    assert.equal(await page.locator('.toast').textContent(), label('error_page_changed'));
    assert.equal(await rescan.isEnabled(), true);
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scansBeforeNavigation, 'A same-tab navigation with two null document tokens still cancels the pending scan');
    await rescan.click();
    await page.evaluate(() => { window.__emit({ tabId: 99, documentRevision: 4, lastEvent: 'document-changed' }); window.__resolvePagePermission(true); });
    assert.equal(await page.locator('.toast').textContent(), label('error_page_changed'));
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scansBeforeNavigation, 'A tab switch while permission is pending cancels the scan');

    // Granting access starts exactly one explicitly requested scan in the unchanged sidebar.
    await page.evaluate(() => { window.__deferPagePermission = false; window.__pagePermission = true; });
    const connectionsBeforeGrant = await page.evaluate(() => window.__connectionCount);
    await rescan.click();
    assert.deepEqual(await page.evaluate(() => { const command = window.__commands.filter(item => item.type === 'start-audit').at(-1); return { expectedTabId: command.expectedTabId, expectedDocumentToken: command.expectedDocumentToken, expectedRevision: command.expectedRevision }; }), { expectedTabId: 99, expectedDocumentToken: null, expectedRevision: 4 });
    assert.equal(await page.evaluate(() => window.__commands.filter(command => command.type === 'start-audit').length), scansBeforeNavigation + 1);
    assert.equal(await page.evaluate(() => window.__connectionCount), connectionsBeforeGrant);
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    await page.evaluate(audit => window.__emit({ documentToken: 'new-page', access: 'ready', audit: { ...audit, id: 'new-page-audit', stale: false }, lastEvent: 'audit' }), audit);
    const requestsBeforeReadyScan = await page.evaluate(() => window.__permissionRequests.length);
    await rescan.click();
    assert.equal(await page.evaluate(() => window.__permissionRequests.length), requestsBeforeReadyScan);
    await page.evaluate(() => window.__emit({ access: 'unsupported', documentToken: null, documentRevision: 5, audit: null, lastEvent: 'document-changed' }));
    assert.equal(await rescan.isDisabled(), true, 'Protected Firefox pages cannot request inspection');
    await page.evaluate(audit => window.__emit({ access: 'ready', documentToken: 'new-page', documentRevision: 6, audit, lastEvent: 'audit' }), audit);

    // A synchronized data clear invalidates every prepared export without deleting preferences.
    await page.locator('.footer button:last-child').click();
    assert.equal(await page.getByLabel(label('exportSource')).locator('option[value="element"]').isDisabled(), true);
    await page.evaluate(() => window.__emit({ selected: null, audit: null, lastEvent: 'data-cleared' }));
    assert.equal(await page.locator('.footer button:disabled').count(), 2);
    assert.equal(await page.locator('.code-preview').count(), 0);
    assert.equal(await page.evaluate(() => window.__state.settings.colorFormat), 'hsl');
    // Manual contrast is a local color calculator, independent of page access
    // and the measured snapshot/export pipeline.
    await page.locator('#tab-contrast').click();
    const manualPanel = page.locator('.manual-contrast');
    const foregroundHex = page.locator('#manual-foreground-hex'), backgroundHex = page.locator('#manual-background-hex');
    const foregroundPicker = page.locator('#manual-foreground-picker'), backgroundPicker = page.locator('#manual-background-picker');
    const foregroundPalette = page.locator('#manual-foreground-picker-panel'), backgroundPalette = page.locator('#manual-background-picker-panel');
    const foregroundHue = page.locator('#manual-foreground-hue'), foregroundSaturation = page.locator('#manual-foreground-saturation'), foregroundValue = page.locator('#manual-foreground-value');
    const paletteState = async () => [await foregroundHue.inputValue(), await foregroundSaturation.inputValue(), await foregroundValue.inputValue()];
    const manualCopy = page.locator('.footer button:first-child'), manualExport = page.locator('.footer button:last-child');
    const assertManualRatio = async (expected, normal, large) => {
      assert.equal(await manualPanel.count(), 1);
      assert.equal((await manualPanel.locator('.manual-ratio').textContent()).replace(',', '.').replace(/\s/g, ''), `${expected}:1`);
      assert.equal(await manualPanel.locator('.manual-preview').count(), 1);
      for (const [category, statuses, thresholds] of [['normal', normal, [4.5, 7]], ['large', large, [3, 4.5]]]) {
        const section = manualPanel.locator(`.manual-category[data-category="${category}"]`);
        assert.equal(await section.locator('.assessment').count(), 2);
        for (const [index, level] of ['AA', 'AAA'].entries()) {
          const row = section.locator(`.assessment[data-level="${level}"]`);
          assert.equal(await row.locator(`.badge.${statuses[index]}`).count(), 1);
          assert.match((await row.textContent()).replace(',', '.'), new RegExp(`${thresholds[index]}\\s*:\\s*1`));
        }
      }
      assert.equal(await manualCopy.isEnabled(), true);
      assert.equal(await manualExport.isDisabled(), true, 'Manual input cannot be exported as an invented page measurement');
      assert.equal(await page.locator('.suggestion-card').count(), 0);
    };
    await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
    assert.equal(await foregroundHex.inputValue(), '#000000');
    assert.equal(await backgroundHex.inputValue(), '#FFFFFF');
    await page.evaluate(() => { window.__failClipboard = true; });
    await manualCopy.click();
    assert.equal(await page.locator('.clipboard-fallback').count(), 1);
    await page.locator('#tab-colors').click();
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'Leaving manual contrast removes its local copy fallback');
    await page.locator('#tab-contrast').click();
    await page.evaluate(() => { window.__failClipboard = false; window.__deferClipboard = true; });
    await manualCopy.click();
    await page.locator('#tab-colors').click(); await page.locator('#tab-contrast').click();
    await page.evaluate(async () => { window.__clipboardRequests.at(-1).reject(new Error('Manual clipboard denied after a tab round trip')); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.equal(await page.locator('.clipboard-fallback').count(), 0, 'Returning to the unchanged manual colors cannot revive an old denied copy');
    await page.evaluate(() => { window.__deferClipboard = false; });
    await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
    for (const appearance of ['light', 'dark']) {
      await page.setViewportSize({ width: 280, height: 800 });
      await page.evaluate(appearance => window.__emit({ selected: null, preview: null, audit: null, access: 'unsupported', settings: { ...window.__state.settings, appearance }, lastEvent: 'ready' }), appearance);
      const localBefore = await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit, commands: structuredClone(window.__commands), requests: structuredClone(window.__permissionRequests) }));
      await foregroundHex.fill('');
      await foregroundHex.evaluate(node => { window.__manualForeground = node; });
      for (const character of '#abc') {
        await foregroundHex.pressSequentially(character);
        assert.equal(await foregroundHex.evaluate(node => node === window.__manualForeground && document.activeElement === node && node.selectionStart === node.value.length), true, 'Typing updates the result without replacing the focused HEX input or its caret');
      }
      assert.equal(await foregroundHex.inputValue(), '#abc');
      assert.equal(await manualPanel.locator('input[type="color"]').count(), 0, 'The inline picker no longer invokes the problematic native Windows dialog');
      assert.equal(await foregroundPicker.locator('.manual-color-swatch > span').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(170, 187, 204)', 'HEX edits update the actual picker swatch');
      await foregroundHex.evaluate(node => node.setSelectionRange(2, 3));
      await page.evaluate(() => window.__emit({ lastEvent: 'ready' }));
      assert.deepEqual(await foregroundHex.evaluate(node => ({ same: node === window.__manualForeground, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { same: true, focused: true, start: 2, end: 3 }, 'An unrelated runtime update preserves an in-progress manual edit');
      await backgroundHex.focus();
      assert.equal(await foregroundHex.inputValue(), '#AABBCC', 'Blur expands a valid shorthand to uppercase six-digit HEX');
      const lastPicker = await paletteState();
      const lastSwatch = await foregroundPicker.locator('.manual-color-swatch > span').evaluate(node => getComputedStyle(node).backgroundColor);
      for (const invalid of ['', '#', '#12', '#1234', '#12345', '#1234567', '#12345678', '#GGGGGG', 'red', 'rgb(0,0,0)']) {
        await foregroundHex.fill(invalid);
        assert.equal(await foregroundHex.getAttribute('aria-invalid'), 'true', invalid);
        const describedBy = await foregroundHex.getAttribute('aria-describedby');
        assert.ok(describedBy);
        assert.ok(await foregroundHex.evaluate(node => node.getAttribute('aria-describedby').split(/\s+/).some(id => { const error = document.getElementById(id); return error?.classList.contains('manual-color-error') && error.checkVisibility(); })), 'Invalid HEX has a visible associated error');
        assert.ok(await manualPanel.locator('.manual-color-error[role="status"]:visible').count() > 0);
        assert.equal(await manualPanel.locator('.manual-ratio,.manual-preview,.assessment').count(), 0, 'Invalid input removes stale ratios, previews and verdicts immediately');
        assert.equal(await manualCopy.isDisabled(), true);
        assert.equal(await manualExport.isDisabled(), true);
        assert.deepEqual(await paletteState(), lastPicker, 'Partial HEX must not silently replace the inline picker with a made-up color');
        assert.equal(await foregroundPicker.locator('.manual-color-swatch > span').evaluate(node => getComputedStyle(node).backgroundColor), lastSwatch);
      }
      await foregroundHex.fill('#000'); await backgroundHex.fill('#ZZZZZZ');
      assert.equal(await backgroundHex.getAttribute('aria-invalid'), 'true');
      assert.equal(await foregroundHex.getAttribute('aria-invalid'), 'false');
      assert.equal(await manualPanel.locator('.manual-ratio,.manual-preview,.assessment').count(), 0);
      assert.equal(await manualCopy.isDisabled(), true);
      await backgroundHex.fill('#fff'); await foregroundHex.focus();
      await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
      await foregroundPicker.click();
      assert.equal(await foregroundPicker.getAttribute('aria-expanded'), 'true');
      assert.equal(await foregroundPalette.isVisible(), true);
      assert.equal(await foregroundHex.inputValue(), '#000000', 'Opening the black swatch does not replace the user color');
      await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
      await backgroundPicker.click();
      assert.equal(await foregroundPalette.isVisible(), false);
      assert.equal(await backgroundPalette.isVisible(), true);
      assert.equal(await manualPanel.locator('[id$="-picker-panel"]:visible').count(), 1, 'At most one inline palette is open');
      assert.equal(await backgroundHex.inputValue(), '#FFFFFF', 'Opening the white swatch preserves white');
      await page.locator('#manual-background-value').focus(); await page.locator('#manual-background-value').press('Home');
      assert.equal(await backgroundHex.inputValue(), '#000000', 'The background picker updates its own HEX field');
      assert.equal(await foregroundHex.inputValue(), '#000000');
      await assertManualRatio(1, ['fail', 'fail'], ['fail', 'fail']);
      await page.locator('#manual-background-value').press('End');
      assert.equal(await backgroundHex.inputValue(), '#FFFFFF');
      await backgroundPalette.locator('input[type="range"]').first().press('Escape');
      assert.equal(await backgroundPalette.isVisible(), false);
      assert.equal(await backgroundPicker.evaluate(node => node === document.activeElement), true, 'Escape returns keyboard focus to the triggering color button');
      await foregroundPicker.click();
      const spectrum = foregroundPalette.locator('.manual-hue-spectrum');
      await spectrum.scrollIntoViewIfNeeded();
      const spectrumBounds = await spectrum.boundingBox();
      assert.ok(spectrumBounds);
      await page.mouse.click(spectrumBounds.x + spectrumBounds.width / 3, spectrumBounds.y + spectrumBounds.height / 2);
      assert.ok(Math.abs(Number(await foregroundHue.inputValue()) - 120) <= 2, 'Clicking one third of the visible hue spectrum selects green directly');
      assert.equal(await foregroundSaturation.inputValue(), '100'); assert.equal(await foregroundValue.inputValue(), '100');
      const spectrumHex = await foregroundHex.inputValue();
      assert.match(spectrumHex, /^#[0-9A-F]{6}$/);
      const spectrumChannels = spectrumHex.slice(1).match(/../g).map(channel => Number.parseInt(channel, 16));
      assert.ok(spectrumChannels[0] <= 10 && spectrumChannels[1] === 255 && spectrumChannels[2] <= 10, 'A direct hue click makes an initially black color visibly green');
      assert.equal(await foregroundPicker.locator('.manual-color-swatch > span').evaluate(node => getComputedStyle(node).backgroundColor), `rgb(${spectrumChannels.join(', ')})`);
      assert.equal(await manualPanel.locator('.manual-preview').evaluate(node => getComputedStyle(node).color), `rgb(${spectrumChannels.join(', ')})`);
      assert.equal(await foregroundHue.evaluate(node => document.activeElement === node), true, 'A spectrum click transfers keyboard focus to its hue slider');
      await foregroundHex.fill('#000000');
      const plane = foregroundPalette.locator('.manual-color-plane');
      await foregroundHex.focus();
      await plane.scrollIntoViewIfNeeded();
      const fieldPixels = await sharp(await plane.screenshot()).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      let bounds = await plane.boundingBox();
      assert.ok(bounds && bounds.width > 100 && bounds.height > 80);
      await page.mouse.click(bounds.x + bounds.width * .7, bounds.y + bounds.height * .3);
      const pickedHex = await foregroundHex.inputValue();
      assert.match(pickedHex, /^#[0-9A-F]{6}$/);
      assert.notEqual(pickedHex, '#000000', 'Selecting saturation and brightness from black produces a visible color immediately');
      const pickedChannels = pickedHex.slice(1).match(/../g).map(channel => Number.parseInt(channel, 16));
      assert.ok(Math.max(...pickedChannels) > Math.min(...pickedChannels));
      const pixelOffset = (Math.floor(fieldPixels.info.height * .3) * fieldPixels.info.width + Math.floor(fieldPixels.info.width * .7)) * fieldPixels.info.channels;
      const visibleChannels = [...fieldPixels.data.subarray(pixelOffset, pixelOffset + 3)];
      assert.ok(pickedChannels.every((channel, index) => Math.abs(channel - visibleChannels[index]) <= 4), `The actual SV field pixel ${visibleChannels} matches the selected HEX channels ${pickedChannels}`);
      assert.equal(await foregroundPicker.locator('.manual-color-swatch > span').evaluate(node => getComputedStyle(node).backgroundColor), `rgb(${pickedChannels.join(', ')})`);
      assert.equal(await manualPanel.locator('.manual-preview').evaluate(node => getComputedStyle(node).color), `rgb(${pickedChannels.join(', ')})`);
      const pickedRatio = fixtureRun(pickedHex, '#FFFFFF', 16).contrast.ratio;
      assert.equal((await manualPanel.locator('.manual-ratio').textContent()).replace(/\s/g, ''), new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(pickedRatio) + ':1', 'HEX, visible sample and contrast update from the same selected color');
      assert.ok(Math.abs(Number(await foregroundSaturation.inputValue()) - 70) <= 2);
      assert.ok(Math.abs(Number(await foregroundValue.inputValue()) - 70) <= 2);
      assert.equal(await foregroundHex.evaluate(node => document.activeElement === node), true, 'Selecting from the SV square retains the HEX field focus');
      await foregroundHex.press('Escape');
      assert.equal(await foregroundPalette.isVisible(), false, 'Escape closes the palette even when the HEX input retained focus after a real SV click');
      assert.equal(await foregroundPicker.evaluate(node => node === document.activeElement), true);
      await foregroundPicker.click(); await plane.scrollIntoViewIfNeeded(); bounds = await plane.boundingBox();
      // Pointer capture keeps dragging responsive beyond the square and clamps
      // the two axes independently to the actual saturation/value limits.
      await page.mouse.move(bounds.x + bounds.width * .5, bounds.y + bounds.height * .5);
      await plane.evaluate(node => node.addEventListener('pointerdown', event => { window.__manualPointerId = event.pointerId; }, { once: true }));
      await page.mouse.down();
      await page.mouse.move(bounds.x - 10, bounds.y - 10, { steps: 4 });
      assert.equal(await foregroundHex.inputValue(), '#FFFFFF');
      await page.mouse.move(bounds.x + bounds.width + 10, bounds.y + bounds.height + 10, { steps: 4 });
      assert.equal(await foregroundHex.inputValue(), '#000000');
      await plane.evaluate(node => node.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: window.__manualPointerId, pointerType: 'mouse' })));
      await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .2, { steps: 3 });
      assert.equal(await foregroundHex.inputValue(), '#000000', 'A cancelled pointer must stop changing the color');
      await page.mouse.up();
      await foregroundHex.fill('#808080');
      await foregroundHue.focus(); await foregroundHue.press('Home'); await foregroundHue.press('ArrowRight');
      assert.equal(await foregroundSaturation.inputValue(), '100');
      assert.equal(await foregroundValue.inputValue(), '100');
      const grayHueHex = await foregroundHex.inputValue();
      assert.notEqual(grayHueHex, '#808080'); assert.notEqual(grayHueHex, '#000000');
      assert.equal(await foregroundHue.evaluate(node => node === document.activeElement), true, 'Keyboard hue editing retains focus');
      await foregroundSaturation.focus(); await foregroundSaturation.press('Home');
      assert.equal(await foregroundHex.inputValue(), '#FFFFFF');
      await foregroundValue.focus(); await foregroundValue.press('Home');
      assert.equal(await foregroundHex.inputValue(), '#000000');
      await foregroundValue.press('End');
      assert.equal(await foregroundHex.inputValue(), '#FFFFFF');
      await foregroundValue.press('Escape');
      assert.equal(await foregroundPalette.isVisible(), false);
      assert.equal(await foregroundPicker.evaluate(node => node === document.activeElement), true);
      // Recover an invalid draft through an explicit palette selection.
      await foregroundHex.fill('#NOPE');
      assert.equal(await manualCopy.isDisabled(), true);
      await foregroundPicker.click();
      await plane.scrollIntoViewIfNeeded();
      let recoveryBounds = await plane.boundingBox();
      await page.mouse.click(recoveryBounds.x + recoveryBounds.width * .7, recoveryBounds.y + recoveryBounds.height * .3);
      assert.match(await foregroundHex.inputValue(), /^#[0-9A-F]{6}$/);
      assert.equal(await foregroundHex.getAttribute('aria-invalid'), 'false');
      assert.equal(await manualCopy.isEnabled(), true);
      assert.ok(Math.abs(Number(await foregroundSaturation.inputValue()) - 70) <= 2, 'Removing the validation error does not shift the selected saturation');
      assert.ok(Math.abs(Number(await foregroundValue.inputValue()) - 70) <= 2, 'Removing the validation error does not shift the selected brightness');
      const recoveredColor = await foregroundHex.inputValue();
      await foregroundHex.fill('#INVALID');
      await plane.scrollIntoViewIfNeeded(); recoveryBounds = await plane.boundingBox();
      await page.mouse.click(recoveryBounds.x + recoveryBounds.width * .7, recoveryBounds.y + recoveryBounds.height * .3);
      assert.equal(await foregroundHex.inputValue(), recoveredColor, 'Choosing the same last-valid color explicitly must recover an invalid HEX draft too');
      assert.equal(await foregroundHex.getAttribute('aria-invalid'), 'false');
      await foregroundHue.press('Escape');
      await foregroundHex.fill('#FFFFFF'); await backgroundHex.fill('#000000');
      await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
      await backgroundHex.fill('#FFFFFF');
      await assertManualRatio(1, ['fail', 'fail'], ['fail', 'fail']);
      await foregroundHex.fill('#777777');
      await assertManualRatio(4.48, ['fail', 'fail'], ['pass', 'fail']);
      await foregroundHex.fill('#707070');
      await assertManualRatio(4.95, ['pass', 'fail'], ['pass', 'pass']);
      await manualCopy.click();
      const report = await page.evaluate(() => window.__copied);
      assert.ok(report.startsWith(label('manualContrastTitle')));
      assert.ok(report.includes(label('manualContrastScope')));
      assert.ok(report.includes(label('normalText')) && report.includes(label('largeText')));
      assert.ok(report.includes('#707070') && report.includes('#FFFFFF'));
      assert.ok(report.includes('AA') && report.includes('AAA'));
      assert.ok(!report.includes(label('measuredAt') + ':'), 'A manual report does not invent a page measurement timestamp');
      assert.equal(await page.locator('.code-preview').count(), 0);
      assert.ok(await page.locator('.content').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${locale}/${appearance}: manual calculator fits 280px`);
      await page.locator('#tab-colors').click();
      assert.equal(await manualPanel.count(), 0);
      await page.locator('#tab-contrast').click();
      assert.equal(await foregroundHex.inputValue(), '#707070'); assert.equal(await backgroundHex.inputValue(), '#FFFFFF');
      await assertManualRatio(4.95, ['pass', 'fail'], ['pass', 'pass']);
      assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, audit: window.__state.audit, commands: window.__commands, requests: window.__permissionRequests })), localBefore, 'Manual colors, copying and tab changes request no page permission, run no audit and create no snapshot');
    }
    await foregroundHex.focus();
    await foregroundHex.evaluate(node => { window.__manualNavigationForeground = node; node.setSelectionRange(2, 4); });
    await page.evaluate(() => window.__emit({ tabId: 101, documentToken: 'manual-navigation', documentRevision: 7, selected: null, preview: null, audit: null, lastEvent: 'document-changed' }));
    assert.equal(await page.locator('[aria-selected=true]').getAttribute('id'), 'tab-contrast', 'Navigation preserves an already open manual calculator without another tab click');
    assert.equal(await foregroundHex.inputValue(), '#707070', 'Navigation does not discard the independent manual color draft');
    assert.deepEqual(await foregroundHex.evaluate(node => ({ same: node === window.__manualNavigationForeground, focused: document.activeElement === node, start: node.selectionStart, end: node.selectionEnd })), { same: true, focused: true, start: 2, end: 4 });
    assert.deepEqual(await page.evaluate(() => ({ selected: window.__state.selected, preview: window.__state.preview, audit: window.__state.audit })), { selected: null, preview: null, audit: null }, 'Preserving the local calculator cannot preserve a previous page measurement');
    await assertManualRatio(4.95, ['pass', 'fail'], ['pass', 'pass']);
    const manualConnections = await page.evaluate(() => window.__connectionCount);
    await page.evaluate(() => window.__disconnect());
    assert.equal(await manualCopy.isEnabled(), true, 'Manual color copying does not depend on the content connection');
    assert.equal(await manualExport.isDisabled(), true);
    await manualCopy.click();
    assert.ok((await page.evaluate(() => window.__copied)).includes(label('manualContrastScope')));
    await page.waitForFunction(previous => window.__connectionCount > previous, manualConnections);
    // A real element selection takes priority without changing either source.
    const measuredSelection = { ...snapshot, id: 'manual-superseded-by-selection', document: { ...snapshot.document, documentToken: 'new-page' } };
    await page.evaluate(selected => window.__emit({ selected, access: 'ready', selectionTab: 'contrast', lastEvent: 'selected' }), measuredSelection);
    assert.equal(await manualPanel.count(), 0);
    assert.equal(await page.locator('.selected-card').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__state.selected), measuredSelection);
    await page.evaluate(() => window.__emit({ selected: null, lastEvent: 'ready' }));
    assert.equal(await foregroundHex.inputValue(), '#707070');
    await assertManualRatio(4.95, ['pass', 'fail'], ['pass', 'pass']);
    // Clearing local data also clears the independent manual draft.
    await page.locator('.header button').click();
    await page.getByRole('button', { name: label('clearData'), exact: true }).click();
    await page.getByRole('button', { name: label('actionConfirm'), exact: true }).click();
    await page.locator('#tab-contrast').click();
    assert.equal(await foregroundHex.inputValue(), '#000000'); assert.equal(await backgroundHex.inputValue(), '#FFFFFF');
    await assertManualRatio(21, ['pass', 'pass'], ['pass', 'pass']);
    await context.close();
    console.log(`${locale}: selected-run and root text excerpts, literal read-only text and explicit copies, truncation and empty states, narrow light/dark layouts, text-free style exports, clipboard fallback invalidation, preview/navigation/rescan/clear isolation passed`);
    console.log(`${locale}: page palettes and full CSS font stacks without selection, page-token copy/export defaults and frozen drafts, element priority, stale/partial/cancelled/running and empty states, navigation and rescan replacement; simultaneous AA/AAA results, target-aware ratio colors, explicit missing measurements, separate CSS color ratios and conditional AA/AAA thresholds with precise alpha, target colors, CSS pair counts/filter and unchanged actual WCAG verdicts/counts/JSON, disjoint no-value/CSS-pair filters with excluded real values and exemptions, empty-filter counts and rescan reset, qualified copies, local manual HEX and inline HSV picker synchronization, black/white preservation, saturation/value pointer dragging with outside clamping and cancellation, keyboard hue/saturation/value controls and single-palette Escape focus, invalid input without stale results and explicit picker recovery, normal/large manual thresholds, retained typing focus and drafts, permission-free manual copies without invented exports, selected-element priority and clear-data reset, labeled placeholders without unsupported suggestions, large/unknown text, compact color previews with exact alpha/copy semantics, narrow layouts, unchanged decorated export bytes, sidebar rule counts, prominent stale-node actions, reconnection, navigation permission/retry/races, rescan reset, settings, focus, preview, clipboard fallback and late-denial isolation, export isolation, downloads, direct suggestion hex copies across color preferences and simulation passed`);
  }
  assert.deepEqual(errors, []);
} finally { await browser.close(); await host.close(); }
