import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:aeronaut/models/lee_context.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/send_to_lee.dart';
import 'package:aeronaut/providers/keys_mode_provider.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/providers/tether_provider.dart';
import 'package:aeronaut/screens/terminal_screen.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/services/tether_api.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/composer.dart';
import 'package:aeronaut/widgets/send_to_lee_sheet.dart';

/// A 1×1 transparent PNG.
final _png = base64Decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// A fake Lee: `GET /tether/targets` and `POST /tether/send`.
class _FakeLee {
  final sends = <Map<String, dynamic>>[];
  int sendStatus = 200;

  late final client = MockClient((r) async {
    if (r.url.path == '/tether/targets') {
      return http.Response(
        jsonEncode({
          'success': true,
          'data': {
            'focus': {'kind': 'page', 'card_id': 'pg-1', 'title': 'Taxonomy'},
            'targets': [
              {'kind': 'hester'},
              {'kind': 'tab', 'pty_id': 7, 'label': 'Claude', 'tab_kind': 'agent', 'provider': 'claude'},
            ],
          },
        }),
        200,
      );
    }
    if (r.url.path == '/tether/send') {
      final body = jsonDecode(r.body) as Map<String, dynamic>;
      sends.add(body);
      if (sendStatus != 200) return http.Response(jsonEncode({'error': 'no_target'}), sendStatus);
      return http.Response(jsonEncode({'success': true, 'data': {'send_id': 's${sends.length}', 'delivered_to': body['target']}}), 200);
    }
    return http.Response('not found', 404);
  });
}

Future<void> _pump(WidgetTester tester, _FakeLee lee, Widget home, {ImagePick? pick}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
        tetherApiFactoryProvider.overrideWithValue((m) => TetherApi(machine: m, client: lee.client)),
        if (pick != null) imagePickProvider.overrideWithValue(pick),
      ],
      child: MaterialApp(theme: AeronautTheme.darkTheme, home: home),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  setUp(() => SharedPreferences.setMockInitialValues({}));

  testWidgets('the sheet aims at Lee\'s focus; a Page takes Deliver only', (tester) async {
    final lee = _FakeLee();
    await _pump(tester, lee, const Scaffold(body: Center(child: SendToLeeButton())));
    await tester.tap(find.byKey(const ValueKey('send-to-lee')));
    await tester.pumpAndSettle();

    expect(find.text("To: Taxonomy (the Page you're on)"), findsOneWidget);
    expect(find.byKey(const ValueKey('deliver-send-to-lee')), findsOneWidget);
    expect(find.byKey(const ValueKey('send-send-to-lee')), findsNothing, reason: 'a Page has only Deliver');

    await tester.enterText(find.byKey(const ValueKey('compose-send-to-lee')), 'Group these by owner.');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('deliver-send-to-lee')));
    await tester.pumpAndSettle();

    expect(lee.sends.single['target'], {'kind': 'page', 'card_id': 'pg-1', 'title': 'Taxonomy'});
    expect(lee.sends.single['items'], [
      {'kind': 'text', 'text': 'Group these by owner.'},
    ]);
    expect(lee.sends.single.containsKey('submit'), isFalse);
    expect(find.text('Delivered to Taxonomy'), findsOneWidget);
    expect(find.byKey(const ValueKey('compose-send-to-lee')), findsNothing, reason: 'the sheet closes');
  });

  testWidgets('pick a tab: Send submits; attached images ride along', (tester) async {
    final lee = _FakeLee();
    await _pump(
      tester,
      lee,
      const Scaffold(body: Center(child: SendToLeeButton())),
      pick: (context, kind) async => ImageItem(mime: 'image/png', bytes: _png, source: kind),
    );
    await tester.tap(find.byKey(const ValueKey('send-to-lee')));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const ValueKey('send-to-lee-pick')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('target-tab-7')));
    await tester.pumpAndSettle();
    expect(find.text('To: Claude (claude agent)'), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('choice-scribble')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('attached-0')), findsOneWidget);

    await tester.enterText(find.byKey(const ValueKey('compose-send-to-lee')), 'Fix the flaky test');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('send-send-to-lee')));
    await tester.pumpAndSettle();

    final sent = lee.sends.single;
    expect(sent['submit'], isTrue);
    expect((sent['target'] as Map)['pty_id'], 7);
    expect((sent['items'] as List).map((i) => (i as Map)['kind']), ['text', 'image']);
    expect(((sent['items'] as List)[1] as Map)['source'], 'scribble');
    expect(find.text('Sent to Claude'), findsOneWidget);
  });

  testWidgets('a failed send keeps the words and says why', (tester) async {
    final lee = _FakeLee()..sendStatus = 409;
    await _pump(
      tester,
      lee,
      const Scaffold(
        body: Composer(target: SendTarget.tab(ptyId: 3, label: 'zsh', tabKind: 'terminal'), fieldKey: 't', compact: true),
      ),
    );
    await tester.enterText(find.byKey(const ValueKey('compose-t')), 'ls -la');
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('deliver-t')));
    await tester.pumpAndSettle();
    expect(find.text('ls -la'), findsOneWidget);
    expect(find.byKey(const ValueKey('compose-error-t')), findsOneWidget);
  });

  testWidgets('Send stays off until there is text', (tester) async {
    final lee = _FakeLee();
    await _pump(
      tester,
      lee,
      const Scaffold(body: Composer(target: SendTarget.hester(), fieldKey: 'h')),
    );
    await tester.tap(find.byKey(const ValueKey('send-h')));
    await tester.pumpAndSettle();
    expect(lee.sends, isEmpty, reason: 'disabled with no text');
  });

  group('tab view', () {
    test('a tab is its own target, by kind', () {
      const claude = TabContext(id: 2, type: TabType.claude, label: 'Claude', ptyId: 7);
      const zsh = TabContext(id: 3, type: TabType.terminal, label: 'zsh', ptyId: 8);
      const lazygit = TabContext(id: 4, type: TabType.git, label: 'Git', ptyId: 9);
      expect(tabTarget(claude).toJson(), {'kind': 'tab', 'pty_id': 7, 'label': 'Claude', 'tab_kind': 'agent', 'provider': 'claude'});
      expect(tabTarget(zsh).tabKind, 'terminal');
      expect(tabTarget(lazygit).tabKind, 'tui');
    });

    test('Keys is remembered per tab', () async {
      final container = ProviderContainer();
      addTearDown(container.dispose);
      final keys = container.read(keysModeProvider.notifier);
      await keys.setKeys(keysModeKey('m1', 9), true);
      expect(container.read(keysModeProvider), ['m1:9']);
      final prefs = await SharedPreferences.getInstance();
      expect(prefs.getStringList('keys_mode_tabs'), ['m1:9']);
      await keys.setKeys(keysModeKey('m1', 9), false);
      expect(container.read(keysModeProvider), isEmpty, reason: 'back to Compose, the default');
    });
  });
}
