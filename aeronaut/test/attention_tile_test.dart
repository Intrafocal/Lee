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
  final int? version;

  _Call(this.method, this.itemId, {this.action, this.text, this.version});
}

/// Records reply/snooze/dismiss calls instead of making them. With no
/// active machine (the default `machinesProvider` state in a test
/// container), the real [AttentionNotifier] methods would already
/// short-circuit before touching the network — this override exists so the
/// tests can assert the exact params (item id, action, text, version) a
/// chip tap or swipe gesture sent.
class _RecordingAttentionNotifier extends AttentionNotifier {
  _RecordingAttentionNotifier(super.ref);

  final calls = <_Call>[];

  @override
  Future<ActionResult> reply(
    String itemId, {
    required String action,
    String? text,
    required int version,
  }) async {
    calls.add(_Call('reply', itemId, action: action, text: text, version: version));
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
}
