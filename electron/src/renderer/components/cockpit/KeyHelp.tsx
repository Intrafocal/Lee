/**
 * KeyHelp - the Cockpit keyboard map (contracts §3.7), opened from the header.
 */

import React from 'react';
import { COCKPIT_KEYS as KEYS } from '../../lib/cockpitModel';

export const KeyHelp: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <div className="cockpit-popover-backdrop" onClick={onClose}>
    <div className="cockpit-popover" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Cockpit keys">
      <div className="cockpit-popover-title">Cockpit keys</div>
      <table className="cockpit-keys">
        <tbody>
          {KEYS.map(([k, d]) => (
            <tr key={k}>
              <td>
                <kbd>{k}</kbd>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="cockpit-muted">⌘1–9 (tabs), ⇧⌘C and the other global shortcuts keep working. Keys are ignored while you type in a field.</div>
    </div>
  </div>
);

export default KeyHelp;
