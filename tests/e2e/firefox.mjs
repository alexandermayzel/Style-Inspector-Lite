import { Builder, By, until } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { readFile, readdir, mkdir, writeFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { serve, root } from './support.mjs';
import { artifactsRoot, buildDir, resolveExternal } from '../../internal/scripts/paths.mjs';

async function findDriver(dir) {
  for (const item of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) { const found = await findDriver(p); if (found) return found; }
    else if (/^geckodriver(?:\.exe)?$/.test(item.name)) return p;
  }
}
const extensionDirectory = await realpath(await resolveExternal(root, process.env.FIREFOX_EXTENSION_DIR ?? buildDir));
assert.ok((await stat(extensionDirectory)).isDirectory(), 'FIREFOX_EXTENSION_DIR must be a built extension directory');
const manifest = JSON.parse(await readFile(path.join(extensionDirectory, 'manifest.json'), 'utf8'));
const options = new firefox.Options().addArguments('-headless')
  .setPreference('browser.shell.checkDefaultBrowser', false)
  .setPreference('browser.startup.homepage_override.mstone', 'ignore')
  .setPreference('datareporting.policy.dataSubmissionEnabled', false)
  .setPreference('toolkit.telemetry.reportingpolicy.firstRun', false);
if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
const driverPath = process.env.GECKODRIVER ?? await findDriver(path.join(artifactsRoot, 'tools/selenium'));
const builder = new Builder().forBrowser('firefox').setFirefoxOptions(options);
builder.setFirefoxService(new firefox.ServiceBuilder(driverPath).addArguments('--allow-system-access'));
let driver, host;
const checks = [];
try {
  host = await serve();
  driver = await builder.build();
  await driver.manage().setTimeouts({ implicit: 0, script: 15000, pageLoad: 30000 });
  await driver.manage().window().setRect({ width: 1280, height: 1000 });
  const capabilities = await driver.getCapabilities();
  const version = capabilities.get('browserVersion');
  // Exercise the exact unpacked directory selected in about:debugging. Direct
  // installation also avoids Mozilla bug 2045054 in the driver's base64 route.
  await driver.setContext('chrome');
  const installed = await driver.executeAsyncScript(`const [file,done]=arguments;
    const {AddonManager}=ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
    const {FileUtils}=ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
    AddonManager.installTemporaryAddon(new FileUtils.File(file)).then(a=>done({id:a.id}),e=>done({error:String(e)}));`, extensionDirectory);
  if (installed.error) throw new Error(installed.error);
  assert.equal(installed.id, manifest.browser_specific_settings.gecko.id);
  await driver.setContext('content');
  await driver.get(`${host.url}/tests/fixtures/page.html`);
  await driver.setContext('chrome');
  const widgetId = manifest.browser_specific_settings.gecko.id.toLowerCase().replace(/[^a-z0-9_-]/g, '_') + '-browser-action';
  const actionId = widgetId.replace(/-browser-action$/, '-BAP');
  await driver.executeScript('CustomizableUI.addWidgetToArea(arguments[0], CustomizableUI.AREA_NAVBAR);', widgetId);
  await driver.wait(until.elementLocated(By.id(widgetId)), 15000);
  const icon = await driver.executeAsyncScript(`const [actionId,done]=arguments;
    const button=document.getElementById(actionId);
    const node=button.querySelector('.toolbarbutton-icon');
    const style=getComputedStyle(node),bounds=node.getBoundingClientRect();
    const urls=[...style.listStyleImage.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)].map(match=>match[1]);
    if (!urls.length) {done({error:'No toolbar icon URL',css:style.listStyleImage});return;}
    const img=new Image();img.onload=()=>done({url:img.src,width:img.naturalWidth,height:img.naturalHeight,visible:bounds.width>0&&bounds.height>0&&style.visibility==='visible'});
    img.onerror=()=>done({error:'Toolbar icon failed to load',url:img.src});img.src=urls[0];`, actionId);
  assert.ok(!icon.error, JSON.stringify(icon));
  assert.match(icon.url, /\/assets\/icon-(16|32)\.png$/);
  assert.ok(icon.visible && icon.width > 0 && icon.height > 0, JSON.stringify(icon));
  checks.push('Toolbar icon is visible and its actual image URL decodes successfully');
  await driver.findElement(By.id(actionId)).click();
  await driver.wait(async () => driver.executeScript('return !!document.getElementById("sidebar")?.contentDocument?.getElementById("webext-panels-browser")?.messageManager;'), 15000);
  // The sidebar lives in a separate extension process. Use a test-only privileged
  // frame message instead of assuming its document is available in browser chrome.
  let commandIndex = 0;
  const ui = async script => {
    const id = `sil-test-${++commandIndex}`;
    const frameCode = `(() => { try { const doc=content.document; const result=(() => { ${script} })(); Promise.resolve(result).then(result=>sendAsyncMessage(${JSON.stringify(id)}, {result}),error=>sendAsyncMessage(${JSON.stringify(id)}, {error:String(error)})); } catch(error) { sendAsyncMessage(${JSON.stringify(id)}, {error:String(error)}); } })();`;
    const reply = await driver.executeAsyncScript(`
      const [id, code, done] = arguments;
      const mm=document.getElementById('sidebar').contentDocument.getElementById('webext-panels-browser').messageManager;
      let timer; const listener=message=>{clearTimeout(timer);mm.removeMessageListener(id,listener);done(message.data);};
      mm.addMessageListener(id,listener);timer=setTimeout(()=>{mm.removeMessageListener(id,listener);done({error:'Sidebar frame timeout'});},5000);
      mm.loadFrameScript('data:application/javascript;charset=utf-8,'+encodeURIComponent(code),false);
    `, id, frameCode);
    if (reply.error) throw new Error(reply.error);
    return reply.result;
  };
  await driver.wait(async () => ui('return !!doc.querySelector("#tab-audit");'), 15000);
  const read = () => ui("return {tab:doc.querySelector('[aria-selected=true]')?.id, text:doc.body.innerText, pickerDisabled:doc.querySelector('.picker')?.disabled, picker:doc.querySelector('.picker')?.getAttribute('aria-pressed')};");
  const clickSidebar = async (selector, x = .5, y = .5) => {
    const point = await ui(`const node=doc.querySelector(${JSON.stringify(selector)}); if(!node) throw new Error('Missing sidebar target');
      node.scrollIntoView({block:'center'}); const rect=node.getBoundingClientRect(); return {x:rect.x+rect.width*${x},y:rect.y+rect.height*${y}};`);
    const position = await driver.executeScript(`const sidebar=document.getElementById('sidebar'),outer=sidebar.getBoundingClientRect();
      const inner=sidebar.contentDocument.getElementById('webext-panels-browser').getBoundingClientRect();
      return {x:Math.round(outer.x+inner.x+arguments[0].x),y:Math.round(outer.y+inner.y+arguments[0].y)};`, point);
    await driver.actions().move({origin:'viewport',x:position.x,y:position.y}).press().release().perform();
  };
  const waitAudit = () => driver.wait(async () => ui("return !!doc.querySelector('.metrics') && !!doc.querySelector('main .section-title button.primary');"),15000);
  // A rescan command travels through the background before clearing old cards.
  // Wait for the asserted result instead of accepting a still-visible old audit.
  const assertCounts = async (readCounts, expected, message) => {
    await driver.wait(async () => { const actual = await readCounts(); return Object.keys(expected).every(key => actual[key] === expected[key]); },15000,message);
    assert.deepEqual(await readCounts(), expected, message);
  };
  let initial = await read();
  assert.equal(initial.tab, 'tab-audit');
  await driver.wait(async () => !(await read()).pickerDisabled, 10000, 'Initial document activation');
  assert.equal((await read()).picker, 'false');
  assert.ok(!/Check again|Erneut prüfen/.test((await read()).text));
  checks.push('External unpacked build installation; trusted toolbar click opens audit and activates without picker/scan');
  await ui("doc.querySelector('#tab-colors').click();");
  await driver.findElement(By.id(actionId)).click();
  assert.equal((await read()).tab, 'tab-colors');
  checks.push('Repeated toolbar activation keeps the sidebar open and preserves its active tab');
  await ui("doc.querySelector('#tab-contrast').click();");
  assert.equal(await ui("return doc.querySelector('.manual-ratio')?.innerText;"), '21 : 1');
  assert.equal(await ui("return doc.querySelectorAll('.manual-category .badge.pass').length;"), 4);
  assert.equal(await ui("return doc.querySelector('.footer button:last-child').disabled;"), true);
  await ui("const input=doc.querySelector('#manual-foreground-hex'); input.value='#777777'; input.dispatchEvent(new content.Event('input',{bubbles:true}));");
  assert.equal(await ui("return doc.querySelectorAll('.manual-category[data-category=normal] .badge.fail').length;"), 2);
  assert.equal(await ui("return doc.querySelectorAll('.manual-category[data-category=large] .badge.pass').length;"), 1);
  await ui("const input=doc.querySelector('#manual-foreground-hex'); input.value='#12'; input.dispatchEvent(new content.Event('input',{bubbles:true}));");
  assert.equal(await ui("return !!doc.querySelector('.manual-ratio');"), false);
  assert.equal(await ui("return doc.querySelector('#manual-foreground-hex').getAttribute('aria-invalid');"), 'true');
  await ui("const input=doc.querySelector('#manual-foreground-hex'); input.value='#000000'; input.dispatchEvent(new content.Event('input',{bubbles:true}));");
  assert.equal(await ui("return doc.querySelector('#manual-foreground-hex').value;"), '#000000');
  assert.equal(await ui("return doc.querySelector('.manual-ratio')?.innerText;"), '21 : 1');
  await clickSidebar('#manual-foreground-picker');
  assert.equal(await ui("return doc.querySelector('#manual-foreground-hex').value;"), '#000000', 'Opening preserves black');
  await clickSidebar('#manual-foreground-sv', .75, .25);
  const picked = await ui("return {hex:doc.querySelector('#manual-foreground-hex').value,preview:doc.querySelector('.manual-preview').style.color,ratio:doc.querySelector('.manual-ratio')?.innerText,open:doc.querySelector('#manual-foreground-picker').getAttribute('aria-expanded')};");
  assert.match(picked.hex, /^#[A-F\d]{6}$/); assert.notEqual(picked.hex, '#000000');
  const channels = picked.hex.slice(1).match(/../g).map(value => parseInt(value,16));
  assert.ok(Math.max(...channels) > 100 && Math.max(...channels) > Math.min(...channels), 'Clicking the SV field selects a visible saturated color from black');
  assert.equal(picked.preview, `rgb(${channels.join(', ')})`);
  assert.ok(picked.ratio && picked.ratio !== '21 : 1'); assert.equal(picked.open, 'true');
  await ui("const input=doc.querySelector('#manual-foreground-hex'); input.value='#000000'; input.dispatchEvent(new content.Event('input',{bubbles:true}));");
  await clickSidebar('#manual-foreground-picker-panel .manual-hue-spectrum', 1/3, .5);
  const huePick = await ui("return {hex:doc.querySelector('#manual-foreground-hex').value,h:doc.querySelector('#manual-foreground-hue').value,s:doc.querySelector('#manual-foreground-saturation').value,v:doc.querySelector('#manual-foreground-value').value};");
  assert.equal(huePick.s, '100'); assert.equal(huePick.v, '100'); assert.ok(Math.abs(Number(huePick.h)-120)<3);
  assert.ok(parseInt(huePick.hex.slice(3,5),16)>250 && parseInt(huePick.hex.slice(1,3),16)<10, 'Clicking the green hue stripe directly leaves black');
  await clickSidebar('#manual-background-picker');
  assert.equal(await ui("return doc.querySelector('#manual-background-hex').value;"), '#FFFFFF', 'Opening preserves white');
  assert.equal(await ui("return doc.querySelector('#manual-foreground-picker-panel').hidden;"), true, 'Only one palette opens at a time');
  await ui("doc.querySelector('#manual-background-hue').focus(); doc.querySelector('#manual-background-hue').dispatchEvent(new content.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));");
  assert.equal(await ui("return doc.querySelector('#manual-background-picker-panel').hidden;"), true);
  assert.equal(await ui("return doc.activeElement.id;"), 'manual-background-picker');
  assert.equal((await read()).picker, 'false');
  checks.push('Manual contrast without selection: real inline palette clicks leave black, opening preserves black/white, HEX/preview sync, one open palette and Escape focus, exact normal/large AA/AAA, invalid input clears results, and no page scan or export');
  await ui("doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')), 10000);
  await driver.findElement(By.id('sample')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).text.includes('11'), 10000);
  assert.equal((await read()).picker, 'false');
  checks.push('Explicit native sidebar picker injects, selects real fixture styles, and ends');
  await ui("doc.querySelector('#tab-audit').click();");
  await driver.wait(async () => (await read()).tab === 'tab-audit', 5000);
  await ui("doc.querySelector('main .primary').click();");
  await waitAudit();
  checks.push('Explicit audit completes in the real installed extension');
  const readPageStyles = () => ui(`return {
    selected:!!doc.querySelector('.selected-card'),
    overview:doc.querySelector('.page-overview') ? {...doc.querySelector('.page-overview').dataset} : null,
    palette:[...doc.querySelectorAll('.page-palette .palette-item > span:not(.swatch)')].map(node=>node.textContent),
    fonts:[...doc.querySelectorAll('.font-chip')].map(node=>node.textContent),
    copyEnabled:!doc.querySelector('.footer button:first-child').disabled,
    exportEnabled:!doc.querySelector('.footer button:last-child').disabled
  };`);
  let initialPageFonts;
  for (const tab of ['colors', 'typography']) {
    await ui(`doc.querySelector('#tab-${tab}').click();`);
    const pageStyles = await readPageStyles();
    assert.equal(pageStyles.selected, false);
    assert.equal(pageStyles.overview.view, tab); assert.equal(pageStyles.overview.status, 'complete');
    assert.equal(pageStyles.copyEnabled, true); assert.equal(pageStyles.exportEnabled, true);
    if (tab === 'colors') assert.ok(pageStyles.palette.includes('#FFFFFF') && pageStyles.palette.length > 2);
    else {
      assert.ok(pageStyles.fonts.some(font => /Trebuchet MS/.test(font)));
      assert.ok(pageStyles.fonts.some(font => /system-ui/.test(font)));
      initialPageFonts = pageStyles.fonts;
    }
    await ui("doc.querySelector('.footer button:last-child').click();");
    const defaults = await ui(`const source=doc.querySelector('option[value="page-tokens"]').parentElement;
      const format=doc.querySelector('option[value="json"]').parentElement;
      const result={source:source.value,format:format.value,elementDisabled:doc.querySelector('option[value="element"]').disabled};
      format.value='json';format.dispatchEvent(new content.Event('change',{bubbles:true}));return result;`);
    assert.deepEqual(defaults, { source: 'page-tokens', format: 'css', elementDisabled: true });
    const pageExport = JSON.parse(await ui("return doc.querySelector('.code-preview').textContent;"));
    assert.equal(pageExport.kind, 'page-tokens'); assert.equal(pageExport.metadata.scanStatus, 'complete');
    assert.ok(pageExport.generatedTokens.some(token => token.group === 'colors'));
    assert.ok(pageExport.generatedTokens.some(token => token.group === 'typography'));
    if (tab === 'typography') {
      // Firefox's native control font uses an escaped CSS identifier. The UI
      // retains it, while the existing safe export grammar explicitly omits it.
      const escapedFamilies = initialPageFonts.filter(font => font.includes('\\'));
      assert.ok(escapedFamilies.every(font => /^MS Shell Dlg /.test(font)));
      assert.deepEqual(pageExport.generatedTokens.filter(token => token.group === 'typography').map(token => token.value).sort(), initialPageFonts.filter(font => !font.includes('\\')).sort());
      assert.equal(pageExport.warnings.filter(warning => warning.code === 'unsupported-font-family').length, escapedFamilies.length);
    }
    await ui("doc.querySelector('main .back').click();");
  }
  await ui("doc.querySelector('#tab-audit').click();");
  const showFirst = () => ui("const b=doc.querySelector('.finding .actions button'); if (!b || b.disabled) return false; b.click(); return true;");
  assert.equal(await showFirst(), true);
  await driver.sleep(1200);
  assert.equal(await showFirst(), true, 'Showing a finding remains available a second time');
  await driver.sleep(1200);
  assert.equal((await read()).pickerDisabled, false);
  const before = await ui("return doc.querySelector('.metrics')?.innerText;");
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('sample').style.color='#111'; document.getElementById('sample').style.fontSize='16px'; document.getElementById('sample').style.fontFamily='Courier New, monospace';");
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main > .notice.warning');"), 10000, 'Real page edits mark the prior scan stale');
  await ui("doc.querySelector('#tab-typography').click();");
  const stalePageFonts = await readPageStyles();
  assert.equal(stalePageFonts.overview.stale, 'true');
  assert.deepEqual(stalePageFonts.fonts, initialPageFonts, 'CSS edits do not silently rewrite a previous page-font snapshot');
  await ui("doc.querySelector('#tab-audit').click();");
  assert.equal(await showFirst(), true, 'A stale measurement does not disable locating its element');
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast', 10000, 'Inspecting a stale finding still selects its element');
  await ui("doc.querySelector('#tab-typography').click();");
  assert.equal((await readPageStyles()).selected, true);
  assert.equal(await ui("return !!doc.querySelector('.fields .field');"), true);
  await ui("doc.querySelector('.footer button:last-child').click();");
  assert.equal(await ui("return doc.querySelector('option[value=element]').parentElement.value;"), 'element', 'An inspected element retains export priority over the page overview');
  await ui("doc.querySelector('#tab-audit').click();"); await waitAudit();
  await ui("doc.querySelector('main .section-title button.primary').click();");
  await waitAudit();
  const rescanned = await ui("return {metrics:doc.querySelector('.metrics')?.innerText,stale:!!doc.querySelector('main > .notice.warning')};");
  assert.notEqual(rescanned.metrics, before, 'Rescan reflects fixed page contrast/font size');
  assert.equal(rescanned.stale, false);
  await ui("doc.querySelector('#tab-typography').click();");
  const refreshedPageFonts = await readPageStyles();
  assert.equal(refreshedPageFonts.selected, false); assert.equal(refreshedPageFonts.overview.stale, 'false');
  assert.ok(refreshedPageFonts.fonts.some(font => /Courier New/.test(font)));
  assert.ok(!refreshedPageFonts.fonts.some(font => /Trebuchet MS/.test(font)), 'A fresh audit replaces the page font list');
  await ui("doc.querySelector('#tab-contrast').click();");
  assert.equal(await ui("return !!doc.querySelector('.selected-card');"), false, 'Rescan clears prior element inspection');
  await ui("doc.querySelector('#tab-audit').click();");
  checks.push('Repeated show and stale inspect remain usable; editing the page and rescanning replaces results and clears prior selection');
  checks.push('Colors and Typography expose measured page palettes and complete CSS fallback stacks without selection; page-token export defaults and selected-element priority are preserved, stale font lists stay historical, and rescanning replaces them');
  await driver.setContext('content'); await driver.navigate().refresh();
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled, 10000);
  assert.equal((await read()).tab, 'tab-audit');
  await driver.findElement(By.id(actionId)).click();
  await driver.wait(async () => !(await read()).pickerDisabled, 10000);
  assert.equal((await read()).picker, 'false');
  for (const tab of ['colors', 'typography']) {
    await ui(`doc.querySelector('#tab-${tab}').click();`);
    const cleared = await readPageStyles();
    assert.equal(cleared.overview.status, 'empty');
    assert.deepEqual(cleared.fonts, []); assert.deepEqual(cleared.palette, []);
    assert.equal(cleared.copyEnabled, false); assert.equal(cleared.exportEnabled, false);
  }
  await ui("doc.querySelector('#tab-audit').click();");
  checks.push('Same-URL reload invalidates old document data and trusted toolbar click reactivates');
  await driver.executeScript('SidebarController.hide();');
  await driver.setContext('content'); await driver.navigate().refresh();
  await driver.actions().contextClick(await driver.findElement(By.id('sample'))).perform();
  await driver.setContext('chrome');
  const contextItem = By.css('#contentAreaContextMenu menuitem[label*="Style Inspector"]');
  await driver.wait(until.elementLocated(contextItem), 10000);
  await driver.findElement(contextItem).click();
  await driver.wait(async () => { try { return (await read()).text.includes('11') && (await read()).tab === 'tab-contrast'; } catch { return false; } }, 10000, 'Context target on a fresh document');
  checks.push('Native context menu on a new document with closed sidebar captures the clicked element without a picker');
  // Keep this exact sidebar document open while navigating to another origin.
  // Native input matters here: script .click() does not carry the activation
  // required by permissions.request(). Never pre-grant permissions in this test.
  await ui("doc.documentElement.dataset.testInstance='kept-open';");
  const scanClick = async () => {
    const point=await ui(`const b=doc.querySelector('main button.primary');
      if(!b || b.disabled) throw new Error('Scan action unavailable');
      b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};`);
    const position=await driver.executeScript(`const side=document.getElementById('sidebar'),outer=side.getBoundingClientRect();
      const inner=side.contentDocument.getElementById('webext-panels-browser').getBoundingClientRect();
      return {x:Math.round(outer.x+inner.x+arguments[0].x),y:Math.round(outer.y+inner.y+arguments[0].y)};`,point);
    await driver.actions().move({origin:'viewport',x:position.x,y:position.y}).press().release().perform();
  };
  const permissionPrompt = By.id('addon-webext-permissions-notification');
  const answerPermission = async allow => {
    await driver.wait(until.elementIsVisible(await driver.wait(until.elementLocated(permissionPrompt),10000)),10000);
    const notification=await driver.findElement(permissionPrompt);
    const control=await driver.executeScript('const host=arguments[0][arguments[1]];return host?.shadowRoot?.querySelector("button") ?? host;',notification,allow?'button':'secondaryButton');
    assert.ok(control,'Native permission prompt has a response control');
    await driver.wait(until.elementIsEnabled(control),10000);
    // Headless Firefox renders its doorhanger outside WebDriver's scrollable
    // viewport. Activate the real prompt control, not a permission-store bypass.
    await driver.executeScript('arguments[0].click();',control);
  };
  const assertKeptOpen = async () => assert.equal(await ui("return doc.documentElement.dataset.testInstance;"),'kept-open');
  await driver.setContext('content'); await driver.get(`${host.url.replace('127.0.0.1','localhost')}/tests/fixtures/page.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await assertKeptOpen();
  assert.equal(await ui("return !!doc.querySelector('.metrics');"),false,'Navigation alone never starts a scan');
  await scanClick(); await answerPermission(false);
  await driver.wait(async () => ui("return !doc.querySelector('main button.primary')?.disabled;"),10000);
  assert.equal(await ui("return !!doc.querySelector('.metrics');"),false,'Permission denial starts no audit');
  await scanClick(); await answerPermission(true); await waitAudit(); await assertKeptOpen();
  checks.push('New-origin sidebar scan requests real optional website permission; denial is retryable and grant starts the audit without closing the sidebar');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/page.html?second-site`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  assert.match(await ui("return doc.querySelector('main button.primary').textContent;"), /Check again|Erneut prüfen/);
  await scanClick(); await waitAudit(); await assertKeptOpen();
  assert.equal(await driver.executeScript("return !!document.getElementById('addon-webext-permissions-notification')?.matches(':not([hidden])') && document.getElementById('notification-popup')?.state==='open';"),false);
  checks.push('Granted website access permits a later navigation scan in the same open sidebar without another prompt');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/text-visibility.html`);
  assert.equal(await driver.executeScript('return getComputedStyle(document.getElementById("modern")).clipPath;'), 'inset(50%)');
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const visibilityCounts = () => ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent)
  };`);
  assert.deepEqual(await visibilityCounts(), { scanned: 7, failed: 0 }, 'Clipped labels are excluded while visible and offscreen text remain');
  await driver.setContext('content');
  await driver.executeScript('const label=document.getElementById("modern");label.className="";label.style.color="#0A0A0A";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.deepEqual(await visibilityCounts(), { scanned: 8, failed: 1 }, 'A revealed label is measured after rescanning');
  checks.push('Visually hidden labels are excluded; visible, partially clipped and offscreen text remain; revealing a label is reflected by rescan');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/placeholder-contrast.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const placeholderCounts = await ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    passed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.pass .metric-count-value').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent),
    manual:Number(doc.querySelector('[data-rule="contrast"] .metric-count.manual .metric-count-value').textContent)
  };`);
  assert.deepEqual(placeholderCounts, { scanned: 10, passed: 5, failed: 0, manual: 4 }, 'Firefox measures shown placeholder styles and supported gradient bounds while keeping real uncertainty');
  assert.equal(await ui("return /[—-]\\s*:\\s*1/.test(doc.querySelector('main').textContent);"), false, 'Unavailable contrast has no fake ratio');
  checks.push('Shown placeholders and ordinary button text are assessed; transparent decoration is ignored, real uncertainty remains and unavailable ratios have no unit');
  await driver.setContext('content');
  const nativePlaceholder = await driver.executeScript(() => {
    const input = document.getElementById('native');
    Object.assign(input.style, { color: '#111', backgroundColor: '#FFF', fontSize: '15px' });
    const style = getComputedStyle(input, '::placeholder');
    return { color: style.color, opacity: Number(style.opacity) };
  });
  // Firefox can expose the native placeholder as color(srgb ...) with fractional
  // channels. Derive the expected measurement from its actual resolved style.
  const components = nativePlaceholder.color.match(/[+-]?(?:\d*\.)?\d+(?:e[+-]?\d+)?/gi).map(Number);
  const channel = components[0] * (nativePlaceholder.color.startsWith('color(srgb ') ? 255 : 1);
  const alpha = (components[3] ?? 1) * nativePlaceholder.opacity;
  assert.ok(Math.abs(channel - 17) < 0.001 && alpha === 0.54, JSON.stringify(nativePlaceholder));
  const visibleGray = (channel * alpha + 255 * (1 - alpha)) / 255;
  const linearGray = visibleGray <= 0.04045 ? visibleGray / 12.92 : ((visibleGray + 0.055) / 1.055) ** 2.4;
  const expectedRatio = 1.05 / (linearGray + 0.05);
  const exactRgb = `rgb(${[channel, channel, channel].map(value => Number(value.toPrecision(15))).join(' ')} / ${alpha})`;
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('native')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('.selected-card') && doc.querySelector('.picker').getAttribute('aria-pressed') === 'false';"),10000);
  const displayedPlaceholder = await ui(`const foreground=doc.querySelector('.color-detail');
    return {
      label:foreground.querySelector('code').textContent,
      hint:foreground.querySelector('code').title,
      swatch:content.getComputedStyle(foreground.querySelector('.swatch > span')).backgroundColor,
      ratio:doc.querySelector('.ratio').title,
      aaFailed:!!doc.querySelector('[data-level="AA"] .badge.fail')
    };`);
  assert.equal(displayedPlaceholder.label, '#1111118A', 'Fractional native placeholder colors respect the HEX preference');
  assert.ok(displayedPlaceholder.hint.includes(exactRgb), 'The rounded HEX tooltip retains the precise measured color');
  assert.match(displayedPlaceholder.swatch, /(?:,\s*|\/\s*)0\.54\)/, 'The swatch keeps the measured alpha rather than the rounded HEX alpha');
  assert.ok(Math.abs(Number.parseFloat(displayedPlaceholder.ratio.replace(',', '.')) - expectedRatio) < 1e-7, 'The contrast ratio keeps the native measurement precision');
  assert.equal(displayedPlaceholder.aaFailed, true);
  checks.push('Native fractional placeholder colors display uppercase HEX with exact-value hints while swatches, contrast precision and AA results retain the original alpha');
  await ui("doc.querySelector('#tab-audit').click();");
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/text-overlap.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const overlapCounts = () => ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    passed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.pass .metric-count-value').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent),
    manual:Number(doc.querySelector('[data-rule="contrast"] .metric-count.manual .metric-count-value').textContent)
  };`);
  assert.deepEqual(await overlapCounts(), { scanned: 12, passed: 4, failed: 0, manual: 8 }, 'Transparent logo padding and stretched boxes are harmless; real paint and unbounded geometry remain uncertain');
  await driver.setContext('content');
  await driver.executeScript(() => {
    const shadow = document.getElementById('logo-wrap').attachShadow({ mode: 'closed' });
    const paint = document.createElement('div'); paint.style.cssText = 'position:absolute;inset:0;background:#FFFFFF'; shadow.append(paint);
  });
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.deepEqual(await overlapCounts(), { scanned: 12, passed: 3, failed: 0, manual: 9 }, 'Firefox content scripts detect closed shadow hosts and keep their unknown paint unassessed');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("logo-wrap").remove(); document.getElementById("solid-overlay").remove();');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.deepEqual(await overlapCounts(), { scanned: 12, passed: 5, failed: 0, manual: 7 }, 'Removing real overlapping paint is reflected in the next audit');
  checks.push('Country labels beside transparent logo padding are assessed; real overlays, closed shadow hosts, later text fragments and geometry limits remain uncertain; rescan reflects removed paint');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/gradient-contrast.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const gradientCounts = () => ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    passed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.pass .metric-count-value').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent),
    manual:Number(doc.querySelector('[data-rule="contrast"] .metric-count.manual .metric-count-value').textContent)
  };`);
  assert.deepEqual(await gradientCounts(), { scanned: 12, passed: 5, failed: 0, manual: 7 }, 'Safe gradient bounds pass while uncertain colors, paint and effects remain unassessed');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("dynamic-background").style.backgroundImage="linear-gradient(to right, #000, #FFF)";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(gradientCounts, { scanned: 12, passed: 4, failed: 0, manual: 8 }, 'A changed gradient whose bound crosses the text color becomes uncertain on rescan, not a false contrast failure');
  checks.push('Supported light and nested translucent gradients meet AA/AAA through conservative minimum ratios; unsupported compositions stay unassessed and rescan refreshes changed bounds without false failures');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/pseudo-decoration.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const decorationCounts = () => ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    passed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.pass .metric-count-value').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent),
    manual:Number(doc.querySelector('[data-rule="contrast"] .metric-count.manual .metric-count-value').textContent),
    small:Number(doc.querySelector('[data-rule="font-size"] .metric-count.fail .metric-count-value').textContent)
  };`);
  await assertCounts(decorationCounts, { scanned: 18, passed: 6, failed: 0, manual: 12, small: 18 }, 'Separated keyboard hints and separators are assessed while uncertain pseudo paint and separately layered backgrounds stay manual');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("layered-hint").parentElement.style.transform="translateY(2000px)";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 18, passed: 6, failed: 0, manual: 12, small: 18 }, 'Offscreen pointer-transparent hints retain uncertainty without guessing a sibling background');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("layered-hint").parentElement.style.transform="";');
  await driver.executeScript('document.getElementById("search").classList.add("overlap");');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 18, passed: 5, failed: 0, manual: 13, small: 18 }, 'Moving a generated key into the text makes contrast uncertain again without removing the small-text hints');
  checks.push('Trailing static keyboard hints, inline separators and single-child breadcrumbs retain contrast; uncertain gaps, shadows, glyphs and layouts stay unassessed; rescan catches moved decoration independently of small text');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/pseudo-flow.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 27, passed: 12, failed: 0, manual: 15, small: 0 }, 'Leading metadata bullets, inline separators, centered half-turn icons and multiple flex children retain their exact contrast');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("timestamp").classList.add("negative");');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 27, passed: 11, failed: 0, manual: 16, small: 0 }, 'A timestamp with a separator moved into its text becomes unassessed on rescan');
  checks.push('Leading Unicode metadata bullets and inline/multiple-child flex separators have AA/AAA measurements; clipping, overflow, reordered or moved paint stay unassessed and a changed timestamp is remeasured');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/offscreen-flow.html`);
  assert.equal(await driver.executeScript('return [...document.querySelectorAll(".label:not(#touch-label)")].every(node=>node.getBoundingClientRect().top>innerHeight);'), true, 'Offscreen flow cases remain below the viewport');
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 12, passed: 4, failed: 0, manual: 8, small: 0 }, 'Normal offscreen flow and nonpainting touch wrappers retain their opaque background while displaced or unpainted backgrounds and text emphasis stay uncertain');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("static-flow").classList.add("transformed");');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 12, passed: 3, failed: 0, manual: 9, small: 0 }, 'Moving an offscreen transparent label removes the unverified background on rescan');
  await driver.setContext('content');
  await driver.executeScript('document.querySelector(".touch-effect > div").style.opacity="1";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 12, passed: 2, failed: 0, manual: 10, small: 0 }, 'Actually painted touch-feedback overlays remain uncertain on rescan');
  checks.push('Offscreen pointer-transparent labels retain exact contrast in normal and zero-offset flow inside an opaque positioned surface; floating, moved, negative-margin, contents-only, overflowing backgrounds and text emphasis stay uncertain; rescan refreshes displacement');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/negative-background.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 16, passed: 4, failed: 0, manual: 12, small: 0 }, 'Opaque separate backgrounds behind pointer-transparent button labels are measured; overlapping and unsupported layers stay unassessed');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("create").parentElement.parentElement.querySelector(".backdrop").style.zIndex="3";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 16, passed: 3, failed: 0, manual: 13, small: 0 }, 'Moving the separate background in front of the text removes its contrast result on rescan');
  checks.push('Shared-context opaque negative-z backgrounds resolve translucent button contrast; unsupported coverage, contexts, gradients, masks and foreground overlays remain uncertain, including after changed stacking order');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/audit-freshness.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 2, passed: 1, failed: 0, manual: 1, small: 0 }, 'A real overlay prevents one initial navigation-link measurement');
  const readFreshnessAudit = () => ui(`return {
    stale:!!doc.querySelector('main > .notice.warning'),
    metrics:doc.querySelector('.metrics').innerText,
    rows:[...doc.querySelectorAll('.finding')].map(node=>node.innerText),
    scope:doc.querySelector('.scope-grid').parentElement.textContent
  };`);
  const originalFreshnessAudit = await readFreshnessAudit();
  assert.equal(originalFreshnessAudit.stale, false);
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-status=manual]');"),10000);
  await ui("doc.querySelector('#tab-audit').click();");
  assert.deepEqual(await readFreshnessAudit(), originalFreshnessAudit, 'Inspecting unchanged uncertain text keeps the native audit fresh');
  await driver.setContext('content');
  await driver.executeScript(`const sheet=document.getElementById('dynamic-rules').sheet;
    sheet.cssRules[0].style.display='none';sheet.cssRules[1].style.display='block';
    sheet.insertRule('#stable {color:#232F3E}',sheet.cssRules.length);`);
  await driver.setContext('chrome');
  assert.equal((await readFreshnessAudit()).stale, false, 'CSSOM-only changes do not pass through DOM mutation invalidation');
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-status=pass]');"),10000);
  assert.ok(await ui("return /13[.,]57/.test(doc.querySelector('main .ratio')?.textContent ?? '');"), 'Fresh inspection measures the now-visible white link on its dark background');
  await ui("doc.querySelector('#tab-audit').click();");
  await waitAudit();
  await assertCounts(decorationCounts, { scanned: 3, passed: 2, failed: 1, manual: 0, small: 0 }, 'Conflicting inspection refreshes the entire audit, including an unrelated new row and a separate contrast failure');
  assert.equal((await readFreshnessAudit()).stale, false);
  await ui("doc.querySelector('#tab-contrast').click();");
  assert.ok(await ui("return !!doc.querySelector('.selected-card') && /13[.,]57/.test(doc.querySelector('main .ratio')?.textContent ?? '') && doc.querySelector('.element-text-value')?.value==='Covered navigation link';"), 'The automatic audit preserves the confirmed selection and its excerpt');
  await driver.setContext('content');
  await driver.executeScript(`const sheet=document.getElementById('dynamic-rules').sheet;
    sheet.cssRules[0].style.display='block';sheet.cssRules[1].style.display='none';sheet.deleteRule(2);`);
  await driver.setContext('chrome'); await ui("doc.querySelector('#tab-audit').click();");
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-status=manual]');"),10000);
  await ui("doc.querySelector('#tab-audit').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 2, passed: 1, failed: 0, manual: 1, small: 0 }, 'A new real overlay also refreshes a previous pass back to uncertainty, without keeping the best result');
  await driver.setContext('content');
  await driver.executeScript(`const sheet=document.getElementById('dynamic-rules').sheet;
    sheet.cssRules[0].style.display='none';sheet.insertRule('#covered {color:#232F3E}',sheet.cssRules.length);`);
  await driver.setContext('chrome');
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-status=fail]');"),10000);
  await ui("doc.querySelector('#tab-audit').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 2, passed: 1, failed: 1, manual: 0, small: 0 }, 'A newly measurable failing contrast refreshes coherently just like a pass');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('dynamic-rules').sheet.deleteRule(2);");
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 2, passed: 2, failed: 0, manual: 0, small: 0 }, 'A manual rescan remains available after automatic reconciliation');
  assert.equal((await readFreshnessAudit()).stale, false);
  await ui("doc.querySelector('#tab-contrast').click();");
  assert.equal(await ui("return !!doc.querySelector('.selected-card');"), false, 'The explicit rescan still clears the previous selection');
  await ui("doc.querySelector('#tab-audit').click();");
  checks.push('Conflicting explicit inspection automatically refreshes the entire audit while preserving selection; newly visible unrelated text and separate failures update together, pass-to-uncertain and uncertain-to-fail transitions work, unchanged inspections stay fresh and manual rescans still clear selection');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/overflow-text.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  assert.equal((await decorationCounts()).scanned, 11, 'Fully clipped text is excluded, while partial, offscreen, escaping and unsupported text remains');
  await driver.setContext('content');
  await driver.executeScript('const nav=document.querySelector(".nav");nav.style.height="78px";nav.scrollTop=0;');
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.equal((await decorationCounts()).scanned, 12, 'Revealing a navigation row includes its text on rescan');
  await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('hidden-row')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  assert.ok(await ui("return /13[.,]57/.test(doc.querySelector('main .ratio')?.textContent ?? '') && !!doc.querySelector('[data-level=AAA] .badge.pass');"), 'The revealed navigation link receives its exact white-on-dark AA/AAA measurement');
  await ui("doc.querySelector('#tab-audit').click();");
  checks.push('Fully clipped overflow text is excluded; partial, offscreen, escaping and unsupported text stays included; revealing a navigation row adds it on rescan and its native inspection measures 13.57:1 with AA/AAA pass');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/transparent-controls.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  assert.equal((await decorationCounts()).scanned, 9, 'Transparent native labels do not count as additional text; visible glyph fills and effects remain');
  const nativeCSSSample = await ui(`const row=[...doc.querySelectorAll('.finding')].find(node=>node.querySelector('.tag')?.textContent==='<span>');
    return {source:row.querySelector('.contrast-value').dataset.source,ratio:row.querySelector('.audit-ratio').textContent,pageStatus:row.querySelector('.contrast-value').dataset.status,cssStatus:row.querySelector('.contrast-value').dataset.cssStatus,cssPass:row.querySelectorAll('.css-assessments .badge.pass').length,explanation:!!row.querySelector('.css-contrast-notice'),unverified:!!row.querySelector('.css-page-unverified')};`);
  assert.equal(nativeCSSSample.source, 'css-colors'); assert.match(nativeCSSSample.ratio, /9[.,]54/);
  assert.equal(nativeCSSSample.pageStatus, 'manual'); assert.equal(nativeCSSSample.cssStatus, 'pass');
  assert.equal(nativeCSSSample.cssPass, 2); assert.equal(nativeCSSSample.explanation, true); assert.equal(nativeCSSSample.unverified, true);
  await ui("[...doc.querySelectorAll('.finding')].find(node=>node.querySelector('.tag')?.textContent==='<span>').querySelector('.actions button:nth-child(2)').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-source=css-colors]');"),10000);
  assert.ok(await ui("return /9[.,]54/.test(doc.querySelector('main .ratio').textContent) && doc.querySelectorAll('.css-assessments .badge.pass').length===2 && !!doc.querySelector('.css-page-unverified') && doc.querySelector('.contrast-value').dataset.status==='manual';"));
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("hidden-button").style.color="#111111";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(async () => ({ scanned: (await decorationCounts()).scanned }), { scanned: 10 }, 'Revealed native glyphs are included by rescan');
  checks.push('Fully transparent native button labels are excluded while visible fills and effects remain; uncertain sibling labels display separate CSS-only AA/AAA thresholds with page rendering unverified and revealing glyphs updates the audit');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/clipped-preview.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 9, passed: 5, failed: 0, manual: 4, small: 0 }, 'Clipped preview text uses its visible background while true overlap and unsupported geometry remain uncertain');
  await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('ellipsis')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  const previewMeasurement = await ui("const preview=doc.querySelector('.color-preview'); const style=doc.defaultView.getComputedStyle(preview); return {ratio:doc.querySelector('main .ratio')?.textContent, color:style.color, background:style.backgroundColor, aaa:!!doc.querySelector('[data-level=AAA] .badge.pass')};");
  assert.match(previewMeasurement.ratio, /7[.,]05/); assert.equal(previewMeasurement.aaa, true);
  assert.equal(previewMeasurement.color, 'rgba(255, 255, 255, 0.6)');
  assert.equal(previewMeasurement.background, 'rgb(22, 23, 23)');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("ellipsis").style.overflow="visible";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 9, passed: 4, failed: 0, manual: 5, small: 0 }, 'Removing clipping exposes the adjacent pane and invalidates the previous background proof');
  checks.push('Clipped message previews retain precise white-alpha-on-dark 7.05:1 AA/AAA measurements and matching preview colors; audit and inspection agree, real overlays and unsupported geometry remain uncertain, and removing clipping changes the rescan result');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/split-text-preview.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  assert.equal((await decorationCounts()).scanned, 21, 'Hidden adjacent text nodes are excluded, including box-shadow containers, while uncertain marks, bidi, effects, shaping and long work remain');
  for (const selectedId of ['split-multilingual', 'split-box-shadow', 'split-ancestor-box-shadow']) {
    await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
    await driver.setContext('content');
    await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(selectedId)).click();
    await driver.setContext('chrome');
    await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
    const splitSelection = await ui("return {ratio:doc.querySelector('main .ratio')?.textContent, runs:doc.querySelector('main select')?.options.length, aaa:!!doc.querySelector('[data-level=AAA] .badge.pass')};");
    assert.match(splitSelection.ratio, /7[.,]05/, selectedId); assert.equal(splitSelection.runs, 2, selectedId); assert.equal(splitSelection.aaa, true, selectedId);
  }
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("split-latin").style.overflow="visible";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.equal((await decorationCounts()).scanned, 32, 'Revealed adjacent text nodes return on rescan');
  checks.push('Adjacent clipped text nodes with boundary whitespace, supported Latin/Cyrillic and long bounded text are omitted only when hidden, including boxes and ancestors with box shadows; two visible preview sections measure 7.05:1 with AAA, uncertain shaping and effects stay included, and removing clipping restores all twelve nodes');
  await driver.setContext('content');await driver.get(`${host.url}/tests/fixtures/text-rendering-preview.html`);
  const renderingGeometry=await driver.executeScript(`return [...document.querySelectorAll('.message')].map(node=>{
    const style=getComputedStyle(node);return {id:node.id,nodes:node.childNodes.length,width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,rendering:style.textRendering.toLowerCase(),feature:style.fontFeatureSettings};});`);
  for(const item of renderingGeometry){
    assert.equal(item.nodes,12);assert.ok(Math.abs(item.width-392.1)<.02);assert.equal(item.height,20);
    assert.equal(item.rendering,item.id==='kern-only'?'auto':'optimizelegibility');
    assert.equal(item.feature,item.id==='render-only'?'normal':'"kern"');
  }
  await driver.setContext('chrome');await driver.wait(async()=>(await read()).pickerDisabled,10000);
  await scanClick();await waitAudit();
  await assertCounts(decorationCounts,{scanned:8,passed:8,failed:0,manual:0,small:0},'Matched font rendering excludes ten hidden text nodes per preview and never scans its tooltip attribute');
  for(const selectedId of ['combined','render-only','kern-only','explicit-kern']){
    await ui("doc.querySelector('#tab-contrast').click();doc.querySelector('.picker').click();");
    await driver.setContext('content');await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(selectedId)).click();await driver.setContext('chrome');
    await driver.wait(async()=>ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
    const selection=await ui("return {ratio:doc.querySelector('main .ratio').textContent,runs:doc.querySelector('main select')?.options.length,aa:!!doc.querySelector('[data-level=AA] .badge.pass'),aaa:!!doc.querySelector('[data-level=AAA] .badge.pass'),colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent)};");
    assert.equal(selection.runs,2);assert.match(selection.ratio,/7[.,]05/);assert.equal(selection.aa,true);assert.equal(selection.aaa,true);assert.deepEqual(selection.colors,['#FFFFFF99','#161717']);
    await ui("const select=doc.querySelector('main select');select.selectedIndex=1;select.dispatchEvent(new content.Event('change',{bubbles:true}));");
    assert.match(await ui("return doc.querySelector('main .ratio').textContent;"),/7[.,]05/,'The partially visible second text node remains measurable');
  }
  const rescanRendering=async()=>{await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();");await waitAudit();};
  await driver.setContext('content');await driver.executeScript("document.querySelector('.cover').style.display='block';");await driver.setContext('chrome');await rescanRendering();
  await assertCounts(decorationCounts,{scanned:8,passed:6,failed:0,manual:2,small:0},'Matching font settings does not hide a real overlay on visible text');
  await driver.setContext('content');await driver.executeScript("document.querySelector('.cover').style.display='none';document.getElementById('combined').style.fontFeatureSettings='\"kern\", \"ss01\"';");await driver.setContext('chrome');await rescanRendering();
  assert.equal((await decorationCounts()).scanned,18,'Unknown feature lists retain all twelve candidates in the affected preview');
  await driver.setContext('content');await driver.executeScript("const node=document.getElementById('combined');node.style.fontFeatureSettings='\"kern\"';node.style.fontKerning='none';");await driver.setContext('chrome');await rescanRendering();
  assert.equal((await decorationCounts()).scanned,18,'Conflicting explicit kerning remains conservative');
  await driver.setContext('content');await driver.executeScript("const node=document.getElementById('combined');node.style.fontKerning='auto';node.style.whiteSpace='normal';node.closest('.row').style.height='auto';");await driver.setContext('chrome');await rescanRendering();
  await assertCounts(decorationCounts,{scanned:18,passed:18,failed:0,manual:0,small:0},'Revealing the full text restores every newly visible section and its actual contrast');
  checks.push('Clipped split previews with optimizeLegibility and explicit kern use matching native Canvas settings; audit and inspection retain two visible sections at 7.05:1 AA/AAA, ignore tooltip text, preserve real overlays and unknown typography, and include all twelve sections after expansion');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/pre-line-timestamp.html`);
  const timestampGeometry = await driver.executeScript(`const node=document.getElementById('second-time'),range=document.createRange();range.selectNodeContents(node);
    const rect=range.getBoundingClientRect(),chat=document.getElementById('chat').getBoundingClientRect();
    return {whiteSpace:getComputedStyle(node).whiteSpace,belowClip:rect.top>chat.bottom,insideViewport:rect.bottom<innerHeight,
      hit:document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2)?.id,
      reserve:getComputedStyle(document.querySelector('.reserve span')).visibility,
      float:getComputedStyle(node.closest('.metadata')).cssFloat};`);
  assert.equal(timestampGeometry.whiteSpace,'pre-line'); assert.equal(timestampGeometry.belowClip,true);
  assert.equal(timestampGeometry.insideViewport,true); assert.equal(timestampGeometry.hit,'composer');
  assert.equal(timestampGeometry.reserve,'hidden'); assert.equal(timestampGeometry.float,'right');
  await driver.setContext('chrome'); await driver.wait(async()=>(await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts,{scanned:2,passed:2,failed:0,manual:0,small:0},'A clipped single-line timestamp and its hidden space reservation are excluded; visible and ordinary offscreen timestamps remain');
  const rescanTimestamp=async()=>{
    await ui("doc.querySelector('#tab-audit').click();");
    await driver.wait(async()=>ui("return !!doc.querySelector('main .section-title button.primary') && !doc.querySelector('main .section-title button.primary').disabled;"),10000);
    await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  };
  await driver.setContext('content'); await driver.executeScript("document.getElementById('chat').scrollTop=180;");
  await driver.setContext('chrome'); await rescanTimestamp();
  await assertCounts(decorationCounts,{scanned:2,passed:2,failed:0,manual:0,small:0},'Scrolling exchanges the hidden and visible timestamps without creating a no-measurement finding');
  await ui("doc.querySelector('#tab-contrast').click();doc.querySelector('.picker').click();");
  await driver.setContext('content'); await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('second-time')).click(); await driver.setContext('chrome');
  await driver.wait(async()=>ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  const timestampSelection=await ui("return {ratio:doc.querySelector('main .ratio').textContent,aa:!!doc.querySelector('[data-level=AA] .badge.pass'),aaa:!!doc.querySelector('[data-level=AAA] .badge.fail'),text:doc.querySelector('.element-text-value')?.value,colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent)};");
  assert.match(timestampSelection.ratio,/4[.,]65/); assert.equal(timestampSelection.aa,true); assert.equal(timestampSelection.aaa,true);
  assert.equal(timestampSelection.text,'09:16'); assert.deepEqual(timestampSelection.colors,['#FFFFFF99','#144D37']);
  await driver.setContext('content'); await driver.executeScript("document.getElementById('cover').style.display='block';");
  await driver.setContext('chrome'); await rescanTimestamp();
  await assertCounts(decorationCounts,{scanned:2,passed:1,failed:0,manual:1,small:0},'A genuinely covered visible timestamp remains unassessed');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('cover').style.display='none';document.getElementById('chat').style.overflow='visible';document.getElementById('composer').style.display='none';");
  await driver.setContext('chrome'); await rescanTimestamp();
  await assertCounts(decorationCounts,{scanned:3,passed:3,failed:0,manual:0,small:0},'Removing the clip restores both message timestamps and retains ordinary offscreen text');
  checks.push('Single-line pre-line timestamps behind a nested scrollport are excluded with their hidden layout duplicates; scrolling restores 4.65:1 with AA pass and AAA fail in audit and inspection, ordinary offscreen text remains, real overlays stay unassessed and removing clipping restores all visible text');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/editable-placeholder.html`);
  const placeholderStack=await driver.executeScript(`const node=document.getElementById('hint'),range=document.createRange();range.selectNodeContents(node);
    const rect=range.getBoundingClientRect();return document.elementsFromPoint(rect.left+rect.width/2,rect.top+rect.height/2).map(node=>node.id||node.tagName);`);
  assert.ok(placeholderStack.indexOf('frame')>=0 && placeholderStack.indexOf('under')>placeholderStack.indexOf('frame'));
  await driver.setContext('chrome'); await driver.wait(async()=>(await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts,{scanned:1,passed:1,failed:0,manual:0,small:0},'The opaque composer background hides unrelated lower hit-test layers');
  const placeholderAudit=await ui("return {ratio:doc.querySelector('.finding .audit-ratio').textContent,aa:!!doc.querySelector('.finding [data-level=AA] .badge.pass'),aaa:!!doc.querySelector('.finding [data-level=AAA] .badge.fail')};");
  assert.match(placeholderAudit.ratio,/^6[.,]40?\s*:\s*1$/); assert.equal(placeholderAudit.aa,true); assert.equal(placeholderAudit.aaa,true);
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  await driver.wait(async()=>(await read()).tab==='tab-contrast' && await ui("return !!doc.querySelector('main .ratio') && !!doc.querySelector('main .contrast-value[data-status=pass]');"),10000);
  const placeholderSelected=await ui("return {ratio:doc.querySelector('main .ratio').textContent,text:doc.querySelector('.element-text-value')?.value,colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent)};");
  assert.match(placeholderSelected.ratio,/^6[.,]40?\s*:\s*1$/); assert.equal(placeholderSelected.text,'Enter a message.');
  assert.deepEqual(placeholderSelected.colors,['#FFFFFF99','#242626']);
  const rescanPlaceholder=async(script,manual,explanation)=>{
    await driver.setContext('content'); await driver.executeScript(script); await driver.setContext('chrome');
    await ui("doc.querySelector('#tab-audit').click();");
    await driver.wait(async()=>ui("return !!doc.querySelector('main .section-title button.primary') && !doc.querySelector('main .section-title button.primary').disabled;"),10000);
    await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
    await assertCounts(decorationCounts,{scanned:1,passed:1-manual,failed:0,manual,small:0},explanation);
    assert.equal(await ui("return doc.body.textContent.includes('PRIVATE_COMPOSER_SENTINEL');"),false);
  };
  await rescanPlaceholder("document.getElementById('editor').focus();document.getElementById('under').style.background='red';",0,'Focusing an empty editor and changing a hidden lower surface does not change its hint background');
  await rescanPlaceholder("const p=document.querySelector('#editor p');p.replaceChildren(document.createTextNode('PRIVATE_COMPOSER_SENTINEL'));const node=p.firstChild;for(const key of ['data','nodeValue','textContent'])Object.defineProperty(node,key,{get(){throw new Error('Editable text must remain unread');},configurable:true});",1,'Actual editable glyph geometry keeps the hint unassessed without reading or exporting private text');
  await rescanPlaceholder("document.querySelector('#editor p').replaceChildren(document.createElement('br'));document.getElementById('editor').style.background='white';",1,'An independently painted editor surface is not confused with the composer ancestor');
  await rescanPlaceholder("document.getElementById('editor').style.background='';document.getElementById('overlay').style.display='block';",1,'A real overlay above the opaque surface remains unassessed');
  await rescanPlaceholder("document.getElementById('overlay').style.display='none';document.getElementById('frame').style.opacity='.5';",1,'A translucent ancestor does not hide lower paint');
  await rescanPlaceholder("document.getElementById('frame').style.opacity='1';document.getElementById('hint').style.left='-30px';",1,'A hint extending outside the opaque padding box cannot use the ancestor as a complete barrier');
  await rescanPlaceholder("document.getElementById('hint').style.left='';",0,'Restoring complete opaque coverage restores the same contrast');
  assert.match(await ui("return doc.querySelector('.finding .audit-ratio').textContent;"),/^6[.,]40?\s*:\s*1$/);
  checks.push('Pointer-transparent hints over empty editable DIV/P/BR content retain a covering opaque ancestor despite lower unrelated paint; audit and inspection agree, editor values remain unread, while typed glyphs, painted editors, real overlays, translucency and incomplete coverage stay unassessed');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/uniform-gradient-surface.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 9, passed: 2, failed: 0, manual: 7, small: 9 }, 'Uniform white surfaces hide the lower border colors; unsupported coverage and paint stay uncertain');
  const surfaceCSS = await ui(`const row=doc.querySelector('.finding');
    return {source:row.querySelector('.contrast-value').dataset.source,ratio:row.querySelector('.audit-ratio').textContent,pageStatus:row.querySelector('.contrast-value').dataset.status,cssPass:row.querySelectorAll('.css-assessments .badge.pass').length,unverified:!!row.querySelector('.css-page-unverified')};`);
  assert.equal(surfaceCSS.source, 'css-colors'); assert.match(surfaceCSS.ratio, /7[.,]07/);
  assert.equal(surfaceCSS.pageStatus, 'manual'); assert.equal(surfaceCSS.cssPass, 2); assert.equal(surfaceCSS.unverified, true);
  await ui("doc.querySelector('.finding .actions button:nth-child(2)').click();");
  // The 10px readability finding opens Typography first; then inspect Contrast.
  await driver.wait(async () => ui("return !!doc.querySelector('.selected-card');"),10000);
  await ui("doc.querySelector('#tab-contrast').click();");
  await driver.wait(async () => (await read()).tab === 'tab-contrast' && await ui("return !!doc.querySelector('main .contrast-value[data-source=css-colors]');"),10000);
  const surfaceSelection = await ui("return {ratio:doc.querySelector('main .ratio').textContent, colors:[...doc.querySelectorAll('.color-detail code')].map(n=>n.textContent), aaa:doc.querySelectorAll('.css-assessments .badge.pass').length, unverified:!!doc.querySelector('.css-page-unverified')};");
  assert.match(surfaceSelection.ratio, /7[.,]07/); assert.deepEqual(surfaceSelection.colors, ['#565959', '#FFFFFF']);
  assert.equal(surfaceSelection.aaa, 2); assert.equal(surfaceSelection.unverified, true);
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("dynamic").closest(".inner").style.backgroundImage="linear-gradient(#FFF,#000),linear-gradient(#888C8C,#888C8C)";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 9, passed: 1, failed: 0, manual: 8, small: 9 }, 'Changing a uniform surface to a real gradient invalidates the solid-background result');
  checks.push('Uniform opaque background images resolve white text surfaces over colored button borders; native overlays and strike paint retain explicit CSS-only 7.07:1 AA/AAA with white preview, unsupported coverage stays uncertain, and rescan handles actual gradients');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/indented-icon-labels.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 5, passed: 0, failed: 0, manual: 5, small: 0 }, 'Clipped positive and negative pixel-indented labels are excluded; partial, unclipped, offscreen, shadowed and percentage-indent text stays included');
  const indentLanguage = await ui('return doc.documentElement.lang;');
  assert.ok(['en', 'de'].includes(indentLanguage));
  const indentCatalog = JSON.parse(await readFile(path.join(extensionDirectory, '_locales', indentLanguage, 'messages.json'), 'utf8'));
  const noIconText = indentCatalog.noText.message;
  assert.match(noIconText, indentLanguage === 'de' ? /Symbole und Bildinhalte/ : /Icons and image content/);
  await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('reported')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui(`return !!doc.querySelector('.selected-card') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false' && doc.querySelector('main').textContent.includes(${JSON.stringify(noIconText)});`),10000);
  assert.equal(await ui("return !!doc.querySelector('main .ratio, main .manual-ratio, main .contrast-value, main [data-level]');"), false, 'An image icon with no visible text gets no invented text ratio or AA/AAA verdict');
  await ui("doc.querySelector('#tab-colors').click();");
  assert.equal(await ui("const row=[...doc.querySelectorAll('.color-row')].find(node=>node.querySelector('.color-name')?.textContent==='color');return row?.querySelector('code')?.textContent;"), '#0099FF', 'Raw selected-element styles remain available even without assessable text');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("reported").style.textIndent="0px";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 6, passed: 0, failed: 0, manual: 6, small: 0 }, 'Revealing an indented label adds its visible text to the completed rescan');
  assert.equal(await ui(`return doc.querySelector('main').textContent.includes(${JSON.stringify(indentCatalog.statusStale.message)});`), false, 'The fresh rescan has no stale-result notice');
  checks.push('Image-replacement labels hidden by finite pixel indentation are excluded from text contrast; selecting the icon explains the text-only scope without a ratio or AA/AAA while retaining raw CSS, and revealing the label updates a fresh audit');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/comparison-colors.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  const comparisonCounts = await decorationCounts();
  assert.equal(comparisonCounts.scanned, 12, 'Comparison rows include visible button, badge and control-hint text');
  for (const selectedId of ['gradient', 'oklch']) {
    await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
    await driver.setContext('content');
    await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(selectedId)).click();
    await driver.setContext('chrome');
    await driver.wait(async () => ui("return !!doc.querySelector('.selected-card') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
    await ui("doc.querySelector('#tab-contrast').click();");
    await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]');"),10000);
    const colors = await ui("return {ratio:doc.querySelector('main .ratio').textContent, aa:!!doc.querySelector('[data-level=AA] .badge.pass'), aaa:!!doc.querySelector('[data-level=AAA] .badge.pass'), colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent), preview:!!doc.querySelector('.color-preview')};");
    assert.equal(colors.aa, true); assert.equal(colors.aaa, true);
    const ratio = Number(colors.ratio.match(/\d+[.,]\d+/)?.[0].replace(',', '.'));
    assert.ok(ratio >= 7 && ratio < 21, `${selectedId}: ${colors.ratio}`);
    if (selectedId === 'gradient') {
      assert.match(colors.ratio, /≥/); assert.deepEqual(colors.colors, ['#030303']);
      assert.equal(colors.preview, false, 'A varying background is described as a range, not shown as one invented solid swatch');
    } else {
      assert.doesNotMatch(colors.ratio, /≥/); assert.deepEqual(colors.colors, ['#322400', '#FFFFCC']);
      assert.equal(colors.preview, true);
    }
  }
  await ui("doc.querySelector('#tab-audit').click();");
  const controlHint = await ui("const row=[...doc.querySelectorAll('.finding')].find(node=>node.querySelector('.tag')?.textContent==='<div>' && /7[.,]06/.test(node.querySelector('.audit-ratio')?.textContent??'')); if(!row)return null; const result={source:row.querySelector('.contrast-value').dataset.source,status:row.querySelector('.contrast-value').dataset.status,cssPass:row.querySelectorAll('.css-assessments .badge.pass').length,unverified:!!row.querySelector('.css-page-unverified')};row.querySelector('.actions button:nth-child(2)').click();return result;");
  assert.deepEqual(controlHint, { source: 'css-colors', status: 'manual', cssPass: 2, unverified: true });
  await driver.wait(async () => ui("return !!doc.querySelector('.selected-card');"),10000);
  await ui("doc.querySelector('#tab-contrast').click();");
  await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-source=css-colors]');"),10000);
  assert.deepEqual(await ui("return [...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent);"), ['#BFBFBF', '#29323D']);
  assert.equal(await ui("return doc.body.textContent.includes('PRIVATE_COMPARISON_INPUT_SENTINEL');"), false, 'Control text values never appear in inspector output');
  await driver.setContext('content');
  await driver.executeScript('document.getElementById("gradient").style.backgroundSize="50% 100%";document.getElementById("gradient").style.backgroundRepeat="no-repeat";');
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { ...comparisonCounts, passed: comparisonCounts.passed - 1, manual: comparisonCounts.manual + 1 }, 'A shrinking image no longer hides the dark ancestor and loses its proven gradient pass');
  checks.push('Covered yellow gradients provide conservative AA/AAA minimum contrast without dark hidden ancestors; OKLCH badges render their Firefox-compatible HEX colors, native control hints retain separate CSS-only evaluation, and reduced image coverage becomes uncertain on rescan');
  await driver.setContext('content');
  const offscreenHint = await driver.executeScript(`const hint=document.getElementById('control-hint');
    for(const child of document.body.children)if(!child.contains(hint))child.style.display='none';
    hint.parentElement.style.transform='translateY(2000px)';window.scrollTo(0,0);
    return hint.getBoundingClientRect().top>innerHeight;`);
  assert.equal(offscreenHint, true);
  await driver.setContext('chrome');
  const rescanHint = async () => {
    await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
    await assertCounts(decorationCounts, { scanned: 2, passed: 0, failed: 0, manual: 2, small: 1 }, 'An offscreen CSS pair never becomes a verified page contrast');
  };
  await rescanHint();
  const hintAuditPair = () => ui(`const row=[...doc.querySelectorAll('.finding')].find(node=>node.querySelector('.tag')?.textContent==='<div>');
    return row?{ratio:row.querySelector('.audit-ratio').textContent,source:row.querySelector('.contrast-value').dataset.source,status:row.querySelector('.contrast-value').dataset.status,passes:row.querySelectorAll('.css-assessments .badge.pass').length}:null;`);
  const offscreenPair = await hintAuditPair();
  assert.equal(offscreenPair.source, 'css-colors'); assert.equal(offscreenPair.status, 'manual');
  assert.equal(offscreenPair.passes, 2); assert.match(offscreenPair.ratio, /7[.,]06/);
  await ui("doc.querySelector('[data-filter=manual]').click();");
  assert.equal(await ui("return doc.querySelectorAll('.finding').length;"), 0, 'Available CSS pairs are excluded from No measurement');
  await ui("doc.querySelector('[data-filter=css]').click();");
  assert.deepEqual(await hintAuditPair(), offscreenPair);
  await ui("const row=[...doc.querySelectorAll('.finding')].find(node=>node.querySelector('.tag')?.textContent==='<div>');row.querySelector('.actions button:nth-child(2)').click();");
  await driver.wait(async () => ui("return !!doc.querySelector('.selected-card');"),10000);
  await ui("doc.querySelector('#tab-contrast').click();");
  await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-source=css-colors]');"),10000);
  assert.match(await ui("return doc.querySelector('main .ratio').textContent;"), /7[.,]06/);
  assert.equal(await ui("return doc.body.textContent.includes('PRIVATE_COMPARISON_INPUT_SENTINEL');"), false);
  await driver.setContext('content');
  await driver.executeScript("const other=document.createElement('input');other.type='hidden';other.id='ambiguous-control';document.getElementById('control-hint').parentElement.append(other);");
  await driver.setContext('chrome'); await rescanHint();
  await ui("doc.querySelector('[data-filter=manual]').click();");
  assert.equal(await ui("return doc.querySelectorAll('.finding').length;"), 1, 'Ambiguous sibling controls cannot be assigned by DOM order');
  assert.notEqual((await hintAuditPair()).source, 'css-colors');
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('ambiguous-control').remove();document.getElementById('control-hint').parentElement.style.transform='';");
  await driver.setContext('chrome'); await rescanHint();
  await ui("doc.querySelector('[data-filter=all]').click();");
  assert.deepEqual(await hintAuditPair(), offscreenPair, 'Onscreen and offscreen audit values match');
  checks.push('Offscreen floating hints retain a bounded unverified sibling-input CSS pair in both audit and inspection; No measurement and CSS-pair filters agree, ambiguous inputs remain unresolved and private control values stay unread');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/clamped-return-link.html`);
  const clampedGeometry = await driver.executeScript("const node=document.getElementById('reported'),range=document.createRange();range.selectNodeContents(node.firstChild);return {width:node.getBoundingClientRect().width,height:node.getBoundingClientRect().height,fragments:range.getClientRects().length,display:getComputedStyle(node).display};");
  assert.deepEqual(clampedGeometry, { width: 102, height: 48, fragments: 6, display: 'flow-root' });
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 7, passed: 6, failed: 0, manual: 1, small: 0 }, 'Only wholly clipped lines are omitted from overlap sampling; split, partly visible and offscreen text remain');
  for (const selectedId of ['height-clipped', 'reported']) {
    await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
    await driver.setContext('content');
    await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(selectedId)).click();
    await driver.setContext('chrome');
    await driver.wait(async () => ui("return !!doc.querySelector('.selected-card') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
    await ui("doc.querySelector('#tab-contrast').click();");
    await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]');"),10000);
    const clampedSelection = await ui("return {ratio:doc.querySelector('main .ratio').textContent,colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent),aa:!!doc.querySelector('[data-level=AA] .badge.pass'),aaa:!!doc.querySelector('[data-level=AAA] .badge.pass')};");
    assert.equal(clampedSelection.aa, true);
    assert.equal(clampedSelection.aaa, selectedId === 'reported');
    assert.match(clampedSelection.ratio, selectedId === 'reported' ? /13[.,]01/ : /6[.,]31/);
    assert.deepEqual(clampedSelection.colors, [selectedId === 'reported' ? '#0C3353' : '#2162A1', '#FFFFFF']);
  }
  await driver.setContext('content');
  await driver.actions().move({ origin: 'viewport', x: 8, y: 500 }).perform();
  await driver.executeScript("document.getElementById('popup').style.display='block';document.getElementById('partial-cover').style.display='block';");
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 7, passed: 4, failed: 0, manual: 3, small: 0 }, 'Real overlays still obscure full and partly clipped visible lines');
  await driver.setContext('content');
  await driver.executeScript("document.querySelectorAll('.popup').forEach(node=>node.style.display='none');Object.assign(document.getElementById('reported').style,{display:'flow-root',webkitLineClamp:'unset',height:'48px',overflow:'visible'});");
  await driver.setContext('chrome');
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 7, passed: 5, failed: 0, manual: 2, small: 0 }, 'Removing clipping restores overlap checks on the revealed lines');
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('reported').style.height='auto';");
  await driver.setContext('chrome');
  await ui("doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 7, passed: 6, failed: 0, manual: 1, small: 0 }, 'Expanding the box restores a measured white background for every revealed line');
  assert.equal(await ui("return doc.body.textContent.includes('Returns can be requested');"), false);
  checks.push('Clamped six-line return text measures only its three visible lines at 6.31:1 AA pass/AAA fail on white; genuine hover measures 13.01:1, split/partial/offscreen text stays included, overlays remain uncertain, and removing clipping or expanding the box updates a fresh audit without exposing page text');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/text-excerpts.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  assert.equal(await ui("return !!doc.querySelector('.element-text-card');"), false, 'An audit does not expose element excerpts');
  await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.actions().move({ origin: await driver.findElement(By.id('choice')) }).perform();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('.selected-card') && doc.querySelector('.picker').getAttribute('aria-pressed')==='true';"),10000);
  assert.equal(await ui("return !!doc.querySelector('.element-text-card');"), false, 'Hover preview does not capture or display text');
  await driver.setContext('content'); await driver.findElement(By.id('choice')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('.element-text-value') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  const excerptValue = () => ui("const node=doc.querySelector('.element-text-value'); return node ? {value:node.value,readonly:node.readOnly,scope:node.closest('.element-text-card').dataset.scope,copyEnabled:!doc.querySelector('.copy-element-text').disabled} : null;");
  assert.deepEqual(await excerptValue(), { value: 'First visible excerpt.', readonly: true, scope: 'run', copyEnabled: true });
  await ui("const select=doc.querySelector('main select'); select.value='1'; select.dispatchEvent(new content.Event('change',{bubbles:true}));");
  assert.equal((await excerptValue()).value, 'Second visible excerpt.', 'Each chosen text area shows its own excerpt');
  await ui("doc.querySelector('#tab-colors').click();");
  assert.deepEqual(await excerptValue(), { value: 'First visible excerpt. Second visible excerpt.', readonly: true, scope: 'element', copyEnabled: true });
  await ui("doc.querySelector('.footer button:last-child').click(); const select=doc.querySelector('option[value=json]').parentElement; select.value='json'; select.dispatchEvent(new content.Event('change',{bubbles:true}));");
  const excerptExport = await ui("return doc.querySelector('.code-preview').textContent;");
  assert.equal(JSON.parse(excerptExport).kind, 'element');
  assert.doesNotMatch(excerptExport, /textExcerpt|First visible excerpt|Second visible excerpt/);
  await ui("doc.querySelector('main .back').click();");
  const pickExcerpt = async id => {
    await ui("doc.querySelector('#tab-contrast').click(); doc.querySelector('.picker').click();");
    await driver.setContext('content');
    await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(id)).click();
    await driver.setContext('chrome');
    await driver.wait(async () => ui("return !!doc.querySelector('.element-text-card') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  };
  await pickExcerpt('long');
  const boundedExcerpt = await excerptValue();
  assert.ok(boundedExcerpt.value.length > 0 && boundedExcerpt.value.length <= 500);
  assert.equal(boundedExcerpt.value.isWellFormed(), true);
  await pickExcerpt('textarea');
  assert.equal(await excerptValue(), null, 'An explicitly selected form field still supplies no form contents');
  assert.equal(await ui("return !!doc.querySelector('.copy-element-text');"), false);
  await pickExcerpt('simple');
  assert.equal((await excerptValue()).value, 'Selected text <em> stays plain & safe.');
  assert.equal(await ui("return !!doc.querySelector('.element-text-card em');"), false, 'Markup-like page text is displayed literally');
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('simple').firstChild.data='Updated selection excerpt.';");
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main .notice.warning button');"),10000);
  await ui("doc.querySelector('main .notice.warning button').click();");
  await driver.wait(async () => ui("return doc.querySelector('.element-text-value')?.value==='Updated selection excerpt.';"),10000);
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('simple').textContent='Replacement selection excerpt.';");
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main .notice.warning button');"),10000);
  await ui("doc.querySelector('main .notice.warning button').click();");
  await driver.wait(async () => ui("return doc.querySelector('main select')?.value==='-1' && !doc.querySelector('main .contrast-value') && !doc.querySelector('.element-text-value');"),10000,'A replaced Text node requires explicit choice');
  await ui("const choice=doc.querySelector('main select');choice.value='0';choice.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));");
  await driver.wait(async () => ui("return doc.querySelector('.element-text-value')?.value==='Replacement selection excerpt.';"),10000);
  await ui("doc.querySelector('#tab-audit').click(); doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  assert.equal(await ui("return !!doc.querySelector('.element-text-card') || doc.body.textContent.includes('Updated selection excerpt.');"), false, 'Rescan discards the confirmed excerpt and keeps audit text-free');
  checks.push('Confirmed selections expose bounded read-only copyable text excerpts for the chosen run or complete element; hover and audit remain text-free, markup stays literal, forms are excluded, UTF-16 limits hold, JSON exports omit excerpts, refresh follows the same Text node, replacement requires explicit choice and rescan clears it');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/empty-overflow-menu.html`);
  const emptyClipGeometry = await driver.executeScript(`
    const quarter=document.getElementById('quarter-text').parentElement;
    const border=document.getElementById('border-only-text').parentElement;
    return {quarterHeight:quarter.getBoundingClientRect().height,quarterClientHeight:quarter.clientHeight,
      borderHeight:border.getBoundingClientRect().height,borderClientHeight:border.clientHeight,
      headingHeight:document.getElementById('closed-heading').getBoundingClientRect().height,
      inert:document.getElementById('closed-menu').inert};`);
  assert.equal(emptyClipGeometry.quarterHeight, .25);
  assert.equal(emptyClipGeometry.quarterClientHeight, 0, 'Rounded clientHeight cannot prove that a fractional clip has no paint');
  assert.equal(emptyClipGeometry.borderHeight, 6);
  assert.equal(emptyClipGeometry.borderClientHeight, 0, 'A positive border box does not give the clipped content a positive area');
  assert.ok(emptyClipGeometry.headingHeight > 0 && emptyClipGeometry.inert, 'Closed-menu descendants retain positive layout boxes');
  const isolateEmptyClipCase = async id => {
    await driver.setContext('content');
    await driver.executeScript(`const active=document.getElementById(arguments[0]).closest('.case');
      for(const node of document.querySelectorAll('.case'))node.style.display=node===active?'block':'none';`, id);
    await driver.setContext('chrome');
  };
  const emptyClipCounts = () => ui("return {scanned:Number(doc.querySelector('.scope-grid strong').textContent)};");
  const rescanEmptyClip = async (expected, explanation) => {
    await ui("doc.querySelector('#tab-audit').click();");
    // DOM mutations can briefly refresh the sidebar connection. Wait for the
    // actual action before checking its synchronous reset behavior.
    await driver.wait(async()=>ui("return !!doc.querySelector('main .section-title button.primary:not(:disabled)');"),10000);
    assert.equal(await ui("doc.querySelector('main .section-title button.primary').click();return !doc.querySelector('.metrics');"), true, 'Rescan clears the previous audit before checking an equal count');
    await waitAudit();
    await assertCounts(emptyClipCounts, { scanned: expected }, explanation);
  };
  await isolateEmptyClipCase('closed-heading');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(emptyClipCounts, { scanned: 0 }, 'An empty-height menu excludes all hidden headings, including SVG siblings and an unsupported quoted font family');
  await driver.setContext('content'); await driver.findElement(By.id('toggle')).click();
  assert.equal(await driver.executeScript("return document.getElementById('toggle').getAttribute('aria-expanded')==='true' && !document.getElementById('closed-menu').inert;"), true);
  await driver.setContext('chrome');
  await rescanEmptyClip(3, 'Opening the same menu includes its three headings on a fresh audit');
  await driver.setContext('content'); await driver.findElement(By.id('toggle')).click();
  await driver.setContext('chrome');
  await rescanEmptyClip(0, 'Closing the menu removes the headings again');
  for (const id of ['border-only-text', 'zero-width-text', 'own-empty-text']) {
    await isolateEmptyClipCase(id);
    await rescanEmptyClip(0, `${id}: an actually empty overflow area does not create a text finding`);
  }
  for (const id of ['visible-inert-text', 'fractional-text', 'quarter-text', 'padding-text', 'contents-text', 'visible-overflow-text', 'absolute-escape-text', 'fixed-escape-text', 'clip-margin-text', 'fieldset-legend-text']) {
    await isolateEmptyClipCase(id);
    await rescanEmptyClip(1, `${id}: visible or conservatively retained text survives the zero-area shortcut`);
  }
  // Modal dialogs and open popovers escape ancestor overflow in the top layer.
  // Closing each before switching cases avoids making the next target inert.
  for (const [id, openMethod, closeMethod] of [['escape-popover', 'showPopover', 'hidePopover'], ['escape-dialog', 'showModal', 'close']]) {
    await isolateEmptyClipCase(id);
    await driver.setContext('content');
    await driver.executeScript('document.getElementById(arguments[0])[arguments[1]]();', id, openMethod);
    assert.equal(await driver.executeScript("return document.getElementById(arguments[0]).matches(':popover-open,:modal');", id), true);
    await driver.setContext('chrome');
    await rescanEmptyClip(1, `${id}: top-layer text stays included despite its empty clipping ancestor`);
    await driver.setContext('content');
    await driver.executeScript('document.getElementById(arguments[0])[arguments[1]]();', id, closeMethod);
    await driver.setContext('chrome');
    await rescanEmptyClip(0, `${id}: closing the top-layer surface removes its text`);
  }
  checks.push('Empty overflow menus exclude hidden SVG headings and quoted-font text independently of font proof; reopening restores them, border-only and zero-width clips stay empty, while visible inert text, fractional/padded clips, display contents, overflow margins, fieldset legends, escaping positioned descendants and top-layer surfaces remain included');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/clamped-euro-title.html`);
  const euroGeometry = await driver.executeScript(`return [...document.querySelectorAll('.title')].map(node=>{
    const text=node.firstChild,range=document.createRange();range.selectNodeContents(text);
    const count=range.getClientRects().length,box=node.getBoundingClientRect(),euro=text.data.indexOf('€');
    range.setStart(text,euro);range.setEnd(text,euro+1);const symbol=range.getBoundingClientRect();
    return {id:node.id,width:box.width,height:box.height,lines:count,euroVisible:symbol.top<box.bottom,clamp:getComputedStyle(node).webkitLineClamp};});`);
  for (const item of euroGeometry) {
    assert.equal(item.width, 148); assert.equal(item.height, 60); assert.ok(item.lines > 3);
    assert.equal(item.euroVisible, item.id.includes('visible-euro'), `${item.id}: the synthetic euro is in the intended visible or hidden line`);
    assert.equal(item.clamp, item.id.startsWith('clamp-') ? '3' : 'none');
  }
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 4, passed: 4, failed: 0, manual: 0, small: 0 }, 'Euro signs in either visible or clipped title text do not invalidate proven line clipping');
  const euroAudit = await ui("return [...doc.querySelectorAll('.finding')].map(row=>({ratio:row.querySelector('.audit-ratio').textContent,aa:!!row.querySelector('[data-level=AA] .badge.pass'),aaa:!!row.querySelector('[data-level=AAA] .badge.pass')}));");
  assert.equal(euroAudit.length, 4);
  for (const row of euroAudit) { assert.match(row.ratio, /15[.,]91/); assert.equal(row.aa, true); assert.equal(row.aaa, true); }
  for (const selectedId of ['height-visible-euro', 'height-hidden-euro', 'clamp-visible-euro', 'clamp-hidden-euro']) {
    await ui("doc.querySelector('#tab-contrast').click();doc.querySelector('.picker').click();");
    await driver.setContext('content');
    await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
    await driver.findElement(By.id(selectedId)).click();
    await driver.setContext('chrome');
    await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=pass]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
    const measured = await ui("return {ratio:doc.querySelector('main .ratio').textContent,aa:!!doc.querySelector('[data-level=AA] .badge.pass'),aaa:!!doc.querySelector('[data-level=AAA] .badge.pass'),colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent)};");
    assert.match(measured.ratio, /15[.,]91/); assert.equal(measured.aa, true); assert.equal(measured.aaa, true);
    assert.deepEqual(measured.colors, ['#FFFFFF', '#222222'], `${selectedId}: inspection agrees with the audit and keeps the actual opaque background`);
  }
  const rescanEuro = async (expected, explanation) => {
    assert.equal(await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();return !doc.querySelector('.metrics');"), true);
    await waitAudit(); await assertCounts(decorationCounts, expected, explanation);
  };
  await driver.setContext('content'); await driver.executeScript("document.getElementById('cover').style.display='block';");
  await driver.setContext('chrome');
  await rescanEuro({ scanned: 4, passed: 3, failed: 0, manual: 1, small: 0 }, 'A real overlay still makes one visible euro title uncertain');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('cover').style.display='none';document.querySelectorAll('.title').forEach(node=>{node.style.overflow='visible';node.style.webkitLineClamp='unset';node.style.display='flow-root';});");
  await driver.setContext('chrome');
  await rescanEuro({ scanned: 4, passed: 0, failed: 0, manual: 4, small: 0 }, 'Removing clipping restores hidden-line overlap checks against the following painted tiles');
  await driver.setContext('content'); await driver.executeScript("document.querySelectorAll('.title').forEach(node=>{node.style.maxHeight='none';});");
  await driver.setContext('chrome');
  await rescanEuro({ scanned: 4, passed: 4, failed: 0, manual: 0, small: 0 }, 'Expanding the titles moves the following tiles below all text and restores actual AA/AAA contrast');
  checks.push('Clipped euro-sign titles retain 15.91:1 white-on-dark AA/AAA contrast in audits and inspection for max-height and three-line clamps, with the symbol visible or hidden; genuine overlays and revealed overflowing lines remain uncertain until the boxes expand');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/clamped-hyphen-title.html`);
  const hyphenGeometry = await driver.executeScript(`return [...document.querySelectorAll('.title')].map(node=>{
    const text=node.firstChild,range=document.createRange();range.selectNodeContents(text);
    const boxes=[...range.getClientRects()],lines=boxes.map(()=>[]);
    for(let i=0;i<text.length;i++){range.setStart(text,i);range.setEnd(text,i+1);const r=range.getBoundingClientRect();const line=boxes.findIndex(b=>Math.abs(b.top-r.top)<.02);if(line>=0)lines[line].push(text.substringData(i,1));}
    const box=node.getBoundingClientRect();return {id:node.id,width:box.width,height:box.height,lines:lines.map(line=>line.join('')),clamp:getComputedStyle(node).webkitLineClamp};});`);
  for (const item of hyphenGeometry) {
    assert.equal(item.width, 112); assert.equal(item.height, 44); assert.ok(item.lines.length > 2);
    const breaks=item.lines.flatMap((line,index)=>line.endsWith('-')?[index]:[]);
    assert.ok(breaks.length > 0, `${item.id}: a real natural hyphen break is required`);
    assert.equal(breaks.some(index=>index<2), item.id.includes('visible-hyphen'), item.id);
    assert.equal(item.clamp, item.id.startsWith('clamp-')?'2':'none');
  }
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 4, passed: 4, failed: 0, manual: 0, small: 0 }, 'Natural hyphen breaks preserve clipping proof for visible and hidden lines under transparent click targets');
  const hyphenAudit=await ui("return [...doc.querySelectorAll('.finding')].map(row=>({ratio:row.querySelector('.audit-ratio').textContent,aa:!!row.querySelector('[data-level=AA] .badge.pass'),aaa:!!row.querySelector('[data-level=AAA] .badge.pass')}));");
  assert.equal(hyphenAudit.length,4);
  for(const row of hyphenAudit){assert.match(row.ratio,/10[.,]43/);assert.equal(row.aa,true);assert.equal(row.aaa,true);}
  for(let index=0;index<4;index++){
    await ui(`doc.querySelector('#tab-audit').click();doc.querySelectorAll('.finding')[${index}].querySelector('.actions button:nth-child(2)').click();`);
    await driver.wait(async()=>ui("return !!doc.querySelector('.selected-card') && !!doc.querySelector('main .contrast-value[data-status=pass]');"),10000);
    const selected=await ui("return {ratio:doc.querySelector('main .ratio').textContent,aa:!!doc.querySelector('[data-level=AA] .badge.pass'),aaa:!!doc.querySelector('[data-level=AAA] .badge.pass'),colors:[...doc.querySelectorAll('.color-detail code')].map(node=>node.textContent)};");
    assert.match(selected.ratio,/10[.,]43/);assert.equal(selected.aa,true);assert.equal(selected.aaa,true);assert.deepEqual(selected.colors,['#99C3FF','#111111']);
  }
  const rescanHyphen=async(expected,explanation)=>{
    await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();");
    await waitAudit();await assertCounts(decorationCounts,expected,explanation);
  };
  await driver.setContext('content');await driver.executeScript("document.getElementById('cover').style.display='block';");
  await driver.setContext('chrome');
  await rescanHyphen({scanned:4,passed:3,failed:0,manual:1,small:0},'A real overlay remains uncertain despite the natural hyphen proof');
  await driver.setContext('content');await driver.executeScript("document.getElementById('cover').style.display='none';document.querySelectorAll('.title').forEach(node=>{node.style.hyphens='auto';});");
  await driver.setContext('chrome');
  await rescanHyphen({scanned:4,passed:0,failed:0,manual:4,small:0},'Automatic hyphenation still requires a separate shaping model');
  await driver.setContext('content');await driver.executeScript("document.querySelectorAll('.title').forEach(node=>{node.style.hyphens='manual';node.style.overflow='visible';node.style.webkitLineClamp='unset';node.style.display='block';});");
  await driver.setContext('chrome');
  await rescanHyphen({scanned:4,passed:0,failed:0,manual:4,small:0},'Visible overflow restores measurement of every line, including overlaps with the following tiles');
  await driver.setContext('content');await driver.executeScript("document.querySelectorAll('.title').forEach(node=>{node.style.maxHeight='none';});");
  await driver.setContext('chrome');
  await rescanHyphen({scanned:4,passed:4,failed:0,manual:0,small:0},'Expanded titles restore the known opaque background for all lines');
  checks.push('Natural ASCII hyphen breaks in visible or clipped title lines preserve 10.43:1 AA/AAA agreement between audit and inspection under empty clickable cards; real overlays, automatic hyphenation and revealed overlaps remain uncertain, and expansion restores measurement');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/positioned-carousel-text.html`);
  const carouselGeometry = await driver.executeScript(`
    const clip=document.getElementById('viewport').getBoundingClientRect();
    return {width:clip.width,items:['hidden-absolute','hidden-nested-absolute','hidden-del','hidden-right','visible-absolute','visible-nested-absolute','visible-del','partial-text'].map(id=>{
      const node=document.getElementById(id),style=getComputedStyle(node),range=document.createRange();range.selectNodeContents(node.firstChild);const rect=range.getBoundingClientRect();
      return {id,fontStyle:style.fontStyle,transformStyle:style.transformStyle,transform:style.transform,fragments:range.getClientRects().length,outside:rect.right<clip.left||rect.left>clip.right,partial:rect.left<clip.right&&rect.right>clip.right};})};`);
  assert.equal(carouselGeometry.width, 400);
  for (const item of carouselGeometry.items) {
    assert.equal(item.fontStyle, item.id.endsWith('nested-absolute') ? 'italic' : 'normal', item.id);
    if (['hidden-absolute', 'visible-absolute', 'hidden-right'].includes(item.id)) {
      assert.equal(item.transformStyle, 'preserve-3d', item.id);
      assert.equal(item.transform, 'matrix(1, 0, 0, 1, 0, 0)', item.id);
    }
    assert.equal(item.fragments, 1);
    assert.equal(item.outside, item.id.startsWith('hidden-'), item.id);
    assert.equal(item.partial, item.id === 'partial-text', item.id);
  }
  const uncertain3d = await driver.executeScript(`return ['rotated-3d','perspective-text'].map(id=>{
    const node=document.getElementById(id),style=getComputedStyle(node),clip=node.parentElement.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(node.firstChild);
    return {id,transformStyle:style.transformStyle,transform:style.transform,perspective:getComputedStyle(node.parentElement).perspective,outside:range.getBoundingClientRect().left>clip.right};});`);
  for (const item of uncertain3d) {
    assert.equal(item.transformStyle, 'preserve-3d', item.id);
    assert.equal(item.outside, true, item.id);
    if (item.id === 'rotated-3d') {
      assert.match(item.transform, /^matrix3d\(/);
      assert.equal(item.perspective, 'none');
    } else {
      assert.equal(item.transform, 'none');
      assert.equal(item.perspective, '400px');
    }
  }
  const isolateCarouselCase = async id => {
    await driver.setContext('content');
    await driver.executeScript(`const active=document.getElementById(arguments[0]).closest('.scenario');
      for(const node of document.querySelectorAll('.scenario'))node.style.display=node===active?'block':'none';`, id);
    await driver.setContext('chrome');
  };
  const carouselCounts = () => ui("return {scanned:Number(doc.querySelector('.scope-grid strong').textContent)};");
  const rescanCarousel = async (expected, explanation) => {
    assert.equal(await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();return !doc.querySelector('.metrics');"), true);
    await waitAudit(); await assertCounts(carouselCounts, { scanned: expected }, explanation);
  };
  await isolateCarouselCase('viewport');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(carouselCounts, { scanned: 4 }, 'Only the visible slide and partially painted edge text remain; contained absolute countdowns, nested badges and solid struck-through prices on hidden slides are excluded');
  await ui("doc.querySelector('#tab-contrast').click();doc.querySelector('.picker').click();");
  await driver.setContext('content'); await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('visible-absolute')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return doc.querySelector('.element-text-value')?.value==='Second countdown' && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  await driver.setContext('content'); await driver.executeScript("document.getElementById('hidden-del').style.textDecorationLine='none';");
  await driver.setContext('chrome');
  await rescanCarousel(4, 'Removing a hidden solid strike does not change which carousel text is painted');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('hidden-del').style.textDecorationLine='line-through';document.getElementById('viewport').style.overflow='visible';");
  await driver.setContext('chrome');
  await rescanCarousel(8, 'Removing the real overflow clip restores every slide, including text outside the viewport');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('viewport').style.overflow='hidden';document.getElementById('rail').style.transform='translateX(0px)';");
  await driver.setContext('chrome');
  await rescanCarousel(3, 'Moving to the first slide includes its three labels and removes the previously visible slide');
  for (const id of ['escape-absolute', 'escape-fixed', 'sticky-text', 'vertical-del', 'rotated-3d', 'perspective-text']) {
    await isolateCarouselCase(id);
    await rescanCarousel(1, `${id}: actual escaping text and unsupported positioning, vertical decoration or 3D geometry stay in scope`);
  }
  await isolateCarouselCase('top-layer');
  await rescanCarousel(0, 'A closed popover has no rendered text');
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('top-layer').showPopover();");
  assert.equal(await driver.executeScript("return getComputedStyle(document.getElementById('top-layer')).position;"), 'absolute', 'Firefox computes the authored relative top-layer surface as absolute, not fixed');
  assert.equal(await driver.executeScript(`const node=document.getElementById('top-layer'),clip=node.parentElement.getBoundingClientRect(),range=document.createRange();
    range.selectNodeContents(node);const text=range.getBoundingClientRect();return getComputedStyle(node.parentElement).position==='relative'&&text.top>clip.bottom;`), true, 'Without the top-layer exception its positioned parent would clip this text');
  await driver.setContext('chrome');
  await rescanCarousel(1, 'An explicitly opened relative top-layer surface escapes its ancestor clip');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('top-layer').hidePopover();");
  await driver.setContext('chrome');
  await rescanCarousel(0, 'Closing the popover removes its text again');
  checks.push('Translated carousel clips exclude contained absolute countdowns with identity preserve-3d transforms, nested italic badges and horizontally hidden solid struck-through prices; visible and partly painted text remains, changing slides or overflow updates the audit, and escaping absolute/fixed text, sticky positioning, vertical decoration, real 3D rotation, ancestor perspective and relative top-layer surfaces stay conservative');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/slotted-visibility.html`);
  const isolateSlottedCase = async id => {
    await driver.setContext('content');
    await driver.executeScript(`const active=document.getElementById(arguments[0]).closest('.scenario');
      for(const node of document.querySelectorAll('.scenario'))node.style.display=node===active?'block':'none';`, id);
    await driver.setContext('chrome');
  };
  const slottedCounts = () => ui("return {scanned:Number(doc.querySelector('.scope-grid strong').textContent)};");
  const rescanSlotted = async (expected, explanation) => {
    // A DOM click starts the scan without moving keyboard focus off the page.
    // A native sidebar click would hide a focus-only shortcut before measuring it.
    assert.equal(await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();return !doc.querySelector('.metrics');"), true);
    await waitAudit(); await assertCounts(slottedCounts, { scanned: expected }, explanation);
  };
  const skipState = async () => {
    await driver.setContext('content');
    const state = await driver.executeScript(`const host=document.getElementById('skip-host'),action=document.getElementById('skip-action'),wrapper=host.shadowRoot.querySelector('.skip-link'),button=action.shadowRoot.querySelector('button');
      const range=document.createRange();range.selectNodeContents(action.firstChild);const text=range.getBoundingClientRect(),box=action.getBoundingClientRect(),clip=wrapper.getBoundingClientRect();
      return {opacity:getComputedStyle(wrapper).opacity,hostOpacity:getComputedStyle(host).opacity,filter:getComputedStyle(host).filter,clipWidth:clip.width,clipHeight:clip.height,boxWidth:box.width,textWidth:text.width,textHeight:text.height,
        focusWithin:wrapper.matches(':focus-within'),buttonFocused:button.matches(':focus'),outerSlot:action.assignedSlot?.getRootNode().host.id,innerSlot:action.firstChild.assignedSlot?.getRootNode().host.id};`);
    await driver.setContext('chrome'); return state;
  };
  await isolateSlottedCase('skip-host');
  let skip = await skipState();
  assert.equal(skip.opacity, '0'); assert.equal(skip.hostOpacity, '1'); assert.match(skip.filter, /^drop-shadow\(/);
  assert.equal(skip.clipWidth, 1); assert.equal(skip.clipHeight, 1);
  assert.ok(skip.boxWidth > 20 && skip.textWidth > 20 && skip.textHeight > 0, 'The hidden shortcut still has positive host and text geometry');
  assert.equal(skip.outerSlot, 'skip-host'); assert.equal(skip.innerSlot, 'skip-action'); assert.equal(skip.focusWithin, false);
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(slottedCounts, { scanned: 0 }, 'An opacity-zero shadow wrapper hides light-DOM text assigned through two open components');
  // The initial trusted scan click focused the extension sidebar. Restore the
  // page browsing context before focusing its nested shadow button; otherwise
  // activeElement changes without Firefox activating :focus-within on the page.
  await driver.executeScript('gBrowser.selectedBrowser.focus();');
  await driver.setContext('content');
  await driver.executeScript("document.getElementById('skip-action').shadowRoot.querySelector('button').focus();");
  await driver.wait(async () => driver.executeScript("return document.getElementById('skip-host').shadowRoot.querySelector('.skip-link').matches(':focus-within');"),10000);
  skip = await skipState();
  assert.equal(skip.opacity, '1'); assert.equal(skip.focusWithin, true); assert.equal(skip.buttonFocused, true);
  assert.ok(skip.clipWidth > 20 && skip.clipHeight > 1, 'Keyboard focus expands the real shadow wrapper');
  await rescanSlotted(1, 'Focusing the same shortcut restores its light-DOM text without expanding the shadow inventory');
  assert.equal((await skipState()).buttonFocused, true, 'Scanning by sidebar DOM click preserves the page focus that makes the shortcut visible');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('focus-sink').focus();");
  skip = await skipState(); assert.equal(skip.opacity, '0'); assert.equal(skip.focusWithin, false);
  await rescanSlotted(0, 'Blurring the shortcut removes it again on a fresh audit');
  await isolateSlottedCase('text-host');
  await driver.setContext('content');
  const directSlot = await driver.executeScript(`const node=document.getElementById('text-host'),range=document.createRange();range.selectNodeContents(node.firstChild);
    return {slotHost:node.firstChild.assignedSlot?.getRootNode().host.id,hostOpacity:getComputedStyle(node).opacity,wrapperOpacity:getComputedStyle(node.shadowRoot.querySelector('.surface')).opacity,width:range.getBoundingClientRect().width};`);
  assert.equal(directSlot.slotHost, 'text-host'); assert.equal(directSlot.hostOpacity, '1'); assert.equal(directSlot.wrapperOpacity, '0'); assert.ok(directSlot.width > 20);
  await driver.setContext('chrome');
  await rescanSlotted(0, 'Directly assigned Text nodes also follow their internal slot wrapper');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('text-host').shadowRoot.querySelector('.surface').style.opacity='1';");
  await driver.setContext('chrome'); await rescanSlotted(1, 'Revealing a direct Text-node slot restores exactly one light-DOM run');
  await isolateSlottedCase('direct-override-host');
  await driver.setContext('content');
  const directOverride = await driver.executeScript(`const node=document.getElementById('direct-override-host'),slot=node.firstChild.assignedSlot,range=document.createRange();range.selectNodeContents(node.firstChild);
    return {hostVisibility:getComputedStyle(node).visibility,slotVisibility:getComputedStyle(slot).visibility,slotHost:slot.getRootNode().host.id,width:range.getBoundingClientRect().width};`);
  assert.equal(directOverride.hostVisibility, 'hidden'); assert.equal(directOverride.slotVisibility, 'visible');
  assert.equal(directOverride.slotHost, 'direct-override-host'); assert.ok(directOverride.width > 20);
  await driver.setContext('chrome');
  await rescanSlotted(1, 'A directly assigned Text node inherits visible from its slot despite a hidden host');
  for (const id of ['visible-host', 'contents-host', 'override-host', 'contents-visibility-host', 'wrapper-contents-host', 'faint-host']) {
    await isolateSlottedCase(id);
    await driver.setContext('content');
    const state = await driver.executeScript(`const host=document.getElementById(arguments[0]),node=host.firstElementChild,wrapper=host.shadowRoot.querySelector('.surface'),slot=host.shadowRoot.querySelector('slot'),range=document.createRange();range.selectNodeContents(node);
      return {slotHost:node.assignedSlot?.getRootNode().host.id,slotDisplay:getComputedStyle(slot).display,slotOpacity:getComputedStyle(slot).opacity,slotContentVisibility:getComputedStyle(slot).contentVisibility,wrapperDisplay:getComputedStyle(wrapper).display,wrapperContentVisibility:getComputedStyle(wrapper).contentVisibility,wrapperOpacity:getComputedStyle(wrapper).opacity,wrapperVisibility:getComputedStyle(wrapper).visibility,visibility:getComputedStyle(node).visibility,textWidth:range.getBoundingClientRect().width};`, id);
    assert.equal(state.slotHost, id); assert.ok(state.textWidth > 20); assert.equal(state.visibility, 'visible');
    if (id === 'contents-host') { assert.equal(state.slotDisplay, 'contents'); assert.equal(state.slotOpacity, '0'); }
    if (id === 'override-host') assert.equal(state.wrapperVisibility, 'hidden');
    if (id === 'contents-visibility-host') { assert.equal(state.slotDisplay, 'contents'); assert.equal(state.slotContentVisibility, 'hidden'); }
    if (id === 'wrapper-contents-host') { assert.equal(state.wrapperDisplay, 'contents'); assert.equal(state.wrapperContentVisibility, 'hidden'); }
    if (id === 'faint-host') assert.equal(state.wrapperOpacity, '0.01');
    await driver.setContext('chrome');
    await rescanSlotted(1, `${id}: visible slotted text remains, including ineffective boxless opacity/content-visibility, inherited visibility overrides and small positive opacity`);
  }
  await isolateSlottedCase('popover-host');
  await rescanSlotted(0, 'A closed assigned popover has no visible text');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('slotted-popover').showPopover();");
  const slottedPopover = await driver.executeScript(`const node=document.getElementById('slotted-popover'),wrapper=document.getElementById('popover-host').shadowRoot.querySelector('.surface'),range=document.createRange();range.selectNodeContents(node);
    return {open:node.matches(':popover-open'),slotHost:node.assignedSlot?.getRootNode().host.id,wrapperOpacity:getComputedStyle(wrapper).opacity,opacity:getComputedStyle(node).opacity,width:range.getBoundingClientRect().width};`);
  assert.equal(slottedPopover.open, true); assert.equal(slottedPopover.slotHost, 'popover-host');
  assert.equal(slottedPopover.wrapperOpacity, '0'); assert.equal(slottedPopover.opacity, '1'); assert.ok(slottedPopover.width > 20);
  await driver.setContext('chrome');
  await rescanSlotted(1, 'An explicitly opened top-layer surface escapes the opacity of its assigned shadow wrapper');
  await driver.setContext('content'); await driver.executeScript("document.getElementById('slotted-popover').hidePopover();");
  await driver.setContext('chrome'); await rescanSlotted(0, 'Closing the assigned popover removes its text again');
  await isolateSlottedCase('reassign-host');
  for (const [slot, expected] of [['hidden', 0], ['visible', 1], ['hidden', 0]]) {
    await driver.setContext('content');
    const assigned = await driver.executeScript(`const node=document.getElementById('reassigned-text');node.slot=arguments[0];
      return {name:node.assignedSlot?.name,opacity:getComputedStyle(node.assignedSlot.parentElement).opacity};`, slot);
    assert.equal(assigned.name, slot); assert.equal(assigned.opacity, slot === 'hidden' ? '0' : '1');
    await driver.setContext('chrome'); await rescanSlotted(expected, `Slot reassignment to ${slot} uses the current rendered ancestry`);
  }
  await isolateSlottedCase('unassigned-host');
  await driver.setContext('content');
  const unassigned = await driver.executeScript(`const node=document.getElementById('unassigned-host'),range=document.createRange();range.selectNodeContents(node.firstChild);
    return {assigned:node.firstChild.assignedSlot!==null,rectangles:range.getClientRects().length,hostWidth:node.getBoundingClientRect().width};`);
  assert.equal(unassigned.assigned, false); assert.equal(unassigned.rectangles, 0); assert.ok(unassigned.hostWidth > 20);
  await driver.setContext('chrome');
  await rescanSlotted(0, 'An unassigned light-DOM label and internal shadow-only text do not expand the audit inventory');
  checks.push('Slotted light-DOM text follows open shadow visibility: nested focus-only shortcuts and directly assigned Text nodes hide and reappear on rescans; boxless opacity/content-visibility, direct-text and element visibility overrides, positive opacity and top-layer escapes remain, slot reassignment updates ancestry, and internal shadow-only or unassigned text stays outside the inventory');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/flex-float-text.html`);
  const configureFloatCases = async (kind, offscreen) => {
    await driver.setContext('content');
    const geometry = await driver.executeScript(`document.body.style.paddingTop=arguments[1]?'2000px':'0px';
      for(const scene of document.querySelectorAll('.scenario'))scene.style.display=scene.classList.contains(arguments[0])?'block':'none';
      window.scrollTo(0,0);
      return [...document.querySelectorAll('.scenario.'+arguments[0]+' .label')].map(node=>{
        const style=getComputedStyle(node),parent=getComputedStyle(node.parentElement),range=document.createRange();range.selectNodeContents(node);
        const rect=range.getBoundingClientRect();return {id:node.id,float:style.cssFloat,parentDisplay:parent.display,pointerEvents:style.pointerEvents,
          offscreen:rect.top>=innerHeight,visible:rect.top>=0&&rect.bottom<=innerHeight};});`, kind, offscreen);
    await driver.setContext('chrome'); return geometry;
  };
  const floatCounts = () => ui(`return {
    scanned:Number(doc.querySelector('.scope-grid strong').textContent),
    passed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.pass .metric-count-value').textContent),
    failed:Number(doc.querySelector('[data-rule="contrast"] .metric-count.fail .metric-count-value').textContent),
    manual:Number(doc.querySelector('[data-rule="contrast"] .metric-count.manual .metric-count-value').textContent)
  };`);
  const rescanFloatCases = async (expected, explanation) => {
    assert.equal(await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();return !doc.querySelector('.metrics');"), true);
    await waitAudit(); await assertCounts(floatCounts, expected, explanation);
  };
  const offscreenItems = await configureFloatCases('good', true);
  assert.equal(offscreenItems.length, 8);
  for (const item of offscreenItems) {
    assert.equal(item.float, item.id.endsWith('-left') ? 'left' : 'right', item.id);
    assert.equal(item.parentDisplay, item.id.replace(/-(left|right)$/, ''), item.id);
    assert.equal(item.pointerEvents, 'none'); assert.equal(item.offscreen, true, item.id);
  }
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(floatCounts, { scanned: 8, passed: 8, failed: 0, manual: 0 }, 'A declared left/right float does not displace direct flex/grid items outside the viewport');
  const visibleItems = await configureFloatCases('good', false);
  assert.equal(visibleItems.every(item => item.visible), true, 'All eight comparison labels are now inside the viewport');
  await rescanFloatCases({ scanned: 8, passed: 8, failed: 0, manual: 0 }, 'The same flex/grid labels have matching audit outcomes inside the viewport');
  const uncertainItems = await configureFloatCases('uncertain', true);
  assert.equal(uncertainItems.length, 11); assert.equal(uncertainItems.every(item => item.offscreen), true);
  await rescanFloatCases({ scanned: 11, passed: 0, failed: 0, manual: 11 }, 'Real floats, displaced/absolute geometry, assigned slots, boxless parents and special details/fieldset formatting remain unassessed offscreen');
  await configureFloatCases('overlay', false);
  await rescanFloatCases({ scanned: 1, passed: 0, failed: 0, manual: 1 }, 'Ignoring an ineffective float cannot hide a real overlapping painted surface');
  await driver.setContext('content'); await driver.executeScript("document.querySelector('.paint').remove();");
  await driver.setContext('chrome');
  await rescanFloatCases({ scanned: 1, passed: 1, failed: 0, manual: 0 }, 'Removing the actual overlay restores the supported background on a fresh scan');
  checks.push('Offscreen pointer-transparent text in direct flex/inline-flex/grid/inline-grid items ignores ineffective declared left/right floats and matches visible results; real floats, displacement, slots, boxless or details/fieldset parents and real overlays retain uncertainty');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/details-visibility.html`);
  await driver.executeScript("document.getElementById('ordinary').style.display='block';");
  const collapsedGeometry = await driver.executeScript(`const node=document.querySelector('#offers .row span'),range=document.createRange();range.selectNodeContents(node);
    return {width:range.getBoundingClientRect().width,native:node.checkVisibility(),summary:document.querySelector('#offers summary').checkVisibility(),pseudo:CSS.supports('selector(::details-content)')};`);
  if (collapsedGeometry.pseudo) assert.ok(collapsedGeometry.width > 10, 'Closed disclosure contents retain misleading layout geometry');
  assert.equal(collapsedGeometry.native, false); assert.equal(collapsedGeometry.summary, true);
  await driver.setContext('chrome'); await driver.wait(async () => (await read()).pickerDisabled, 10000);
  await scanClick(); await waitAudit();
  await assertCounts(floatCounts, { scanned: 1, passed: 1, failed: 0, manual: 0 }, 'Closed offers retain only the first summary');
  const disclosureCase = async (id, count, setup = '', manual = 0) => {
    await driver.setContext('content');
    await driver.executeScript(`for(const node of document.querySelectorAll('.scenario'))node.style.display=node.id===arguments[0]?'block':'none';window.scrollTo(0,0);`, id);
    if (setup) await driver.executeScript(setup);
    await driver.setContext('chrome');
    await rescanFloatCases({ scanned: count, passed: count - manual, failed: 0, manual }, `Disclosure case ${id}: ${setup}`);
  };
  await disclosureCase('ordinary', 6, "document.getElementById('offers').open=true;");
  await disclosureCase('ordinary', 1, "document.getElementById('offers').open=false;");
  await disclosureCase('nested', 1);
  await disclosureCase('nested', 3, "document.getElementById('outer').open=true;");
  await disclosureCase('nested', 1, "document.getElementById('outer').open=false;");
  await disclosureCase('boxless', 1);
  await disclosureCase('boxless', 2, "document.getElementById('boxless-details').open=true;");
  for (const id of ['override', 'contents', 'inline']) await disclosureCase(id, collapsedGeometry.pseudo ? 2 : 1);
  await disclosureCase('hidden', collapsedGeometry.pseudo ? 1 : 2);
  await disclosureCase('slotted', 0);
  await disclosureCase('slotted', 1, "document.getElementById('component').shadowRoot.querySelector('details').open=true;");
  await disclosureCase('slotted', 0, "document.getElementById('component').shadowRoot.querySelector('details').open=false;");
  await disclosureCase('offscreen', 2);
  await disclosureCase('overlay', 1, '', 1);
  await disclosureCase('overlay', 1, "document.querySelector('#overlay .paint').remove();");
  checks.push('Collapsed disclosures exclude retained child layout boxes, direct text and secondary summaries; opening, nesting, boxless contents, slotted light DOM and supported details-content overrides follow actual rendering, while offscreen text stays in scope and real overlays remain unassessed');
  await disclosureCase('ordinary-decoration', 3);
  await disclosureCase('ordinary-decoration', 3, "document.getElementById('ordinary-stripe').className='right';");
  await disclosureCase('ordinary-decoration', 3, "document.getElementById('ordinary-stripe').className='cover';", 3);
  await disclosureCase('decoration', 4, '', collapsedGeometry.pseudo ? 0 : 4);
  await disclosureCase('decoration', 4, "document.getElementById('stripe').className='right';", collapsedGeometry.pseudo ? 0 : 4);
  await disclosureCase('decoration', 4, "document.getElementById('stripe').className='cover';", 4);
  checks.push('Empty absolute left/right decorative stripes separated from actual text ink preserve contrast, including padded/bordered owners and supported disclosure wrappers; full-width overlays remain unassessed');
  await driver.setContext('content'); await driver.get(`${host.url}/tests/fixtures/paint-properties.html`);
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  await scanClick(); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 7, passed: 2, failed: 4, manual: 1, small: 0 }, 'Boxless backgrounds cannot pass white-on-white text; glyph fill controls contrast and editor contents stay excluded');
  await ui("doc.querySelector('#tab-contrast').click();doc.querySelector('.picker').click();");
  await driver.setContext('content');
  await driver.wait(until.elementLocated(By.css('[data-style-inspector-overlay]')),10000);
  await driver.findElement(By.id('fill')).click();
  await driver.setContext('chrome');
  await driver.wait(async () => ui("return !!doc.querySelector('main .contrast-value[data-status=fail]') && doc.querySelector('.picker').getAttribute('aria-pressed')==='false';"),10000);
  assert.ok(await ui("return /4[.,]48/.test(doc.querySelector('main .ratio')?.textContent ?? '') && doc.querySelector('main').textContent.includes('#777777');"), 'Inspection uses the actual text fill rather than the overridden color property');
  await driver.setContext('content'); await driver.executeScript("document.designMode='on';");
  await driver.setContext('chrome'); await ui("doc.querySelector('#tab-audit').click();doc.querySelector('main .section-title button.primary').click();"); await waitAudit();
  await assertCounts(decorationCounts, { scanned: 0, passed: 0, failed: 0, manual: 0, small: 0 }, 'A document in designMode does not inspect editing contents');
  checks.push('Boxless background colors never certify invisible white text; explicit and inherited sRGB glyph fill supplies the measured contrast, outlined text stays uncertain, plaintext-only/mixed-case/semantic editors and designMode stay outside text measurement while ordinary noneditable text remains');
  await driver.setContext('content'); await driver.get('about:config');
  await driver.setContext('chrome');
  await driver.wait(async () => (await read()).pickerDisabled,10000);
  // Browser-protected pages remain unavailable even after optional access.
  const protectedAction=await ui("return {disabled:doc.querySelector('main button.primary')?.disabled,text:doc.body.innerText};");
  if (!protectedAction.disabled) await scanClick();
  await driver.wait(async () => ui("return !doc.querySelector('.metrics') && doc.querySelector('main button.primary')?.disabled;"),10000);
  checks.push('Protected Firefox pages stay unscannable despite optional website permission');
  await mkdir(path.join(root, 'test-results'), { recursive: true });
  await writeFile(path.join(root, 'test-results', `firefox-${version}.json`), JSON.stringify({ version, checks, limitations: ['Optional download save dialog and multi-window interactive edge cases still require manual verification.'] }, null, 2));
  console.log(JSON.stringify({ version, checks }, null, 2));
} catch (error) {
  console.log({ completedChecks: checks.length, lastCheck: checks.at(-1) });
  if (driver) {
    await driver.setContext('chrome').catch(() => {});
    console.log(await driver.executeScript("return {sidebar:document.getElementById('sidebar')?.outerHTML, panel:document.getElementById('sidebar')?.contentDocument?.getElementById('webext-panels-browser')?.outerHTML, errors:Services.console.getMessageArray().map(e=>e.message).filter(e=>/moz-extension|ExtensionError/.test(e)).slice(-8)};").catch(() => 'No chrome diagnostics'));
  }
  throw error;
} finally { try { if (driver) await driver.quit(); } finally { if (host) await host.close(); } }
