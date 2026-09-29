/**
 * CommandPalette - Hester AI quick query modal
 *
 * Triggered by Cmd+/ anywhere in Lee. Connects to the Hester daemon
 * via SSE streaming to show real-time ReAct processing.
 *
 * In Deep (Deep D1 §5), `exploration` is passed and the footer offers
 * **Keep** (⌘K): the last response becomes a `quote` reference in that
 * exploration, source `palette`.
 *
 * At the Desk (D2 §7.2) the palette is about the zoomed Page card (`about:
 * page <title>`, through the steward), and Keep goes to that card; at the
 * overview there's no card to keep into.
 *
 * About (cockpit-design §6.2): opened while the Cockpit has a selected item,
 * the palette shows "about: <kind> <title> ×" above the field and asks
 * through POST /cockpit/ask (the steward); × makes the question general
 * again, and a general question streams through /context/stream. A steward
 * answer with proposals or a steer lists them under its text; "Review in
 * Home" (⌘⏎) hands the whole answer to Home's StewardAnswerView, where they
 * can be accepted (no second model call). The input
 * has no ring (the §1.4 rule): its rule brightens and the caret shows.
 *
 * Images (Tether §4.3): the question can carry images, attached here (the
 * image button, or pasting one into the field) or sent from a device with
 * Send to Lee (`initialImages`). They go to Hester as the ContextRequest's
 * `images`; a question with images always streams (the steward takes text
 * only). The mic (§5.3, purpose `ask`) fills the field; it never asks.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Icon, HesterGlyph, type IconName } from './Icon';
import { addReference } from '../lib/hesterDeep';
import { askSteward } from '../lib/hesterCockpit';
import type { AboutRef, StewardAnswer } from '../../shared/cockpit';
import { cockpitModeStore } from './cockpit/cockpitMode';
import { aboutLine, deskAboutFor, paletteAboutFor, paletteRoute, publishedPaletteAbout, stewardExtras } from './paletteAbout';
import { MicButton } from './voice/MicButton';
import type { PaletteImage } from '../lib/tetherDelivery';

const HESTER_DAEMON_PORT = 9000;

// Phase display names and icons
const PHASE_DISPLAY: Record<string, { icon: IconName; label: string }> = {
  preparing: { icon: 'settings', label: 'Preparing' },
  thinking: { icon: 'more', label: 'Thinking' },
  acting: { icon: 'play', label: 'Acting' },
  observing: { icon: 'eye', label: 'Observing' },
  responding: { icon: 'send', label: 'Responding' },
};

interface PhaseEvent {
  phase: string;
  iteration: number;
  tool_name?: string;
  tool_context?: string;
  model_used?: string;
  is_local?: boolean;
  tools_selected?: number;
  prepare_time_ms?: number;
}

interface ResponseEvent {
  session_id: string;
  status: string;
  text?: string;
  iterations?: number;
  tools_used?: string[];
  thinking_depth?: string;
  model_used?: string;
}

// Tab info for context awareness
interface TabInfo {
  id: number;
  type: string;
  label: string;
  dockPosition: string;
}

interface CommandPaletteProps {
  isOpen: boolean;
  onClose: () => void;
  onOpenAsTab: (sessionId: string) => void;
  workspace: string;
  tabs?: TabInfo[];
  activeTabId?: number | null;
  focusedPanel?: string;
  initialPrompt?: string | null;
  autoSubmit?: boolean; // If true (default), auto-submit initialPrompt; if false, just pre-populate
  onPromptConsumed?: () => void;
  /** The exploration open in Deep, if any: enables Keep. */
  exploration?: { workspace: string; id: string };
  /** Images to attach to the question (Send to Lee); taken once, like initialPrompt. */
  initialImages?: PaletteImage[] | null;
  onImagesConsumed?: () => void;
}

/** Largest image the palette attaches (Hester's own limit is higher; this keeps the request sane). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

function readImageFile(file: File): Promise<PaletteImage | null> {
  if (file.type !== 'image/png' && file.type !== 'image/jpeg') return Promise.resolve(null);
  if (file.size > MAX_IMAGE_BYTES) return Promise.resolve(null);
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result ?? '');
      const b64 = url.slice(url.indexOf(',') + 1);
      resolve(b64 ? { mime: file.type as PaletteImage['mime'], data_b64: b64, source: 'file', caption: file.name } : null);
    };
    r.onerror = () => resolve(null);
    r.readAsDataURL(file);
  });
}

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  isOpen,
  onClose,
  onOpenAsTab,
  workspace,
  tabs = [],
  activeTabId = null,
  focusedPanel = 'center',
  initialPrompt = null,
  autoSubmit = true,
  onPromptConsumed,
  exploration: explorationProp,
  initialImages = null,
  onImagesConsumed,
}) => {
  // At the Desk, Keep needs a card zoomed in (the overview has none to keep into).
  const deskNav = cockpitModeStore.get().deep;
  const exploration = explorationProp && (deskNav.zoom === 'card' || !deskNav.card_id) ? explorationProp : undefined;
  const [query, setQuery] = useState('');
  const hasAutoSubmittedRef = useRef(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [phases, setPhases] = useState<PhaseEvent[]>([]);
  const [viewingIndex, setViewingIndex] = useState<number>(-1); // -1 means latest
  const [response, setResponse] = useState<ResponseEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDaemonHealthy, setIsDaemonHealthy] = useState<boolean | null>(null);
  const [kept, setKept] = useState<'idle' | 'saving' | 'kept' | 'error'>('idle');
  const [about, setAbout] = useState<AboutRef | null>(null);
  const [steward, setSteward] = useState<{ answer: StewardAnswer; question: string } | null>(null);
  const askSeq = useRef(0);
  const [images, setImages] = useState<PaletteImage[]>([]);
  const imagesRef = useRef<PaletteImage[]>([]);
  imagesRef.current = images;
  const fileRef = useRef<HTMLInputElement>(null);
  /** The question came from the mic: tag the request `input: 'voice'`. */
  const viaVoice = useRef(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const sessionIdRef = useRef<string>(`palette-${Date.now()}`);

  // Check daemon health on mount
  useEffect(() => {
    if (isOpen) {
      // The Cockpit's selected item, if any, is what this question is about.
      const st = cockpitModeStore.get();
      setAbout(paletteAboutFor(st, publishedPaletteAbout()) ?? deskAboutFor(st));
      checkDaemonHealth();
      // Focus input when opened
      setTimeout(() => inputRef.current?.focus(), 50);
      // Reset auto-submit flag when opened
      hasAutoSubmittedRef.current = false;
    }
  }, [isOpen]);

  // Images sent with Send to Lee join whatever is attached already.
  useEffect(() => {
    if (!isOpen || !initialImages?.length) return;
    setImages((l) => [...l, ...initialImages]);
    imagesRef.current = [...imagesRef.current, ...initialImages];
    onImagesConsumed?.();
  }, [isOpen, initialImages, onImagesConsumed]);

  // A new prompt while open (a second Send to Lee) is taken like the first.
  useEffect(() => {
    if (initialPrompt) hasAutoSubmittedRef.current = false;
  }, [initialPrompt]);

  // Handle initial prompt - auto-submit when provided (if autoSubmit is true)
  useEffect(() => {
    if (isOpen && initialPrompt && !hasAutoSubmittedRef.current && isDaemonHealthy !== false) {
      hasAutoSubmittedRef.current = true;
      setQuery(initialPrompt);
      // Notify that we consumed the prompt
      if (onPromptConsumed) {
        onPromptConsumed();
      }
      // Only auto-submit if autoSubmit is true
      if (autoSubmit) {
        setTimeout(() => {
          submitQuery(initialPrompt);
        }, 100);
      }
    }
  }, [isOpen, initialPrompt, isDaemonHealthy, onPromptConsumed, autoSubmit]);

  // Reset state when closed
  useEffect(() => {
    if (!isOpen) {
      // Cancel any in-flight request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      askSeq.current++;
      // Reset after animation
      setTimeout(() => {
        setQuery('');
        setPhases([]);
        setViewingIndex(-1);
        setResponse(null);
        setError(null);
        setIsProcessing(false);
        setKept('idle');
        setAbout(null);
        setSteward(null);
        setImages([]);
        viaVoice.current = false;
        sessionIdRef.current = `palette-${Date.now()}`;
      }, 200);
    }
  }, [isOpen]);

  const checkDaemonHealth = async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${HESTER_DAEMON_PORT}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(2000),
      });
      const data = await response.json();
      setIsDaemonHealthy(data.status === 'healthy');
    } catch {
      // Periodic health poll: the palette already shows the unhealthy state,
      // so a message per poll would just be noise.
      setIsDaemonHealthy(false);
    }
  };

  // Core submit logic - can be called with any query string
  const submitQuery = useCallback(async (queryText: string) => {
    if (!queryText.trim() || isProcessing) return;

    // Reset state for new query
    setKept('idle');
    setPhases([]);
    setViewingIndex(-1);
    setResponse(null);
    setSteward(null);
    setError(null);
    setIsProcessing(true);

    // About an item: the steward answers in one piece (no phases, no session).
    // A question with images streams: the steward takes text only.
    const attached = imagesRef.current;
    const route = attached.length ? paletteRoute(null) : paletteRoute(about);
    if (route.kind === 'steward') {
      const seq = ++askSeq.current;
      const r = await askSteward(workspace, queryText.trim(), route.about);
      if (seq !== askSeq.current) return;
      if (r.ok) {
        setResponse({ session_id: '', status: 'done', text: r.data.text });
        setSteward({ answer: r.data, question: queryText.trim() });
      } else setError(r.error || 'Hester could not answer');
      setIsProcessing(false);
      return;
    }

    // Create new abort controller
    abortControllerRef.current = new AbortController();

    try {
      // Find the active tab to determine current context
      const activeTab = tabs.find(t => t.id === activeTabId);
      const openFiles = tabs
        .filter(t => t.type === 'editor')
        .map(t => t.label);

      const requestBody = {
        session_id: sessionIdRef.current,
        source: 'Lee' as const,
        message: queryText.trim(),
        editor_state: {
          working_directory: workspace || process.cwd?.() || '.',
          open_files: openFiles,
          active_file: activeTab?.type === 'editor' ? activeTab.label : null,
        },
        // Additional context for Hester
        lee_context: {
          focused_panel: focusedPanel,
          active_tab: activeTab ? {
            id: activeTab.id,
            type: activeTab.type,
            label: activeTab.label,
          } : null,
          tabs: tabs.map(t => ({
            id: t.id,
            type: t.type,
            label: t.label,
            dock_position: t.dockPosition,
          })),
        },
        // Tether §4.3: images attached here or sent from a device (base64, as ImageData takes them).
        ...(attached.length ? { images: attached.map((i) => ({ data: i.data_b64, mime_type: i.mime, source: i.source })) } : {}),
        ...(viaVoice.current ? { input: 'voice' as const } : {}),
      };
      viaVoice.current = false;

      const fetchResponse = await fetch(
        `http://127.0.0.1:${HESTER_DAEMON_PORT}/context/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'text/event-stream',
            // Copilot v4 §5.1: the model-call trigger's surface (never loads steward.md).
            'X-Lee-Trigger': 'palette',
          },
          body: JSON.stringify(requestBody),
          signal: abortControllerRef.current.signal,
        }
      );

      if (!fetchResponse.ok) {
        throw new Error(`HTTP ${fetchResponse.status}: ${fetchResponse.statusText}`);
      }

      // Read the SSE stream
      const reader = fetchResponse.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        let currentEvent = '';
        let currentData = '';

        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ')) {
            currentData = line.slice(6);
          } else if (line === '' && currentEvent && currentData) {
            // End of event, process it
            try {
              const data = JSON.parse(currentData);

              switch (currentEvent) {
                case 'phase':
                  setPhases((prev) => [...prev, data as PhaseEvent]);
                  setViewingIndex(-1); // Always show latest during processing
                  break;
                case 'response':
                  setResponse(data as ResponseEvent);
                  break;
                case 'error':
                  setError(data.error || 'Unknown error');
                  break;
                case 'done':
                  // Processing complete
                  break;
              }
            } catch (parseError) {
              console.error('Failed to parse SSE data:', parseError, currentData);
            }

            currentEvent = '';
            currentData = '';
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Request was cancelled, don't show error
        return;
      }
      console.error('Command palette error:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect to Hester');
    } finally {
      setIsProcessing(false);
    }
  }, [isProcessing, workspace, tabs, activeTabId, focusedPanel, about]);

  // Form submit handler - uses current query state
  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    await submitQuery(query);
  }, [query, submitQuery]);

  const handleOpenAsTab = useCallback(() => {
    if (response?.session_id) {
      onOpenAsTab(response.session_id);
      onClose();
    }
  }, [response, onOpenAsTab, onClose]);

  // Review in Home (§6.2): the whole steward answer, so its proposals and steer can be acted on.
  const extras = stewardExtras(steward?.answer);
  const handleReviewInHome = useCallback(() => {
    if (!steward) return;
    if (cockpitModeStore.requestSteward({ kind: 'answer', answer: steward.answer, question: steward.question })) onClose();
    else setError('The Cockpit is not available here');
  }, [steward, onClose]);

  // Keep (Deep D1 §5.5): the last response as a quote reference in the open exploration.
  const handleKeep = useCallback(async () => {
    const text = response?.text?.trim();
    if (!exploration || !text || kept === 'saving' || kept === 'kept') return;
    setKept('saving');
    const r = await addReference(exploration.workspace, exploration.id, { kind: 'quote', quote: text, source: { kind: 'palette' } });
    setKept(r.ok ? 'kept' : 'error');
    if (r.ok) {
      try {
        const ids = /^pg-[0-9a-f]{8}$/.test(exploration.id) ? { card_id: exploration.id, card_kind: 'page' as const } : { exploration_id: exploration.id };
        window.lee?.cockpit?.logEvent({ type: 'deep.action', data: { action: 'keep', ...ids, chars: text.length } });
      } catch {
        /* cockpit IPC not available */
      }
    }
  }, [exploration, response, kept]);

  // Handle keyboard shortcuts (Escape to close, Cmd+Enter to open as tab, Cmd+K to Keep in Deep)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!isOpen) return;

      // Escape to close
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }

      // Cmd+K keeps the response in the open exploration (Deep only)
      if (exploration && e.metaKey && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K') && response?.text && !error) {
        e.preventDefault();
        e.stopPropagation();
        void handleKeep();
        return;
      }

      // Cmd+Enter to open as Hester tab (a streamed response has a session)
      if (e.key === 'Enter' && e.metaKey && response?.session_id && !error) {
        e.preventDefault();
        e.stopPropagation();
        handleOpenAsTab();
        return;
      }

      // Cmd+Enter hands a steward answer with proposals to Home
      if (e.key === 'Enter' && e.metaKey && extras && !error) {
        e.preventDefault();
        e.stopPropagation();
        handleReviewInHome();
      }
    };

    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown, true);
      return () => window.removeEventListener('keydown', handleKeyDown, true);
    }
  }, [isOpen, onClose, response, error, handleOpenAsTab, exploration, handleKeep, extras, handleReviewInHome]);

  if (!isOpen) return null;

  return (
    <div className="command-palette-overlay" onClick={onClose}>
      <div className="command-palette" onClick={(e) => e.stopPropagation()}>
        {about && (
          <div className="command-palette-about" title={about.label}>
            <span className="command-palette-about-text">
              about: {aboutLine(about).kind} <span className="command-palette-about-title">{aboutLine(about).title}</span>
            </span>
            <button
              type="button"
              className="command-palette-about-clear"
              onClick={() => {
                setAbout(null);
                inputRef.current?.focus();
              }}
              aria-label="Clear about: ask a general question"
              title="Ask a general question"
            >
              ×
            </button>
          </div>
        )}
        {/* Header with input */}
        <form onSubmit={handleSubmit} className="command-palette-header">
          <span className="command-palette-icon"><HesterGlyph size={16} /></span>
          <input
            ref={inputRef}
            type="text"
            className="command-palette-input"
            placeholder={
              isDaemonHealthy === false
                ? 'Hester daemon not running...'
                : about
                  ? `Ask about ${aboutLine(about).title}…`
                  : 'Ask Hester anything...'
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type === 'image/png' || f.type === 'image/jpeg');
              if (!files.length) return;
              e.preventDefault();
              void Promise.all(files.map(readImageFile)).then((got) => setImages((l) => [...l, ...got.filter((x): x is PaletteImage => !!x)]));
            }}
            disabled={isProcessing || isDaemonHealthy === false}
          />
          <MicButton
            workspace={workspace}
            purpose="ask"
            value={query}
            onChange={(t) => setQuery(t)}
            onVoice={() => {
              viaVoice.current = true;
            }}
            fieldRef={inputRef}
            disabled={isProcessing || isDaemonHealthy === false}
          />
          <button
            type="button"
            className="command-palette-attach"
            onClick={() => fileRef.current?.click()}
            disabled={isProcessing || isDaemonHealthy === false}
            aria-label="Attach an image"
            title="Attach an image (or paste one)"
          >
            <Icon name="image" size={14} />
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            hidden
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              e.target.value = '';
              void Promise.all(files.map(readImageFile)).then((got) => setImages((l) => [...l, ...got.filter((x): x is PaletteImage => !!x)]));
              inputRef.current?.focus();
            }}
          />
          <span className="command-palette-shortcut">⌘/</span>
        </form>

        {images.length > 0 && (
          <div className="command-palette-images">
            {images.map((img, i) => (
              <span key={`${i}:${img.data_b64.length}`} className="command-palette-image" title={img.caption || img.source}>
                <img src={`data:${img.mime};base64,${img.data_b64}`} alt={img.caption || 'attached image'} />
                <button
                  type="button"
                  className="command-palette-image-remove"
                  onClick={() => setImages((l) => l.filter((_, j) => j !== i))}
                  disabled={isProcessing}
                  aria-label="Remove this image"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {/* Daemon status warning */}
        {isDaemonHealthy === false && (
          <div className="command-palette-warning">
            <span><Icon name="warning" size={14} /></span>
            <span>Hester daemon is not running. Start it with: <code>hester daemon start</code></span>
          </div>
        )}

        {/* Phase indicator with navigation */}
        {phases.length > 0 && (
          <div className="command-palette-phases">
            {(() => {
              const displayIndex = viewingIndex === -1 ? phases.length - 1 : viewingIndex;
              const currentPhase = phases[displayIndex];
              const canGoBack = displayIndex > 0;
              const canGoForward = displayIndex < phases.length - 1;
              const isViewingLatest = viewingIndex === -1 || viewingIndex === phases.length - 1;

              return (
                <>
                  <div className={`command-palette-phase ${currentPhase.phase}`}>
                    <span className="phase-icon">
                      <Icon name={PHASE_DISPLAY[currentPhase.phase]?.icon || 'dot'} size={14} />
                    </span>
                    <span className="phase-label">
                      {PHASE_DISPLAY[currentPhase.phase]?.label || currentPhase.phase}
                    </span>
                    {currentPhase.tool_name && (
                      <span className="phase-tool">{currentPhase.tool_name}</span>
                    )}
                    {currentPhase.tool_context && (
                      <span className="phase-context">{currentPhase.tool_context}</span>
                    )}
                    {currentPhase.is_local && (
                      <span className="phase-local">LOCAL</span>
                    )}
                    {currentPhase.iteration > 1 && (
                      <span className="phase-iteration">iter {currentPhase.iteration}</span>
                    )}
                  </div>
                  {phases.length > 1 && (
                    <div className="phase-nav">
                      <button
                        className="phase-nav-btn"
                        onClick={() => setViewingIndex(displayIndex - 1)}
                        disabled={!canGoBack}
                        title="Previous phase"
                      >
                        ‹
                      </button>
                      <span className="phase-nav-counter">
                        {displayIndex + 1}/{phases.length}
                      </span>
                      <button
                        className="phase-nav-btn"
                        onClick={() => setViewingIndex(isViewingLatest ? -1 : displayIndex + 1)}
                        disabled={!canGoForward}
                        title="Next phase"
                      >
                        ›
                      </button>
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}

        {/* Error display */}
        {error && (
          <div className="command-palette-error">
            <span><Icon name="close" size={14} className="command-palette-error-icon" /></span>
            <span>{error}</span>
          </div>
        )}

        {/* Response display */}
        {response?.text && (
          <div className="command-palette-response">
            <div className="response-content">
              {response.text}
            </div>
            {response.iterations !== undefined && (
              <div className="response-meta">
                <span>{response.iterations} iterations</span>
                {response.tools_used && response.tools_used.length > 0 && (
                  <span>{response.tools_used.length} tools</span>
                )}
                {response.thinking_depth && (
                  <span className="response-depth">{response.thinking_depth}</span>
                )}
              </div>
            )}
            {extras && (
              <div className="command-palette-proposals">
                {extras.proposals.length > 0 && (
                  <>
                    <div className="command-palette-proposals-head">Hester proposes</div>
                    <ul>
                      {extras.proposals.map((label, i) => (
                        <li key={`${i}:${label}`}>{label}</li>
                      ))}
                    </ul>
                  </>
                )}
                {extras.steer && (
                  <>
                    <div className="command-palette-proposals-head">Hester would send the agent</div>
                    <pre className="command-palette-steer">{extras.steer}</pre>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* Footer with actions */}
        {(response || error) && (
          <div className="command-palette-footer">
            <button className="command-palette-btn secondary" onClick={onClose}>
              Dismiss
              <kbd>Esc</kbd>
            </button>
            {exploration && response?.text && !error && (
              <button
                className="command-palette-btn secondary"
                onClick={() => void handleKeep()}
                disabled={kept === 'saving' || kept === 'kept'}
                title="Keep this answer as a reference in the open exploration"
              >
                {kept === 'kept' ? 'Kept' : kept === 'error' ? 'Keep failed · retry' : 'Keep'}
                <kbd>⌘K</kbd>
              </button>
            )}
            {extras && !error && (
              <button className="command-palette-btn secondary" onClick={handleReviewInHome} title="Show this answer in Home, where its proposals can be accepted">
                Review in Home
                <kbd>⌘⏎</kbd>
              </button>
            )}
            {response?.session_id && !error && (
              <button className="command-palette-btn primary" onClick={handleOpenAsTab}>
                Open as Hester Tab
                <kbd>⌘⏎</kbd>
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
