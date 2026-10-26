import type { Audit, ColorValue, ContrastResult, ContrastSuggestion, ExportFormat, ExportOptions, ExportResult, ExportScope, ExportSource, FontUsage, PaletteRole, PaletteSort, PaletteUsage, RGBA, RuleCounts, RuleStatus, Settings, SimulationMode, Snapshot, TabId, TextRun } from '../core/types';
import type { AnalysisSummary, SidebarCommand, SidebarMessage, SidebarState } from '../runtime/protocol';
import { DEFAULT_SETTINGS } from '../runtime/settings';
import { formatColor, formatDisplayColor, parseColor } from '../core/colors';
import { cssColorContrast, evaluateRun, reassessAudit } from '../core/contrast';
import { suggestContrast } from '../core/suggestions';
import { simulateColor } from '../core/simulation';
import { safeValue, serializeColorVariables, serializeExport } from '../core/exports';
import { getFontEntries, getInventoryRuns, getPaletteEntries, primaryPaletteRole } from '../core/style-inventory';
import { groupAuditRuns } from '../core/audit-groups';
import { compareAudits, type AuditComparison, type AuditChange } from '../core/audit-comparison';
import { serializeDiagnostic } from '../core/diagnostics';
import { date, language, number, reason, t } from './i18n';
import { manualContrast, parseManualColor } from './manual-contrast';
import { closeActiveColorPicker, createColorPicker, type ColorPicker } from './color-picker';

type View = TabId | 'settings' | 'export' | 'occurrences';
type Filter = 'all' | 'contrast' | 'small' | 'manual' | 'css';
type FontSort = 'frequency' | 'size-asc' | 'size-desc';
type ScanScope = 'page' | 'viewport' | 'selection';
type CommandBody = SidebarCommand extends infer C ? C extends SidebarCommand ? Omit<C, 'requestId'> : never : never;
type Child = Node | string | null | undefined;
const icons: Record<string, string> = {
 'status-pass':'M4.5 11.5l5 5L19.5 7.5', 'status-fail':'M12 5v9 M12 19h.01', 'status-manual':'M7.5 8.5a4.5 4.5 0 0 1 9 0c0 3.5-4.5 3.5-4.5 7 M12 20h.01', 'status-not-applicable':'M6 12h12',
 audit: 'M6 3h8l4 4v14H6z M14 3v5h5 M9 12h6 M9 16h6', contrast:'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18 M12 3v18', colors:'M12 3a9 9 0 1 0 0 18h2a2 2 0 0 0 0-4h-1a2 2 0 0 1 0-4h3a5 5 0 0 0 0-10z M7 9h.01 M10 6h.01 M15 6h.01', typography:'M4 5h16 M12 5v15 M8 20h8 M4 5v3 M20 5v3', layout:'M3 4h18v16H3z M9 4v16 M9 11h12', settings:'M9 3h6l1 3l3 1l2 5l-2 5l-3 1l-1 3H9l-1-3l-3-1l-2-5l2-5l3-1z M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8', picker:'M4 3l15 9l-7 1l-3 7z', copy:'M8 8h12v13H8z M16 8V3H3v13h5', export:'M14 3h7v7 M21 3L11 13 M10 4H4v16h16v-6', back:'M15 5l-7 7l7 7', close:'M5 5l14 14 M19 5L5 19', refresh:'M20 7v5h-5 M4 17v-5h5 M6 7a7 7 0 0 1 12-1l2 6 M4 12l2 6a7 7 0 0 0 12-1', show:'M2 12s4-7 10-7s10 7 10 7s-4 7-10 7s-10-7-10-7 M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6', save:'M4 3h14l3 3v15H3V3z M7 3v6h10V3 M7 21v-8h10v8'
};
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', ...children: Child[]): HTMLElementTagNameMap[K] {
 const node = document.createElement(tag); if (className) node.className = className;
 for (const child of children) if (child !== null && child !== undefined) node.append(child);
 return node;
}
function icon(name: string): SVGSVGElement {
 const node = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
 for (const [key, value] of Object.entries({viewBox:'0 0 24 24', fill:'none', stroke:'currentColor', 'stroke-width':'1.7','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'})) node.setAttribute(key,value);
 if(name==='contrast'){const half=document.createElementNS(node.namespaceURI,'path');half.setAttribute('d','M12 3a9 9 0 0 1 0 18Z');half.setAttribute('fill','currentColor');half.setAttribute('stroke','none');node.append(half);}
 const path = document.createElementNS(node.namespaceURI,'path'); path.setAttribute('d', icons[name] ?? icons.audit!); node.append(path); return node;
}
function button(label: string, action: () => void, className = '', symbol?: string): HTMLButtonElement {
 const node = el('button',className, symbol ? icon(symbol) : null, label); node.type='button'; node.addEventListener('click', action); return node;
}
function card(title: string, ...children: Child[]): HTMLElement { return el('section','card',el('h2','',title),...children); }
function notice(text: string, style = '') { return el('div',`notice ${style}`,text); }
function small(text: string) { return el('p','small-text muted',text); }
function viewportPartialNote(){const note=small(t('auditViewportPartial'));note.classList.add('audit-viewport-partial');return note;}
function badge(status: RuleStatus, font = false) {
 const keys: Record<RuleStatus,string> = { pass: font ? 'statusThresholdMet' : 'statusPass', fail: font ? 'findingSmallText':'statusFail',manual:'statusManualReview','not-applicable':'statusNotApplicable' };
 const node=el('span',`badge ${status}`,`${status==='pass'?'✓':status==='fail'?'!':status==='manual'?'?':'–'} ${t(keys[status]!)}`);if(status==='manual')node.title=t('manualHelp');return node;
}
function selectField(label: string, options: Array<[string,string,boolean?]>, value: string, onChange: (value: string) => void) {
 const id=`field-${Array.from(label).map(char=>char.codePointAt(0)!.toString(16)).join('-')}`;const select=el('select');select.id=id;
 for(const [optionValue,title,disabled] of options){const option=el('option','',title);option.value=optionValue;option.disabled=Boolean(disabled);select.append(option);}
 select.value=value; select.addEventListener('change',()=>onChange(select.value));
 const labelNode=el('label','',label);labelNode.htmlFor=id;return el('div','form-field',labelNode,select);
}
function toggle(label:string, description:string, checked:boolean,onChange:(checked:boolean)=>void,controlId?:string){
 const id=controlId??`field-${Array.from(label).map(char=>char.codePointAt(0)!.toString(16)).join('-')}`;const input=el('input');input.type='checkbox';input.id=id;input.checked=checked;input.addEventListener('change',()=>onChange(input.checked));
 const labelNode=el('label','setting-label',label,el('small','',description));labelNode.htmlFor=id;return el('div','toggle-row',input,labelNode);
}
let sequence=0;
let state: SidebarState = {windowId:0,tabId:null,documentToken:null,documentRevision:0,access:'needs-activation',selected:null,preview:null,picker:false,audit:null,progress:null,lastEvent:'ready',settings:{...DEFAULT_SETTINGS}};
let connected=false;let hasConnected=false;let port:browser.runtime.Port|null=null;let sidebarWindowId:number|null=null;
let reconnectAttempts=0;let reconnectTimer:ReturnType<typeof setTimeout>|undefined;let readyTimer:ReturnType<typeof setTimeout>|undefined;let closing=false;
const reconnectDelays=[250,500,1000,2000,4000];
let activeTab: TabId='audit'; let view:View='audit'; let previousView:TabId='audit';let lastElementTab:TabId='contrast';
const scrolls: Partial<Record<View,number>>={};let filter:Filter='all';let resultLimit=30;let paletteLimit=24;let paletteSort:PaletteSort='usage';let selectedRunId:string|null=null;let previewRunIndex=0;let returnToAudit=false;
let fontSort:FontSort='frequency';
let scanScope:ScanScope='page';let missingReason='';let fontFamilyLimit=12;
const fontSizeLimits=new Map<string,number>();const fontVariantLimits=new Map<string,number>();
const fontInventories=new WeakMap<Audit,Partial<Record<FontSort,FontUsage[]>>>();
const paletteInventories=new WeakMap<Audit,Partial<Record<PaletteSort,PaletteUsage[]>>>();
const measurementDateFormat=new Intl.DateTimeFormat(language,{dateStyle:'medium',timeStyle:'medium'});
let simulation:SimulationMode='original';let simulationOpen=false;let suggestionProperty:'color'|'background-color'='color';let includePalette=false;
let confirmAction:'clear'|'reset'|null=null;let shortcut=t('unassigned');let toastTimer:ReturnType<typeof setTimeout>|undefined;let clipboardFallback:string|null=null;let clipboardValidity:(()=>boolean)|null=null;let pendingRun:{requestId:string;runId:string;elementRef:string}|null=null;
let auditStarting=false;let auditStartRequest:string|null=null;let hasAudited=false;let accessRequest:object|null=null;let copySequence=0;const auditActionRequests=new Map<string,string>();const auditActionErrors=new Map<string,string>();
const auditAssessments=new WeakMap<Audit,Partial<Record<Settings['contrastTarget'],Audit>>>();
let exportSources:Partial<Record<ExportSource['kind'],ExportSource>>={};let exportKind:ExportSource['kind']='element';let exportFormat:ExportFormat='css';let exportScope:ExportScope='all';let exportResult:ExportResult|null=null;let exportInvalid=false;
let exportColorFormat:Settings['colorFormat']='hex';let exportTarget:Settings['contrastTarget']='AA';
let exportInventory:NonNullable<ExportOptions['inventory']>='measured';
let exportCache:{source:ExportSource;key:string;result:ExportResult}|null=null;let saveRequest:object|null=null;
let exportPreview:{result:ExportResult;node:HTMLPreElement}|null=null;
const exportPreviewLimit=65536;
let manualDraft={foreground:'#000000',background:'#FFFFFF',underlay:''};
let manualPanel:{node:HTMLElement;update:()=>void}|null=null;
let manualExplicit=false;
let manualOrigin:{view:View;tab:TabId;scroll:number}|null=null;
let inventorySelection:{auditId:string;measuredAt:string;refs:string[];label:string;origin:TabId;scroll:number;limit:number;prefer?:((run:TextRun)=>boolean)}|null=null;
let returnToInventory=false;
let groupedAudit=false;
const openAuditGroups=new Set<string>();
const groupMemberLimits=new Map<string,number>();
const openFontVariants=new Set<string>();
const openPaletteActions=new Set<string>();
let pendingDiagnostic:{requestId:string;valid:()=>boolean}|null=null;
let comparisonOpen=false;let comparisonLimit=30;
let comparisonFilter:'all'|AuditChange['kind']='all';
let comparisonCache:{previous:Audit;current:Audit;target:Settings['contrastTarget'];value:AuditComparison}|null=null;
let analysesOverview:Extract<SidebarMessage,{type:'analyses'}>|null=null;
let pendingAnalyses:{requestId:string;clearing:boolean}|null=null;
let confirmAnalysis:AnalysisSummary|null=null;
const diagnosticRequests=new Set<string>();
const version=browser.runtime.getManifest().version;
const app=document.querySelector<HTMLDivElement>('#app')!;document.documentElement.lang=language;
const logo=el('img','brand-icon');logo.src='../assets/icon-48.png';logo.alt='';logo.width=32;logo.height=32;
const title=el('h1','brand-title','Style Inspector ',el('span','','Lite'));
const gear=button('',()=>openSubview('settings'),'icon-button','settings');gear.title=t('actionSettings');gear.setAttribute('aria-label',t('actionSettings'));
const header=el('header','header',logo,title,gear);
const picker=button(t('actionSelectElement'),()=>{if(state.picker){send({type:'cancel-picker'});}else{navigate(lastElementTab==='audit'?'contrast':lastElementTab);send({type:'start-picker'});}},'picker','picker');
const toolbar=el('div','toolbar',picker);
const tabs=el('nav','tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label',t('navigation'));
const tabButtons=new Map<TabId,HTMLButtonElement>(); const tabIds:TabId[]=['audit','contrast','colors','typography','layout'];
for(const id of tabIds){
 const key=`tab${id[0]!.toUpperCase()}${id.slice(1)}`;const name=el('span',`tab-long ${id==='audit'?'audit-name':''}`,t(key));
 const tab=button('',()=>navigate(id),'tab');tab.append(icon(id),name);if(id==='audit')tab.append(el('span','tab-short',t('tabAuditShort')));
 tab.id=`tab-${id}`;tab.setAttribute('role','tab');tab.setAttribute('aria-label',t(key));tab.title=t(key);tab.setAttribute('aria-controls','panel');
 tab.addEventListener('keydown',event=>{let next=tabIds.indexOf(id);if(event.key==='ArrowRight')next=(next+1)%5;else if(event.key==='ArrowLeft')next=(next+4)%5;else if(event.key==='Home')next=0;else if(event.key==='End')next=4;else return;event.preventDefault();navigate(tabIds[next]!);tabButtons.get(tabIds[next]!)?.focus();});
 tabButtons.set(id,tab);tabs.append(tab);
}
const content=el('main','content');content.id='panel';content.tabIndex=0;content.setAttribute('role','tabpanel');
const copy=button(t('actionCopy'),()=>void copyCurrent(),'primary','copy');
const exportButton=button(t('actionExport'),()=>{if(view==='export')void saveExport();else openExport();},'','export');
const footer=el('footer','footer',copy,exportButton);const toast=el('div','toast');toast.setAttribute('role','status');toast.setAttribute('aria-live','polite');
const shell=el('div','shell',header,toolbar,tabs,content,footer,toast);app.append(shell);
function send(command:CommandBody,runId?:string){
 if(!port||(!connected&&command.type!=='ready')){notify(t('error_connection'));return;}
 const requestId=`sidebar-${++sequence}`;
 if(command.type==='start-audit')auditStartRequest=requestId;
 if(command.type==='select-node')pendingRun=runId?{requestId,runId,elementRef:command.referenceId}:null;
 else if(command.type==='start-picker'||command.type==='cancel-picker'||command.type==='refresh-selection')pendingRun=null;
 if(command.type==='show-node'||command.type==='select-node'){
  auditActionRequests.set(requestId,command.referenceId);if(auditActionRequests.size>100)auditActionRequests.delete(auditActionRequests.keys().next().value!);
 }
 try{port.postMessage({...command,requestId});}catch{notify(t('error_connection'));handleDisconnect(port);}
}
function notify(message:string){toast.textContent=message;if(toastTimer)clearTimeout(toastTimer);toastTimer=setTimeout(()=>{toast.textContent='';},4500);}
function applyTheme(){if(state.settings.appearance==='system')delete document.documentElement.dataset.theme;else document.documentElement.dataset.theme=state.settings.appearance;}
function invalidateCopy(){copySequence++;clipboardFallback=null;clipboardValidity=null;pendingDiagnostic=null;}
function navigate(tab:TabId){if(view!==tab||manualExplicit)invalidateCopy();scrolls[view]=content.scrollTop;manualExplicit=false;view=tab;activeTab=tab;if(tab!=='audit')lastElementTab=tab;confirmAction=null;pendingAnalyses=null;confirmAnalysis=null;render(true);}
function openSubview(next:'settings'|'export'){
 if(view!==next){pendingAnalyses=null;confirmAnalysis=null;}
 invalidateCopy();if(state.picker)send({type:'cancel-picker'});scrolls[view]=content.scrollTop;if(view!=='settings'&&view!=='export')previousView=activeTab;view=next;confirmAction=null;render(true);
}
function back(){navigate(previousView);}
function resetAnalysisView(){
 copySequence++;
 activeTab=view=previousView='audit';lastElementTab='contrast';filter='all';resultLimit=30;paletteLimit=24;selectedRunId=null;previewRunIndex=0;returnToAudit=false;
 simulation='original';simulationOpen=false;suggestionProperty='color';includePalette=false;pendingRun=null;confirmAction=null;clipboardFallback=null;clipboardValidity=null;
 exportSources={};exportResult=null;exportCache=null;exportPreview=null;saveRequest=null;exportInvalid=true;exportKind='element';exportFormat='css';exportScope='all';
 auditActionRequests.clear();auditActionErrors.clear();for(const key of Object.keys(scrolls))delete scrolls[key as View];content.scrollTop=0;
 inventorySelection=null;returnToInventory=false;manualExplicit=false;manualOrigin=null;openAuditGroups.clear();groupMemberLimits.clear();openFontVariants.clear();openPaletteActions.clear();pendingDiagnostic=null;
 missingReason='';fontFamilyLimit=12;fontSizeLimits.clear();fontVariantLimits.clear();
 comparisonOpen=false;comparisonLimit=30;comparisonFilter='all';comparisonCache=null;pendingAnalyses=null;confirmAnalysis=null;
 if(toastTimer)clearTimeout(toastTimer);toast.textContent='';
}
function canStartAudit(){return connected&&state.tabId!==null&&state.access!=='unsupported'&&!auditStarting&&!accessRequest;}
async function startAudit(){
 if(!canStartAudit())return;
 const scope=scanScope,referenceId=scope==='selection'?scanRoot():undefined;
 if(scope==='selection'&&!referenceId){notify(t('auditScopeSelectionHelp'));return;}
 const intended={expectedTabId:state.tabId!,expectedDocumentToken:state.documentToken,expectedRevision:state.documentRevision??0};const initialPort=port;
 if(state.access!=='ready'){
  const pending={};accessRequest=pending;
  try{
   // Call directly in the click handler: awaiting anything first loses Firefox's user gesture.
   const permission=browser.permissions.request({origins:['http://*/*','https://*/*']});render();
   const allowed=await permission;
   if(!allowed){notify(t('error_page_permission'));return;}
   if(!connected||port!==initialPort||state.tabId!==intended.expectedTabId||state.documentToken!==intended.expectedDocumentToken||(state.documentRevision??0)!==intended.expectedRevision||state.access==='unsupported'){notify(t('error_page_changed'));return;}
  }catch{notify(t('error_page_permission'));return;}
  finally{if(accessRequest===pending)accessRequest=null;render();}
 }
 // Keep the last result until the content script actually accepts the new
 // scan. A removed section or rejected start must not erase useful results.
 invalidateCopy();auditStarting=true;hasAudited=true;render();send({type:'start-audit',...intended,scope,...(referenceId?{referenceId}:{})});
}
function scanRoot(){return state.selected?.elementRef??(state.audit?.scope==='selection'?state.audit.rootElementRef:undefined);}
function scopeLabel(scope:ScanScope){return t(scope==='viewport'?'auditScopeViewport':scope==='selection'?'auditScopeSelection':'auditScopePage');}
function renderScanScope(){
 const root=scanRoot();if(scanScope==='selection'&&!root&&!auditStarting)scanScope='page';
 const field=selectField(t('auditScope'),[['page',scopeLabel('page')],['viewport',scopeLabel('viewport')],['selection',scopeLabel('selection'),!root]],scanScope,value=>{if(value==='page'||value==='viewport'||value==='selection'){scanScope=value;render();document.getElementById('audit-scope')?.focus({preventScroll:true});}});
 field.classList.add('audit-scope-control');const control=field.querySelector('select')!;control.id='audit-scope';field.querySelector('label')!.htmlFor=control.id;control.disabled=auditStarting||state.audit?.status==='running'||Boolean(accessRequest);
 field.append(small(t(scanScope==='selection'?'auditScopeSelectionInfo':scanScope==='viewport'?'auditScopeViewportInfo':'auditScopePageInfo')));
 if(!root)field.append(small(t('auditScopeSelectionHelp')));return field;
}
function auditRuntimeDetails(audit:Audit){
 const lines=[t('auditScopeMeasured',scopeLabel(audit.scope??'page'))];
 if(typeof audit.durationMs==='number'&&Number.isFinite(audit.durationMs))lines.push(t('auditDuration',number(Math.max(0,audit.durationMs)/1000,1)));
 if(audit.limits)lines.push(t('auditLimits',number(audit.limits.maxRuns,0),number(audit.limits.maxElements,0)));
 if(typeof audit.examined==='number')lines.push(t('auditExamined',number(audit.examined,0)));
 const limitNotice=audit.reachedLimits?.length?t('auditLimitsReached',audit.reachedLimits.map(limit=>t(limit==='text-runs'?'auditLimitRuns':limit==='elements'?'auditLimitElements':'auditLimitComplexity')).join(' · ')):null;
 return {lines,limitNotice};
}
function renderAuditRuntime(audit:Audit){
 const {lines,limitNotice}=auditRuntimeDetails(audit);
 return el('div','audit-runtime',...lines.map(small),limitNotice?notice(limitNotice,'warning'):null);
}
const comparisonLabels:Record<AuditChange['kind'],string>={new:'comparisonNew',resolved:'comparisonResolved',persistent:'comparisonPersistent',unassessed:'comparisonUnassessed'};
function renderAuditComparison(previous:Audit,current:Audit){
 const target=state.settings.contrastTarget;
 const details=el('details','card audit-diff',el('summary','',t('comparisonTitle')));
 details.open=comparisonOpen;
 const rows=el('div','audit-diff-content');details.append(rows);
 const populate=()=>{
  rows.replaceChildren();if(!details.open)return;
  if(comparisonCache?.previous!==previous||comparisonCache.current!==current||comparisonCache.target!==target)comparisonCache={previous,current,target,value:compareAudits(previous,current,target)};
  const result=comparisonCache.value;
  rows.append(small(t('comparisonTimes',date(previous.measuredAt),date(current.measuredAt))),small(t('comparisonScope',scopeLabel(current.scope??'page'),`${current.viewport.width} × ${current.viewport.height}`,target)));
  if(!result.comparable){rows.append(notice(t(`comparisonUnavailable_${result.reason.replaceAll('-','_')}`),'warning'));return;}
  rows.append(small(t('comparisonHelp')));
  const filters=el('div','filter-bar');filters.setAttribute('role','group');filters.setAttribute('aria-label',t('comparisonTitle'));
  for(const kind of ['all','new','resolved','persistent','unassessed']as const){
   const count=kind==='all'?result.changes.length:result.counts[kind];
   const action=button(`${t(kind==='all'?'all':comparisonLabels[kind])} (${number(count,0)})`,()=>{comparisonFilter=kind;comparisonLimit=30;populate();rows.querySelector<HTMLButtonElement>(`[data-change-filter="${kind}"]`)?.focus();});
   action.dataset.changeFilter=kind;action.setAttribute('aria-pressed',String(comparisonFilter===kind));filters.append(action);
  }
  rows.append(filters);
  const visible=result.changes.filter(change=>comparisonFilter==='all'||change.kind===comparisonFilter);
  if(!visible.length){rows.append(small(t('comparisonNoFindings')));return;}
  const beforeRuns=new Map(previous.runs.map(run=>[run.id,run])),afterRuns=new Map(current.runs.map(run=>[run.id,run]));
  const value=(measurement:AuditChange['before'],rule:AuditChange['ruleId'])=>{
   if(!measurement)return t('comparisonNotCaptured');
   const metric=rule==='text.contrast'?(measurement.ratio===null?t('ratioUnavailable'):`${ratioNumber(measurement.ratio,measurement.ratioKind==='minimum')} : 1${measurement.ratioKind==='minimum'?' · '+t('contrastMinimum'):''}`):measurement.sizeCssPx===null?t('fontUnknown'):`${number(measurement.sizeCssPx,3)} CSS px`;
   const status=rule==='text.font-size-min'&&measurement.status==='pass'?t('statusThresholdMet'):rule==='text.font-size-min'&&measurement.status==='fail'?t('findingSmallText'):statusText(measurement.status);
   return `${status} · ${metric}`;
  };
  for(const change of visible.slice(0,comparisonLimit)){
   const run=afterRuns.get(change.runId)??beforeRuns.get(change.runId);
   const item=el('article','audit-diff-item',el('strong','',t(comparisonLabels[change.kind])),el('p','',t(change.ruleId==='text.contrast'?'textContrast':'fontSize')),el('code','selector',run?.selector??run?.tagName??'—'),small(t('comparisonBefore',value(change.before,change.ruleId))),small(t('comparisonAfter',value(change.after,change.ruleId))));
   item.dataset.change=change.kind;
   if(change.after&&run){const inspect=button(t('actionInspect'),()=>inspectRun(run,change.ruleId==='text.font-size-min'?'typography':'contrast'),'small show-node','show');inspect.disabled=!connected||state.access!=='ready'||auditStarting;item.append(inspect);}
   rows.append(item);
  }
  if(visible.length>comparisonLimit){const more=button(t('actionMore',visible.length-comparisonLimit),()=>{const index=comparisonLimit;comparisonLimit+=30;populate();const item=rows.querySelectorAll<HTMLElement>('.audit-diff-item')[index];if(item){item.tabIndex=-1;item.focus();}},'small');rows.append(more);}
 };
 details.addEventListener('toggle',()=>{if(!details.isConnected)return;comparisonOpen=details.open;populate();});populate();return details;
}
function inventoryLimitNotice(audit:Audit,kind:'colors'|'fonts'){
 const limits=audit.inventoryLimits;if(!limits)return null;
 const relevant=limits.reached.filter(limit=>limit==='elements'||(kind==='colors'?limit==='colors':['font-families','font-sizes','font-variants'].includes(limit)));
 if(!relevant.length)return null;
 const labels:Record<string,[string,number]>={colors:['inventoryLimitColors',limits.maxColors],'font-families':['inventoryLimitFamilies',limits.maxFontFamilies],'font-sizes':['inventoryLimitSizes',limits.maxFontSizes],'font-variants':['inventoryLimitVariants',limits.maxFontVariants],elements:['inventoryLimitElements',limits.maxElements]};
 const text=relevant.map(limit=>{const[key,count]=labels[limit]!;return t(key,number(count,0));}).join(' · ');
 const node=notice(t('inventoryLimited',text),'warning');node.classList.add('inventory-limit');return node;
}
function currentSnapshot(){return state.preview??state.selected;}
function isManualContrast(){return view==='contrast'&&(manualExplicit||!currentSnapshot());}
function isPageOverview(){return (view==='colors'||view==='typography')&&!currentSnapshot();}
function currentRun(snapshot:Snapshot){return snapshot===state.preview?snapshot.textRuns[Math.min(previewRunIndex,snapshot.textRuns.length-1)]:selectedRunId===null?snapshot.textRuns[0]:snapshot.textRuns.find(run=>run.id===selectedRunId);}
function currentAudit(){
 const audit=state.audit;if(!audit)return null;const target=state.settings.contrastTarget;
 // Runtime messages provide immutable snapshots; reuse a target's assessment within that snapshot.
 let targets=auditAssessments.get(audit);if(!targets){targets={};auditAssessments.set(audit,targets);}return targets[target]??(targets[target]=reassessAudit(audit,target));
}
function measuredRun(run:TextRun){return evaluateRun(run,state.settings.contrastTarget);}
function colorText(value:ColorValue|RGBA|null){if(!value)return t('unknownColor');if('raw'in value)return value.rgba?formatDisplayColor(value.rgba,state.settings.colorFormat):value.raw;return formatDisplayColor(value,state.settings.colorFormat);}
function colorRoundingHint(value:ColorValue|RGBA|null,text:string){const rgba=value&&('raw'in value?value.rgba:value);return rgba&&text.startsWith('#')&&text!==formatColor(rgba,'hex')?t('colorRoundedHex',formatColor(rgba,'rgb')):'';}
function preview(foreground:RGBA|null,background:RGBA|null){const node=el('div','color-preview',t('previewText'));if(foreground&&background){node.style.color=formatColor(foreground,'rgb');node.style.backgroundColor=formatColor(background,'rgb');}else node.textContent=t('unknownColor');return node;}
function swatch(color:RGBA|string|null,compact=false){
 const rgba=typeof color==='string'?parseColor(color).rgba:color;
 const node=el('span',`swatch${compact?' swatch-small':''}${rgba?'':' swatch-unknown'}`);node.setAttribute('aria-hidden','true');
 const fill=el('span');if(rgba)fill.style.backgroundColor=formatColor(rgba,'rgb');else node.title=t('unknownColor');node.append(fill);return node;
}
function colorChip(value:ColorValue|RGBA|null,text=colorText(value),className=''){
 const rgba=value&&('raw'in value?value.rgba:value);
 const label=el('code',`color-value-text ${className}`.trim(),text);label.title=colorRoundingHint(value,text);
 return el('span','color-chip',swatch(rgba,true),label);
}
function colorDetail(label:string,value:ColorValue|RGBA|null){return el('div','color-detail',el('span','color-name',label),colorChip(value));}
function decorateHex(text:string){
 const fragment=document.createDocumentFragment();let start=0,decorated=0;
 // Build only text nodes and our own decorative spans; never interpret export text as markup.
 for(const match of text.matchAll(/(?<![\w#-])#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})(?![\w-])/gi)){
  if(decorated++>=256)break;
  fragment.append(text.slice(start,match.index),el('span','code-color',swatch(parseColor(match[0]).rgba,true),match[0]));start=match.index!+match[0].length;
 }
 fragment.append(text.slice(start));return fragment;
}
function render(resetScroll=false){
 if(pendingDiagnostic&&!pendingDiagnostic.valid())pendingDiagnostic=null;
 if(clipboardValidity&&!clipboardValidity()){copySequence++;clipboardFallback=null;clipboardValidity=null;}
 if(!isManualContrast())closeActiveColorPicker();
 const top=resetScroll?(scrolls[view]??0):content.scrollTop;
 const focused=content.contains(document.activeElement)?document.activeElement as HTMLElement:null,focusedId=focused?.id??'';
 const selection=focused instanceof HTMLInputElement&&focused.type==='text'?{start:focused.selectionStart,end:focused.selectionEnd,direction:focused.selectionDirection}:null;
 applyTheme();gear.setAttribute('aria-pressed',String(view==='settings'));picker.replaceChildren(icon(state.picker?'close':'picker'),state.picker?t('actionStopSelecting'):t('actionSelectElement'));
 picker.setAttribute('aria-pressed',String(state.picker));picker.disabled=view==='settings'||view==='export'||state.access!=='ready'||!connected;picker.title=!connected?t('actionsDisconnected'):picker.disabled?t('activationToolbar'):t(state.picker?'actionStopSelecting':'actionSelectElement');
 for(const[id,tab]of tabButtons){tab.setAttribute('aria-selected',String(activeTab===id));tab.tabIndex=activeTab===id?0:-1;}
 if(view==='settings'||view==='export'||view==='occurrences'){content.removeAttribute('aria-labelledby');content.setAttribute('aria-label',t(view==='settings'?'actionSettings':view==='export'?'exportTitle':'inventoryOccurrences'));}else{content.removeAttribute('aria-label');content.setAttribute('aria-labelledby',`tab-${activeTab}`);}
 const retainedManual=isManualContrast()&&manualPanel?.node.parentElement===content?manualPanel.node:null;
 if(retainedManual){for(const child of [...content.children])if(child!==retainedManual)child.remove();}else content.replaceChildren();
 if(!connected){const status=notice(t(reconnectAttempts>=reconnectDelays.length&&!reconnectTimer?'statusReconnectFailed':hasConnected?'statusReconnecting':'statusConnecting'),'warning');if(reconnectAttempts>=reconnectDelays.length&&!reconnectTimer)status.append(el('p','',button(t('actionReconnect'),()=>{reconnectAttempts=0;connectPort();})));content.insertBefore(status,retainedManual);}
 if(view==='settings')renderSettings();else if(view==='export')renderExport();else if(view==='occurrences')renderOccurrences();else{
  if(connected&&state.access!=='ready'&&!isManualContrast())content.append(notice(state.access==='unsupported'?t('unsupported'):view==='audit'?t('auditActivation',t(hasAudited?'actionRescan':'actionScanPage')):t(state.settings.contextMenuEnabled?'activation':'activationToolbar'),'warning'));
  if(state.error&&!isManualContrast())content.append(notice(t(`error_${state.error.replaceAll('-','_')}`),'error'));
  if(view==='audit')renderAudit();else renderElement(view);
 }
 if(clipboardFallback!==null){const fallback=el('textarea','clipboard-fallback');fallback.value=clipboardFallback;fallback.readOnly=true;fallback.rows=7;fallback.setAttribute('aria-label',t('clipboardFallback'));const panel=card(t('clipboardFallback'),small(t('clipboardFallbackHint')),fallback,button(t('actionClose'),()=>{clipboardFallback=null;render();},'small'));content.prepend(panel);}
 updateFooter();content.scrollTop=top;if(focusedId){const restore=document.getElementById(focusedId);if(restore!==document.activeElement)restore?.focus({preventScroll:true});if(selection&&restore instanceof HTMLInputElement&&selection.start!==null&&selection.end!==null)restore.setSelectionRange(selection.start,selection.end,selection.direction??undefined);}
}
function updateFooter(){
 if(view==='occurrences'){copy.disabled=true;exportButton.disabled=true;copy.title=exportButton.title=t('inventoryActionsHint');copy.setAttribute('aria-label',`${t('actionCopy')}: ${copy.title}`);exportButton.replaceChildren(icon('export'),t('actionExport'));return;}
 if(isManualContrast()){copy.disabled=!manualContrast(manualDraft.foreground,manualDraft.background,manualDraft.underlay);copy.title=t('manualCopyReport');copy.setAttribute('aria-label',`${t('actionCopy')}: ${copy.title}`);exportButton.disabled=true;exportButton.title=t('manualExportUnavailable');exportButton.replaceChildren(icon('export'),t('actionExport'));return;}
 const previewing=Boolean(state.preview)&&view!=='audit';const pageOverview=isPageOverview();const data=view==='audit'||pageOverview?Boolean(state.audit):Boolean(state.selected);
 const disabled=view==='settings'||previewing||!data||!connected;
 copy.disabled=view==='export'?!exportResult||exportInvalid||!connected:disabled;
 exportButton.disabled=view==='export'?!exportResult||exportInvalid||!connected||Boolean(saveRequest):disabled;
 exportButton.replaceChildren(icon(view==='export'?'save':'export'),t(view==='export'?'actionSave':'actionExport'));
 let description=view==='settings'?t('footerSettings'):previewing?t('footerPreview'):!data?t('footerNoData'):pageOverview?t('copyPageValues'):t(view==='audit'||view==='contrast'?'copyTextReport':'copyCss');
 if(view==='export')description=exportInvalid?t('exportInvalid'):t('copyExport');if(!connected)description=t('actionsDisconnected');copy.title=description;copy.setAttribute('aria-label',`${t('actionCopy')}: ${description}`);exportButton.title=!connected?description:disabled&&view!=='export'?description:t(view==='export'?'actionSave':'actionExport');
}
function auditMetric(title:string,description:string,counts:RuleCounts,font=false){
 const rows=el('div','metric-counts');
 for(const[status,count,key]of [
  ['pass',counts.pass,font?'statusThresholdMet':'statusPass'],
  ['fail',counts.fail,font?'auditBelowThreshold':'statusFail'],
  ['manual',counts.manual,font?'statusManualReview':'cssPageUnverified'],
  ['not-applicable',counts.notApplicable,'statusNotApplicable']
 ]as const){const mark=el('span','metric-count-symbol',icon(`status-${status}`));mark.setAttribute('aria-hidden','true');const row=el('div',`metric-count ${status}`,el('span','metric-count-label',mark,el('span','',t(key))),el('strong','metric-count-value',number(count,0)));row.dataset.status=status;rows.append(row);}
 const node=el('section','metric audit-metric',el('h3','metric-label',title),el('p','metric-description',description),rows,el('p','metric-total',t('auditRuleTotal',number(counts.assessed,0))));node.dataset.rule=font?'font-size':'contrast';return node;
}
function ratioNumber(ratio:number,minimum=false,digits=2){return(minimum?'≥ ':'')+number(minimum?Math.floor(ratio*10**digits)/10**digits:ratio,digits);}
function contrastValue(run:TextRun,compact=false){
 const result=run.contrast,sample=cssColorContrast(run),ratio=result.ratio??sample?.ratio??null;
 const minimum=result.ratioKind==='minimum';
 const value=el('div',`${compact?'audit-ratio':'ratio'}${ratio===null?' ratio-unavailable':''}`,ratio===null?t('ratioUnavailable'):ratioNumber(ratio,minimum),ratio===null?null:el('span','ratio-unit',' : 1'));
 if(ratio!==null)value.title=(sample?t('cssColorContrast')+' · ':'')+ratioNumber(ratio,minimum,8)+' : 1'+(minimum?' · '+t('contrastMinimum'):'');
 const node=el('div','contrast-value',sample?el('small','css-contrast-label',t('cssColorContrast')):null,value,sample?el('small','css-contrast-notice',t('cssColorContrastNotice')):null,minimum?small(t('contrastMinimum')):null,small(`${run.textSource==='placeholder'?t('placeholderText')+' · ':''}${t(result.category==='large'?'largeText':result.category==='normal'?'normalText':'unknownText')}`),sample?null:el('div','contrast-target',small(t('contrastValueTarget',result.target)),badge(result.status)));
 if(sample){node.dataset.source='css-colors';const comparison=sample[result.target];if(comparison){node.dataset.cssStatus=comparison.status;node.append(small(t('cssColorTarget',result.target)));}}
 node.dataset.status=result.status;node.dataset.target=result.target;return node;
}
function contrastAssessments(run:TextRun){
 const result=run.contrast,sample=cssColorContrast(run);
 if(sample){
  const rows=el('div','assessments css-assessments',el('h3','',t('cssColorsOnly')));rows.dataset.source='css-colors';
  if(sample.category==='unknown')rows.append(small(t('cssThresholdUnknown')));
  else for(const level of ['AA','AAA']as const){const comparison=sample[level];if(!comparison)continue;const status=el('span',`badge css-threshold ${comparison.status}`,t(comparison.status==='pass'?'cssThresholdReached':'cssThresholdBelow'));const row=el('div','assessment css-assessment',el('div','',t('cssThreshold',level),el('small','',`${number(comparison.threshold)} : 1`)),status);row.dataset.level=level;row.dataset.comparison=comparison.status;rows.append(row);}
  rows.append(el('div','notice warning css-page-unverified',el('strong','',t('cssPageUnverified')),run.contrast.reason?el('p','',reason(run.contrast.reason)):null));return rows;
 }
 const rows=el('div','assessments');
 for(const level of ['AA','AAA']as const){const value=result[level];const row=el('div','assessment',el('div','',`WCAG ${level}`,el('small','',t('threshold',number(value.threshold)+' : 1'))),badge(value.status));row.dataset.level=level;rows.append(row);}
 return rows;
}
function renderAudit(){
 const audit=currentAudit();
 if(!audit){const symbol=el('div','empty-symbol',icon('audit'));const action=button(t(hasAudited?'actionRescan':'actionScanPage'),startAudit,'primary',hasAudited?'refresh':'audit');action.disabled=!canStartAudit();content.append(el('section','card empty',symbol,el('h2','',t('emptyAuditTitle')),el('p','',t(accessRequest?'statusPagePermission':auditStarting?'statusStartingAudit':'emptyAudit')),renderScanScope(),action,small(t('emptyAuditHint'))));content.append(small(t('auditCaution')));return;}
 const running=audit.status==='running';const scanAction=button(t(running?'actionCancelScan':'actionRescan'),()=>{if(running)send({type:'cancel-audit'});else void startAudit();},running?'':'primary',running?'close':'refresh');scanAction.disabled=running?state.access!=='ready'||!connected:!canStartAudit();
 content.append(el('div','section-title',el('h2','',t('tabAudit')),scanAction));
 content.append(renderScanScope(),renderAuditRuntime(audit));
 if(auditStarting)content.append(notice(t('auditStartPreserve')));
 if(audit.stale)content.append(notice(t('statusStale'),'warning'));
 if(running){const progress=el('progress');progress.max=audit.total||1;progress.value=audit.scanned;progress.setAttribute('aria-label',t('statusScanning',audit.scanned,audit.total));content.append(el('div','card',small(t('statusScanning',audit.scanned,audit.total)),progress));}
 else if(audit.status!=='complete')content.append(notice(t(audit.status==='cancelled'?'statusCancelled':'statusPartial'),'warning'));
 content.append(el('div','metrics audit-overview',auditMetric(t('textContrast'),t('auditContrastDescription',state.settings.contrastTarget),audit.counts.contrast),auditMetric(t('fontSize'),t('auditFontDescription'),audit.counts.fontSize,true)));
 if(audit.counts.contrast.manual||audit.counts.fontSize.manual){const help=notice(t('manualHelp'));help.prepend(el('strong','',t('noticePrefix')),' ');content.append(help);}
 const scope=el('div','scope-grid');for(const[label,value]of [[t('scanned'),audit.scanned],[t('skipped'),audit.skipped],[t('checks'),audit.counts.checks],[t('findings'),audit.counts.findings],[t('affected'),audit.counts.affectedRuns],[t('total'),audit.total]])scope.append(el('div','',el('strong','',String(value)),el('span','',String(label))));
 const scopeDetails=el('details','card',el('summary','',t('scope')),scope,small(`${t('viewport')}: ${audit.viewport.width} × ${audit.viewport.height}`),small(`${t('measuredAt')}: ${date(audit.measuredAt)}`),small(t('auditScopeLabel')),small(t('auditCounts',audit.counts.contrast.pass,audit.counts.contrast.fail,audit.counts.contrast.manual,audit.counts.contrast.notApplicable)),small(t('auditFontCounts',audit.counts.fontSize.pass,audit.counts.fontSize.fail,audit.counts.fontSize.manual,audit.counts.fontSize.notApplicable)),small(t('limitations')));
 for(const item of audit.reasons)scopeDetails.append(small(reason(item)));content.append(scopeDetails);
 if(state.previousAudit)content.append(renderAuditComparison(state.previousAudit,audit));
 else if(!running)content.append(small(t('comparisonFirstAudit')));
 const filters=el('div','filter-bar');filters.setAttribute('role','group');filters.setAttribute('aria-label',t('findings'));
 const filterRuns:Record<Filter,TextRun[]>={all:audit.runs,contrast:[],small:[],manual:[],css:[]};
 for(const run of audit.runs){
  if(run.contrast.status==='fail')filterRuns.contrast.push(run);if(run.fontSize.status==='fail')filterRuns.small.push(run);
  // A CSS pair or an inconclusive gradient minimum still provides a value.
  // The no-values filter concerns contrast, independently of the font-size rule.
  if(cssColorContrast(run))filterRuns.css.push(run);
  else if(run.contrast.status==='manual'&&run.contrast.ratio===null)filterRuns.manual.push(run);
 }
 for(const[id,key]of [['all','all'],['contrast','filterContrast'],['small','filterSmall'],['manual','filterManual'],['css','filterCSSPairs']]as const){const count=number(filterRuns[id].length,0),control=button(`${t(key)} (${count})`,()=>{filter=id;resultLimit=30;render();});control.id=`audit-filter-${id}`;control.setAttribute('aria-pressed',String(filter===id));control.dataset.filter=id;if(id==='css')control.title=t('cssPairSubcount',count);filters.append(control);}content.append(filters);
 let rows=filterRuns[filter];
 if(filter==='manual'){
  const reasons=new Map<string,number>();for(const run of rows){const code=run.contrast.reason??'unknown';reasons.set(code,(reasons.get(code)??0)+1);}
  if(missingReason&&!reasons.has(missingReason))missingReason='';
  const options:Array<[string,string]>=[['',t('auditAllReasons',number(rows.length,0))],...[...reasons].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).map(([code,count]):[string,string]=>[code,`${reason(code)} (${number(count,0)})`])];
  const field=selectField(t('auditMissingReason'),options,missingReason,value=>{missingReason=value;resultLimit=30;render();document.getElementById('audit-missing-reason')?.focus({preventScroll:true});});field.querySelector('select')!.id='audit-missing-reason';field.querySelector('label')!.htmlFor='audit-missing-reason';
  if(missingReason){const total=rows.length;rows=rows.filter(run=>(run.contrast.reason??'unknown')===missingReason);field.append(small(t('auditReasonMatches',number(rows.length,0),number(total,0))));}content.append(field);
 }
 if(!rows.length)content.append(notice(t('noFindings')));
 const grouping=toggle(t('auditGroupResults'),t('auditGroupResultsHelp'),groupedAudit,value=>{groupedAudit=value;resultLimit=30;render();});const groupToggle=grouping.querySelector('input')!;groupToggle.id='audit-group-results';grouping.querySelector('label')!.htmlFor=groupToggle.id;content.append(grouping);
 const displayed=groupedAudit?groupAuditRuns(rows):rows.map(run=>({id:run.id,runs:[run],representative:run}));
 for(const group of displayed.slice(0,resultLimit)){
  const run=group.representative;
  if(groupedAudit&&group.runs.length>1){
   const details=el('details','card audit-group');details.dataset.groupId=group.id;details.open=openAuditGroups.has(group.id);
   const sample=cssColorContrast(run),ratio=run.contrast.ratio??sample?.ratio;const summary=el('summary','',t('auditGroupCount',number(group.runs.length,0)),el('span','audit-group-summary-status',ratio===null||ratio===undefined?t('ratioUnavailable'):`${sample?t('cssColorContrast')+' · ':''}${run.contrast.ratioKind==='minimum'?'≥ ':''}${number(run.contrast.ratioKind==='minimum'?Math.floor(ratio*100)/100:ratio)} : 1`));details.append(summary,contrastValue(run,true),contrastAssessments(run),fontStatus(run));
   if(run.contrast.reason&&!cssColorContrast(run))details.append(small(reason(run.contrast.reason)));
   if(run.viewportPartial)details.append(viewportPartialNote());
   const members=el('div','audit-group-members');
   const populate=()=>{members.replaceChildren();if(!details.open)return;const limit=groupMemberLimits.get(group.id)??30;for(const member of group.runs.slice(0,limit))members.append(occurrenceItem(member,running||auditStarting,false));if(group.runs.length>limit)members.append(button(t('actionMore',group.runs.length-limit),()=>{groupMemberLimits.set(group.id,limit+30);populate();},'list-more'));};
   details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open)openAuditGroups.add(group.id);else openAuditGroups.delete(group.id);populate();});details.append(members);populate();content.append(details);continue;
  }
  const info=el('div','finding-status',el('small','',t('textContrast')),contrastValue(run,true),contrastAssessments(run),el('div','row',el('small','',t('fontSize')),badge(run.fontSize.status,true)),small(run.fontSizeCssPx===null?t('fontUnknown'):`${number(run.fontSizeCssPx,5)} CSS px · ${t('threshold','12 CSS px')}`));
  if(run.contrast.reason&&!cssColorContrast(run))info.append(small(reason(run.contrast.reason)));
  if(run.viewportPartial)info.append(viewportPartialNote());
  const expired=auditActionErrors.get(run.elementRef);const unavailable=!connected?t('actionsDisconnected'):state.access!=='ready'?t('auditActionsActivation'):running||auditStarting?t('auditActionsRunning'):expired;
  const show=button(t('actionShow'),()=>send({type:'show-node',referenceId:run.elementRef}),'small show-node','show');show.disabled=Boolean(unavailable);show.title=unavailable??t('actionShowHint',run.selector);
  const inspect=button(t('actionInspect'),()=>inspectRun(run,run.fontSize.status==='fail'&&run.contrast.status!=='fail'?'typography':'contrast'),'small');inspect.disabled=Boolean(unavailable);if(unavailable)inspect.title=unavailable;
  const actions=el('div','actions',show,inspect);
  if(state.settings.showDiagnostics&&run.contrast.status==='manual')actions.append(diagnosticButton(run,{kind:'audit',id:audit.id}));
  if(run.contrast.status==='fail'&&run.textSource!=='placeholder'){const suggestions=button(t('actionSuggestions'),()=>inspectRun(run,'contrast'),'small');suggestions.disabled=inspect.disabled;actions.append(suggestions);}
  const finding=el('article','card finding',el('span','tag',`<${run.tagName}>`),el('code','selector',run.selector),info,actions);finding.dataset.reference=run.elementRef;if(unavailable)finding.append(el('p','finding-actions-help',unavailable));content.append(finding);
 }
 if(displayed.length>resultLimit)content.append(button(t('actionMore',displayed.length-resultLimit),()=>{resultLimit+=30;render();},'list-more'));
 content.append(renderPalette(audit),renderFonts(audit),renderSimulation(null,audit));content.append(small(t('auditCaution')));
}
function inspectRun(run:TextRun,tab:'contrast'|'typography'){scrolls[view]=content.scrollTop;returnToInventory=view==='occurrences';returnToAudit=!returnToInventory;manualExplicit=false;send({type:'select-node',referenceId:run.elementRef,tab},run.id);}
function occurrences(refs:string[]|undefined,label:string,prefer?:((run:TextRun)=>boolean)){
 if(!refs?.length||!state.audit)return;invalidateCopy();inventorySelection={auditId:state.audit.id,measuredAt:state.audit.measuredAt,refs:[...refs],label,origin:activeTab,scroll:content.scrollTop,limit:30,...(prefer?{prefer}:{})};scrolls.occurrences=0;view='occurrences';returnToInventory=false;render(true);
}
function inventoryMatches(refs:string[]|undefined,label:string,prefer?:((run:TextRun)=>boolean)){
 const control=button(t('inventoryShowOccurrences'),()=>occurrences(refs,label,prefer),'small inventory-matches','show');control.disabled=!refs?.length;control.title=control.disabled?t('inventoryRefreshHint'):t('inventoryShowOccurrencesFor',label);return control;
}
function occurrenceItem(run:TextRun,running=false,inventory=true){
 const unavailable=!connected?t('actionsDisconnected'):state.access!=='ready'?t('auditActionsActivation'):running?t('auditActionsRunning'):auditActionErrors.get(run.elementRef);
 const show=button(t('actionShow'),()=>send({type:'show-node',referenceId:run.elementRef}),'small show-node','show');show.disabled=Boolean(unavailable);show.title=unavailable??t('actionShowHint',run.selector);
 const inspect=button(t('actionInspect'),()=>inspectRun(run,inventory&&inventorySelection?.origin==='typography'?'typography':'contrast'),'small');inspect.disabled=Boolean(unavailable);if(unavailable)inspect.title=unavailable;
 const item=el('article','occurrence-item',el('span','tag',`<${run.tagName}>`),el('code','selector',run.selector));item.dataset.reference=run.elementRef;
 if(run.textExcerpt?.value)item.append(el('p','occurrence-excerpt',run.textExcerpt.value));
 const actions=el('div','actions',show,inspect);if(state.settings.showDiagnostics&&run.contrast.status==='manual'&&state.audit)actions.append(diagnosticButton(run,{kind:'audit',id:state.audit.id}));item.append(actions);if(unavailable)item.append(small(unavailable));return item;
}
function diagnosticButton(run:TextRun,source:{kind:'audit'|'selection';id:string}){
 const control=button(t('actionCopyDiagnostic'),()=>requestDiagnostic(run,source),'small diagnostic-copy','copy');
 control.disabled=!connected||state.access!=='ready'||state.picker||state.audit?.status==='running'||Boolean(pendingDiagnostic)||!state.documentToken;control.title=t('diagnosticPrivacy');return control;
}
function requestDiagnostic(run:TextRun,source:{kind:'audit'|'selection';id:string}){
 if(!state.settings.showDiagnostics||!connected||!port||state.tabId===null||!state.documentToken||state.picker||state.audit?.status==='running')return;
 invalidateCopy();const initialState=state,expectedTabId=state.tabId,expectedDocumentToken=state.documentToken,expectedRevision=state.documentRevision,initialView=view,initialFilter=filter,initialPort=port;
 const sourceRun=()=>source.kind==='audit'?state.audit?.runs.find(item=>item.id===run.id&&item.elementRef===run.elementRef):state.selected?currentRun(state.selected):undefined;
 const measured=JSON.stringify(sourceRun());
 const valid=()=>state.settings.showDiagnostics&&connected&&port===initialPort&&state===initialState&&state.tabId===expectedTabId&&state.documentToken===expectedDocumentToken&&state.documentRevision===expectedRevision&&view===initialView&&!state.picker&&JSON.stringify(sourceRun())===measured&&(source.kind==='audit'?state.audit?.id===source.id&&filter===initialFilter:state.selected?.id===source.id&&!state.preview&&currentRun(state.selected)?.id===run.id);
 const requestId=`diagnostic-${++sequence}`;pendingDiagnostic={requestId,valid};diagnosticRequests.add(requestId);if(diagnosticRequests.size>64)diagnosticRequests.delete(diagnosticRequests.values().next().value!);
 try{port.postMessage({type:'diagnose-node',requestId,referenceId:run.elementRef,runId:run.id,source,expectedTabId,expectedDocumentToken,expectedRevision});render();}catch{pendingDiagnostic=null;handleDisconnect(port);}
}
function renderOccurrences(){
 const selection=inventorySelection,audit=currentAudit();
 const goBack=()=>{if(!selection){navigate(activeTab);return;}view=activeTab=selection.origin;scrolls[view]=selection.scroll;render(true);};
 content.append(el('div','section-title',el('h2','',t('inventoryOccurrences')),button(t('actionBack'),goBack,'back','back')));
 if(!selection||!audit||audit.id!==selection.auditId||audit.measuredAt!==selection.measuredAt){content.append(notice(t('inventoryRefreshHint'),'warning'));return;}
 const runs=getInventoryRuns(audit,selection.refs,selection.prefer);const list=el('section','card inventory-occurrences',el('h3','',selection.label),small(t('inventoryOccurrenceCount',number(runs.length,0))));
 if(audit.stale)list.append(notice(t('statusStale'),'warning'));
 for(const run of runs.slice(0,selection.limit))list.append(occurrenceItem(run,audit.status==='running'));
 if(!runs.length)list.append(small(t('inventoryRefreshHint')));
 if(runs.length>selection.limit)list.append(button(t('actionMore',runs.length-selection.limit),()=>{selection.limit+=30;render();},'list-more'));
 content.append(list);
}
function renderManualContrast(){
 if(manualExplicit&&manualOrigin){const back=button(t('manualReturnPalette'),()=>{const origin=manualOrigin!;invalidateCopy();manualExplicit=false;view=origin.view;activeTab=origin.tab;scrolls[view]=origin.scroll;render(true);},'back manual-return','back');content.insertBefore(back,manualPanel?.node.parentElement===content?manualPanel.node:null);}
 if(!manualPanel){
  const node=el('section','card manual-contrast',el('h2','',t('manualContrastTitle')),small(t('manualContrastScope')));
  const fields={} as Record<'foreground'|'background'|'underlay',{text:HTMLInputElement;picker:ColorPicker;error:HTMLElement;container:HTMLElement}>;
  const result=el('div','manual-contrast-result');result.id='manual-results';result.setAttribute('aria-live','polite');
  const changed=()=>{copySequence++;if(clipboardFallback!==null){clipboardFallback=null;content.querySelector('.clipboard-fallback')?.closest('.card')?.remove();}manualPanel!.update();updateFooter();};
  for(const side of ['foreground','background','underlay']as const){
   const text=el('input');text.type='text';text.id=`manual-${side}-hex`;text.value=manualDraft[side];text.maxLength=128;text.autocomplete='off';text.spellcheck=false;text.setAttribute('autocapitalize','characters');
   const colorLabel=t(side==='foreground'?'foreground':side==='background'?'manualBackground':'manualUnderlay');
   const label=el('label','',colorLabel);label.htmlFor=text.id;
   const picker=createColorPicker(side,colorLabel,hex=>{if(manualPanel?.node!==node)return;manualDraft[side]=hex;changed();});
   const hint=el('small','',t(side==='underlay'?'manualUnderlayHelp':'manualHexHint'));hint.id=`manual-${side}-hint`;
   const error=el('p','manual-color-error',t('manualHexError'));error.id=`manual-${side}-error`;error.setAttribute('role','status');error.hidden=true;
   text.setAttribute('aria-describedby',`${hint.id} ${error.id}`);
   text.addEventListener('input',()=>{if(manualPanel?.node!==node)return;manualDraft[side]=text.value;changed();});
   text.addEventListener('blur',()=>{if(manualPanel?.node!==node)return;const parsed=parseManualColor(text.value);if(parsed){manualDraft[side]=parsed.value;manualPanel.update();}});
   const container=el('div','manual-color-field',label,el('div','manual-color-inputs',text,picker.button),hint,error,picker.panel);fields[side]={text,picker,error,container};node.append(container);
  }
  node.append(small(t('manualPickerOpaque')));
  node.append(result);
  manualPanel={node,update:()=>{
   const background=parseManualColor(manualDraft.background),needsUnderlay=Boolean(background&&background.rgba.a<1);fields.underlay.container.hidden=!needsUnderlay;
   for(const side of ['foreground','background','underlay']as const){const field=fields[side],parsed=parseManualColor(manualDraft[side]),valid=Boolean(parsed&&(side!=='underlay'||parsed.rgba.a===1));if(field.text.value!==manualDraft[side])field.text.value=manualDraft[side];field.text.setAttribute('aria-invalid',String(!valid));field.error.hidden=valid||side==='underlay'&&!needsUnderlay;if(parsed)field.picker.setColor(parsed.hex);}
   const pair=manualContrast(manualDraft.foreground,manualDraft.background,manualDraft.underlay);result.replaceChildren();if(!pair)return;
   const value=el('div','ratio manual-ratio',number(pair.normal.ratio!),el('span','ratio-unit',' : 1'));value.title=number(pair.normal.ratio!,8)+' : 1';
   const numeric=el('div','contrast-value',value,small(`${t('normalText')} · ${t('contrastValueTarget',state.settings.contrastTarget)}`));numeric.dataset.status=pair.normal[state.settings.contrastTarget].status;numeric.dataset.target=state.settings.contrastTarget;result.append(numeric);
   const sample=preview(pair.foreground.rgba,pair.effectiveBackground);sample.classList.add('manual-preview');result.append(sample);if(pair.underlay)result.append(colorDetail(t('effectiveBackground'),pair.effectiveBackground));
   for(const category of ['normal','large']as const){const assessment=pair[category],group=el('section','manual-category',el('h3','',t(category==='normal'?'normalText':'largeText')));group.dataset.category=category;
    if(category==='large')group.append(small(t('manualLargeTextHelp')));
    for(const level of ['AA','AAA']as const){const outcome=assessment[level],row=el('div','assessment',el('div','',`WCAG ${level}`,el('small','',t('threshold',number(outcome.threshold)+' : 1'))),badge(outcome.status));row.dataset.level=level;group.append(row);}result.append(group);
   }
  }};
 }
 manualPanel.update();if(manualPanel.node.parentElement!==content)content.append(manualPanel.node);
}
function renderElement(tab:Exclude<TabId,'audit'>){
 if(isManualContrast()){renderManualContrast();return;}
 const snapshot=currentSnapshot();if(!snapshot){if(tab==='contrast')renderManualContrast();else if(tab==='colors'||tab==='typography')renderPageOverview(tab);else content.append(el('section','card empty',el('div','empty-symbol',icon('picker')),el('h2','',t('emptySelectionTitle')),el('p','',t('emptySelection'))));return;}
 if(returnToInventory&&inventorySelection)content.append(button(t('inventoryReturnOccurrences'),()=>{returnToInventory=false;view='occurrences';activeTab=inventorySelection!.origin;render(true);},'back','back'));
 if(returnToAudit)content.append(button(t('actionReturnAudit'),()=>{returnToAudit=false;navigate('audit');},'back','back'));
 const selection=el('section','card selected-card',el('div','selected-label',t(state.preview?'statusPreview':'statusSelected')),el('div','tag',`<${snapshot.tagName}>`),el('code','selector',snapshot.selector));content.append(selection);
 if(snapshot.stale){const refresh=button(t('actionRefresh'),()=>send({type:'refresh-selection'}),'small','refresh');refresh.disabled=state.access!=='ready'||!connected;content.append(el('div','notice warning',t('statusStale'),el('p','',refresh)));}
 const run=currentRun(snapshot),missing=!state.preview&&selectedRunId!==null&&!run;
 if(snapshot.textRuns.length>1||missing&&snapshot.textRuns.length){
  const options:Array<[string,string,boolean?]>=snapshot.textRuns.map((item,index)=>[String(index),`${t('textAreas',index+1,snapshot.textRuns.length)} · ${item.tagName}`]);
  if(missing)options.unshift(['-1',t('textAreaUnavailable'),true]);
  content.append(small(t('mixedText',snapshot.textRuns.length)),selectField(t('textContrast'),options,String(run?snapshot.textRuns.indexOf(run):-1),value=>{const index=Number(value);if(!snapshot.textRuns[index])return;if(state.preview)previewRunIndex=index;else selectedRunId=snapshot.textRuns[index]!.id;simulation='original';render();}));
 }
 if(missing)content.append(notice(t('textAreaUnavailable'),'warning'));
 if(tab==='contrast'){if(!missing)renderContrast(snapshot,run);}else if(tab==='colors')renderColors(snapshot,run);else if(tab==='typography')renderTypography(snapshot,run);else renderLayout(snapshot);
 if(snapshot.reasons.length)content.append(el('details','card',el('summary','',t('reasonLabel')),...snapshot.reasons.map(item=>small(reason(item)))));
 if(!state.preview)renderElementText(snapshot,tab,run);
}
function renderElementText(snapshot:Snapshot,tab:Exclude<TabId,'audit'>,run:TextRun|undefined){
 const excerpt=tab==='contrast'?run?.textExcerpt:snapshot.textExcerpt;
 const node=card(t('elementTextTitle'));node.classList.add('element-text-card');node.dataset.scope=tab==='contrast'?'run':'element';
 if(!excerpt?.value){node.append(small(t('textExcerptUnavailable')));content.append(node);return;}
 const value=el('textarea','element-text-value');value.value=excerpt.value;value.readOnly=true;value.rows=4;value.dir='auto';value.spellcheck=false;value.setAttribute('aria-label',t(tab==='contrast'?'textAreaContent':'elementTextTitle'));
 const context={tabId:state.tabId,documentToken:state.documentToken,documentRevision:state.documentRevision};
 const current=()=>{
  if(!connected||state.preview||view!==tab||state.selected?.id!==snapshot.id||state.tabId!==context.tabId||state.documentToken!==context.documentToken||state.documentRevision!==context.documentRevision)return false;
  const active=tab==='contrast'?currentRun(state.selected):undefined;
  const latest=tab==='contrast'?active?.textExcerpt:state.selected.textExcerpt;
  return (tab!=='contrast'||active?.id===run?.id)&&latest?.value===excerpt.value&&latest.truncated===excerpt.truncated;
 };
 const copyTextButton=button(t('actionCopyText'),()=>void copyText(excerpt.value,false,current),'small copy-element-text','copy');copyTextButton.disabled=!connected;
 node.append(value);if(excerpt.truncated)node.append(small(t('textExcerptTruncated')));node.append(copyTextButton);content.append(node);
}
function fontStatus(run:TextRun){const result=run.fontSize;return el('div','stack',badge(result.status,true),small(result.fontSizeCssPx===null?t('fontUnknown'):result.status==='fail'?t('fontWarning',number(result.fontSizeCssPx,5)):`${number(result.fontSizeCssPx,5)} CSS px`),result.status==='fail'?small(t('fontRecommendation')):null,small(t('fontHeuristic')));}
function renderContrast(snapshot:Snapshot,rawRun:TextRun|undefined){
 if(!rawRun){content.append(notice(t('noText')));return;}const run=measuredRun(rawRun);const result=run.contrast;
 const summary=card(t('textContrast'),contrastValue(run),contrastAssessments(run));
 if(state.settings.showDiagnostics&&!state.preview)summary.append(diagnosticButton(rawRun,{kind:'selection',id:snapshot.id}));
 if(result.reason&&!cssColorContrast(run))summary.append(notice(reason(result.reason),'warning'));content.append(summary);
 if(!state.preview)renderMeasurementComparison(snapshot,run);
 content.append(card(t('fontSize'),fontStatus(run),button(t('actionTypography'),()=>navigate('typography'),'small')));
 const hasColorPair=Boolean(run.foreground.rgba&&run.effectiveBackground),cssOnly=result.status==='manual'&&result.ratio===null&&hasColorPair&&!run.backgroundRange;
 const colors=card(t(cssOnly?'previewCSS':'previewColor'),cssOnly?notice(t('previewCSSNotice')):null,run.backgroundRange?null:hasColorPair?preview(run.foreground.rgba,run.effectiveBackground):notice(t('previewUnavailable')),colorDetail(t('foreground'),run.foreground),run.backgroundRange?small(t('gradientBackground')):colorDetail(t(cssOnly?'previewCSSBackground':'effectiveBackground'),run.effectiveBackground),small(`font-size: ${run.fontSizeCssPx??'—'}px · font-weight: ${run.fontWeight??'—'}`));content.append(colors);
 if(!state.preview&&result.status==='fail'){if(run.textSource==='placeholder')content.append(card(t('suggestions'),small(t('placeholderSuggestionsUnavailable'))));else renderSuggestions(snapshot,run);}else if(!state.preview&&result.status==='manual')content.append(card(t('suggestions'),small(t('noSuggestion')),cssColorContrast(run)?null:small(reason(result.reason))));
 content.append(renderSimulation(run,null));
}
function renderMeasurementComparison(snapshot:Snapshot,selected:TextRun){
 const audit=currentAudit();if(!audit||audit.status==='running'||snapshot.measuredAt===audit.measuredAt)return;
 if((['windowId','tabId','frameId','documentToken']as const).some(key=>snapshot.document[key]!==audit.document[key]))return;
 const previous=audit.runs.find(run=>run.id===selected.id&&run.elementRef===selected.elementRef);if(!previous)return;
 const signature=(run:TextRun)=>JSON.stringify([run.contrast.status,run.contrast.ratio,run.contrast.ratioKind,run.contrast.reason,cssColorContrast(run)?.ratio,run.contrast.AA.status,run.contrast.AAA.status,run.fontSizeCssPx,run.fontSize.status]);
 const changed=signature(previous)!==signature(selected);
 const details=el('details','card measurement-comparison',el('summary','',t(changed?'auditComparisonChanged':'auditComparisonTitle')));details.dataset.changed=String(changed);
 const rows=el('div','measurement-comparison-grid');
 for(const [kind,label,item,stamp,stale]of [['audit','auditComparisonOriginal',previous,audit.measuredAt,audit.stale],['selection','auditComparisonSelection',selected,snapshot.measuredAt,snapshot.stale]]as const){
  const css=cssColorContrast(item),ratio=item.contrast.ratio??css?.ratio??null,minimum=item.contrast.ratioKind==='minimum';
  const value=ratio===null?t('ratioUnavailable'):`${minimum?'≥ ':''}${number(minimum?Math.floor(ratio*100)/100:ratio)} : 1`;
  const section=el('section','measurement-comparison-item',el('h3','',t(label)),small(measurementDateFormat.format(new Date(stamp))),small(t(css?'cssColorContrast':'textContrast')),el('strong','comparison-ratio',value),small(css?t('cssPageUnverified'):statusText(item.contrast.status)),small(`${t('fontSize')}: ${item.fontSizeCssPx===null?t('fontUnknown'):number(item.fontSizeCssPx,3)+' CSS px'}`));
  section.dataset.measurement=kind;section.dataset.source=css?'css-colors':'page';section.dataset.status=item.contrast.status;
  if(item.contrast.reason)section.append(small(reason(item.contrast.reason)));if(stale)section.append(small(t('statusStale')));rows.append(section);
 }
 details.append(rows);if(previous.viewportPartial)details.append(viewportPartialNote());details.append(small(t('auditComparisonHelp')));content.append(details);
}
function renderSuggestions(snapshot:Snapshot,run:TextRun){
 const node=card(t('suggestions'),small(t('suggestionIntro')));
 if(snapshot.stale){node.append(notice(t('statusStale'),'warning'));content.append(node);return;}
 if(suggestionProperty==='background-color'&&!run.ownOpaqueBackground)suggestionProperty='color';
 node.append(selectField(t('suggestions'),[['color',t('changeText')],['background-color',t('changeBackground'),!run.ownOpaqueBackground]],suggestionProperty,value=>{suggestionProperty=value as 'color'|'background-color';render();}));
 if(!run.ownOpaqueBackground)node.append(small(t('backgroundUnavailable')));
 const audit=currentAudit();if(audit&&!audit.stale&&audit.palette.length)node.append(toggle(t('pagePaletteOption'),t('paletteSource'),includePalette,value=>{includePalette=value;render();}));
 const output=suggestContrast(snapshot,run,state.settings.contrastTarget,suggestionProperty,includePalette&&!audit?.stale?audit?.palette??[]:[]);
 if(!output.suggestions.length){node.append(notice(t('noCandidate'),'warning'));if(output.reason)node.append(small(reason(output.reason)));}
 for(const suggestion of output.suggestions){
  const colors=el('div','suggestion-colors');
  const original=suggestion.property==='color'?suggestion.foreground:suggestion.background;
  for(const [side,color,key]of [['before',original,'before'],['after',suggestion.color,'suggestion']]as const){
   const value=formatColor(color,'hex');const copyColor=button('',()=>void copyText(value),'icon-button','copy');
   copyColor.title=t('actionCopyValue',value);copyColor.setAttribute('aria-label',copyColor.title);
   const tile=el('div','suggestion-color',el('div','suggestion-color-label',t(key)),el('div','suggestion-color-value',colorChip(color,value,'suggestion-hex'),copyColor));tile.dataset.side=side;colors.append(tile);
  }
  const ratios=el('p','suggestion-ratios');
  for(const [index,value]of [suggestion.beforeRatio,suggestion.afterRatio].entries()){const part=el('span','contrast-number',`${number(value)} : 1`);part.dataset.status=value>=suggestion.threshold?'pass':'fail';part.title=t(index===0?'before':'suggestion');if(index)ratios.append(' → ');ratios.append(part);}
  const item=el('article','card suggestion-card',el('h3','',t(suggestion.property==='color'?'changeText':'changeBackground')),colors,ratios,el('span','badge pass',`✓ ${t('targetMet',suggestion.target)}`));
  item.append(el('div','compare',el('div','',el('div','preview-label',t('before')),preview(run.foreground.rgba,run.effectiveBackground)),el('div','',el('div','preview-label',t('suggestion')),preview(suggestion.property==='color'?suggestion.color:suggestion.foreground,suggestion.property==='background-color'?suggestion.color:suggestion.background))));
  if(suggestion.conditions.includes('text-fill-reset-to-currentcolor'))item.append(small(t('suggestionTextFillReset')));
  if(suggestion.source==='page-palette')item.append(small(t('paletteSource')));
  item.append(el('div','actions',button(t('actionExportSuggestion'),()=>openExport(suggestion),'small')));node.append(item);
 }
 node.append(small(t('suggestionScope')));content.append(node);
}
function renderSimulation(run:TextRun|null,audit:Audit|null){
 const details=el('details','card',el('summary','',t('simulation')));details.open=simulationOpen;details.addEventListener('toggle',()=>{if(details.isConnected)simulationOpen=details.open;});
 const modes:SimulationMode[]=['original','protanopia','deuteranopia','tritanopia','grayscale'];
 details.append(selectField(t('simulationMode'),modes.map(mode=>[mode,t(`mode${mode[0]!.toUpperCase()}${mode.slice(1)}`)]),simulation,value=>{simulation=value as SimulationMode;simulationOpen=true;render();}),small(t(`simulation${simulation[0]!.toUpperCase()}${simulation.slice(1)}`)));
 if(run){
  const foreground=run.foreground.rgba,background=run.effectiveBackground;
  if(foreground&&background&&foreground.a===1&&background.a===1&&run.contrast.ratio!==null){details.append(el('div','compare',el('div','',el('div','preview-label',t('originalMeasurement')),preview(foreground,background)),el('div','',el('div','preview-label',t('simulatedPreview')),preview(simulateColor(foreground,simulation),simulateColor(background,simulation)))));}else details.append(notice(t(run.backgroundRange?'gradientBackground':'unknownColor'),run.backgroundRange?'':'warning'));
 }else if(audit){
  const palette=el('div','palette simulation-palette');for(const color of audit.palette.slice(0,paletteLimit)){const item=el('div','palette-item',el('div','preview-label',t('modeOriginal')),swatch(color.rgba),colorChip(color),el('div','preview-label',t('simulatedPreview')),swatch(color.rgba&&color.rgba.a===1?simulateColor(color.rgba,simulation):null));palette.append(item);}details.append(palette);if(audit.palette.length>paletteLimit)details.append(button(t('actionMore',audit.palette.length-paletteLimit),()=>{paletteLimit+=24;render();},'list-more'));
 }
 details.append(el('p','simulation-explanation',t('simulationNotice')),el('p','simulation-explanation',t('useOfColor')));return details;
}
function renderColors(snapshot:Snapshot,run:TextRun|undefined){
 const node=card(t('tabColors'));for(const[property,value]of Object.entries(snapshot.styles.colors))node.append(colorRow(property,parseColor(value)));
 if(run?.effectiveBackground)node.append(colorRow(t('effectiveBackground'),{raw:formatColor(run.effectiveBackground,'rgb'),rgba:run.effectiveBackground}));
 if(run?.backgroundRange)node.append(small(t('gradientBackground')));
 node.append(small(t('alphaNote')),small(t('generatedNames')));content.append(node);renderPageOverview('colors');
}
function renderPageOverview(tab:'colors'|'typography'){
 const audit=currentAudit();
 if(!audit){
  const action=button(t(hasAudited?'actionRescan':'actionScanPage'),startAudit,'primary',hasAudited?'refresh':'audit');action.disabled=!canStartAudit();
  const empty=card(t('pageOverview'),small(t('noPalette')),renderScanScope(),action);empty.classList.add('page-overview');empty.dataset.view=tab;empty.dataset.status='empty';content.append(empty);return;
 }
 const running=audit.status==='running';const action=button(t(running?'actionCancelScan':'actionRescan'),()=>{if(running)send({type:'cancel-audit'});else void startAudit();},running?'':'primary',running?'close':'refresh');action.disabled=running?state.access!=='ready'||!connected:!canStartAudit();
 const summary=el('section','card page-overview',el('div','section-title',el('h2','',t('pageOverview')),action),small(t('pageValuesScope')),small(`${t('measuredAt')}: ${date(audit.measuredAt)}`),small(`${t('scanned')}: ${number(audit.scanned,0)}`));summary.dataset.view=tab;summary.dataset.status=audit.status;summary.dataset.stale=String(audit.stale);
 summary.append(renderScanScope(),renderAuditRuntime(audit));
 if(audit.stale)summary.append(notice(t('statusStale'),'warning'));
 if(running){const progress=el('progress');progress.max=audit.total||1;progress.value=audit.scanned;progress.setAttribute('aria-label',t('statusScanning',audit.scanned,audit.total));summary.append(small(t('statusScanning',audit.scanned,audit.total)),progress);}
 else if(audit.status!=='complete')summary.append(notice(t(audit.status==='cancelled'?'statusCancelled':'statusPartial'),'warning'));
 const scope=el('details','',el('summary','',t('scope')),small(`${t('viewport')}: ${audit.viewport.width} × ${audit.viewport.height}`),small(t('auditScopeLabel')),small(t('limitations')),...audit.reasons.map(item=>small(reason(item))));summary.append(scope);
 content.append(summary,tab==='colors'?renderPalette(audit):renderFonts(audit));
}
function colorRow(label:string,color:ColorValue){const copyValue=button('',()=>void copyText(colorText(color)),'icon-button','copy');copyValue.title=t('actionCopyValue',label);copyValue.setAttribute('aria-label',t('actionCopyValue',label));copyValue.disabled=Boolean(state.preview);return el('div','color-row',el('div','color-row-value',el('div','color-name',label),colorChip(color),color.rgba?null:small(t('unknownColor'))),copyValue);}
const paletteRoles:PaletteRole[]=['background','text','accent','other'];
const paletteRoleKeys:Record<PaletteRole,string>={background:'paletteRoleBackground',text:'paletteRoleText',accent:'paletteRoleAccent',other:'paletteRoleOther'};
function inventoryFrequency(count:number){
 const frequency=el('span','inventory-frequency',t('inventoryFrequency',number(count,0)));
 frequency.title=t('inventoryElementCount',number(count,0));frequency.setAttribute('aria-label',frequency.title);return frequency;
}
function paletteItem(entry:PaletteUsage){
 const color=entry.color,value=colorText(color),copyColor=button('',()=>void copyText(value),'icon-button','copy');
 copyColor.title=t('actionCopyValue',value);copyColor.setAttribute('aria-label',copyColor.title);
 const label=el('span','palette-value',value);label.title=colorRoundingHint(color,value);
 const item=el('div','palette-item',swatch(color.rgba??color.raw),label,copyColor);item.dataset.role=primaryPaletteRole(entry);
 if(entry.count>0){
  const roles=paletteRoles.filter(role=>(entry.roles[role]??0)>0).map(role=>t(paletteRoleKeys[role]));
  item.append(el('div','palette-usage',inventoryFrequency(entry.count),el('div','palette-roles muted',roles.join(' · '))));
 }
 const same=(candidate:ColorValue|RGBA|null)=>{if(!candidate)return false;const rgba='raw'in candidate?candidate.rgba:candidate;return color.rgba&&rgba?(['r','g','b','a']as const).every(channel=>rgba[channel]===color.rgba![channel]):!color.rgba&&!rgba&&'raw'in candidate&&candidate.raw===color.raw;};
 const actions=el('details','palette-actions',el('summary','',t('inventoryColorActions')),inventoryMatches(entry.elementRefs,value,run=>same(run.foreground)||same(run.background)||same(run.effectiveBackground)));
 const actionKey=color.rgba?formatColor(color.rgba,'rgb'):color.raw;actions.open=openPaletteActions.has(actionKey);actions.addEventListener('toggle',()=>{if(actions.isConnected){if(actions.open)openPaletteActions.add(actionKey);else openPaletteActions.delete(actionKey);}});
 for(const side of ['foreground','background']as const){const control=button(t(side==='foreground'?'paletteUseText':'paletteUseBackground'),()=>usePaletteColor(color,side),`small palette-use-${side==='foreground'?'text':'background'}`);control.disabled=!color.rgba;control.title=color.rgba?t('manualPaletteScope'):t('unknownColor');actions.append(control);}item.append(actions);
 return item;
}
function usePaletteColor(color:ColorValue,side:'foreground'|'background'){
 if(!color.rgba)return;invalidateCopy();manualDraft[side]=formatColor(color.rgba,'hex');manualOrigin={view,tab:activeTab,scroll:content.scrollTop};manualExplicit=true;closeActiveColorPicker();manualPanel=null;view=activeTab='contrast';scrolls.contrast=0;render(true);
}
function renderPalette(audit:Audit){
 let cached=paletteInventories.get(audit);if(!cached){cached={};paletteInventories.set(audit,cached);}
 const entries=cached[paletteSort]??(cached[paletteSort]=getPaletteEntries(audit,paletteSort)),node=card(`${t('pagePalette')} · ${number(entries.length,0)}`);node.classList.add('palette-overview');
 const limited=inventoryLimitNotice(audit,'colors');if(limited)node.append(limited);
 if(entries.length){
  const sort=selectField(t('paletteSort'),[['usage',t('paletteSortUsage')],['frequency',t('paletteSortFrequency')],['hue',t('paletteSortHue')]],paletteSort,value=>{
   if(value!=='usage'&&value!=='frequency'&&value!=='hue')return;
   paletteSort=value;paletteLimit=24;render();const control=document.getElementById('palette-sort');control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});
  });sort.classList.add('inventory-sort');sort.querySelector('select')!.id='palette-sort';sort.querySelector('label')!.htmlFor='palette-sort';
  node.append(sort,small(t('paletteUsageHelp')));
  const visible=entries.slice(0,paletteLimit);
  if(paletteSort==='usage'){
   for(const role of paletteRoles){
    const group=visible.filter(entry=>primaryPaletteRole(entry)===role);if(!group.length)continue;
    const total=entries.filter(entry=>primaryPaletteRole(entry)===role).length;
    const heading=el('h3','palette-group-title',`${t(paletteRoleKeys[role])} (${number(total,0)})`);heading.id=`palette-group-${role}`;
    const palette=el('div','palette page-palette',...group.map(paletteItem));palette.setAttribute('aria-labelledby',heading.id);
    node.append(el('div','palette-group',heading,palette));
   }
  }else node.append(el('div','palette page-palette',...visible.map(paletteItem)));
  if(entries.some(entry=>entry.count===0))node.append(small(t('inventoryRefreshHint')));
  if(entries.length>paletteLimit)node.append(button(t('actionMore',entries.length-paletteLimit),()=>{paletteLimit+=24;render();},'list-more'));
 }else node.append(small(t('noPageValues')));
 node.append(small(`${t('scanned')}: ${number(audit.scanned,0)}${audit.stale?' · '+t('statusStale'):''}`));return node;
}
function compareFontRows(a:{sizeCssPx:number|null;count:number},b:{sizeCssPx:number|null;count:number}){
 const unknown=Number(a.sizeCssPx===null)-Number(b.sizeCssPx===null);if(unknown)return unknown;
 if(fontSort==='frequency'&&a.count!==b.count)return b.count-a.count;
 if(a.sizeCssPx===null||b.sizeCssPx===null)return 0;
 return (a.sizeCssPx-b.sizeCssPx)*(fontSort==='size-desc'?-1:1);
}
function focusRevealedFontRow(family:string|null,selector:string,index:number){
 const root=family===null?content:[...content.querySelectorAll<HTMLElement>('.font-usage-item')].find(item=>item.dataset.fontFamily===family);
 const row=root?.querySelectorAll<HTMLElement>(selector)[index];if(!row)return;
 const action=row.querySelector<HTMLButtonElement>('button:not(:disabled)');if(!action)row.tabIndex=-1;
 (action??row).focus({preventScroll:true});row.scrollIntoView({block:'nearest'});
}
function renderFonts(audit:Audit){
 let cached=fontInventories.get(audit);if(!cached){cached={};fontInventories.set(audit,cached);}
 let entries=cached[fontSort];if(!entries){entries=getFontEntries(audit);for(const entry of entries){entry.sizes.sort(compareFontRows);entry.variants?.sort(compareFontRows);}cached[fontSort]=entries;}
 const node=card(`${t('pageFonts')} · ${number(entries.length,0)}`,small(t('pageFontsHelp')));node.classList.add('font-overview');
 const limited=inventoryLimitNotice(audit,'fonts');if(limited)node.append(limited);
 if(!entries.length){node.append(small(t('noPageValues')));return node;}
 const sort=selectField(t('fontSort'),[['frequency',t('fontSortFrequency')],['size-asc',t('fontSortSizeAsc')],['size-desc',t('fontSortSizeDesc')]],fontSort,value=>{
  if(value!=='frequency'&&value!=='size-asc'&&value!=='size-desc')return;
  fontSort=value;fontSizeLimits.clear();fontVariantLimits.clear();render();const control=document.getElementById('font-sort');control?.focus({preventScroll:true});control?.scrollIntoView({block:'nearest'});
 });sort.classList.add('inventory-sort');sort.querySelector('select')!.id='font-sort';sort.querySelector('label')!.htmlFor='font-sort';
 node.append(sort,small(t('fontUsageHelp')));
 const list=el('ul','font-inventory');
 for(const entry of entries.slice(0,fontFamilyLimit)){
  const heading=el('div','font-usage-heading',el('span','font-chip',entry.family),entry.count>0?inventoryFrequency(entry.count):null);
  const item=el('li','font-usage-item',heading,inventoryMatches(entry.elementRefs,entry.family,run=>run.fontFamily===entry.family)),sizes=el('ul','font-size-list');sizes.setAttribute('aria-label',t('fontObservedSizes'));
  item.dataset.fontFamily=entry.family;
  const sizeLimit=fontSizeLimits.get(entry.family)??12;
  for(const size of entry.sizes.slice(0,sizeLimit)){
   const sizeLabel=size.sizeCssPx===null?t('fontSizeUnknown'):t('fontCssSize',number(size.sizeCssPx,3));sizes.append(el('li','font-size-row',el('span','',sizeLabel),size.count>0?inventoryFrequency(size.count):null,inventoryMatches(size.elementRefs,`${entry.family} · ${sizeLabel}`,run=>run.fontFamily===entry.family&&run.fontSizeCssPx===size.sizeCssPx)));
  }
  if(entry.sizes.length>sizeLimit){const more=button(t('fontMoreSizes',number(entry.sizes.length-sizeLimit,0)),()=>{fontSizeLimits.set(entry.family,sizeLimit+12);render();focusRevealedFontRow(entry.family,'.font-size-row',sizeLimit);},'small font-more-sizes');more.setAttribute('aria-label',t('fontMoreFor',t('fontObservedSizes'),entry.family));sizes.append(el('li','',more));}
  if(entry.sizes.length)item.append(sizes);else item.append(small(t('inventoryRefreshHint')));
  if(entry.variants?.length){
   const variants=el('details','font-variants',el('summary','',`${t('fontVariants')} (${number(entry.variants.length,0)})`)),rows=el('ul','font-variant-list');
   const populate=()=>{
    rows.replaceChildren();if(!variants.open)return;const limit=fontVariantLimits.get(entry.family)??12;
    for(const variant of entry.variants!.slice(0,limit)){
     const size=variant.sizeCssPx===null?t('fontSizeUnknown'):t('fontCssSize',number(variant.sizeCssPx,3)),weight=variant.fontWeight===null?t('fontWeightUnknown'):t('fontWeightValue',number(variant.fontWeight,3)),line=!variant.lineHeight?t('fontLineHeightUnknown'):t('fontLineHeightValue',variant.lineHeight==='normal'?t('fontLineHeightNormal'):variant.lineHeight);
     rows.append(el('li','font-variant-row',el('span','',`${size} · ${weight} · ${line}`),inventoryFrequency(variant.count),inventoryMatches(variant.elementRefs,`${entry.family} · ${size} · ${weight} · ${line}`,run=>run.fontFamily===entry.family&&run.fontSizeCssPx===variant.sizeCssPx&&run.fontWeight===variant.fontWeight&&(run.lineHeight??'')===variant.lineHeight)));
    }
    if(entry.variants!.length>limit)rows.append(el('li','',button(t('fontMoreVariants',number(entry.variants!.length-limit,0)),()=>{fontVariantLimits.set(entry.family,limit+12);populate();focusRevealedFontRow(entry.family,'.font-variant-row',limit);},'small font-more-variants')));
   };
   variants.open=openFontVariants.has(entry.family);variants.addEventListener('toggle',()=>{if(!variants.isConnected)return;if(variants.open)openFontVariants.add(entry.family);else openFontVariants.delete(entry.family);populate();});variants.append(rows);populate();item.append(variants);
  }
  list.append(item);
 }
 node.append(list);if(entries.length>fontFamilyLimit)node.append(button(t('fontMoreFamilies',number(entries.length-fontFamilyLimit,0)),()=>{const first=fontFamilyLimit;fontFamilyLimit+=12;render();focusRevealedFontRow(null,'.font-usage-item',first);},'list-more font-more-families'));return node;
}
function fields(styles:Record<string,string>){const list=el('dl','fields');for(const[property,raw]of Object.entries(styles)){const color=property==='color'||property.endsWith('-color')?parseColor(raw):null;const value=color?colorText(color):raw;const control=button('',()=>void copyText(value),'icon-button','copy');control.title=t('actionCopyValue',property);control.setAttribute('aria-label',control.title);control.disabled=Boolean(state.preview);list.append(el('div','field',el('dt','',property),el('dd','',color?colorChip(color):value),control));}return list;}
function renderTypography(snapshot:Snapshot,run:TextRun|undefined){
 content.append(card(t('tabTypography'),fields(snapshot.styles.typography)));
 if(run)content.append(card(t('fontSize'),fontStatus(measuredRun(run))));
 const sample=el('div','font-preview',t('previewFontText'));for(const property of ['font-family','font-weight','font-style','letter-spacing','text-transform']){const value=snapshot.styles.typography[property];if(value&&safeValue(property,value))sample.style.setProperty(property,value);}
 content.append(card(t('previewFont'),sample,small(t('fontFallback'))));renderPageOverview('typography');
}
function renderLayout(snapshot:Snapshot){
 const styles=snapshot.styles.layout;const sides=(prefix:string,suffix='')=>['top','right','bottom','left'].map(side=>styles[`${prefix}-${side}${suffix}`]??'—').join(' · ');
 const contentWidth=contentDimension(styles,'width');const contentHeight=contentDimension(styles,'height');
 const box=el('div','box-model',el('span','box-label',`margin · ${sides('margin')}`),el('div','border-box',el('span','box-label',`border · ${sides('border','-width')}`),el('div','padding-box',el('span','box-label',`padding · ${sides('padding')}`),el('div','content-box',`${t('contentBox')}: ${contentWidth} × ${contentHeight}`))));
 content.append(card(t('tabLayout'),box,small(t('visualDimensions',number(snapshot.rect.width),number(snapshot.rect.height))),small(t('visualNote'))),card(t('cssDimensions'),fields(styles)));
}
function contentDimension(styles:Record<string,string>,dimension:'width'|'height'){
 const parsed=Number.parseFloat(styles[dimension]??'');if(!Number.isFinite(parsed)||!/^\d+(\.\d+)?px$/.test(styles[dimension]??''))return styles[dimension]??'—';let value=parsed;
 if(styles['box-sizing']==='border-box')for(const side of dimension==='width'?['left','right']:['top','bottom'])value-=Number.parseFloat(styles[`padding-${side}`]??'0')+Number.parseFloat(styles[`border-${side}-width`]??'0');
 return `${number(Math.max(0,value),3)} px`;
}
function renderSettings(){
 content.append(el('div','section-title',el('h2','',t('actionSettings')),button(t('actionBack'),back,'back','back')));
 const settings=state.settings;const preferences=el('section','card');
 preferences.append(selectField(t('appearance'),[['system',t('appearanceSystem')],['light',t('appearanceLight')],['dark',t('appearanceDark')]],settings.appearance,value=>send({type:'update-settings',settings:{appearance:value as Settings['appearance']}})),selectField(t('colorFormat'),[['hex','HEX'],['rgb','RGB'],['hsl','HSL']],settings.colorFormat,value=>send({type:'update-settings',settings:{colorFormat:value as Settings['colorFormat']}})),selectField(t('contrastTarget'),[['AA','AA'],['AAA','AAA']],settings.contrastTarget,value=>send({type:'update-settings',settings:{contrastTarget:value as Settings['contrastTarget']}})),toggle(t('livePreview'),t('livePreviewDescription'),settings.livePreview,value=>send({type:'update-settings',settings:{livePreview:value}})),toggle(t('contextMenuEnabled'),t('contextMenuDescription'),settings.contextMenuEnabled,value=>send({type:'update-settings',settings:{contextMenuEnabled:value}})));
 preferences.append(toggle(t('showDiagnostics'),t('showDiagnosticsDescription'),settings.showDiagnostics,value=>send({type:'update-settings',settings:{showDiagnostics:value}}),'show-diagnostics'));
 for(const control of preferences.querySelectorAll<HTMLSelectElement|HTMLInputElement>('select,input'))control.disabled=!connected;
 content.append(preferences);
 const clear=button(t('clearData'),()=>{confirmAction='clear';render();},'danger');clear.disabled=!connected;
 const reset=button(t('resetSettings'),()=>{confirmAction='reset';render();});reset.disabled=!connected;
 const data=card(t('dataManagement'),small(t('clearDataDescription')),clear,small(t('resetSettingsDescription')),reset);
 if(confirmAction){const action=confirmAction;const confirm=el('div','confirm-box',el('p','',t(action==='clear'?'confirmClear':'confirmReset')),el('div','actions',button(t('actionConfirm'),()=>{send({type:action==='clear'?'clear-data':'reset-settings'});confirmAction=null;render();},'danger'),button(t('actionCancel'),()=>{confirmAction=null;render();})));confirm.setAttribute('role','alert');data.append(confirm);}
 content.append(data,renderAnalysesOverview(),card(t('shortcut'),el('span','shortcut',shortcut),small(t('shortcutHelp'))),card(t('about'),el('span','badge',t('version',version)),small(t('privacy')),small(t('limitations'))));
}
function requestAnalyses(entry?:AnalysisSummary){
 if(!connected||pendingAnalyses)return;
 const requestId=`analyses-${++sequence}`;
 pendingAnalyses={requestId,clearing:Boolean(entry)};confirmAnalysis=null;render();
 try{port?.postMessage(entry?{type:'clear-tab-analysis',targetTabId:entry.tabId,documentToken:entry.documentToken,requestId}:{type:'list-analyses',requestId});}
 catch{pendingAnalyses=null;render();notify(t('error_connection'));}
}
function renderAnalysesOverview(){
 const section=card(t('analysesTitle'),small(t('analysesDescription')));section.classList.add('analyses-overview');
 const refresh=button(t(pendingAnalyses?'analysesLoading':analysesOverview?'analysesRefresh':'analysesShow'),()=>requestAnalyses(),'small show-node','refresh');refresh.disabled=!connected||Boolean(pendingAnalyses);section.append(refresh);
 if(!analysesOverview)return section;
 const {entries,maximumBytes,maximumRecords}=analysesOverview;
 const bytes=entries.reduce((sum,entry)=>sum+entry.estimatedBytes,0);
 section.append(small(t('analysesUsage',number(entries.length,0),number(maximumRecords,0),number(bytes/1024,1),number(maximumBytes/1024,0))),small(t('analysesEstimate')));
 if(!entries.length)section.append(small(t('analysesEmpty')));
 for(const entry of entries){
  const title=entry.title||t('analysesTab',entry.tabId);
  const item=el('article','analysis-entry',el('strong','analysis-title',title));item.dataset.tabId=String(entry.tabId);
  if(entry.tabId===state.tabId)item.append(small(t('analysesCurrent')));
  if(entry.measuredAt)item.append(small(`${t('measuredAt')}: ${date(entry.measuredAt)}`));
  const parts=[t('analysesRuns',number(entry.auditRuns,0))];
  if(entry.auditStatus)parts.push(t(entry.auditStatus==='running'?'analysesRunning':entry.auditStatus==='complete'?'statusComplete':entry.auditStatus==='cancelled'?'statusCancelled':'statusPartial'));
  if(entry.selected)parts.push(t('analysesSelection'));if(entry.previousAudit)parts.push(t('analysesBaseline'));
  item.append(small(parts.join(' · ')));
  const remove=button(t('analysesDelete'),()=>{confirmAnalysis=entry;render();},'small danger');remove.disabled=!connected||Boolean(pendingAnalyses);item.append(remove);
  if(confirmAnalysis?.tabId===entry.tabId&&confirmAnalysis.documentToken===entry.documentToken){
   const confirm=el('div','confirm-box',el('p','',t('analysesConfirm',title)),el('div','actions',button(t('actionConfirm'),()=>requestAnalyses(entry),'danger'),button(t('actionCancel'),()=>{confirmAnalysis=null;render();})));
   confirm.setAttribute('role','alert');item.append(confirm);
  }
  section.append(item);
 }
 return section;
}
function openExport(suggestion?:ContrastSuggestion){
 exportSources={};exportCache=null;exportPreview=null;saveRequest=null;if(state.selected)exportSources.element={kind:'element',snapshot:structuredClone(state.selected)};
 const audit=currentAudit();if(audit){exportSources['page-tokens']={kind:'page-tokens',audit:structuredClone(audit)};exportSources.audit={kind:'audit',audit:structuredClone(audit)};}
 if(suggestion&&state.selected)exportSources['contrast-suggestion']={kind:'contrast-suggestion',snapshot:structuredClone(state.selected),suggestion:structuredClone(suggestion)};
 exportKind=suggestion?'contrast-suggestion':activeTab==='audit'||isPageOverview()?'page-tokens':'element';exportFormat='css';exportScope='all';exportInventory='measured';exportColorFormat=state.settings.colorFormat;exportTarget=state.settings.contrastTarget;exportInvalid=false;openSubview('export');
}
function renderExport(){
 content.append(el('div','section-title',el('h2','',t('exportTitle')),button(t('actionBack'),back,'back','back')));
 if(exportInvalid){exportResult=null;exportPreview=null;content.append(notice(t('exportInvalid'),'warning'));return;}
 const sources: Array<[ExportSource['kind'],string]>=[['element','sourceElement'],['page-tokens','sourceTokens'],['audit','sourceAudit'],['contrast-suggestion','sourceSuggestion']];
 const controls=el('section','card',selectField(t('exportSource'),sources.map(([key,label])=>[key,t(label),!exportSources[key]]),exportKind,value=>{invalidateCopy();exportKind=value as ExportSource['kind'];if(exportKind==='audit')exportFormat='json';render();}));
 if(exportKind==='element')controls.append(selectField(t('exportScope'),[['all',t('scopeAll')],['colors',t('scopeColors')],['typography',t('scopeTypography')],['layout',t('scopeLayout')]],exportScope,value=>{invalidateCopy();exportScope=value as ExportScope;render();}));
 else if(exportKind==='contrast-suggestion')controls.append(notice(t('scopeSuggestion')));
 else if(exportKind==='page-tokens')controls.append(selectField(t('exportInventory'),[['measured',t('exportInventoryMeasured')],['css',t('exportInventoryCSS')]],exportInventory,value=>{invalidateCopy();exportInventory=value==='css'?'css':'measured';render();}),small(t('exportInventoryHelp')));
 if(exportKind==='audit')exportFormat='json';controls.append(selectField(t('exportFormat'),[['css','CSS',exportKind==='audit'],['scss','SCSS',exportKind==='audit'],['json','JSON'],['tailwind','Tailwind CSS v4',exportKind==='audit']],exportFormat,value=>{invalidateCopy();exportFormat=value as ExportFormat;render();}),small(t(exportKind==='audit'?'exportAuditOnly':'exportGenerated')),small(t('exportUnavailable')));content.append(controls);
 const source=exportSources[exportKind];if(!source){exportResult=null;exportPreview=null;content.append(notice(t('footerNoData'),'warning'));return;}
 try{
  const options:ExportOptions={format:exportFormat,scope:exportScope,colorFormat:exportColorFormat,version,target:exportTarget,...(exportKind==='page-tokens'?{inventory:exportInventory}:{})};const key=JSON.stringify(options);
  // Draft sources and preferences are frozen. Unrelated state updates must not
  // rebuild a large export or cancel a pending permission request for its bytes.
  if(exportCache?.source!==source||exportCache.key!==key)exportCache={source,key,result:serializeExport(source,options)};
  exportResult=exportCache.result;
 }catch{exportResult=null;exportCache=null;exportPreview=null;content.append(notice(t('error_generic'),'error'));return;}
 const snapshot='snapshot'in source?source.snapshot:source.audit;
 const output=card(t('exportPreview'),el('div','filename',exportResult.filename),small(`${t('measuredAt')}: ${date(snapshot.measuredAt)}`),small(t('exportFrozen')));
 if(snapshot.stale)output.append(notice(t('statusStale'),'warning'));if('audit'in source&&source.audit.status!=='complete')output.append(notice(t('statusPartial'),'warning'));
 // Rendering every color in a full-page JSON report can create thousands of
 // swatch nodes. Keep the preview small; copying and saving use the full result.
 if(exportPreview?.result!==exportResult){
  const text=exportResult.text.slice(0,exportPreviewLimit).replace(/[\uD800-\uDBFF]$/,'');
  const code=el('pre','code-preview',decorateHex(text));code.id='export-code-preview';code.tabIndex=0;code.setAttribute('aria-label',t('exportPreview'));
  exportPreview={result:exportResult,node:code};
 }
 if(exportResult.text.length>exportPreviewLimit){const hint=notice(t('exportPreviewTruncated'));hint.classList.add('export-preview-truncated');output.append(hint);}
 output.append(exportPreview.node);
 if(exportResult.warnings.length){output.append(notice(t('exportUnsupported'),'warning'));for(const warning of exportResult.warnings)output.append(small(`${warning.property?warning.property+': ':''}${reason(warning.code)}`));}
 if(exportResult.classes){const classes=exportResult.classes;output.append(button(t('actionCopyClasses'),()=>void copyText(classes),'small'),small(t('tailwindHelp')));}
 content.append(output,small(t('downloadPermission')));
}
function reportRatio(result:ContrastResult){return result.ratio===null?t('ratioUnavailable'):`${result.ratioKind==='minimum'?'≥ ':''}${result.ratio} : 1${result.ratioKind==='minimum'?' · '+t('contrastMinimum'):''}`;}
function cssContrastReport(run:TextRun){
 const sample=cssColorContrast(run);if(!sample)return[];
 const lines=[`${t('cssColorContrast')}: ${sample.ratio} : 1`,t('cssColorsOnly')];
 if(sample.category==='unknown')lines.push(t('cssThresholdUnknown'));
 else for(const level of ['AA','AAA']as const){const comparison=sample[level];if(comparison)lines.push(`${t('cssThreshold',level)}: ${t(comparison.status==='pass'?'cssThresholdReached':'cssThresholdBelow')} (≥ ${comparison.threshold} : 1)`);}
 lines.push(t('cssColorContrastNotice'),t('cssPageUnverified'));return lines;
}
function contrastReport(snapshot:Snapshot){
 const lines=[t('tabContrast'),`${t('measuredAt')}: ${date(snapshot.measuredAt)}`];
 if(snapshot.stale)lines.push(t('statusStale'));
 for(const raw of snapshot.textRuns){const run=measuredRun(raw),sample=cssColorContrast(run);lines.push(`${run.tagName} · ${run.textSource==='placeholder'?t('placeholderText')+' · ':''}${t(run.contrast.category==='large'?'largeText':run.contrast.category==='normal'?'normalText':'unknownText')}`,`${t('foreground')}: ${colorText(run.foreground)}`,`${t(sample?'previewCSSBackground':'effectiveBackground')}: ${run.backgroundRange?t('gradientBackground'):colorText(run.effectiveBackground)}`);if(sample)lines.push(...cssContrastReport(run));else lines.push(`${t('ratio')}: ${reportRatio(run.contrast)}`,`AA: ${statusText(run.contrast.AA.status)} (≥ ${run.contrast.AA.threshold} : 1)`,`AAA: ${statusText(run.contrast.AAA.status)} (≥ ${run.contrast.AAA.threshold} : 1)`);if(run.contrast.reason)lines.push(reason(run.contrast.reason));}
 if(snapshot.reasons.length)lines.push('',t('reasonLabel'),...snapshot.reasons.map(reason));
 return lines.join('\n');
}
function statusText(status:RuleStatus){return t(({pass:'statusPass',fail:'statusFail',manual:'statusManualReview','not-applicable':'statusNotApplicable'}as const)[status]);}
function auditReport(audit:Audit){
 const runtime=auditRuntimeDetails(audit);
 const lines=[t('auditTitle'),`${t('measuredAt')}: ${date(audit.measuredAt)}`,...runtime.lines,...(runtime.limitNotice?[runtime.limitNotice]:[]),`${t('contrastTarget')}: ${audit.target}`,`${t('viewport')}: ${audit.viewport.width} × ${audit.viewport.height}`,`${t('scanned')}: ${audit.scanned}`,`${t('skipped')}: ${audit.skipped}`,`${t('checks')}: ${audit.counts.checks}`,`${t('findings')}: ${audit.counts.findings}`,`${t('affected')}: ${audit.counts.affectedRuns}`,'',t('textContrast'),t('auditCounts',audit.counts.contrast.pass,audit.counts.contrast.fail,audit.counts.contrast.manual,audit.counts.contrast.notApplicable),'',t('readabilityHints')+' · < 12 CSS px',t('auditFontCounts',audit.counts.fontSize.pass,audit.counts.fontSize.fail,audit.counts.fontSize.manual,audit.counts.fontSize.notApplicable),t('fontHeuristic'),''];
 for(const run of audit.runs){lines.push(`${run.tagName} · ${run.id}${run.textSource==='placeholder'?' · '+t('placeholderText'):''}`);if(run.viewportPartial)lines.push(t('auditViewportPartial'));if(cssColorContrast(run))lines.push(...cssContrastReport(run));else lines.push(`${t('textContrast')}: ${statusText(run.contrast.status)} · ${reportRatio(run.contrast)} · ≥ ${run.contrast.threshold} : 1`,`AA: ${statusText(run.contrast.AA.status)} (≥ ${run.contrast.AA.threshold} : 1)`,`AAA: ${statusText(run.contrast.AAA.status)} (≥ ${run.contrast.AAA.threshold} : 1)`);lines.push(`${t('fontSize')}: ${run.fontSizeCssPx??'—'} CSS px · ${run.fontSize.status==='fail'?t('findingSmallText'):run.fontSize.status==='pass'?t('statusThresholdMet'):statusText(run.fontSize.status)}`);if(run.contrast.reason)lines.push(reason(run.contrast.reason));}
 if(audit.stale)lines.push(t('statusStale'));
 lines.push(audit.status==='running'?t('statusScanning',audit.scanned,audit.total):t(audit.status==='cancelled'?'statusCancelled':audit.status==='partial'?'statusPartial':'statusComplete'));
 lines.push('',t('limitations'),...audit.reasons.map(reason));return lines.join('\n');
}
async function copyCurrent(){
 if(copy.disabled)return;if(isManualContrast()){const pair=manualContrast(manualDraft.foreground,manualDraft.background,manualDraft.underlay);if(!pair)return;const lines=[t('manualContrastTitle'),t('manualContrastScope'),`${t('foreground')}: ${pair.foreground.value}`,`${t('manualBackground')}: ${pair.background.value}`,...(pair.underlay?[`${t('manualUnderlay')}: ${pair.underlay.value}`,`${t('effectiveBackground')}: ${formatColor(pair.effectiveBackground,'hex')}`]:[]),`${t('ratio')}: ${pair.normal.ratio} : 1`];for(const category of ['normal','large']as const){lines.push('',t(category==='normal'?'normalText':'largeText'));for(const level of ['AA','AAA']as const){const result=pair[category][level];lines.push(`${level}: ${statusText(result.status)} (≥ ${result.threshold} : 1)`);}}await copyText(lines.join('\n'),true);return;}if(view==='export'&&exportResult){await copyText(exportResult.text);return;}if(view==='audit'){const audit=currentAudit();if(audit)await copyText(auditReport(audit));return;}
 if(isPageOverview()){const audit=currentAudit();if(audit){try{await copyText(serializeExport({kind:'page-tokens',audit},{version,format:'css',colorFormat:state.settings.colorFormat,target:state.settings.contrastTarget,inventory:'measured'}).text);}catch{notify(t('error_generic'));}}return;}
 const snapshot=state.selected;if(!snapshot||state.preview)return;if(view==='contrast'){await copyText(contrastReport(snapshot));return;}
 if(view==='colors'){await copyText(serializeColorVariables(snapshot,state.settings.colorFormat));return;}
 if(view==='typography'||view==='layout'){try{await copyText(serializeExport({kind:'element',snapshot},{version,format:'css',scope:view,colorFormat:state.settings.colorFormat}).text);}catch{notify(t('error_generic'));}}
}
async function copyText(text:string,local=false,valid?:()=>boolean){
 if(!connected&&!local){notify(t('actionsDisconnected'));return;}if(valid&&!valid())return;const cancelledDiagnostic=Boolean(pendingDiagnostic);pendingDiagnostic=null;if(cancelledDiagnostic)render();const request=++copySequence;clipboardValidity=valid??null;const current=()=>request===copySequence&&(local?isManualContrast():connected)&&(!valid||valid());
 try{await navigator.clipboard.writeText(text);if(!current())return;const hadFallback=clipboardFallback!==null;clipboardFallback=null;if(hadFallback)render();notify(t('statusCopied'));}
 catch{if(!current())return;clipboardFallback=text;render();const fallback=content.querySelector<HTMLTextAreaElement>('.clipboard-fallback');fallback?.focus();fallback?.select();notify(t('statusCopyFailed'));}
}
async function saveExport(){
 if(!exportResult||exportInvalid||!connected||saveRequest)return;const result=exportResult;const initialPort=port;const request={};saveRequest=request;updateFooter();
 const current=()=>saveRequest===request&&!exportInvalid&&view==='export'&&connected&&port===initialPort&&exportResult===result;
 try{const allowed=await browser.permissions.request({permissions:['downloads']});if(!current())return;if(!allowed){notify(t('error_download_permission'));return;}send({type:'save-export',text:result.text,mime:result.mimeType,filename:result.filename});}
 catch{if(current())notify(t('error_download_failed'));}
 finally{if(saveRequest===request){saveRequest=null;updateFooter();}}
}
function receiveMessage(rawMessage:unknown){
 const message=rawMessage as SidebarMessage;
 if(message.type==='analyses'){
  if(pendingAnalyses?.requestId!==message.requestId)return;
  pendingAnalyses=null;confirmAnalysis=null;analysesOverview=message;if(view==='settings')render();return;
 }
 if(message.type==='diagnostic'){
  diagnosticRequests.delete(message.requestId);
  const pending=pendingDiagnostic;if(!pending||pending.requestId!==message.requestId)return;pendingDiagnostic=null;if(!pending.valid()){render();return;}try{const text=serializeDiagnostic(message.report);render();void copyText(text,false,pending.valid);}catch{render();notify(t('error_generic'));}return;
 }
 if(message.type==='error'){
  if(message.requestId?.startsWith('analyses-')){if(pendingAnalyses?.requestId!==message.requestId)return;pendingAnalyses=null;confirmAnalysis=null;if(view==='settings')render();notify(t(`error_${message.code.replaceAll('-','_')}`));return;}
  if(message.requestId&&(diagnosticRequests.has(message.requestId)||message.requestId.startsWith('diagnostic-'))){diagnosticRequests.delete(message.requestId);const pending=pendingDiagnostic?.requestId===message.requestId?pendingDiagnostic:null;if(pending)pendingDiagnostic=null;if(!pending?.valid()){render();return;}}
  const text=t(`error_${message.code.replaceAll('-','_')}`);const reference=message.requestId?auditActionRequests.get(message.requestId):undefined;
  if(reference){auditActionRequests.delete(message.requestId!);if(['element-removed','target-expired','stale-document'].includes(message.code))auditActionErrors.set(reference,t('auditActionsExpired'));if(pendingRun?.requestId===message.requestId){pendingRun=null;returnToAudit=false;}}
  if(auditStarting&&message.requestId===auditStartRequest){auditStarting=false;auditStartRequest=null;}render();notify(text);return;
 }
 if(message.type==='saved'){notify(t(({started:'statusStartedDownload',complete:'statusSaved',cancelled:'statusSaveCancelled',failed:'error_download_failed'}as const)[message.status]));return;}
 if(message.type!=='state')return;
 const previous=state;state=message.state;connected=true;hasConnected=true;reconnectAttempts=0;
 if(previous.settings.showDiagnostics&&!state.settings.showDiagnostics)invalidateCopy();
 if(readyTimer){clearTimeout(readyTimer);readyTimer=undefined;}if(reconnectTimer){clearTimeout(reconnectTimer);reconnectTimer=undefined;}
 const documentChanged=previous.documentToken!==state.documentToken||previous.tabId!==state.tabId;
 const selectionChanged=documentChanged||previous.selected?.id!==state.selected?.id||previous.selected?.elementRef!==state.selected?.elementRef;
 const pickerConfirmed=state.lastEvent==='selected'&&state.selectionOrigin==='picker'&&previous.picker&&!state.picker;
 const auditMeasurementChanged=previous.audit?.id!==state.audit?.id||previous.audit?.measuredAt!==state.audit?.measuredAt;
 if(selectionChanged||auditMeasurementChanged)paletteLimit=24;
 if(auditMeasurementChanged){openAuditGroups.clear();groupMemberLimits.clear();openFontVariants.clear();openPaletteActions.clear();fontFamilyLimit=12;fontSizeLimits.clear();fontVariantLimits.clear();missingReason='';inventorySelection=null;returnToInventory=false;if(view==='occurrences')view=activeTab;if(state.audit?.scope)scanScope=state.audit.scope;}
 if(documentChanged){const keepManual=view==='contrast'&&!previous.selected&&!previous.preview&&!state.selected&&!state.preview,manualScroll=content.scrollTop;resetAnalysisView();scanScope=state.audit?.scope??'page';auditStarting=false;auditStartRequest=null;if(keepManual){activeTab=view=lastElementTab='contrast';scrolls.contrast=manualScroll;}}
 if(previous.preview?.elementRef!==state.preview?.elementRef)previewRunIndex=0;
 if(selectionChanged||pickerConfirmed){copySequence++;clipboardFallback=null;if(documentChanged||previous.selected?.elementRef!==state.selected?.elementRef||pickerConfirmed)selectedRunId=state.selected?.textRuns[0]?.id??null;simulation='original';suggestionProperty='color';includePalette=false;}
 if(state.lastEvent==='selected'&&state.selected){pendingAnalyses=null;confirmAnalysis=null;manualExplicit=false;view=state.selectionTab??(state.selectionOrigin==='context'&&(view==='audit'||view==='settings'||view==='export')?'contrast':lastElementTab);activeTab=view as TabId;if(activeTab==='audit')activeTab=view='contrast';lastElementTab=activeTab;
  // Only the matching audit selection owns its requested text area. A newer
  // picker/context selection must not inherit an unfinished audit request.
  if(state.selectionOrigin!=='audit'){pendingRun=null;returnToInventory=false;}
  else if(pendingRun?.elementRef===state.selected.elementRef){selectedRunId=pendingRun.runId;pendingRun=null;}
 }
 if(state.lastEvent==='data-cleared'){analysesOverview=null;if(!pendingAnalyses?.clearing)pendingAnalyses=null;confirmAnalysis=null;comparisonCache=null;comparisonOpen=false;closeActiveColorPicker();manualDraft={foreground:'#000000',background:'#FFFFFF',underlay:''};manualPanel=null;copySequence++;hasAudited=false;exportInvalid=true;exportSources={};exportResult=null;exportCache=null;exportPreview=null;saveRequest=null;clipboardFallback=null;pendingRun=null;pendingDiagnostic=null;simulation='original';simulationOpen=false;returnToAudit=false;manualExplicit=false;manualOrigin=null;inventorySelection=null;returnToInventory=false;openAuditGroups.clear();groupMemberLimits.clear();openFontVariants.clear();openPaletteActions.clear();notify(t('statusCleared'));}
 if(state.lastEvent==='data-cleared'){auditStarting=false;auditStartRequest=null;}
 if(state.lastEvent==='audit-reset'){resetAnalysisView();auditStarting=true;}
 if(state.audit){if(!auditStartRequest||state.audit.id===auditStartRequest){auditStarting=false;auditStartRequest=null;}hasAudited=true;}
 if(exportSources['contrast-suggestion']&&(selectionChanged||state.selected?.stale||previous.settings.contrastTarget!==state.settings.contrastTarget)){
  delete exportSources['contrast-suggestion'];if(exportCache?.source.kind==='contrast-suggestion')exportCache=null;if(exportKind==='contrast-suggestion')exportInvalid=true;
 }
 if(view==='export'&&state.lastEvent==='stale')exportInvalid=true;
 render(documentChanged||state.lastEvent==='selected'||state.lastEvent==='audit-reset');
}
function handleDisconnect(disconnected:browser.runtime.Port|null){
 if(disconnected!==port||closing)return;copySequence++;pendingDiagnostic=null;pendingAnalyses=null;analysesOverview=null;confirmAnalysis=null;saveRequest=null;port=null;connected=false;
 if(readyTimer){clearTimeout(readyTimer);readyTimer=undefined;}
 auditStarting=false;auditStartRequest=null;
 if(!reconnectTimer&&reconnectAttempts<reconnectDelays.length){
  const delay=reconnectDelays[reconnectAttempts++]!;reconnectTimer=setTimeout(()=>{reconnectTimer=undefined;connectPort();},delay);
 }
 render();
}
function connectPort(){
 if(closing||sidebarWindowId===null)return;
 try{
  const next=browser.runtime.connect({name:'sidebar'});port=next;
  next.onMessage.addListener((message:unknown)=>{if(port===next)receiveMessage(message);});
  next.onDisconnect.addListener(()=>handleDisconnect(next));
  readyTimer=setTimeout(()=>{if(port===next&&!connected){try{next.disconnect();}catch{}handleDisconnect(next);}},5000);
  send({type:'ready',windowId:sidebarWindowId});
 }catch{handleDisconnect(port);}
}
void browser.windows.getCurrent().then(window=>{sidebarWindowId=window.id!;connectPort();}).catch(()=>{reconnectAttempts=reconnectDelays.length;render();notify(t('error_connection'));});
window.addEventListener('unload',()=>{closing=true;if(reconnectTimer)clearTimeout(reconnectTimer);if(readyTimer)clearTimeout(readyTimer);try{port?.disconnect();}catch{}});
void browser.commands.getAll().then(commands=>{shortcut=commands.find(command=>command.name==='_execute_action')?.shortcut||t('unassigned');if(view==='settings')render();}).catch(()=>{});
document.addEventListener('keydown',event=>{if(event.key==='Escape'){if(closeActiveColorPicker(true)){event.preventDefault();event.stopPropagation();return;}if(confirmAnalysis){confirmAnalysis=null;render();}else if(confirmAction){confirmAction=null;render();}else if(state.picker)send({type:'cancel-picker'});else if(view==='settings'||view==='export')back();}});
render();
