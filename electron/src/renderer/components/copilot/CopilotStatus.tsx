/**
 * CopilotStatus - mounted in StatusBar's right section. Owns the flyout, the
 * blocking banner and the capture/digest/retro overlays (contracts §9.1).
 * There is no pill: an agent's state shows on its own tab (lib/copilotAttention.ts),
 * and StatusBar's centre slot replaces "Ask Hester" with "N need you" only
 * for items not on a tab in this window; it opens the flyout from there.
 */

import React, { useEffect, useRef, useState } from 'react';
import { AttentionFlyout } from './AttentionFlyout';
import { BlockingBanner } from './BlockingBanner';
import { CapturePopover } from './CapturePopover';
import { DigestPanel } from './DigestPanel';
import { fetchRetro } from '../../lib/hesterCopilot';
import type { UseCopilotResult } from '../../hooks/useCopilot';
import type { FocusItem } from '../../../shared/copilot';

interface CopilotStatusProps {
  workspace: string;
  copilot: UseCopilotResult;
  onOpenHandoff: () => void;
  /** The flyout is opened from StatusBar's centre slot (or its context menu) and anchored to it. */
  attentionOpen: boolean;
  onAttentionClose: () => void;
  anchorRef: React.RefObject<HTMLElement>;
  captureOpen: boolean;
  onOpenCapture: () => void;
  onCaptureClose: () => void;
}

const RETRO_POLL_MS = 5 * 60 * 1000;

export const CopilotStatus: React.FC<CopilotStatusProps> = ({
  workspace,
  copilot,
  onOpenHandoff,
  attentionOpen,
  onAttentionClose,
  anchorRef,
  captureOpen,
  onOpenCapture,
  onCaptureClose,
}) => {
  const [digestRequest, setDigestRequest] = useState<{ since: string | null; focus: FocusItem | null } | null>(null);
  const [digestReady, setDigestReady] = useState(false);
  const [retroDue, setRetroDue] = useState(false);
  const prevFocusRef = useRef<{ active: boolean; source: string | null }>({ active: false, source: null });
  const lastReturnNonce = useRef(0);

  const { api, snapshot, focus, lastReturn } = copilot;
  const isFocused = !!focus?.active;

  // Open the digest on return (handoff end, or presence returning from away).
  useEffect(() => {
    if (!lastReturn || lastReturn.nonce === lastReturnNonce.current) return;
    lastReturnNonce.current = lastReturn.nonce;
    setDigestRequest({ since: lastReturn.info.away_since, focus: null });
  }, [lastReturn]);

  // Open the digest on a manual focus start; show only a chip on an inferred one.
  useEffect(() => {
    const prev = prevFocusRef.current;
    if (focus && focus.active && !prev.active) {
      if (focus.source === 'manual') setDigestRequest({ since: null, focus: focus.item ?? null });
      else if (focus.source === 'inferred') setDigestReady(true);
    }
    if (focus) prevFocusRef.current = { active: focus.active, source: focus.source };
  }, [focus]);

  // Poll only while not focused: the retro chip is hidden during focus anyway
  // (`retroDue && !isFocused` below). The poll uses ?peek=1 so it never marks
  // the retro "shown"; only RetroCard's un-peeked fetch does that.
  useEffect(() => {
    if (!api || isFocused) return;
    let cancelled = false;
    const poll = () => {
      fetchRetro({ peek: true }).then((res) => {
        if (!cancelled) setRetroDue(res.ok && res.data.due && !res.data.answered && !res.data.skipped);
      });
    };
    poll();
    const timer = setInterval(poll, RETRO_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [api, isFocused]);

  if (!api || !snapshot) return null;

  return (
    <>
      <BlockingBanner items={snapshot.items} api={api} />

      {digestReady && !isFocused && (
        <button
          className="copilot-digest-ready-chip"
          onClick={() => {
            setDigestReady(false);
            setDigestRequest({ since: null, focus: null });
          }}
        >
          Digest ready
        </button>
      )}

      {retroDue && !isFocused && (
        <button className="copilot-retro-chip" onClick={() => setDigestRequest({ since: null, focus: null })}>
          Weekly retro
        </button>
      )}

      {attentionOpen && anchorRef.current && (
        <AttentionFlyout
          snapshot={snapshot}
          api={api}
          anchorRect={anchorRef.current.getBoundingClientRect()}
          onClose={onAttentionClose}
          onOpenCapture={() => {
            onAttentionClose();
            onOpenCapture();
          }}
          onOpenHandoff={() => {
            onAttentionClose();
            onOpenHandoff();
          }}
        />
      )}

      {captureOpen && <CapturePopover api={api} workspace={workspace} onClose={onCaptureClose} />}

      {digestRequest && (
        <DigestPanel
          api={api}
          workspace={workspace}
          since={digestRequest.since}
          focus={digestRequest.focus}
          onRetroDone={() => setRetroDue(false)}
          onClose={() => setDigestRequest(null)}
        />
      )}
    </>
  );
};

export default CopilotStatus;
