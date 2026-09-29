import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/services/api_auth.dart';
import 'package:aeronaut/services/copilot_api.dart';

void main() {
  const machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

  tearDown(() {
    // Every test installs its own handler; never leak one into the next.
    ApiAuth.handler = null;
  });

  group('CopilotApi 401 vs 403 (contracts §4.4)', () {
    test('401 reports through ApiAuth and returns a rejected-token error', () async {
      AuthFailure? reported;
      ApiAuth.handler = (f) => reported = f;

      final client = MockClient((req) async {
        return http.Response(jsonEncode({'success': false, 'error': 'nope'}), 401);
      });
      final api = CopilotApi(machine: machine, client: client);

      final result = await api.reply('att_1', action: 'reply', text: 'ok', version: 1);

      expect(result.success, isFalse);
      expect(result.error, 'Token rejected. Re-pair this machine.');
      expect(reported, isNotNull);
      expect(reported!.machineId, 'm1');
    });

    test(
      '403 on a write action does NOT report through ApiAuth and gives a re-pair-to-act error, '
      'not a token-rejected one (a legacy shared-token or valid-but-forbidden principal, not a bad token)',
      () async {
        var reportedCount = 0;
        ApiAuth.handler = (_) => reportedCount++;

        final client = MockClient((req) async {
          return http.Response(jsonEncode({'success': false, 'error': 'Forbidden'}), 403);
        });
        final api = CopilotApi(machine: machine, client: client);

        final result = await api.reply('att_1', action: 'reply', text: 'ok', version: 1);

        expect(result.success, isFalse);
        expect(result.error, isNot('Token rejected. Re-pair this machine.'));
        expect(reportedCount, 0, reason: '403 must not tear down the machine connection');
      },
    );

    test('403 on getSnapshot does not report through ApiAuth either', () async {
      var reportedCount = 0;
      ApiAuth.handler = (_) => reportedCount++;

      final client = MockClient((req) async {
        return http.Response(jsonEncode({'success': false, 'error': 'Forbidden'}), 403);
      });
      final api = CopilotApi(machine: machine, client: client);

      final snapshot = await api.getSnapshot();

      expect(snapshot, isNull);
      expect(reportedCount, 0);
    });

    test('401 on getSnapshot still reports through ApiAuth', () async {
      var reportedCount = 0;
      ApiAuth.handler = (_) => reportedCount++;

      final client = MockClient((req) async {
        return http.Response(jsonEncode({'success': false, 'error': 'nope'}), 401);
      });
      final api = CopilotApi(machine: machine, client: client);

      final snapshot = await api.getSnapshot();

      expect(snapshot, isNull);
      expect(reportedCount, 1);
    });
  });
}
