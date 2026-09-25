import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/hester_models.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/screens/someday_screen.dart';
import 'package:aeronaut/services/hester_api.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

/// Puts [_machine] in place as the active machine without touching
/// SharedPreferences — `MachinesNotifier.init()` is never called, so no
/// health-check timer starts either.
class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

Map<String, dynamic> _item({
  required String id,
  String text = 'try sqlite for the cache',
  String createdAt = '2026-09-20T10:00:00Z',
  String as_ = 'someday',
  String surface = 'aeronaut',
}) {
  return {
    'id': id,
    'created_at': createdAt,
    'status': 'open',
    'as': as_,
    'source': {'surface': surface},
    'tags': <String>[],
    'triage': null,
    'text': text,
  };
}

Future<void> _pump(
  WidgetTester tester,
  http.Client client, {
  String? workspace = '/ws/api',
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [machinesProvider.overrideWith((ref) => _FixedMachinesNotifier())],
      child: MaterialApp(
        theme: AeronautTheme.darkTheme,
        home: SomedayScreen(
          workspace: workspace,
          apiBuilder: (m) => HesterApi(machine: m, client: client),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  group('SomedayItem.fromJson', () {
    test('parses fields, including the exploration marker', () {
      final item = SomedayItem.fromJson(_item(id: 'sd_1', as_: 'explore', surface: 'lee'));
      expect(item.id, 'sd_1');
      expect(item.text, 'try sqlite for the cache');
      expect(item.status, 'open');
      expect(item.asExploration, isTrue);
      expect(item.sourceSurface, 'lee');
      expect(item.createdAt, DateTime.utc(2026, 9, 20, 10));
    });

    test('defaults as to someday (not an exploration)', () {
      final item = SomedayItem.fromJson(_item(id: 'sd_2'));
      expect(item.asExploration, isFalse);
    });
  });

  group('HesterApi.getSomeday', () {
    test('hits GET /someday?workspace=&status=open and preserves server order', () async {
      Uri? requested;
      final client = MockClient((req) async {
        requested = req.url;
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              _item(id: 'sd_new', createdAt: '2026-09-24T00:00:00Z'),
              _item(id: 'sd_old', createdAt: '2026-09-01T00:00:00Z'),
            ],
          }),
          200,
        );
      });
      final api = HesterApi(machine: _machine, client: client);

      final items = await api.getSomeday(workspace: '/ws/api');

      expect(requested?.path, '/someday');
      expect(requested?.queryParameters, {'workspace': '/ws/api', 'status': 'open'});
      // The daemon already returns newest-first; the client must not re-sort.
      expect(items?.map((i) => i.id).toList(), ['sd_new', 'sd_old']);
    });

    test('returns null (Hester offline) when the daemon is unreachable', () async {
      final client = MockClient((req) async => throw Exception('connection refused'));
      final api = HesterApi(machine: _machine, client: client);

      expect(await api.getSomeday(workspace: '/ws/api'), isNull);
    });
  });

  group('HesterApi.triageSomeday', () {
    test('posts the action and workspace to /someday/{id}/triage', () async {
      Uri? requested;
      Map<String, dynamic>? body;
      final client = MockClient((req) async {
        requested = req.url;
        body = jsonDecode(req.body) as Map<String, dynamic>;
        return http.Response(
          jsonEncode({'success': true, 'data': _item(id: 'sd_1')..['status'] = 'explored'}),
          200,
        );
      });
      final api = HesterApi(machine: _machine, client: client);

      final result = await api.triageSomeday('sd_1', workspace: '/ws/api', action: 'explore');

      expect(requested?.path, '/someday/sd_1/triage');
      expect(body, {'workspace': '/ws/api', 'action': 'explore'});
      expect(result?.id, 'sd_1');
    });
  });

  group('SomedayScreen', () {
    testWidgets('lists items newest first with age, source and exploration marker', (tester) async {
      final client = MockClient((req) async {
        return http.Response(
          jsonEncode({
            'success': true,
            'data': [
              _item(id: 'sd_a', text: 'idea A', as_: 'explore', surface: 'dirigible'),
              _item(id: 'sd_b', text: 'idea B', surface: 'lee'),
            ],
          }),
          200,
        );
      });

      await _pump(tester, client);

      expect(find.text('idea A'), findsOneWidget);
      expect(find.text('idea B'), findsOneWidget);
      expect(find.text('as exploration'), findsOneWidget);
      expect(find.text('Dirigible'), findsOneWidget);
      expect(find.text('Lee'), findsOneWidget);

      double y(String t) => tester.getTopLeft(find.text(t)).dy;
      expect(y('idea A'), lessThan(y('idea B')), reason: 'server order (newest first) is preserved');
    });

    testWidgets('a triage button posts the matching action and refreshes', (tester) async {
      final actions = <String>[];
      var listCalls = 0;
      final client = MockClient((req) async {
        if (req.method == 'POST') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          actions.add(body['action'] as String);
          return http.Response(
            jsonEncode({'success': true, 'data': _item(id: 'sd_1')..['status'] = 'kept'}),
            200,
          );
        }
        listCalls++;
        // Second GET (post-triage refresh) returns an empty list.
        final data = listCalls == 1 ? [_item(id: 'sd_1', text: 'drop the cron idea')] : <dynamic>[];
        return http.Response(jsonEncode({'success': true, 'data': data}), 200);
      });

      await _pump(tester, client);
      expect(find.text('drop the cron idea'), findsOneWidget);

      await tester.tap(find.text('Keep'));
      await tester.pumpAndSettle();

      expect(actions, ['keep']);
      expect(listCalls, 2, reason: 'reloads after the triage instead of assuming success');
      expect(find.text('Nothing captured yet.'), findsOneWidget);
    });

    testWidgets('Explore/Promote/Drop send their own action names', (tester) async {
      final actions = <String>[];
      final client = MockClient((req) async {
        if (req.method == 'POST') {
          final body = jsonDecode(req.body) as Map<String, dynamic>;
          actions.add(body['action'] as String);
          return http.Response(jsonEncode({'success': true, 'data': _item(id: 'sd_1')}), 200);
        }
        return http.Response(
          jsonEncode({'success': true, 'data': [_item(id: 'sd_1', text: 'multi-action idea')]}),
          200,
        );
      });

      await _pump(tester, client);
      await tester.tap(find.text('Explore'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Promote'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Drop'));
      await tester.pumpAndSettle();

      expect(actions, ['explore', 'promote', 'drop']);
    });

    testWidgets('shows Hester offline when the daemon is unreachable', (tester) async {
      final client = MockClient((req) async => throw Exception('refused'));
      await _pump(tester, client);
      expect(find.text('Hester offline'), findsOneWidget);
    });

    testWidgets('no workspace selected shows a message and makes no request', (tester) async {
      var called = false;
      final client = MockClient((req) async {
        called = true;
        return http.Response(jsonEncode({'success': true, 'data': []}), 200);
      });

      await _pump(tester, client, workspace: null);

      expect(find.text('No workspace selected.'), findsOneWidget);
      expect(called, isFalse);
    });
  });
}
