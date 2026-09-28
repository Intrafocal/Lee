/**
 * useViewportSize - an element's size in CSS px, kept current with a
 * ResizeObserver: what the Desk and a Board fit their camera to. Measured
 * again when `deps` change (a surface shown again after being hidden).
 */

import { useLayoutEffect, useState, type RefObject } from 'react';
import type { Size } from './camera';

export function useViewportSize(ref: RefObject<HTMLElement | null>, deps: readonly unknown[] = [], initial: Size = { w: 800, h: 600 }): Size {
  const [size, setSize] = useState<Size>(initial);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width && r.height) setSize((s) => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return size;
}
