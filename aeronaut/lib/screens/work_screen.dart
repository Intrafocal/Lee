import 'package:flutter/material.dart';
import 'package:flutter/scheduler.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity.dart';
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
import '../widgets/deep_idle_card.dart';
import '../widgets/in_flight_section.dart';
import '../widgets/machine_switcher.dart';
import '../widgets/now_header_actions.dart';
import '../widgets/phosphor_icon.dart';
import '../widgets/work_ui.dart';
import '../widgets/workspace_switcher.dart';
import 'agent_screen.dart';

/// Items that need you: what Work's headline counts (cockpit design §4.1;
/// summaries and ambient items don't, and the Desk's "Still thinking?"
/// push has its own card, [DeepIdleCard]).
List<AttentionItem> waitingOnYou(AttentionSnapshot snapshot) => snapshot.items
    .where((i) =>
        (i.state == AttentionItemState.open || i.state == AttentionItemState.snoozed) &&
        i.severity != AttentionSeverity.ambient &&
        i.kind != AttentionKind.summary &&
        i.kind != AttentionKind.deepIdle)
    .toList();

/// Work (cockpit design §4, §8.1): the Now screen, renamed. One serif line
/// says what needs you, then the waiting cards (blocking first, oldest
/// first), then In flight, then recent Progress. Capture (+), Focus and
/// hand-off sit in the app bar; during a Deep session the header says "In
/// deep work" instead of offering Focus (14 §8.1).
class WorkScreen extends ConsumerWidget {
  const WorkScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final machine = ref.watch(machinesProvider.select((s) => s.activeMachine));
    // RootShell wraps this tab in RequireMachine, so this only happens for
    // the frame in which the active machine is removed.
    if (machine == null) return const SizedBox.shrink();

    final windowsState = ref.watch(windowsProvider);
    final deep = ref.watch(attentionProvider.select((s) => s.snapshot.deep));

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
          if (deep != null) const _InDeepWork() else const FocusMenuButton(),
          IconButton(
            icon: const PhosphorIcon(PhosphorIcons.send, size: 20),
            tooltip: 'Hand off…',
            onPressed: () => showHandoffSheet(context),
          ),
          const CaptureButton(),
        ],
      ),
      body: RefreshIndicator.adaptive(
        color: AeronautColors.accent,
        backgroundColor: AeronautColors.bgSurface,
        onRefresh: () => ref.read(attentionProvider.notifier).refresh(),
        child: ListView(
          padding: const EdgeInsets.only(bottom: AeronautTheme.spacingXl),
          children: const [
            _AwayBanner(),
            _DeepIdleSection(),
            _Headline(),
            _WaitingSection(),
            InFlightSection(),
            _WinsSection(),
          ],
        ),
      ),
    );
  }
}

/// "In deep work": a Deep session is running at the Mac, so devices hold
/// notifications and Focus isn't offered (14 §8.1).
class _InDeepWork extends StatelessWidget {
  const _InDeepWork();

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingSm),
        child: Text(
          'In deep work',
          key: const ValueKey('in-deep-work'),
          style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
        ),
      ),
    );
  }
}

/// Desk D2 §9.2: the "Still thinking?" push, first on Work while it's open.
class _DeepIdleSection extends ConsumerWidget {
  const _DeepIdleSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final item = ref.watch(attentionProvider.select((s) => openDeepIdle(s.snapshot)));
    return item == null ? const SizedBox.shrink() : DeepIdleCard(item: item);
  }
}

/// Work's one serif line (§4.1): "Two things need you.", "Working on it."
/// or "All clear.", with a neutral count line under it.
class _Headline extends ConsumerWidget {
  const _Headline();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final attention = ref.watch(attentionProvider);
    final snapshot = attention.snapshot;
    final waiting = waitingOnYou(snapshot).length;
    final working = snapshot.agents.where((a) => a.state == AgentRunState.busy).length;
    final summary = [
      if (waiting > 0) '$waiting waiting on you',
      if (working > 0) '$working working',
    ].join(' · ');
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingLg,
        AeronautTheme.spacingMd,
        0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            workLine(waiting: waiting, working: working),
            key: const ValueKey('work-line'),
            style: writingStyle(size: 22),
          ),
          if (attention.error != null && snapshot.items.isEmpty) ...[
            const SizedBox(height: 4),
            QuietText(attention.error!),
          ] else if (summary.isNotEmpty) ...[
            const SizedBox(height: 4),
            QuietText(summary),
          ],
        ],
      ),
    );
  }
}

/// While a hand-off is running, a one-line reminder of it (the old Focus
/// card carried this).
class _AwayBanner extends ConsumerWidget {
  const _AwayBanner();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final away = ref.watch(attentionProvider.select((s) => s.snapshot.away));
    if (!away.active) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        AeronautTheme.spacingMd,
        0,
      ),
      child: Row(
        children: [
          const PhosphorIcon(PhosphorIcons.send, size: 14, color: AeronautColors.textSecondary),
          const SizedBox(width: AeronautTheme.spacingSm),
          Text(
            'Away · ${away.parkedCount} parked',
            style: AeronautTheme.caption1.copyWith(color: AeronautColors.textSecondary),
          ),
        ],
      ),
    );
  }
}

/// "Waiting on you" (§4.1): one card per item that needs you
/// ([waitingOnYou], as the headline counts them), blocking first, then
/// needs-you, longest-waiting first within each. Ambient and summary items
/// stay off it, as on the Mac: they aren't waiting on you. The first
/// card is raised, so its Allow is the view's one phosphor control, unless
/// the "Still thinking?" push is showing: its Extend is then the one. A
/// card opens the one-agent screen.
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
    final snapshot = attention.snapshot;
    final idle = openDeepIdle(snapshot) != null;
    final items = waitingOnYou(snapshot)
      ..sort((a, b) {
        final cmp = _severityOrder[a.severity]!.compareTo(_severityOrder[b.severity]!);
        if (cmp != 0) return cmp;
        return b.activeWaitMs.compareTo(a.activeWaitMs);
      });

    if (attention.loading && items.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(AeronautTheme.spacingLg),
        child: Center(child: CircularProgressIndicator.adaptive(strokeWidth: 2)),
      );
    }
    if (items.isEmpty) return const SizedBox.shrink();

    String? tokensFor(AttentionItem item) {
      for (final a in snapshot.agents) {
        if (a.ptyId == item.source.ptyId && a.usage != null && a.usage!.shownTokens > 0) {
          return formatTokens(a.usage!.shownTokens);
        }
      }
      return null;
    }

    void open(AttentionItem item, {bool focusReply = false}) {
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => AgentScreen(ptyId: item.source.ptyId, itemId: item.id, focusReply: focusReply),
        ),
      );
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('Waiting on you', needs: true),
        for (var i = 0; i < items.length; i++)
          AttentionTile(
            key: ValueKey('waiting-${items[i].id}'),
            item: items[i],
            awayActive: snapshot.away.active,
            raised: i == 0 && !idle,
            tokenLabel: tokensFor(items[i]),
            onOpen: () => open(items[i]),
            onWriteReply: () => open(items[i], focusReply: true),
          ),
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
        Row(
          children: [
            const Expanded(child: Eyebrow('Progress')),
            if (workspace != null)
              Padding(
                padding: const EdgeInsets.only(top: AeronautTheme.spacingMd, right: AeronautTheme.spacingSm),
                child: IconButton(
                  tooltip: 'Refresh progress',
                  icon: const PhosphorIcon(PhosphorIcons.refresh, size: 16),
                  onPressed: _loading ? null : () => _load(workspace),
                ),
              ),
          ],
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
          PhosphorIcon(icon, size: 14, color: verified ? AeronautColors.textSecondary : AeronautColors.textTertiary),
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
