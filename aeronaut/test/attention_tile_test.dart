import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/attention_tile.dart';

/// One recorded call into the notifier, for asserting exactly what a chip
/// tap or swipe sent — without hitting the network.
class _Call {
  final String method;
  final String itemId;
  final String? action;
  final String? text;
  final int? choice;
  final int? version;

  _Call(this.method, this.itemId, {this.action, this.text, this.choice, this.version});
}

/// Records reply/snooze/dismiss/open calls instead of making them, and
/// serves canned data for [fetchFullItem]. With no active machine (the
/// default `machinesProvider` state in a test container), the real
/// [AttentionNotifier] methods would already short-circuit before touching
/// the network — this override exists so the tests can assert the exact
/// params (item id, action, text, choice, version) a tap or swipe gesture
/// sent, and control what a full-text/full-question fetch returns.
class _RecordingAttentionNotifier extends AttentionNotifier {
  _RecordingAttentionNotifier(super.ref);

  final calls = <_Call>[];

  /// Set by a test to control what [fetchFullItem] resolves to; null means
  /// "not arrived yet" (the caller keeps showing the clipped text).
  AttentionItem? Function(AttentionItem item)? onFetchFullItem;
  int fetchFullItemCalls = 0;

  @override
  Future<ActionResult> reply(
    String itemId, {
    required String action,
    String? text,
    int? choice,
    required int version,
  }) async {
    calls.add(_Call('reply', itemId, action: action, text: text, choice: choice, version: version));
    return const ActionResult(success: true);
  }

  @override
  Future<ActionResult> dismiss(String itemId) async {
    calls.add(_Call('dismiss', itemId));
    return const ActionResult(success: true);
  }

  @override
  Future<ActionResult> snooze(String itemId, {String? until, int? minutes}) async {
    calls.add(_Call('snooze', itemId));
    return const ActionResult(success: true);
  }

  @override
  Future<ActionResult> open(String itemId) async {
    calls.add(_Call('open', itemId));
    return const ActionResult(success: true);
  }

  @override
  Future<AttentionItem?> fetchFullItem(AttentionItem item) async {
    fetchFullItemCalls++;
    return onFetchFullItem?.call(item);
  }
}

Future<_RecordingAttentionNotifier> _pumpTile(WidgetTester tester, AttentionItem item) async {
  late _RecordingAttentionNotifier notifier;
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        attentionProvider.overrideWith((ref) {
          notifier = _RecordingAttentionNotifier(ref);
          return notifier;
        }),
      ],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: Scaffold(
          body: SingleChildScrollView(child: AttentionTile(item: item)),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  return notifier;
}

void main() {
  const reviewItem = AttentionItem(
    id: 'att_review',
    version: 5,
    kind: AttentionKind.review,
    title: 'Review this diff',
    text: 'Renamed a few functions',
    actions: [AttentionActionName.reply, AttentionActionName.snooze, AttentionActionName.dismiss],
  );

  const waitingItem = AttentionItem(
    id: 'att_waiting',
    version: 1,
    kind: AttentionKind.waiting,
    title: 'Claude is waiting for you',
    actions: [AttentionActionName.reply, AttentionActionName.snooze, AttentionActionName.dismiss],
  );

  const approvalItem = AttentionItem(
    id: 'att_approval',
    version: 2,
    kind: AttentionKind.approval,
    title: 'Run "npm test"?',
    actions: [
      AttentionActionName.approve,
      AttentionActionName.deny,
      AttentionActionName.snooze,
      AttentionActionName.dismiss,
    ],
  );

  group('quick-reply chips (contracts §5.2)', () {
    testWidgets('review tile shows the chips once Reply is tapped', (tester) async {
      await _pumpTile(tester, reviewItem);

      expect(find.text('Reply'), findsOneWidget);
      for (final chip in quickReplyChips) {
        expect(find.text(chip), findsNothing);
      }

      await tester.tap(find.text('Reply'));
      await tester.pumpAndSettle();

      for (final chip in quickReplyChips) {
        expect(find.text(chip), findsOneWidget);
      }
    });

    testWidgets('waiting (question) tile also shows the chips', (tester) async {
      await _pumpTile(tester, waitingItem);
      await tester.tap(find.text('Reply'));
      await tester.pumpAndSettle();

      for (final chip in quickReplyChips) {
        expect(find.text(chip), findsOneWidget);
      }
    });

    testWidgets('tapping a chip sends a text reply with the item\'s version', (tester) async {
      final notifier = await _pumpTile(tester, reviewItem);

      await tester.tap(find.text('Reply'));
      await tester.pumpAndSettle();

      final chipText = quickReplyChips.first;
      await tester.tap(find.text(chipText));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      final call = notifier.calls.single;
      expect(call.method, 'reply');
      expect(call.itemId, 'att_review');
      expect(call.action, 'text');
      expect(call.text, chipText);
      expect(call.version, 5);

      // The reply field closes, same as a typed send.
      expect(find.text(chipText), findsNothing);
    });

    testWidgets('a kind outside the chip set (e.g. summary) shows no chips', (tester) async {
      const item = AttentionItem(
        id: 'att_summary',
        version: 1,
        kind: AttentionKind.summary,
        title: 'Turn summary',
        actions: [AttentionActionName.reply, AttentionActionName.dismiss],
      );
      await _pumpTile(tester, item);

      await tester.tap(find.text('Reply'));
      await tester.pumpAndSettle();

      for (final chip in quickReplyChips) {
        expect(find.text(chip), findsNothing);
      }
      // The free-text field is still there for anything else.
      expect(find.byType(TextField), findsOneWidget);
    });
  });

  group('swipe actions (contracts §5.2, C3)', () {
    testWidgets('approval tiles: Approve/Deny stay explicit taps; swipe only reaches snooze/dismiss',
        (tester) async {
      final notifier = await _pumpTile(tester, approvalItem);

      expect(find.text('Approve'), findsOneWidget);
      expect(find.text('Deny'), findsOneWidget);
      // Exactly one swipe surface for the whole tile (snooze + dismiss) —
      // there is no separate gesture target that could reach approve/deny.
      expect(find.byType(Dismissible), findsOneWidget);

      // Swipe left -> dismiss. Never approve/deny, whatever direction.
      await tester.drag(find.byType(Dismissible), const Offset(-500, 0));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      expect(notifier.calls.single.method, 'dismiss');
      expect(notifier.calls.single.itemId, 'att_approval');
      expect(
        notifier.calls.any((c) => c.action == 'approve' || c.action == 'deny'),
        isFalse,
      );

      // Approve/Deny remain intact, tap-only.
      expect(find.text('Approve'), findsOneWidget);
      expect(find.text('Deny'), findsOneWidget);
    });

    testWidgets('swipe right on a snoozable/dismissible tile opens the snooze menu', (tester) async {
      await _pumpTile(tester, reviewItem);

      expect(find.byType(Dismissible), findsOneWidget);

      await tester.drag(find.byType(Dismissible), const Offset(500, 0));
      await tester.pumpAndSettle();

      // Same menu as tapping the Snooze button.
      expect(find.text('Snooze 15 minutes'), findsOneWidget);
      expect(find.text('Snooze 1 hour'), findsOneWidget);
      expect(find.text('Until it changes'), findsOneWidget);
    });

    testWidgets('an item with neither snooze nor dismiss has no Dismissible', (tester) async {
      const item = AttentionItem(
        id: 'att_none',
        version: 1,
        kind: AttentionKind.approval,
        title: 'No snooze or dismiss',
        actions: [AttentionActionName.approve, AttentionActionName.deny],
      );
      await _pumpTile(tester, item);
      expect(find.byType(Dismissible), findsNothing);
    });
  });

  group('full-text expand (a clipped item.text)', () {
    final clippedText = '${'a' * 279}…'; // 280 chars, looks clipped
    final clippedItem = AttentionItem(
      id: 'att_clip',
      version: 1,
      kind: AttentionKind.review,
      title: 'Review this diff',
      text: clippedText,
      actions: const [AttentionActionName.snooze, AttentionActionName.dismiss],
    );

    testWidgets('tapping the text fetches and shows the full text', (tester) async {
      final notifier = await _pumpTile(tester, clippedItem);
      notifier.onFetchFullItem = (item) => AttentionItem(
            id: item.id,
            version: item.version,
            text: 'the real full text, much longer than the clipped preview',
          );

      await tester.tap(find.text(clippedText));
      await tester.pumpAndSettle();

      expect(notifier.fetchFullItemCalls, 1);
      expect(find.text('the real full text, much longer than the clipped preview'), findsOneWidget);
      expect(find.text(clippedText), findsNothing);
    });

    testWidgets('collapsing and re-expanding reuses the already-fetched text (no second call)', (tester) async {
      final notifier = await _pumpTile(tester, clippedItem);
      notifier.onFetchFullItem = (item) => AttentionItem(id: item.id, version: item.version, text: 'full text here');

      await tester.tap(find.text(clippedText)); // expand
      await tester.pumpAndSettle();
      expect(notifier.fetchFullItemCalls, 1);
      expect(find.text('full text here'), findsOneWidget);

      await tester.tap(find.text('full text here')); // collapse — back to the clipped preview
      await tester.pumpAndSettle();
      expect(find.text(clippedText), findsOneWidget);

      await tester.tap(find.text(clippedText)); // re-expand
      await tester.pumpAndSettle();
      expect(find.text('full text here'), findsOneWidget);
      expect(notifier.fetchFullItemCalls, 1, reason: 'served from the tile\'s own already-fetched text');
    });

    testWidgets('while the fetch is pending, the clipped text keeps showing', (tester) async {
      final notifier = await _pumpTile(tester, clippedItem);
      notifier.onFetchFullItem = (item) => null; // simulates "not arrived yet" / gone

      await tester.tap(find.text(clippedText));
      await tester.pumpAndSettle();

      expect(find.text(clippedText), findsOneWidget);
    });
  });

  group('question kind (Claude\'s AskUserQuestion)', () {
    const answerableItem = AttentionItem(
      id: 'att_ask',
      version: 1,
      kind: AttentionKind.question,
      title: 'Claude asks: which approach?',
      actions: [AttentionActionName.choose, AttentionActionName.snooze, AttentionActionName.dismiss],
      question: QuestionSet(questions: [
        Question(
          question: 'Which approach should I take?',
          header: 'Approach',
          options: [
            QuestionOption(label: 'Rewrite', description: 'Start fresh'),
            QuestionOption(label: 'Patch', description: 'Small fix'),
          ],
        ),
      ]),
    );

    testWidgets('shows the question and tappable options; never Approve/Deny/Reply', (tester) async {
      await _pumpTile(tester, answerableItem);

      expect(find.text('Which approach should I take?'), findsOneWidget);
      expect(find.text('Rewrite'), findsOneWidget);
      expect(find.text('Patch'), findsOneWidget);
      expect(find.text('Approve'), findsNothing);
      expect(find.text('Deny'), findsNothing);
      expect(find.text('Reply'), findsNothing);
    });

    testWidgets('tapping an option sends choose with its 0-based index and the item version', (tester) async {
      final notifier = await _pumpTile(tester, answerableItem);

      await tester.tap(find.text('Patch'));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      final call = notifier.calls.single;
      expect(call.method, 'reply');
      expect(call.itemId, 'att_ask');
      expect(call.action, 'choose');
      expect(call.choice, 1);
      expect(call.version, 1);
    });

    testWidgets('no "choose" in actions (Lee\'s call) is read-only with Open tab, never a tap target', (tester) async {
      const item = AttentionItem(
        id: 'att_ask2',
        version: 1,
        kind: AttentionKind.question,
        title: 'Claude asks: pick the files',
        actions: [AttentionActionName.snooze, AttentionActionName.dismiss],
        question: QuestionSet(questions: [
          Question(question: 'Pick the files to change', options: [QuestionOption(label: 'a.ts')]),
        ]),
      );
      final notifier = await _pumpTile(tester, item);

      expect(find.text('Pick the files to change'), findsOneWidget);
      expect(find.text('a.ts'), findsNothing, reason: 'not choosable — no tappable option button');
      expect(find.text('Open tab'), findsOneWidget);

      await tester.tap(find.text('Open tab'));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      expect(notifier.calls.single.method, 'open');
      expect(notifier.calls.single.itemId, 'att_ask2');
    });

    testWidgets('no question payload yet is read-only with Open tab', (tester) async {
      const item = AttentionItem(
        id: 'att_ask3',
        version: 1,
        kind: AttentionKind.question,
        title: 'Claude asks: …',
        actions: [AttentionActionName.choose],
      );
      await _pumpTile(tester, item);

      expect(find.text('Claude is asking a question — open the tab to answer.'), findsOneWidget);
      expect(find.text('Open tab'), findsOneWidget);
    });
  });

  group('legacy AskUserQuestion safety net (approval kind, older Lee)', () {
    const legacyItem = AttentionItem(
      id: 'att_legacy',
      version: 1,
      kind: AttentionKind.approval,
      title: 'Claude wants to use AskUserQuestion',
      tool: ToolPreview(name: 'AskUserQuestion', preview: '', signature: 's'),
      actions: [
        AttentionActionName.approve,
        AttentionActionName.deny,
        AttentionActionName.snooze,
        AttentionActionName.dismiss,
      ],
    );

    testWidgets('shows Open tab instead of Approve/Deny, with an explanation', (tester) async {
      await _pumpTile(tester, legacyItem);

      expect(find.text('Approve'), findsNothing);
      expect(find.text('Deny'), findsNothing);
      expect(find.text('Claude is asking a question — open the tab to answer.'), findsOneWidget);
      expect(find.text('Open tab'), findsOneWidget);
    });

    testWidgets('tapping Open tab calls notifier.open, never approve/deny', (tester) async {
      final notifier = await _pumpTile(tester, legacyItem);

      await tester.tap(find.text('Open tab'));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      expect(notifier.calls.single.method, 'open');
      expect(notifier.calls.any((c) => c.action == 'approve' || c.action == 'deny'), isFalse);
    });

    testWidgets('a swipe still only reaches dismiss, never approve/deny', (tester) async {
      final notifier = await _pumpTile(tester, legacyItem);

      expect(find.byType(Dismissible), findsOneWidget);
      await tester.drag(find.byType(Dismissible), const Offset(-500, 0));
      await tester.pumpAndSettle();

      expect(notifier.calls, hasLength(1));
      expect(notifier.calls.single.method, 'dismiss');
    });
  });
}
