import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// One row in the Now screen's Waiting list (contracts §9.2): title, source,
/// the agent's own words, and inline actions per `item.actions` — approve/
/// deny, reply, snooze, dismiss, wake — matching the Lee status bar flyout.
class AttentionTile extends ConsumerStatefulWidget {
  final AttentionItem item;
  final bool awayActive;

  const AttentionTile({required this.item, this.awayActive = false, super.key});

  @override
  ConsumerState<AttentionTile> createState() => _AttentionTileState();
}

class _AttentionTileState extends ConsumerState<AttentionTile> {
  bool _replying = false;
  bool _busy = false;
  final _replyController = TextEditingController();

  @override
  void dispose() {
    _replyController.dispose();
    super.dispose();
  }

  Future<void> _run(Future<ActionResult> Function() action) async {
    if (_busy) return;
    setState(() => _busy = true);
    final result = await action();
    if (!mounted) return;
    setState(() => _busy = false);
    if (!result.success) {
      final message = switch (result.error) {
        'stale' => 'This item changed — refreshing.',
        'gone' => 'That agent session has ended.',
        _ => result.error ?? 'Action failed.',
      };
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
      unawaited(ref.read(attentionProvider.notifier).refresh());
    }
  }

  @override
  Widget build(BuildContext context) {
    final item = widget.item;
    final notifier = ref.read(attentionProvider.notifier);

    return Container(
      margin: const EdgeInsets.symmetric(
        horizontal: AeronautTheme.spacingMd,
        vertical: AeronautTheme.spacingXs,
      ),
      padding: const EdgeInsets.all(AeronautTheme.spacingMd),
      decoration: BoxDecoration(
        color: AeronautColors.bgSurface,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        border: Border.all(
          color: _severityColor(item.severity).withValues(
            alpha: item.severity == AttentionSeverity.blocking ? 0.6 : 0.2,
          ),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.only(top: 5),
                child: _SeverityDot(severity: item.severity),
              ),
              const SizedBox(width: AeronautTheme.spacingSm),
              Expanded(
                child: Text(
                  item.title,
                  style: AeronautTheme.subheadline.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              if (item.parked)
                const Padding(
                  padding: EdgeInsets.only(left: 4),
                  child: PhosphorIcon(PhosphorIcons.clock, size: 14, color: AeronautColors.textTertiary),
                ),
              const SizedBox(width: 4),
              Text(_age(item.createdAt), style: AeronautTheme.caption2),
            ],
          ),
          if (item.sourceLabel.isNotEmpty) ...[
            const SizedBox(height: 2),
            Text(
              item.sourceLabel,
              style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
            ),
          ],
          if (item.text.isNotEmpty) ...[
            const SizedBox(height: AeronautTheme.spacingSm),
            Text(
              item.text,
              style: AeronautTheme.footnote,
              maxLines: 4,
              overflow: TextOverflow.ellipsis,
            ),
          ],
          const SizedBox(height: AeronautTheme.spacingSm),
          if (_replying)
            _ReplyField(
              controller: _replyController,
              busy: _busy,
              onCancel: () => setState(() => _replying = false),
              onSend: (text) {
                final trimmed = text.trim();
                if (trimmed.isEmpty) return;
                setState(() => _replying = false);
                _run(() => notifier.reply(item.id, action: 'text', text: trimmed, version: item.version));
                _replyController.clear();
              },
            )
          else
            Wrap(
              spacing: AeronautTheme.spacingSm,
              runSpacing: 4,
              children: [
                if (item.canApproveDeny) ...[
                  _ActionButton(
                    icon: PhosphorIcons.check,
                    label: 'Approve',
                    filled: true,
                    busy: _busy,
                    onTap: () => _run(
                      () => notifier.reply(item.id, action: 'approve', version: item.version),
                    ),
                  ),
                  _ActionButton(
                    icon: PhosphorIcons.close,
                    label: 'Deny',
                    busy: _busy,
                    onTap: () => _run(
                      () => notifier.reply(item.id, action: 'deny', version: item.version),
                    ),
                  ),
                ],
                if (item.canReply)
                  _ActionButton(
                    icon: PhosphorIcons.send,
                    label: 'Reply',
                    filled: true,
                    busy: _busy,
                    onTap: () => setState(() => _replying = true),
                  ),
                if (item.canSnooze)
                  _ActionButton(
                    icon: PhosphorIcons.clock,
                    label: 'Snooze',
                    busy: _busy,
                    onTap: () => _showSnoozeMenu(context, notifier, item),
                  ),
                if (item.canDismiss)
                  _ActionButton(
                    icon: PhosphorIcons.trash,
                    label: 'Dismiss',
                    busy: _busy,
                    onTap: () => _run(() => notifier.dismiss(item.id)),
                  ),
                if (widget.awayActive && item.canWake)
                  _ActionButton(
                    icon: PhosphorIcons.bell,
                    label: item.wake ? 'Waking me' : 'Wake me',
                    filled: item.wake,
                    busy: _busy,
                    onTap: () => _run(() => notifier.setWake(item.id, !item.wake)),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  void _showSnoozeMenu(BuildContext context, AttentionNotifier notifier, AttentionItem item) {
    showModalBottomSheet<void>(
      context: context,
      backgroundColor: AeronautColors.bgElevated,
      builder: (ctx) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              title: const Text('Snooze 15 minutes'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, minutes: 15));
              },
            ),
            ListTile(
              title: const Text('Snooze 1 hour'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, minutes: 60));
              },
            ),
            ListTile(
              title: const Text('Until it changes'),
              onTap: () {
                Navigator.pop(ctx);
                _run(() => notifier.snooze(item.id, until: 'change'));
              },
            ),
          ],
        ),
      ),
    );
  }
}

Color _severityColor(AttentionSeverity severity) {
  switch (severity) {
    case AttentionSeverity.blocking:
      return AeronautColors.offline;
    case AttentionSeverity.needsYou:
      return AeronautColors.warning;
    case AttentionSeverity.ambient:
      return AeronautColors.textTertiary;
  }
}

/// `Xs` / `Xm` / `Xh` / `Xd` — no `intl` dependency for one small label.
String _age(DateTime? createdAt) {
  if (createdAt == null) return '';
  final diff = DateTime.now().toUtc().difference(createdAt.toUtc());
  if (diff.inSeconds < 60) return '${diff.inSeconds}s';
  if (diff.inMinutes < 60) return '${diff.inMinutes}m';
  if (diff.inHours < 24) return '${diff.inHours}h';
  return '${diff.inDays}d';
}

class _SeverityDot extends StatelessWidget {
  final AttentionSeverity severity;

  const _SeverityDot({required this.severity});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(shape: BoxShape.circle, color: _severityColor(severity)),
    );
  }
}

class _ActionButton extends StatelessWidget {
  final PhosphorIconData icon;
  final String label;
  final bool filled;
  final bool busy;
  final VoidCallback onTap;

  const _ActionButton({
    required this.icon,
    required this.label,
    this.filled = false,
    this.busy = false,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final child = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PhosphorIcon(icon, size: 14, color: filled ? AeronautColors.onAccent : AeronautColors.textSecondary),
        const SizedBox(width: 4),
        Text(label),
      ],
    );
    const padding = EdgeInsets.symmetric(horizontal: 12, vertical: 6);
    if (filled) {
      return ElevatedButton(
        onPressed: busy ? null : onTap,
        style: ElevatedButton.styleFrom(padding: padding, textStyle: AeronautTheme.caption1),
        child: child,
      );
    }
    return OutlinedButton(
      onPressed: busy ? null : onTap,
      style: OutlinedButton.styleFrom(padding: padding, textStyle: AeronautTheme.caption1),
      child: child,
    );
  }
}

class _ReplyField extends StatelessWidget {
  final TextEditingController controller;
  final bool busy;
  final VoidCallback onCancel;
  final ValueChanged<String> onSend;

  const _ReplyField({
    required this.controller,
    required this.busy,
    required this.onCancel,
    required this.onSend,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.end,
      children: [
        Expanded(
          child: TextField(
            controller: controller,
            autofocus: true,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.send,
            onSubmitted: onSend,
            decoration: const InputDecoration(hintText: 'Reply…', isDense: true),
          ),
        ),
        IconButton(
          icon: const PhosphorIcon(PhosphorIcons.send, size: 18),
          onPressed: busy ? null : () => onSend(controller.text),
        ),
        IconButton(
          icon: const PhosphorIcon(PhosphorIcons.close, size: 18),
          onPressed: onCancel,
        ),
      ],
    );
  }
}
