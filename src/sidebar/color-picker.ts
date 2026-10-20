import { changeHue, hsvToHex, rgbToHsv, type HSV } from './hsv';
import { parseManualHex } from './manual-contrast';
import { number, t } from './i18n';

export interface ColorPicker { button: HTMLButtonElement; panel: HTMLDivElement; setColor: (hex:string)=>void; close: (focus?:boolean)=>void }
let active:ColorPicker|null=null;
export function closeActiveColorPicker(focus=false):boolean{if(!active)return false;active.close(focus);return true;}
export function createColorPicker(side:'foreground'|'background',label:string,onChange:(hex:string)=>void):ColorPicker {
  let hex=side==='foreground'?'#000000':'#FFFFFF',color:HSV=rgbToHsv(parseManualHex(hex)!.rgba),pointer:number|null=null,pointerBox:DOMRect|null=null;
  const button=document.createElement('button');button.type='button';button.id=`manual-${side}-picker`;button.className='manual-picker-button';button.setAttribute('aria-expanded','false');
  const swatch=document.createElement('span');swatch.className='manual-color-swatch swatch';swatch.setAttribute('aria-hidden','true');const fill=document.createElement('span');swatch.append(fill);button.append(swatch);
  const panel=document.createElement('div');panel.id=`${button.id}-panel`;panel.className='manual-picker-panel';panel.hidden=true;panel.setAttribute('role','group');panel.setAttribute('aria-label',t('manualPickColor',label));button.setAttribute('aria-controls',panel.id);
  const plane=document.createElement('div');plane.id=`manual-${side}-sv`;plane.className='manual-color-plane picker-color-field';plane.setAttribute('aria-hidden','true');
  const cursor=document.createElement('span');cursor.className='manual-color-cursor';plane.append(cursor);panel.append(plane);
  const hint=document.createElement('p');hint.className='manual-picker-hint';hint.textContent=t('manualPaletteHint');panel.append(hint);
  const fields={}as Record<'h'|'s'|'v',{input:HTMLInputElement;value:HTMLOutputElement}>;
  for(const [key,suffix,title,max]of[['h','hue','manualHue',360],['s','saturation','manualSaturation',100],['v','value','manualValue',100]]as const){
    const field=document.createElement('div');field.className='manual-picker-channel';const name=document.createElement('label');name.textContent=t(title);
    const input=document.createElement('input');input.type='range';input.id=`manual-${side}-${suffix}`;input.min='0';input.max=String(max);input.step='1';name.htmlFor=input.id;
    const value=document.createElement('output');value.setAttribute('aria-hidden','true');name.append(value);field.append(name);
    if(key==='h'){const spectrum=document.createElement('div');spectrum.className='manual-hue-spectrum picker-color-field';spectrum.setAttribute('aria-hidden','true');spectrum.addEventListener('pointerdown',event=>{if(event.button!==0)return;const box=spectrum.getBoundingClientRect();if(box.width<=0)return;event.preventDefault();const hue=Math.min(360,Math.max(0,(event.clientX-box.left)/box.width*360));color={...changeHue(color,hue),h:hue};input.focus({preventScroll:true});commit();});field.append(spectrum);}
    input.addEventListener('input',()=>{const numeric=Number(input.value);color=key==='h'?{...changeHue(color,numeric),h:numeric}:{...color,[key]:numeric/100};commit();});field.append(input);fields[key]={input,value};panel.append(field);
  }
  function update(){
    fill.style.backgroundColor=hex;button.title=t('manualPickColor',label)+' · '+hex;button.setAttribute('aria-label',button.title);
    plane.style.backgroundColor=`hsl(${color.h} 100% 50%)`;cursor.style.left=`${color.s*100}%`;cursor.style.top=`${(1-color.v)*100}%`;
    for(const key of['h','s','v']as const){const value=key==='h'?color.h:color[key]*100,text=number(value,0)+(key==='h'?'°':'%');fields[key].input.value=String(Math.round(value));fields[key].input.setAttribute('aria-valuetext',text);fields[key].value.textContent=text;}
  }
  function commit(){hex=hsvToHex(color);update();onChange(hex);}
  function release(){if(pointer===null)return;const id=pointer;pointer=null;pointerBox=null;if(plane.hasPointerCapture(id))plane.releasePointerCapture(id);}
  // Committing a color can hide an invalid-HEX message above the palette.
  // Keep one coordinate frame for the gesture so that reflow cannot change it.
  function point(event:PointerEvent){const box=pointerBox??plane.getBoundingClientRect();if(box.width<=0||box.height<=0)return;color={...color,s:Math.min(1,Math.max(0,(event.clientX-box.left)/box.width)),v:Math.min(1,Math.max(0,1-(event.clientY-box.top)/box.height))};commit();}
  plane.addEventListener('pointerdown',event=>{if(event.button!==0||pointer!==null)return;event.preventDefault();pointer=event.pointerId;pointerBox=plane.getBoundingClientRect();plane.setPointerCapture(pointer);point(event);});
  plane.addEventListener('pointermove',event=>{if(event.pointerId===pointer)point(event);});
  plane.addEventListener('pointerup',event=>{if(event.pointerId===pointer){point(event);release();}});
  plane.addEventListener('pointercancel',event=>{if(event.pointerId===pointer)release();});plane.addEventListener('lostpointercapture',event=>{if(event.pointerId===pointer){pointer=null;pointerBox=null;}});
  const api:ColorPicker={button,panel,setColor(value){const parsed=parseManualHex(value);if(!parsed||parsed.hex===hex)return;hex=parsed.hex;const next=rgbToHsv(parsed.rgba);color={...next,h:next.s===0?color.h:next.h};update();},close(focus=false){release();panel.hidden=true;button.setAttribute('aria-expanded','false');if(active===api)active=null;if(focus)button.focus({preventScroll:true});}};
  button.addEventListener('click',()=>{if(!panel.hidden){api.close();return;}active?.close();active=api;panel.hidden=false;button.setAttribute('aria-expanded','true');});
  const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!panel.hidden){event.preventDefault();event.stopPropagation();api.close(true);}};button.addEventListener('keydown',escape);panel.addEventListener('keydown',escape);
  update();return api;
}
