/**
 * CopilotStatus - entry point mounted in StatusBar's status-bar-center.
 * Owns the needs-you pill, the flyout, the blocking banner and the
 * capture/digest/retro overlays (contracts §9.1). The focus indicator lives
 * in StatusBar's own message slot (it replaces "Ask Hester" while active),
 * and the handoff dialog is owned by StatusBar too, since both the flyout
 * footer and the focus chip's menu need to open it.
 */

import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../Icon';
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
}

const RETRO_POLL_MS = 5 * 60 * 1000;

export const CopilotStatus: React.FC<CopilotStatusProps> = ({ workspace, copilot, onOpenHandoff }) => {
  const [flyoutOpen, setFlyoutOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [digestRequest, setDigestRequest] = useState<{ since: string | null; focus: FocusItem | null } | null>(null);
  const [digestReady, setDigestReady] = useState(false);
  const [retroDue, setRetroDue] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const prevFocusRef = useRef<{ active: boolean; source: string | null }>({ active: false, source: null });
  const lastReturnNonce = useRef(0);

  const { api, snapshot, focus, counts, lastReturn } = copilot;
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
  // (`retroDue && !isFocused` below), and Hester's GET /copilot/retro marks
  // the retro "shown" (once per week) as a side effect of being called, so
  // polling while nothing would be shown skews that metric.
  useEffect(() => {
    if (!api || isFocused) return;
    let cancelled = false;
    const poll = () => {
      fetchRetro().then((res) => {
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

  const needsYouCount = (counts?.needs_you ?? 0) + (counts?.blocking ?? 0);

  return (
    <>
      <BlockingBanner items={snapshot.items} api={api} />

      {!isFocused && (
        <button
          ref={pillRef}
          className={`copilot-pill${
            needsYouCount === 0 ? ' is-idle' : counts?.blocking ? '' : ' is-quiet'
          }`}
          onClick={() => setFlyoutOpen((v) => !v)}
          title="Focus, Capture and Hand off"
        >
          <Icon name="bell" size={12} />
          {needsYouCount > 0 ? `${needsYouCount} need you` : null}
        </button>
      )}

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

      {flyoutOpen && pillRef.current && (
        <AttentionFlyout
          snapshot={snapshot}
          api={api}
          anchorRect={pillRef.current.getBoundingClientRect()}
          onClose={() => setFlyoutOpen(false)}
          onOpenCapture={() => {
            setFlyoutOpen(false);
            setCaptureOpen(true);
          }}
          onOpenHandoff={() => {
            setFlyoutOpen(false);
            onOpenHandoff();
          }}
        />
      )}

      {captureOpen && <CapturePopover api={api} workspace={workspace} onClose={() => setCaptureOpen(false)} />}

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
