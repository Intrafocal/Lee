/**
 * BlockingBanner - raised banner above the status bar for open blocking
 * items, one at a time (newest first, "+N more"). Shown during focus too;
 * it's the one allowed interruption (contracts §9.1).
 */

import React from 'react';
import ReactDOM from 'react-dom';
import { AttentionItemRow } from './AttentionItemRow';
import type { AttentionItem, CopilotAPI } from '../../../shared/copilot';

interface BlockingBannerProps {
  items: AttentionItem[];
  api: CopilotAPI;
}

export const BlockingBanner: React.FC<BlockingBannerProps> = ({ items, api }) => {
  const blocking = items
    .filter((i) => i.state === 'open' && i.severity === 'blocking')
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  if (blocking.length === 0) return null;

  const [top, ...rest] = blocking;

  return ReactDOM.createPortal(
    <div className="copilot-banner-wrap">
      <div className="copilot-banner">
        <AttentionItemRow item={top} api={api} />
      </div>
      {rest.length > 0 && <div className="copilot-banner-more">+{rest.length} more</div>}
    </div>,
    document.body,
  );
};

export default BlockingBanner;
