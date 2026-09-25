import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../providers/attention_provider.dart';
import '../providers/machines_provider.dart';
import '../providers/windows_provider.dart';
import '../services/copilot_api.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import '../theme/phosphor_icons.generated.dart';
import 'phosphor_icon.dart';

/// Hand-off sheet (v1, contracts §7.1, §9.2): follow-ups for idle agents,
/// wake marks on waiting items and busy/idle agents, one optional new
/// background launch, and a summary policy — committed by a single
/// **Launch** button (`POST /handoff/start`). Every field is optional; only
/// that one click causes anything (C3).
class HandoffSheet extends ConsumerStatefulWidget {
  const HandoffSheet({super.key});

  @override
  ConsumerState<HandoffSheet> createState() => _HandoffSheetState();
}

class _HandoffSheetState extends ConsumerState<HandoffSheet> {
  HandoffProposals? _proposals;
  bool _loading = true;
  String? _error;
  bool _launching = false;

  final Map<int, TextEditingController> _followupControllers = {};
  final Set<int> _wakePtyIds = {};
  final Set<String> _wakeItemIds = {};
  SummaryPolicyMode _summaryMode = SummaryPolicyMode.onReturn;

  bool _newLaunch = false;
  final _promptController = TextEditingController();
  final _titleController = TextEditingController();
  bool _worktree = true;
  String _permissionMode = 'acceptEdits';
  String? _launchWorkspace;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) {
      setState(() {
        _loading = false;
        _error = 'No active machine.';
      });
      return;
    }
    final api = CopilotApi(machine: machine);
    try {
      final proposals = await api.handoffProposals();
      if (!mounted) return;
      setState(() {
        _proposals = proposals;
        _loading = false;
        _error = proposals == null ? 'Could not load agents.' : null;
        _summaryMode = proposals?.defaultSummary.mode ?? SummaryPolicyMode.onReturn;
        _launchWorkspace =
            ref.read(windowsProvider).activeWindow?.workspace ?? proposals?.workspaces.firstOrNull;
      });
    } finally {
      api.dispose();
    }
  }

  @override
  void dispose() {
    for (final c in _followupControllers.values) {
      c.dispose();
    }
    _promptController.dispose();
    _titleController.dispose();
    super.dispose();
  }

  TextEditingController _followupController(int ptyId) =>
      _followupControllers.putIfAbsent(ptyId, TextEditingController.new);

  Future<void> _launch() async {
    final machine = ref.read(machinesProvider).activeMachine;
    if (machine == null) return;
    setState(() => _launching = true);

    final followups = <HandoffFollowup>[
      for (final entry in _followupControllers.entries)
        if (entry.value.text.trim().isNotEmpty)
          HandoffFollowup(ptyId: entry.key, text: entry.value.text.trim()),
    ];
    final launches = <HandoffLaunch>[
      if (_newLaunch && _promptController.text.trim().isNotEmpty && _launchWorkspace != null)
        HandoffLaunch(
          workspace: _launchWorkspace!,
          prompt: _promptController.text.trim(),
          title: _titleController.text.trim().isEmpty ? null : _titleController.text.trim(),
          worktree: _worktree,
          permissionMode: _permissionMode,
        ),
    ];
    final summary = switch (_summaryMode) {
      SummaryPolicyMode.none => const SummaryPolicy.none(),
      SummaryPolicyMode.onReturn => const SummaryPolicy.onReturn(),
      // v0 UI has no time picker yet; "at a time" defaults to two hours out.
      SummaryPolicyMode.at => SummaryPolicy.at(DateTime.now().add(const Duration(hours: 2))),
    };

    final api = CopilotApi(machine: machine);
    final HandoffResult result;
    try {
      result = await api.handoffStart(HandoffRequest(
        followups: followups,
        launch: launches,
        summary: summary,
        wakeItemIds: _wakeItemIds.toList(),
        wakePtyIds: _wakePtyIds.toList(),
      ));
    } finally {
      api.dispose();
    }
    if (!mounted) return;
    setState(() => _launching = false);
    if (result.success) {
      unawaited(ref.read(attentionProvider.notifier).refresh());
      Navigator.of(context).pop();
    } else {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(result.error ?? 'Hand-off failed'),
          backgroundColor: AeronautColors.offline,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    return DraggableScrollableSheet(
      initialChildSize: 0.85,
      minChildSize: 0.5,
      maxChildSize: 0.95,
      expand: false,
      builder: (context, scrollController) {
        return Container(
          decoration: const BoxDecoration(
            color: AeronautColors.bgPrimary,
            borderRadius: BorderRadius.vertical(top: Radius.circular(AeronautTheme.radiusLg)),
          ),
          child: SafeArea(
            top: false,
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                  child: Row(
                    children: [
                      const Text('Hand off…', style: AeronautTheme.title3),
                      const Spacer(),
                      IconButton(
                        icon: const PhosphorIcon(PhosphorIcons.close, size: 20),
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: _loading
                      ? const Center(child: CircularProgressIndicator.adaptive(strokeWidth: 2))
                      : (_proposals == null)
                          ? Center(
                              child: Text(_error ?? 'Could not load agents.', style: AeronautTheme.caption1),
                            )
                          : ListView(
                              controller: scrollController,
                              padding: const EdgeInsets.symmetric(horizontal: AeronautTheme.spacingMd),
                              children: _buildContent(_proposals!),
                            ),
                ),
                Padding(
                  padding: const EdgeInsets.all(AeronautTheme.spacingMd),
                  child: SizedBox(
                    width: double.infinity,
                    child: ElevatedButton(
                      onPressed: (_loading || _launching || _proposals == null) ? null : _launch,
                      child: _launching
                          ? const SizedBox(
                              height: 18,
                              width: 18,
                              child: CircularProgressIndicator.adaptive(strokeWidth: 2),
                            )
                          : const Text('Launch'),
                    ),
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }

  List<Widget> _buildContent(HandoffProposals proposals) {
    return [
      if (proposals.agents.isNotEmpty) ...[
        const Text('Agents', style: AeronautTheme.headline),
        const SizedBox(height: AeronautTheme.spacingSm),
        for (final agent in proposals.agents)
          _AgentRow(
            agent: agent,
            controller: agent.isIdle ? _followupController(agent.ptyId) : null,
            waking: _wakePtyIds.contains(agent.ptyId),
            onWakeToggle: (v) =>
                setState(() => v ? _wakePtyIds.add(agent.ptyId) : _wakePtyIds.remove(agent.ptyId)),
          ),
        const SizedBox(height: AeronautTheme.spacingMd),
      ],
      const Text('New agent', style: AeronautTheme.headline),
      SwitchListTile.adaptive(
        contentPadding: EdgeInsets.zero,
        title: const Text('Launch a new agent'),
        value: _newLaunch,
        onChanged: (v) => setState(() => _newLaunch = v),
      ),
      if (_newLaunch) ...[
        if (proposals.workspaces.length > 1)
          DropdownButton<String>(
            value: _launchWorkspace,
            isExpanded: true,
            items: [
              for (final ws in proposals.workspaces)
                DropdownMenuItem(value: ws, child: Text(ws.split('/').last)),
            ],
            onChanged: (v) => setState(() => _launchWorkspace = v),
          ),
        TextField(
          controller: _titleController,
          decoration: const InputDecoration(labelText: 'Title (optional)'),
        ),
        const SizedBox(height: AeronautTheme.spacingSm),
        TextField(
          controller: _promptController,
          minLines: 2,
          maxLines: 5,
          decoration: const InputDecoration(labelText: 'Prompt'),
        ),
        SwitchListTile.adaptive(
          contentPadding: EdgeInsets.zero,
          title: const Text('New worktree'),
          value: _worktree,
          onChanged: (v) => setState(() => _worktree = v),
        ),
        DropdownButton<String>(
          value: _permissionMode,
          items: const [
            DropdownMenuItem(value: 'acceptEdits', child: Text('Accept edits')),
            DropdownMenuItem(value: 'default', child: Text('Default')),
            DropdownMenuItem(value: 'plan', child: Text('Plan')),
          ],
          onChanged: (v) => setState(() => _permissionMode = v ?? 'acceptEdits'),
        ),
      ],
      const SizedBox(height: AeronautTheme.spacingMd),
      const Text('Summary', style: AeronautTheme.headline),
      const SizedBox(height: AeronautTheme.spacingSm),
      SegmentedButton<SummaryPolicyMode>(
        segments: const [
          ButtonSegment(value: SummaryPolicyMode.none, label: Text('None')),
          ButtonSegment(value: SummaryPolicyMode.onReturn, label: Text("When I'm back")),
          ButtonSegment(value: SummaryPolicyMode.at, label: Text('At a time')),
        ],
        selected: {_summaryMode},
        onSelectionChanged: (selection) => setState(() => _summaryMode = selection.first),
      ),
      if (_summaryMode == SummaryPolicyMode.at)
        const Padding(
          padding: EdgeInsets.only(top: 4),
          child: Text('2 hours from now', style: AeronautTheme.caption2),
        ),
      if (proposals.waiting.isNotEmpty) ...[
        const SizedBox(height: AeronautTheme.spacingMd),
        const Text('Waiting items', style: AeronautTheme.headline),
        for (final item in proposals.waiting)
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            title: Text(item.title, maxLines: 1, overflow: TextOverflow.ellipsis),
            value: _wakeItemIds.contains(item.id),
            onChanged: (v) =>
                setState(() => (v ?? false) ? _wakeItemIds.add(item.id) : _wakeItemIds.remove(item.id)),
          ),
      ],
      const SizedBox(height: AeronautTheme.spacingXl),
    ];
  }
}

class _AgentRow extends StatelessWidget {
  final HandoffAgent agent;
  final TextEditingController? controller;
  final bool waking;
  final ValueChanged<bool> onWakeToggle;

  const _AgentRow({
    required this.agent,
    this.controller,
    required this.waking,
    required this.onWakeToggle,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: Text(agent.label, style: AeronautTheme.subheadline)),
              Text(agent.state, style: AeronautTheme.caption2.copyWith(color: AeronautColors.textTertiary)),
              Checkbox(value: waking, onChanged: (v) => onWakeToggle(v ?? false)),
              const Text('Wake me', style: AeronautTheme.caption2),
            ],
          ),
          if (controller != null)
            TextField(
              controller: controller,
              decoration: const InputDecoration(hintText: 'Follow-up (optional)', isDense: true),
            ),
        ],
      ),
    );
  }
}
