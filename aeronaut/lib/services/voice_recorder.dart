import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:record/record.dart';

import '../models/voice.dart';

/// A finished clip: the WAV bytes, how long it ran, and how loud it got.
class RecordedClip {
  final Uint8List wav;
  final Duration duration;

  /// The loudest level heard, 0..1 (see [levelFromDbfs]).
  final double peak;

  const RecordedClip({required this.wav, required this.duration, required this.peak});
}

/// Below this peak level a clip is treated as silence and never uploaded
/// (Gemini makes words up from silence; §5.7).
const silencePeak = 0.12;

/// dBFS (-160..0, as `record` reports it) to a 0..1 level: -60 dBFS and
/// below is 0, 0 dBFS is 1.
double levelFromDbfs(double dbfs) {
  if (dbfs.isNaN || dbfs <= -60) return 0;
  if (dbfs >= 0) return 1;
  return (dbfs + 60) / 60;
}

/// How long a PCM16 mono 16 kHz WAV's audio runs, from its size.
Duration wavDuration(int bytes) {
  const header = 44;
  const bytesPerSecond = voiceSampleRate * voiceChannels * voiceBitsPerSample ~/ 8;
  if (bytes <= header) return Duration.zero;
  return Duration(milliseconds: ((bytes - header) * 1000) ~/ bytesPerSecond);
}

/// What the voice provider records with; tests swap in a fake.
abstract class VoiceRecorder {
  /// Asks for the mic when needed; false when it's refused.
  Future<bool> hasPermission();

  /// Starts a clip in the wire format (§5.2).
  Future<void> start();

  /// The live level, 0..1, while recording.
  Stream<double> get levels;

  /// Stops and returns the clip (its temp file already deleted), or null.
  Future<RecordedClip?> stop();

  /// Stops and throws the clip away.
  Future<void> cancel();

  Future<void> dispose();
}

/// [VoiceRecorder] over `record`'s WAV encoder: 16 kHz, mono, PCM16, into
/// a temp file that is read once and deleted.
class RecordVoiceRecorder implements VoiceRecorder {
  final AudioRecorder _recorder = AudioRecorder();
  final _levels = StreamController<double>.broadcast();
  StreamSubscription<Amplitude>? _amplitudeSub;
  String? _path;
  double _peak = 0;
  final _clock = Stopwatch();

  @override
  Future<bool> hasPermission() => _recorder.hasPermission();

  @override
  Stream<double> get levels => _levels.stream;

  @override
  Future<void> start() async {
    final path = '${Directory.systemTemp.path}/aeronaut-voice-${DateTime.now().microsecondsSinceEpoch}.wav';
    _path = path;
    _peak = 0;
    await _recorder.start(
      const RecordConfig(
        encoder: AudioEncoder.wav,
        sampleRate: voiceSampleRate,
        numChannels: voiceChannels,
        // Speech, not music: let iOS clean it up for the transcriber.
        noiseSuppress: true,
        echoCancel: true,
      ),
      path: path,
    );
    _clock
      ..reset()
      ..start();
    _amplitudeSub = _recorder.onAmplitudeChanged(const Duration(milliseconds: 100)).listen((a) {
      final level = levelFromDbfs(a.current);
      if (level > _peak) _peak = level;
      _levels.add(level);
    });
  }

  @override
  Future<RecordedClip?> stop() async {
    await _amplitudeSub?.cancel();
    _amplitudeSub = null;
    _clock.stop();
    final path = await _recorder.stop() ?? _path;
    _path = null;
    if (path == null) return null;
    final file = File(path);
    try {
      if (!await file.exists()) return null;
      final bytes = await file.readAsBytes();
      final measured = wavDuration(bytes.length);
      return RecordedClip(
        wav: bytes,
        duration: measured > Duration.zero ? measured : _clock.elapsed,
        peak: _peak,
      );
    } finally {
      // Never kept (§5.2): the clip lives only as long as the upload.
      try {
        await file.delete();
      } catch (_) {
        // already gone
      }
    }
  }

  @override
  Future<void> cancel() async {
    await _amplitudeSub?.cancel();
    _amplitudeSub = null;
    _clock.stop();
    final path = _path;
    _path = null;
    await _recorder.cancel();
    if (path != null) {
      try {
        await File(path).delete();
      } catch (_) {
        // record's cancel already removed it
      }
    }
  }

  @override
  Future<void> dispose() async {
    await _amplitudeSub?.cancel();
    await _levels.close();
    await _recorder.dispose();
  }
}
