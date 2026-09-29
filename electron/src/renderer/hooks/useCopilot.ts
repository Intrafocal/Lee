/**
 * useCopilot - subscribes to the attention snapshot, presence and return
 * events from `window.lee.copilot` (contracts §9.1, Appendix A `CopilotAPI`)
 * and hands components a single live `CopilotAPI` to act through.
 *
 * Stub strategy (contracts §10.C): if `window.lee.copilot` is missing at
 * runtime (package A/B not merged yet), `available` is false and callers
 * should render nothing. In dev, a canned fake can stand in so this package
 * can be built and eyeballed on its own.
 *
 * The fake is loaded with a dynamic `import()` gated by a literal
 * `if (import.meta.env.DEV)` at the call site, which Vite inlines to
 * `if (false)` in a production build - the import becomes unreachable and
 * both it and the `copilotFake` chunk are dropped, so none of it ships.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AttentionSnapshot,
  AwayState,
  CopilotAPI,
  CopilotUnsubscribe,
  FocusState,
  PresenceState,
  ReturnInfo,
} from '../../shared/copilot';

function resolveRealApi(): CopilotAPI | null {
  const lee = typeof window !== 'undefined' ? window.lee : undefined;
  return lee && lee.copilot ? lee.copilot : null;
}

function isFakeRequested(): boolean {
  try {
    return window.localStorage.getItem('copilotFake') === '1';
  } catch {
    return false;
  }
}

export interface ReturnEvent {
  info: ReturnInfo;
  /** Bumped on every push so effects can react even to a repeated shape. */
  nonce: number;
}

export interface UseCopilotResult {
  available: boolean;
  api: CopilotAPI | null;
  snapshot: AttentionSnapshot | null;
  presence: PresenceState | null;
  focus: FocusState | null;
  away: AwayState | null;
  counts: AttentionSnapshot['counts'] | null;
  lastReturn: ReturnEvent | null;
}

export function useCopilot(): UseCopilotResult {
  const realApi = useMemo(resolveRealApi, []);
  const [fakeApi, setFakeApi] = useState<CopilotAPI | null>(null);

  useEffect(() => {
    if (realApi || !import.meta.env.DEV || !isFakeRequested()) return;
    let cancelled = false;
    import('./copilotFake').then((mod) => {
      if (!cancelled) setFakeApi(mod.createFakeCopilotApi());
    });
    return () => {
      cancelled = true;
    };
  }, [realApi]);

  const api = realApi ?? fakeApi;

  const [snapshot, setSnapshot] = useState<AttentionSnapshot | null>(null);
  const [presence, setPresence] = useState<PresenceState | null>(null);
  const [lastReturn, setLastReturn] = useState<ReturnEvent | null>(null);
  const nonceRef = useRef(0);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;

    api
      .getSnapshot()
      .then((s) => {
        if (!cancelled) setSnapshot(s);
      })
      .catch(() => {});
    api
      .getPresence()
      .then((p) => {
        if (!cancelled) setPresence(p);
      })
      .catch(() => {});

    const unsubs: CopilotUnsubscribe[] = [
      api.onSnapshot((s) => setSnapshot(s)),
      api.onPresence((p) => setPresence(p)),
      api.onReturn((info) => {
        nonceRef.current += 1;
        setLastReturn({ info, nonce: nonceRef.current });
      }),
    ];

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [api]);

  return {
    available: api != null,
    api,
    snapshot,
    presence,
    focus: snapshot?.focus ?? null,
    away: snapshot?.away ?? null,
    counts: snapshot?.counts ?? null,
    lastReturn,
  };
}
