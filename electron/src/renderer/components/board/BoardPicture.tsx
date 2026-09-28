/**
 * BoardPicture - a Board card's picture on the Desk and in its hover
 * preview: preview.png as of the card's updated_at (fetched with auth into
 * a blob: URL), or the one this window drew since, whichever is newer. A
 * Board never drawn (an empty one) shows its kind in a word.
 */

import { useEffect, useState } from 'react';
import type { DeskCard } from '../../../shared/desk';
import { boardPreviewUrl, localPreview, onPreviewChange } from '../../lib/boardAssets';

export function useBoardPicture(workspace: string, card: Pick<DeskCard, 'id' | 'kind' | 'updated_at'> | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => onPreviewChange(() => setTick((t) => t + 1)), []);
  const id = card?.kind === 'board' ? card.id : null;
  const stamp = card?.updated_at ?? '';
  useEffect(() => {
    if (!id) {
      setUrl(null);
      return;
    }
    const mine = localPreview(workspace, id);
    const theirs = Date.parse(stamp);
    // What this window drew, unless the Desk has heard of a newer change (another window's).
    if (mine && !(Number.isFinite(theirs) && theirs > mine.at)) {
      setUrl(mine.url);
      return;
    }
    let cancelled = false;
    void boardPreviewUrl(workspace, id, stamp).then((u) => {
      if (!cancelled) setUrl(u ?? mine?.url ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [workspace, id, stamp, tick]);
  return url;
}

export function BoardPicture({ workspace, card, className }: { workspace: string; card: DeskCard; className?: string }): JSX.Element {
  const url = useBoardPicture(workspace, card);
  return url ? (
    <img className={`board-picture${className ? ` ${className}` : ''}`} src={url} alt="" draggable={false} />
  ) : (
    <div className={`board-picture is-empty${className ? ` ${className}` : ''}`}>Board</div>
  );
}
