import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve, root, defaults } from './support.mjs';
import { artifactsRoot, buildDir, resolveExternal } from '../../internal/scripts/paths.mjs';

const useFirefox = process.argv.includes('--firefox');
const baseline = process.argv.includes('--baseline');
const contentOption = process.argv.indexOf('--content-dir');
const contentDirectory = contentOption < 0 ? buildDir : await resolveExternal(root, process.argv[contentOption + 1]);
const source = await readFile(path.join(contentDirectory, 'content.js'), 'utf8');
const messages = JSON.parse(await readFile(path.join(root, '_locales/en/messages.json'), 'utf8'));
const output = path.join(await resolveExternal(root, artifactsRoot), 'test-results');
const findings = [];
const host = await serve();
let browser;

async function createBrowser() {
  if (!useFirefox) {
    const instance = await chromium.launch({ channel: process.env.UI_BROWSER_CHANNEL ?? 'msedge', headless: true });
    try {
      const page = await instance.newPage({ viewport: { width: 1100, height: 1000 } });
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      return { name: `Chromium ${instance.version()}`, errors,
        evaluate: (fn, value) => page.evaluate(fn, value), navigate: url => page.goto(url),
        screenshot: () => page.screenshot(), close: () => instance.close() };
    } catch (error) { await instance.close(); throw error; }
  }
  const { Builder } = await import('selenium-webdriver');
  const { default: firefox } = await import('selenium-webdriver/firefox.js');
  const options = new firefox.Options().addArguments('-headless')
    .setPreference('browser.shell.checkDefaultBrowser', false)
    .setPreference('browser.startup.homepage_override.mstone', 'ignore')
    .setPreference('datareporting.policy.dataSubmissionEnabled', false)
    .setPreference('toolkit.telemetry.reportingpolicy.firstRun', false);
  if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
  else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
    .setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER).addArguments('--allow-system-access')).build();
  try {
    await driver.manage().setTimeouts({ implicit: 0, script: 15000, pageLoad: 30000 });
    const initialHandles = await driver.getAllWindowHandles();
    await driver.switchTo().window(initialHandles[0]);
    await driver.setContext('chrome');
    await driver.executeScript('window.gBrowser.selectedTab = window.gBrowser.addTab("about:blank", {triggeringPrincipal:Services.scriptSecurityManager.getSystemPrincipal()});');
    await driver.setContext('content');
    const handles = await driver.getAllWindowHandles();
    await driver.switchTo().window(handles.find(handle => !initialHandles.includes(handle)) ?? handles.at(-1));
    await driver.manage().window().setRect({ width: 1100, height: 1100 });
    return { name: `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`, errors: [],
      evaluate: async (fn, value) => {
        const result = await driver.executeAsyncScript(`const [source,value,done]=arguments;
          Promise.resolve().then(()=>eval('('+source+')')(value))
            .then(result=>done({value:result}),error=>done({failure:String(error.stack||error)}));`, fn.toString(), value ?? null);
        if (result.failure) throw new Error(result.failure);
        return result.value;
      },
      navigate: url => driver.get(url), screenshot: async () => Buffer.from(await driver.takeScreenshot(), 'base64'), close: () => driver.quit() };
  } catch (error) { await driver.quit(); throw error; }
}

async function scan(requestId) {
  await browser.evaluate(requestId => window.__command('start-audit', { requestId }), requestId);
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const audit = await browser.evaluate(requestId => window.__events.findLast(event =>
      event.requestId === requestId && event.audit && event.audit.status !== 'running')?.audit ?? null, requestId);
    if (audit) { assert.equal(audit.status, 'complete', requestId); return audit; }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Audit timed out: ${requestId}`);
}

async function inspect(id) {
  return browser.evaluate(async id => {
    const requestId = `counter-inspect-${id}`;
    window.__styleInspectorContext = { requestId, element: document.getElementById(id) };
    const response = await window.__command('capture-context', { requestId });
    if (response.error) throw new Error(response.error);
    const snapshot = window.__events.findLast(event => event.requestId === requestId && event.type === 'selected').snapshot;
    await window.__command('cancel-picker'); return snapshot;
  }, id);
}

function assertPlainCounter(run, label) {
  assert.deepEqual(run.foreground.rgba, { r: 241, g: 241, b: 241, a: 1 }, `${label}: exact text color`);
  assert.deepEqual(run.effectiveBackground, { r: 15, g: 15, b: 15, a: 1 }, `${label}: exact dark background`);
  assert.ok(run.contrast.ratio > 16 && run.contrast.ratio < 18, `${label}: a real measured ratio`);
  assert.equal(run.contrast.status, 'pass', `${label}: the actual contrast passes`);
  assert.equal(run.contrast.AA.status, 'pass', `${label}: AA passes`);
  assert.equal(run.contrast.AAA.status, 'pass', `${label}: AAA passes`);
}

try {
  browser = await createBrowser();
  await browser.navigate(`${host.url}/tests/fixtures/preformatted-counter.html`);
  await browser.evaluate(async ({ defaults, messages }) => {
    await document.fonts.ready;
    window.__events = []; window.__handlers = []; window.__pageErrors = [];
    window.addEventListener('error', event => { if (event.error) window.__pageErrors.push(String(event.error)); });
    window.browser = {
      runtime: { id: 'sil-counter-test', onMessage: { addListener(handler) { window.__handlers.push(handler); } },
        sendMessage: async event => { window.__events.push(structuredClone(event)); } },
      i18n: { getUILanguage: () => 'en', getMessage: (key, value = '') => messages[key]?.message.replace(/\$value1\$/g, value) ?? '' },
    };
    window.__command = async (type, detail = {}) => {
      const message = { channel: 'sil-content', type, requestId: `counter-${type}`, epoch: 0, windowId: 1, tabId: 1, settings: defaults, ...detail };
      for (const handler of window.__handlers) {
        const response = handler(message, { id: 'sil-counter-test' }); if (response !== undefined) return await response;
      }
    };
  }, { defaults, messages });
  await browser.evaluate(source => { (0, eval)(source); }, source);
  await browser.evaluate(() => window.__command('hello'));
  const cases = await browser.evaluate(() => [...document.querySelectorAll('[data-expected]')].map(node => {
    const style = getComputedStyle(node), range = document.createRange(); range.selectNodeContents(node.firstChild);
    const context = document.createElement('canvas').getContext('2d');
    context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const ink = context.measureText(node.firstChild.data);
    return { id: node.id, expected: node.dataset.expected, rect: node.getBoundingClientRect().toJSON(),
      clip: node.closest('.clip').getBoundingClientRect().toJSON(), whiteSpace: style.whiteSpace,
      range: [...range.getClientRects()].map(rect => rect.toJSON()),
      ink: { width: ink.width, ascent: ink.actualBoundingBoxAscent, descent: ink.actualBoundingBoxDescent,
        fontAscent: ink.fontBoundingBoxAscent, fontDescent: ink.fontBoundingBoxDescent },
    };
  }));
  assert.ok(cases.every(item => item.whiteSpace === 'pre'));
  const audit = await scan('counter-initial');
  await mkdir(output, { recursive: true });
  const label = `preformatted-counter-${baseline ? 'baseline-' : ''}${browser.name.toLowerCase().replace(/[^a-z0-9.]+/g, '-')}`;
  await writeFile(path.join(output, `${label}.png`), await browser.screenshot());
  const observations = [];
  const mismatches = [];
  for (const item of cases) {
    const snapshot = await inspect(item.id);
    observations.push({ id: item.id, expected: item.expected, runs: snapshot.textRuns.length, reasons: snapshot.textRuns.flatMap(run => run.reasons), geometry: { rect: item.rect, clip: item.clip, range: item.range, ink: item.ink } });
    const expected = baseline || item.expected === 'visible' ? 1 : 0;
    if (snapshot.textRuns.length !== expected) mismatches.push({ id: item.id, actual: snapshot.textRuns.length, expected });
    for (const run of snapshot.textRuns) {
      const audited = audit.runs.find(candidate => candidate.elementRef === run.elementRef);
      assert.ok(audited, `${item.id}: visible and uncertain text stays in the audit`);
      assert.equal(audited.contrast.ratio, run.contrast.ratio, `${item.id}: audit and inspection agree`);
      if (item.id === 'margin-2') { assertPlainCounter(run, 'Inspected visible digit'); assertPlainCounter(audited, 'Audited visible digit'); }
    }
  }
  if (mismatches.length) await writeFile(path.join(output, `${label}-mismatches.json`), JSON.stringify({ browser: browser.name, mismatches, observations }, null, 2));
  assert.deepEqual(mismatches, [], 'Only text proven fully clipped is omitted');
  assert.equal(audit.runs.length, baseline ? cases.length : cases.filter(item => item.expected === 'visible').length);
  findings.push({ check: baseline ? 'Baseline reproduces hidden pre counter text entering the audit' : 'Hidden plain and italic pre digits are excluded through margin/translation/mask clips; visible, partial, offscreen, escaped and unsupported whitespace/effect cases stay in scope', observations });
  if (!baseline) {
    await browser.evaluate(() => { document.querySelector('#margin-case .track').style.marginTop = '-60px'; });
    const shifted = await scan('counter-shift');
    const hidden = await inspect('margin-2'), revealed = await inspect('margin-3');
    assert.equal(hidden.textRuns.length, 0, 'The previously visible digit becomes clipped');
    assert.equal(revealed.textRuns.length, 1, 'A formerly clipped digit is measured after changing the wheel');
    const revealedAudit = shifted.runs.find(run => run.elementRef === revealed.textRuns[0].elementRef);
    assert.ok(revealedAudit); assertPlainCounter(revealed.textRuns[0], 'Inspected revealed digit'); assertPlainCounter(revealedAudit, 'Audited revealed digit');
    findings.push({ check: 'Changing the counter offset updates visibility after rescan' });
    await browser.evaluate(() => { document.querySelector('#margin-case .track').style.marginTop = '-40px'; document.getElementById('cover').style.display = 'block'; });
    const coveredAudit = await scan('counter-cover');
    const covered = (await inspect('margin-2')).textRuns[0];
    assert.equal(covered.contrast.status, 'manual', 'A genuine opaque overlay stays unassessed');
    assert.equal(coveredAudit.runs.find(run => run.elementRef === covered.elementRef).contrast.status, 'manual');
    findings.push({ check: 'Actual overlays remain unassessed in audit and inspection' });
    await browser.evaluate(() => { document.getElementById('cover').remove(); for (const node of document.querySelectorAll('.clip')) node.style.overflow = 'visible'; });
    const expanded = await scan('counter-expanded');
    assert.equal(expanded.runs.length, cases.length, 'Removing clipping restores every measured text node');
    for (const item of cases.filter(item => item.expected === 'clipped')) assert.equal((await inspect(item.id)).textRuns.length, 1, item.id);
    findings.push({ check: 'Expansion restores hidden digits without changing conservative whitespace handling' });
  }
  assert.deepEqual(browser.errors, []); assert.deepEqual(await browser.evaluate(() => window.__pageErrors), []);
  const privacy = await browser.evaluate(() => JSON.stringify(window.__events.filter(event => event.audit).map(event => event.audit)));
  assert.ok(!privacy.includes('textExcerpt'), 'Audit measurements do not export text excerpts');
  await writeFile(path.join(output, `${label}.json`), JSON.stringify({ browser: browser.name, baseline, findings }, null, 2));
  console.log(`${browser.name}: ${findings.length} preformatted-counter checks passed${baseline ? ' (baseline)' : ''}`);
} finally { await browser?.close(); await host.close(); }
