/**
 * SendChip - the status bar's quiet line after a Send to Lee (§4.3): "From
 * your phone: photo → Taxonomy · Undo". Undo shows only for a Page insertion
 * and works while it's unchanged; the chip goes after 8 s. Neutral text, no
 * phosphor or ember: it's news, not a next step.
 */

import React, { useEffect, useState } from 'react';
import { currentSendChip, dismissSendChip, onSendChip, type SendChip as Chip } from '../../lib/tetherDelivery';

export const SendChip: React.FC = () => {
  const [chip, setChip] = useState<Chip | null>(currentSendChip());
  const [note, setNote] = useState<string | null>(null);
  useEffect(
    () =>
      onSendChip((c) => {
        setChip(c);
        setNote(null);
      }),
    [],
  );
  if (!chip) return null;
  const undo = chip.undo;
  return (
    <span className="status-item status-send-chip" role="status">
      <span className="status-text">{note ?? chip.line}</span>
      {undo && !note && (
        <>
          <span className="status-cockpit-sep">·</span>
          <button
            type="button"
            className="status-send-undo"
            onClick={() => {
              void undo().then((ok) => {
                if (ok) dismissSendChip();
                else setNote('Changed since: Undo it in the Page');
              });
            }}
          >
            Undo
          </button>
        </>
      )}
    </span>
  );
};
