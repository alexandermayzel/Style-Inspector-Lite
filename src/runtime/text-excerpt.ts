import type { TextExcerpt } from '../core/types';

export interface TextReadBudget { remaining: number }
const EXCLUDED = 'input,textarea,select,option,optgroup,datalist,[contenteditable],[role~="textbox" i],[role~="combobox" i],[role~="searchbox" i],script,style,template,noscript,head,svg,canvas,iframe,object,embed,meter,progress';

/** Only ordinary HTML text of a confirmed selection. Never read value-bearing attributes. */
export function permitsTextExcerpt(element: Element): boolean {
  return element.namespaceURI === 'http://www.w3.org/1999/xhtml'
    && element.ownerDocument.designMode.toLowerCase() !== 'on'
    && !element.closest(EXCLUDED);
}

function clip(value: string, maximum: number): string {
  const end = Math.min(value.length, maximum);
  // Avoid half of a UTF-16 surrogate pair at the character budget boundary.
  return value.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(value[end - 1]!) ? end - 1 : end);
}

/** A bounded prefix is read before whitespace normalization, not the full node. */
export function readTextExcerpt(node: Text, budget: TextReadBudget): TextExcerpt {
  const count = Math.min(node.length, 4096, Math.max(0, budget.remaining));
  budget.remaining -= count;
  const normalized = node.substringData(0, count).replace(/\s+/gu, ' ').trim();
  const value = clip(normalized, 500);
  return { value, truncated: count < node.length || value.length < normalized.length };
}

export function combineTextExcerpts(parts: TextExcerpt[], limited: boolean): TextExcerpt {
  const combined = parts.map(part => part.value).filter(Boolean).join(' ');
  const value = clip(combined, 2000);
  return { value, truncated: limited || parts.some(part => part.truncated) || value.length < combined.length };
}
