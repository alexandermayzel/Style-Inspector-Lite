import assert from 'node:assert/strict';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { serve, root, defaults } from './support.mjs';
import { artifactsRoot, buildDir, resolveExternal } from '../../internal/scripts/paths.mjs';

const useFirefox = process.argv.includes('--firefox');
const findings = [];
const source = await readFile(path.join(buildDir, 'content.js'), 'utf8');
const messages = JSON.parse(await readFile(path.join(root, '_locales/en/messages.json'), 'utf8'));
const output = path.join(await resolveExternal(root, artifactsRoot), 'test-results');
const host = await serve();
let browser;

async function findDriver(directory) {
  for (const item of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) { const found = await findDriver(file); if (found) return found; }
    else if (/^geckodriver(?:\.exe)?$/.test(item.name)) return file;
  }
}

async function createBrowser() {
  if (!useFirefox) {
    const instance = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
    try {
      const page = await instance.newPage({ viewport: { width: 1100, height: 900 }, colorScheme: 'light' });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      return {
        name: `Chromium ${instance.version()}`, errors,
        evaluate: (fn, value) => page.evaluate(fn, value),
        navigate: url => page.goto(url),
        screenshot: () => page.screenshot(),
        prefer: dark => page.emulateMedia({ colorScheme: dark ? 'dark' : 'light' }),
        forced: active => page.emulateMedia({ forcedColors: active ? 'active' : 'none' }),
        close: () => instance.close(),
      };
    } catch (error) { await instance.close(); throw error; }
  }
  const { Builder } = await import('selenium-webdriver');
  const { default: firefox } = await import('selenium-webdriver/firefox.js');
  const options = new firefox.Options().addArguments('-headless')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('toolkit.telemetry.reportingpolicy.firstRun', false)
    .setPreference('layout.css.prefers-color-scheme.content-override', 1);
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  const driverPath = process.env.GECKODRIVER ?? await findDriver(path.join(root, '../Style-Inspector-Lite-artifacts/tools/selenium'));
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(driverPath).addArguments('--allow-system-access')).build();
  try {
    await driver.manage().setTimeouts({ implicit: 0, script: 15000, pageLoad: 30000 });
    const handles = await driver.getAllWindowHandles();
    await driver.switchTo().window(handles[0]);
    // Some startup pages discard their initial content browsing context.
    // Select a fresh tab in this isolated profile before content commands.
    await driver.setContext('chrome');
    await driver.executeScript('window.gBrowser.selectedTab = window.gBrowser.addTab("about:blank", {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});');
    await driver.setContext('content');
    await driver.switchTo().window((await driver.getAllWindowHandles()).at(-1));
    await driver.manage().window().setRect({ width: 1100, height: 1000 });
    const preference = async (kind, value) => {
      await driver.setContext('chrome');
      await driver.executeScript(`const [kind,value]=arguments;
        if(kind==='dark') Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override',value?0:1);
        else {
          Services.prefs.setBoolPref('browser.display.use_system_colors',false);
          Services.prefs.setStringPref('browser.display.background_color',value?'#f4d3a2':'#ffffff');
          Services.prefs.setStringPref('browser.display.foreground_color','#000000');
          Services.prefs.setIntPref('browser.display.document_color_use',value?2:0);
        }`, kind, value);
      await driver.setContext('content');
    };
    return {
      name: `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`, errors: [],
      evaluate: async (fn, value) => {
        const result = await driver.executeAsyncScript(`const [source,value,done]=arguments;
          Promise.resolve().then(()=>eval('('+source+')')(value))
            .then(result=>done({value:result}),error=>done({failure:String(error.stack||error)}));`, fn.toString(), value ?? null);
        if (result.failure) throw new Error(result.failure);
        return result.value;
      },
      navigate: url => driver.get(url),
      screenshot: async () => Buffer.from(await driver.takeScreenshot(), 'base64'),
      prefer: dark => preference('dark', dark),
      forced: active => preference('forced', active),
      close: () => driver.quit(),
    };
  } catch (error) { await driver.quit(); throw error; }
}

async function settle() {
  await browser.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)))));
}

async function scan(requestId) {
  await browser.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const audit = await browser.evaluate(requestId => window.__events.findLast(event =>
      event.requestId === requestId && event.audit && event.audit.status !== 'running')?.audit ?? null, requestId);
    if (audit) {
      assert.equal(audit.status, 'complete', JSON.stringify({ requestId, reasons: audit.reasons }));
      assert.equal(audit.stale, false, `${requestId}: own probes must not invalidate the scan`);
      return audit;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Audit timed out: ${requestId}`);
}

async function inspect(id) {
  const snapshot = await browser.evaluate(async id => {
    const requestId = `canvas-inspect-${id}`;
    window.__styleInspectorContext = { requestId, element: document.getElementById(id) };
    const response = await window.__command('capture-context', { requestId });
    if (response.error) throw new Error(response.error);
    const snapshot = window.__events.findLast(event => event.requestId === requestId && event.type === 'selected').snapshot;
    await window.__command('cancel-picker');
    return snapshot;
  }, id);
  assert.equal(snapshot.stale, false, `${id}: new inspection is fresh`);
  assert.equal(snapshot.textRuns.length, 1, `${id}: one real text run`);
  return snapshot.textRuns[0];
}

function sameColor(actual, expected, label) {
  assert.ok(actual, `${label}: background is resolved`);
  for (const channel of ['r', 'g', 'b', 'a']) assert.ok(Math.abs(actual[channel] - expected[channel]) < 1e-6,
    `${label}: ${channel} is ${actual[channel]}, expected ${expected[channel]}`);
}

async function surface() {
  const bytes = await browser.screenshot();
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const offset = (info.width + 1) * info.channels;
  return { r: data[offset], g: data[offset + 1], b: data[offset + 2], a: 1 };
}

async function unchangedDocument(expected, label) {
  await settle();
  const state = await browser.evaluate(() => ({
    count: document.querySelectorAll('*').length,
    markup: document.documentElement.outerHTML,
    audit: window.__events.findLast(event => event.audit)?.audit,
  }));
  assert.equal(state.count, expected.count, `${label}: no retained probe or overlay nodes`);
  assert.equal(state.markup, expected.markup, `${label}: measurement leaves the fixture unchanged`);
  assert.equal(state.audit.stale, false, `${label}: probe mutations must not stale an audit`);
  assert.ok(!state.audit.reasons.includes('document-changed-during-scan'), label);
}

try {
  browser = await createBrowser();
  await browser.navigate(`${host.url}/tests/fixtures/document-canvas.html`);
  await browser.evaluate(({ defaults, messages }) => {
    window.__events = []; window.__handlers = []; window.__pageErrors = [];
    window.addEventListener('error', event => { if (event.error) window.__pageErrors.push(String(event.error)); });
    window.browser = {
      runtime: {
        id: 'sil-canvas-test',
        onMessage: { addListener(handler) { window.__handlers.push(handler); } },
        sendMessage: async event => { window.__events.push(structuredClone(event)); },
      },
      i18n: { getUILanguage: () => 'en', getMessage: (key, value = '') => messages[key]?.message.replace(/\$value1\$/g, value) ?? '' },
    };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `canvas-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) {
        const response = handler(message, { id: 'sil-canvas-test' });
        if (response !== undefined) return await response;
      }
    };
  }, { defaults, messages });
  await browser.evaluate(source => { (0, eval)(source); }, source);
  assert.equal(await browser.evaluate(() => window.__handlers.length), 1);
  await browser.evaluate(() => window.__command('hello'));
  const original = await browser.evaluate(() => ({ count: document.querySelectorAll('*').length, markup: document.documentElement.outerHTML }));
  const initial = await scan('canvas-initial');
  const initialSurface = await surface();
  sameColor(initialSurface, { r: 255, g: 255, b: 255, a: 1 }, 'default browser surface');
  for (const id of ['art', 'comics', 'system', 'local-dark', 'contents']) {
    const run = await inspect(id);
    sameColor(run.effectiveBackground, initialSurface, id);
    assert.equal(run.contrast.ratio, 21, id);
    assert.equal(run.contrast.status, 'pass', id);
    assert.equal(run.background.rgba.a, 0, `${id}: own transparent CSS value remains transparent`);
    assert.equal(run.ownOpaqueBackground, false, id);
    const audited = initial.runs.find(item => item.elementRef === run.elementRef);
    assert.ok(audited, `${id}: the audit and selection share the real element`);
    assert.equal(audited.contrast.ratio, run.contrast.ratio, id);
    sameColor(audited.effectiveBackground, run.effectiveBackground, `${id}: audit/inspection`);
  }
  const alpha = await inspect('alpha');
  sameColor(alpha.effectiveBackground, { r: 127.5, g: 127.5, b: 127.5, a: 1 }, 'translucent black');
  assert.equal(alpha.contrast.status, 'fail');
  const gradient = await inspect('gradient');
  assert.equal(gradient.contrast.ratioKind, 'minimum');
  assert.equal(gradient.contrast.status, 'pass');
  assert.ok(gradient.contrast.ratio > 18);
  assert.ok(gradient.backgroundRange && gradient.backgroundRange.min.a === 1);
  const explicit = await inspect('explicit');
  sameColor(explicit.effectiveBackground, initialSurface, 'explicit white');
  assert.equal(explicit.ownOpaqueBackground, true);
  for (const [id, reason] of [['covered', 'overlapping-element'], ['image', 'background-image-or-gradient']]) {
    const run = await inspect(id);
    assert.equal(run.contrast.status, 'manual', id);
    assert.equal(run.contrast.ratio, null, id);
    assert.ok(run.reasons.includes(reason), `${id}: ${JSON.stringify(run.reasons)}`);
  }
  await unchangedDocument(original, 'initial audit and selections');
  findings.push({ check: 'Transparent navigation, own CSS values, alpha, gradient, explicit surfaces and real uncertain paint', runs: initial.runs.length });

  for (const [scheme, darkPreference] of [['dark', false], ['light', true], ['normal', true], ['light dark', true], ['light dark', false]]) {
    const previousScheme = await browser.evaluate(() => document.documentElement.style.colorScheme);
    await browser.prefer(darkPreference);
    await browser.evaluate(({ scheme, darkPreference }) => {
      document.documentElement.style.colorScheme = scheme;
      document.getElementById('local-dark').style.colorScheme = scheme === 'dark' || scheme === 'light dark' && darkPreference ? 'light' : 'dark';
    }, { scheme, darkPreference });
    await settle();
    if (scheme !== previousScheme) assert.equal(await browser.evaluate(() => window.__events.findLast(event => event.audit).audit.stale),
      true, `${scheme}: real root change invalidates the preceding audit`);
    const expectedMarkup = await browser.evaluate(() => ({ count: document.querySelectorAll('*').length, markup: document.documentElement.outerHTML }));
    const measuredSurface = await surface();
    const audit = await scan(`canvas-scheme-${scheme}-${darkPreference}`);
    const art = await inspect('art');
    sameColor(art.effectiveBackground, measuredSurface, `${scheme}/${darkPreference}: screenshot surface`);
    const local = await inspect('local-dark');
    sameColor(local.effectiveBackground, measuredSurface, 'Local color scheme does not replace the root surface');
    const system = await inspect('system');
    assert.equal(system.contrast.status, 'pass', `${scheme}: native system text`);
    const translucent = await inspect('alpha');
    sameColor(translucent.effectiveBackground, { r: measuredSurface.r / 2, g: measuredSurface.g / 2, b: measuredSurface.b / 2, a: 1 }, `${scheme}: alpha composition`);
    const ranged = await inspect('gradient');
    assert.ok(ranged.backgroundRange, `${scheme}: gradients remain anchored to the real canvas`);
    assert.equal(ranged.contrast.ratioKind, 'minimum');
    sameColor((await inspect('explicit')).effectiveBackground, { r: 255, g: 255, b: 255, a: 1 }, `${scheme}: explicit background`);
    assert.ok(audit.runs.some(run => run.elementRef === art.elementRef && run.contrast.ratio === art.contrast.ratio));
    await unchangedDocument(expectedMarkup, `scheme ${scheme}/${darkPreference}`);
    findings.push({ check: 'Root scheme and fresh audit match independent screenshot pixels', scheme, darkPreference, surface: measuredSurface });
  }

  await browser.prefer(false);
  await browser.forced(true);
  await browser.evaluate(() => { document.documentElement.style.colorScheme = 'normal'; });
  await settle();
  assert.equal(await browser.evaluate(() => matchMedia('(forced-colors:active)').matches), true);
  const forcedSurface = await surface();
  await scan('canvas-forced-colors');
  sameColor((await inspect('art')).effectiveBackground, forcedSurface, 'Forced browser colors');
  if (useFirefox) sameColor(forcedSurface, { r: 244, g: 211, b: 162, a: 1 }, 'Custom Firefox canvas preference');
  findings.push({ check: 'Forced colors use the browser palette', surface: forcedSurface });
  await browser.forced(false);

  await browser.evaluate(() => {
    const style = document.createElement('style');
    style.textContent = '#canvas-modal,#canvas-popover{background:transparent;color:#000;border:0;padding:24px}#canvas-modal::backdrop,#canvas-popover::backdrop{background:#777}';
    document.head.append(style);
    const host = document.createElement('div'); host.id = 'canvas-shadow';
    const child = document.createElement('span'); child.id = 'canvas-slotted'; child.textContent = 'Slotted text over a shadow surface';
    host.append(child);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<div style="background:#777"><slot></slot></div>';
    document.body.append(host);
    const direct = document.createElement('div'); direct.id = 'canvas-shadow-direct';
    direct.textContent = 'Direct host text over a shadow surface';
    direct.attachShadow({ mode: 'open' }).innerHTML = '<div style="background:#777"><slot></slot></div>';
    document.body.append(direct);
    const dialog = document.createElement('dialog'); dialog.id = 'canvas-modal';
    dialog.innerHTML = '<span id="canvas-modal-text">Transparent modal text</span>';
    document.body.append(dialog);
    const popover = document.createElement('div'); popover.id = 'canvas-popover'; popover.popover = 'manual';
    popover.innerHTML = '<span id="canvas-popover-text">Transparent popover text</span>';
    document.body.append(popover);
  });
  await settle();
  await scan('canvas-shadow');
  for (const id of ['canvas-slotted', 'canvas-shadow-direct']) {
    const slotted = await inspect(id);
    assert.equal(slotted.effectiveBackground, null, id);
    assert.ok(slotted.reasons.includes('unresolved-background'), id);
    assert.equal(slotted.contrast.status, 'manual', id);
  }
  for (const kind of ['modal', 'popover']) {
    await browser.evaluate(kind => {
      const node = document.getElementById(`canvas-${kind}`);
      if (kind === 'modal') node.showModal(); else node.showPopover();
    }, kind);
    await settle();
    await scan(`canvas-${kind}`);
    const run = await inspect(`canvas-${kind}-text`);
    assert.equal(run.effectiveBackground, null, `${kind}: backdrop cannot be skipped`);
    assert.ok(run.reasons.includes('unresolved-background'), `${kind}: ${JSON.stringify(run.reasons)}`);
    assert.equal(run.contrast.status, 'manual', kind);
    await browser.evaluate(kind => {
      const node = document.getElementById(`canvas-${kind}`);
      if (kind === 'modal') node.close(); else node.hidePopover();
    }, kind);
  }
  findings.push({ check: 'Slotted text and transparent modal/popover backdrops remain unresolved' });
  assert.deepEqual(browser.errors, []);
  assert.deepEqual(await browser.evaluate(() => window.__pageErrors), []);
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, `document-canvas-${browser.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-')}.json`),
    JSON.stringify({ browser: browser.name, findings }, null, 2));
  console.log(`${browser.name}: ${findings.length} document canvas checks passed`);
} finally {
  await browser?.close();
  await host.close();
}
