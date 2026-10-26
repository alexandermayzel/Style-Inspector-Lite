// Synthetic responsiveness probes. Timing is reported, never a machine-dependent pass threshold.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { root as repo, artifactsRoot, buildDir } from '../../internal/scripts/paths.mjs';
const out = path.join(artifactsRoot, 'test-results');
await mkdir(out, { recursive: true });
const require = createRequire(path.join(repo, 'package.json'));
const source = await readFile(path.join(buildDir, 'content.js'), 'utf8');
const defaults = { schemaVersion: 1, appearance: 'system', colorFormat: 'hex', contrastTarget: 'AA', livePreview: true, contextMenuEnabled: true, showDiagnostics: false };
const server = createServer((req, res) => { res.writeHead(200, { 'Content-Type':'text/html' }); res.end('<!doctype html><html><head><style>body{margin:0;background:#fff;color:#222;font:14px/20px Arial}p{margin:0}</style></head><body></body></html>'); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const address = `http://127.0.0.1:${server.address().port}`;
let browser;
async function create() {
  if (!process.argv.includes('--firefox')) {
    const { chromium } = require('playwright');
    const instance = await chromium.launch({ channel:'msedge', headless:true });
    const page = await instance.newPage({ viewport:{width:1200,height:900} });
    return { name:`Edge ${instance.version()}`, evaluate:(fn, args)=>page.evaluate(fn,args), navigate:()=>page.goto(address), close:()=>instance.close() };
  }
  const { Builder } = require('selenium-webdriver');
  const firefox = require('selenium-webdriver/firefox');
  const options = new firefox.Options().addArguments('-headless').setBinary(process.env.FIREFOX_BINARY ?? 'C:/Program Files/Mozilla Firefox/firefox.exe').setPreference('datareporting.policy.dataSubmissionEnabled',false);
  const driver = await new Builder().forBrowser('firefox').setFirefoxOptions(options).setFirefoxService(new firefox.ServiceBuilder(process.env.GECKODRIVER)).build();
  await driver.manage().setTimeouts({ script:120000 });
  await driver.manage().window().setRect({width:1200,height:1000});
  return { name:`Firefox ${(await driver.getCapabilities()).get('browserVersion')}`, evaluate:async(fn,args)=> {
    const r = await driver.executeAsyncScript('const [fn,args,done]=arguments;Promise.resolve().then(()=>eval("("+fn+")")(args)).then(value=>done({value}),e=>done({error:String(e.stack||e)}));',fn.toString(),args??null);
    if(r.error)throw Error(r.error);return r.value;
  }, navigate:()=>driver.get(address), close:()=>driver.quit() };
}
const rows=[];
try {
  browser = await create();
  for(const kind of ['simple-100','simple-1000','deep-300','siblings-10000','one-element-1000-text','selection-deep-300','picker-deep-300','picker-live','picker-no-preview','idle-mutations']) {
    await browser.navigate();
    await browser.evaluate(({kind,defaults,source,countCalls})=>{
      const root=document.createElement('main');document.body.append(root);
      if(kind==='one-element-1000-text'){
        const p=document.createElement('p');p.style.whiteSpace='pre';
        for(let i=0;i<1000;i++)p.append(document.createTextNode(`Example ${i}\n`));root.append(p);
      }else if(kind.endsWith('deep-300')){
        let parent=root;for(let i=0;i<300;i++){const child=document.createElement('div');parent.append(child);parent=child;}for(let i=0;i<100;i++){const p=document.createElement('p');p.textContent=`Example ${i}`;parent.append(p);}window.__selectionTarget=parent;
      }else{
        const count=kind==='simple-100'?100:kind==='siblings-10000'?10000:1000;
        const frag=document.createDocumentFragment();for(let i=0;i<count;i++){const p=document.createElement('p');p.textContent=`Example ${i}`;frag.append(p);}root.append(frag);
      }
      window.__probe={styles:0,ranges:0,hits:0,events:0,audits:0,gaps:[],done:null};
      if(countCalls){
      const css=window.getComputedStyle;window.getComputedStyle=function(...args){window.__probe.styles++;try{return css.call(window,...args);}catch(e){window.__probe.failure=String(e.stack||e);throw e;}};
      const range=Range.prototype.getClientRects;Range.prototype.getClientRects=function(...args){window.__probe.ranges++;return range.apply(this,args);};
      const hit=Document.prototype.elementsFromPoint;Document.prototype.elementsFromPoint=function(...args){window.__probe.hits++;return hit.apply(this,args);};
      }
      let last=performance.now();window.__timer=setInterval(()=>{const now=performance.now();window.__probe.gaps.push(now-last);last=now;},10);
      window.__handlers=[];
      window.browser={runtime:{id:'performance-test',onMessage:{addListener(fn){window.__handlers.push(fn);}},sendMessage:async(event)=>{
        window.__probe.events++;if(event.audit){window.__probe.audits++;if(event.audit.status!=='running')window.__probe.done={status:event.audit.status,runs:event.audit.runs.length,reasons:event.audit.reasons};}
        if(event.type==='preview')window.__probe.previewRuns=event.snapshot.textRuns.length;
        if(event.type==='selected')window.__probe.selectionRuns=event.snapshot.textRuns.length;
      }},i18n:{getUILanguage:()=> 'en',getMessage:()=>''}};
      window.__command=async(type,detail={})=>{const msg={channel:'sil-content',type,requestId:`probe-${type}`,epoch:0,windowId:1,tabId:1,settings:{...defaults,livePreview:kind!=='picker-no-preview'},...detail};for(const fn of window.__handlers){const response=fn(msg,{id:'performance-test'});if(response!==undefined)return await response;}};
      (0,eval)(source);
    },{kind,defaults,source,countCalls:!process.argv.includes('--no-counts')});
    const row=await browser.evaluate(async kind=>{
      await window.__command('hello');
      const start=performance.now();
      if(kind.startsWith('selection')){
        window.__styleInspectorContext={requestId:'probe-selection',element:window.__selectionTarget};
        const response=await window.__command('capture-context',{requestId:'probe-selection'});
        if(response.error)throw Error(response.error);
      }else if(kind.startsWith('picker')){
        await window.__command('start-picker');
        (window.__selectionTarget??document.querySelector('main')).dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true}));
        if(kind==='picker-no-preview')await new Promise(r=>setTimeout(r,500));
        else { const until=performance.now()+100000;while(window.__probe.previewRuns===undefined&&performance.now()<until)await new Promise(r=>setTimeout(r,10));if(window.__probe.previewRuns===undefined)throw Error(`Preview timeout ${kind}`); }
        await window.__command('cancel-picker');
      }else{
        await window.__command('start-audit');
        const until=performance.now()+100000;
        while(!window.__probe.done&&performance.now()<until)await new Promise(r=>setTimeout(r,10));
        if(!window.__probe.done)throw Error(`Scan timeout ${kind}`);
      }
      const elapsed=performance.now()-start;
      await new Promise(r=>setTimeout(r,30));
      const result={kind,elapsed,styles:window.__probe.styles,ranges:window.__probe.ranges,hits:window.__probe.hits,events:window.__probe.events,auditEvents:window.__probe.audits,maxGap:Math.max(...window.__probe.gaps),gapsOver50:window.__probe.gaps.filter(n=>n>50).length,result:window.__probe.done,previewRuns:window.__probe.previewRuns,selectionRuns:window.__probe.selectionRuns,failure:window.__probe.failure};
      if(kind==='idle-mutations'){
        const before={...window.__probe};
        for(let batch=0;batch<20;batch++){for(let i=0;i<200;i++)document.querySelector('main').setAttribute('data-counter',String(batch*200+i));await new Promise(r=>setTimeout(r,10));}
        result.after4000Mutations={styles:window.__probe.styles-before.styles,ranges:window.__probe.ranges-before.ranges,hits:window.__probe.hits-before.hits,events:window.__probe.events-before.events,audits:window.__probe.audits-before.audits};
      }
      clearInterval(window.__timer);return result;
    },kind);
    if (!kind.startsWith('picker')&&!kind.startsWith('selection')) { assert.equal(row.result.runs, ['simple-100','deep-300'].includes(kind) ? 100 : 1000); assert.equal(row.result.reasons.includes('measurement-failed'), false); }
    if (kind==='picker-live'||kind==='picker-deep-300') assert.equal(row.previewRuns,100);
    if (kind==='selection-deep-300') assert.equal(row.selectionRuns,100);
    if (kind==='picker-no-preview') assert.equal(row.previewRuns ?? null,null);
    if (kind==='idle-mutations') assert.deepEqual(row.after4000Mutations,{styles:0,ranges:0,hits:0,events:1,audits:1});
    rows.push(row);console.log(JSON.stringify({browser:browser.name,...row}));
  }
  await writeFile(path.join(out,`performance-${browser.name.split(' ')[0].toLowerCase()}${process.argv.includes('--no-counts')?'-timing-only':''}.json`),JSON.stringify({browser:browser.name,countCalls:!process.argv.includes('--no-counts'),notes:'Synthetic local fixtures, instrumented content-script path. Sidebar/background IPC is stubbed; not a full browser CPU benchmark.',rows},null,2));
} finally {if(browser)await browser.close();await new Promise(r=>server.close(r));}
