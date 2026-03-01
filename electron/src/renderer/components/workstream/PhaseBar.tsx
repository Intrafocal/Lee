/**
 * PhaseBar - Workstream header with title, phase badge, and transition buttons
 */

import React, { useState } from 'react';
import { WorkstreamPhase, PHASE_CONFIG, ResolvedTask } from './types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface PhaseBarProps {
  wsId: string;
  title: string;
  phase: WorkstreamPhase;
  tasks: ResolvedTask[];
  onPhaseChanged: () => void;
}

export const PhaseBar: React.FC<PhaseBarProps> = ({
  wsId,
  title,
  phase,
  tasks,
  onPhaseChanged,
}) => {
  const [transitioning, setTransitioning] = useState(false);
  const config = PHASE_CONFIG[phase] || { label: phase, color: '#666', icon: '?' };
  const completedCount = tasks.filter(t => t.status === 'completed').length;

  const advancePhase = async (target: WorkstreamPhase) => {
    setTransitioning(true);
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/phase/${target}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) onPhaseChanged();
    } catch {
      // daemon unavailable
    } finally {
      setTransitioning(false);
    }
  };

  const renderActions = () => {
    if (transitioning) {
      return <span className="ws-phase-transitioning">Transitioning...</span>;
    }

    const buttons: React.ReactNode[] = [];

    // Pause button for execution
    if (phase === 'execution') {
      buttons.push(
        <button key="pause" className="ws-phase-btn ws-phase-btn-secondary" onClick={() => advancePhase('paused')}>
          ⏸ Pause
        </button>,
      );
    }

    // Resume from paused
    if (phase === 'paused') {
      buttons.push(
        <button key="resume" className="ws-phase-btn ws-phase-btn-primary" onClick={() => advancePhase('execution')}>
          ▶ Resume
        </button>,
      );
    }

    // Next phase button
    if (config.next && config.nextLabel && phase !== 'paused') {
      buttons.push(
        <button key="next" className="ws-phase-btn ws-phase-btn-primary" onClick={() => advancePhase(config.next!)}>
          {config.nextLabel}
        </button>,
      );
    }

    return buttons;
  };

  return (
    <div className="ws-phase-bar">
      <div className="ws-phase-left">
        <span className="ws-title">{title}</span>
        <span className="ws-phase-badge" style={{ background: config.color }}>
          {config.icon} {config.label}
        </span>
        {tasks.length > 0 && (
          <span className="ws-task-progress">
            {completedCount}/{tasks.length} tasks
          </span>
        )}
      </div>
      <div className="ws-phase-actions">
        {renderActions()}
      </div>
    </div>
  );
};
