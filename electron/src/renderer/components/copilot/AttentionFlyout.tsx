/**
 * AttentionFlyout - items grouped Blocking / Needs you / Recent (ambient),
 * with a footer for Go deep, Capture… and Hand off… (contracts §9.1; Deep D1 §14).
 */

import React, { useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import { AttentionItemRow } from './AttentionItemRow';
import { FocusControl } from './FocusControl';
import { groupAttentionItems } from '../../lib/copilotAttention';
import type { AttentionSnapshot, CopilotAPI } from '../../../shared/copilot';

interface AttentionFlyoutProps {
  snapshot: AttentionSnapshot;
  api: CopilotAPI;
  workspace: string;
  anchorRect: DOMRect;
  onClose: () => void;
  onOpenCapture: () => void;
  onOpenHandoff: () => void;
}

export const AttentionFlyout: React.FC<AttentionFlyoutProps> = ({
  snapshot,
  api,
  workspace,
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

  const { blocking, needsYou, recent } = groupAttentionItems(snapshot.items);
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
        <FocusControl focus={snapshot.focus} api={api} workspace={workspace} onDone={onClose} />
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
