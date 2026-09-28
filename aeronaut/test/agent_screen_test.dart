import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/screens/agent_screen.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/theme/phosphor_tokens.dart';
import 'package:aeronaut/widgets/attention_tile.dart';

class _Reply {
  final String itemId;
  final String action;
  final String? text;
  final int version;

  _Reply(this.itemId, this.action, this.text, this.version);
}

/// Serves a fixed snapshot and records replies instead of sending them.
class _FakeAttentionNotifier extends AttentionNotifier {
  _FakeAttentionNotifier(super.ref, AttentionSnapshot snapshot) {
    state = AttentionUiState(snapshot: snapshot);
  }

  final replies = <_Reply>[];
  int fullSummaryFetches = 0;
  String? fullSummary;
  String? fullItemText;

  void setSnapshot(AttentionSnapshot snapshot) => state = AttentionUiState(snapshot: snapshot);

  @override
  Future<AttentionItem?> fetchFullItem(AttentionItem item) async {
    final text = fullItemText;
    return text == null
        ? null
        : AttentionItem(id: item.id, version: item.version, kind: item.kind, text: text, source: item.source, actions: item.actions);
  }

  @override
  Future<ActionResult> reply(String itemId, {required String action, String? text, int? choice, required int version, bool voice = false}) async {
    replies.add(_Reply(itemId, action, text, version));
    return const ActionResult(success: true);
  }

  @override
  Future<AgentSummary?> fetchFullAgentSummary(int ptyId) async {
    fullSummaryFetches++;
    return fullSummary == null ? null : AgentSummary(ptyId: ptyId, lastSummary: fullSummary);
  }
}

Future<_FakeAttentionNotifier> _pump(WidgetTester tester, AttentionSnapshot snapshot, {int? ptyId, String? itemId}) async {
  late _FakeAttentionNotifier notifier;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        attentionProvider.overrideWith((ref) => notifier = _FakeAttentionNotifier(ref, snapshot)),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: AgentScreen(ptyId: ptyId, itemId: itemId),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return notifier;
}

final _busySince = DateTime.now().subtract(const Duration(minutes: 18));

AgentSummary _agent({String? lastSummary, List<AgentActivity> recent = const [], List<AgentUpdate> updates = const []}) =>
    AgentSummary(
      ptyId: 7,
      tabId: 70,
      label: 'Claude: api',
      workspace: '/ws/api',
      state: AgentRunState.waiting,
      busySince: _busySince,
      lastSummary: lastSummary,
      recent: recent,
      updates: updates,
      usage: const AgentUsage(shownTokens: 412000),
    );

const _waitingItem = AttentionItem(
  id: 'att_1',
  version: 4,
  kind: AttentionKind.waiting,
  severity: AttentionSeverity.needsYou,
  title: 'Claude is waiting for you',
  text: 'Should I **also** migrate the old table?',
  source: AttentionSource(ptyId: 7),
  actions: [AttentionActionName.reply, AttentionActionName.dismiss],
);

void main() {
  testWidgets('It asked as prose, the 2x2 quick replies, usage in the meta line', (tester) async {
    final notifier = await _pump(
      tester,
      AttentionSnapshot(items: const [_waitingItem], agents: [_agent()]),
      ptyId: 7,
    );

    expect(find.text('Claude: api'), findsOneWidget);
    expect(find.textContaining('412k tokens'), findsOneWidget, reason: 'subscription usage as tokens only');
    expect(find.text('IT ASKED'), findsOneWidget);
    expect(find.textContaining('migrate the old table', findRichText: true), findsOneWidget);

    // Four replies, 48px, in two rows of two.
    for (final chip in quickReplyChips) {
      expect(find.text(chip), findsOneWidget);
    }
    Rect box(String t) => tester.getRect(find.ancestor(of: find.text(t), matching: find.byType(SizedBox)).first);
    expect(box(quickReplyChips[0]).height, 48);
    expect(box(quickReplyChips[0]).top, box(quickReplyChips[1]).top);
    expect(box(quickReplyChips[2]).top, box(quickReplyChips[3]).top);
    expect(box(quickReplyChips[2]).top, greaterThan(box(quickReplyChips[0]).top));

    await tester.tap(find.text('Explain first'));
    await tester.pumpAndSettle();
    expect(notifier.replies.single.itemId, 'att_1');
    expect(notifier.replies.single.action, 'text');
    expect(notifier.replies.single.text, 'Explain first');
    expect(notifier.replies.single.version, 4);
  });

  testWidgets('the reply bar sends through the item, with a round phosphor Send', (tester) async {
    final notifier = await _pump(
      tester,
      AttentionSnapshot(items: const [_waitingItem], agents: [_agent()]),
      ptyId: 7,
    );
    final send = find.byKey(const ValueKey('agent-send'));
    final material = tester.widget<Material>(find.ancestor(of: send, matching: find.byType(Material)).first);
    expect(material.color, Phosphor.phosphor);
    expect(material.shape, isA<CircleBorder>());

    await tester.enterText(find.byKey(const ValueKey('agent-reply-field')), '  use the new column  ');
    await tester.tap(send);
    await tester.pumpAndSettle();
    expect(notifier.replies.single.text, 'use the new column');
  });

  testWidgets('no open item: the reply bar is disabled with "Reply from the Mac for now"', (tester) async {
    final notifier = await _pump(
      tester,
      AttentionSnapshot(agents: [_agent(lastSummary: 'All tests pass.')]),
      ptyId: 7,
    );
    expect(find.text('IT SAID'), findsOneWidget);
    expect(find.textContaining('All tests pass.', findRichText: true), findsOneWidget);
    expect(find.text('Reply from the Mac for now'), findsOneWidget);
    final field = tester.widget<TextField>(find.byKey(const ValueKey('agent-reply-field')));
    expect(field.enabled, isFalse);

    await tester.tap(find.text('Yes, go ahead'));
    await tester.tap(find.byKey(const ValueKey('agent-send')));
    await tester.pumpAndSettle();
    expect(notifier.replies, isEmpty);
  });

  testWidgets('an approval shows the command and Allow/Deny; Allow takes the phosphor', (tester) async {
    const approval = AttentionItem(
      id: 'att_2',
      version: 9,
      kind: AttentionKind.approval,
      severity: AttentionSeverity.blocking,
      title: 'Claude wants to run a command',
      source: AttentionSource(ptyId: 7),
      tool: ToolPreview(name: 'Bash', preview: 'rm -rf build', signature: 's'),
      actions: [AttentionActionName.approve, AttentionActionName.deny, AttentionActionName.reply],
    );
    final notifier = await _pump(tester, AttentionSnapshot(items: const [approval], agents: [_agent()]), ptyId: 7);
    expect(find.text('rm -rf build'), findsOneWidget);
    expect(tester.getSize(find.byKey(const ValueKey('agent-allow'))).height, 48);
    final send = tester.widget<Material>(
      find.ancestor(of: find.byKey(const ValueKey('agent-send')), matching: find.byType(Material)).first,
    );
    expect(send.color, isNot(Phosphor.phosphor), reason: 'one phosphor control per view');

    await tester.tap(find.byKey(const ValueKey('agent-allow')));
    await tester.pumpAndSettle();
    expect(notifier.replies.single.action, 'approve');
    expect(notifier.replies.single.version, 9);
  });

  testWidgets('Updates and a folded Along the way', (tester) async {
    await _pump(
      tester,
      AttentionSnapshot(agents: [
        _agent(
          recent: const [
            AgentActivity(tool: 'Read', files: ['/r/a.ts'], phase: 'post'),
            AgentActivity(tool: 'Bash', preview: 'cd x && npm test', phase: 'post', failed: true),
          ],
          updates: const [
            AgentUpdate(summary: 'Renamed the table.', leeStatus: LeeStatusBlock(next: 'Run the migration')),
          ],
        ),
      ]),
      ptyId: 7,
    );
    expect(find.text('UPDATES'), findsOneWidget);
    expect(find.text('Renamed the table.'), findsOneWidget);
    expect(find.text('Next: Run the migration'), findsOneWidget);

    expect(find.text('Along the way'), findsOneWidget);
    expect(find.text('Ran tests (failed)'), findsNothing, reason: 'folded until opened');
    await tester.tap(find.text('Along the way'));
    await tester.pumpAndSettle();
    expect(find.text('Ran tests (failed)'), findsOneWidget);
    expect(find.text('Read a.ts'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Ran tests (failed)')).dy,
      lessThan(tester.getTopLeft(find.text('Read a.ts')).dy),
      reason: 'newest first',
    );
  });

  testWidgets('a clipped last message is replaced by the full one', (tester) async {
    final clipped = '${'a' * 279}…';
    late _FakeAttentionNotifier notifier;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionProvider.overrideWith((ref) {
            notifier = _FakeAttentionNotifier(ref, AttentionSnapshot(agents: [_agent(lastSummary: clipped)]))
              ..fullSummary = 'the whole message';
            return notifier;
          }),
        ],
        child: MaterialApp(theme: AeronautTheme.darkTheme, home: const AgentScreen(ptyId: 7)),
      ),
    );
    await tester.pumpAndSettle();
    expect(notifier.fullSummaryFetches, 1);
    expect(find.textContaining('the whole message', findRichText: true), findsOneWidget);
  });

  testWidgets('a new unclipped item drops the full text fetched for the old one', (tester) async {
    final clipped = AttentionItem(
      id: 'att_a',
      version: 1,
      kind: AttentionKind.waiting,
      severity: AttentionSeverity.needsYou,
      text: '${'q' * 279}…',
      source: const AttentionSource(ptyId: 7),
      actions: const [AttentionActionName.reply],
    );
    late _FakeAttentionNotifier notifier;
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          attentionProvider.overrideWith((ref) {
            notifier = _FakeAttentionNotifier(ref, AttentionSnapshot(items: [clipped], agents: [_agent()]))
              ..fullItemText = 'the whole first question';
            return notifier;
          }),
        ],
        child: MaterialApp(theme: AeronautTheme.darkTheme, home: const AgentScreen(ptyId: 7)),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('the whole first question', findRichText: true), findsOneWidget);

    const second = AttentionItem(
      id: 'att_b',
      version: 1,
      kind: AttentionKind.waiting,
      severity: AttentionSeverity.needsYou,
      text: 'Ship it now?',
      source: AttentionSource(ptyId: 7),
      actions: [AttentionActionName.reply],
    );
    notifier.setSnapshot(AttentionSnapshot(items: const [second], agents: [_agent()]));
    await tester.pumpAndSettle();
    expect(find.textContaining('the whole first question', findRichText: true), findsNothing);
    expect(find.textContaining('Ship it now?', findRichText: true), findsOneWidget);

    notifier.setSnapshot(AttentionSnapshot(agents: [_agent(lastSummary: 'Done for now.')]));
    await tester.pumpAndSettle();
    expect(find.textContaining('Ship it now?', findRichText: true), findsNothing);
    expect(find.textContaining('Done for now.', findRichText: true), findsOneWidget);
  });

  testWidgets('a finished agent with no item says so', (tester) async {
    await _pump(tester, const AttentionSnapshot(), ptyId: 99);
    expect(find.text('This agent has finished.'), findsOneWidget);
  });

  test('agentItem prefers the named item, then an approval, then anything that takes a reply', () {
    const reply = AttentionItem(id: 'r', source: AttentionSource(ptyId: 1), actions: [AttentionActionName.reply]);
    const approve = AttentionItem(
      id: 'a',
      kind: AttentionKind.approval,
      source: AttentionSource(ptyId: 1),
      actions: [AttentionActionName.approve, AttentionActionName.deny],
    );
    const other = AttentionItem(id: 'o', source: AttentionSource(ptyId: 2), actions: [AttentionActionName.reply]);
    const snap = AttentionSnapshot(items: [reply, approve, other]);
    expect(agentItem(snap, ptyId: 1)?.id, 'a');
    expect(agentItem(snap, ptyId: 1, itemId: 'r')?.id, 'r');
    expect(agentItem(snap, itemId: 'o')?.id, 'o');
    expect(agentItem(snap, ptyId: 3), isNull);
  });
}
