import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/machine.dart';
import '../models/voice.dart';
import '../services/voice_api.dart';
import '../services/voice_recorder.dart';
import 'machines_provider.dart';
import 'speech_provider.dart';

/// Voice on the phone (docs/plans/2026-09-28-tether-review-voice.md §5.3,
/// §5.5). The rules every client follows: the mic shows only when Hester
/// says voice is available (cached 5 min, refetched after a 503); one
/// recording at a time; tap toggles and a hold over 300 ms stops on
/// release; the cap auto-stops and still transcribes; cancel discards;
/// silent or too-short clips are never uploaded; a transcript fills its
/// field and is never sent for you.

/// Builds the API and the recorder; tests override these.
final voiceApiFactoryProvider = Provider<VoiceApi Function(Machine machine)>((ref) => (m) => VoiceApi(machine: m));
final voiceRecorderFactoryProvider = Provider<VoiceRecorder Function()>((ref) => RecordVoiceRecorder.new);

/// Hester's `GET /voice` for the active machine, cached for
/// [voiceCapabilitiesTtl].
class VoiceCapabilitiesNotifier extends StateNotifier<VoiceCapabilities> {
  final Ref _ref;
  final Machine? _machine;
  DateTime? _fetchedAt;
  Future<void>? _inFlight;

  VoiceCapabilitiesNotifier(this._ref, this._machine) : super(VoiceCapabilities.unavailable) {
    ensureFresh();
  }

  /// Refetches when the cache is older than the TTL (or [force]).
  Future<void> ensureFresh({bool force = false}) {
    final machine = _machine;
    if (machine == null) return Future.value();
    final fresh = _fetchedAt != null && DateTime.now().difference(_fetchedAt!) < voiceCapabilitiesTtl;
    if (fresh && !force) return Future.value();
    return _inFlight ??= () async {
      final api = _ref.read(voiceApiFactoryProvider)(machine);
      try {
        final caps = await api.capabilities();
        _fetchedAt = DateTime.now();
        if (mounted) state = caps;
      } finally {
        api.dispose();
        _inFlight = null;
      }
    }();
  }
}

final voiceCapabilitiesProvider = StateNotifierProvider<VoiceCapabilitiesNotifier, VoiceCapabilities>((ref) {
  final machine = ref.watch(machinesProvider.select((s) => s.activeMachine));
  return VoiceCapabilitiesNotifier(ref, machine);
});

/// The one recording in the app: who holds the mic and where it is.
class VoiceSession extends Equatable {
  final VoiceState state;

  /// The field that holds the mic (a key each [VoiceButton] picks).
  final String? owner;

  /// Live level, 0..1, while recording.
  final double level;
  final Duration elapsed;
  final VoiceErrorCode? error;

  const VoiceSession({this.state = VoiceState.idle, this.owner, this.level = 0, this.elapsed = Duration.zero, this.error});

  bool busyFor(String key) => owner == key && (state == VoiceState.arming || state == VoiceState.recording || state == VoiceState.transcribing);

  @override
  List<Object?> get props => [state, owner, level, elapsed, error];
}

class VoiceNotifier extends StateNotifier<VoiceSession> {
  final Ref _ref;
  VoiceRecorder? _recorder;
  StreamSubscription<double>? _levelSub;
  Timer? _ticker;
  Timer? _cap;
  DateTime? _startedAt;
  VoicePurpose _purpose = VoicePurpose.reply;
  String? _itemId;
  String? _workspace;
  void Function(String text)? _onTranscript;

  VoiceNotifier(this._ref) : super(const VoiceSession());

  /// Starts recording for [owner]; [onTranscript] gets the text once it's
  /// back. False when another field holds the mic or the mic is refused.
  Future<bool> start(
    String owner, {
    required VoicePurpose purpose,
    required void Function(String text) onTranscript,
    String? itemId,
    String? workspace,
  }) async {
    if (state.state == VoiceState.arming || state.state == VoiceState.recording || state.state == VoiceState.transcribing) {
      return false;
    }
    // Readback stops the moment you start talking (§5.5).
    _ref.read(speechProvider.notifier).stopSpeaking();
    state = VoiceSession(state: VoiceState.arming, owner: owner);
    final recorder = _recorder ??= _ref.read(voiceRecorderFactoryProvider)();
    final allowed = await recorder.hasPermission();
    if (!allowed) {
      _fail(owner, VoiceErrorCode.permissionDenied);
      return false;
    }
    try {
      await recorder.start();
    } catch (_) {
      _fail(owner, VoiceErrorCode.permissionDenied);
      return false;
    }
    _purpose = purpose;
    _itemId = itemId;
    _workspace = workspace;
    _onTranscript = onTranscript;
    _startedAt = DateTime.now();
    state = VoiceSession(state: VoiceState.recording, owner: owner);
    _levelSub = recorder.levels.listen((level) {
      if (state.state == VoiceState.recording) {
        state = VoiceSession(state: VoiceState.recording, owner: owner, level: level, elapsed: state.elapsed);
      }
    });
    _ticker = Timer.periodic(const Duration(milliseconds: 250), (_) {
      if (state.state != VoiceState.recording) return;
      state = VoiceSession(
        state: VoiceState.recording,
        owner: owner,
        level: state.level,
        elapsed: DateTime.now().difference(_startedAt!),
      );
    });
    // The cap auto-stops and still transcribes.
    _cap = Timer(_ref.read(voiceCapabilitiesProvider).maxDuration, stop);
    return true;
  }

  /// Stops, and transcribes what was said unless it was silent or too short.
  Future<void> stop() async {
    if (state.state != VoiceState.recording) return;
    final owner = state.owner;
    _stopTimers();
    state = VoiceSession(state: VoiceState.transcribing, owner: owner);
    final clip = await _recorder?.stop();
    if (clip == null) {
      _fail(owner, VoiceErrorCode.silence);
      return;
    }
    if (clip.duration.inMilliseconds < voiceMinMs) {
      _fail(owner, VoiceErrorCode.tooShort);
      return;
    }
    if (clip.peak < silencePeak) {
      _fail(owner, VoiceErrorCode.silence);
      return;
    }
    final machine = _ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      _fail(owner, VoiceErrorCode.network);
      return;
    }
    final api = _ref.read(voiceApiFactoryProvider)(machine);
    try {
      final out = await api.transcribe(clip.wav, purpose: _purpose, itemId: _itemId, workspace: _workspace);
      if (out.error != null) {
        // A 503 means voice went away on the Mac: refetch, and the mic hides.
        if (out.error == VoiceErrorCode.voiceUnavailable || out.error == VoiceErrorCode.voiceDisabled) {
          unawaited(_ref.read(voiceCapabilitiesProvider.notifier).ensureFresh(force: true));
        }
        _fail(owner, out.error!);
        return;
      }
      final text = out.result?.text.trim() ?? '';
      if (text.isEmpty) {
        _fail(owner, VoiceErrorCode.silence);
        return;
      }
      _onTranscript?.call(text);
      if (mounted) state = const VoiceSession();
    } finally {
      api.dispose();
      _onTranscript = null;
    }
  }

  /// Stops and throws the clip away.
  Future<void> cancel() async {
    if (state.state != VoiceState.recording && state.state != VoiceState.arming) return;
    _stopTimers();
    _onTranscript = null;
    await _recorder?.cancel();
    if (mounted) state = const VoiceSession();
  }

  /// Clears an error line.
  void clearError() {
    if (state.state == VoiceState.error) state = const VoiceSession();
  }

  void _fail(String? owner, VoiceErrorCode error) {
    if (!mounted) return;
    state = VoiceSession(state: VoiceState.error, owner: owner, error: error);
  }

  void _stopTimers() {
    _levelSub?.cancel();
    _levelSub = null;
    _ticker?.cancel();
    _ticker = null;
    _cap?.cancel();
    _cap = null;
  }

  @override
  void dispose() {
    _stopTimers();
    unawaited(_recorder?.dispose());
    super.dispose();
  }
}

final voiceProvider = StateNotifierProvider<VoiceNotifier, VoiceSession>(VoiceNotifier.new);
