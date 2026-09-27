import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/screens/work_screen.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/theme/phosphor_icons.generated.dart';
import 'package:aeronaut/theme/phosphor_tokens.dart';
import 'package:aeronaut/widgets/in_flight_section.dart';
import 'package:aeronaut/widgets/now_header_actions.dart';
import 'package:aeronaut/widgets/phosphor_icon.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

/// [_machine] as the active machine, without SharedPreferences or health pings.
class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

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

    test('idle agents finished over two hours ago fold away', () {
      final groups = inFlightGroups([
        agent(1, AgentRunState.idle, idleFor: const Duration(hours: 3)),
        agent(2, AgentRunState.idle, idleFor: const Duration(minutes: 90)),
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
              busySince: now.subtract(const Duration(minutes: 12)), lastTool: 'Edit',
              now: const AgentNow(tool: 'Edit', files: ['/repo/src/main.ts']),
              usage: const AgentUsage(shownTokens: 412000)),
        ],
      ));
      await tester.pump();

      double y(String t) => tester.getTopLeft(find.text(t)).dy;
      expect(y('Busy one'), lessThan(y('Waiting one')));
      expect(y('Waiting one'), lessThan(y('Idle one')));
      expect(find.text('Editing main.ts'), findsOneWidget, reason: 'the doing-now line');
      expect(find.text('12m · 412k tok'), findsOneWidget);
      expect(find.text('needs you · Claude wants to use Bash'), findsOneWidget, reason: 'waiting agent names its item');
      expect(find.text('done · ready to review'), findsOneWidget);
      expect(find.text('IN FLIGHT'), findsOneWidget);

      await tester.tap(find.text('Busy one'));
      expect(opened, [3]);
    });

    testWidgets('idle agents over two hours fold into "n earlier today"', (tester) async {
      final notifier = await _pump(
        tester,
        body: const SingleChildScrollView(child: InFlightSection()),
      );
      final now = DateTime.now();
      notifier.setSnapshot(AttentionSnapshot(agents: [
        AgentSummary(ptyId: 1, label: 'Old one', state: AgentRunState.idle,
            idleSince: now.subtract(const Duration(hours: 3))),
        AgentSummary(ptyId: 2, label: 'Recent one', state: AgentRunState.idle,
            idleSince: now.subtract(const Duration(minutes: 3))),
      ]));
      await tester.pump();
      expect(find.text('Old one'), findsNothing);
      expect(find.text('1 earlier today'), findsOneWidget);
      await tester.tap(find.text('1 earlier today'));
      await tester.pump();
      expect(find.text('Old one'), findsOneWidget);
    });
  });

  group('Work', () {
    test('waitingOnYou counts needs-you items, not ambient ones or summaries', () {
      const snap = AttentionSnapshot(items: [
        AttentionItem(id: 'a', severity: AttentionSeverity.blocking),
        AttentionItem(id: 'b', severity: AttentionSeverity.needsYou, state: AttentionItemState.snoozed),
        AttentionItem(id: 'c', severity: AttentionSeverity.ambient),
        AttentionItem(id: 'd', severity: AttentionSeverity.needsYou, kind: AttentionKind.summary),
        AttentionItem(id: 'e', severity: AttentionSeverity.needsYou, state: AttentionItemState.resolved),
      ]);
      expect(waitingOnYou(snap).map((i) => i.id), ['a', 'b']);
    });

    testWidgets('headline, raised first card, and In deep work instead of Focus', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
            attentionProvider.overrideWith(_RecordingAttentionNotifier.new),
          ],
          child: MaterialApp(theme: AeronautTheme.darkTheme, home: const WorkScreen()),
        ),
      );
      await tester.pump();
      final container = ProviderScope.containerOf(tester.element(find.byType(WorkScreen)));
      final notifier = container.read(attentionProvider.notifier) as _RecordingAttentionNotifier;
      notifier.setSnapshot(const AttentionSnapshot());
      await tester.pump();
      expect(find.text('All clear.'), findsOneWidget);
      expect(find.byTooltip('Focus off'), findsOneWidget);
      expect(find.byKey(const ValueKey('in-deep-work')), findsNothing);

      notifier.setSnapshot(const AttentionSnapshot(
        deep: DeepSession(explorationId: 'exp_1', title: 'Caching'),
        items: [
          AttentionItem(
            id: 'x',
            kind: AttentionKind.approval,
            severity: AttentionSeverity.blocking,
            title: 'Run npm test?',
            activeWaitMs: 5000,
            actions: [AttentionActionName.approve, AttentionActionName.deny],
          ),
          AttentionItem(
            id: 'y',
            kind: AttentionKind.approval,
            severity: AttentionSeverity.needsYou,
            title: 'Run ls?',
            actions: [AttentionActionName.approve, AttentionActionName.deny],
          ),
        ],
        agents: [AgentSummary(ptyId: 9, state: AgentRunState.busy)],
      ));
      await tester.pump();
      expect(find.text('Two things need you.'), findsOneWidget);
      expect(find.text('2 waiting on you · 1 working'), findsOneWidget);
      expect(find.text('In deep work'), findsOneWidget);
      expect(find.byTooltip('Focus off'), findsNothing, reason: 'devices show In deep work instead of Focus');

      Color allowFill(String itemId) => tester
          .widget<Material>(find
              .descendant(
                of: find.descendant(
                  of: find.byKey(ValueKey('waiting-$itemId')),
                  matching: find.byKey(const ValueKey('attention-allow')),
                ),
                matching: find.byType(Material),
              )
              .first)
          .color!;
      expect(allowFill('x'), Phosphor.phosphor, reason: 'the raised first card holds the one phosphor control');
      expect(allowFill('y'), isNot(Phosphor.phosphor));
    });

    testWidgets('ambient items and summaries stay out of Waiting on you', (tester) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
            attentionProvider.overrideWith(_RecordingAttentionNotifier.new),
          ],
          child: MaterialApp(theme: AeronautTheme.darkTheme, home: const WorkScreen()),
        ),
      );
      await tester.pump();
      final container = ProviderScope.containerOf(tester.element(find.byType(WorkScreen)));
      final notifier = container.read(attentionProvider.notifier) as _RecordingAttentionNotifier;

      notifier.setSnapshot(const AttentionSnapshot(items: [
        AttentionItem(id: 'amb', kind: AttentionKind.summary, severity: AttentionSeverity.ambient, title: 'Claude finished a turn'),
      ]));
      await tester.pump();
      expect(find.text('All clear.'), findsOneWidget);
      expect(find.text('WAITING ON YOU'), findsNothing);
      expect(find.byKey(const ValueKey('waiting-amb')), findsNothing);

      notifier.setSnapshot(const AttentionSnapshot(items: [
        AttentionItem(id: 'amb', kind: AttentionKind.summary, severity: AttentionSeverity.ambient, title: 'Claude finished a turn'),
        AttentionItem(id: 'sum', kind: AttentionKind.summary, severity: AttentionSeverity.needsYou, title: 'A summary'),
        AttentionItem(
          id: 'q',
          kind: AttentionKind.question,
          severity: AttentionSeverity.needsYou,
          title: 'Which table?',
          actions: [AttentionActionName.reply],
        ),
      ]));
      await tester.pump();
      expect(find.text('One thing needs you.'), findsOneWidget);
      expect(find.byKey(const ValueKey('waiting-q')), findsOneWidget);
      expect(find.byKey(const ValueKey('waiting-amb')), findsNothing);
      expect(find.byKey(const ValueKey('waiting-sum')), findsNothing);
    });
  });

  group('Work header', () {
    testWidgets('capture sheet sends the capture', (tester) async {
      final notifier = await _pump(tester, actions: const [CaptureButton()]);
      expect(find.byType(PhosphorIcon), findsOneWidget);
      expect(tester.widget<PhosphorIcon>(find.byType(PhosphorIcon)).icon, PhosphorIcons.plus,
          reason: "Capture is the header's + button");
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
