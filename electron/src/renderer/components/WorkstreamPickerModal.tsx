/**
 * WorkstreamPickerModal - List, search, and create workstreams
 *
 * Follows the WorkspaceModal pattern. Opens via Cmd+Shift+W.
 * On select, calls back with workstream ID to open/focus a tab.
 */

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { WorkstreamResponse, WorkstreamPhase, PHASE_CONFIG } from './workstream/types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface WorkstreamPickerModalProps {
  onSelect: (wsId: string, title: string) => void;
  onClose: () => void;
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export const WorkstreamPickerModal: React.FC<WorkstreamPickerModalProps> = ({
  onSelect,
  onClose,
}) => {
  const [workstreams, setWorkstreams] = useState<WorkstreamResponse[]>([]);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newObjective, setNewObjective] = useState('');
  const [loading, setLoading] = useState(true);
  const filterRef = useRef<HTMLInputElement>(null);

  const fetchWorkstreams = useCallback(async () => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/`);
      if (res.ok) {
        const data = await res.json();
        // API may return list directly or wrapped
        setWorkstreams(Array.isArray(data) ? data : data.workstreams || []);
      }
    } catch {
      // daemon unavailable
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkstreams();
    // Focus filter on open
    setTimeout(() => filterRef.current?.focus(), 100);
  }, [fetchWorkstreams]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const handleCreate = async () => {
    if (!newTitle.trim()) return;
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTitle.trim(), objective: newObjective.trim() || newTitle.trim() }),
      });
      if (res.ok) {
        const ws = await res.json();
        onSelect(ws.id, ws.title);
      }
    } catch {
      // daemon unavailable
    }
  };

  const filtered = workstreams.filter(ws =>
    ws.title.toLowerCase().includes(filter.toLowerCase()),
  );

  // Sort by updated_at descending
  filtered.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());

  return (
    <div className="ws-picker-overlay" onClick={onClose}>
      <div className="ws-picker" onClick={e => e.stopPropagation()}>
        <div className="ws-picker-header">
          <h2>Workstreams</h2>
          <button className="ws-picker-close" onClick={onClose}>×</button>
        </div>

        <div className="ws-picker-search">
          <input
            ref={filterRef}
            className="ws-picker-filter"
            placeholder="Search workstreams..."
            value={filter}
            onChange={e => setFilter(e.target.value)}
          />
        </div>

        <div className="ws-picker-list">
          {loading && <div className="ws-picker-loading">Loading...</div>}
          {!loading && filtered.length === 0 && !creating && (
            <div className="ws-picker-empty">No workstreams found</div>
          )}
          {filtered.map(ws => {
            const phase = ws.phase as WorkstreamPhase;
            const config = PHASE_CONFIG[phase] || { label: phase, color: '#666', icon: '?' };
            const completed = ws.completed_task_ids?.length || 0;
            const total = ws.runbook?.tasks?.length || 0;
            return (
              <button
                key={ws.id}
                className="ws-picker-item"
                onClick={() => onSelect(ws.id, ws.title)}
              >
                <span className="ws-picker-phase" style={{ background: config.color }}>
                  {config.icon}
                </span>
                <div className="ws-picker-info">
                  <span className="ws-picker-title">{ws.title}</span>
                  <span className="ws-picker-meta">
                    {config.label}
                    {total > 0 && ` · ${completed}/${total} tasks`}
                    {' · '}
                    {timeAgo(ws.updated_at)}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="ws-picker-footer">
          {creating ? (
            <div className="ws-picker-create-form">
              <input
                className="ws-picker-create-input"
                placeholder="Title"
                value={newTitle}
                onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
                autoFocus
              />
              <input
                className="ws-picker-create-input"
                placeholder="Objective (optional)"
                value={newObjective}
                onChange={e => setNewObjective(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') setCreating(false); }}
              />
              <div className="ws-picker-create-actions">
                <button className="ws-picker-btn-cancel" onClick={() => setCreating(false)}>Cancel</button>
                <button className="ws-picker-btn-create" onClick={handleCreate} disabled={!newTitle.trim()}>Create</button>
              </div>
            </div>
          ) : (
            <button className="ws-picker-new-btn" onClick={() => setCreating(true)}>
              + New Workstream
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
