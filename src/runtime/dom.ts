import { parseColor, resolveBackground } from '../core/colors';
import { documentCanvasColor } from './document-canvas';
import { evaluateContrast, evaluateFontSize } from '../core/contrast';
import { compositeGradientRange, parseLinearGradient, splitBackgroundLayers } from '../core/gradients';
import type { GradientBackgroundLayer } from '../core/gradients';
import { STYLE_PROPERTIES } from '../core/exports';
import { randomId } from './id';
import { pseudoIsSeparated } from './pseudo-geometry';
import { negativeBackground, opaqueAncestorCoversText, siblingControlCssBackground, singleSiblingInput } from './background-geometry';
import { coveringOpaqueGradient } from './background-image-geometry';
import { unclippedTextRects } from './text-visibility';
import { visibleTextSampleRect } from './text-sampling';
import { hasEmptyOverflow, mayEscapeOverflow } from './empty-overflow';
import { combineTextExcerpts, permitsTextExcerpt, readTextExcerpt } from './text-excerpt';
import type { BackgroundRange, ColorValue, DocumentIdentity, Settings, Snapshot, TextRun } from '../core/types';

export const OVERLAY_ATTRIBUTE = 'data-style-inspector-overlay';
const PROPERTIES = STYLE_PROPERTIES;
const ownElements = new WeakSet<Element>();

/** Keep ownership after removal or attribute changes; page lookalikes are not ours. */
export function registerOwnElement(element: Element) { ownElements.add(element); }

/** Never use selector lookup to resurrect an element: refs identify actual DOM objects. */
export class ElementRegistry {
  private ids = new WeakMap<Element, string>();
  private elements = new Map<string, Element>();
  private textIds = new WeakMap<Text, number>();
  private serial = 0;
  private textSerial = 0;
  constructor(private readonly token: string) {}
  reference(element: Element): string {
    let id = this.ids.get(element);
    if (!id) {
      id = `${this.token}:e${++this.serial}`;
      this.ids.set(element, id);
      this.elements.set(id, element);
    }
    return id;
  }
  /** Run identity follows the actual Text object and its current owner, not its ordinal. */
  textReference(element: Element, node: Text): string {
    let id = this.textIds.get(node);
    if (id === undefined) {
      id = ++this.textSerial;
      this.textIds.set(node, id);
    }
    return `${this.reference(element)}:node${id}`;
  }
  get(id: string): Element | null {
    const element = this.elements.get(id);
    return element?.isConnected ? element : null;
  }
  /** Keep only references that a current audit, selection or preview can use. */
  retain(references: ReadonlySet<string>) {
    for (const [id, element] of this.elements) {
      if (references.has(id) && element.isConnected) continue;
      this.elements.delete(id);
      this.ids.delete(element);
    }
  }
  clear() { this.ids = new WeakMap(); this.textIds = new WeakMap(); this.elements.clear(); }
}

export function viewport() {
  return { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio };
}

export function isOwnElement(element: Element): boolean {
  for (let current: Element | null = element; current; current = current.parentElement) if (ownElements.has(current)) return true;
  return false;
}

/** Recognize empty clips without guessing at arbitrary shapes or viewport visibility. */
function hasEmptyClip(style: CSSStyleDeclaration): boolean {
  // Boxless ancestors do not establish a clipping box for their descendants.
  if (style.display === 'contents') return false;
  // Range/client rectangles still exist for visually hidden accessible labels.
  // Opposing percentage insets that consume the reference box leave no paint.
  const inset = style.clipPath?.match(/^inset\(([^()]*)\)(?:\s+(?:border|padding|content|margin|fill|stroke|view)-box)?$/);
  if (inset) {
    const values = inset[1]!.split(/\s+round\s+/)[0]!.trim().split(/\s+/);
    if (values.length >= 1 && values.length <= 4) {
      const percentages = values.map(value => {
        if (/^[+-]?(?:\d*\.)?\d+%$/.test(value)) {
          const number = Number.parseFloat(value);
          return Number.isFinite(number) ? number : null;
        }
        return /^[+-]?0(?:\.0+)?(?:px)?$/.test(value) ? 0 : null;
      });
      const [top, right = top, bottom = top, left = right] = percentages;
      if ((top != null && bottom != null && top + bottom >= 100)
        || (left != null && right != null && left + right >= 100)) return true;
    }
  }
  // Legacy clip only applies to absolutely positioned boxes. An auto edge
  // does not prevent a different, fully known axis from having zero area.
  if (style.position !== 'absolute' && style.position !== 'fixed') return false;
  const rect = style.clip?.match(/^rect\(([^()]*)\)$/);
  if (!rect) return false;
  const values = rect[1]!.trim().split(/\s*,\s*|\s+/);
  if (values.length !== 4) return false;
  const [top, right, bottom, left] = values.map(value => {
    if (!/^[+-]?(?:\d*\.)?\d+(?:px)?$/.test(value)) return null;
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? number : null;
  });
  return (top != null && bottom != null && bottom <= top)
    || (left != null && right != null && right <= left);
}

/** Follow the accessible rendered ancestry of light-DOM content assigned to slots.
 * This does not discover or measure additional text inside shadow roots.
 */
function renderedParent(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const parent = element.parentNode;
  return parent?.nodeType === 11 ? (parent as ShadowRoot).host ?? null : null;
}

function inTopLayer(element: Element): boolean {
  try { return element.matches(':modal, :popover-open, :fullscreen'); }
  catch { return true; } // Unknown painting order cannot prove ancestor occlusion.
}

/** The browser keeps layout boxes for collapsed disclosure contents. */
function hiddenDetailsContent(element: Element): boolean {
  if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.tagName !== 'DETAILS') return false;
  // Newer Firefox allows author overrides on this anonymous content wrapper.
  // A boxless wrapper cannot enforce content-visibility; older Firefox exposes
  // no pseudo style and uses the native open state instead.
  const content = getComputedStyle(element, '::details-content');
  if (content.display === 'none') return true;
  if (content.display === 'contents') return false;
  if (content.contentVisibility === 'hidden') {
    // A non-replaced inline wrapper cannot apply size/layout containment.
    // Unknown display types are not evidence that their text is hidden.
    return ['block', 'flow-root', 'inline-block', 'flex', 'inline-flex', 'grid', 'inline-grid'].includes(content.display);
  }
  if (['visible', 'auto'].includes(content.contentVisibility)) return false;
  return !(element as HTMLDetailsElement).open;
}

function hasRenderedBox(element: Element, checkVisibility = true): boolean {
  if (isOwnElement(element) || ['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD'].includes(element.tagName)) return false;
  const style = getComputedStyle(element);
  if (checkVisibility && ['hidden', 'collapse'].includes(style.visibility)) return false;
  // Keep normal offscreen/content-visibility:auto text in scope. The default
  // native check detects skipped anonymous boxes without testing the viewport,
  // opacity or inherited visibility. display:contents needs the ancestry below.
  if (style.display !== 'contents' && element.checkVisibility?.() === false) return false;
  let ancestorOverflowApplies = true, ancestorPaintApplies = true;
  let branch: Element | null = null;
  for (let current: Element | null = element; current; current = renderedParent(current)) {
    if (branch && hiddenDetailsContent(current)) {
      const summary = Array.from(current.children).find(child => child.namespaceURI === current!.namespaceURI && child.tagName === 'SUMMARY');
      if (branch !== summary) return false;
    }
    const ancestor = getComputedStyle(current);
    if (ancestor.display === 'none' || ancestor.display !== 'contents' && ancestor.contentVisibility === 'hidden') return false;
    // Boxless slots/wrappers have no opacity or clipping surface. Top-layer
    // descendants escape ancestor paint effects, but not display:none.
    if (ancestorPaintApplies && ancestor.display !== 'contents'
      && (Number.parseFloat(ancestor.opacity) === 0 || hasEmptyClip(ancestor))) return false;
    if (ancestorOverflowApplies && hasEmptyOverflow(current, ancestor)) return false;
    if (mayEscapeOverflow(current, ancestor)) ancestorOverflowApplies = false;
    if (ancestor.display !== 'contents' && inTopLayer(current)) ancestorPaintApplies = false;
    branch = current;
  }
  if (style.display === 'contents') return true; // Individual text ranges below determine actual rendering.
  return element.getClientRects().length > 0;
}

export function isRendered(element: Element): boolean { return hasRenderedBox(element); }

function placeholderStyle(element: Element): CSSStyleDeclaration | null {
  // The browser exposes this state without reading form values or hint text.
  return element.tagName === 'INPUT' && element.matches(':placeholder-shown') ? getComputedStyle(element, '::placeholder') : null;
}

function hiddenPlaceholder(element: Element, style: CSSStyleDeclaration): boolean {
  return element.matches('[placeholder=""]') || style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || numeric(style.opacity) === 0;
}

/** A native click target may have no painted label, while its box still paints. */
function hiddenButtonText(element: Element): boolean {
  if (element.tagName !== 'INPUT' || !['button', 'submit', 'reset'].includes((element.getAttribute('type') ?? 'text').toLowerCase())) return false;
  const style = getComputedStyle(element);
  const rawFill = style.getPropertyValue?.('-webkit-text-fill-color');
  const fill = rawFill?.toLowerCase() === 'currentcolor' ? style.color : rawFill;
  if (!fill || parseColor(fill).rgba?.a !== 0 || style.textShadow !== 'none' || style.textEmphasisStyle !== 'none'
    || style.textDecorationLine !== 'none' || /\btext\b/.test(style.backgroundClip ?? '')
    || /\btext\b/.test(style.getPropertyValue?.('-webkit-background-clip') ?? '')) return false;
  const stroke = style.getPropertyValue?.('-webkit-text-stroke-width');
  // Unknown stroke/fill metadata stays in scope. Never infer invisibility from
  // a small nonzero opacity, nor inspect the button's value or other form text.
  return !!stroke && /^0(?:\.0+)?px$/.test(stroke);
}

export interface TextRunGeometry {
  rects: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>[];
  limited: boolean;
  /** Local identity only; never serialized or used to read page text. */
  identityNode?: Text;
  /** Local reference only, never serialized; absent for audits and picker previews. */
  textNode?: Text;
}

const MAX_TEXT_RECTS = 32;

export function directTextCount(element: Element, maximum = Infinity, geometry?: TextRunGeometry[], includeText = false): number {
  // Enumerated contenteditable values are case-insensitive and include
  // plaintext-only. Exclude editor subtrees, including nested false islands,
  // before checking whitespace; a standalone false declaration remains text.
  if (maximum <= 0 || element.ownerDocument?.designMode?.toLowerCase() === 'on'
    || (element as HTMLElement).isContentEditable === true
    || element.closest('textarea,[contenteditable="true" i],[contenteditable="plaintext-only" i],[contenteditable=""]')
    || element.tagName !== 'INPUT' && element.closest('[role~="textbox" i],[role~="combobox" i],[role~="searchbox" i]')) return 0;
  const rendered = isRendered(element);
  // An internal slot may override a host's inherited visibility for its own
  // assigned Text nodes. Other hiding effects still apply to the whole host.
  if (!rendered && (!element.shadowRoot || !hasRenderedBox(element, false))) return 0;
  if (element.tagName === 'INPUT') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (['checkbox', 'radio', 'range', 'color', 'file', 'image', 'hidden'].includes(type)) return 0;
    if (hiddenButtonText(element)) return 0;
    const placeholder = placeholderStyle(element);
    return placeholder && hiddenPlaceholder(element, placeholder) ? 0 : 1; // Style metadata only; never read values.
  }
  let count = 0;
  const captureText = includeText && permitsTextExcerpt(element);
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.TEXT_NODE || !child.nodeValue?.trim()) continue;
    if (hiddenDetailsContent(element)) continue;
    // A host's own box can be visible while its light-DOM text is assigned to
    // a hidden internal slot. Text uses that slot's inherited visibility.
    const slot = (child as Text).assignedSlot;
    if (slot ? !isRendered(slot) : !rendered) continue;
    const range = document.createRange();
    range.selectNodeContents(child);
    const measured: TextRunGeometry = { rects: [], limited: false };
    let visible = false;
    for (const rect of range.getClientRects()) {
      if (rect.width <= 0 || rect.height <= 0) continue;
      visible = true;
      if (measured.rects.length >= MAX_TEXT_RECTS) { measured.limited = true; break; }
      measured.rects.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
    }
    if (visible && !measured.limited) measured.rects = unclippedTextRects(element, child as Text, measured.rects);
    if (visible && measured.rects.length) {
      measured.identityNode = child as Text;
      if (captureText) measured.textNode = child as Text;
      geometry?.push(measured);
      if (++count >= maximum) break;
    }
  }
  return count;
}

export function elementLabel(element: Element): string {
  // Generated display label only, deliberately independent of arbitrary page IDs/classes.
  const siblings = element.parentElement ? [...element.parentElement.children].filter(item => item.tagName === element.tagName) : [element];
  return `${element.localName}:nth-of-type(${siblings.indexOf(element) + 1})`;
}

function numeric(raw: string): number | null {
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}

function boxHasNoPaint(style: CSSStyleDeclaration): boolean {
  if (!style.display || style.display.includes('list-item')) return false;
  if (parseColor(style.backgroundColor).rgba?.a !== 0) return false;
  if ([style.backgroundImage, style.borderImageSource, style.boxShadow, style.textShadow, style.filter, style.backdropFilter, style.appearance].some(value => value !== 'none')) return false;
  const unpaintedStroke = (line: string, width: string, color: string): boolean =>
    Boolean(line) && (['none', 'hidden'].includes(line) || numeric(width) === 0 || parseColor(color).rgba?.a === 0);
  for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
    if (!unpaintedStroke(style[`border${side}Style`], style[`border${side}Width`], style[`border${side}Color`])) return false;
  }
  return unpaintedStroke(style.outlineStyle, style.outlineWidth, style.outlineColor);
}

function emptyPseudoHasNoPaint(style: CSSStyleDeclaration): boolean {
  return ['""', "''"].includes(style.content) && boxHasNoPaint(style);
}

function paintingConditions(element: Element, geometry: readonly TextRunGeometry[]): { background: ColorValue; effectiveBackground: ReturnType<typeof resolveBackground>['rgba']; backgroundRange?: BackgroundRange; pseudos: { owner: Element; pseudo: string; style: CSSStyleDeclaration }[]; reasons: string[]; ownOpaqueBackground: boolean } {
  const reasons = new Set<string>();
  const pseudos: { owner: Element; pseudo: string; style: CSSStyleDeclaration }[] = [];
  const layers: ColorValue[] = [];
  const gradientLayers: GradientBackgroundLayer[] = [];
  let hasGradient = false, unsupportedImage = false, gradientLayersLimited = false;
  const ownStyle = getComputedStyle(element);
  const own = parseColor(ownStyle.backgroundColor);
  let backgroundVisible = true;
  let reachedDocumentRoot = false;
  let knownCanvasPath = true;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (current === element.ownerDocument?.documentElement) reachedDocumentRoot = true;
    // Light-DOM ancestors cannot establish a shadow surface or a top-layer
    // backdrop between this text and the document canvas.
    if (current.assignedSlot || current.shadowRoot
      || (current as Element & { readonly openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
      || inTopLayer(current)) knownCanvasPath = false;
    const style = getComputedStyle(current);
    // display:contents has no box to paint its declared background. Its
    // children still inherit text styles and may paint generated pseudo boxes.
    if (backgroundVisible && style.display !== 'contents') {
      const coveringImage = style.backgroundImage !== 'none' ? coveringOpaqueGradient(current, element, style, geometry) : null;
      const firstStop = coveringImage?.[0];
      const solidImage = firstStop && coveringImage!.every(stop => (['r', 'g', 'b', 'a'] as const).every(channel => stop[channel] === firstStop[channel])) ? firstStop : null;
      const background = solidImage ? { raw: style.backgroundImage, rgba: solidImage } : parseColor(style.backgroundColor);
      layers.push(background);
      const gradients: GradientBackgroundLayer['gradients'] = [];
      if (coveringImage && !solidImage) {
        gradients.push(coveringImage); hasGradient = true;
      } else if (style.backgroundImage !== 'none' && !solidImage) {
        const images = splitBackgroundLayers(style.backgroundImage);
        if (!images) unsupportedImage = true;
        else for (const image of images) {
          if (image === 'none') continue;
          const stops = parseLinearGradient(image);
          if (stops) { gradients.push(stops); hasGradient = true; }
          else unsupportedImage = true;
        }
        if (style.backgroundBlendMode && style.backgroundBlendMode.split(',').some(mode => mode.trim() !== 'normal')) reasons.add('blend-mode');
      }
      // Stop retaining image data beyond the compositor's bounded input size.
      if (gradientLayers.length < 300) gradientLayers.push({ color: background, gradients, ...(coveringImage && !solidImage ? { coveringTopImage: true as const } : {}) });
      else gradientLayersLimited = true;
      // An opaque nearer background hides backgrounds painted behind it.
      // Ancestor group effects below still affect the composed subtree.
      if (coveringImage || background.rgba?.a === 1) backgroundVisible = false;
    }
    if (numeric(style.opacity) !== 1) reasons.add('group-opacity');
    if (style.filter !== 'none' || (style.backdropFilter && style.backdropFilter !== 'none')) reasons.add('filter');
    if (style.mixBlendMode !== 'normal') reasons.add('blend-mode');
    if (style.textShadow !== 'none') reasons.add('text-shadow');
    for (const pseudo of ['::before', '::after']) {
      const pseudoStyle = getComputedStyle(current, pseudo);
      // Empty generated content can paint an overlay. Ignore it only when all
      // of its supported painting sources are demonstrably absent.
      if (pseudoStyle.content && !['none', 'normal'].includes(pseudoStyle.content) && pseudoStyle.display !== 'none'
        && !['hidden', 'collapse'].includes(pseudoStyle.visibility) && numeric(pseudoStyle.opacity) !== 0 && !emptyPseudoHasNoPaint(pseudoStyle)) {
        if (pseudos.length < 64) pseudos.push({ owner: current, pseudo, style: pseudoStyle });
        else reasons.add('pseudo-element');
      }
    }
  }
  if (backgroundVisible && reachedDocumentRoot && knownCanvasPath) {
    const canvas = documentCanvasColor(element.ownerDocument, registerOwnElement);
    if (canvas) {
      layers.push(canvas);
      if (gradientLayers.length < 300) gradientLayers.push({ color: canvas, gradients: [] });
      else gradientLayersLimited = true;
    }
  }
  const backgroundRange = hasGradient && !unsupportedImage && !gradientLayersLimited ? compositeGradientRange(gradientLayers) ?? undefined : undefined;
  // A covering opaque image supplies its own backdrop; colors hidden underneath
  // it do not need to resolve to establish the conservative gradient bounds.
  const resolved = backgroundRange ? { rgba: null } : resolveBackground(layers);
  if ('reason' in resolved && resolved.reason) reasons.add(resolved.reason);
  if (unsupportedImage || (hasGradient && !backgroundRange)) reasons.add('background-image-or-gradient');
  return { background: own, effectiveBackground: backgroundRange ? null : resolved.rgba, ...(backgroundRange ? { backgroundRange } : {}), pseudos, reasons: [...reasons], ownOpaqueBackground: ownStyle.display !== 'contents' && own.rgba?.a === 1 && ownStyle.backgroundImage === 'none' };
}

function candidateMayPaint(candidate: Element, textRect: TextRunGeometry['rects'][number], budget: { remaining: number; limited: boolean }): boolean {
  const pending = [candidate];
  while (pending.length) {
    if (budget.remaining-- <= 0) { budget.limited = true; return true; }
    const current = pending.pop()!;
    const style = getComputedStyle(current);
    if (style.display === 'none' || numeric(style.opacity) === 0) continue;
    // A hit-test box may be just transparent padding around a smaller icon.
    // Prove the light-DOM subtree cannot paint here; uncertain sources remain
    // manual, including effects that can extend outside descendant bounds.
    if (!boxHasNoPaint(style) || style.mixBlendMode !== 'normal' || !['none', 'normal'].includes(style.content)
      || current.shadowRoot || (current as Element & { readonly openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
      || ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'TEXTAREA', 'SELECT', 'METER', 'PROGRESS'].includes(current.tagName)) return true;
    for (const pseudo of ['::before', '::after']) {
      const pseudoStyle = getComputedStyle(current, pseudo);
      if (pseudoStyle.content && !['none', 'normal'].includes(pseudoStyle.content) && pseudoStyle.display !== 'none'
        && !['hidden', 'collapse'].includes(pseudoStyle.visibility) && numeric(pseudoStyle.opacity) !== 0 && !emptyPseudoHasNoPaint(pseudoStyle)) return true;
    }
    if (current instanceof SVGElement) {
      const rect = current.getBoundingClientRect();
      const separate = rect.left + rect.width <= textRect.left || rect.left >= textRect.left + textRect.width
        || rect.top + rect.height <= textRect.top || rect.top >= textRect.top + textRect.height;
      // An SVG viewport with clipped overflow contains even pointer-transparent
      // descendants and strokes. Other SVG geometry cannot prove empty paint.
      if (current.localName === 'svg' && separate && style.overflowX === 'hidden' && style.overflowY === 'hidden') continue;
      return true;
    }
    if (current.namespaceURI !== 'http://www.w3.org/1999/xhtml') return true;
    for (const child of current.childNodes) {
      if (budget.remaining-- <= 0) { budget.limited = true; return true; }
      if (child.nodeType === Node.TEXT_NODE) {
        // Empty/collapsed text nodes in transparent feedback wrappers do not
        // paint. Inspect layout only, without reading unrelated text contents.
        // Firefox 142 can return a zero-size rectangle even for an empty node.
        if ((child as Text).length === 0) continue;
        if (!document.createRange) return true;
        const range = document.createRange();
        range.selectNodeContents(child);
        if (range.getClientRects().length !== 0) return true;
      }
    }
    for (const child of current.children) {
      if (pending.length >= budget.remaining) { budget.limited = true; return true; }
      pending.push(child);
    }
  }
  return false;
}

/** Offscreen pointer handling must not penalize ordinary, undisplaced text flow. */
function hasInFlowBackground(element: Element, rect: TextRunGeometry['rects'][number]): boolean {
  let examined = 0;
  for (let current: Element | null = element; current; current = current.parentElement) {
    if (++examined > 300 || current.namespaceURI !== 'http://www.w3.org/1999/xhtml') return false;
    const style = getComputedStyle(current);
    // An opaque positioned container still paints its own children's background.
    // Only transparent layers before that boundary can move text above siblings.
    if (style.display !== 'contents' && parseColor(style.backgroundColor).rgba?.a === 1) {
      if (!['border-box', 'padding-box'].includes(style.backgroundClip) || current.getClientRects().length !== 1) return false;
      const bounds = current.getBoundingClientRect();
      const borders = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth].map(numeric);
      if (borders.some(value => value === null || value < 0)) return false;
      return rect.left >= bounds.left + borders[3]! && rect.top >= bounds.top + borders[0]!
        && rect.left + rect.width <= bounds.left + bounds.width - borders[1]!
        && rect.top + rect.height <= bounds.top + bounds.height - borders[2]!;
    }
    // Resolved style can retain float:left/right on a flex/grid item even
    // though that declaration does not float its box. Require a direct known
    // layout parent; slotting can make the light-DOM parent misleading.
    const parent = current.parentElement;
    const ignoredFloat = ['left', 'right'].includes(style.cssFloat) && !!parent
      && parent.namespaceURI === 'http://www.w3.org/1999/xhtml' && !current.assignedSlot
      // These elements can insert anonymous content boxes between DOM children
      // and their authored layout; do not infer item status from that parent.
      && !['DETAILS', 'FIELDSET'].includes(parent.tagName)
      && !parent.shadowRoot && !(parent as Element & { readonly openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot
      && ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(getComputedStyle(parent).display);
    if (!['static', 'relative'].includes(style.position) || style.cssFloat !== 'none' && !ignoredFloat
      || [style.transform, style.translate, style.rotate, style.scale, style.perspective, style.offsetPath].some(value => value !== 'none')
      || !['1', 'normal'].includes(style.zoom)) return false;
    if (style.position === 'relative' && [style.top, style.right, style.bottom, style.left].some(value => value !== 'auto' && numeric(value) !== 0)) return false;
    if ([style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].some(value => numeric(value) === null || numeric(value)! < 0)) return false;
  }
  return false;
}

function overlapConditions(element: Element, geometry?: TextRunGeometry): { reasons: string[]; background?: NonNullable<TextRun['effectiveBackground']>; cssBackground?: NonNullable<TextRun['effectiveBackground']> } {
  const reasons = geometry?.limited ? ['overlap-sampling-limit'] : [];
  const budget = { remaining: 64, limited: false };
  let background: NonNullable<TextRun['effectiveBackground']> | undefined;
  let cssBackground: NonNullable<TextRun['effectiveBackground']> | undefined;
  let cssResolvedRects = 0;
  let offscreenInput: Element | null | undefined;
  let resolvedRects = 0, examinedRects = 0;
  // A stretched element's box can overlap a neighbour below its actual text.
  // Controls have no direct text-node ranges and retain their box sample.
  for (const originalRect of geometry?.rects ?? [element.getBoundingClientRect()]) {
    const rect = geometry ? visibleTextSampleRect(element, originalRect) : originalRect;
    examinedRects++;
    const centerX = rect.left + rect.width / 2, centerY = rect.top + rect.height / 2;
    const inViewport = centerX >= 0 && centerX < innerWidth && centerY >= 0 && centerY < innerHeight;
    if (!inViewport) {
      const style = getComputedStyle(element);
      // Offscreen floating labels have no hit-test evidence for a sibling
      // surface. Normal text flow can still use its enclosing opaque background.
      if (style.pointerEvents === 'none' && parseColor(style.backgroundColor).rgba?.a !== 1 && !hasInFlowBackground(element, rect)) {
        reasons.push('layered-background');
        // A DOM association can supply only the same unverified CSS pair used
        // onscreen. It cannot establish actual paint order outside the viewport.
        if (offscreenInput === undefined) offscreenInput = singleSiblingInput(element);
        const css = offscreenInput && siblingControlCssBackground(element, offscreenInput, rect);
        if (css && (!cssBackground || (['r', 'g', 'b', 'a'] as const).every(key => cssBackground![key] === css[key]))) {
          cssBackground = css; cssResolvedRects++;
        }
        // Continue through every fragment: one covered line cannot establish
        // a CSS pair for another line outside the reserved input padding.
      }
    }
    if (inViewport && document.elementsFromPoint) {
      const painted = document.elementsFromPoint(centerX, centerY).filter(item => !isOwnElement(item));
      const index = painted.indexOf(element);
      if (index > 0 && painted.slice(0, index).some(item => !element.contains(item) && !item.contains(element) && candidateMayPaint(item, rect, budget))) {
        reasons.push('overlapping-element');
        break;
      }
      // Pointer-transparent text can float over a sibling input or another
      // separately painted surface. Its ancestor colors do not establish the
      // visible background, and absence from hit testing does not prove clear
      // paint. A narrow sibling-input fallback supplies only a CSS color pair;
      // the layered-page verdict stays unverified and control contents stay unread.
      if (index < 0) {
        for (const item of painted) {
          // A covering ancestor hides later hit-test entries. Earlier foreign
          // paint is still checked normally; use the full original fragment,
          // not a clipped center sample, to prove this boundary for each line.
          if (item.contains(element) && opaqueAncestorCoversText(element, item, originalRect, budget)) break;
          if (element.contains(item) || item.contains(element) || !candidateMayPaint(item, rect, budget)) continue;
          const resolved = negativeBackground(element, item, rect);
          if (!resolved || (background && (['r', 'g', 'b', 'a'] as const).some(key => background![key] !== resolved[key]))) {
            reasons.push('layered-background');
            const css = siblingControlCssBackground(element, item, rect);
            if (css && (!cssBackground || (['r', 'g', 'b', 'a'] as const).every(key => cssBackground![key] === css[key]))) {
              cssBackground = css; cssResolvedRects++;
            }
          } else { background = resolved; resolvedRects++; }
          // A proven opaque backdrop covers lower hit-test layers, including
          // unrelated content scrolled underneath a fixed header.
          break;
        }
      }
    }
  }
  if (budget.limited && !reasons.includes('overlap-sampling-limit')) reasons.push('overlap-sampling-limit');
  if (background && resolvedRects !== examinedRects) reasons.push('layered-background');
  return { reasons, ...(background ? { background } : {}),
    ...(cssBackground && cssResolvedRects === examinedRects && !geometry?.limited ? { cssBackground } : {}) };
}

export function measureRuns(element: Element, registry: ElementRegistry, settings: Settings, count?: number, geometry: TextRunGeometry[] = []): TextRun[] {
  count ??= directTextCount(element, Infinity, geometry);
  if (!count || hiddenButtonText(element)) return [];
  const placeholder = placeholderStyle(element);
  if (placeholder && hiddenPlaceholder(element, placeholder)) return [];
  const style = placeholder ?? getComputedStyle(element);
  let foreground = parseColor(style.color);
  const paint = paintingConditions(element, geometry.slice(0, count));
  const fontSizeCssPx = numeric(style.fontSize);
  const fontWeight = style.fontWeight === 'bold' ? 700 : style.fontWeight === 'normal' ? 400 : numeric(style.fontWeight);
  const reasons = [...paint.reasons];
  let foregroundSource: TextRun['foregroundSource'];
  const fill = style.getPropertyValue?.('-webkit-text-fill-color')?.trim();
  if (fill && fill.toLowerCase() !== 'currentcolor') {
    const painted = parseColor(fill).rgba;
    // Measure the actual glyph fill; a foreground correction will explicitly
    // reset the fill to currentColor before relying on the new color property.
    if (!painted || !foreground.rgba || (['r', 'g', 'b', 'a'] as const).some(channel => painted[channel] !== foreground.rgba![channel])) {
      foreground = parseColor(fill);
      foregroundSource = 'text-fill';
    }
  }
  if (!foreground.rgba) reasons.push(foreground.reason ?? 'unsupported-color');
  const stroke = style.getPropertyValue?.('-webkit-text-stroke-width')?.trim();
  if (stroke && !/^0(?:\.0+)?px$/.test(stroke)) reasons.push('text-stroke');
  if (placeholder) {
    const opacity = numeric(placeholder.opacity);
    if (opacity === null || opacity < 0 || opacity > 1) reasons.push('group-opacity');
    else if (foreground.rgba) foreground.rgba = { ...foreground.rgba, a: foreground.rgba.a * opacity };
    // Alpha is applied to the glyph alone only when the pseudo-element has no
    // background of its own. Otherwise the composed placeholder needs review.
    const background = parseColor(placeholder.backgroundColor);
    if (background.rgba?.a !== 0 || placeholder.backgroundImage !== 'none') reasons.push('pseudo-element');
    if (placeholder.filter !== 'none' || (placeholder.backdropFilter && placeholder.backdropFilter !== 'none')) reasons.push('filter');
    if (placeholder.mixBlendMode !== 'normal') reasons.push('blend-mode');
    if (placeholder.textShadow !== 'none') reasons.push('text-shadow');
  } else if (element.tagName === 'INPUT') reasons.push('control-text-availability-unknown');
  if (element instanceof SVGElement) reasons.push('svg-text');
  const disabled = element.matches(':disabled');
  const notApplicable = disabled ? 'inactive-control' : undefined;
  const elementRef = registry.reference(element);
  const selector = elementLabel(element);
  return Array.from({ length: count }, (_, index) => {
    const overlap = overlapConditions(element, geometry[index]);
    const runReasons = [...reasons, ...overlap.reasons];
    if (paint.pseudos.some(item => !pseudoIsSeparated(item.owner, element, item.pseudo, item.style, geometry[index]))) runReasons.push('pseudo-element');
    const unresolvedLayer = runReasons.includes('layered-background');
    const effectiveBackground = unresolvedLayer ? overlap.cssBackground ?? null : overlap.background ?? paint.effectiveBackground;
    const backgroundRange = unresolvedLayer || overlap.background ? undefined : paint.backgroundRange;
    // Controls have no Text node. Keep their synthetic IDs in a disjoint
    // namespace so they cannot alias a measured DOM Text object's identity.
    const textNode = geometry[index]?.identityNode;
    return {
      id: textNode ? registry.textReference(element, textNode) : `${elementRef}:text${index + 1}`, elementRef, tagName: element.localName, selector,
      ...(placeholder ? { textSource: 'placeholder' as const } : {}),
      ...(foregroundSource ? { foregroundSource } : {}),
      ...(fill ? { textFillPresent: true } : {}),
      fontSizeCssPx, fontWeight, foreground, background: paint.background, effectiveBackground,
      ...(backgroundRange ? { backgroundRange } : {}),
      ownOpaqueBackground: paint.ownOpaqueBackground, reasons: runReasons, notApplicable,
      contrast: evaluateContrast({ foreground: foreground.rgba, background: effectiveBackground, backgroundRange, fontSizeCssPx, fontWeight, target: settings.contrastTarget, reasons: runReasons, notApplicable }),
      fontSize: evaluateFontSize(fontSizeCssPx, notApplicable),
    };
  });
}

export function measureSnapshot(element: Element, identity: DocumentIdentity, registry: ElementRegistry, settings: Settings, options: { includeText?: boolean } = {}): Snapshot {
  if (!element.isConnected) throw new Error('element-removed');
  const style = getComputedStyle(element);
  const styles: Snapshot['styles'] = { colors: {}, typography: {}, layout: {} };
  for (const group of Object.keys(PROPERTIES) as (keyof typeof PROPERTIES)[]) {
    for (const property of PROPERTIES[group]) styles[group][property] = style.getPropertyValue(property).slice(0, 1024);
  }
  const textRuns: TextRun[] = [];
  const textParts: { node: Text; excerpt: NonNullable<TextRun['textExcerpt']> }[] = [];
  const textBudget = { remaining: 50_000 };
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
  let current: Element | null = element;
  let examined = 0;
  let truncatedText = false;
  while (current && examined++ < 300 && textRuns.length < 100) {
    const remaining = 100 - textRuns.length;
    const geometry: TextRunGeometry[] = [];
    const count = directTextCount(current, remaining + 1, geometry, options.includeText);
    truncatedText ||= count > remaining;
    const runs = measureRuns(current, registry, settings, Math.min(count, remaining), geometry);
    if (options.includeText) for (const [index, run] of runs.entries()) {
      const node = geometry[index]?.textNode;
      if (node) {
        run.textExcerpt = readTextExcerpt(node, textBudget);
        textParts.push({ node, excerpt: run.textExcerpt });
      }
    }
    textRuns.push(...runs);
    current = walker.nextNode() as Element | null;
  }
  const rect = element.getBoundingClientRect();
  // Runs are grouped by element. The combined excerpt instead follows DOM text order.
  textParts.sort((a, b) => a.node.compareDocumentPosition(b.node) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);
  return {
    id: randomId(), document: identity, elementRef: registry.reference(element), tagName: element.localName,
    selector: elementLabel(element), measuredAt: new Date().toISOString(), viewport: viewport(), stale: false,
    reasons: [...(current || truncatedText ? ['selection-text-limit'] : []), ...(style.transform !== 'none' ? ['transformed-css-size'] : [])],
    styles, textRuns,
    ...(options.includeText ? { textExcerpt: combineTextExcerpts(textParts.map(part => part.excerpt), Boolean(current || truncatedText)) } : {}),
    rect: { width: rect.width, height: rect.height, x: rect.x, y: rect.y },
  };
}
