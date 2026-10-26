import { parseColor, resolveBackground } from '../core/colors';
import type { RGBA } from '../core/types';

interface Rect { left: number; top: number; width: number; height: number }
const namespace = 'http://www.w3.org/1999/xhtml';
const px = (value: string) => /^\d+(?:\.\d+)?px$/.test(value) ? Number.parseFloat(value) : null;
const zIndex = (value: string) => /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function translation(raw: string): boolean {
  if (raw === 'none') return true;
  const match = /^matrix\(([^()]*)\)$/.exec(raw);
  const values = match?.[1]?.split(',').map(Number);
  return !!values && values.length === 6 && values.every(Number.isFinite)
    && values[0] === 1 && values[1] === 0 && values[2] === 0 && values[3] === 1;
}

/** Restrict the proof to ordinary 2D contexts without compositing or clipping effects. */
function simple(style: CSSStyleDeclaration, allowBoxless = false): boolean {
  return style.opacity === '1' && style.visibility === 'visible' && style.contentVisibility === 'visible'
    && style.animationName === 'none'
    && style.display !== 'none' && (allowBoxless || style.display !== 'contents')
    && style.mixBlendMode === 'normal' && style.filter === 'none' && style.backdropFilter === 'none'
    && style.clipPath === 'none' && style.clip === 'auto' && style.maskImage === 'none'
    && style.perspective === 'none' && style.transformStyle === 'flat' && translation(style.transform)
    && [style.translate, style.rotate, style.scale, style.offsetPath].every(value => value === 'none')
    && ['normal', '1'].includes(style.zoom) && style.contain === 'none' && style.containerType === 'normal'
    && ['auto', 'transform'].includes(style.willChange);
}

function context(element: Element, style: CSSStyleDeclaration): boolean {
  if (style.position === 'fixed' || style.position === 'sticky' || style.transform !== 'none'
    || style.willChange === 'transform' || style.isolation === 'isolate') return true;
  if (zIndex(style.zIndex) === null) return false;
  return style.position !== 'static' || !!element.parentElement
    && ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(getComputedStyle(element.parentElement).display);
}

function containsText(element: Element, style: CSSStyleDeclaration, rect: Rect): boolean {
  if (element.getClientRects().length !== 1) return false;
  const box = element.getBoundingClientRect();
  const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(px);
  if (borders.some(value => value === null)) return false;
  return rect.left >= box.left + borders[3]! && rect.top >= box.top + borders[0]!
    && rect.left + rect.width <= box.right - borders[1]! && rect.top + rect.height <= box.bottom - borders[2]!;
}

interface PaintBudget { remaining: number; limited: boolean }

/** A deliberately inset rectangle stays inside borders and rounded corners. */
function coversPaddingInterior(element: Element, style: CSSStyleDeclaration, rect: Rect): boolean {
  if (element.getClientRects().length !== 1
    || !['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display)) return false;
  const box = element.getBoundingClientRect();
  const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(px);
  const radii = [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomRightRadius, style.borderBottomLeftRadius].map(px);
  if (![box.left, box.top, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0
    || [...borders, ...radii].some(value => value === null)) return false;
  const guard = 1 + Math.max(...radii as number[]);
  return rect.left >= box.left + borders[3]! + guard && rect.top >= box.top + borders[0]! + guard
    && rect.left + rect.width <= box.left + box.width - borders[1]! - guard
    && rect.top + rect.height <= box.top + box.height - borders[2]! - guard;
}

/**
 * Retain an explicitly authored ancestor color for an unverified CSS pair.
 * Displaced offscreen text has no hit-test proof of its visible backdrop; this
 * only establishes a fully covering CSS surface, without inferring canvas paint.
 */
export function enclosingCssBackground(element: Element, rect: Rect): RGBA | null {
  if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return null;
  const controls = ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'METER', 'PROGRESS'];
  const parent = element.parentElement;
  // A nearby control may supply a separate surface. If its narrow association
  // was not proven by the caller, ancestor CSS is not a substitute for it.
  if (parent) {
    if (parent.children.length > 32) return null;
    for (const child of parent.children) if (child !== element && controls.includes(child.tagName)) return null;
  }
  let background: RGBA | null = null, depth = 0;
  for (let owner: Element | null = element; owner; owner = owner.parentElement) {
    if (++depth > 64 || owner.namespaceURI !== namespace || owner.assignedSlot || owner.shadowRoot
      || (owner as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
      || ['DETAILS', 'FIELDSET'].includes(owner.tagName) || controls.includes(owner.tagName)) return null;
    try { if (owner.matches(':modal, :popover-open, :fullscreen')) return null; }
    catch { return null; }
    const style = getComputedStyle(owner);
    if (!simple(style, true)
      || [style.backgroundImage, style.borderImageSource, style.boxShadow, style.textShadow, style.appearance].some(value => value !== 'none')
      || !['none', 'normal'].includes(style.content)) return null;
    // Boxless wrappers do not paint their declared colors. Outer compositing
    // guards still apply after finding the first actual opaque CSS surface.
    if (background || style.display === 'contents') continue;
    const color = parseColor(style.backgroundColor).rgba;
    if (!color) return null;
    if (color.a === 0) continue;
    if (color.a !== 1 || !['border-box', 'padding-box'].includes(style.backgroundClip)
      || !coversPaddingInterior(owner, style, rect)) return null;
    background = color;
  }
  return background;
}

/**
 * A hit-tested opaque ancestor hides lower hit-test layers. Prove coverage of
 * the whole original text fragment before ending the search below it. This
 * establishes no new color and never inspects editable/control contents.
 */
export function opaqueAncestorCoversText(element: Element, candidate: Element, rect: Rect, budget?: PaintBudget): boolean {
  const view = element.ownerDocument?.defaultView;
  if (candidate === element || candidate.namespaceURI !== namespace || !candidate.contains(element)
    || ['HTML', 'BODY', 'DETAILS', 'FIELDSET'].includes(candidate.tagName)
    || ![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0
    || !view || !Number.isFinite(view.innerWidth) || !Number.isFinite(view.innerHeight)
    || rect.left < 0 || rect.top < 0 || rect.left + rect.width > view.innerWidth || rect.top + rect.height > view.innerHeight) return false;
  const paint = getComputedStyle(candidate);
  if (parseColor(paint.backgroundColor).rgba?.a !== 1 || !['border-box', 'padding-box'].includes(paint.backgroundClip)
    || !coversPaddingInterior(candidate, paint, rect)) return false;
  let reached = false, depth = 0;
  for (let owner: Element | null = element; owner; owner = owner.parentElement) {
    if (++depth > 64) return false;
    if (budget && budget.remaining-- <= 0) { budget.limited = true; return false; }
    if (owner.namespaceURI !== namespace || owner.assignedSlot || owner.shadowRoot
      || (owner as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
      || ['DETAILS', 'FIELDSET'].includes(owner.tagName)) return false;
    try { if (owner.matches(':modal, :popover-open, :fullscreen')) return false; }
    catch { return false; }
    const style = getComputedStyle(owner);
    if (!simple(style, owner !== candidate)
      || style.zIndex !== 'auto' && (zIndex(style.zIndex) === null || zIndex(style.zIndex)! < 0)
      || [style.backgroundImage, style.borderImageSource, style.boxShadow, style.textShadow, style.appearance].some(value => value !== 'none')
      || !['none', 'normal'].includes(style.content) || style.outlineStyle !== 'none') return false;
    if (owner === candidate) reached = true;
    else if (!reached) {
      // paintingConditions composes ancestor colors independently of geometry.
      // Only transparent intermediate boxes can reuse that color unchanged.
      if (parseColor(style.backgroundColor).rgba?.a !== 0
        || [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].some(value => px(value) !== 0)) return false;
    }
    if ([style.overflowX, style.overflowY].some(value => value !== 'visible')) {
      if (![style.overflowX, style.overflowY].every(value => ['visible', 'hidden', 'auto', 'scroll'].includes(value))
        || !coversPaddingInterior(owner, style, rect)) return false;
      const box = owner.getBoundingClientRect();
      const { clientLeft, clientTop, clientWidth, clientHeight } = owner;
      if (![clientLeft, clientTop, clientWidth, clientHeight].every(Number.isFinite)
        || clientLeft < 0 || clientTop < 0 || clientWidth <= 0 || clientHeight <= 0) return false;
      // Client dimensions exclude scrollbars; the extra pixel also covers
      // their integer rounding. Border-box coverage alone is insufficient.
      if (style.overflowX !== 'visible' && (rect.left < box.left + clientLeft + 1
        || rect.left + rect.width > box.left + clientLeft + clientWidth - 1)) return false;
      if (style.overflowY !== 'visible' && (rect.top < box.top + clientTop + 1
        || rect.top + rect.height > box.top + clientTop + clientHeight - 1)) return false;
    }
  }
  return reached;
}

/**
 * An opaque, empty negative-z sibling can be the background of pointer-transparent
 * text. Establish its shared stacking context and complete rectangle coverage;
 * never infer paint order from a negative z-index belonging to another context.
 */
export function negativeBackground(element: Element, candidate: Element, rect: Rect): RGBA | null {
  if (candidate.namespaceURI !== namespace || candidate.matches(':popover-open, :fullscreen') || !candidate.parentElement?.contains(element)
    || candidate.contains(element) || element.contains(candidate)) return null;
  const style = getComputedStyle(candidate);
  const color = parseColor(style.backgroundColor);
  const z = zIndex(style.zIndex);
  if (!simple(style) || style.display !== 'block' || !['absolute', 'fixed'].includes(style.position) || z === null || z >= 0
    || color.rgba?.a !== 1 || !['border-box', 'padding-box'].includes(style.backgroundClip)
    || !containsText(candidate, style, rect) || candidate.children.length || candidate.childNodes.length > 32
    || candidate.shadowRoot || (candidate as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
    || !['DIV', 'SPAN', 'SECTION'].includes(candidate.tagName)) return null;
  for (const node of candidate.childNodes) if (node.nodeType !== Node.COMMENT_NODE && !(node.nodeType === Node.TEXT_NODE && (node as Text).length === 0)) return null;
  if ([style.backgroundImage, style.borderImageSource, style.boxShadow, style.textShadow, style.appearance].some(value => value !== 'none')
    || !['none', 'normal'].includes(style.content) || style.outlineStyle !== 'none'
    || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].some(value => value !== '0px')) return null;
  for (const pseudo of ['::before', '::after']) if (!['none', 'normal'].includes(getComputedStyle(candidate, pseudo).content)) return null;

  let boundary: Element | null = null;
  let depth = 0;
  for (let owner: Element | null = candidate.parentElement; owner && ++depth <= 64; owner = owner.parentElement) {
    const parentStyle = getComputedStyle(owner);
    if (owner.namespaceURI !== namespace || !simple(parentStyle) || !owner.contains(element)) return null;
    // Clipping an otherwise covering layer can expose a different backdrop.
    if ([parentStyle.overflowX, parentStyle.overflowY].some(value => value !== 'visible')) return null;
    if (context(owner, parentStyle)) { boundary = owner; break; }
  }
  if (!boundary) return null;
  const layers = [];
  depth = 0;
  for (let owner: Element | null = element; owner && owner !== boundary; owner = owner.parentElement) {
    if (++depth > 64 || owner.namespaceURI !== namespace) return null;
    const foregroundStyle = getComputedStyle(owner);
    if (!simple(foregroundStyle) || foregroundStyle.backgroundImage !== 'none'
      || (context(owner, foregroundStyle) && (zIndex(foregroundStyle.zIndex) ?? 0) < 0)) return null;
    const background = parseColor(foregroundStyle.backgroundColor);
    if (!background.rgba) return null;
    layers.push(background);
  }
  layers.push(color);
  return resolveBackground(layers).rgba;
}

/**
 * A floating hint can share the reserved padding of a sibling input. Its flat
 * CSS background is useful for a labeled CSS-pair comparison, never proof of
 * the complete native control paint. Do not read its value or placeholder.
 */
export function singleSiblingInput(element: Element): Element | null {
  const parent = element.parentElement;
  if (!parent || element.assignedSlot || parent.assignedSlot || parent.shadowRoot
    || (parent as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
    || parent.children.length > 32) return null;
  let candidate: Element | null = null;
  // With no viewport hit test, even a second same-colored or unsupported input
  // makes the association ambiguous. Never inspect values or placeholder text.
  for (const child of parent.children) {
    if (child === element || child.tagName !== 'INPUT') continue;
    if (candidate || child.assignedSlot) return null;
    candidate = child;
  }
  return candidate;
}

export function siblingControlCssBackground(element: Element, candidate: Element, rect: Rect): RGBA | null {
  if (element.namespaceURI !== namespace || candidate.namespaceURI !== namespace || candidate.tagName !== 'INPUT'
    || !element.parentElement || candidate.parentElement !== element.parentElement
    || !['text', 'search'].includes(candidate.getAttribute('type')?.toLowerCase() || 'text')) return null;
  const text = getComputedStyle(element), control = getComputedStyle(candidate);
  if (text.position !== 'absolute' || text.pointerEvents !== 'none' || !['auto', '0'].includes(text.zIndex)
    || text.backgroundImage !== 'none' || parseColor(text.backgroundColor).rgba?.a !== 0
    || control.position !== 'static' || !['block', 'inline-block'].includes(control.display)
    || control.appearance !== 'none' || control.backgroundImage !== 'none'
    || !['border-box', 'padding-box'].includes(control.backgroundClip)
    || candidate.matches(':popover-open, :fullscreen') || candidate.getClientRects().length !== 1) return null;
  let depth = 0;
  for (let owner: Element | null = element; owner; owner = owner.parentElement) {
    // Boxless outer wrappers do not change this shared input/hint geometry;
    // keep checking their inherited effects. The hint and common parent need boxes.
    const allowBoxless = owner !== element && owner !== element.parentElement;
    if (++depth > 64 || owner.namespaceURI !== namespace || !simple(getComputedStyle(owner), allowBoxless)) return null;
  }
  if (!simple(control)) return null;
  const color = parseColor(control.backgroundColor).rgba;
  if (color?.a !== 1) return null;
  const box = candidate.getBoundingClientRect();
  const borders = [control.borderTopWidth, control.borderRightWidth, control.borderBottomWidth, control.borderLeftWidth].map(px);
  const padding = [control.paddingTop, control.paddingRight, control.paddingBottom, control.paddingLeft].map(px);
  const radii = [control.borderTopLeftRadius, control.borderTopRightRadius, control.borderBottomRightRadius, control.borderBottomLeftRadius].map(px);
  if ([...borders, ...padding, ...radii].some(value => value === null)
    || ![box.left, box.top, box.width, box.height, rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return null;
  const guard = 1 + Math.max(...radii as number[]);
  const left = box.left + borders[3]!, right = box.left + box.width - borders[1]!;
  const top = box.top + borders[0]!, bottom = box.top + box.height - borders[2]!;
  if (rect.left < left + guard || rect.left + rect.width > right - guard
    || rect.top < top + guard || rect.top + rect.height > bottom - guard) return null;
  // Restrict this fallback to horizontal padding, away from input text layout.
  if (rect.left + rect.width > left + padding[3]! - 1 && rect.left < right - padding[1]! + 1) return null;
  return color;
}
