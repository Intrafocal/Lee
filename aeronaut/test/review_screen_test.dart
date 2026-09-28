import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/providers/tether_provider.dart';
import 'package:aeronaut/screens/page_screen.dart';
import 'package:aeronaut/screens/review_screen.dart';
import 'package:aeronaut/screens/root_shell.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/services/tether_api.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/theme/phosphor_tokens.dart';
import 'package:aeronaut/widgets/pick_up_block.dart';

import 'tether_api_test.dart' show cardJson, tetherJson;

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// A fake Lee answering the `/tether/*` reads.
class _FakeLee {
  final paths = <String>[];

  http.Response _ok(Object data) => http.Response(jsonEncode({'success': true, 'data': data}), 200);

  late final client = MockClient((r) async {
    paths.add(r.url.path);
    switch (r.url.path) {
      case '/tether':
        return _ok(tetherJson());
      case '/tether/desk':
        return _ok({
          'workspace': '/ws/api',
          'areas': [
            {'id': 'ar-1', 'name': 'Storage', 'cards': [cardJson('pg-0000abcd'), cardJson('pg-2', title: 'Old notes')]},
          ],
          'goals_card': null,
          'last_card_id': 'pg-0000abcd',
        });
      case '/tether/pages/pg-0000abcd':
        return _ok({
          'card': cardJson('pg-0000abcd'),
          'text': 'The eviction order is the real question.\n\n![sketch](assets/a1.png)',
          'answers': [
            {'id': 'a1', 'question': 'Is LRU enough?', 'answer': 'Mostly.', 'status': 'done'},
          ],
          'handoffs': [],
          'open_questions': [
            {'id': 'q1', 'text': 'How big does it get?'},
          ],
          'references': [],
        });
      case '/tether/pages/pg-0000abcd/assets/a1.png':
        return http.Response.bytes(_png, 200, headers: {'content-type': 'image/png'});
      case '/tether/drawer':
        return _ok({
          'stashed': [
            {'id': 'ar-9', 'name': 'Parked', 'stashed_at': '2026-09-20T10:00:00Z', 'cards': [cardJson('pg-9', stashed: true)]},
          ],
          'ideas': [
            {'id': 'idea_1', 'text': 'try sqlite for the cache', 'created_at': '2026-09-28T09:00:00Z', 'surface': 'aeronaut'},
          ],
        });
    }
    return http.Response('not found', 404);
  });
}

/// A 1×1 transparent PNG.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

Future<ProviderContainer> _pump(WidgetTester tester, _FakeLee lee, Widget home) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
        tetherApiFactoryProvider.overrideWithValue((m) => TetherApi(machine: m, client: lee.client)),
      ],
      child: MaterialApp(theme: AeronautTheme.darkTheme, home: home),
    ),
  );
  await tester.pumpAndSettle();
  return ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
}

void main() {
  testWidgets('Review › Desk: Areas → Pages → a Page, in the writing font, with its answers folded', (tester) async {
    final lee = _FakeLee();
    await _pump(tester, lee, const ReviewScreen());

    expect(find.text('Desk'), findsOneWidget);
    expect(find.text('Drawer'), findsOneWidget);
    expect(find.text('Files'), findsOneWidget);
    expect(find.text('Storage'), findsOneWidget);
    expect(find.text('2 Pages'), findsOneWidget);

    await tester.tap(find.text('Storage'));
    await tester.pumpAndSettle();
    expect(find.text('Old notes'), findsOneWidget);
    await tester.tap(find.text('Cache design'));
    await tester.pumpAndSettle();

    expect(find.byType(PageScreen), findsOneWidget);
    final body = tester.widget<MarkdownBody>(find.byKey(const ValueKey('page-text')));
    expect(body.data, contains('eviction order'));
    expect(body.styleSheet!.p!.fontFamily, Phosphor.fontWrite, reason: 'a Page is your words');
    expect(lee.paths, contains('/tether/pages/pg-0000abcd/assets/a1.png'), reason: 'the image is fetched through Lee');

    // Folded until opened.
    expect(find.text('ANSWERS · 1'), findsOneWidget);
    expect(find.text('Mostly.'), findsNothing);
    await tester.tap(find.text('ANSWERS · 1'));
    await tester.pumpAndSettle();
    expect(find.text('Mostly.'), findsOneWidget);
    expect(find.text('OPEN QUESTIONS · 1'), findsOneWidget);
  });

  testWidgets('Review › Drawer: Stashed Areas and Ideas, read-only', (tester) async {
    final lee = _FakeLee();
    final container = await _pump(tester, lee, const ReviewScreen());
    container.read(reviewSectionProvider.notifier).state = ReviewSection.drawer;
    await tester.pumpAndSettle();

    expect(find.text('Parked'), findsOneWidget);
    final idea = tester.widget<Text>(find.text('try sqlite for the cache'));
    expect(idea.style!.fontFamily, Phosphor.fontWrite, reason: 'captured on a device: your words');
    expect(find.text('Explore'), findsNothing, reason: 'triage stays in Lee');
  });

  testWidgets('Work › Pick up: your last card and where you stopped; a tap opens it in Review', (tester) async {
    final lee = _FakeLee();
    final container = await _pump(
      tester,
      lee,
      const Scaffold(
        body: Column(
          children: [
            SizedBox(height: 360, child: SingleChildScrollView(child: PickUpBlock())),
            Expanded(child: ReviewScreen()),
          ],
        ),
      ),
    );

    expect(find.text('PICK UP'), findsOneWidget);
    final title = tester.widget<Text>(find.byKey(const ValueKey('tether-card-title')));
    expect(title.style!.fontFamily, Phosphor.fontWrite);
    expect(find.text('“The eviction order is the real question.”'), findsOneWidget);
    expect(find.byKey(const ValueKey('tether-q-q4')), findsOneWidget);
    expect(find.byKey(const ValueKey('tether-q-q5')), findsNothing, reason: 'at most five');
    expect(find.text('Open this first on the Mac'), findsNothing, reason: 'Open next is gone');

    await tester.tap(find.byKey(const ValueKey('pick-up')));
    await tester.pumpAndSettle();
    expect(container.read(rootTabProvider), RootTab.review);
    expect(find.byType(PageScreen), findsOneWidget);
  });
}
