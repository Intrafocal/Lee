import 'dart:async';

import 'package:equatable/equatable.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/attention.dart';
import '../services/speech_sanitizer.dart';
import '../services/speech_service.dart';

/// Readback (docs/plans/2026-09-28-tether-review-voice.md §5.5), only with
/// the app in the foreground:
/// - A voice message gets its **next reply** read, once: Hester's answer to
///   a spoken question, or an agent's next item after a spoken reply to it.
///   Typing never arms it.
/// - "Speak replies" is a manual switch that reads every Hester answer; it
///   never turns itself on.
/// Nothing else, so the phone doesn't narrate (pull-first). Recording stops
/// whatever is being read.

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
  /// "Speak replies": every Hester answer, until you switch it off.
  final bool enabled;

  /// Agent sessions (by PTY) whose next item is read once, after a spoken reply.
  final Set<int> voicePtyIds;

  /// Hester's next answer is read once, after a spoken question.
  final bool nextHesterAnswer;

  const SpeechState({this.enabled = false, this.voicePtyIds = const {}, this.nextHesterAnswer = false});

  SpeechState copyWith({bool? enabled, Set<int>? voicePtyIds, bool? nextHesterAnswer}) => SpeechState(
        enabled: enabled ?? this.enabled,
        voicePtyIds: voicePtyIds ?? this.voicePtyIds,
        nextHesterAnswer: nextHesterAnswer ?? this.nextHesterAnswer,
      );

  @override
  List<Object?> get props => [enabled, voicePtyIds, nextHesterAnswer];
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
      if (mounted && on != state.enabled) state = state.copyWith(enabled: on);
    } catch (_) {
      // No prefs (tests): stays off.
    }
  }

  Future<void> setEnabled(bool on) async {
    state = state.copyWith(enabled: on);
    if (!on) await stopSpeaking();
    try {
      final prefs = await SharedPreferences.getInstance();
      await prefs.setBool(_prefsKey, on);
    } catch (_) {
      // Remembered for this run only.
    }
  }

  /// You asked Hester by voice: her next answer is read, once.
  void armHesterAnswer() {
    if (!state.nextHesterAnswer) state = state.copyWith(nextHesterAnswer: true);
  }

  /// You replied to the agent on [ptyId] by voice: its next item is read, once.
  void noteVoiceReply(int? ptyId) {
    if (ptyId == null || state.voicePtyIds.contains(ptyId)) return;
    state = state.copyWith(voicePtyIds: {...state.voicePtyIds, ptyId});
  }

  /// You replied to [ptyId] by typing: nothing of its is read.
  void noteTypedReply(int? ptyId) {
    if (ptyId == null || !state.voicePtyIds.contains(ptyId)) return;
    state = state.copyWith(voicePtyIds: {...state.voicePtyIds}..remove(ptyId));
  }

  /// You asked Hester by typing: a pending spoken-question readback is dropped.
  void noteTypedQuestion() {
    if (state.nextHesterAnswer) state = state.copyWith(nextHesterAnswer: false);
  }

  /// Hester's final answer in the chat: read when "Speak replies" is on, or once after a spoken question.
  void readHesterAnswer(String markdown) {
    final once = state.nextHesterAnswer;
    if (once) state = state.copyWith(nextHesterAnswer: false);
    if (state.enabled || once) _say(sanitizeForSpeech(markdown));
  }

  /// A new item from an agent you just replied to by voice: read once.
  void readAttentionItem(AttentionItem item) {
    final pty = item.source.ptyId;
    if (!state.voicePtyIds.contains(pty)) return;
    state = state.copyWith(voicePtyIds: {...state.voicePtyIds}..remove(pty));
    _say(readbackLine(item));
  }

  void _say(String text) {
    if (text.isEmpty) return;
    if (!_ref.read(isForegroundProvider)()) return;
    unawaited(_voice.speak(text));
  }

  Future<void> stopSpeaking() async {
    await _speaker?.stop();
  }
}

final speechProvider = StateNotifierProvider<SpeechNotifier, SpeechState>(SpeechNotifier.new);
