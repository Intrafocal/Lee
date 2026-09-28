import 'dart:async';
import 'dart:collection';

import 'package:flutter_tts/flutter_tts.dart';

/// Readback's voice: on-device iOS TTS, one utterance at a time
/// (docs/plans/2026-09-28-tether-review-voice.md §5.1, §5.5). No server TTS.
abstract class Speaker {
  /// Queues [text]; it is spoken after whatever is already queued.
  Future<void> speak(String text);

  /// Stops now and drops the queue (recording starts, or you turned it off).
  Future<void> stop();
}

/// [Speaker] over `flutter_tts`. It ducks other audio while it talks and
/// never records, so `record` and TTS don't fight over the session: the
/// voice provider stops it before a recording starts (§5.7).
class TtsSpeaker implements Speaker {
  final FlutterTts _tts = FlutterTts();
  final Queue<String> _queue = Queue();
  bool _configured = false;
  bool _speaking = false;

  Future<void> _configure() async {
    if (_configured) return;
    _configured = true;
    try {
      await _tts.setSharedInstance(true);
      await _tts.setIosAudioCategory(
        IosTextToSpeechAudioCategory.playback,
        [IosTextToSpeechAudioCategoryOptions.duckOthers],
        IosTextToSpeechAudioMode.spokenAudio,
      );
      await _tts.awaitSpeakCompletion(true);
    } catch (_) {
      // Not iOS (tests, web): speak with the defaults.
    }
  }

  @override
  Future<void> speak(String text) async {
    if (text.trim().isEmpty) return;
    _queue.add(text);
    if (_speaking) return;
    _speaking = true;
    try {
      await _configure();
      while (_queue.isNotEmpty) {
        await _tts.speak(_queue.removeFirst());
      }
    } catch (_) {
      _queue.clear();
    } finally {
      _speaking = false;
    }
  }

  @override
  Future<void> stop() async {
    _queue.clear();
    try {
      await _tts.stop();
    } catch (_) {
      // nothing playing
    }
  }
}
