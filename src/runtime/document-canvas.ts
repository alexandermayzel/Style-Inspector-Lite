import { parseColor } from '../core/colors';
import type { ColorValue } from '../core/types';

const pending = new WeakMap<Document, { scheme: string; color: ColorValue | null }>();

/**
 * The browser paints the top-level document canvas below transparent CSS
 * backgrounds. Resolve its system color using the root's color scheme.
 * Canvas2D color parsing does not reliably use that scheme, so it is not a
 * substitute for a computed CSS color.
 */
export function documentCanvasColor(document: Document, registerOwn: (element: Element) => void): ColorValue | null {
  const root = document?.documentElement, view = document?.defaultView;
  if (!root || !view || view.top !== view || root.localName !== 'html'
    || root.namespaceURI !== 'http://www.w3.org/1999/xhtml') return null;
  let host: HTMLElement | undefined;
  try {
    const scheme = view.getComputedStyle(root).colorScheme;
    if (!scheme) return null;
    const cached = pending.get(document);
    if (cached?.scheme === scheme) return cached.color;
    const entry = { scheme, color: null as ColorValue | null };
    pending.set(document, entry);
    // Reuse only within this synchronous measurement batch. A fresh inspection
    // must see changes to browser colors even when no page DOM mutation occurs.
    queueMicrotask(() => { if (pending.get(document) === entry) pending.delete(document); });

    host = document.createElement('span');
    registerOwn(host);
    host.style.setProperty('all', 'initial', 'important');
    host.style.setProperty('display', 'none', 'important');
    host.style.setProperty('width', '0', 'important');
    host.style.setProperty('height', '0', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    const shadow = host.attachShadow({ mode: 'closed' });
    const probe = document.createElement('span');
    probe.style.setProperty('all', 'initial', 'important');
    probe.style.setProperty('color-scheme', scheme, 'important');
    probe.style.setProperty('forced-color-adjust', 'none', 'important');
    probe.style.setProperty('background-color', 'Canvas', 'important');
    shadow.append(probe);
    root.append(host);
    const resolved = view.getComputedStyle(probe);
    const color = parseColor(resolved.backgroundColor);
    if (resolved.colorScheme === scheme && color.rgba?.a === 1) entry.color = color;
    return entry.color;
  } catch {
    // Unsupported DOM/CSS behavior does not establish a default white surface.
    return null;
  } finally {
    host?.remove();
  }
}
