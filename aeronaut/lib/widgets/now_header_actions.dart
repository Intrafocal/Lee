import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../providers/attention_provider.dart';
import '../providers/windows_provider.dart';
import '../screens/someday_screen.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'handoff_sheet.dart';
import 'phosphor_icon.dart';

enum _FocusAction { start, stop, stopAndHandoff }

/// Opens the hand-off sheet (v1 Launch). Lee stops focus when a hand-off
/// starts, so "Stop and hand off…" is just this.
void showHandoffSheet(BuildContext context) {
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.transparent,
    builder: (_) => const HandoffSheet(),
  );
}

/// App-bar Focus control: an eye that shows the focus state (lit while a
/// session runs, with the count of items it's holding back) and opens a
/// small menu to start or stop focus, or stop and hand off.
class FocusMenuButton extends ConsumerWidget {
  const FocusMenuButton({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final focus = ref.watch(attentionProvider.select((s) => s.snapshot.focus));
    final what = focus.item?.displayLabel;
    final tooltip = focus.active
        ? (what == null || what.isEmpty ? 'Focus on' : 'Focus on · $what')
        : 'Focus off';

    return PopupMenuButton<_FocusAction>(
      tooltip: tooltip,
      offset: const Offset(0, 40),
      color: AeronautColors.bgElevated,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        side: const BorderSide(color: AeronautColors.border),
      ),
      onSelected: (action) {
        final notifier = ref.read(attentionProvider.notifier);
        switch (action) {
          case _FocusAction.start:
            notifier.focusStart();
          case _FocusAction.stop:
            notifier.focusStop();
          case _FocusAction.stopAndHandoff:
            showHandoffSheet(context);
        }
      },
      itemBuilder: (_) => [
        if (focus.active)
          PopupMenuItem(
            enabled: false,
            child: Text(
              [
                if (what != null && what.isNotEmpty) what,
                '${focus.quietCount} held back',
              ].join(' · '),
              style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
            ),
          ),
        if (!focus.active)
          const PopupMenuItem(
            value: _FocusAction.start,
            child: _MenuRow(icon: PhosphorIcons.eye, label: 'Start focus'),
          )
        else ...[
          const PopupMenuItem(
            value: _FocusAction.stop,
            child: _MenuRow(icon: PhosphorIcons.eyeOff, label: 'Stop focus'),
          ),
          const PopupMenuItem(
            value: _FocusAction.stopAndHandoff,
            child: _MenuRow(icon: PhosphorIcons.send, label: 'Stop and hand off…'),
          ),
        ],
      ],
      child: SizedBox(
        width: 44,
        height: 44,
        child: Stack(
          alignment: Alignment.center,
          children: [
            PhosphorIcon(
              focus.active ? PhosphorIcons.eye : PhosphorIcons.eyeOff,
              size: 20,
              color: focus.active ? AeronautColors.accent : AeronautColors.textSecondary,
            ),
            if (focus.active && focus.quietCount > 0)
              Positioned(
                top: 6,
                right: 4,
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 1),
                  decoration: BoxDecoration(
                    color: AeronautColors.accent,
                    borderRadius: BorderRadius.circular(AeronautTheme.radiusSm),
                  ),
                  child: Text(
                    '${focus.quietCount}',
                    style: AeronautTheme.caption2.copyWith(color: AeronautColors.onAccent, fontSize: 9),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _MenuRow extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;

  const _MenuRow({required this.icon, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PhosphorIcon(icon, size: 16, color: AeronautColors.textSecondary),
        const SizedBox(width: AeronautTheme.spacingSm),
        Flexible(
          child: Text(label, style: AeronautTheme.subheadline, overflow: TextOverflow.ellipsis),
        ),
      ],
    );
  }
}

/// App-bar Capture control: opens [CaptureSheet].
class CaptureButton extends StatelessWidget {
  const CaptureButton({super.key});

  @override
  Widget build(BuildContext context) {
    return IconButton(
      icon: const PhosphorIcon(PhosphorIcons.edit, size: 20),
      tooltip: 'Capture',
      onPressed: () => showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        backgroundColor: Colors.transparent,
        builder: (_) => const CaptureSheet(),
      ),
    );
  }
}

/// Compact capture: one field, an "as exploration" toggle, one button. Sends
/// the same capture call the old in-body card did, then closes.
class CaptureSheet extends ConsumerStatefulWidget {
  const CaptureSheet({super.key});

  @override
  ConsumerState<CaptureSheet> createState() => _CaptureSheetState();
}

class _CaptureSheetState extends ConsumerState<CaptureSheet> {
  final _controller = TextEditingController();
  bool _asExploration = false;
  bool _busy = false;

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  Future<void> _capture() async {
    final text = _controller.text.trim();
    if (text.isEmpty || _busy) return;
    setState(() => _busy = true);
    final workspace = ref.read(windowsProvider).activeWindow?.workspace;
    final messenger = ScaffoldMessenger.of(context);
    final navigator = Navigator.of(context);
    final result =
        await ref.read(attentionProvider.notifier).capture(text, workspace: workspace, asExploration: _asExploration);
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.success) {
      navigator.pop();
      messenger.showSnackBar(
        SnackBar(content: Text(result.spooled ? 'Saved; will sync when Hester is back' : 'Captured')),
      );
    } else {
      messenger.showSnackBar(
        SnackBar(
          content: Text(result.error ?? 'Capture failed'),
          backgroundColor: AeronautColors.offline,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
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
          color: AeronautColors.bgSurface,
          borderRadius: BorderRadius.vertical(top: Radius.circular(AeronautTheme.radiusLg)),
        ),
        child: SafeArea(
          top: false,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const PhosphorIcon(PhosphorIcons.edit, size: 16, color: AeronautColors.textSecondary),
                  const SizedBox(width: 6),
                  Text('Capture', style: AeronautTheme.footnote.copyWith(fontWeight: FontWeight.w600)),
                  const Spacer(),
                  TextButton.icon(
                    key: const ValueKey('capture-view-someday'),
                    style: TextButton.styleFrom(
                      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                      visualDensity: VisualDensity.compact,
                    ),
                    onPressed: () {
                      final workspace = ref.read(windowsProvider).activeWindow?.workspace;
                      final navigator = Navigator.of(context);
                      navigator.pop();
                      navigator.push(
                        MaterialPageRoute<void>(builder: (_) => SomedayScreen(workspace: workspace)),
                      );
                    },
                    icon: const PhosphorIcon(PhosphorIcons.list, size: 14),
                    label: const Text('Someday'),
                  ),
                ],
              ),
              const SizedBox(height: AeronautTheme.spacingSm),
              TextField(
                key: const ValueKey('capture-field'),
                controller: _controller,
                autofocus: true,
                minLines: 1,
                maxLines: 4,
                textInputAction: TextInputAction.done,
                onSubmitted: (_) => _capture(),
                decoration: const InputDecoration(hintText: 'Jot an idea for later…', isDense: true),
              ),
              const SizedBox(height: AeronautTheme.spacingXs),
              Row(
                children: [
                  Switch.adaptive(
                    key: const ValueKey('capture-exploration'),
                    value: _asExploration,
                    activeThumbColor: AeronautColors.accent,
                    onChanged: (v) => setState(() => _asExploration = v),
                  ),
                  const Text('As exploration', style: AeronautTheme.caption1),
                  const Spacer(),
                  ElevatedButton(
                    key: const ValueKey('capture-send'),
                    onPressed: _busy ? null : _capture,
                    child: _busy
                        ? const SizedBox(
                            width: 16,
                            height: 16,
                            child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                          )
                        : const Text('Capture'),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}
