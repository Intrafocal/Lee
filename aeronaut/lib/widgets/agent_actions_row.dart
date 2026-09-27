import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/hester_models.dart';
import '../providers/attention_provider.dart';
import '../services/agent_actions.dart';
import '../theme/aeronaut_colors.dart';
import '../theme/aeronaut_theme.dart';
import 'work_ui.dart';

/// The one-agent screen's actions (Desk D2 §9.4, the Mac's Work detail):
/// Check in, Rename, Accept (a task in review) and Assign… (an agent with
/// no task: to an open task or a new one). All quiet: the screen's one next
/// step stays Allow or Send.
class AgentActionsRow extends ConsumerStatefulWidget {
  final AgentSummary? agent;

  /// The agent's workspace (or the item's), where its task lives.
  final String? workspace;

  const AgentActionsRow({required this.agent, required this.workspace, super.key});

  @override
  ConsumerState<AgentActionsRow> createState() => _AgentActionsRowState();
}

class _AgentActionsRowState extends ConsumerState<AgentActionsRow> {
  List<TaskRef>? _tasks;
  bool _busy = false;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    final actions = ref.read(agentActionsProvider);
    final ws = widget.workspace;
    if (actions == null || ws == null) return;
    final tasks = await actions.openTasks(ws);
    if (mounted) setState(() => _tasks = tasks);
  }

  TaskRef? get _task {
    final a = widget.agent;
    final tasks = _tasks;
    return a == null || tasks == null ? null : taskForAgent(tasks, a.ptyId);
  }

  /// Runs [write]; says [done] or why not, then reloads the tasks.
  Future<void> _run(Future<String?> Function(AgentActions a) write, String done) async {
    final actions = ref.read(agentActionsProvider);
    if (actions == null || _busy) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final error = await write(actions);
    if (!mounted) return;
    setState(() => _busy = false);
    messenger.showSnackBar(SnackBar(content: Text(error ?? done)));
    unawaited(_load());
  }

  /// The agent with its session id (full snapshots only), for Rename and Assign.
  Future<AgentSummary?> _fullAgent() async {
    final a = widget.agent;
    if (a == null) return null;
    if (a.sessionId != null) return a;
    final full = await ref.read(attentionProvider.notifier).fetchFullAgentSummary(a.ptyId);
    return full ?? a;
  }

  Future<void> _checkin() async {
    final a = widget.agent!;
    final actions = ref.read(agentActionsProvider);
    if (actions == null || _busy) return;
    setState(() => _busy = true);
    final messenger = ScaffoldMessenger.of(context);
    final result = await actions.checkin(a.ptyId);
    if (!mounted) return;
    setState(() => _busy = false);
    messenger.showSnackBar(SnackBar(
      content: Text(result == null
          ? 'Asked for a check-in'
          : result == 'proposed'
              ? 'Proposed on the Mac'
              : result),
    ));
  }

  Future<void> _rename() async {
    final ws = widget.workspace;
    if (ws == null) return;
    final task = _task;
    final current = task?.displayTitle ?? widget.agent?.label ?? '';
    final name = await showDialog<String>(
      context: context,
      builder: (dialog) => _RenameDialog(initial: current),
    );
    if (name == null || name.trim().isEmpty || !mounted) return;
    String? sessionId;
    if (task == null) {
      sessionId = (await _fullAgent())?.sessionId;
      if (!mounted) return;
      if (sessionId == null) {
        ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Rename it from the Mac for now')));
        return;
      }
    }
    await _run((a) => a.rename(ws, taskId: task?.id, sessionId: sessionId, name: name.trim()), 'Renamed');
  }

  Future<void> _accept() async {
    final ws = widget.workspace;
    final task = _task;
    if (ws == null || task == null) return;
    await _run((a) => a.accept(ws, task.id), 'Accepted');
  }

  Future<void> _assign() async {
    final ws = widget.workspace;
    final tasks = _tasks;
    if (ws == null || tasks == null) return;
    final free = freeTasks(tasks);
    final pick = await showModalBottomSheet<Object>(
      context: context,
      backgroundColor: AeronautColors.bgSurface,
      builder: (sheet) => SafeArea(
        child: ListView(
          shrinkWrap: true,
          padding: const EdgeInsets.all(AeronautTheme.spacingMd),
          children: [
            const Text('Assign to', style: AeronautTheme.headline),
            const SizedBox(height: AeronautTheme.spacingSm),
            if (free.isEmpty) const QuietText('No open task without an agent.'),
            for (final t in free)
              ListTile(
                key: ValueKey('assign-${t.id}'),
                contentPadding: EdgeInsets.zero,
                title: Text(t.displayTitle.isEmpty ? 'Untitled task' : t.displayTitle),
                onTap: () => Navigator.pop(sheet, t),
              ),
            const SizedBox(height: AeronautTheme.spacingSm),
            WorkButton(
              key: const ValueKey('assign-new'),
              label: 'New task from this agent',
              onPressed: () => Navigator.pop(sheet, 'new'),
            ),
          ],
        ),
      ),
    );
    if (pick == null || !mounted) return;
    final agent = await _fullAgent();
    if (agent == null || !mounted) return;
    if (pick is TaskRef) {
      await _run((a) => a.assign(ws, pick.id, agent), 'Assigned');
    } else {
      await _run((a) => a.newTask(ws, agent.label, agent), 'Task created');
    }
  }

  @override
  Widget build(BuildContext context) {
    final agent = widget.agent;
    if (ref.watch(agentActionsProvider) == null || widget.workspace == null) return const SizedBox.shrink();
    final task = _task;
    final buttons = <Widget>[
      if (agent != null)
        WorkButton(key: const ValueKey('agent-checkin'), label: 'Check in', kind: BtnKind.quiet, onPressed: _busy ? null : _checkin),
      if (agent != null || task != null)
        WorkButton(key: const ValueKey('agent-rename'), label: 'Rename', kind: BtnKind.quiet, onPressed: _busy ? null : _rename),
      if (task != null && task.inReview)
        WorkButton(key: const ValueKey('agent-accept'), label: 'Accept', kind: BtnKind.quiet, onPressed: _busy ? null : _accept),
      if (agent != null && _tasks != null && task == null)
        WorkButton(key: const ValueKey('agent-assign'), label: 'Assign…', kind: BtnKind.quiet, onPressed: _busy ? null : _assign),
    ];
    if (buttons.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: AeronautTheme.spacingSm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (task != null)
            Padding(
              padding: const EdgeInsets.only(bottom: 2),
              child: QuietText(task.inReview ? 'Task: ${task.displayTitle} · in review' : 'Task: ${task.displayTitle}'),
            ),
          Wrap(spacing: AeronautTheme.spacingSm, children: buttons),
        ],
      ),
    );
  }
}

class _RenameDialog extends StatefulWidget {
  final String initial;

  const _RenameDialog({required this.initial});

  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final _controller = TextEditingController(text: widget.initial);

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      backgroundColor: AeronautColors.bgSurface,
      title: const Text('Rename'),
      content: TextField(
        key: const ValueKey('agent-rename-field'),
        controller: _controller,
        autofocus: true,
        // A name you give it is your words: the writing face.
        style: writingStyle(size: 17),
        onSubmitted: (v) => Navigator.pop(context, v),
      ),
      actions: [
        TextButton(onPressed: () => Navigator.pop(context), child: const Text('Cancel')),
        TextButton(
          key: const ValueKey('agent-rename-save'),
          onPressed: () => Navigator.pop(context, _controller.text),
          child: const Text('Save'),
        ),
      ],
    );
  }
}
