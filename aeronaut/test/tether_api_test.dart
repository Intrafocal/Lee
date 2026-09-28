import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/send_to_lee.dart';
import 'package:aeronaut/models/tether.dart';
import 'package:aeronaut/services/api_auth.dart';
import 'package:aeronaut/services/tether_api.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

http.Response _ok(Object data) => http.Response(jsonEncode({'success': true, 'data': data}), 200);

/// Lee main's `GET /tether` (§3.3).
Map<String, dynamic> tetherJson() => {
      'workspace': '/ws/api',
      'pick_up': {
        'card_id': 'pg-0000abcd',
        'card_kind': 'page',
        'title': 'Cache design',
        'area_name': 'Storage',
        'stopped_at': 'The eviction order is the real question.',
        'stopped_line': 14,
        'last_touched_at': '2026-09-27T10:00:00Z',
      },
      'open_questions': [
        for (var i = 0; i < 7; i++) {'card_id': 'pg-0000abcd', 'question_id': 'q$i', 'text': 'Question $i?'},
      ],
      'captured_count': 2,
      'spooled': 1,
    };

Map<String, dynamic> cardJson(String id, {String title = 'Cache design', bool stashed = false}) => {
      'id': id,
      'kind': 'page',
      'title': title,
      'area_id': 'ar-1',
      'area_name': 'Storage',
      'stashed': stashed,
      'updated_at': '2026-09-27T10:00:00Z',
      'chars': 1200,
      'answers': 2,
      'open_questions': 1,
    };

void main() {
  group('models', () {
    test('Tether: pick up, at most five open questions, counts', () {
      final t = Tether.fromJson(tetherJson());
      expect(t.pickUp!.cardId, 'pg-0000abcd');
      expect(t.pickUp!.areaName, 'Storage');
      expect(t.pickUp!.stoppedLine, 14);
      expect(t.openQuestions.length, 5);
      expect(t.capturedCount, 2);
      expect(t.spooled, 1);
    });

    test('TetherPage and TetherDrawer', () {
      final page = TetherPage.fromJson({
        'card': cardJson('pg-1'),
        'text': '# Cache\n\n![sketch](assets/a1.png)',
        'answers': [
          {'id': 'a1', 'question': 'LRU?', 'answer': null, 'status': 'pending'},
        ],
        'handoffs': [
          {'id': 'h1', 'kind': 'research', 'provider': 'claude', 'status': 'done', 'result': 'Use LFU.'},
        ],
        'open_questions': [
          {'id': 'q1', 'text': 'How big?'},
        ],
        'references': [
          {'title': 'Paper', 'where': 'arxiv', 'quote': null},
        ],
      });
      expect(page.card.displayTitle, 'Cache design');
      expect(page.answers.single.answer, isNull);
      expect(page.handoffs.single.result, 'Use LFU.');
      expect(page.references.single.where, 'arxiv');

      final drawer = TetherDrawer.fromJson({
        'stashed': [
          {'id': 'ar-2', 'name': 'Old', 'stashed_at': '2026-09-20T10:00:00Z', 'cards': [cardJson('pg-2', stashed: true)]},
        ],
        'ideas': [
          {'id': 'idea_1', 'text': 'try sqlite', 'created_at': '2026-09-28T09:00:00Z', 'surface': 'aeronaut'},
          {'id': 'idea_2', 'text': '', 'created_at': '2026-09-28T09:00:00Z', 'surface': null},
        ],
      });
      expect(drawer.stashed.single.stashedAt, isNotNull);
      expect(drawer.stashed.single.cards.single.stashed, isTrue);
      expect(drawer.ideas.single.fromDevice, isTrue, reason: 'blank ideas are dropped');
    });
  });

  group('TetherApi', () {
    late List<http.Request> requests;
    late http.Response Function(http.Request) respond;
    late TetherApi api;

    setUp(() {
      requests = [];
      respond = (_) => http.Response('not found', 404);
      api = TetherApi(
        machine: _machine,
        client: MockClient((r) async {
          requests.add(r);
          return respond(r);
        }),
      );
    });

    test('GET /tether with the workspace, envelope unwrapped', () async {
      respond = (_) => _ok(tetherJson());
      final result = await api.getTether(workspace: '/ws/api');
      expect(requests.single.url.path, '/tether');
      expect(requests.single.url.queryParameters, {'workspace': '/ws/api'});
      expect(requests.single.headers['Authorization'], 'Bearer t');
      expect(result.tether!.pickUp!.title, 'Cache design');
    });

    test('503 is Hester offline; 401 reports the token', () async {
      respond = (_) => http.Response(jsonEncode({'error': 'hester_offline'}), 503);
      expect((await api.getTether()).hesterOffline, isTrue);

      final failures = <AuthFailure>[];
      ApiAuth.handler = failures.add;
      addTearDown(() => ApiAuth.handler = null);
      respond = (_) => http.Response('', 401);
      final read = await api.getDesk();
      expect(read.value, isNull);
      expect(failures.single.machineId, 'm1');
    });

    test('Review reads: desk, pages (a list), a page, the drawer', () async {
      respond = (r) => switch (r.url.path) {
            '/tether/desk' => _ok({
                'workspace': '/ws/api',
                'areas': [
                  {'id': 'ar-1', 'name': 'Storage', 'cards': [cardJson('pg-1')]},
                ],
                'goals_card': null,
                'last_card_id': 'pg-1',
              }),
            '/tether/pages' => _ok([cardJson('pg-1'), cardJson('pg-2')]),
            '/tether/pages/pg-1' => _ok({'card': cardJson('pg-1'), 'text': 'hi'}),
            '/tether/drawer' => _ok({'stashed': [], 'ideas': []}),
            _ => http.Response('not found', 404),
          };
      expect((await api.getDesk()).value!.areas.single.cards.single.id, 'pg-1');
      expect((await api.getPages()).value!.length, 2);
      expect(requests.last.url.queryParameters['limit'], '50');
      expect((await api.getPage('pg-1')).value!.text, 'hi');
      expect((await api.getDrawer()).value!.ideas, isEmpty);
    });

    test('an unknown route (a Lee from before this round) says to update Lee', () async {
      final read = await api.getDesk();
      expect(read.error, contains('too old'));
    });

    test('POST /tether/capture: card, voice tag; spooled when Hester is away', () async {
      respond = (_) => _ok({'spooled': true});
      final result = await api.capture('clocks drift', workspace: '/ws', cardId: 'pg-1', voice: true);
      final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
      expect(requests.single.url.path, '/tether/capture');
      expect(body, {'text': 'clocks drift', 'workspace': '/ws', 'card_id': 'pg-1', 'input': 'voice'});
      expect(result.success, isTrue);
      expect(result.spooled, isTrue);

      respond = (_) => _ok({'id': 'idea_1'});
      final typed = await api.capture('x');
      expect(jsonDecode(requests.last.body), {'text': 'x'}, reason: 'no input tag when typed');
      expect(typed.ideaId, 'idea_1');
    });

    test('POST /tether/send: target, items and submit on the wire', () async {
      respond = (_) => _ok({
            'send_id': 's1',
            'delivered_to': {'kind': 'page', 'card_id': 'pg-1', 'title': 'Taxonomy'},
          });
      final result = await api.send(SendRequest(
        workspace: '/ws',
        items: [
          const TextItem('look at this', voice: true),
          ImageItem(mime: 'image/png', bytes: Uint8List.fromList([1, 2, 3]), source: ImageSourceKind.scribble),
        ],
      ));
      final body = jsonDecode(requests.single.body) as Map<String, dynamic>;
      expect(body['target'], 'focus');
      expect(body.containsKey('submit'), isFalse, reason: 'Deliver is the default');
      expect(body['items'], [
        {'kind': 'text', 'text': 'look at this', 'input': 'voice'},
        {'kind': 'image', 'mime': 'image/png', 'data_b64': 'AQID', 'source': 'scribble'},
      ]);
      expect(result.ok, isTrue);
      expect(result.deliveredTo!.name, 'Taxonomy');

      await api.send(const SendRequest(
        target: SendTarget.tab(ptyId: 7, label: 'Claude', tabKind: 'agent', provider: 'claude'),
        items: [TextItem('run the tests')],
        submit: true,
      ));
      final sent = jsonDecode(requests.last.body) as Map<String, dynamic>;
      expect(sent['submit'], isTrue);
      expect(sent['target'], {'kind': 'tab', 'pty_id': 7, 'label': 'Claude', 'tab_kind': 'agent', 'provider': 'claude'});
    });

    test('send errors say what happened', () async {
      respond = (_) => http.Response(jsonEncode({'error': 'no_target'}), 409);
      expect((await api.send(const SendRequest(items: [TextItem('x')]))).error, contains('Pick where it goes'));
      respond = (_) => http.Response(jsonEncode({'error': 'no_window'}), 503);
      expect((await api.send(const SendRequest(items: [TextItem('x')]))).error, contains('no window'));
      respond = (_) => http.Response('', 504);
      expect((await api.send(const SendRequest(items: [TextItem('x')]))).error, 'Lee did not answer in time.');
    });

    test('a Page asset: only assets/<name>, fetched with the token', () async {
      expect(api.assetUri('pg-1', 'https://example.com/x.png'), isNull);
      expect(api.assetUri('pg-1', 'assets/../secret'), isNull);
      final uri = api.assetUri('pg-1', 'assets/a1.png')!;
      expect(uri.path, '/tether/pages/pg-1/assets/a1.png');
      respond = (_) => http.Response.bytes([9, 9], 200);
      expect(await api.fetchAsset(uri), [9, 9]);
      expect(requests.single.headers['Authorization'], 'Bearer t');
    });
  });

  group('Send to Lee', () {
    test('targets: focus first, the rest without it, boards never offered', () {
      final targets = SendTargets.fromJson({
        'focus': {'kind': 'page', 'card_id': 'pg-1', 'title': 'Taxonomy'},
        'targets': [
          {'kind': 'page', 'card_id': 'pg-1', 'title': 'Taxonomy'},
          {'kind': 'hester'},
          {'kind': 'tab', 'pty_id': 3, 'label': 'zsh', 'tab_kind': 'terminal', 'provider': null},
          {'kind': 'board', 'card_id': 'bd-1', 'title': 'Board'},
          {'kind': 'mystery'},
        ],
      });
      expect(targets.all.map((t) => t.name), ['Taxonomy', 'Hester', 'zsh']);
      expect(focusPhrase(targets.focus!), "the Page you're on");
      expect(targets.focus!.canSubmit, isFalse);
      expect(targets.all[1].canSubmit, isTrue);
    });

    test('sendProblem: Pages take Deliver only; Send needs text; limits', () {
      const page = SendTarget.page(cardId: 'pg-1', title: 'T');
      const tab = SendTarget.tab(ptyId: 1, label: 'zsh', tabKind: 'terminal');
      final image = ImageItem(mime: 'image/jpeg', bytes: Uint8List(4), source: ImageSourceKind.photo);
      expect(sendProblem(const [TextItem('x')], submit: true, target: page), 'A Page takes Deliver only.');
      expect(sendProblem(const [TextItem('x')], submit: false, target: page), isNull);
      expect(sendProblem([image], submit: true, target: tab), contains('needs some text'));
      expect(sendProblem([image], submit: false, target: tab), isNull);
      expect(sendProblem(const [], submit: false, target: tab), isNotNull);
      expect(sendProblem(List.filled(5, const TextItem('x')), submit: false, target: tab), contains('Up to 4'));
      expect(sendProblem([TextItem('x' * 20001)], submit: false, target: tab), contains('too long'));
    });
  });
}
