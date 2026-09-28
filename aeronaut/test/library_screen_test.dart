import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/carry.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/screens/library_screen.dart';
import 'package:aeronaut/services/copilot_api.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/theme/phosphor_tokens.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// Lee main's Tether, `GET /carry` (Desk D2 §9.3): the last Desk card, with exploration_id as its legacy alias.
Map<String, dynamic> _carry({Map<String, dynamic>? openNext}) => {
      'workspace': '/ws/api',
      'pick_up': {
        'card_id': 'pg-0000abcd',
        'card_kind': 'page',
        'title': 'Cache design',
        'area_name': 'Storage',
        'stopped_at': 'The eviction order is the real question.',
        'stopped_line': 14,
        'last_touched_at': '2026-09-27T10:00:00Z',
        'exploration_id': 'pg-0000abcd',
      },
      'open_questions': [
        {'card_id': 'pg-0000abcd', 'exploration_id': 'pg-0000abcd', 'question_id': 'q1', 'text': 'Is LRU enough here?'},
      ],
      'captured_count': 2,
      'reading_count': 3,
      'open_next': openNext,
      'spooled': 1,
    };

/// A fake Lee: GET /carry, POST /carry/capture and POST /carry/open-next.
class _FakeLee {
  final requests = <http.Request>[];
  Map<String, dynamic>? openNext;
  int carryStatus = 200;

  late final client = MockClient((request) async {
    requests.add(request);
    final path = request.url.path;
    if (request.method == 'GET' && path == '/carry') {
      if (carryStatus != 200) return http.Response(jsonEncode({'error': 'hester_offline'}), carryStatus);
      return http.Response(jsonEncode({'success': true, 'data': _carry(openNext: openNext)}), 200);
    }
    if (request.method == 'POST' && path == '/carry/capture') {
      return http.Response(jsonEncode({'success': true, 'data': {'someday_id': 'sd_9'}}), 200);
    }
    if (request.method == 'POST' && path == '/carry/open-next') {
      final body = jsonDecode(request.body) as Map<String, dynamic>;
      openNext = {'card_id': body['card_id'], 'exploration_id': body['card_id'], 'set_at': '2026-09-27T12:00:00Z'};
      return http.Response(jsonEncode({'success': true, 'data': openNext}), 200);
    }
    return http.Response('not found', 404);
  });
}

Future<void> _pumpCarry(WidgetTester tester, _FakeLee lee) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [machinesProvider.overrideWith((ref) => _FixedMachinesNotifier())],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: Scaffold(
          body: CarryView(
            workspace: '/ws/api',
            apiBuilder: (m) => CopilotApi(machine: m, client: lee.client),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('CarrySnapshot.fromJson', () {
    test('parses the /carry contract: your last Desk card', () {
      final c = CarrySnapshot.fromJson(_carry(openNext: {'card_id': 'pg-0000abcd', 'set_at': '2026-09-27T12:00:00Z'}));
      expect(c.pickUp!.cardId, 'pg-0000abcd');
      expect(c.pickUp!.areaName, 'Storage');
      expect(c.pickUp!.stoppedLine, 14);
      expect(c.pickUp!.stoppedAt, 'The eviction order is the real question.');
      expect(c.openQuestions.single.cardId, 'pg-0000abcd');
      expect(c.openQuestions.single.text, 'Is LRU enough here?');
      expect(c.readingCount, 3);
      expect(c.capturedCount, 2);
      expect(c.spooled, 1);
      expect(c.opensFirst('pg-0000abcd'), isTrue);
      expect(c.opensFirst('pg-00000002'), isFalse);
    });

    test('a Lee from before the Desk: exploration ids stand in for card ids', () {
      final c = CarrySnapshot.fromJson({
        'workspace': '/w',
        'pick_up': {'exploration_id': 'exp_1', 'title': 'Old', 'stopped_at': 'Here.', 'last_touched_at': null},
        'open_questions': [
          {'exploration_id': 'exp_1', 'question_id': 'q1', 'text': 'Why?'},
        ],
        'open_next': {'exploration_id': 'exp_1', 'set_at': '2026-09-27T12:00:00Z'},
      });
      expect(c.pickUp!.cardId, 'exp_1');
      expect(c.pickUp!.areaName, isNull);
      expect(c.pickUp!.stoppedLine, isNull);
      expect(c.openQuestions.single.cardId, 'exp_1');
      expect(c.opensFirst('exp_1'), isTrue);
      expect(c.spooled, 0);
    });

    test('nothing to pick up', () {
      final c = CarrySnapshot.fromJson({'workspace': '/w', 'pick_up': null, 'open_questions': <dynamic>[]});
      expect(c.pickUp, isNull);
      expect(c.openNext, isNull);
      expect(c.readingCount, 0);
    });
  });

  test('thingsToRead', () {
    expect(thingsToRead(1), 'One thing to read');
    expect(thingsToRead(3), '3 things to read');
  });

  group('CarryView', () {
    testWidgets('shows where you stopped and the open questions in Newsreader', (tester) async {
      final lee = _FakeLee();
      await _pumpCarry(tester, lee);

      expect(lee.requests.first.url.queryParameters['workspace'], '/ws/api');
      final title = tester.widget<Text>(find.text('Cache design'));
      expect(title.style!.fontFamily, Phosphor.fontWrite, reason: 'the card title is your words');
      expect(find.textContaining('Storage · last touched'), findsOneWidget);
      expect(find.text('YOU STOPPED AT'), findsOneWidget);
      final quote = tester.widget<Text>(find.text('“The eviction order is the real question.”'));
      expect(quote.style!.fontFamily, Phosphor.fontWrite);
      expect(quote.style!.fontStyle, FontStyle.italic);
      final question = tester.widget<Text>(find.text('Is LRU enough here?'));
      expect(question.style!.fontFamily, Phosphor.fontWrite);
      expect(find.text('3 things to read'), findsOneWidget);
      expect(find.text('1 waiting for Hester'), findsOneWidget);
    });

    testWidgets('Capture a thought into this posts with the card id', (tester) async {
      final lee = _FakeLee();
      await _pumpCarry(tester, lee);

      await tester.tap(find.text('Capture a thought into this'));
      await tester.pumpAndSettle();
      await tester.enterText(find.byKey(const ValueKey('carry-capture-field')), 'What if the TTL is per key?');
      await tester.tap(find.byKey(const ValueKey('carry-capture-send')));
      await tester.pumpAndSettle();

      final post = lee.requests.firstWhere((r) => r.url.path == '/carry/capture');
      final body = jsonDecode(post.body) as Map<String, dynamic>;
      expect(body['text'], 'What if the TTL is per key?');
      expect(body['card_id'], 'pg-0000abcd');
      expect(body['workspace'], '/ws/api');
      expect(find.byKey(const ValueKey('carry-capture-field')), findsNothing, reason: 'sheet closes');
      expect(find.text('Captured'), findsOneWidget);
    });

    testWidgets('Open this first on the Mac sets open-next, then says so', (tester) async {
      final lee = _FakeLee();
      await _pumpCarry(tester, lee);

      await tester.tap(find.text('Open this first on the Mac'));
      await tester.pumpAndSettle();

      final post = lee.requests.firstWhere((r) => r.url.path == '/carry/open-next');
      expect((jsonDecode(post.body) as Map<String, dynamic>)['card_id'], 'pg-0000abcd');
      expect(find.text('Opens first on the Mac'), findsOneWidget);
    });

    testWidgets('Hester offline (503) says so', (tester) async {
      final lee = _FakeLee()..carryStatus = 503;
      await _pumpCarry(tester, lee);
      expect(find.text('Hester is offline.'), findsOneWidget);
    });
  });

  testWidgets('LibraryScreen tabs: Tether first, then Ideas; no Explorations tab', (tester) async {
    final lee = _FakeLee();
    await tester.pumpWidget(
      ProviderScope(
        overrides: [machinesProvider.overrideWith((ref) => _FixedMachinesNotifier())],
        child: MaterialApp(
          theme: AeronautTheme.darkTheme,
          home: LibraryScreen(
            copilotApi: (m) => CopilotApi(machine: m, client: lee.client),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final tabs = ['Tether', 'Ideas'].map((t) => tester.getTopLeft(find.text(t)).dx).toList();
    expect(tabs[0], lessThan(tabs[1]));
    expect(find.text('Explorations'), findsNothing);
    expect(find.text('Cache design'), findsOneWidget, reason: 'Tether shows first');
  });
}
