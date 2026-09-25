import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/in_flight_section.dart';

/// Records [fetchFullAgentSummary] calls and serves canned data instead of
/// hitting the network — same pattern as `attention_tile_test.dart`'s
/// `_RecordingAttentionNotifier`.
class _RecordingAttentionNotifier extends AttentionNotifier {
  _RecordingAttentionNotifier(super.ref);

  int fetchFullAgentSummaryCalls = 0;
  AgentSummary? Function(int ptyId)? onFetch;

  @override
  Future<AgentSummary?> fetchFullAgentSummary(int ptyId) async {
    fetchFullAgentSummaryCalls++;
    return onFetch?.call(ptyId);
  }
}

// [AgentRow] only reads `attentionProvider` lazily, inside the expand
// handler — never during build — so the override factory below won't run
// just from pumping the widget. Force it into existence afterwards via the
// element's own provider container, instead of relying on the factory
// closure to have fired.
Future<_RecordingAttentionNotifier> _pumpRow(WidgetTester tester, AgentSummary agent) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        attentionProvider.overrideWith((ref) => _RecordingAttentionNotifier(ref)),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: Scaffold(
          body: AgentRow(agent: agent, now: DateTime.now()),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final context = tester.element(find.byType(AgentRow));
  return ProviderScope.containerOf(context).read(attentionProvider.notifier) as _RecordingAttentionNotifier;
}

void main() {
  group('AgentRow summary expand (In-flight full summary)', () {
    final clippedSummary = '${'a' * 279}…'; // 280 chars, looks clipped

    testWidgets('a clipped summary is expanded and replaced by the full one on tap', (tester) async {
      final agent = AgentSummary(ptyId: 3, label: 'Claude: api', lastSummary: clippedSummary);
      final notifier = await _pumpRow(tester, agent);
      notifier.onFetch = (ptyId) => AgentSummary(
            ptyId: ptyId,
            lastSummary: 'the real, full unclipped summary text',
          );

      await tester.tap(find.text(clippedSummary));
      await tester.pumpAndSettle();

      expect(notifier.fetchFullAgentSummaryCalls, 1);
      expect(find.text('the real, full unclipped summary text'), findsOneWidget);
      expect(find.text(clippedSummary), findsNothing);
    });

    testWidgets('a short summary never triggers a full-snapshot fetch', (tester) async {
      const agent = AgentSummary(ptyId: 4, label: 'Claude: web', lastSummary: 'short and sweet');
      final notifier = await _pumpRow(tester, agent);
      notifier.onFetch = (ptyId) => const AgentSummary(ptyId: 4, lastSummary: 'should never be requested');

      await tester.tap(find.text('short and sweet'));
      await tester.pumpAndSettle();

      expect(notifier.fetchFullAgentSummaryCalls, 0);
      expect(find.text('short and sweet'), findsOneWidget);
    });

    testWidgets('collapsing and re-expanding reuses the already-fetched summary', (tester) async {
      final agent = AgentSummary(ptyId: 5, label: 'Claude: worker', lastSummary: clippedSummary);
      final notifier = await _pumpRow(tester, agent);
      notifier.onFetch = (ptyId) => AgentSummary(ptyId: ptyId, lastSummary: 'full summary once');

      await tester.tap(find.text(clippedSummary)); // expand
      await tester.pumpAndSettle();
      expect(notifier.fetchFullAgentSummaryCalls, 1);
      expect(find.text('full summary once'), findsOneWidget);

      await tester.tap(find.text('full summary once')); // collapse
      await tester.pumpAndSettle();
      expect(find.text(clippedSummary), findsOneWidget);

      await tester.tap(find.text(clippedSummary)); // re-expand
      await tester.pumpAndSettle();
      expect(find.text('full summary once'), findsOneWidget);
      expect(notifier.fetchFullAgentSummaryCalls, 1, reason: 'reused the already-fetched summary');
    });

    testWidgets('when the full summary is not available, the clipped one keeps showing', (tester) async {
      final agent = AgentSummary(ptyId: 6, label: 'Claude: db', lastSummary: clippedSummary);
      final notifier = await _pumpRow(tester, agent);
      notifier.onFetch = (ptyId) => null; // e.g. the full snapshot didn't have this agent any more

      await tester.tap(find.text(clippedSummary));
      await tester.pumpAndSettle();

      expect(find.text(clippedSummary), findsOneWidget);
    });
  });
}
