/**
 * KeyHelp (?) - the Cockpit keyboard map (contracts §3.7).
 */

import React from 'react';

const KEYS: Array<[string, string]> = [
  ['⌘0', 'Cockpit ↔ Workbench (⇧⌘0 resets zoom)'],
  ['1–6', 'Feed, Tasks, Ops, Someday, Tabs, History'],
  ['j / k, ↓ / ↑', 'Next / previous row'],
  ['h / l, ← / →', 'Previous / next agent tile'],
  ['Enter', 'Go into the selected agent, or open the row'],
  ['a / d', 'Approve / deny the selected approval'],
  ['r', 'Reply to the selected item'],
  ['c', 'Check in on the selected agent (shows the prompt first)'],
  ['n', 'New task'],
  ['o', 'Run ▾ operations'],
  ['x', 'Dismiss the selected Feed entry'],
  ['`', 'Focus your tabs'],
  ['Esc', 'Close popovers, clear selection'],
];

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
      <div className="cockpit-muted">⌘1–9, ⇧⌘C and the other global shortcuts keep working. Keys are ignored while you type in a field.</div>
    </div>
  </div>
);

export default KeyHelp;
