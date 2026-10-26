import { parseColor } from '../core/colors';

interface Geometry { rects: { left: number; top: number; width: number; height: number }[]; limited: boolean }
type ReadStyle = (element: Element, pseudo?: string) => CSSStyleDeclaration;
interface TraversalBudget { remaining: number }
type PseudoChange = false | 'paint' | 'font';
let changesCache: WeakMap<Element, PseudoChange> | null = null;

/** CSS declarations are live, but derived comparisons are valid only during
 * the current synchronous chunk. Never reuse them after yielding to the page. */
export function withTextPseudoBatch<T>(measure: () => T): T {
  const previous = changesCache;
  changesCache = new WeakMap();
  try { return measure(); } finally { changesCache = previous; }
}
const textProperties = ['color', 'fontSize', 'fontWeight', 'fontFamily', 'fontStyle', 'fontStretch', 'fontVariant',
  'fontSizeAdjust', 'fontFeatureSettings', 'fontVariationSettings', 'fontKerning', 'fontOpticalSizing',
  'letterSpacing', 'wordSpacing', 'textTransform', 'textShadow', 'textEmphasisStyle', 'textEmphasisColor'] as const;

function altersText(base: CSSStyleDeclaration, pseudo: CSSStyleDeclaration): false | 'paint' | 'font' {
  if ((['fontSize', 'fontWeight'] as const).some(property => pseudo[property] && base[property]
    && pseudo[property] !== base[property])) return 'font';
  if (textProperties.some(property => pseudo[property] && base[property] && pseudo[property] !== base[property])) return 'paint';
  // Text decorations propagate through inline paint without being inherited
  // computed properties. An ordinary underlined link therefore exposes `none`
  // on these pseudo boxes; that default does not remove its existing underline.
  if (pseudo.textDecorationLine && pseudo.textDecorationLine !== 'none'
    && (['textDecorationLine', 'textDecorationColor', 'textDecorationStyle'] as const)
      .some(property => pseudo[property] && pseudo[property] !== base[property])) return 'paint';
  for (const property of ['-webkit-text-fill-color', '-webkit-text-stroke-color', '-webkit-text-stroke-width']) {
    const current = pseudo.getPropertyValue?.(property), ordinary = base.getPropertyValue?.(property);
    if (current && ordinary && current !== ordinary) return 'paint';
  }
  // These pseudo boxes default to transparent, independently of their owner's
  // background. Only an actually painted pseudo background changes the result.
  return (!!pseudo.backgroundColor && parseColor(pseudo.backgroundColor).rgba?.a !== 0
    || !!pseudo.backgroundImage && pseudo.backgroundImage !== 'none') ? 'paint' : false;
}

/** Prove a later line is unaffected without reading page text. Unknown writing
 * modes, generated layout, and traversal limits retain a conservative result. */
function mayShareFirstLine(owner: Element, geometry: readonly Geometry[], readStyle: ReadStyle, budget: TraversalBudget): boolean {
  if (!geometry.length || geometry.some(item => item.limited || !item.rects.length)) return true;
  const style = readStyle(owner), document = owner.ownerDocument;
  if (style.writingMode !== 'horizontal-tb' || !document?.createTreeWalker || !document.createRange
    || style.transform !== 'none' || style.rotate !== 'none' || style.perspective !== 'none') return true;
  const walker = document.createTreeWalker(owner, NodeFilter.SHOW_TEXT);
  let node: Node | null, visited = 0;
  while ((node = walker.nextNode())) {
    if (++visited > 128 || budget.remaining-- <= 0) return true;
    let visible = true, depth = 0;
    for (let current = node.parentElement; current && current !== owner; current = current.parentElement) {
      if (++depth > 64 || budget.remaining-- <= 0) return true;
      const currentStyle = readStyle(current);
      if (current.assignedSlot || current.shadowRoot) return true;
      if (currentStyle.display === 'none' || currentStyle.visibility !== 'visible'
        || ['absolute', 'fixed'].includes(currentStyle.position) || currentStyle.cssFloat !== 'none') { visible = false; break; }
    }
    if (!visible) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    const rect = Array.from(range.getClientRects()).find(rect => rect.width > 0 && rect.height > 0);
    if (!rect) continue;
    return geometry.some(item => item.rects.some(fragment => fragment.top < rect.top + rect.height
      && fragment.top + fragment.height > rect.top));
  }
  return true;
}

/** ::first-line/::first-letter styles are not reflected by an inline child's
 * computed color. Keep them explicit until partial glyph styles are measured. */
export function textPseudoStyle(owner: Element, geometry: readonly Geometry[], readStyle: ReadStyle, budget: TraversalBudget = { remaining: 256 }): PseudoChange {
  const base = readStyle(owner);
  // These pseudo-elements apply to block containers, not ordinary inline,
  // flex or grid containers even when CSSOM exposes their declared styles.
  if (!['block', 'flow-root', 'inline-block', 'list-item', 'table-cell', 'table-caption'].includes(base.display)) return false;
  let changed = changesCache?.get(owner);
  if (changed === undefined) {
    const changes = ['::first-line', '::first-letter'].map(pseudo => altersText(base, readStyle(owner, pseudo)));
    changed = changes.includes('font') ? 'font' : changes.includes('paint') ? 'paint' : false;
    changesCache?.set(owner, changed);
  }
  return changed && mayShareFirstLine(owner, geometry, readStyle, budget) ? changed : false;
}
