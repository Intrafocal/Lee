/**
 * CapturePopover - single text field + "as exploration" checkbox; captures
 * an idea into Ideas from any surface (contracts §9.1, §8.1).
 */

import React, { useState } from 'react';
import ReactDOM from 'react-dom';
import type { CopilotAPI } from '../../../shared/copilot';

interface CapturePopoverProps {
  api: CopilotAPI;
  workspace: string;
  onClose: () => void;
}

export const CapturePopover: React.FC<CapturePopoverProps> = ({ api, workspace, onClose }) => {
  const [text, setText] = useState('');
  const [asExplore, setAsExplore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ spooled: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.capture({ text: trimmed, workspace, as: asExplore ? 'explore' : 'someday' });
      if (!res.success) {
        setError(res.error || 'Capture failed');
        return;
      }
      setResult({ spooled: !!res.spooled });
      setTimeout(onClose, 1400);
    } catch {
      setError('Capture failed');
    } finally {
      setBusy(false);
    }
  };

  return ReactDOM.createPortal(
    <div className="copilot-modal-overlay" onClick={onClose}>
      <div className="copilot-modal" onClick={(e) => e.stopPropagation()}>
        <div className="copilot-modal-header">
          <span className="copilot-modal-title">Capture</span>
          <button className="copilot-modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="copilot-modal-body">
          <textarea
            autoFocus
            className="copilot-textarea"
            placeholder="What's on your mind?"
            value={text}
            disabled={busy || !!result}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
          />
          <label className="copilot-checkbox-row">
            <input
              type="checkbox"
              checked={asExplore}
              disabled={busy || !!result}
              onChange={(e) => setAsExplore(e.target.checked)}
            />
            As exploration
          </label>
          {result && (
            <div className={`copilot-capture-toast${result.spooled ? ' is-spooled' : ''}`}>
              {result.spooled ? 'Saved; will sync when Hester is back' : 'Captured'}
            </div>
          )}
          {error && <div className="copilot-capture-error">{error}</div>}
        </div>
        {!result && (
          <div className="copilot-modal-footer">
            <button className="copilot-btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button className="copilot-btn copilot-btn-primary" onClick={() => void submit()} disabled={busy || !text.trim()}>
              Capture
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default CapturePopover;
