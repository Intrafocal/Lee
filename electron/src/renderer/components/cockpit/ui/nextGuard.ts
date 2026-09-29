/**
 * nextGuard - development check for cockpit-design §0 rule 1: phosphor marks
 * the one next step, so at most one `Btn kind="next"` is mounted per view
 * root. Each next button registers with its root while mounted; a second one
 * in the same root warns in the console (it never throws or changes the UI).
 *
 * A view root is the nearest ancestor with `data-view-root` (the Cockpit's
 * section, a popover, the Deep page), else the document body. Pure apart
 * from the console: the smokes create their own guard with createNextGuard()
 * and count registrations without React or a DOM.
 */

export const VIEW_ROOT_ATTR = 'data-view-root';

export interface NextGuard {
  /** Record one mounted next button in `root`; returns its unregister. */
  register(root: object, label?: string): () => void;
  /** Next buttons mounted in `root` now. */
  count(root: object): number;
  /** Whether Btn registers at all (on in development, off in production). */
  enabled: boolean;
}

export interface NextGuardOptions {
  enabled?: boolean;
  warn?: (message: string) => void;
}

export function createNextGuard(opts: NextGuardOptions = {}): NextGuard {
  const roots = new WeakMap<object, Map<symbol, string>>();
  const warn = opts.warn ?? ((m: string) => console.warn(m));
  const guard: NextGuard = {
    enabled: opts.enabled ?? true,
    register(root, label = '') {
      let mounted = roots.get(root);
      if (!mounted) {
        mounted = new Map();
        roots.set(root, mounted);
      }
      const token = Symbol(label);
      mounted.set(token, label);
      if (mounted.size > 1) {
        const labels = [...mounted.values()].map((l) => (l ? `"${l}"` : '(unlabelled)')).join(', ');
        warn(`[nextGuard] ${mounted.size} next buttons in one view (${labels}): phosphor marks the one next step (cockpit-design §0 rule 1).`);
      }
      return () => {
        mounted?.delete(token);
      };
    },
    count(root) {
      return roots.get(root)?.size ?? 0;
    },
  };
  return guard;
}

/** The guard Btn uses: on in development only (Vite inlines import.meta.env.DEV). */
export const nextGuard: NextGuard = createNextGuard({ enabled: !!import.meta.env?.DEV });

/** The view root an element belongs to, for nextGuard. */
export function viewRootOf(el: Element): object {
  return el.closest(`[${VIEW_ROOT_ATTR}]`) ?? el.ownerDocument.body;
}
