/**
 * useCockpit - Lee-side Cockpit data (window.lee.cockpit: tabs, Feed, Ops)
 * plus Hester's Cockpit snapshot, polled (contracts §4).
 *
 * Stubs (§12.C): no window.lee.cockpit, or an invoke rejecting with "No
 * handler registered", reads as empty data; if tabs.list itself is missing,
 * `available` is false and the Cockpit stays off. In a dev build,
 * `localStorage.cockpitFake = '1'` swaps in a canned API (cockpitFake.ts),
 * loaded behind a literal `import.meta.env.DEV` so production drops it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CockpitAPI, FeedEntry, OperationsSnapshot, TabRuntimeInfo } from '../../shared/cockpit';
import { fetchCockpitSnapshot, type CockpitSnapshot } from '../lib/hesterCockpit';

function resolveRealApi(): CockpitAPI | null {
  const lee = typeof window !== 'undefined' ? window.lee : undefined;
  return lee && lee.cockpit ? lee.cockpit : null;
}

function isFakeRequested(): boolean {
  try {
    return window.localStorage.getItem('cockpitFake') === '1';
  } catch {
    return false;
  }
}

export function isMissingHandler(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return msg.includes('No handler registered');
}

/** Resolve an invoke, reading a missing handler as `fallback`. Other errors also fall back. */
export async function safeInvoke<T>(p: (() => Promise<T>) | undefined, fallback: T): Promise<T> {
  if (!p) return fallback;
  try {
    return await p();
  } catch {
    return fallback;
  }
}

export interface HesterCockpitState {
  snapshot: CockpitSnapshot | null;
  /** Error text when the last poll failed ("Hester offline"); null when fine. */
  offline: string | null;
  loaded: boolean;
  refresh: () => void;
}

export interface UseCockpitResult {
  api: CockpitAPI | null;
  /** null while probing; false when tabs.list is unavailable (Cockpit stays off). */
  available: boolean | null;
  runtime: TabRuntimeInfo[];
  feed: FeedEntry[];
  ops: OperationsSnapshot | null;
  hester: HesterCockpitState;
}

export function useCockpit(opts: { workspace: string; visible: boolean; agentsKey: string }): UseCockpitResult {
  const { workspace, visible, agentsKey } = opts;
  const realApi = useMemo(resolveRealApi, []);
  const [fakeApi, setFakeApi] = useState<CockpitAPI | null>(null);
  const [fakeChecked, setFakeChecked] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) {
      if (!realApi && isFakeRequested()) {
        let cancelled = false;
        import('./cockpitFake').then((mod) => {
          if (cancelled) return;
          setFakeApi(mod.createFakeCockpitApi());
          setFakeChecked(true);
        });
        return () => {
          cancelled = true;
        };
      }
    }
    setFakeChecked(true);
  }, [realApi]);

  const api = realApi ?? fakeApi;
  const [available, setAvailable] = useState<boolean | null>(null);
  const [runtime, setRuntime] = useState<TabRuntimeInfo[]>([]);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [ops, setOps] = useState<OperationsSnapshot | null>(null);

  useEffect(() => {
    if (!fakeChecked) return;
    if (!api || !workspace) {
      if (!api) setAvailable(false);
      return;
    }
    let cancelled = false;
    api.tabs
      .list(workspace)
      .then((tabs) => {
        if (cancelled) return;
        setRuntime(Array.isArray(tabs) ? tabs : []);
        setAvailable(true);
      })
      .catch((err) => {
        if (!cancelled) setAvailable(!isMissingHandler(err));
      });
    safeInvoke(() => api.feed.get(workspace), null).then((s) => {
      if (!cancelled && s) setFeed(s.entries ?? []);
    });
    safeInvoke(() => api.ops.list(workspace), null).then((s) => {
      if (!cancelled && s) setOps(s);
    });
    const unsubs: Array<() => void> = [];
    const sub = (fn: () => () => void) => {
      try {
        unsubs.push(fn());
      } catch {
        /* channel missing */
      }
    };
    sub(() => api.tabs.onChange((tabs) => setRuntime(Array.isArray(tabs) ? tabs : [])));
    sub(() => api.feed.onChange((s) => setFeed(s?.entries ?? [])));
    sub(() =>
      api.ops.onChange((s) => {
        if (s && s.workspace === workspace) setOps(s);
      }),
    );
    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [api, workspace, fakeChecked]);

  const hester = useHesterCockpit(workspace, visible, agentsKey, fakeApi != null);

  return { api, available, runtime, feed, ops, hester };
}

function useHesterCockpit(workspace: string, visible: boolean, agentsKey: string, fake: boolean): HesterCockpitState {
  const [snapshot, setSnapshot] = useState<CockpitSnapshot | null>(null);
  const [offline, setOffline] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const versionRef = useRef<number | null>(null);
  const inFlight = useRef(false);
  const wsRef = useRef(workspace);

  useEffect(() => {
    wsRef.current = workspace;
    versionRef.current = null;
    setSnapshot(null);
    setLoaded(false);
  }, [workspace]);

  const poll = useCallback(async () => {
    const ws = wsRef.current;
    if (!ws || inFlight.current) return;
    inFlight.current = true;
    try {
      if (fake) {
        if (import.meta.env.DEV) {
          const mod = await import('./cockpitFake');
          if (wsRef.current === ws) {
            setSnapshot(mod.fakeHesterSnapshot(ws));
            setOffline(null);
          }
        }
        return;
      }
      const res = await fetchCockpitSnapshot(ws, versionRef.current);
      if (wsRef.current !== ws) return;
      if (!res.ok) {
        setOffline(res.error);
        return;
      }
      setOffline(null);
      if ('unchanged' in res.data) return;
      versionRef.current = res.data.version;
      setSnapshot(res.data);
    } finally {
      inFlight.current = false;
      setLoaded(true);
    }
  }, [fake]);

  const refresh = useCallback(() => {
    versionRef.current = null;
    void poll();
  }, [poll]);

  useEffect(() => {
    if (!workspace) return;
    void poll();
    const id = window.setInterval(() => void poll(), visible ? 5000 : 30000);
    return () => window.clearInterval(id);
  }, [workspace, visible, poll]);

  const firstAgents = useRef(true);
  useEffect(() => {
    if (firstAgents.current) {
      firstAgents.current = false;
      return;
    }
    const id = window.setTimeout(() => void poll(), 1000);
    return () => window.clearTimeout(id);
  }, [agentsKey, poll]);

  return { snapshot, offline, loaded, refresh };
}
