import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/activity.dart';
import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../screens/agent_screen.dart';
import '../screens/root_shell.dart';
import '../services/lee_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';
import 'work_ui.dart';

/// Idle agents that finished longer ago than this fold into a
/// "n earlier today" row (cockpit design §4.1).
const Duration staleIdleAfter = Duration(hours: 2);

/// The In flight list split for display: [visible] in order (busy, then
/// waiting, then idle/unknown), and [older] idle agents folded away.
class InFlightGroups {
  final List<AgentSummary> visible;
  final List<AgentSummary> older;

  const InFlightGroups(this.visible, this.older);
}

/// Orders [agents] for Work: busy first (longest-running first), then
/// waiting, then idle (most recently finished first), then unknown. Idle
/// agents that finished more than [staleAfter] before [now] go to
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

/// "<1m", "12m", "1h 5m", "2d".
String shortDuration(Duration d) {
  if (d.isNegative || d.inMinutes < 1) return '<1m';
  if (d.inHours < 1) return '${d.inMinutes}m';
  if (d.inDays < 1) {
    final m = d.inMinutes % 60;
    return m == 0 ? '${d.inHours}h' : '${d.inHours}h ${m}m';
  }
  return '${d.inDays}d';
}

/// The "doing now" sub-line for an agent row (cockpit design §4.1, §7.1).
String agentSubLine(AgentSummary a, {AttentionItem? waitingItem}) {
  switch (a.state) {
    case AgentRunState.busy:
      if (a.now != null && a.now!.tool.isNotEmpty) return describeNow(a.now!);
      if (a.lastTool != null && a.lastTool!.isNotEmpty) return describeActivity(tool: a.lastTool!);
      return 'Working';
    case AgentRunState.waiting:
      final title = waitingItem?.title ?? '';
      return title.isEmpty ? 'needs you' : 'needs you · $title';
    case AgentRunState.idle:
      return a.idleSince != null ? 'done · ready to review' : 'idle';
    case AgentRunState.unknown:
      return 'idle';
  }
}

DotKind agentDot(AgentRunState state) => switch (state) {
      AgentRunState.busy => DotKind.working,
      AgentRunState.waiting => DotKind.needs,
      AgentRunState.idle => DotKind.done,
      AgentRunState.unknown => DotKind.idle,
    };

/// "12m · 412k tok": how long, then the session's tokens (docs/15-Usage.md §6.2).
String agentMeta(AgentSummary a, DateTime now) {
  final since = switch (a.state) {
    AgentRunState.busy || AgentRunState.waiting => a.busySince,
    AgentRunState.idle => a.idleSince,
    AgentRunState.unknown => null,
  };
  final tokens = a.usage != null && a.usage!.shownTokens > 0 ? formatTokens(a.usage!.shownTokens) : '';
  return [
    if (since != null) shortDuration(now.difference(since)),
    if (tokens.isNotEmpty) tokens,
  ].join(' · ');
}

/// Opens [agent]'s tab: selects its window, focuses the tab in Lee and
/// switches to the Machine tab's Tabs view, which shows the active tab.
Future<void> openAgentTab(WidgetRef ref, AgentSummary agent) async {
  final machine = ref.read(machinesProvider).activeMachine;
  if (machine == null || agent.tabId == null) return;
  final windowId = agent.windowId ?? ref.read(activeWindowIdProvider);
  if (agent.windowId != null) {
    ref.read(windowsProvider.notifier).setActiveWindow(agent.windowId!);
  }
  ref.read(machineViewProvider.notifier).state = MachineView.tabs;
  ref.read(rootTabProvider.notifier).state = RootTab.machine;
  final api = LeeApi(machine: machine);
  try {
    await api.sendCommand('system', 'focus_tab', {'tab_id': agent.tabId}, windowId);
  } finally {
    api.dispose();
  }
}

/// Work's "In flight" (cockpit design §4.1): one grouped card of rows —
/// busy agents with what they're doing now, then those waiting on you, then
/// done — with idle ones over two hours folded into "n earlier today". A tap
/// opens the one-agent screen.
class InFlightSection extends ConsumerStatefulWidget {
  /// Overrides what a tap on an agent does (tests); defaults to pushing
  /// [AgentScreen].
  final void Function(AgentSummary agent)? onOpenAgent;

  const InFlightSection({this.onOpenAgent, super.key});

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
        if (i.source.ptyId == a.ptyId) return i;
      }
      return null;
    }

    void open(AgentSummary a) {
      if (widget.onOpenAgent != null) {
        widget.onOpenAgent!(a);
        return;
      }
      Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => AgentScreen(ptyId: a.ptyId)),
      );
    }

    Widget row(AgentSummary a) => AgentRow(
          key: ValueKey('agent-${a.ptyId}'),
          agent: a,
          now: now,
          waitingItem: a.state == AgentRunState.waiting ? waitingItemFor(a) : null,
          onOpen: () => open(a),
        );

    final rows = <Widget>[
      for (final a in groups.visible) row(a),
      if (groups.older.isNotEmpty)
        InkWell(
          key: const ValueKey('in-flight-older'),
          onTap: () => setState(() => _showOlder = !_showOlder),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd, vertical: 12),
            child: Row(
              children: [
                Text(
                  '${groups.older.length} earlier today',
                  style: AeronautTheme.footnote.copyWith(color: AeronautColors.textTertiary),
                ),
                const Spacer(),
                PhosphorIcon(
                  _showOlder ? PhosphorIcons.chevronUp : PhosphorIcons.chevronDown,
                  size: 14,
                  color: AeronautColors.textTertiary,
                ),
              ],
            ),
          ),
        ),
      if (_showOlder)
        for (final a in groups.older) row(a),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Eyebrow('In flight'),
        if (snapshot.agents.isEmpty)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: QuietText('No agents running.'),
          )
        else
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
            child: WorkCard(
              padding: EdgeInsets.zero,
              child: Column(
                children: [
                  for (var i = 0; i < rows.length; i++) ...[
                    if (i > 0) const Divider(height: 1, indent: AeronautTheme.spacingMd),
                    rows[i],
                  ],
                ],
              ),
            ),
          ),
      ],
    );
  }
}

/// One agent in In flight: a dot, the name, the "doing now" sub-line, and
/// how long plus its tokens on the right.
class AgentRow extends StatelessWidget {
  final AgentSummary agent;
  final DateTime now;
  final AttentionItem? waitingItem;
  final VoidCallback? onOpen;

  const AgentRow({
    required this.agent,
    required this.now,
    this.waitingItem,
    this.onOpen,
    super.key,
  });

  @override
  Widget build(BuildContext context) {
    final a = agent;
    final meta = agentMeta(a, now);
    return InkWell(
      onTap: onOpen,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 56),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd, vertical: 10),
          child: Row(
            children: [
              WorkDot(agentDot(a.state)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    Text(
                      a.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AeronautTheme.subheadline.copyWith(fontWeight: FontWeight.w500),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      agentSubLine(a, waitingItem: waitingItem),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: AeronautTheme.footnote.copyWith(color: AeronautColors.textTertiary),
                    ),
                  ],
                ),
              ),
              if (meta.isNotEmpty) ...[
                const SizedBox(width: AeronautTheme.spacingSm),
                Text(meta, style: AeronautTheme.caption1.copyWith(color: AeronautColors.textTertiary)),
              ],
              const SizedBox(width: 4),
              const PhosphorIcon(PhosphorIcons.chevronRight, size: 14, color: AeronautColors.textTertiary),
            ],
          ),
        ),
      ),
    );
  }
}
