import { chromium } from 'playwright';
import { tsImport } from 'tsx/esm/api';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve, root, defaults, message } from './support.mjs';

// The report uses actual browser-computed colors from the built UI. Fixtures are
// explicit test data, never injected into the production extension at runtime.
const baseline = process.argv.includes('--baseline');
const { fixtureRun, fixtureSnapshot, fixtureAudit } = await tsImport('../fixtures/export/data.ts', import.meta.url);
const { parseColor } = await tsImport('../../src/core/colors.ts', import.meta.url);
const bad = fixtureRun(), good = { ...fixtureRun('#707070', '#ffffff', 16), id: 'good', elementRef: 'good' };
const manual = { ...fixtureRun('#17243a', '#ffffff', 16), id: 'manual', elementRef: 'manual', effectiveBackground: null, reasons: ['background-image'] };
const cssSample = { ...fixtureRun('#0F1111', '#FFA41C', 14), id: 'css-sample', elementRef: 'css-sample', reasons: ['overlapping-element'] };
const cssSplit = { ...fixtureRun('#707070', '#FFFFFF', 16), id: 'css-split', elementRef: 'css-split', reasons: ['overlapping-element'] };
const cssFail = { ...fixtureRun('#AAAAAA', '#FFFFFF', 16), id: 'css-fail', elementRef: 'css-fail', reasons: ['overlapping-element'] };
const cssLarge = { ...fixtureRun('#888888', '#FFFFFF', 24), id: 'css-large', elementRef: 'css-large', reasons: ['overlapping-element'] };
const cssUnknown = { ...cssSample, id: 'css-unknown', elementRef: 'css-unknown', fontSizeCssPx: null };
const exempt = { ...fixtureRun('#17243a', '#ffffff', 16), id: 'exempt', elementRef: 'exempt', notApplicable: 'inactive-control' };
const large = { ...fixtureRun('#707070', '#ffffff', 24), id: 'large', elementRef: 'large' };
const snapshot = fixtureSnapshot(bad), audit = fixtureAudit([bad, good, manual, cssSample, exempt, large]);
audit.paletteUsage = [
  { color: parseColor('#FFFFFF'), count: 21, roles: { background: 21, text: 2 } },
  { color: parseColor('#707070'), count: 8, roles: { text: 8 } },
  { color: parseColor('#0066CC'), count: 6, roles: { accent: 6 } },
  { color: parseColor('#00000000'), count: 30, roles: { other: 30 } },
];
audit.fontUsage = [{ family: audit.fonts[0], count: 21, sizes: [{ sizeCssPx: 12, count: 7 }, { sizeCssPx: 14.5, count: 5 }, { sizeCssPx: 16, count: 8 }, { sizeCssPx: null, count: 1 }] }];
audit.paletteUsage[0].elementRefs = [bad.elementRef, good.elementRef];
audit.fontUsage[0].elementRefs = [bad.elementRef, good.elementRef];
audit.fontUsage[0].sizes[0].elementRefs = [bad.elementRef];
audit.fontUsage[0].variants = [{ sizeCssPx: 16, fontWeight: 400, lineHeight: '24px', count: 2, elementRefs: [bad.elementRef, good.elementRef] }, { sizeCssPx: 20, fontWeight: 700, lineHeight: 'normal', count: 1, elementRefs: [good.elementRef] }];
snapshot.textExcerpt = { value: 'Synthetic selected element excerpt for the interface contrast check.', truncated: true };
snapshot.textRuns[0].textExcerpt = { value: 'Synthetic selected text area.', truncated: false };
snapshot.styles.colors['border-top-color'] = '#12345680';
snapshot.styles.colors['border-right-color'] = 'color(display-p3 1 0 0)';
snapshot.styles.typography['text-decoration-color'] = '#ABCDEF';
snapshot.styles.layout['border-bottom-color'] = '#123456';
const host = await serve();
const browser = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
const measurements = [], errors = [];

// This independent WCAG calculation deliberately does not import our analyzer.
// Group opacity and transparent ancestor backgrounds are composited in paint
// order. Anti-aliasing is excluded, as required for nominal text-color testing.
async function inspect(page, context, selector = 'body') {
  const data = await page.evaluate(selector => {
    const scope = document.querySelector(selector);
    if (!scope) return { text: [], nonText: [], excluded: {} };
    const excluded = { preview: 0, hidden: 0, disabled: 0 };
    const text = [], nonText = [];
    const parse = value => {
      const match = value.match(/^rgba?\(([^)]+)\)$/);
      if (!match) throw new Error(`Unrecognized browser color: ${value}`);
      const parts = match[1].split(/[\s,/]+/).filter(Boolean).map(Number);
      return [parts[0], parts[1], parts[2], parts[3] ?? 1];
    };
    const over = (top, bottom) => {
      const alpha = top[3] + bottom[3] * (1 - top[3]);
      return alpha ? [0, 1, 2].map(i => (top[i] * top[3] + bottom[i] * bottom[3] * (1 - top[3])) / alpha).concat(alpha) : [0, 0, 0, 0];
    };
    const luminance = rgb => rgb.slice(0, 3).map(channel => {
      const c = channel / 255;
      return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
    }).reduce((sum, channel, i) => sum + channel * [.2126, .7152, .0722][i], 0);
    const contrast = (first, second) => (Math.max(luminance(first), luminance(second)) + .05) / (Math.min(luminance(first), luminance(second)) + .05);
    const paint = (element, ink = [0, 0, 0, 0]) => {
      let result = ink;
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (style.backgroundImage !== 'none') throw new Error(`Unmeasured interface layer: ${node.className}`);
        result = over(result, parse(style.backgroundColor)); result[3] *= Number(style.opacity);
      }
      return over(result, [255, 255, 255, 1]);
    };
    const visible = node => node.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) && node.getBoundingClientRect().width > 0;
    const describe = node => node.tagName.toLowerCase() + (node.id ? `#${node.id}` : '') + (typeof node.className === 'string' && node.className ? '.' + node.className.trim().replace(/\s+/g, '.') : '');
    const recordGraphic = (node, kind, foreground, background, detail) => {
      const ratio = contrast(foreground, background);
      nonText.push({ element: describe(node), kind, detail, foreground, background, ratio, threshold: 3, pass: ratio >= 3 });
    };
    const opaqueGroups = node => {
      for (let parent = node; parent; parent = parent.parentElement) if (Number(getComputedStyle(parent).opacity) !== 1) throw new Error(`Unsupported group opacity for boundary/focus measurement: ${describe(parent)}`);
    };
    const add = (element, value) => {
      if (!value.trim()) return;
      if (element.closest('.color-preview,.font-preview,.swatch')) { excluded.preview++; return; }
      if (element.closest('.sr-only,svg,option') || !element.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })) { excluded.hidden++; return; }
      for (let parent = element; parent; parent = parent.parentElement) {
        if (parent.tagName === 'DETAILS' && !parent.open && !parent.querySelector(':scope > summary')?.contains(element)) { excluded.hidden++; return; }
      }
      const style = getComputedStyle(element), disabled = Boolean(element.closest(':disabled,[aria-disabled="true"]'));
      let foreground = parse(style.color), background = [0, 0, 0, 0];
      for (let parent = element; parent; parent = parent.parentElement) {
        const parentStyle = getComputedStyle(parent), layer = parse(parentStyle.backgroundColor);
        if (parentStyle.backgroundImage !== 'none') throw new Error(`Unmeasured UI background image: ${element.className}`);
        foreground = over(foreground, layer); background = over(background, layer);
        const opacity = Number(parentStyle.opacity);
        foreground[3] *= opacity; background[3] *= opacity;
      }
      foreground = over(foreground, [255, 255, 255, 1]); background = over(background, [255, 255, 255, 1]);
      const first = luminance(foreground), second = luminance(background);
      const ratio = (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
      const size = parseFloat(style.fontSize), weight = Number(style.fontWeight);
      const threshold = size >= 24 || size >= 14 * 96 / 72 && weight >= 700 ? 3 : 4.5;
      if (disabled) excluded.disabled++;
      const contrastValue = element.closest('.contrast-value'), assessment = element.closest('.assessment'), suggestionColor = element.closest('.suggestion-color');
      text.push({ element: element.tagName.toLowerCase() + (element.id ? `#${element.id}` : '') + (typeof element.className === 'string' && element.className ? '.' + element.className.trim().replace(/\s+/g, '.') : ''), text: value.trim().replace(/\s+/g, ' ').slice(0, 120), color: style.color, foreground, background, fontSize: size, fontWeight: weight, ratio, threshold, disabled, pass: ratio >= threshold, ...(contrastValue ? { contrastStatus: contrastValue.dataset.status, contrastTarget: contrastValue.dataset.target, contrastSource: contrastValue.dataset.source ?? 'page', cssContrastStatus: contrastValue.dataset.cssStatus } : {}), ...(assessment ? { assessmentLevel: assessment.dataset.level, assessmentSource: assessment.closest('.css-assessments') ? 'css-colors' : 'page', cssComparison: assessment.dataset.comparison } : {}), ...(suggestionColor ? { suggestionSide: suggestionColor.dataset.side } : {}), ...(element.closest('.color-chip') ? { colorChip: true } : {}), ...(element.closest('.code-color') ? { exportColorToken: true } : {}) });
    };
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.parentElement?.closest('script,style,textarea,select')) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      if (range.getBoundingClientRect().width > 0) add(node.parentElement, node.textContent ?? '');
    }
    for (const control of scope.querySelectorAll('select,textarea,input[type="text"]')) add(control, control.tagName === 'SELECT' ? control.selectedOptions[0]?.text ?? '' : control.value);
    const nodes = selector => [...(scope.matches(selector) ? [scope] : []), ...scope.querySelectorAll(selector)];
    // Editable fields rely on their boundary. Decorative card/separator lines
    // and user-selected swatch colors are deliberately not interface criteria.
    for (const control of nodes('input[type="text"],button[id$="-picker"],select,textarea')) {
      if (!visible(control) || control.matches(':disabled')) continue;
      opaqueGroups(control);
      const style = getComputedStyle(control), outside = paint(control.parentElement);
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        if (style[`border${side}Style`] === 'none' || parseFloat(style[`border${side}Width`]) <= 0) { nonText.push({ element: describe(control), kind: 'field-boundary', detail: side, ratio: 0, threshold: 3, pass: false }); continue; }
        const ink = over(parse(style[`border${side}Color`]), paint(control));
        recordGraphic(control, 'field-boundary', ink, outside, `${side}: outside`);
        if (control.type !== 'color') recordGraphic(control, 'field-boundary', ink, paint(control), `${side}: inside`);
      }
    }
    for (const graphic of nodes('svg')) {
      if (!visible(graphic) || graphic.closest(':disabled,[aria-disabled="true"],.color-preview,.font-preview,.swatch')) continue;
      for (const shape of graphic.querySelectorAll('path,circle,rect,line,polyline,polygon')) {
        if (!shape.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true }) || !(shape.getBoundingClientRect().width > 0 || shape.getBoundingClientRect().height > 0)) continue;
        const style = getComputedStyle(shape), background = paint(shape);
        for (const prop of ['stroke', 'fill']) {
          if (style[prop] === 'none' || Number(style[`${prop}Opacity`]) === 0 || prop === 'stroke' && parseFloat(style.strokeWidth) === 0) continue;
          const ink = parse(style[prop]); ink[3] *= Number(style[`${prop}Opacity`]);
          recordGraphic(graphic.closest('button') ?? graphic, 'icon', paint(shape, ink), background, prop);
        }
      }
    }
    for (const control of nodes('button,select,input,summary,textarea,[tabindex]')) {
      if (!visible(control) || !control.matches(':focus-visible') || control.matches(':disabled')) continue;
      opaqueGroups(control);
      const style = getComputedStyle(control), background = paint(control.parentElement);
      if (style.outlineStyle === 'none' || parseFloat(style.outlineWidth) <= 0) nonText.push({ element: describe(control), kind: 'focus-ring', ratio: 0, threshold: 3, pass: false });
      else recordGraphic(control, 'focus-ring', over(parse(style.outlineColor), background), background, 'outside at outline offset');
    }
    return { text, nonText, excluded };
  }, selector);
  measurements.push({ ...context, ...data });
}

try {
  for (const locale of ['en', 'de']) for (const theme of ['light', 'dark']) {
    const catalog = JSON.parse(await readFile(path.join(root, `_locales/${locale}/messages.json`), 'utf8'));
    const label = key => message(catalog, key);
    const state = { windowId: 42, tabId: 88, documentToken: snapshot.document.documentToken, access: 'ready', selected: snapshot, preview: null, picker: false, audit, progress: null, lastEvent: 'ready', settings: { ...defaults, appearance: theme } };
    const context = await browser.newContext({ viewport: { width: 380, height: 800 }, locale, colorScheme: theme });
    await context.addInitScript(({ state, catalog, locale }) => {
      window.__state = structuredClone(state); window.__listeners = []; window.__failClipboard = false;
      const emit = () => window.__listeners.forEach(fn => fn({ type: 'state', state: structuredClone(window.__state) }));
      window.__emit = patch => { Object.assign(window.__state, patch); emit(); };
      const getMessage = (key, substitutions = []) => {
        const entry = catalog[key], values = Array.isArray(substitutions) ? substitutions : [substitutions];
        return entry?.message.replace(/\$([a-z\d]+)\$/gi, (_, name) => values[Number(entry.placeholders?.[name]?.content.slice(1)) - 1] ?? '') ?? '';
      };
      window.browser = { i18n: { getUILanguage: () => locale, getMessage }, runtime: {
        getManifest: () => ({ version: '1.0.0' }), connect: () => ({ onMessage: { addListener: fn => window.__listeners.push(fn) }, onDisconnect: { addListener() {} }, postMessage(command) {
          if (command.type === 'ready') emit();
          if (command.type === 'update-settings') { Object.assign(window.__state.settings, command.settings); emit(); }
          if (command.type === 'start-picker') { window.__state.picker = true; window.__state.lastEvent = 'preview'; emit(); }
          if (command.type === 'cancel-picker') { window.__state.picker = false; window.__state.preview = null; window.__state.lastEvent = 'picker-cancelled'; emit(); }
        } }) }, windows: { getCurrent: async () => ({ id: 42 }) }, commands: { getAll: async () => [] }, permissions: { request: async () => false } };
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { if (window.__failClipboard) throw new Error('Fixture clipboard denial'); } } });
    }, { state, catalog, locale });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`${host.url}/dist/sidebar/index.html`); await page.locator('.metrics').waitFor();
    const check = async (view, interactions = false) => {
      await page.mouse.move(0, 0);
      await inspect(page, { locale, theme, view, interaction: 'normal' });
      if (interactions) for (const selector of ['.footer .primary', '.picker', '.tab[aria-selected="true"]', '.filter-bar button[aria-pressed="true"]', '.danger', '.actions button', '.show-node', '.suggestion-color button', '.section-title button', 'input[type="text"]', '#show-diagnostics', '#manual-foreground-picker', '#manual-foreground-hue', '#manual-foreground-saturation', '#manual-foreground-value', 'select', '.clipboard-fallback', '.inventory-matches', '.palette-use-text', '.palette-use-background', '.diagnostic-copy', '.font-variants > summary', '.audit-group > summary']) {
        const control = page.locator(selector).first();
        if (!await control.count() || !await control.isVisible() || !await control.isEnabled()) continue;
        await control.hover(); await inspect(page, { locale, theme, view, interaction: 'hover' }, selector);
        await page.mouse.move(0, 0); await page.keyboard.press('Tab'); await control.focus();
        assert.equal(await control.evaluate(node => node.matches(':focus-visible')), true, `${view}/${selector}: keyboard focus is visible`);
        await inspect(page, { locale, theme, view, interaction: 'focus' }, selector);
      }
    };
    for (const tab of ['audit', 'contrast', 'colors', 'typography', 'layout']) {
      await page.locator(`#tab-${tab}`).click();
      await page.locator('details').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
      await check(tab, true);
      if (!baseline && ['audit', 'contrast'].includes(tab)) {
        assert.equal(await page.locator('.diagnostic-copy').count(), 0, `${tab}: diagnostics hidden by default`);
        await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, showDiagnostics: true }, lastEvent: 'settings' }));
        assert.ok(await page.locator('.diagnostic-copy').count() > 0, `${tab}: opted-in diagnostics visible`);
        await check(`${tab}-diagnostics-enabled`, true);
        await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, showDiagnostics: false }, lastEvent: 'settings' }));
      }
      if (tab === 'contrast') {
        const simulation = page.getByLabel(label('simulationMode'));
        for (const mode of ['protanopia', 'deuteranopia', 'tritanopia', 'grayscale']) { await simulation.selectOption(mode); await check(`simulation-${mode}`); }
        for (const [name, run, target, status, comparisons, thresholds = [4.5, 7]] of [
          ['normal-aa', good, 'AA', 'pass'], ['normal-aaa', good, 'AAA', 'fail'], ['large-aaa', large, 'AAA', 'pass'], ['unresolved', manual, 'AAA', 'manual'],
          ['css-colors', cssSample, 'AA', 'manual', ['pass', 'pass']], ['css-split-aa', cssSplit, 'AA', 'manual', ['pass', 'fail']], ['css-split-aaa', cssSplit, 'AAA', 'manual', ['pass', 'fail']],
          ['css-fail', cssFail, 'AA', 'manual', ['fail', 'fail']], ['css-large', cssLarge, 'AAA', 'manual', ['pass', 'fail'], [3, 4.5]], ['css-unknown', cssUnknown, 'AA', 'manual'],
          ['exempt', exempt, 'AA', 'not-applicable'], ['placeholder-pass', { ...good, textSource: 'placeholder' }, 'AA', 'pass'], ['placeholder-fail', { ...bad, textSource: 'placeholder' }, 'AA', 'fail'], ['placeholder-manual', { ...manual, textSource: 'placeholder' }, 'AA', 'manual'],
        ]) {
          const selected = { ...fixtureSnapshot(run), id: `contrast-${name}` };
          await page.evaluate(({ selected, target }) => window.__emit({ selected, settings: { ...window.__state.settings, contrastTarget: target }, lastEvent: 'ready' }), { selected, target });
          if (!baseline) {
            const numeric = page.locator(`.contrast-value[data-status="${status}"][data-target="${target}"] .ratio`);
            assert.equal(await numeric.count(), 1, `${locale}/${theme}/${name}: computed contrast is associated with the correct status and target`);
            if (name.startsWith('css-')) {
              assert.equal(await numeric.locator('.ratio-unit').count(), 1);
              assert.equal(await page.locator('.css-contrast-label').textContent(), label('cssColorContrast'));
              assert.equal(await page.locator('.css-contrast-notice').textContent(), label('cssColorContrastNotice'));
              assert.ok((await page.locator('.css-assessments').textContent()).includes(label('cssColorsOnly')));
              assert.equal(await page.locator('.css-page-unverified').count(), 1);
              assert.ok((await page.locator('.css-page-unverified').textContent()).includes(label('cssPageUnverified')));
              assert.equal(await page.locator('.assessment:not(.css-assessment)').count(), 0);
              assert.equal(await page.locator('.contrast-value .contrast-target').count(), 0);
              if (comparisons) {
                assert.equal(await page.locator('.contrast-value').getAttribute('data-css-status'), comparisons[target === 'AA' ? 0 : 1]);
                for (const [index, level] of ['AA', 'AAA'].entries()) {
                  const row = page.locator(`.css-assessment[data-level="${level}"]`);
                  assert.equal(await row.getAttribute('data-comparison'), comparisons[index]);
                  assert.equal(await row.locator(`.css-threshold.${comparisons[index]}`).count(), 1);
                  assert.ok((await row.textContent()).includes(message(catalog, 'cssThreshold', [level])));
                  assert.match((await row.locator('small').textContent()).replace(',', '.'), new RegExp(`${thresholds[index]}\\s*:\\s*1`));
                }
              } else {
                assert.equal(await page.locator('.contrast-value').getAttribute('data-css-status'), null);
                assert.equal(await page.locator('.css-assessment').count(), 0);
                assert.ok((await page.locator('.css-assessments').textContent()).includes(label('cssThresholdUnknown')));
              }
            } else if (status === 'manual' || status === 'not-applicable') {
              assert.equal(await numeric.textContent(), label('ratioUnavailable'));
              assert.equal(await numeric.locator('.ratio-unit').count(), 0, 'Missing measurements have no ratio unit');
            } else assert.equal(await numeric.evaluate(node => getComputedStyle(node).color), await numeric.locator('.ratio-unit').evaluate(node => getComputedStyle(node).color));
          }
          await check(`contrast-${name}`);
        }
        await page.evaluate(selected => window.__emit({ selected, settings: { ...window.__state.settings, contrastTarget: 'AA' }, lastEvent: 'ready' }), snapshot);
      }
    }
    for (const tab of ['colors', 'typography']) {
      for (const status of ['complete', 'partial', 'running']) {
        await page.evaluate(({ audit, status }) => window.__emit({ selected: null, preview: null, audit: { ...audit, status, stale: status === 'partial' }, lastEvent: 'ready' }), { audit, status });
        await page.locator(`#tab-${tab}`).click();
        await check(`page-${tab}-${status}`, status === 'complete');
        if (status === 'complete') {
          await page.locator('details.palette-actions,details.font-variants').evaluateAll(nodes => nodes.forEach(node => { node.open = true; }));
          await check(`page-${tab}-actions`, true);
          const matching = page.locator(tab === 'colors' ? '.palette-item .inventory-matches:enabled' : '.font-usage-item > .inventory-matches:enabled').first();
          await matching.click(); await check(`page-${tab}-occurrences`, true);
          await page.locator('.section-title > .back').click();
          await page.setViewportSize({ width: 280, height: 800 });
          if (tab === 'colors') {
            for (const sort of ['usage', 'frequency', 'hue']) {
              await page.locator('#palette-sort').selectOption(sort);
              await check(`page-colors-${sort}-narrow`, true);
            }
            await page.locator('#palette-sort').selectOption('usage');
          } else {
            for (const sort of ['frequency', 'size-asc', 'size-desc']) {
              await page.locator('#font-sort').selectOption(sort);
              await check(`page-font-sizes-${sort}-narrow`, true);
            }
            await page.locator('#font-sort').selectOption('frequency');
          }
          await page.setViewportSize({ width: 380, height: 800 });
        }
      }
      await page.evaluate(audit => window.__emit({ audit: { ...audit, fonts: [], palette: [], paletteUsage: [], fontUsage: [] }, lastEvent: 'ready' }), audit);
      await check(`page-${tab}-empty`);
      await page.evaluate(() => window.__emit({ audit: null, lastEvent: 'ready' }));
      await check(`page-${tab}-not-scanned`, true);
    }
    await page.evaluate(({ snapshot, audit }) => window.__emit({ selected: snapshot, audit, lastEvent: 'ready' }), { snapshot, audit });
    await page.locator('#tab-audit').click();
    const repeat = { ...good, id: 'group-repeat', elementRef: 'group-repeat' };
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), fixtureAudit([good, repeat, manual, cssSample]));
    await page.locator('#audit-group-results').check();
    await page.locator('.audit-group > summary').click(); await page.locator('.audit-group .occurrence-item').first().waitFor();
    await check('audit-group-expanded', true);
    await page.locator('#audit-group-results').uncheck();
    await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), audit);
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, contrastTarget: 'AAA' }, lastEvent: 'ready' }));
    await check('audit-aaa', true);
    await page.evaluate(() => window.__emit({ settings: { ...window.__state.settings, contrastTarget: 'AA' }, lastEvent: 'ready' }));
    await page.locator('.header button').click(); await check('settings', true);
    if (!baseline) {
      assert.equal(await page.locator('#show-diagnostics').isChecked(), false);
      await page.locator('#show-diagnostics').check(); await check('settings-diagnostics-enabled', true);
      await page.locator('#show-diagnostics').uncheck();
    }
    await page.getByRole('button', { name: label('clearData'), exact: true }).click(); await check('clear-confirmation', true);
    await page.getByRole('button', { name: label('actionCancel'), exact: true }).click();
    await page.locator('#tab-colors').click(); await page.locator('.footer button:last-child').click();
    for (const format of ['css', 'scss', 'json', 'tailwind']) { await page.getByLabel(label('exportFormat'), { exact: true }).selectOption(format); await check(`export-${format}`, true); }
    if (!baseline) {
      const largeAudit = fixtureAudit(Array.from({ length: 100 }, (_, index) => ({ ...good, id: `export-${index}`, elementRef: `export-${index}` })));
      await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), largeAudit);
      await page.locator('#tab-audit').click(); await page.locator('.footer button:last-child').click();
      await page.getByLabel(label('exportSource'), { exact: true }).selectOption('audit');
      assert.equal(await page.locator('.export-preview-truncated').count(), 1);
      await check('export-shortened-preview');
      await page.evaluate(audit => window.__emit({ audit, lastEvent: 'audit' }), audit);
    }
    await page.locator('#tab-colors').click(); await page.evaluate(() => { window.__failClipboard = true; });
    await page.locator('.footer button:first-child').click(); await check('clipboard-fallback-and-toast');
    await page.getByRole('button', { name: label('actionClose'), exact: true }).click();
    await page.evaluate(() => { window.__failClipboard = false; });
    await page.locator('.picker').click(); await check('picker-pressed', true);
    await page.locator('.picker').click();
    await page.locator('#tab-audit').click();
    for (const status of ['running', 'cancelled', 'partial', 'complete']) {
      await page.evaluate(({ audit, status }) => window.__emit({ audit: { ...audit, status, stale: status === 'complete' }, error: status === 'partial' ? 'generic' : undefined, lastEvent: 'ready' }), { audit, status });
      await check(`audit-${status}`);
    }
    for (const access of ['ready', 'needs-activation', 'unsupported']) {
      await page.evaluate(access => window.__emit({ selected: null, audit: null, access, error: undefined, lastEvent: 'ready' }), access);
      await check(`empty-${access}`, true);
      await page.locator('#tab-contrast').click(); await check(`no-selection-${access}`, true);
      if (access === 'ready') {
        const foreground = page.locator('#manual-foreground-hex');
        for (const [name, value] of [['pass', '#000000'], ['fail', '#FFFFFF'], ['split', '#707070'], ['invalid', '#12']]) {
          await foreground.fill(value); await check(`manual-${name}`, true);
        }
        await page.locator('#manual-background-hex').fill('#12'); await check('manual-both-invalid', true);
        await page.locator('#manual-background-hex').fill('#FFFFFF');
        await foreground.fill('#000000'); await page.locator('#manual-foreground-picker').click(); await check('manual-color-picker', true);
        await page.locator('#manual-foreground-sv').click({position:{x:60,y:40}}); await check('manual-picker-colored', true);
        await page.setViewportSize({ width: 280, height: 650 }); await check('manual-narrow', true);
        await page.locator('#manual-foreground-hue').press('Escape');
        await page.locator('#manual-background-hex').fill('rgb(10 20 30 / .4)');
        await check('manual-transparent-background-missing-underlay', true);
        await page.locator('#manual-underlay-hex').fill('#FFFFFF');
        await check('manual-transparent-background-explicit-underlay', true);
        await page.locator('#manual-underlay-hex').fill('rgb(0 0 0 / .5)');
        await check('manual-transparent-underlay-invalid', true);
        await page.setViewportSize({ width: 380, height: 800 });
      }
      await page.locator('#tab-audit').click();
    }
    await context.close();
  }
  const rows = measurements.flatMap(({ text, nonText, excluded, ...state }) => text.map(row => ({ ...state, ...row })));
  const graphics = measurements.flatMap(({ text, nonText, excluded, ...state }) => nonText.map(row => ({ ...state, ...row })));
  const nonTextFailures = graphics.filter(row => !row.pass);
  const enabled = rows.filter(row => !row.disabled), disabled = rows.filter(row => row.disabled);
  const failures = enabled.filter(row => !row.pass), small = enabled.filter(row => row.fontSize < 12);
  const minimum = values => values.length ? values.reduce((result, row) => row.ratio < result.ratio ? row : result) : null;
  const report = { browser: browser.version(), baseline, scope: 'Rendered built sidebar: English/German, light/dark, five tabs, both AA/AAA assessments and selected targets, pass/fail/unresolved/exempt numeric colors for normal/large text, settings, export formats with decorated color tokens, compact color previews with adjacent readable text for opaque/alpha/unknown values, suggestion hex tiles and copy controls, prominent show-on-page actions, simulation, picker, empty/loading/error/stale states, hovered/focused controls. Nominal WCAG 2.2 text contrast; no antialiasing or page sample previews. Disabled controls are reported separately, not WCAG failures.', states: measurements.length, textMeasurements: rows.length, enabledMeasurements: enabled.length, disabledMeasurements: disabled.length, minimumEnabled: minimum(enabled), minimumDisabled: minimum(disabled), perTheme: Object.fromEntries(['light', 'dark'].map(theme => [theme, minimum(enabled.filter(row => row.theme === theme))])), failures, fontSizesBelow12: small, errors, measurements };
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  const reportFile = path.join(root, 'test-results', baseline ? 'sidebar-contrast-baseline.json' : 'sidebar-contrast.json');
  Object.assign(report, { nonTextMeasurements: graphics.length, nonTextFailures, nonTextPerTheme: Object.fromEntries(['light', 'dark'].map(theme => [theme, minimum(graphics.filter(row => row.theme === theme))])) });
  report.scope += ' Inventory actions and occurrence lists, font variants, expanded audit groups and diagnosis controls. Manual HEX/RGB-alpha calculator with explicit underlying surfaces, open palettes, invalid values and narrow layout. Independently measured editable field boundaries, currentColor SVG shapes and CSS focus outlines meet 3:1; decorative lines, selected color swatches, palette gradients and native widget interiors are excluded.';
  await writeFile(reportFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ reportFile, states: report.states, textMeasurements: rows.length, nonTextMeasurements: graphics.length, nonTextFailures: nonTextFailures.length, nonTextPerTheme: report.nonTextPerTheme, failures: failures.length, fontSizesBelow12: small.length, minimumEnabled: report.minimumEnabled, minimumDisabled: report.minimumDisabled, perTheme: report.perTheme }, null, 2));
  assert.deepEqual(errors, [], 'No sidebar page errors');
  assert.ok(enabled.length > 500, 'Substantial actual rendered UI coverage');
  if (!baseline) {
    for (const theme of ['light', 'dark']) for (const status of ['pass', 'fail', 'manual', 'not-applicable']) {
      assert.ok(enabled.some(row => row.theme === theme && row.contrastStatus === status && /(?:\.ratio|\.audit-ratio)/.test(row.element)), `${theme}: actual numeric UI text measured for ${status}`);
    }
    for (const theme of ['light', 'dark']) {
      for (const status of ['pass', 'fail']) {
        assert.ok(enabled.some(row => row.theme === theme && row.contrastSource === 'css-colors' && row.cssContrastStatus === status && /(?:\.ratio|\.audit-ratio)/.test(row.element)), `${theme}: separately labeled CSS ${status} numeric text measured`);
        assert.ok(enabled.some(row => row.theme === theme && row.assessmentSource === 'css-colors' && row.cssComparison === status && row.element.includes('.css-threshold')), `${theme}: CSS-only ${status} threshold badges measured`);
      }
      for (const side of ['before', 'after']) assert.ok(enabled.some(row => row.theme === theme && row.suggestionSide === side && row.element.includes('.suggestion-hex')), `${theme}: visible ${side} hex text measured independently from the color swatch`);
      for (const view of ['contrast', 'colors', 'typography', 'layout']) assert.ok(enabled.some(row => row.theme === theme && row.view === view && row.colorChip), `${theme}/${view}: compact color-value text is measured independently of the swatch`);
      for (const format of ['css', 'scss', 'json', 'tailwind']) assert.ok(enabled.some(row => row.theme === theme && row.view === `export-${format}` && row.exportColorToken), `${theme}/${format}: decorated export tokens remain readable`);
      for (const interaction of ['normal', 'hover', 'focus']) assert.ok(enabled.some(row => row.theme === theme && row.interaction === interaction && row.element.includes('.show-node')), `${theme}: prominent show-on-page text measured while ${interaction}`);
    }
    assert.deepEqual(failures, [], 'Every enabled UI text sample meets its WCAG AA threshold');
    assert.deepEqual(nonTextFailures, [], 'Editable boundaries, SVG controls and focus outlines meet 3:1');
    for (const theme of ['light', 'dark']) for (const kind of ['field-boundary', 'icon', 'focus-ring']) assert.ok(graphics.some(row => row.theme === theme && row.kind === kind), `${theme}: actual ${kind} colors measured`);
    for (const theme of ['light', 'dark']) for (const suffix of ['hex', 'picker']) for (const kind of ['field-boundary', 'focus-ring']) assert.ok(graphics.some(row => row.theme === theme && row.kind === kind && row.element.includes(`#manual-foreground-${suffix}`)), `${theme}: manual ${suffix} ${kind} measured`);
    for (const theme of ['light', 'dark']) for (const suffix of ['hue', 'saturation', 'value']) assert.ok(graphics.some(row => row.theme === theme && row.kind === 'focus-ring' && row.element.includes(`#manual-foreground-${suffix}`)), `${theme}: keyboard focus on ${suffix} slider measured`);
    assert.deepEqual(small, [], 'Own UI text remains at least 12 CSS px; page previews excluded');
    assert.ok(disabled.every(row => row.ratio >= 4.5), 'Non-normative readability goal: disabled text remains legible');
  }
} finally { await browser.close(); await host.close(); }
