import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../screens/root_shell.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// Idle agents that finished longer ago than this fold into a
/// "N earlier" row instead of taking space on Now.
const Duration staleIdleAfter = Duration(hours: 1);

/// The In flight list split for display: [visible] in order (busy, then
/// waiting, then idle/unknown), and [older] idle agents folded away.
class InFlightGroups {
  final List<AgentSummary> visible;
  final List<AgentSummary> older;

  const InFlightGroups(this.visible, this.older);
}

/// Orders [agents] for the Now screen: busy first (longest-running first),
/// then waiting, then idle (most recently finished first), then unknown.
/// Idle agents that finished more than [staleAfter] before [now] go to
/// [InFlightGroups.older]. Pure, so ordering is unit-testable.
InFlightGroups inFlightGroups(
  List<AgentSummary> agents,
  DateTime now, {
  Duration staleAfter = staleIdleAfter,
}) {
  int rank(AgentRunState s) => switch (s) {
        AgentRunState.busy => 0,
        AgentRunState.waiting => 1,
        AgentRunState.idle => 2,
        AgentRunState.unknown => 3,
      };
  final far = DateTime.fromMillisecondsSinceEpoch(0);
  final sorted = [...agents]..sort((a, b) {
      final r = rank(a.state).compareTo(rank(b.state));
      if (r != 0) return r;
      if (a.state == AgentRunState.idle) {
        return (b.idleSince ?? far).compareTo(a.idleSince ?? far);
      }
      return (a.busySince ?? now).compareTo(b.busySince ?? now);
    });
  final visible = <AgentSummary>[];
  final older = <AgentSummary>[];
  for (final a in sorted) {
    final stale = a.state == AgentRunState.idle &&
        a.idleSince != null &&
        now.difference(a.idleSince!) > staleAfter;
    (stale ? older : visible).add(a);
  }
  return InFlightGroups(visible, older);
}

/// "just now", "12m", "1h 5m", "2d".
String shortDuration(Duration d) {
  if (d.isNegative || d.inMinutes < 1) return '<1m';
  if (d.inHours < 1) return '${d.inMinutes}m';
  if (d.inDays < 1) {
    final m = d.inMinutes % 60;
    return m == 0 ? '${d.inHours}h' : '${d.inHours}h ${m}m';
  }
  return '${d.inDays}d';
}

/// Opens [agent]'s tab: selects its window, focuses the tab in Lee and
/// switches to the Tabs root, which shows the active tab (the terminal).
Future<void> openAgentTab(WidgetRef ref, AgentSummary agent) async {
  final machine = ref.read(machinesProvider).activeMachine;
  if (machine == null || agent.tabId == null) return;
  final windowId = agent.windowId ?? ref.read(activeWindowIdProvider);
  if (agent.windowId != null) {
    ref.read(windowsProvider.notifier).setActiveWindow(agent.windowId!);
  }
  ref.read(rootTabProvider.notifier).state = RootTab.tabs;
  final api = LeeApi(machine: machine);
  try {
    await api.sendCommand('system', 'focus_tab', {'tab_id': agent.tabId}, windowId);
  } finally {
    api.dispose();
  }
}

/// Now's "In flight" section (every agent Lee is running, not just the ones
/// waiting): state, elapsed time, last tool and the agent's last words.
/// Read-only and tap-driven: a tap opens the agent's tab.
class InFlightSection extends ConsumerStatefulWidget {
  /// Scrolls to a Waiting item; used by a waiting agent's "needs you" link.
  final void Function(String itemId)? onShowItem;

  /// Overrides what a tap on an agent does (tests); defaults to [openAgentTab].
  final void Function(AgentSummary agent)? onOpenAgent;

  const InFlightSection({this.onShowItem, this.onOpenAgent, super.key});

  @override
  ConsumerState<InFlightSection> createState() => _InFlightSectionState();
}

class _InFlightSectionState extends ConsumerState<InFlightSection> {
  Timer? _ticker;
  bool _showOlder = false;

  @override
  void initState() {
    super.initState();
    // Elapsed times are minutes-grained; repaint twice a minute.
    _ticker = Timer.periodic(const Duration(seconds: 30), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _ticker?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final snapshot = ref.watch(attentionProvider.select((s) => s.snapshot));
    final now = DateTime.now();
    final groups = inFlightGroups(snapshot.agents, now);
    final liveItems = snapshot.items
        .where((i) => i.state == AttentionItemState.open || i.state == AttentionItemState.snoozed)
        .toList();

    AttentionItem? waitingItemFor(AgentSummary a) {
      for (final i in liveItems) {
        if (i.source.ptyId == a.ptyId &&
            (i.kind == AttentionKind.approval || i.kind == AttentionKind.waiting)) {
          return i;
        }
      }
      return null;
    }

    void open(AgentSummary a) =>
        widget.onOpenAgent != null ? widget.onOpenAgent!(a) : unawaited(openAgentTab(ref, a));

    Widget row(AgentSummary a) => AgentRow(
          key: ValueKey('agent-${a.ptyId}'),
          agent: a,
          now: now,
          waitingItem: a.state == AgentRunState.waiting ? waitingItemFor(a) : null,
          onOpen: a.tabId == null ? null : () => open(a),
          onShowItem: widget.onShowItem,
        );

    final count = snapshot.agents.length;
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
              const Text('In flight', style: AeronautTheme.headline),
              const SizedBox(width: AeronautTheme.spacingSm),
              if (count > 0)
                Text('$count', style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
            ],
          ),
        ),
        if (count == 0)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AeronautTheme.spacingMd,
              vertical: AeronautTheme.spacingSm,
            ),
            child: Text(
              'No agents running.',
              style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
            ),
          )
        else ...[
          for (final a in groups.visible) row(a),
          if (groups.older.isNotEmpty) ...[
            InkWell(
              onTap: () => setState(() => _showOlder = !_showOlder),
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: AeronautTheme.spacingMd,
                  vertical: AeronautTheme.spacingSm,
                ),
                child: Row(
                  children: [
                    PhosphorIcon(
                      _showOlder ? PhosphorIcons.chevronUp : PhosphorIcons.chevronDown,
                      size: 14,
                      color: AeronautColors.textTertiary,
                    ),
                    const SizedBox(width: 6),
                    Text(
                      '${groups.older.length} idle over an hour',
                      style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary),
                    ),
                  ],
                ),
              ),
            ),
            if (_showOlder)
              for (final a in groups.older) row(a),
          ],
        ],
      ],
    );
  }
}

/// One agent in In flight. Tapping the row opens its tab; tapping the
/// summary expands it; a waiting agent links to its Waiting item.
class AgentRow extends StatefulWidget {
  final AgentSummary agent;
  final DateTime now;
  final AttentionItem? waitingItem;
  final VoidCallback? onOpen;
  final void Function(String itemId)? onShowItem;

  const AgentRow({
    required this.agent,
    required this.now,
    this.waitingItem,
    this.onOpen,
    this.onShowItem,
    super.key,
  });

  @override
  State<AgentRow> createState() => _AgentRowState();
}

class _AgentRowState extends State<AgentRow> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final a = widget.agent;
    final (Color color, String status) = switch (a.state) {
      AgentRunState.busy => (
          AeronautColors.accent,
          a.busySince != null ? 'busy ${shortDuration(widget.now.difference(a.busySince!))}' : 'busy',
        ),
      AgentRunState.waiting => (AeronautColors.warning, 'needs you'),
      AgentRunState.idle => (
          AeronautColors.textTertiary,
          a.idleSince != null ? 'finished ${shortDuration(widget.now.difference(a.idleSince!))} ago' : 'idle',
        ),
      AgentRunState.unknown => (AeronautColors.textTertiary, 'ready'),
    };
    final meta = [
      if (a.lastTool != null && a.lastTool!.isNotEmpty) a.lastTool!,
      if (a.filesTouchedCount > 0) '${a.filesTouchedCount} file${a.filesTouchedCount == 1 ? '' : 's'}',
      if (a.workspaceName != null && !a.label.contains(a.workspaceName!)) a.workspaceName!,
    ].join(' · ');
    final summary = a.lastSummary?.trim() ?? '';
    final item = widget.waitingItem;

    return Padding(
      padding: const EdgeInsets.fromLTRB(AeronautTheme.spacingMd, 0, AeronautTheme.spacingMd, AeronautTheme.spacingSm),
      child: Material(
        color: AeronautColors.bgSurface,
        borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
        child: InkWell(
          borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
          onTap: widget.onOpen,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd, vertical: 10),
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(AeronautTheme.radiusMd),
              border: Border.all(
                color: a.state == AgentRunState.waiting
                    ? AeronautColors.warning.withValues(alpha: 0.4)
                    : AeronautColors.border,
              ),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    _StateDot(color: color, glow: a.state == AgentRunState.busy),
                    const SizedBox(width: AeronautTheme.spacingSm),
                    Expanded(
                      child: Text(
                        a.label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: AeronautTheme.subheadline.copyWith(fontWeight: FontWeight.w600),
                      ),
                    ),
                    const SizedBox(width: AeronautTheme.spacingSm),
                    Text(status, style: AeronautTheme.caption1.copyWith(color: color)),
                    if (widget.onOpen != null) ...[
                      const SizedBox(width: 4),
                      const PhosphorIcon(PhosphorIcons.chevronRight, size: 14, color: AeronautColors.textTertiary),
                    ],
                  ],
                ),
                if (meta.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 16, top: 2),
                    child: Text(
                      meta,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AeronautTheme.caption2.copyWith(color: AeronautColors.textTertiary),
                    ),
                  ),
                if (item != null)
                  Padding(
                    padding: const EdgeInsets.only(left: 16, top: 6),
                    child: InkWell(
                      onTap: widget.onShowItem == null ? null : () => widget.onShowItem!(item.id),
                      child: Row(
                        children: [
                          const PhosphorIcon(PhosphorIcons.bell, size: 12, color: AeronautColors.warning),
                          const SizedBox(width: 4),
                          Expanded(
                            child: Text(
                              item.title,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: AeronautTheme.caption1.copyWith(color: AeronautColors.warning),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                if (summary.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(left: 16, top: 6),
                    child: GestureDetector(
                      behavior: HitTestBehavior.opaque,
                      onTap: () => setState(() => _expanded = !_expanded),
                      child: Text(
                        summary,
                        maxLines: _expanded ? null : 2,
                        overflow: _expanded ? TextOverflow.visible : TextOverflow.ellipsis,
                        style: AeronautTheme.footnote.copyWith(color: AeronautColors.textSecondary),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _StateDot extends StatelessWidget {
  final Color color;
  final bool glow;

  const _StateDot({required this.color, this.glow = false});

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 8,
      height: 8,
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        color: color,
        boxShadow: glow ? [BoxShadow(color: color.withValues(alpha: 0.5), blurRadius: 6)] : null,
      ),
    );
  }
}
