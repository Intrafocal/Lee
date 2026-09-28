import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show HapticFeedback;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/voice.dart';
import '../providers/voice_provider.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/pending_icons.dart';
import '../theme/phosphor_tokens.dart';
import 'phosphor_icon.dart';

/// The mic next to a text field (docs/plans/2026-09-28-tether-review-voice.md
/// §5.3, §5.5). Hidden unless Hester says voice is available. Tap to start,
/// tap to stop; hold past 300 ms and it stops when you let go. The
/// transcript is added to [controller] ([appendTranscript]) and focus goes
/// back to the field: it's never sent for you.
class VoiceButton extends ConsumerStatefulWidget {
  /// Which field holds the mic: one recording at a time across the app.
  final String fieldKey;
  final VoicePurpose purpose;
  final TextEditingController controller;
  final FocusNode? focusNode;

  /// Hints for Hester's vocabulary (the item being replied to, the workspace).
  final String? itemId;
  final String? workspace;

  /// A transcript went into the field: tag the send `input: 'voice'`.
  final VoidCallback? onTranscript;
  final double size;

  const VoiceButton({
    required this.fieldKey,
    required this.purpose,
    required this.controller,
    this.focusNode,
    this.itemId,
    this.workspace,
    this.onTranscript,
    this.size = 20,
    super.key,
  });

  @override
  ConsumerState<VoiceButton> createState() => _VoiceButtonState();
}

class _VoiceButtonState extends ConsumerState<VoiceButton> {
  DateTime? _downAt;
  bool _startedThisPress = false;

  @override
  void initState() {
    super.initState();
    // Cached for 5 minutes; this is free when fresh.
    Future.microtask(() {
      if (mounted) ref.read(voiceCapabilitiesProvider.notifier).ensureFresh();
    });
  }

  void _insert(String text) {
    final next = appendTranscript(widget.controller.text, text);
    widget.controller.value = TextEditingValue(
      text: next.text,
      selection: TextSelection.collapsed(offset: next.caret),
    );
    widget.focusNode?.requestFocus();
    widget.onTranscript?.call();
  }

  Future<void> _down() async {
    final session = ref.read(voiceProvider);
    final notifier = ref.read(voiceProvider.notifier);
    _downAt = DateTime.now();
    _startedThisPress = false;
    if (session.state == VoiceState.recording && session.owner == widget.fieldKey) return;
    if (session.state == VoiceState.error) notifier.clearError();
    HapticFeedback.selectionClick();
    _startedThisPress = await notifier.start(
      widget.fieldKey,
      purpose: widget.purpose,
      itemId: widget.itemId,
      workspace: widget.workspace,
      onTranscript: (text) {
        if (mounted) _insert(text);
      },
    );
  }

  void _up() {
    final session = ref.read(voiceProvider);
    if (session.state != VoiceState.recording || session.owner != widget.fieldKey) return;
    final held = _downAt != null && DateTime.now().difference(_downAt!).inMilliseconds > voiceHoldMs;
    // A hold stops on release; a tap that started it keeps it going; a tap
    // while it was already going stops it.
    if (held || !_startedThisPress) {
      HapticFeedback.selectionClick();
      ref.read(voiceProvider.notifier).stop();
    }
  }

  @override
  Widget build(BuildContext context) {
    final caps = ref.watch(voiceCapabilitiesProvider);
    if (!caps.available) return const SizedBox.shrink();
    final session = ref.watch(voiceProvider);
    final mine = session.owner == widget.fieldKey;
    final recording = mine && session.state == VoiceState.recording;
    final transcribing = mine && (session.state == VoiceState.transcribing || session.state == VoiceState.arming);
    final elsewhere = !mine &&
        (session.state == VoiceState.recording || session.state == VoiceState.transcribing || session.state == VoiceState.arming);

    Widget icon = PhosphorIcon(
      PendingIcons.mic,
      size: widget.size,
      color: elsewhere ? Phosphor.text3 : (recording ? Phosphor.text1 : Phosphor.text2),
    );
    if (transcribing) {
      icon = SizedBox(
        width: widget.size,
        height: widget.size,
        child: const CircularProgressIndicator(strokeWidth: 2, color: Phosphor.text2),
      );
    }

    return Semantics(
      button: true,
      label: recording ? 'Stop recording' : 'Talk',
      child: Tooltip(
        message: recording ? 'Stop' : 'Talk',
        child: Listener(
          key: ValueKey('voice-${widget.fieldKey}'),
          behavior: HitTestBehavior.opaque,
          onPointerDown: elsewhere || transcribing ? null : (_) => _down(),
          onPointerUp: elsewhere || transcribing ? null : (_) => _up(),
          child: SizedBox(
            width: 44,
            height: 44,
            child: Stack(
              alignment: Alignment.center,
              children: [
                // The level ring: a quiet ground ring that fills with your voice.
                if (recording)
                  AnimatedContainer(
                    duration: const Duration(milliseconds: 100),
                    width: widget.size + 12 + 14 * session.level,
                    height: widget.size + 12 + 14 * session.level,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: Phosphor.ground4,
                      border: Border.all(color: Phosphor.text3),
                    ),
                  ),
                icon,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One quiet line under a field for its mic: "0:07 · tap the mic to stop
/// · Cancel" while recording, "Transcribing…", or the error. Nothing when
/// the mic is idle or belongs to another field.
class VoiceStatusLine extends ConsumerWidget {
  final String fieldKey;

  const VoiceStatusLine({required this.fieldKey, super.key});

  static String _clock(Duration d) => '${d.inMinutes}:${(d.inSeconds % 60).toString().padLeft(2, '0')}';

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final session = ref.watch(voiceProvider);
    if (session.owner != fieldKey) return const SizedBox.shrink();
    final notifier = ref.read(voiceProvider.notifier);
    final style = AeronautTheme.caption1.copyWith(color: Phosphor.text3);
    final Widget line = switch (session.state) {
      VoiceState.recording => Row(
          children: [
            Text('${_clock(session.elapsed)} · tap the mic to stop', style: style),
            const Spacer(),
            TextButton(
              key: ValueKey('voice-cancel-$fieldKey'),
              style: TextButton.styleFrom(
                visualDensity: VisualDensity.compact,
                foregroundColor: Phosphor.text2,
                textStyle: AeronautTheme.caption1,
              ),
              onPressed: notifier.cancel,
              child: const Text('Cancel'),
            ),
          ],
        ),
      VoiceState.arming || VoiceState.transcribing => Text('Transcribing…', style: style),
      VoiceState.error when session.error != null && session.error!.message.isNotEmpty => GestureDetector(
          onTap: notifier.clearError,
          child: Text(session.error!.message, key: ValueKey('voice-error-$fieldKey'), style: style),
        ),
      _ => const SizedBox.shrink(),
    };
    return Padding(padding: const EdgeInsets.only(top: 2), child: line);
  }
}
