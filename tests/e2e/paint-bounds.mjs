import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Builder } from 'selenium-webdriver';
import firefox from 'selenium-webdriver/firefox.js';
import { root } from './support.mjs';

// Exercise native layout and pseudo-element CSSOM without substituting DOM mocks.
const bundle = await build({ stdin: { contents: `export { measureSnapshot, ElementRegistry } from './src/runtime/dom';
  export { DEFAULT_SETTINGS } from './src/runtime/settings'; export { cssColorContrast } from './src/core/contrast';`, resolveDir: root },
  bundle: true, format: 'iife', globalName: 'PaintChecks', write: false });
const options = new firefox.Options().addArguments('-headless');
if (process.env.FIREFOX_BINARY) options.setBinary(process.env.FIREFOX_BINARY);
else if (process.platform === 'win32') options.setBinary('C:\\Program Files\\Mozilla Firefox\\firefox.exe');
const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options)
  .setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER)).build();
try {
  await driver.manage().setTimeouts({ script: 15000, pageLoad: 15000 });
  await driver.manage().window().setRect({ width: 1200, height: 1100 });
  await driver.get('data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html><head><style>
    html { background: white; } body { margin: 20px; color: black; font: 16px/24px sans-serif; }
    section { margin: 12px 0; } p { margin: 0; }
    .line::first-line { color: white; } .letter::first-letter { color: white; }
    .font::first-letter { font-size: 9px; font-weight: 900; } .fill::first-line { -webkit-text-fill-color: white; }
    .paint::first-line { background: black; } .italic::first-line { font-style: italic; }
    .decoration::first-line { text-decoration: underline red; }
    .box { position: relative; background: black; width: 100px; height: 24px; }
    .box span { position: absolute; white-space: nowrap; color: white; font: 16px/24px sans-serif; }
    .outside { left: 150px; } .partial { left: 85px; } .inside { left: 6px; }
  </style></head><body>
    <section><p id="plain">Ordinary text</p></section>
    <section><p class="line" id="line">First line text</p></section>
    <section><p class="letter" id="letter">Initial text</p></section>
    <section class="line"><p><span id="inherited">Inherited first line</span><br><span id="later">Later line</span></p><p id="second">Second paragraph</p></section>
    <section><span class="line" id="inline">An inline cannot establish first-line</span></section>
    <section><p class="font" id="font">Small initial</p></section>
    <section><p class="fill" id="fill">Filled first line</p></section>
    <section><p class="paint" id="paint">Background first line</p></section>
    <section><p class="italic" id="italic">Styled first line</p></section>
    <section style="display:grid"><a id="ordinary-link" href="#" style="color:black">Ordinary underlined grid item</a></section>
    <section><p class="decoration" id="decoration">Decorated first line</p></section>
    <section class="box"><span class="outside" id="outside">Text</span></section>
    <section class="box"><span class="partial" id="partial">Text</span></section>
    <section class="box"><span class="inside" id="inside">Text</span></section>
    <section class="box" style="padding:20px;background-clip:content-box"><span style="left:0;top:0" id="padding">Text</span></section>
    <section class="box" style="border-radius:24px;height:48px"><span style="left:0;top:0" id="corner">Text</span></section>
    <section class="box" style="transform:rotate(15deg)"><span class="inside" id="rotate">Text</span></section>
    <section class="box" style="transform:translateX(20px)"><span class="inside" id="translate">Text</span></section>
    <section class="box"><span id="ellipsis" style="display:block;position:relative;overflow:hidden;text-overflow:ellipsis;width:80px;white-space:nowrap">An ellipsized preview remains a measurement of the visible text</span></section>
  </body></html>`));
  await driver.executeScript(bundle.outputFiles[0].text + '\nwindow.PaintChecks = PaintChecks;');
  const results = await driver.executeScript(`
    const result={}, registry=new PaintChecks.ElementRegistry('paint-checks');
    for(const id of ['plain','line','letter','inherited','later','second','inline','font','fill','paint','italic','ordinary-link','decoration','outside','partial','inside','padding','corner','rotate','translate','ellipsis']) {
      const snapshot=PaintChecks.measureSnapshot(document.getElementById(id),{documentToken:'paint-checks',tabId:1,windowId:1,frameId:0},registry,PaintChecks.DEFAULT_SETTINGS);
      const run=snapshot.textRuns[0]; result[id]={run, css:run&&PaintChecks.cssColorContrast(run)};
    }
    return result;`);
  for (const id of ['plain', 'later', 'second', 'inline', 'inside', 'translate', 'ellipsis', 'ordinary-link']) {
    assert.equal(results[id].run.contrast.status, 'pass', `${id}: ordinary text remains measurable`);
    assert.equal(results[id].run.contrast.ratio, 21, `${id}: exact black/white contrast`);
  }
  for (const id of ['line', 'letter', 'inherited', 'fill', 'paint', 'italic', 'decoration']) {
    assert.equal(results[id].run.contrast.status, 'manual', `${id}: pseudo paint cannot be certified using element CSS`);
    assert.equal(results[id].run.contrast.ratio, null, id);
    assert.ok(results[id].run.reasons.includes('text-pseudo-style'), id);
    assert.equal(results[id].css?.ratio, 21, `${id}: ordinary CSS colors remain explicitly unverified`);
  }
  assert.equal(results.font.run.contrast.status, 'manual');
  assert.equal(results.font.run.fontSize.status, 'manual');
  assert.equal(results.font.css?.category, 'unknown');
  assert.equal(results.font.css?.AA, undefined, 'An altered initial has no single confirmed font threshold');
  assert.equal(results.outside.run.contrast.ratio, 1, 'A fully escaped black parent cannot be the white text background');
  assert.equal(results.outside.run.contrast.status, 'fail');
  for (const id of ['partial', 'padding', 'corner', 'rotate']) {
    assert.equal(results[id].run.contrast.status, 'manual', `${id}: partial/complex paint coverage is not certified`);
    assert.ok(results[id].run.reasons.includes('background-coverage'), id);
  }
  // A propagated body background continues across the entire document canvas.
  const canvas = await driver.executeScript(`
    document.documentElement.style.background='transparent'; document.body.style.background='black';
    const e=document.getElementById('outside'); e.parentElement.style.background='transparent';
    return PaintChecks.measureSnapshot(e,{documentToken:'canvas',tabId:1,windowId:1,frameId:0},new PaintChecks.ElementRegistry('canvas'),PaintChecks.DEFAULT_SETTINGS).textRuns[0];`);
  assert.equal(canvas.contrast.ratio, 21, 'An HTML body background propagated to the canvas is not clipped to its box');
  console.log(JSON.stringify({ browser: `Firefox ${(await driver.getCapabilities()).get('browserVersion')}`, groups: 22,
    cases: Object.fromEntries(Object.entries(results).map(([id, result]) => [id, { status: result.run.contrast.status, ratio: result.run.contrast.ratio, reasons: result.run.reasons }])) }, null, 2));
} finally { await driver.quit(); }
