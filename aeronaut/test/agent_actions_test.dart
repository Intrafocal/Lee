import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/hester_models.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/services/agent_actions.dart';
import 'package:aeronaut/services/copilot_api.dart';
import 'package:aeronaut/services/hester_api.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/agent_actions_row.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't', hesterPort: 9000);

/// Records every action; serves [tasks].
class _FakeActions implements AgentActions {
  List<TaskRef>? tasks;
  final calls = <String>[];
  String? checkinResult;

  _FakeActions(this.tasks);

  @override
  Future<List<TaskRef>?> openTasks(String workspace) async => tasks;

  @override
  Future<String?> checkin(int ptyId) async {
    calls.add('checkin:$ptyId');
    return checkinResult;
  }

  @override
  Future<String?> rename(String workspace, {String? taskId, String? sessionId, required String name}) async {
    calls.add('rename:${taskId ?? 'session:$sessionId'}:$name');
    return null;
  }

  @override
  Future<String?> accept(String workspace, String taskId) async {
    calls.add('accept:$taskId');
    return null;
  }

  @override
  Future<String?> assign(String workspace, String taskId, AgentSummary agent) async {
    calls.add('assign:$taskId:${agent.sessionId}');
    return null;
  }

  @override
  Future<String?> newTask(String workspace, String title, AgentSummary agent) async {
    calls.add('new:$title:${agent.sessionId}');
    return null;
  }
}

/// The full snapshot's agent carries its session id.
class _FakeAttention extends AttentionNotifier {
  _FakeAttention(super.ref);

  @override
  Future<AgentSummary?> fetchFullAgentSummary(int ptyId) async =>
      AgentSummary(ptyId: ptyId, label: 'Claude: api', workspace: '/ws/api', sessionId: 'sess-7');

  @override
  Future<void> refresh() async {}
}

const _agent = AgentSummary(ptyId: 7, label: 'Claude: api', workspace: '/ws/api', state: AgentRunState.idle);

Future<void> _pump(WidgetTester tester, _FakeActions actions) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        agentActionsProvider.overrideWithValue(actions),
        attentionProvider.overrideWith(_FakeAttention.new),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: const Scaffold(body: AgentActionsRow(agent: _agent, workspace: '/ws/api')),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  test('TaskRef, taskForAgent, freeTasks', () {
    final tasks = [
      TaskRef.fromJson({'id': 't1', 'title': 'Fix login', 'name': 'login', 'status': 'review', 'agent': {'pty_id': 7}}),
      TaskRef.fromJson({'id': 't2', 'title': 'Docs', 'status': 'queued', 'agent': null}),
    ];
    expect(tasks[0].displayTitle, 'login');
    expect(tasks[0].inReview, isTrue);
    expect(taskForAgent(tasks, 7)!.id, 't1');
    expect(taskForAgent(tasks, 8), isNull);
    expect(freeTasks(tasks).map((t) => t.id), ['t2']);
  });

  testWidgets('a task in review: Check in, Rename and Accept; no Assign', (tester) async {
    final actions = _FakeActions([const TaskRef(id: 't1', title: 'Fix login', status: 'review', agentPtyId: 7)]);
    await _pump(tester, actions);
    expect(find.text('Task: Fix login · in review'), findsOneWidget);
    expect(find.byKey(const ValueKey('agent-assign')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('agent-accept')));
    await tester.pumpAndSettle();
    expect(actions.calls, ['accept:t1']);
    expect(find.text('Accepted'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('agent-rename')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('agent-rename-field')), 'Login redirect');
    await tester.tap(find.byKey(const ValueKey('agent-rename-save')));
    await tester.pumpAndSettle();
    expect(actions.calls.last, 'rename:t1:Login redirect');
  });

  testWidgets('an agent with no task: Assign… to an open task or a new one; rename by session', (tester) async {
    final actions = _FakeActions([const TaskRef(id: 't2', title: 'Docs', status: 'queued')]);
    await _pump(tester, actions);
    expect(find.byKey(const ValueKey('agent-accept')), findsNothing);

    await tester.tap(find.byKey(const ValueKey('agent-assign')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('assign-t2')));
    await tester.pumpAndSettle();
    expect(actions.calls, ['assign:t2:sess-7']);

    await tester.tap(find.byKey(const ValueKey('agent-assign')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('assign-new')));
    await tester.pumpAndSettle();
    expect(actions.calls.last, 'new:Claude: api:sess-7');

    await tester.tap(find.byKey(const ValueKey('agent-rename')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('agent-rename-field')), 'API');
    await tester.tap(find.byKey(const ValueKey('agent-rename-save')));
    await tester.pumpAndSettle();
    expect(actions.calls.last, 'rename:session:sess-7:API');
  });

  testWidgets('Check in says when Lee only proposed it', (tester) async {
    final actions = _FakeActions(const [])..checkinResult = 'proposed';
    await _pump(tester, actions);
    await tester.tap(find.byKey(const ValueKey('agent-checkin')));
    await tester.pumpAndSettle();
    expect(actions.calls, ['checkin:7']);
    expect(find.text('Proposed on the Mac'), findsOneWidget);
  });

  group('wire shapes', () {
    test('HesterApi task routes', () async {
      final requests = <http.Request>[];
      final client = MockClient((r) async {
        requests.add(r);
        if (r.method == 'GET') {
          return http.Response(jsonEncode({'success': true, 'data': [{'id': 't1', 'title': 'A', 'status': 'running', 'agent': {'pty_id': 3}}]}), 200);
        }
        return http.Response(jsonEncode({'success': true, 'data': {}}), 200);
      });
      final api = HesterApi(machine: _machine, client: client);
      final tasks = await api.getOpenTasks(workspace: '/ws/api');
      expect(tasks!.single.agentPtyId, 3);
      expect(requests.last.url.queryParameters, {'workspace': '/ws/api', 'status': 'open'});

      expect(await api.renameTask(workspace: '/ws/api', sessionId: 's1', name: 'N'), isNull);
      expect(requests.last.url.path, '/cockpit/tasks/name');
      expect(jsonDecode(requests.last.body), {'workspace': '/ws/api', 'session_id': 's1', 'name': 'N', 'source': 'user'});

      await api.acceptTask(workspace: '/ws/api', taskId: 't1');
      expect(requests.last.url.path, '/cockpit/tasks/t1/close');
      expect(jsonDecode(requests.last.body), {'workspace': '/ws/api', 'status': 'done', 'accepted': true});

      await api.linkTask(workspace: '/ws/api', taskId: 't1', ptyId: 3, sessionId: 's1', provider: 'claude', tabLabel: 'Claude');
      expect(requests.last.url.path, '/cockpit/tasks/t1/link');
      expect(jsonDecode(requests.last.body)['pty_id'], 3);

      await api.createTaskForAgent(workspace: '/ws/api', title: 'Claude', ptyId: 3, provider: 'claude', tabLabel: 'Claude');
      final created = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(requests.last.url.path, '/cockpit/tasks');
      expect(created['agent'], {'provider': 'claude', 'pty_id': 3, 'session_id': null, 'tab_label': 'Claude'});
      expect(created['origin'], {'kind': 'agent'});
    });

    test('CopilotApi.agentCheckin: the tab domain; 202 is proposed', () async {
      var status = 200;
      late Map<String, dynamic> body;
      final client = MockClient((r) async {
        expect(r.url.path, '/command');
        body = jsonDecode(r.body) as Map<String, dynamic>;
        return http.Response(jsonEncode({'success': true}), status);
      });
      final api = CopilotApi(machine: _machine, client: client);
      final ok = await api.agentCheckin(7);
      expect(ok.success, isTrue);
      expect(ok.error, isNull);
      expect(body, {'domain': 'tab', 'action': 'checkin', 'params': {'pty_id': 7}});
      status = 202;
      final proposed = await api.agentCheckin(7);
      expect(proposed.success, isTrue);
      expect(proposed.error, 'proposed');
    });
  });
}
