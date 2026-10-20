/** Random document/snapshot identity also works in HTTP content-script contexts.
 * crypto.randomUUID is secure-context-only; getRandomValues is not.
 */
export function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
}
