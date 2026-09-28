/**
 * useVoiceInput - one field's mic (§5.3): capabilities, the state machine
 * (lib/voice/voiceModel), the recording and the transcribe call.
 *
 * - The mic shows only when Hester says voice is `available`.
 * - One recording at a time in the whole window: starting here cancels any
 *   other (a module-level lock).
 * - A transcript goes to `onTranscript` (the field appends it with
 *   appendTranscript and puts focus back). Nothing is ever sent from here.
 * - Errors show inline for a few seconds, then the mic is idle again.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceErrorCode, VoicePurpose, VoiceState } from '../../shared/voice';
import { startRecording, type Recording } from '../lib/voice/recorder';
import { transcribe, voiceCapabilities, voiceErrorText } from '../lib/voice/hesterVoice';
import { recordCapMs, voiceStep, type VoiceEvent } from '../lib/voice/voiceModel';
import { micRequest, micStatus } from '../lib/tetherIpc';

const ERROR_MS = 5000;

/** The window's one live recording: whoever holds it, and how to make them let go. */
let lockHolder: { id: symbol; cancel: () => void } | null = null;

export interface VoiceInput {
  available: boolean;
  state: VoiceState;
  /** 0..1 while recording, for the level ring. */
  level: number;
  elapsedMs: number;
  error: string | null;
  /** Pointer down on the mic (or a keyboard toggle with `release` straight after). */
  press(): void;
  release(): void;
  /** Tap semantics in one call (the keyboard shortcut). */
  toggle(): void;
  cancel(): void;
}

export interface VoiceInputOptions {
  workspace: string;
  purpose: VoicePurpose;
  /** The attention item a reply is for (the vocabulary hint). */
  itemId?: string;
  onTranscript: (text: string) => void;
  /** Off hides the mic even when voice is available (e.g. the field is disabled). */
  enabled?: boolean;
}

export function useVoiceInput(opts: VoiceInputOptions): VoiceInput {
  const { workspace, purpose, itemId, enabled = true } = opts;
  const onTranscript = useRef(opts.onTranscript);
  onTranscript.current = opts.onTranscript;

  const [available, setAvailable] = useState(false);
  const [maxSeconds, setMaxSeconds] = useState<number | null>(null);
  const [state, setState] = useState<VoiceState>('idle');
  const stateRef = useRef<VoiceState>('idle');
  const [level, setLevel] = useState(0);
  const [elapsedMs, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const id = useRef(Symbol('voice'));
  const rec = useRef<Recording | null>(null);
  const pressAt = useRef(0);
  const startedByPress = useRef(false);
  const capTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const errTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abort = useRef<AbortController | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Capabilities: on mount, and again whenever the mic comes back to idle (a 503 dropped the cache).
  useEffect(() => {
    if (!workspace || !enabled) return;
    let live = true;
    void voiceCapabilities(workspace).then((caps) => {
      if (!live) return;
      setAvailable(!!caps?.available);
      setMaxSeconds(caps?.max_seconds ?? null);
    });
    return () => {
      live = false;
    };
  }, [workspace, enabled, state === 'idle']);

  const clearTimers = () => {
    if (capTimer.current) clearTimeout(capTimer.current);
    if (tickTimer.current) clearInterval(tickTimer.current);
    capTimer.current = null;
    tickTimer.current = null;
  };

  const release = () => {
    clearTimers();
    if (lockHolder?.id === id.current) lockHolder = null;
    if (alive.current) setLevel(0);
  };

  const fail = (code: VoiceErrorCode) => {
    release();
    rec.current = null;
    if (!alive.current) return;
    const text = voiceErrorText(code);
    if (!text) {
      go({ kind: 'cancel' });
      return;
    }
    setError(text);
    go({ kind: 'failed' });
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => {
      if (!alive.current) return;
      setError(null);
      go({ kind: 'clear' });
    }, ERROR_MS);
  };

  const stop = async () => {
    const r = rec.current;
    rec.current = null;
    clearTimers();
    if (!r) return;
    const out = await r.stop();
    release();
    if (!out.ok) return fail(out.error);
    abort.current = new AbortController();
    const t = await transcribe(workspace, out.clip.wav, purpose, { itemId, signal: abort.current.signal });
    abort.current = null;
    if (!alive.current) return;
    if (!t.ok) return fail(t.error);
    go({ kind: 'transcribed' });
    if (t.data.text.trim()) onTranscript.current(t.data.text);
    else fail('silence');
  };

  const start = async () => {
    if (lockHolder && lockHolder.id !== id.current) lockHolder.cancel();
    lockHolder = { id: id.current, cancel: () => cancelRef.current() };
    setError(null);
    if (errTimer.current) clearTimeout(errTimer.current);
    const status = await micStatus();
    if (status === 'denied' || status === 'restricted') return fail('permission_denied');
    if (status === 'not-determined' && !(await micRequest())) return fail('permission_denied');
    if (stateRef.current !== 'arming') return release(); // cancelled while asking
    let r: Recording;
    try {
      r = await startRecording((l) => alive.current && setLevel(l));
    } catch {
      return fail('permission_denied');
    }
    if (stateRef.current !== 'arming') {
      r.cancel();
      return release();
    }
    rec.current = r;
    const t0 = Date.now();
    setElapsed(0);
    tickTimer.current = setInterval(() => alive.current && setElapsed(Date.now() - t0), 250);
    capTimer.current = setTimeout(() => go({ kind: 'cap' }), recordCapMs(maxSeconds));
    go({ kind: 'armed' });
  };

  const discard = () => {
    rec.current?.cancel();
    rec.current = null;
    abort.current?.abort();
    abort.current = null;
    release();
  };

  // The one dispatcher: step the machine, then run its effect.
  const go = (ev: VoiceEvent) => {
    const { state: next, effect } = voiceStep(stateRef.current, ev);
    stateRef.current = next;
    if (alive.current) setState(next);
    if (effect === 'start') void start();
    else if (effect === 'stop') void stop();
    else if (effect === 'discard') discard();
  };
  const goRef = useRef(go);
  goRef.current = go;
  const cancelRef = useRef(() => goRef.current({ kind: 'cancel' }));

  // Unmounting mid-recording discards it (and lets go of the lock).
  useEffect(
    () => () => {
      rec.current?.cancel();
      abort.current?.abort();
      clearTimers();
      if (errTimer.current) clearTimeout(errTimer.current);
      if (lockHolder?.id === id.current) lockHolder = null;
    },
    [],
  );

  const press = useCallback(() => {
    pressAt.current = Date.now();
    startedByPress.current = stateRef.current === 'idle' || stateRef.current === 'error';
    goRef.current({ kind: 'press' });
  }, []);
  const releaseFn = useCallback(() => {
    goRef.current({ kind: 'release', heldMs: Date.now() - pressAt.current, startedByThisPress: startedByPress.current });
    startedByPress.current = false;
  }, []);
  const toggle = useCallback(() => {
    startedByPress.current = false;
    goRef.current({ kind: 'press' });
  }, []);
  const cancel = useCallback(() => goRef.current({ kind: 'cancel' }), []);

  return { available: available && enabled, state, level, elapsedMs, error, press, release: releaseFn, toggle, cancel };
}
