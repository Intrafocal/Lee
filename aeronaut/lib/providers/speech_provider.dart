import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/attention.dart';
import '../services/speech_sanitizer.dart';
import '../services/speech_service.dart';

/// Readback (docs/plans/2026-09-28-tether-review-voice.md §5.5): with
/// "Speak replies" on, and the app in the foreground, the phone reads
/// Hester's final chat answers and new items from the agent sessions you
/// replied to by voice. Nothing else, so the phone doesn't narrate
/// (pull-first). The toggle switches itself on when you send a voice
/// message, and recording stops whatever is being read.

const _prefsKey = 'speak_replies';

/// The speaker; tests override it.
final speakerFactoryProvider = Provider<Speaker Function()>((ref) => TtsSpeaker.new);

/// Whether the app is in front; readback never talks from the background.
/// Tests override it.
final isForegroundProvider = Provider<bool Function()>((ref) => () {
      final s = WidgetsBinding.instance.lifecycleState;
      return s == null || s == AppLifecycleState.resumed;
    });

class SpeechState extends Equatable {
  /// "Speak replies".
  final bool enabled;

  /// The agent sessions (by PTY) you replied to by voice this run.
  final Set<int> voicePtyIds;

  const SpeechState({this.enabled = false, this.voicePtyIds = const {}});

  @override
  List<Object?> get props => [enabled, voicePtyIds];
}

/// "Claude, in api: Allow Bash? Approve or deny on screen." for an
/// approval; "Claude, in api: Tests pass." and the item's text, sanitized, otherwise.
String readbackLine(AttentionItem item) {
  final raw = item.source.provider ?? 'claude';
  final who = raw.isEmpty ? 'Claude' : '${raw[0].toUpperCase()}${raw.substring(1)}';
  final tab = item.source.tabLabel;
  final head = tab == null || tab.isEmpty ? who : '$who, in $tab';
  final title = item.title.trim().isEmpty ? 'needs you' : item.title.trim();
  final lead = '$head: ${title.endsWith('.') || title.endsWith('?') ? title : '$title.'}';
  if (item.kind == AttentionKind.approval || item.canApproveDeny) return '$lead Approve or deny on screen.';
  final body = item.text.trim().isEmpty ? '' : sanitizeForSpeech(item.text);
  return body.isEmpty ? lead : '$lead $body';
}

class SpeechNotifier extends StateNotifier<SpeechState> {
  final Ref _ref;
  Speaker? _speaker;

  SpeechNotifier(this._ref) : super(const SpeechState()) {
    unawaited(_load());
  }

  Speaker get _voice => _speaker ??= _ref.read(speakerFactoryProvider)();

  Future<void> _load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final on = prefs.getBool(_prefsKey) ?? false;
      if (mounted && on != state.enabled) state = SpeechState(enabled: on, voicePtyIds: state.voicePtyIds);
    } catch (_) {
      // No prefs (tests): stays off.
    }
  }

  Future<void> setEnabled(bool on) async {
    state = SpeechState(enabled: on, voicePtyIds: state.voicePtyIds);
    if (!on) await stopSpeaking();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefsKey, on);
    } catch (_) {
      // Remembered for this run only.
    }
  }

  /// A voice message was sent: readback comes on.
  void autoEnableFromVoice() {
    if (!state.enabled) unawaited(setEnabled(true));
  }

  /// You replied to the agent on [ptyId] by voice: its next items are read.
  void noteVoiceReply(int? ptyId) {
    if (ptyId == null || state.voicePtyIds.contains(ptyId)) return;
    state = SpeechState(enabled: state.enabled, voicePtyIds: {...state.voicePtyIds, ptyId});
  }

  /// Hester's final answer in the chat.
  void readHesterAnswer(String markdown) => _say(sanitizeForSpeech(markdown));

  /// A new item from an agent you replied to by voice.
  void readAttentionItem(AttentionItem item) {
    if (!state.voicePtyIds.contains(item.source.ptyId)) return;
    _say(readbackLine(item));
  }

  void _say(String text) {
    if (!state.enabled || text.isEmpty) return;
    if (!_ref.read(isForegroundProvider)()) return;
    unawaited(_voice.speak(text));
  }

  Future<void> stopSpeaking() async {
    await _speaker?.stop();
  }
}

final speechProvider = StateNotifierProvider<SpeechNotifier, SpeechState>(SpeechNotifier.new);
