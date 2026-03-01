/**
 * RunbookPanel - Task list with status indicators, dispatch, and complete actions
 */

import React, { useState } from 'react';
import { ResolvedTask, TaskStatus, WorkstreamPhase } from './types';

const HESTER_DAEMON = 'http://127.0.0.1:9000';

interface RunbookPanelProps {
  wsId: string;
  phase: WorkstreamPhase;
  tasks: ResolvedTask[];
  onTasksChanged: () => void;
}

const STATUS_ICONS: Record<TaskStatus, string> = {
  completed: '✓',
  in_progress: '◉',
  ready: '○',
  blocked: '🔒',
};

export const RunbookPanel: React.FC<RunbookPanelProps> = ({
  wsId,
  phase,
  tasks,
  onTasksChanged,
}) => {
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [agentInput, setAgentInput] = useState('');
  const [generating, setGenerating] = useState(false);

  const addTask = async () => {
    if (!newTaskTitle.trim()) return;
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/runbook/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: newTaskTitle.trim() }),
      });
      if (res.ok) {
        setNewTaskTitle('');
        onTasksChanged();
      }
    } catch {
      // daemon unavailable
    }
  };

  const completeTask = async (taskId: string) => {
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/complete/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) onTasksChanged();
    } catch {
      // daemon unavailable
    }
  };

  const dispatchTask = async (taskId: string) => {
    if (!agentInput.trim()) return;
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/dispatch/${taskId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: agentInput.trim() }),
      });
      if (res.ok) {
        setDispatchingId(null);
        setAgentInput('');
        onTasksChanged();
      }
    } catch {
      // daemon unavailable
    }
  };

  const generateFromDesign = async () => {
    setGenerating(true);
    try {
      const res = await fetch(`${HESTER_DAEMON}/workstream/${wsId}/runbook/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (res.ok) onTasksChanged();
    } catch {
      // daemon unavailable
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="ws-runbook">
      <div className="ws-runbook-header">
        <span className="ws-runbook-title">Runbook</span>
        {phase === 'planning' && (
          <button
            className="ws-runbook-generate"
            onClick={generateFromDesign}
            disabled={generating}
          >
            {generating ? 'Generating...' : '⚡ Generate from Design'}
          </button>
        )}
      </div>

      <div className="ws-task-list">
        {tasks.length === 0 && (
          <div className="ws-task-empty">No tasks yet. Add one below or generate from design.</div>
        )}
        {tasks.map(task => (
          <div key={task.task_id} className={`ws-task ws-task-${task.status}`}>
            <span className={`ws-task-icon ws-task-icon-${task.status}`}>
              {STATUS_ICONS[task.status]}
            </span>
            <div className="ws-task-content">
              <span className="ws-task-title">{task.title}</span>
              {task.dependencies.length > 0 && task.status === 'blocked' && (
                <span className="ws-task-deps">
                  Blocked by: {task.dependencies.join(', ')}
                </span>
              )}
            </div>
            <div className="ws-task-actions">
              {task.status === 'ready' && (
                dispatchingId === task.task_id ? (
                  <div className="ws-dispatch-inline">
                    <input
                      className="ws-dispatch-input"
                      placeholder="agent_id"
                      value={agentInput}
                      onChange={e => setAgentInput(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') dispatchTask(task.task_id);
                        if (e.key === 'Escape') { setDispatchingId(null); setAgentInput(''); }
                      }}
                      autoFocus
                    />
                    <button className="ws-dispatch-go" onClick={() => dispatchTask(task.task_id)}>→</button>
                  </div>
                ) : (
                  <button className="ws-task-btn" onClick={() => setDispatchingId(task.task_id)} title="Dispatch to agent">
                    ▶
                  </button>
                )
              )}
              {task.status === 'in_progress' && (
                <button className="ws-task-btn ws-task-btn-complete" onClick={() => completeTask(task.task_id)} title="Mark complete">
                  ✓
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="ws-add-task">
        <input
          className="ws-add-task-input"
          placeholder="Add task..."
          value={newTaskTitle}
          onChange={e => setNewTaskTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') addTask(); }}
        />
        <button className="ws-add-task-btn" onClick={addTask} disabled={!newTaskTitle.trim()}>
          +
        </button>
      </div>
    </div>
  );
};
