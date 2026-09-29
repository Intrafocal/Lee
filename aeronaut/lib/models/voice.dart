import 'package:equatable/equatable.dart';

/// Voice: the one wire contract between Hester (which transcribes) and the
/// phone (which records). Mirrors `electron/src/shared/voice.ts` by hand
/// (docs/plans/2026-09-28-tether-review-voice.md §5.3); keep them in step.

/// The wire format: 16 kHz, mono, 16-bit PCM WAV, as the raw request body.
const voiceSampleRate = 16000;
const voiceChannels = 1;
const voiceBitsPerSample = 16;

/// Shorter clips are never uploaded.
const voiceMinMs = 300;

/// A hold longer than this stops on release.
const voiceHoldMs = 300;

/// The client cap: recording auto-stops here and still transcribes.
const voiceMaxMs = 60000;

/// Capabilities are cached this long, and refetched after a 503.
const voiceCapabilitiesTtl = Duration(minutes: 5);

/// Where the transcript goes: `?purpose=` on `POST /voice/transcribe`.
enum VoicePurpose { reply, capture, ask, send }

enum VoiceState { idle, arming, recording, transcribing, error }

/// The server's codes plus the client's own. [wire] is the string on the
/// wire (`voice_unavailable` also arrives as `voice_unavailable:<reason>`).
enum VoiceErrorCode {
  voiceDisabled('voice_disabled'),
  voiceUnavailable('voice_unavailable'),
  unsupportedMediaType('unsupported_media_type'),
  tooLarge('too_large'),
  tooLong('too_long'),
  tooShort('too_short'),
  providerError('provider_error'),
  timeout('timeout'),
  permissionDenied('permission_denied'),
  silence('silence'),
  network('network'),
  cancelled('cancelled');

  final String wire;

  const VoiceErrorCode(this.wire);

  /// The code for an error string from Hester, or null when it isn't one.
  static VoiceErrorCode? fromWire(String? s) {
    if (s == null) return null;
    final base = s.split(':').first;
    for (final c in values) {
      if (c.wire == base) return c;
    }
    return null;
  }

  /// The code for an HTTP status when the body names none.
  static VoiceErrorCode fromStatus(int status) => switch (status) {
        503 => VoiceErrorCode.voiceUnavailable,
        415 => VoiceErrorCode.unsupportedMediaType,
        413 => VoiceErrorCode.tooLarge,
        422 => VoiceErrorCode.tooShort,
        504 => VoiceErrorCode.timeout,
        _ => VoiceErrorCode.providerError,
      };

  /// One short line under the field.
  String get message => switch (this) {
        VoiceErrorCode.voiceDisabled || VoiceErrorCode.voiceUnavailable => 'Voice is off on the Mac.',
        VoiceErrorCode.unsupportedMediaType => 'Hester could not read that recording.',
        VoiceErrorCode.tooLarge || VoiceErrorCode.tooLong => 'That was too long. Try a shorter note.',
        VoiceErrorCode.tooShort => 'Too short to hear.',
        VoiceErrorCode.providerError => 'Transcription failed. Try again.',
        VoiceErrorCode.timeout => 'Transcription took too long.',
        VoiceErrorCode.permissionDenied => 'Allow the microphone in Settings to talk.',
        VoiceErrorCode.silence => 'Nothing heard.',
        VoiceErrorCode.network => 'Could not reach Hester.',
        VoiceErrorCode.cancelled => '',
      };
}

/// `GET /voice` on Hester. The mic shows only when [available].
class VoiceCapabilities extends Equatable {
  final bool enabled;
  final bool available;

  /// 'disabled', 'no_api_key', 'whisper_not_installed' or 'whisper_model_missing'.
  final String? reason;
  final String provider;
  final String model;
  final String location;
  final List<String> accepts;
  final int sampleRate;
  final int channels;
  final int maxSeconds;
  final int maxBytes;

  const VoiceCapabilities({
    this.enabled = false,
    this.available = false,
    this.reason,
    this.provider = '',
    this.model = '',
    this.location = '',
    this.accepts = const ['audio/wav'],
    this.sampleRate = voiceSampleRate,
    this.channels = voiceChannels,
    this.maxSeconds = voiceMaxMs ~/ 1000,
    this.maxBytes = 0,
  });

  static const unavailable = VoiceCapabilities();

  factory VoiceCapabilities.fromJson(Map<String, dynamic> json) {
    return VoiceCapabilities(
      enabled: json['enabled'] as bool? ?? false,
      available: json['available'] as bool? ?? false,
      reason: json['reason'] as String?,
      provider: json['provider'] as String? ?? '',
      model: json['model'] as String? ?? '',
      location: json['location'] as String? ?? '',
      accepts: (json['accepts'] as List<dynamic>?)?.whereType<String>().toList() ?? const ['audio/wav'],
      sampleRate: (json['sample_rate'] as num?)?.toInt() ?? voiceSampleRate,
      channels: (json['channels'] as num?)?.toInt() ?? voiceChannels,
      maxSeconds: (json['max_seconds'] as num?)?.toInt() ?? voiceMaxMs ~/ 1000,
      maxBytes: (json['max_bytes'] as num?)?.toInt() ?? 0,
    );
  }

  /// The recording cap: the lower of the server's and the client's.
  Duration get maxDuration {
    final serverMs = maxSeconds > 0 ? maxSeconds * 1000 : voiceMaxMs;
    return Duration(milliseconds: serverMs < voiceMaxMs ? serverMs : voiceMaxMs);
  }

  @override
  List<Object?> get props =>
      [enabled, available, reason, provider, model, location, accepts, sampleRate, channels, maxSeconds, maxBytes];
}

/// `POST /voice/transcribe`.
class TranscribeResult extends Equatable {
  final String text;
  final String provider;
  final String model;
  final String location;
  final int audioMs;
  final int latencyMs;

  const TranscribeResult({
    required this.text,
    this.provider = '',
    this.model = '',
    this.location = '',
    this.audioMs = 0,
    this.latencyMs = 0,
  });

  factory TranscribeResult.fromJson(Map<String, dynamic> json) => TranscribeResult(
        text: json['text'] as String? ?? '',
        provider: json['provider'] as String? ?? '',
        model: json['model'] as String? ?? '',
        location: json['location'] as String? ?? '',
        audioMs: (json['audio_ms'] as num?)?.toInt() ?? 0,
        latencyMs: (json['latency_ms'] as num?)?.toInt() ?? 0,
      );

  @override
  List<Object?> get props => [text, provider, model, location, audioMs, latencyMs];
}

/// Put a transcript into the field it belongs to: an empty draft becomes
/// [t]; else `draft + (a space if needed) + t`. The caret goes at the end.
/// A blank transcript leaves the draft alone.
({String text, int caret}) appendTranscript(String draft, String t) {
  final add = t.trim();
  if (add.isEmpty) return (text: draft, caret: draft.length);
  if (draft.trim().isEmpty) return (text: add, caret: add.length);
  final text = RegExp(r'\s$').hasMatch(draft) ? '$draft$add' : '$draft $add';
  return (text: text, caret: text.length);
}
