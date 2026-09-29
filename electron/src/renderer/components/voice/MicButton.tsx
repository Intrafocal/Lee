/**
 * MicButton - the mic next to a text field (§5.3 R). Hidden unless Hester's
 * voice is available. Tap to start and tap again to stop, or hold and let go;
 * a ring follows your level while it records, a spinner while Hester
 * transcribes, and one quiet line under the field when something went wrong.
 *
 * The transcript is appended to the field's value (appendTranscript), focus
 * goes back to the field with the caret at the end, and `onVoice` tells the
 * owner the next send carries `input: 'voice'`. It never sends.
 *
 * With `fieldRef`, ⌘⇧M in that field toggles the mic and Esc while
 * recording cancels (field-scoped: nothing global).
 */

import React, { useEffect, useRef } from 'react';
import { appendTranscript, type VoicePurpose } from '../../../shared/voice';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { elapsedLabel } from '../../lib/voice/voiceModel';
import { Icon } from '../Icon';
import './voice.css';

type Field = HTMLInputElement | HTMLTextAreaElement;

export interface MicButtonProps {
  workspace: string;
  purpose: VoicePurpose;
  /** The field's current text. */
  value: string;
  /** The new text (the transcript appended) and where the caret goes. */
  onChange: (text: string, caret: number) => void;
  /** The field, for focus, the caret and the ⌘⇧M shortcut. */
  fieldRef?: React.RefObject<Field | null>;
  /** The next send came from the mic (tag it `input: 'voice'`). */
  onVoice?: () => void;
  itemId?: string;
  disabled?: boolean;
  className?: string;
}

export const MicButton: React.FC<MicButtonProps> = ({ workspace, purpose, value, onChange, fieldRef, onVoice, itemId, disabled, className }) => {
  const valueRef = useRef(value);
  valueRef.current = value;
  const voice = useVoiceInput({
    workspace,
    purpose,
    itemId,
    enabled: !disabled,
    onTranscript: (t) => {
      const r = appendTranscript(valueRef.current, t);
      onChange(r.text, r.caret);
      onVoice?.();
      requestAnimationFrame(() => {
        const f = fieldRef?.current;
        if (!f) return;
        f.focus();
        try {
          f.setSelectionRange(r.caret, r.caret);
        } catch {
          /* not a text field */
        }
      });
    },
  });

  // ⌘⇧M (Ctrl+Shift+M elsewhere) in the field toggles; Esc while recording cancels.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  useEffect(() => {
    const f = fieldRef?.current;
    if (!f) return;
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      const v = voiceRef.current;
      if (!v.available) return;
      if ((k.metaKey || k.ctrlKey) && k.shiftKey && !k.altKey && (k.key === 'm' || k.key === 'M')) {
        k.preventDefault();
        k.stopPropagation();
        v.toggle();
      } else if (k.key === 'Escape' && (v.state === 'recording' || v.state === 'arming' || v.state === 'transcribing')) {
        k.preventDefault();
        k.stopPropagation();
        v.cancel();
      }
    };
    f.addEventListener('keydown', onKey);
    return () => f.removeEventListener('keydown', onKey);
  }, [fieldRef, voice.available]);

  if (!voice.available) return null;
  const recording = voice.state === 'recording';
  const busy = voice.state === 'transcribing' || voice.state === 'arming';
  const label = recording ? 'Stop and transcribe' : busy ? 'Transcribing…' : 'Speak (⌘⇧M)';
  return (
    <span className={`voice-mic${className ? ` ${className}` : ''}`}>
      <button
        type="button"
        className={`voice-mic-btn${recording ? ' is-recording' : ''}${busy ? ' is-busy' : ''}`}
        style={{ '--voice-level': voice.level.toFixed(3) } as React.CSSProperties}
        aria-label={label}
        aria-pressed={recording}
        title={label}
        disabled={disabled || voice.state === 'transcribing'}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault(); // keep focus in the field
          voice.press();
        }}
        onPointerUp={() => voice.release()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            voice.toggle();
          }
        }}
      >
        {busy ? <span className="voice-spinner" aria-hidden="true" /> : <Icon name="mic" size={14} />}
      </button>
      {recording && <span className="voice-elapsed">{elapsedLabel(voice.elapsedMs)}</span>}
      {voice.error && (
        <span className="voice-error" role="status">
          {voice.error}
        </span>
      )}
    </span>
  );
};
