import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/attention.dart';
import '../models/hester_models.dart';
import '../models/machine.dart';
import '../providers/machines_provider.dart';
import 'copilot_api.dart';
import 'hester_api.dart';

/// The one-agent screen's actions (Desk D2 §9.4; the Mac's Work detail):
/// Check in through Lee main's `/command` tab domain, and Rename / Accept /
/// Assign through Hester's task routes. Each write returns null on success,
/// else a sentence to show.
abstract class AgentActions {
  /// Open tasks in [workspace]; null when Hester can't be reached.
  Future<List<TaskRef>?> openTasks(String workspace);

  /// Null when asked; 'proposed' when Lee asks at the desk instead.
  Future<String?> checkin(int ptyId);
  Future<String?> rename(String workspace, {String? taskId, String? sessionId, required String name});
  Future<String?> accept(String workspace, String taskId);
  Future<String?> assign(String workspace, String taskId, AgentSummary agent);
  Future<String?> newTask(String workspace, String title, AgentSummary agent);
}

class LiveAgentActions implements AgentActions {
  final Machine machine;

  LiveAgentActions(this.machine);

  Future<T> _hester<T>(Future<T> Function(HesterApi api) run) async {
    final api = HesterApi(machine: machine);
    try {
      return await run(api);
    } finally {
      api.dispose();
    }
  }

  @override
  Future<List<TaskRef>?> openTasks(String workspace) => _hester((api) => api.getOpenTasks(workspace: workspace));

  @override
  Future<String?> checkin(int ptyId) async {
    final api = CopilotApi(machine: machine);
    try {
      final result = await api.agentCheckin(ptyId);
      return result.success ? result.error : (result.error ?? 'Check-in failed');
    } finally {
      api.dispose();
    }
  }

  @override
  Future<String?> rename(String workspace, {String? taskId, String? sessionId, required String name}) =>
      _hester((api) => api.renameTask(workspace: workspace, taskId: taskId, sessionId: sessionId, name: name));

  @override
  Future<String?> accept(String workspace, String taskId) =>
      _hester((api) => api.acceptTask(workspace: workspace, taskId: taskId));

  @override
  Future<String?> assign(String workspace, String taskId, AgentSummary agent) => _hester((api) => api.linkTask(
        workspace: workspace,
        taskId: taskId,
        ptyId: agent.ptyId,
        sessionId: agent.sessionId,
        provider: agent.provider,
        tabLabel: agent.label,
      ));

  @override
  Future<String?> newTask(String workspace, String title, AgentSummary agent) => _hester((api) => api.createTaskForAgent(
        workspace: workspace,
        title: title,
        ptyId: agent.ptyId,
        sessionId: agent.sessionId,
        provider: agent.provider,
        tabLabel: agent.label,
      ));
}

/// The active machine's actions; null with no machine. Tests override it.
final agentActionsProvider = Provider<AgentActions?>((ref) {
  final machine = ref.watch(machinesProvider.select((s) => s.activeMachine));
  return machine == null ? null : LiveAgentActions(machine);
});

/// The task [ptyId] works on, if any.
TaskRef? taskForAgent(List<TaskRef> tasks, int ptyId) {
  for (final t in tasks) {
    if (t.agentPtyId == ptyId) return t;
  }
  return null;
}

/// Open tasks an agent could be assigned to: those with no agent running.
List<TaskRef> freeTasks(List<TaskRef> tasks) => tasks.where((t) => t.agentPtyId == null).toList();
