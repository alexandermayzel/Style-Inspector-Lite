import { clamp, formatColor, isRGBA } from '../core/colors';
import type { RGBA } from '../core/types';

export interface HSV { h: number; s: number; v: number }
function normalized(color: HSV): HSV {
  if (![color.h, color.s, color.v].every(Number.isFinite)) throw new Error('invalid-hsv');
  return { h: ((color.h % 360) + 360) % 360, s: clamp(color.s), v: clamp(color.v) };
}
export function rgbToHsv(color: RGBA): HSV {
  if (!isRGBA(color)) throw new Error('invalid-rgb');
  const r=color.r/255,g=color.g/255,b=color.b/255,v=Math.max(r,g,b),delta=v-Math.min(r,g,b);
  const h=delta===0?0:v===r?60*((g-b)/delta):v===g?60*((b-r)/delta+2):60*((r-g)/delta+4);
  return { h: (h+360)%360, s:v===0?0:delta/v, v };
}
export function hsvToHex(color: HSV): string {
  const {h,s,v}=normalized(color),c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c;
  const [r,g,b]=h<60?[c,x,0]:h<120?[x,c,0]:h<180?[0,c,x]:h<240?[0,x,c]:h<300?[x,0,c]:[c,0,x];
  return formatColor({r:Math.round((r!+m)*255),g:Math.round((g!+m)*255),b:Math.round((b!+m)*255),a:1},'hex');
}
/** A deliberate hue change reveals a color from an achromatic starting value. */
export function changeHue(color: HSV, hue: number): HSV {
  const current=normalized(color),h=normalized({...current,h:hue}).h;
  return {...current,h,...(current.s===0||current.v===0?{s:1,v:1}:{})};
}
