/**
 * AttentionFlyout - items grouped Blocking / Needs you / Recent (ambient),
 * with a footer for Focus, Capture… and Hand off… (contracts §9.1).
 */

import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { AttentionItemRow } from './AttentionItemRow';
import { FocusControl } from './FocusControl';
import type { AttentionItem, AttentionSnapshot, CopilotAPI } from '../../../shared/copilot';

interface AttentionFlyoutProps {
  snapshot: AttentionSnapshot;
  api: CopilotAPI;
  anchorRect: DOMRect;
  onClose: () => void;
  onOpenCapture: () => void;
  onOpenHandoff: () => void;
}

function groupItems(items: AttentionItem[]): { blocking: AttentionItem[]; needsYou: AttentionItem[]; recent: AttentionItem[] } {
  const open = items.filter((i) => i.state === 'open' || i.state === 'snoozed');
  return {
    blocking: open.filter((i) => i.severity === 'blocking'),
    needsYou: open.filter((i) => i.severity === 'needs-you'),
    recent: open.filter((i) => i.severity === 'ambient'),
  };
}

export const AttentionFlyout: React.FC<AttentionFlyoutProps> = ({
  snapshot,
  api,
  anchorRect,
  onClose,
  onOpenCapture,
  onOpenHandoff,
}) => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  const { blocking, needsYou, recent } = groupItems(snapshot.items);
  const empty = blocking.length === 0 && needsYou.length === 0 && recent.length === 0;

  const style: React.CSSProperties = {
    bottom: window.innerHeight - anchorRect.top + 8,
    left: Math.max(8, Math.min(anchorRect.left, window.innerWidth - 396)),
  };

  return ReactDOM.createPortal(
    <div className="copilot-flyout" style={style} ref={ref}>
      <div className="copilot-flyout-scroll">
        {empty && <div className="copilot-flyout-empty">Nothing needs you right now.</div>}
        {blocking.length > 0 && (
          <div className="copilot-flyout-section">
            <div className="copilot-flyout-section-title">Blocking</div>
            {blocking.map((item) => (
              <AttentionItemRow key={item.id} item={item} api={api} />
            ))}
          </div>
        )}
        {needsYou.length > 0 && (
          <div className="copilot-flyout-section">
            <div className="copilot-flyout-section-title">Needs you</div>
            {needsYou.map((item) => (
              <AttentionItemRow key={item.id} item={item} api={api} />
            ))}
          </div>
        )}
        {recent.length > 0 && (
          <div className="copilot-flyout-section">
            <div className="copilot-flyout-section-title">Recent</div>
            {recent.map((item) => (
              <AttentionItemRow key={item.id} item={item} api={api} />
            ))}
          </div>
        )}
      </div>
      <div className="copilot-flyout-footer">
        <FocusControl focus={snapshot.focus} api={api} onStopAndHandoff={onOpenHandoff} />
        <button className="copilot-flyout-footer-btn" onClick={onOpenCapture}>
          Capture…
        </button>
        <button className="copilot-flyout-footer-btn" onClick={onOpenHandoff}>
          Hand off…
        </button>
      </div>
    </div>,
    document.body,
  );
};

export default AttentionFlyout;
