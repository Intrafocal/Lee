"""
Voice: Hester transcribes; Lee, Aeronaut and the T-Deck record
(docs/plans/2026-09-28-tether-review-voice.md §5).

One wire format everywhere: 16 kHz mono 16-bit PCM WAV as the raw request
body. ``GET /voice`` says whether the mic shows; ``POST /voice/transcribe``
returns the text for the field it belongs to. Single pass, no ReAct loop, no
session history; the audio, the hint and the text are never persisted or
logged. Off unless ``hester.voice.enabled: true``.
"""
