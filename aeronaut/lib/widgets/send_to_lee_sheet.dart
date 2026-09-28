import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/send_to_lee.dart';
import '../providers/machines_provider.dart';
import '../providers/tether_provider.dart';
import '../providers/voice_provider.dart';
import '../providers/windows_provider.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../theme/phosphor_tokens.dart';
import 'composer.dart';
import 'phosphor_icon.dart';
import 'work_ui.dart';

/// Opens Send to Lee (docs/plans/2026-09-28-tether-review-voice.md §4.5),
/// from Work's header and Hester's app bar.
Future<void> showSendToLeeSheet(BuildContext context) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const SendToLeeSheet(),
  );
}

/// The app-bar entry for [showSendToLeeSheet].
class SendToLeeButton extends StatelessWidget {
  const SendToLeeButton({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      key: const ValueKey('send-to-lee'),
      icon: const PhosphorIcon(PhosphorIcons.upload, size: 20),
      tooltip: 'Send to Lee',
      onPressed: () => showSendToLeeSheet(context),
    );
  }
}

/// Send to Lee: pick Voice note, Photo, Screenshot, Scribble or Text (as
/// many as fit in one send), see where it goes ("To: Taxonomy (the Page
/// you're on)", with a picker for the others), then Deliver or Send.
class SendToLeeSheet extends ConsumerStatefulWidget {
  const SendToLeeSheet({super.key});

  @override
  ConsumerState<SendToLeeSheet> createState() => _SendToLeeSheetState();
}

class _SendToLeeSheetState extends ConsumerState<SendToLeeSheet> {
  static const _field = 'send-to-lee';
  final _composer = GlobalKey<ComposerState>();

  SendTargets? _targets;
  String? _loadError;
  bool _loading = true;

  /// Picked by hand; null means Lee's focus.
  SendTarget? _picked;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    final api = ref.read(tetherApiFactoryProvider)(machine);
    try {
      final read = await api.getTargets(workspace: ref.read(windowsProvider).activeWindow?.workspace);
      if (!mounted) return;
      setState(() {
        _loading = false;
        _targets = read.value;
        _loadError = read.value == null ? read.error : null;
      });
    } finally {
      api.dispose();
    }
  }

  SendTarget? get _target => _picked ?? _targets?.focus;

  Future<void> _pick() async {
    final targets = _targets;
    if (targets == null) return;
    final picked = await showModalBottomSheet<SendTarget>(
      context: context,
      backgroundColor: Phosphor.ground3,
      isScrollControlled: true,
      builder: (ctx) => SafeArea(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxHeight: MediaQuery.of(ctx).size.height * 0.6),
          child: ListView(
            shrinkWrap: true,
            children: [
              for (final t in targets.all)
                ListTile(
                  key: ValueKey('target-${t.kind.name}-${t.cardId ?? t.ptyId ?? ''}'),
                  title: Text(t.name),
                  subtitle: Text(
                    targets.focus != null && t.sameAs(targets.focus!) ? '${t.what} · ${focusPhrase(t)}' : t.what,
                    style: AeronautTheme.caption1.copyWith(color: Phosphor.text3),
                  ),
                  trailing: _target != null && t.sameAs(_target!)
                      ? const PhosphorIcon(PhosphorIcons.check, size: 16, color: Phosphor.text1)
                      : null,
                  onTap: () => Navigator.pop(ctx, t),
                ),
            ],
          ),
        ),
      ),
    );
    if (picked != null && mounted) setState(() => _picked = picked);
  }

  String _toLine() {
    final t = _target;
    if (_loading) return 'Finding what Lee has open…';
    if (t == null) return _loadError == null ? 'To: nothing in front of you on the Mac' : 'To: Lee';
    final focus = _targets?.focus;
    final isFocus = focus != null && t.sameAs(focus);
    return 'To: ${t.name} (${isFocus ? focusPhrase(t) : t.what})';
  }

  @override
  Widget build(BuildContext context) {
    final voiceAvailable = ref.watch(voiceCapabilitiesProvider.select((c) => c.available));
    final messenger = ScaffoldMessenger.of(context);
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: Container(
        padding: const EdgeInsets.fromLTRB(
          AeronautTheme.spacingMd,
          AeronautTheme.spacingMd,
          AeronautTheme.spacingMd,
          AeronautTheme.spacingLg,
        ),
        decoration: const BoxDecoration(
          color: Phosphor.ground2,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AeronautTheme.radiusLg)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Send to Lee', style: AeronautTheme.footnote.copyWith(fontWeight: FontWeight.w600)),
              const SizedBox(height: 2),
              Row(
                children: [
                  Expanded(child: QuietText(_toLine())),
                  if (_targets != null && _targets!.all.isNotEmpty)
                    TextButton(
                      key: const ValueKey('send-to-lee-pick'),
                      style: TextButton.styleFrom(visualDensity: VisualDensity.compact, foregroundColor: Phosphor.text2),
                      onPressed: _pick,
                      child: const Text('Change'),
                    ),
                ],
              ),
              if (_loadError != null && _loadError != 'hester_offline')
                QuietText(_loadError!),
              const SizedBox(height: AeronautTheme.spacingSm),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(
                  children: [
                    if (voiceAvailable)
                      _Choice(
                        key: const ValueKey('choice-voice'),
                        icon: PhosphorIcons.mic,
                        label: 'Voice note',
                        onTap: () => _composer.currentState?.startVoice(),
                      ),
                    _Choice(
                      key: const ValueKey('choice-photo'),
                      icon: PhosphorIcons.camera,
                      label: 'Photo',
                      onTap: () => _composer.currentState?.attach(ImageSourceKind.photo),
                    ),
                    _Choice(
                      key: const ValueKey('choice-screenshot'),
                      icon: PhosphorIcons.image,
                      label: 'Screenshot',
                      onTap: () => _composer.currentState?.attach(ImageSourceKind.screenshot),
                    ),
                    _Choice(
                      key: const ValueKey('choice-scribble'),
                      icon: PhosphorIcons.draw,
                      label: 'Scribble',
                      onTap: () => _composer.currentState?.attach(ImageSourceKind.scribble),
                    ),
                    _Choice(
                      key: const ValueKey('choice-text'),
                      icon: PhosphorIcons.edit,
                      label: 'Text',
                      onTap: () => _composer.currentState?.focusField(),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: AeronautTheme.spacingSm),
              Composer(
                key: _composer,
                target: _target,
                fieldKey: _field,
                onSent: (_, message) {
                  Navigator.of(context).pop();
                  messenger.showSnackBar(SnackBar(content: Text(message)));
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _Choice extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;
  final VoidCallback onTap;

  const _Choice({required this.icon, required this.label, required this.onTap, super.key});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(right: AeronautTheme.spacingSm),
      child: Material(
        color: Phosphor.ground3,
        shape: const StadiumBorder(side: BorderSide(color: Phosphor.ground4)),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                PhosphorIcon(icon, size: 16, color: Phosphor.text2),
                const SizedBox(width: 6),
                Text(label, style: const TextStyle(fontSize: 13, color: Phosphor.text1)),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
