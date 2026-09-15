/**
 * Makes `window.lee` a typed value in the renderer.
 *
 * Every component used to do `const lee = (window as any).lee`, so a renamed
 * preload wrapper or a wrong argument count only showed up at runtime as an
 * undefined-is-not-a-function. The shape lives in `src/shared/lee-api.ts`,
 * which preload is also checked against.
 */

import type { LeeAPI } from '../shared/lee-api';

declare global {
  interface Window {
    /**
     * Injected by the preload script. Present in Electron; components that can
     * also render outside it should still guard with `if (!window.lee)`.
     */
    lee: LeeAPI;
  }
}

export {};
