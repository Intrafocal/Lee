/**
 * PhaseBar - Workstream header with title, phase badge, and transition buttons
 */

import React, { useState } from 'react';
import { WorkstreamPhase, PHASE_CONFIG, PHASE_ORDER, ResolvedTask } from './types';
import { Icon } from '../Icon';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface PhaseBarProps {
  wsId: string;
  title: string;
  phase: WorkstreamPhase;
  tasks: ResolvedTask[];
  /** Goal ids the workstream serves (v4). */
  serves?: string[];
  onPhaseChanged: () => void;
}

export const PhaseBar: React.FC<PhaseBarProps> = ({
  wsId,
  title,
  phase,
  tasks,
  serves,
  onPhaseChanged,
}) => {
  const [transitioning, setTransitioning] = useState(false);
  const config = PHASE_CONFIG[phase] || { label: phase, color: '#666', icon: 'dot' as const };
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
      // Daemon unavailable; reported once by the status bar indicator.
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
          <Icon name="stop" size={12} className="icon-inline" /> Pause
        </button>,
      );
    }

    // Resume from paused
    if (phase === 'paused') {
      buttons.push(
        <button key="resume" className="ws-phase-btn ws-phase-btn-primary" onClick={() => advancePhase('execution')}>
          <Icon name="play" size={12} className="icon-inline" /> Resume
        </button>,
      );
    }

    // Phases are soft (v4): step back to the previous phase without pausing.
    const idx = PHASE_ORDER.indexOf(phase);
    if (idx > 0) {
      const prev = PHASE_ORDER[idx - 1];
      buttons.push(
        <button key="back" className="ws-phase-btn ws-phase-btn-secondary" title={`Move back to ${PHASE_CONFIG[prev].label}`} onClick={() => advancePhase(prev)}>
          <Icon name="arrow-left" size={12} className="icon-inline" /> Back to {PHASE_CONFIG[prev].label}
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
          <Icon name={config.icon} size={12} className="icon-inline" /> {config.label}
        </span>
        {serves && serves.length > 0 && (
          <span className="ws-task-progress" title="Goals this workstream serves">
            serves {serves.join(', ')}
          </span>
        )}
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
