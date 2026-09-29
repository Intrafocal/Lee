/**
 * Small DOM checks shared by the Cockpit's keyboard handlers.
 */

/** Focus is on a button or link: Enter and Space belong to it (its own click decides). */
export function isControlTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return !!el.closest('button, a[href], [role="button"], summary');
}

/** Focus is in a field you type into. */
export function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el as HTMLElement).isContentEditable;
}
