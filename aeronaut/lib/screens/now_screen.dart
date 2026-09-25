import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/hester_models.dart';
import '../providers/attention_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../services/hester_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import '../widgets/attention_tile.dart';
import '../widgets/handoff_sheet.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/workspace_switcher.dart';

/// The Now screen: steering, not monitoring (contracts §9.2). Waiting
/// (Reply), quick Capture, the Focus toggle, Launch (v1 hand-off) and Wins
/// (v1 verified wins), all for the active machine.
class NowScreen extends ConsumerWidget {
  const NowScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machine = ref.watch(machinesProvider.select((s) => s.activeMachine));
    // RootShell wraps this tab in RequireMachine, so this only happens for
    // the frame in which the active machine is removed.
    if (machine == null) return const SizedBox.shrink();

    final windowsState = ref.watch(windowsProvider);

    return Scaffold(
      appBar: AppBar(
        title: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const MachineSwitcher(),
            if (windowsState.hasMultipleWindows) const WorkspaceSwitcher(),
          ],
        ),
        actions: [
          IconButton(
            icon: const PhosphorIcon(PhosphorIcons.send, size: 20),
            tooltip: 'Hand off…',
            onPressed: () => showModalBottomSheet<void>(
              context: context,
              isScrollControlled: true,
              backgroundColor: Colors.transparent,
              builder: (_) => const HandoffSheet(),
            ),
          ),
        ],
      ),
      body: RefreshIndicator.adaptive(
        color: AeronautColors.accent,
        backgroundColor: AeronautColors.bgSurface,
        onRefresh: () => ref.read(attentionProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.only(bottom: AeronautTheme.spacingXl),
          children: const [
            _FocusCard(),
            _CaptureCard(),
            _WaitingSection(),
            _WinsSection(),
          ],
        ),
      ),
    );
  }
}

class _FocusCard extends ConsumerWidget {
  const _FocusCard();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attention = ref.watch(attentionProvider);
    final focus = attention.snapshot.focus;
    final away = attention.snapshot.away;

    final String label;
    if (focus.active) {
      final what = focus.item?.displayLabel ?? '';
      label = what.isEmpty ? 'Focus · ${focus.quietCount} queued' : 'Focus · $what · ${focus.quietCount} queued';
    } else if (away.active) {
      label = 'Away · ${away.parkedCount} parked';
    } else {
      label = 'Not focused';
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        0,
      ),
      child: Container(
        padding: const EdgeInsets.symmetric(
          horizontal: AeronautTheme.spacingMd,
          vertical: AeronautTheme.spacingSm,
        ),
        decoration: BoxDecoration(
          color: AeronautColors.bgSurface,
          borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
          border: Border.all(color: AeronautColors.border),
        ),
        child: Row(
          children: [
            PhosphorIcon(
              focus.active ? PhosphorIcons.eye : PhosphorIcons.eyeOff,
              size: 20,
              color: focus.active ? AeronautColors.accent : AeronautColors.textTertiary,
            ),
            const SizedBox(width: AeronautTheme.spacingSm),
            Expanded(child: Text(label, style: AeronautTheme.subheadline)),
            Switch.adaptive(
              value: focus.active,
              activeThumbColor: AeronautColors.accent,
              onChanged: (value) {
                final notifier = ref.read(attentionProvider.notifier);
                if (value) {
                  notifier.focusStart();
                } else {
                  notifier.focusStop();
                }
              },
            ),
          ],
        ),
      ),
    );
  }
}

class _CaptureCard extends ConsumerStatefulWidget {
  const _CaptureCard();

  @override
  ConsumerState<_CaptureCard> createState() => _CaptureCardState();
}

class _CaptureCardState extends ConsumerState<_CaptureCard> {
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
    final result =
        await ref.read(attentionProvider.notifier).capture(text, workspace: workspace, asExploration: _asExploration);
    if (!mounted) return;
    setState(() => _busy = false);
    if (result.success) {
      _controller.clear();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(result.spooled ? 'Saved; will sync when Hester is back' : 'Captured')),
      );
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
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
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        0,
      ),
      child: Container(
        padding: const EdgeInsets.all(AeronautTheme.spacingMd),
        decoration: BoxDecoration(
          color: AeronautColors.bgSurface,
          borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
          border: Border.all(color: AeronautColors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                const PhosphorIcon(PhosphorIcons.edit, size: 16, color: AeronautColors.textSecondary),
                const SizedBox(width: 6),
                Text('Capture', style: AeronautTheme.footnote.copyWith(fontWeight: FontWeight.w600)),
              ],
            ),
            const SizedBox(height: AeronautTheme.spacingSm),
            TextField(
              controller: _controller,
              minLines: 1,
              maxLines: 3,
              textInputAction: TextInputAction.done,
              onSubmitted: (_) => _capture(),
              decoration: const InputDecoration(hintText: 'Jot an idea for later…', isDense: true),
            ),
            Row(
              children: [
                Checkbox(
                  value: _asExploration,
                  onChanged: (v) => setState(() => _asExploration = v ?? false),
                ),
                const Text('As exploration', style: AeronautTheme.caption1),
                const Spacer(),
                ElevatedButton(
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
    );
  }
}

class _WaitingSection extends ConsumerWidget {
  const _WaitingSection();

  static const _severityOrder = {
    AttentionSeverity.blocking: 0,
    AttentionSeverity.needsYou: 1,
    AttentionSeverity.ambient: 2,
  };

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attention = ref.watch(attentionProvider);
    final items = attention.snapshot.items
        .where((i) => i.state == AttentionItemState.open || i.state == AttentionItemState.snoozed)
        .toList()
      ..sort((a, b) {
        final cmp = _severityOrder[a.severity]!.compareTo(_severityOrder[b.severity]!);
        if (cmp != 0) return cmp;
        return b.activeWaitMs.compareTo(a.activeWaitMs);
      });

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Padding(
          padding: EdgeInsets.fromLTRB(
            AeronautTheme.spacingMd,
            AeronautTheme.spacingLg,
            AeronautTheme.spacingMd,
            AeronautTheme.spacingXs,
          ),
          child: Text('Waiting', style: AeronautTheme.headline),
        ),
        if (attention.loading && items.isEmpty)
          const Padding(
            padding: EdgeInsets.all(AeronautTheme.spacingLg),
            child: Center(child: CircularProgressIndicator.adaptive(strokeWidth: 2)),
          )
        else if (items.isEmpty)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AeronautTheme.spacingMd,
              vertical: AeronautTheme.spacingLg,
            ),
            child: Text(
              attention.error ?? "You're all caught up.",
              style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
            ),
          )
        else
          for (final item in items)
            AttentionTile(item: item, awayActive: attention.snapshot.away.active),
      ],
    );
  }
}

/// Verified wins + agent claims for the selected window's workspace (v1,
/// contracts §8.4, §9.2). Reloads whenever the workspace selection changes.
class _WinsSection extends ConsumerStatefulWidget {
  const _WinsSection();

  @override
  ConsumerState<_WinsSection> createState() => _WinsSectionState();
}

class _WinsSectionState extends ConsumerState<_WinsSection> {
  DigestResult? _digest;
  bool _loading = false;
  String? _error;
  String? _loadedWorkspace;

  Future<void> _load(String workspace) async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = HesterApi(machine: machine);
    try {
      final digest = await api.getDigest(workspace: workspace);
      if (!mounted) return;
      setState(() {
        _digest = digest;
        _loading = false;
        _loadedWorkspace = workspace;
        if (digest == null) _error = 'Hester offline';
      });
    } finally {
      api.dispose();
    }
  }

  @override
  Widget build(BuildContext context) {
    final workspace = ref.watch(windowsProvider.select((s) => s.activeWindow?.workspace));
    if (workspace != null && workspace != _loadedWorkspace && !_loading) {
      SchedulerBinding.instance.addPostFrameCallback((_) {
        if (mounted) _load(workspace);
      });
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(
            AeronautTheme.spacingMd,
            AeronautTheme.spacingLg,
            AeronautTheme.spacingMd,
            AeronautTheme.spacingXs,
          ),
          child: Row(
            children: [
              const Text('Wins', style: AeronautTheme.headline),
              const Spacer(),
              if (workspace != null)
                IconButton(
                  icon: const PhosphorIcon(PhosphorIcons.refresh, size: 16),
                  onPressed: _loading ? null : () => _load(workspace),
                ),
            ],
          ),
        ),
        if (workspace == null)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: Text('No workspace selected.', style: AeronautTheme.caption1),
          )
        else if (_loading && _digest == null)
          const Padding(
            padding: EdgeInsets.all(AeronautTheme.spacingLg),
            child: Center(child: CircularProgressIndicator.adaptive(strokeWidth: 2)),
          )
        else if (_digest != null)
          _DigestBody(digest: _digest!)
        else
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: Text(
              _error ?? '',
              style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
            ),
          ),
      ],
    );
  }
}

class _DigestBody extends StatelessWidget {
  final DigestResult digest;

  const _DigestBody({required this.digest});

  @override
  Widget build(BuildContext context) {
    if (digest.wins.isEmpty && digest.agentClaims.isEmpty) {
      return const Padding(
        padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
        child: Text('Nothing verified yet.', style: AeronautTheme.caption1),
      );
    }
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (digest.topLine.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(bottom: AeronautTheme.spacingSm),
              child: Text(
                digest.topLine,
                style: AeronautTheme.caption1.copyWith(color: AeronautColors.textSecondary),
              ),
            ),
          for (final win in digest.wins)
            _WinRow(icon: PhosphorIcons.check, title: win.title, verified: win.verified),
          for (final claim in digest.agentClaims)
            _WinRow(
              icon: PhosphorIcons.agent,
              title: claim.summary.isEmpty ? 'Claude finished a turn' : claim.summary,
              badge: 'Claude says',
            ),
        ],
      ),
    );
  }
}

class _WinRow extends StatelessWidget {
  final PhosphorIconData icon;
  final String title;
  final bool verified;
  final String? badge;

  const _WinRow({required this.icon, required this.title, this.verified = false, this.badge});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          PhosphorIcon(icon, size: 14, color: verified ? AeronautColors.online : AeronautColors.textTertiary),
          const SizedBox(width: 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: AeronautTheme.footnote, maxLines: 2, overflow: TextOverflow.ellipsis),
                if (badge != null)
                  Text(badge!, style: AeronautTheme.caption2.copyWith(color: AeronautColors.textTertiary)),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
