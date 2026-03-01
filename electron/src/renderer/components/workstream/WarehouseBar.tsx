/**
 * WarehouseBar - Footer with bundle chips and file count
 */

import React, { useState } from 'react';
import { WarehouseResponse } from './types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface WarehouseBarProps {
  wsId: string;
  warehouse: WarehouseResponse | null;
  onWarehouseChanged: () => void;
}

export const WarehouseBar: React.FC<WarehouseBarProps> = ({
  wsId,
  warehouse,
  onWarehouseChanged,
}) => {
  const [adding, setAdding] = useState(false);
  const [bundleInput, setBundleInput] = useState('');

  const addBundle = async () => {
    if (!bundleInput.trim()) return;
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/warehouse/bundle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: bundleInput.trim() }),
      });
      if (res.ok) {
        setBundleInput('');
        setAdding(false);
        onWarehouseChanged();
      }
    } catch {
      // daemon unavailable
    }
  };

  const bundles = warehouse?.bundle_ids || [];
  const fileCount = warehouse?.files?.length || 0;

  return (
    <div className="ws-warehouse">
      <div className="ws-warehouse-bundles">
        {bundles.map(id => (
          <span key={id} className="ws-warehouse-chip" title={id}>
            📦 {id.length > 20 ? id.slice(0, 20) + '…' : id}
          </span>
        ))}
        {adding ? (
          <div className="ws-warehouse-add-inline">
            <input
              className="ws-warehouse-input"
              placeholder="bundle_id"
              value={bundleInput}
              onChange={e => setBundleInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') addBundle();
                if (e.key === 'Escape') { setAdding(false); setBundleInput(''); }
              }}
              autoFocus
            />
          </div>
        ) : (
          <button className="ws-warehouse-add" onClick={() => setAdding(true)} title="Add bundle">+</button>
        )}
      </div>
      {fileCount > 0 && (
        <span className="ws-warehouse-files">{fileCount} files</span>
      )}
    </div>
  );
};
