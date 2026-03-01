/**
 * AgentPanel - Live agent telemetry cards
 */

import React from 'react';
import { AgentSession } from './types';

interface AgentPanelProps {
  sessions: AgentSession[];
}

function timeAgo(isoStr: string): string {
  const diff = Date.now() - new Date(isoStr).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

const STATUS_COLORS: Record<string, string> = {
  active: '#20b2aa',
  idle: '#888',
  completed: '#4a9',
  failed: '#e74c3c',
};

export const AgentPanel: React.FC<AgentPanelProps> = ({ sessions }) => {
  if (sessions.length === 0) {
    return (
      <div className="ws-agents">
        <div className="ws-agents-empty">
          No agents dispatched
        </div>
      </div>
    );
  }

  return (
    <div className="ws-agents">
      {sessions.map(session => (
        <div key={session.session_id} className="ws-agent-card">
          <div className="ws-agent-header">
            <span
              className="ws-agent-dot"
              style={{ background: STATUS_COLORS[session.status] || '#888' }}
            />
            <span className="ws-agent-type">{session.agent_type}</span>
            <span className="ws-agent-id">{session.session_id.slice(0, 8)}</span>
            <span className="ws-agent-time">{timeAgo(session.last_update)}</span>
          </div>
          {session.current_tool && (
            <div className="ws-agent-tool">
              🔧 {session.current_tool}
            </div>
          )}
          {session.active_file && (
            <div className="ws-agent-file">
              📄 {session.active_file}
            </div>
          )}
          {session.recent_tools.length > 0 && (
            <div className="ws-agent-tools">
              {session.recent_tools.slice(0, 5).map((tool, i) => (
                <span key={i} className="ws-agent-tool-chip">{tool}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
};
