import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../providers/windows_provider.dart';
import '../screens/library_screen.dart' show showCarryCaptureSheet;
import '../theme/aeronaut_theme.dart';
import 'work_ui.dart';

/// The open "Still thinking?" push in [snapshot], if any (Desk D2 §9.2).
AttentionItem? openDeepIdle(AttentionSnapshot snapshot) {
  for (final i in snapshot.items) {
    if (i.kind == AttentionKind.deepIdle && i.state == AttentionItemState.open) return i;
  }
  return null;
}

/// "10:45": when the session ends if you stay away.
String endsAtLabel(DateTime? at) {
  if (at == null) return '';
  final local = at.toLocal();
  return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
}

/// "Still thinking?" (Desk D2 §9.2): a Deep session on the Mac has been
/// idle for 40 minutes and ends at 45. Extend is the one next step; End and
/// rate takes deep / mixed / shallow; Capture puts a thought into the card
/// and leaves the push open. Work shows it above everything else.
class DeepIdleCard extends ConsumerStatefulWidget {
  final AttentionItem item;

  const DeepIdleCard({required this.item, super.key});

  @override
  ConsumerState<DeepIdleCard> createState() => _DeepIdleCardState();
}

class _DeepIdleCardState extends ConsumerState<DeepIdleCard> {
  /// The action in flight: 'extend', a rating, or null.
  String? _busy;

  Future<void> _answer(String action, {String? rating}) async {
    if (_busy != null) return;
    setState(() => _busy = rating ?? action);
    final messenger = ScaffoldMessenger.of(context);
    final result = await ref.read(attentionProvider.notifier).deepIdleEnd(widget.item, action: action, rating: rating);
    if (!mounted) return;
    setState(() => _busy = null);
    final String message;
    if (result.success) {
      message = action == 'extend' ? 'Kept going for another 45 minutes' : 'Session ended';
    } else if (result.error == 'stale' || result.error == 'gone') {
      message = 'The session already moved on';
    } else {
      message = result.error ?? 'Could not reach Lee';
    }
    messenger.showSnackBar(SnackBar(content: Text(message)));
    if (!result.success) await ref.read(attentionProvider.notifier).refresh();
  }

  void _capture() {
    final info = widget.item.deepIdle;
    final title = info?.cardTitle ?? widget.item.text;
    final workspace = ref.read(windowsProvider).activeWindow?.workspace ?? widget.item.source.workspace;
    showCarryCaptureSheet(
      context,
      title: title.isEmpty ? 'Captured away' : 'Into $title',
      onCapture: (text) async {
        final messenger = ScaffoldMessenger.of(context);
        final result = await ref
            .read(attentionProvider.notifier)
            .captureIntoCard(text, workspace: workspace, cardId: info?.cardId);
        messenger.showSnackBar(SnackBar(
          content: Text(result.success
              ? (result.spooled ? 'Saved; will sync when Hester is back' : 'Captured')
              : (result.error ?? 'Capture failed')),
        ));
        return result.success;
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final info = item.deepIdle;
    final title = info?.cardTitle ?? item.text;
    final ends = endsAtLabel(info?.endsAt);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Eyebrow(item.title.isEmpty ? 'Still thinking?' : item.title, needs: true),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
          child: WorkCard(
            key: ValueKey('deep-idle-${item.id}'),
            raised: true,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                if (title.isNotEmpty) Text(title, style: writingStyle(size: 20)),
                const SizedBox(height: 4),
                QuietText(ends.isEmpty
                    ? 'Your Deep session is idle on the Mac.'
                    : 'Your Deep session ends at $ends if you stay away.'),
                const SizedBox(height: AeronautTheme.spacingMd),
                WorkButton(
                  key: const ValueKey('deep-idle-extend'),
                  label: 'Extend',
                  kind: BtnKind.next,
                  height: 48,
                  busy: _busy == 'extend',
                  onPressed: () => _answer('extend'),
                ),
                const SizedBox(height: AeronautTheme.spacingMd),
                const QuietText('End and rate'),
                const SizedBox(height: AeronautTheme.spacingSm),
                Row(
                  children: [
                    for (final r in const ['deep', 'mixed', 'shallow']) ...[
                      if (r != 'deep') const SizedBox(width: AeronautTheme.spacingSm),
                      Expanded(
                        child: WorkButton(
                          key: ValueKey('deep-idle-rate-$r'),
                          label: '${r[0].toUpperCase()}${r.substring(1)}',
                          busy: _busy == r,
                          onPressed: () => _answer('end_rate', rating: r),
                        ),
                      ),
                    ],
                  ],
                ),
                const SizedBox(height: AeronautTheme.spacingSm),
                WorkButton(
                  key: const ValueKey('deep-idle-capture'),
                  label: 'Capture a thought into this',
                  kind: BtnKind.quiet,
                  onPressed: _capture,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
