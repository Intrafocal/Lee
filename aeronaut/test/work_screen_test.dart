import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/in_flight_section.dart';
import 'package:aeronaut/widgets/now_header_actions.dart';

/// Records capture/focus calls instead of making them, and lets a test set
/// the snapshot the widgets read.
class _RecordingAttentionNotifier extends AttentionNotifier {
  _RecordingAttentionNotifier(super.ref);

  final calls = <String>[];
  String? capturedText;
  bool? capturedAsExploration;

  /// What the next `capture()` call returns — tests override this to
  /// exercise the spooled/error feedback paths, not just success.
  CaptureResult captureResult = const CaptureResult(success: true);

  void setSnapshot(AttentionSnapshot snapshot) {
    state = AttentionUiState(snapshot: snapshot);
  }

  @override
  Future<CaptureResult> capture(String text, {String? workspace, bool asExploration = false}) async {
    calls.add('capture');
    capturedText = text;
    capturedAsExploration = asExploration;
    return captureResult;
  }

  @override
  Future<FocusState?> focusStart({FocusItem? item}) async {
    calls.add('focusStart');
    return null;
  }

  @override
  Future<FocusState?> focusStop() async {
    calls.add('focusStop');
    return null;
  }
}

Future<_RecordingAttentionNotifier> _pump(WidgetTester tester, {List<Widget> actions = const [], Widget? body}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        attentionProvider.overrideWith(_RecordingAttentionNotifier.new),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: Scaffold(
          appBar: AppBar(actions: actions),
          body: body ?? const SizedBox.shrink(),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  final container = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
  return container.read(attentionProvider.notifier) as _RecordingAttentionNotifier;
}

void main() {
  group('inFlightGroups', () {
    final now = DateTime.utc(2026, 9, 25, 15);
    AgentSummary agent(int id, AgentRunState state, {Duration? busyFor, Duration? idleFor}) => AgentSummary(
          ptyId: id,
          state: state,
          busySince: busyFor == null ? null : now.subtract(busyFor),
          idleSince: idleFor == null ? null : now.subtract(idleFor),
        );

    test('busy first (longest-running first), then waiting, then idle (latest first)', () {
      final groups = inFlightGroups([
        agent(1, AgentRunState.idle, idleFor: const Duration(minutes: 30)),
        agent(2, AgentRunState.waiting, busyFor: const Duration(minutes: 5)),
        agent(3, AgentRunState.busy, busyFor: const Duration(minutes: 2)),
        agent(4, AgentRunState.idle, idleFor: const Duration(minutes: 3)),
        agent(5, AgentRunState.busy, busyFor: const Duration(minutes: 20)),
        agent(6, AgentRunState.unknown),
      ], now);
      expect(groups.visible.map((a) => a.ptyId), [5, 3, 2, 4, 1, 6]);
      expect(groups.older, isEmpty);
    });

    test('idle agents finished over an hour ago fold away', () {
      final groups = inFlightGroups([
        agent(1, AgentRunState.idle, idleFor: const Duration(hours: 3)),
        agent(2, AgentRunState.idle, idleFor: const Duration(minutes: 10)),
        agent(3, AgentRunState.busy, busyFor: const Duration(hours: 2)),
      ], now);
      expect(groups.visible.map((a) => a.ptyId), [3, 2]);
      expect(groups.older.map((a) => a.ptyId), [1]);
    });

    test('shortDuration', () {
      expect(shortDuration(const Duration(seconds: 20)), '<1m');
      expect(shortDuration(const Duration(minutes: 12)), '12m');
      expect(shortDuration(const Duration(minutes: 65)), '1h 5m');
      expect(shortDuration(const Duration(hours: 2)), '2h');
      expect(shortDuration(const Duration(days: 3)), '3d');
    });
  });

  group('InFlightSection', () {
    testWidgets('shows agents in order and a tap opens the agent', (tester) async {
      final opened = <int>[];
      final notifier = await _pump(
        tester,
        body: SingleChildScrollView(child: InFlightSection(onOpenAgent: (a) => opened.add(a.ptyId))),
      );
      expect(find.text('No agents running.'), findsOneWidget);

      final now = DateTime.now();
      notifier.setSnapshot(AttentionSnapshot(
        items: [
          const AttentionItem(
            id: 'w1',
            kind: AttentionKind.approval,
            title: 'Claude wants to use Bash',
            source: AttentionSource(ptyId: 2),
          ),
        ],
        agents: [
          AgentSummary(ptyId: 1, tabId: 11, label: 'Idle one', state: AgentRunState.idle,
              idleSince: now.subtract(const Duration(minutes: 5)), lastSummary: 'All tests pass.'),
          const AgentSummary(ptyId: 2, tabId: 12, label: 'Waiting one', state: AgentRunState.waiting),
          AgentSummary(ptyId: 3, tabId: 13, label: 'Busy one', state: AgentRunState.busy,
              busySince: now.subtract(const Duration(minutes: 12)), lastTool: 'Edit'),
        ],
      ));
      await tester.pump();

      double y(String t) => tester.getTopLeft(find.text(t)).dy;
      expect(y('Busy one'), lessThan(y('Waiting one')));
      expect(y('Waiting one'), lessThan(y('Idle one')));
      expect(find.text('busy 12m'), findsOneWidget);
      expect(find.text('finished 5m ago'), findsOneWidget);
      expect(find.text('needs you'), findsOneWidget);
      expect(find.text('Claude wants to use Bash'), findsOneWidget, reason: 'waiting agent links its item');
      expect(find.text('All tests pass.'), findsOneWidget);

      await tester.tap(find.text('Busy one'));
      expect(opened, [3]);
    });
  });

  group('Now header', () {
    testWidgets('capture sheet sends the capture', (tester) async {
      final notifier = await _pump(tester, actions: const [CaptureButton()]);
      await tester.tap(find.byTooltip('Capture'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const ValueKey('capture-field')), '  try sqlite for the cache ');
      await tester.tap(find.byKey(const ValueKey('capture-exploration')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('capture-send')));
      await tester.pumpAndSettle();

      expect(notifier.calls, ['capture']);
      expect(notifier.capturedText, 'try sqlite for the cache');
      expect(notifier.capturedAsExploration, isTrue);
      expect(find.byKey(const ValueKey('capture-field')), findsNothing, reason: 'sheet closes');
      expect(find.text('Captured'), findsOneWidget);
    });

    testWidgets('capture sheet shows the spooled message and still closes', (tester) async {
      final notifier = await _pump(tester, actions: const [CaptureButton()]);
      notifier.captureResult = const CaptureResult(success: true, spooled: true);
      await tester.tap(find.byTooltip('Capture'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const ValueKey('capture-field')), 'try sqlite for the cache');
      await tester.tap(find.byKey(const ValueKey('capture-send')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('capture-field')),
        findsNothing,
        reason: 'sheet closes on spooled success too — Lee accepted the capture',
      );
      expect(find.text('Saved; will sync when Hester is back'), findsOneWidget);
    });

    testWidgets('capture sheet keeps the sheet and text on error so nothing is lost', (tester) async {
      final notifier = await _pump(tester, actions: const [CaptureButton()]);
      notifier.captureResult = const CaptureResult(success: false, error: 'HTTP 500');
      await tester.tap(find.byTooltip('Capture'));
      await tester.pumpAndSettle();

      await tester.enterText(find.byKey(const ValueKey('capture-field')), 'try sqlite for the cache');
      await tester.tap(find.byKey(const ValueKey('capture-send')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const ValueKey('capture-field')),
        findsOneWidget,
        reason: 'sheet stays open on failure so the idea is not lost',
      );
      expect(find.text('try sqlite for the cache'), findsOneWidget, reason: 'entered text is preserved');
      expect(find.text('HTTP 500'), findsOneWidget);
    });

    testWidgets('focus menu starts and stops focus', (tester) async {
      final notifier = await _pump(tester, actions: const [FocusMenuButton()]);

      await tester.tap(find.byTooltip('Focus off'));
      await tester.pumpAndSettle();
      expect(find.text('Stop focus'), findsNothing);
      await tester.tap(find.text('Start focus'));
      await tester.pumpAndSettle();
      expect(notifier.calls, ['focusStart']);

      notifier.setSnapshot(AttentionSnapshot(
        focus: FocusState(active: true, item: FocusItem.workspace('/ws/api'), quietCount: 2),
      ));
      await tester.pump();
      expect(find.text('2'), findsOneWidget, reason: 'held-back count on the icon');

      await tester.tap(find.byTooltip('Focus on · api'));
      await tester.pumpAndSettle();
      expect(find.text('Stop and hand off…'), findsOneWidget);
      await tester.tap(find.text('Stop focus'));
      await tester.pumpAndSettle();
      expect(notifier.calls, ['focusStart', 'focusStop']);
    });
  });
}
