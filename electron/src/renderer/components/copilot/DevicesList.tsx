/**
 * DevicesList - paired-device management, embedded in PairingDialog: name,
 * kind, paired via, last seen, Revoke, and "Create device token" (shown
 * once) (contracts §9.1, §4).
 */

import React, { useEffect, useState } from 'react';
import { Icon } from '../Icon';
import type { CopilotAPI, DeviceInfo } from '../../../shared/copilot';

interface DevicesListProps {
  api: CopilotAPI;
}

function formatLastSeen(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const DevicesList: React.FC<DevicesListProps> = ({ api }) => {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [kind, setKind] = useState('other');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    api
      .devices.list()
      .then((list) => setDevices(list.filter((d) => !d.revoked_at)))
      .catch(() => setError('Could not load devices'));
  };

  useEffect(load, [api]);

  const revoke = async (deviceId: string) => {
    const res = await api.devices.revoke(deviceId);
    if (res.success) load();
    else setError(res.error || 'Could not revoke device');
  };

  const create = async () => {
    if (!name.trim()) return;
    const res = await api.devices.create(name.trim(), kind);
    if (res.success && res.token) {
      setNewToken(res.token);
      setName('');
      load();
    } else {
      setError(res.error || 'Could not create device token');
    }
  };

  const copyToken = async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard access denied - nothing more we can do here
    }
  };

  return (
    <div className="copilot-devices">
      <div className="copilot-devices-title">Devices</div>
      {error && <div className="copilot-capture-error">{error}</div>}
      {devices.length === 0 && <div className="copilot-device-empty">No paired devices yet.</div>}
      {devices.map((d) => (
        <div className="copilot-device-row" key={d.device_id}>
          <div className="copilot-device-main">
            <div className="copilot-device-name">{d.name}</div>
            <div className="copilot-device-meta">
              {d.kind} · via {d.paired_via} · last seen {formatLastSeen(d.last_seen_at)}
            </div>
          </div>
          <button className="copilot-device-revoke" onClick={() => void revoke(d.device_id)}>
            Revoke
          </button>
        </div>
      ))}

      {newToken ? (
        <div className="copilot-device-token-reveal">
          <code>{newToken}</code>
          <button className="copilot-device-token-copy" onClick={() => void copyToken()} title="Copy">
            <Icon name={copied ? 'check' : 'copy'} size={14} />
          </button>
        </div>
      ) : creating ? (
        <div className="copilot-device-create-form">
          <input
            className="copilot-input"
            placeholder="Device name"
            value={name}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
          <select className="copilot-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="aeronaut">Aeronaut</option>
            <option value="dirigible">Dirigible</option>
            <option value="other">Other</option>
          </select>
          <div style={{ display: 'flex', gap: 6 }}>
            <button className="copilot-btn" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button className="copilot-btn copilot-btn-primary" onClick={() => void create()} disabled={!name.trim()}>
              Create
            </button>
          </div>
        </div>
      ) : (
        <button className="copilot-device-create-btn" style={{ marginTop: 8 }} onClick={() => setCreating(true)}>
          + Create device token
        </button>
      )}
    </div>
  );
};

export default DevicesList;
