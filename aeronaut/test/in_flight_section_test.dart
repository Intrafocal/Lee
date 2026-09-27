import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/in_flight_section.dart';
import 'package:aeronaut/widgets/work_ui.dart';

Future<void> _pumpRow(WidgetTester tester, AgentSummary agent, {AttentionItem? item, DateTime? now}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AeronautTheme.darkTheme,
      home: Scaffold(
        body: AgentRow(agent: agent, now: now ?? DateTime.now(), waitingItem: item),
      ),
    ),
  );
}

void main() {
  final now = DateTime.utc(2026, 9, 27, 15);

  group('agentSubLine (the "doing now" line)', () {
    test('busy: what it is doing now, else its last tool, else Working', () {
      expect(
        agentSubLine(const AgentSummary(
          ptyId: 1,
          state: AgentRunState.busy,
          now: AgentNow(tool: 'Bash', preview: 'cd electron && npm test'),
        )),
        'Running tests',
      );
      expect(agentSubLine(const AgentSummary(ptyId: 1, state: AgentRunState.busy, lastTool: 'Read')), 'Reading');
      expect(agentSubLine(const AgentSummary(ptyId: 1, state: AgentRunState.busy)), 'Working');
    });

    test('waiting names the item; idle reads as done', () {
      const item = AttentionItem(id: 'a', title: 'Claude wants to use Bash');
      expect(agentSubLine(const AgentSummary(ptyId: 1, state: AgentRunState.waiting), waitingItem: item),
          'needs you · Claude wants to use Bash');
      expect(agentSubLine(const AgentSummary(ptyId: 1, state: AgentRunState.waiting)), 'needs you');
      expect(agentSubLine(AgentSummary(ptyId: 1, state: AgentRunState.idle, idleSince: now)), 'done · ready to review');
      expect(agentSubLine(const AgentSummary(ptyId: 1)), 'idle');
    });
  });

  test('agentMeta: elapsed, then tokens', () {
    final busy = AgentSummary(
      ptyId: 1,
      state: AgentRunState.busy,
      busySince: now.subtract(const Duration(minutes: 12)),
      usage: const AgentUsage(shownTokens: 412000),
    );
    expect(agentMeta(busy, now), '12m · 412k tok');
    expect(agentMeta(const AgentSummary(ptyId: 2, usage: AgentUsage(shownTokens: 0)), now), '');
  });

  testWidgets('AgentRow shows the dot, name, sub-line and meta', (tester) async {
    await _pumpRow(
      tester,
      AgentSummary(
        ptyId: 3,
        label: 'Claude: api',
        state: AgentRunState.busy,
        busySince: now.subtract(const Duration(minutes: 5)),
        now: const AgentNow(tool: 'Edit', files: ['/r/lib/main.dart']),
        usage: const AgentUsage(shownTokens: 1500000),
      ),
      now: now,
    );
    expect(find.text('Claude: api'), findsOneWidget);
    expect(find.text('Editing main.dart'), findsOneWidget);
    expect(find.text('5m · 1.5M tok'), findsOneWidget);
    expect(find.byKey(const ValueKey('dot-working')), findsOneWidget);
    expect(find.byType(WorkDot), findsOneWidget);
  });

  testWidgets('a waiting agent gets the needs-you dot', (tester) async {
    await _pumpRow(tester, const AgentSummary(ptyId: 4, label: 'Claude: web', state: AgentRunState.waiting));
    expect(find.byKey(const ValueKey('dot-needs')), findsOneWidget);
    expect(find.text('needs you'), findsOneWidget);
  });
}
