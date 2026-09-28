import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/speech_provider.dart';
import '../providers/voice_provider.dart';
import '../theme/pending_icons.dart';
import '../theme/phosphor_tokens.dart';
import 'phosphor_icon.dart';

/// "Speak replies" in Work's header and Hester's app bar (§5.5). Shown
/// while voice is available, or while it's on (so it can always be turned
/// off). On is primary text, off is muted: never phosphor, it's a setting.
class SpeakerToggle extends ConsumerWidget {
  const SpeakerToggle({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final on = ref.watch(speechProvider.select((s) => s.enabled));
    final available = ref.watch(voiceCapabilitiesProvider.select((c) => c.available));
    if (!on && !available) return const SizedBox.shrink();
    return IconButton(
      key: const ValueKey('speak-replies'),
      tooltip: on ? 'Speak replies: on' : 'Speak replies: off',
      icon: PhosphorIcon(on ? PendingIcons.speaker : PendingIcons.speakerOff, size: 20, color: on ? Phosphor.text1 : Phosphor.text3),
      onPressed: () => ref.read(speechProvider.notifier).setEnabled(!on),
    );
  }
}
