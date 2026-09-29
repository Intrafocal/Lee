import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/attention_provider.dart';
import 'package:aeronaut/screens/work_screen.dart';
import 'package:aeronaut/services/copilot_api.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/theme/phosphor_tokens.dart';
import 'package:aeronaut/widgets/deep_idle_card.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

/// Lee main's deep_idle item (Desk D2 §9.2), as a compact snapshot carries it.
Map<String, dynamic> _idleJson({int version = 2}) => {
      'id': 'att_idle',
      'version': version,
      'kind': 'deep_idle',
      'severity': 'needs-you',
      'state': 'open',
      'parked': false,
      'wake': false,
      'notify': true,
      'related_to_focus': false,
      'active_wait_ms': 0,
      'title': 'Still thinking?',
      'text': 'Mesh sync',
      'source': {'kind': 'lee', 'workspace': '/ws/api'},
      'actions': ['extend', 'end_rate', 'capture', 'dismiss'],
      'deep_idle': {
        'session_id': 'fs_1',
        'ends_at': '2026-09-27T10:45:00Z',
        'card': {'card_id': 'pg-0000abcd', 'title': 'Mesh sync'},
      },
    };

class _RecordingAttentionNotifier extends AttentionNotifier {
  _RecordingAttentionNotifier(super.ref);

  final calls = <String>[];
  String? capturedCardId;

  void setSnapshot(AttentionSnapshot snapshot) => state = AttentionUiState(snapshot: snapshot);

  @override
  Future<ActionResult> deepIdleEnd(AttentionItem item, {required String action, String? rating, String? stoppedAt}) async {
    calls.add(rating == null ? action : '$action:$rating');
    return const ActionResult(success: true);
  }

  @override
  Future<CaptureResult> capture(String text, {String? workspace, String? cardId, bool voice = false}) async {
    calls.add('capture:$text');
    capturedCardId = cardId;
    return const CaptureResult(success: true, spooled: true);
  }

  @override
  Future<void> refresh() async {}
}

Future<_RecordingAttentionNotifier> _pumpWork(WidgetTester tester, AttentionSnapshot snapshot) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [attentionProvider.overrideWith(_RecordingAttentionNotifier.new)],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: Scaffold(
          body: Consumer(builder: (context, ref, _) {
            final item = ref.watch(attentionProvider.select((s) => openDeepIdle(s.snapshot)));
            return ListView(children: [if (item != null) DeepIdleCard(item: item)]);
          }),
        ),
      ),
    ),
  );
  final container = ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
  final notifier = container.read(attentionProvider.notifier) as _RecordingAttentionNotifier;
  notifier.setSnapshot(snapshot);
  await tester.pumpAndSettle();
  return notifier;
}

void main() {
  group('deep_idle item', () {
    test('parses the kind, the actions and the session', () {
      final item = AttentionItem.fromJson(_idleJson());
      expect(item.kind, AttentionKind.deepIdle);
      expect(item.actions, [
        AttentionActionName.extend,
        AttentionActionName.endRate,
        AttentionActionName.capture,
        AttentionActionName.dismiss,
      ]);
      expect(item.deepIdle!.sessionId, 'fs_1');
      expect(item.deepIdle!.endsAt, DateTime.utc(2026, 9, 27, 10, 45));
      expect(item.deepIdle!.cardId, 'pg-0000abcd');
      expect(item.deepIdle!.cardTitle, 'Mesh sync');
    });

    test('a push with no card yet (at the Desk overview)', () {
      final json = _idleJson()..['deep_idle'] = {'session_id': 'fs_2', 'ends_at': null, 'card': null};
      final item = AttentionItem.fromJson(json);
      expect(item.deepIdle!.cardId, isNull);
      expect(item.deepIdle!.endsAt, isNull);
      expect(endsAtLabel(null), '');
    });

    test('is not counted as waiting on you; openDeepIdle finds it', () {
      final snap = AttentionSnapshot.fromJson({
        'items': [_idleJson()],
        'deep': {'exploration_id': 'pg-0000abcd', 'title': 'Mesh sync', 'card_id': 'pg-0000abcd', 'card_kind': 'page'},
      });
      expect(waitingOnYou(snap), isEmpty);
      expect(openDeepIdle(snap)!.id, 'att_idle');
      expect(snap.deep!.cardId, 'pg-0000abcd');
    });
  });

  group('CopilotApi.deepIdleEnd', () {
    test('posts DeepIdleEndRequest; 409 is stale', () async {
      final bodies = <Map<String, dynamic>>[];
      var status = 200;
      final client = MockClient((request) async {
        expect(request.url.path, '/deep/idle-end');
        bodies.add(jsonDecode(request.body) as Map<String, dynamic>);
        return http.Response(jsonEncode({'success': true, 'data': {'active': false}}), status);
      });
      final api = CopilotApi(machine: _machine, client: client);
      expect((await api.deepIdleEnd('att_idle', version: 2, action: 'extend')).success, isTrue);
      expect(bodies.last, {'item_id': 'att_idle', 'version': 2, 'action': 'extend'});
      await api.deepIdleEnd('att_idle', version: 3, action: 'end_rate', rating: 'mixed', stoppedAt: '  here ');
      expect(bodies.last, {'item_id': 'att_idle', 'version': 3, 'action': 'end_rate', 'rating': 'mixed', 'stopped_at': 'here'});
      await api.deepIdleEnd('att_idle', version: 3, action: 'end_rate');
      expect(bodies.last.containsKey('rating'), isTrue, reason: 'unrated is an explicit null');
      expect(bodies.last['rating'], isNull);
      status = 409;
      final stale = await api.deepIdleEnd('att_idle', version: 2, action: 'extend');
      expect(stale.success, isFalse);
      expect(stale.error, 'stale');
    });
  });

  group('DeepIdleCard', () {
    testWidgets('shows the card title in Newsreader; Extend is the one next step', (tester) async {
      final notifier = await _pumpWork(tester, AttentionSnapshot.fromJson({'items': [_idleJson()]}));
      expect(find.text('STILL THINKING?'), findsOneWidget);
      final title = tester.widget<Text>(find.text('Mesh sync'));
      expect(title.style!.fontFamily, Phosphor.fontWrite);
      expect(find.textContaining('ends at'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('deep-idle-extend')));
      await tester.pumpAndSettle();
      expect(notifier.calls, ['extend']);
      expect(find.text('Kept going for another 45 minutes'), findsOneWidget);
    });

    testWidgets('End and rate: deep / mixed / shallow', (tester) async {
      final notifier = await _pumpWork(tester, AttentionSnapshot.fromJson({'items': [_idleJson()]}));
      await tester.tap(find.byKey(const ValueKey('deep-idle-rate-shallow')));
      await tester.pumpAndSettle();
      expect(notifier.calls, ['end_rate:shallow']);
      expect(find.text('Session ended'), findsOneWidget);
    });

    testWidgets('Capture goes into the push\'s card', (tester) async {
      final notifier = await _pumpWork(tester, AttentionSnapshot.fromJson({'items': [_idleJson()]}));
      await tester.tap(find.byKey(const ValueKey('deep-idle-capture')));
      await tester.pumpAndSettle();
      expect(find.text('Into Mesh sync'), findsOneWidget);
      await tester.enterText(find.byKey(const ValueKey('tether-capture-field')), 'clocks drift');
      await tester.tap(find.byKey(const ValueKey('tether-capture-send')));
      await tester.pumpAndSettle();
      expect(notifier.calls, ['capture:clocks drift']);
      expect(notifier.capturedCardId, 'pg-0000abcd');
      expect(find.text('Saved; will sync when Hester is back'), findsOneWidget);
    });
  });
}
