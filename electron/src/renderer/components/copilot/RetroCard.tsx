/**
 * RetroCard - weekly retro prompt, three optional free-text answers, Save
 * and Skip this week (contracts §8.6, §9.1).
 */

import React, { useEffect, useState } from 'react';
import { fetchRetro, saveRetro, type RetroResponse } from '../../lib/hesterCopilot';

interface RetroCardProps {
  onDone?: () => void;
}

export const RetroCard: React.FC<RetroCardProps> = ({ onDone }) => {
  const [retro, setRetro] = useState<RetroResponse | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<'saved' | 'skipped' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchRetro().then((res) => {
      if (res.ok) setRetro(res.data);
      else setError(res.error);
    });
  }, []);

  if (error) return <div className="copilot-digest-empty">{error}</div>;
  if (!retro) return <div className="copilot-digest-empty">Loading…</div>;
  if (!retro.due || retro.answered || retro.skipped) return null;
  if (saved) {
    return <div className="copilot-retro-card"><span className="copilot-retro-saved">{saved === 'saved' ? 'Thanks — saved.' : 'Skipped this week.'}</span></div>;
  }

  const submit = async (skip: boolean) => {
    setBusy(true);
    try {
      const res = await saveRetro({ week: retro.week, answers: skip ? undefined : answers, skipped: skip });
      if (res.ok) {
        setSaved(skip ? 'skipped' : 'saved');
        onDone?.();
      } else {
        setError(res.error);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="copilot-retro-card">
      {retro.questions.map((q) => (
        <div className="copilot-retro-question" key={q.id}>
          <div className="copilot-retro-question-text">{q.text}</div>
          <textarea
            className="copilot-textarea"
            value={answers[q.id] || ''}
            onChange={(e) => setAnswers((a) => ({ ...a, [q.id]: e.target.value }))}
          />
        </div>
      ))}
      <div className="copilot-retro-actions">
        <button className="copilot-btn" onClick={() => void submit(true)} disabled={busy}>
          Skip this week
        </button>
        <button className="copilot-btn copilot-btn-primary" onClick={() => void submit(false)} disabled={busy}>
          Save
        </button>
      </div>
    </div>
  );
};

export default RetroCard;
