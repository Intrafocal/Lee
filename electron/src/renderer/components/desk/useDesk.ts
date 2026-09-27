/**
 * useDesk - the Desk's data for one window (D2 contract §4, §7.1): GET /desk
 * (which runs the migration when it's due), the waiting hand-offs for the
 * cards' ember dots, and a refresh the surface and the Page call after they
 * change something. Shared through DeskContext so the zoomed Page (DeepHost)
 * and the overview (DeskSurface) see one copy.
 *
 * Status: 'old' is a 404 from a Hester without the Desk (§10: one quiet line
 * asking for a reinstall, no fallback to explorations); 'offline' is no
 * answer at all (the last card still opens and writes locally).
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { Desk } from '../../../shared/desk';
import { getDesk } from '../../lib/hesterDesk';
import { listTasks } from '../../lib/hesterCockpit';
import { areasOnDesk, waitingCardIds } from '../../lib/deskModel';

export type DeskStatus = 'loading' | 'ok' | 'old' | 'offline';

export interface DeskData {
  workspace: string;
  desk: Desk | null;
  status: DeskStatus;
  /** Cards with a hand-off waiting on you. */
  waiting: ReadonlySet<string>;
  refresh: () => Promise<void>;
  /** A card's title as the Desk knows it ('' when unknown). */
  titleOf: (id: string) => string;
  /** The Area a new Page goes in when nothing says: the one in view, else the first on the Desk. */
  defaultArea: (inView: string | null) => string | null;
}

const REFRESH_MS = 30000;

export function useDesk(workspace: string, active: boolean): DeskData {
  const [desk, setDesk] = useState<Desk | null>(null);
  const [status, setStatus] = useState<DeskStatus>('loading');
  const [waiting, setWaiting] = useState<ReadonlySet<string>>(() => new Set());
  const seq = useRef(0);
  const deskRef = useRef<Desk | null>(null);
  deskRef.current = desk;

  const refresh = useCallback(async () => {
    if (!workspace) return;
    const n = ++seq.current;
    const [r, tasks] = await Promise.all([getDesk(workspace), listTasks(workspace, 'open')]);
    if (n !== seq.current) return;
    if (r.ok) {
      setDesk(r.data);
      setStatus('ok');
    } else setStatus(r.status === 404 ? 'old' : deskRef.current ? 'ok' : 'offline');
    if (tasks.ok) setWaiting(waitingCardIds(Array.isArray(tasks.data) ? tasks.data : []));
  }, [workspace]);

  useEffect(() => {
    setDesk(null);
    setStatus('loading');
  }, [workspace]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    const t = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(t);
  }, [active, refresh]);

  const titleOf = useCallback((id: string) => deskRef.current?.cards.find((c) => c.id === id)?.title ?? '', []);
  const defaultArea = useCallback((inView: string | null) => {
    const on = deskRef.current ? areasOnDesk(deskRef.current) : [];
    return on.find((a) => a.id === inView)?.id ?? on[0]?.id ?? inView ?? null;
  }, []);

  return useMemo(() => ({ workspace, desk, status, waiting, refresh, titleOf, defaultArea }), [workspace, desk, status, waiting, refresh, titleOf, defaultArea]);
}

export const DeskContext = createContext<DeskData | null>(null);

export function useDeskContext(): DeskData | null {
  return useContext(DeskContext);
}
