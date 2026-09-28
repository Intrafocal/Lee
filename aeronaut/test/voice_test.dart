import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:aeronaut/models/attention.dart';
import 'package:aeronaut/models/machine.dart';
import 'package:aeronaut/models/voice.dart';
import 'package:aeronaut/providers/machines_provider.dart';
import 'package:aeronaut/providers/speech_provider.dart';
import 'package:aeronaut/providers/voice_provider.dart';
import 'package:aeronaut/services/machine_store.dart';
import 'package:aeronaut/services/speech_service.dart';
import 'package:aeronaut/services/voice_api.dart';
import 'package:aeronaut/services/voice_recorder.dart';
import 'package:aeronaut/theme/aeronaut_theme.dart';
import 'package:aeronaut/widgets/voice_button.dart';

const _machine = Machine(id: 'm1', name: 'Dev', host: '127.0.0.1', token: 't');

class _FixedMachinesNotifier extends MachinesNotifier {
  _FixedMachinesNotifier() : super(MachineStore()) {
    state = const MachinesState(machines: [_machine], activeMachineId: 'm1');
  }
}

/// A recorder that hands back whatever clip the test sets.
class _FakeRecorder implements VoiceRecorder {
  RecordedClip? clip;
  bool permission = true;
  final calls = <String>[];
  final _levels = StreamController<double>.broadcast();

  @override
  Future<bool> hasPermission() async => permission;

  @override
  Stream<double> get levels => _levels.stream;

  @override
  Future<void> start() async => calls.add('start');

  @override
  Future<RecordedClip?> stop() async {
    calls.add('stop');
    return clip;
  }

  @override
  Future<void> cancel() async => calls.add('cancel');

  @override
  Future<void> dispose() async {}
}

class _FakeSpeaker implements Speaker {
  final said = <String>[];
  int stops = 0;

  @override
  Future<void> speak(String text) async => said.add(text);

  @override
  Future<void> stop() async => stops++;
}

RecordedClip _clip({int ms = 1500, double peak = 0.6}) =>
    RecordedClip(wav: Uint8List(44 + ms * 32), duration: Duration(milliseconds: ms), peak: peak);

void main() {
  // Speak replies lives in SharedPreferences.
  setUp(() => SharedPreferences.setMockInitialValues({}));

  group('appendTranscript (mirrors shared/voice.ts)', () {
    test('an empty or blank draft becomes the transcript', () {
      expect(appendTranscript('', 'hello'), (text: 'hello', caret: 5));
      expect(appendTranscript('   ', ' hello '), (text: 'hello', caret: 5));
    });

    test('otherwise a space if needed, caret at the end', () {
      expect(appendTranscript('Fix it', 'and push'), (text: 'Fix it and push', caret: 15));
      expect(appendTranscript('Fix it ', 'and push'), (text: 'Fix it and push', caret: 15));
      expect(appendTranscript('Line\n', 'next'), (text: 'Line\nnext', caret: 9));
    });

    test('a blank transcript leaves the draft alone', () {
      expect(appendTranscript('draft', '  '), (text: 'draft', caret: 5));
    });
  });

  group('wire', () {
    test('error codes from the server, with or without a reason', () {
      expect(VoiceErrorCode.fromWire('voice_unavailable:no_api_key'), VoiceErrorCode.voiceUnavailable);
      expect(VoiceErrorCode.fromWire('too_short'), VoiceErrorCode.tooShort);
      expect(VoiceErrorCode.fromWire('nope'), isNull);
      expect(VoiceErrorCode.fromStatus(413), VoiceErrorCode.tooLarge);
      expect(VoiceErrorCode.fromStatus(504), VoiceErrorCode.timeout);
    });

    test('the cap is the lower of the server and 60 s', () {
      expect(const VoiceCapabilities(maxSeconds: 30).maxDuration, const Duration(seconds: 30));
      expect(const VoiceCapabilities(maxSeconds: 120).maxDuration, const Duration(seconds: 60));
    });

    test('wavDuration reads PCM16 mono 16 kHz', () {
      expect(wavDuration(44 + 32000), const Duration(seconds: 1));
      expect(wavDuration(10), Duration.zero);
    });

    test('POST /voice/transcribe: raw WAV body, purpose and hints in the query', () async {
      late http.Request seen;
      final api = VoiceApi(
        machine: _machine,
        client: MockClient((r) async {
          seen = r;
          return http.Response(jsonEncode({'text': 'ship it', 'provider': 'gemini', 'audio_ms': 1500}), 200);
        }),
      );
      final wav = Uint8List.fromList([82, 73, 70, 70]);
      final out = await api.transcribe(wav, purpose: VoicePurpose.reply, itemId: 'att_1', workspace: '/ws');
      expect(seen.url.toString(), 'http://127.0.0.1:9000/voice/transcribe?purpose=reply&item_id=att_1&workspace=%2Fws');
      expect(seen.headers['Content-Type'], 'audio/wav');
      expect(seen.headers['Authorization'], 'Bearer t');
      expect(seen.bodyBytes, wav);
      expect(out.result!.text, 'ship it');
    });

    test('errors map to codes; GET /voice failures hide the mic', () async {
      final api = VoiceApi(
        machine: _machine,
        client: MockClient((r) async => r.url.path == '/voice'
            ? http.Response('boom', 500)
            : http.Response(jsonEncode({'error': 'voice_unavailable:no_api_key'}), 503)),
      );
      expect((await api.transcribe(Uint8List(0), purpose: VoicePurpose.ask)).error, VoiceErrorCode.voiceUnavailable);
      expect((await api.capabilities()).available, isFalse);
    });
  });

  group('the mic', () {
    late _FakeRecorder recorder;
    late _FakeSpeaker speaker;
    late List<Uint8List> uploads;
    late String transcript;

    Future<ProviderContainer> pump(WidgetTester tester, TextEditingController controller, {bool available = true, List<String>? sent}) async {
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            machinesProvider.overrideWith((ref) => _FixedMachinesNotifier()),
            voiceRecorderFactoryProvider.overrideWithValue(() => recorder),
            speakerFactoryProvider.overrideWithValue(() => speaker),
            voiceApiFactoryProvider.overrideWithValue((m) => VoiceApi(
                  machine: m,
                  client: MockClient((r) async {
                    if (r.url.path == '/voice') {
                      return http.Response(jsonEncode({'enabled': available, 'available': available, 'max_seconds': 60}), 200);
                    }
                    uploads.add(r.bodyBytes);
                    return http.Response(jsonEncode({'text': transcript}), 200);
                  }),
                )),
          ],
          child: MaterialApp(
            theme: AeronautTheme.darkTheme,
            home: Scaffold(
              body: Column(
                children: [
                  Row(
                    children: [
                      Expanded(child: TextField(key: const ValueKey('field'), controller: controller)),
                      VoiceButton(
                        fieldKey: 'f',
                        purpose: VoicePurpose.reply,
                        controller: controller,
                        onTranscript: () => sent?.add('voice'),
                      ),
                    ],
                  ),
                  const VoiceStatusLine(fieldKey: 'f'),
                ],
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return ProviderScope.containerOf(tester.element(find.byType(MaterialApp)));
    }

    setUp(() {
      recorder = _FakeRecorder();
      speaker = _FakeSpeaker();
      uploads = [];
      transcript = 'and push it';
    });

    testWidgets('hidden when Hester says voice is off', (tester) async {
      await pump(tester, TextEditingController(), available: false);
      expect(find.byKey(const ValueKey('voice-f')), findsNothing);
    });

    testWidgets('tap to start, tap to stop: the transcript fills the field and nothing is sent', (tester) async {
      final controller = TextEditingController(text: 'Fix the test');
      final tags = <String>[];
      await pump(tester, controller, sent: tags);
      recorder.clip = _clip();

      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      expect(recorder.calls, ['start']);
      expect(find.textContaining('tap the mic to stop'), findsOneWidget);
      expect(speaker.stops, 0, reason: 'nothing was speaking yet');

      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pumpAndSettle();
      expect(recorder.calls, ['start', 'stop']);
      expect(uploads.single.length, recorder.clip!.wav.length);
      expect(controller.text, 'Fix the test and push it');
      expect(controller.selection.baseOffset, controller.text.length);
      expect(tags, ['voice']);
    });

    testWidgets('too short or silent: never uploaded, says why', (tester) async {
      final controller = TextEditingController();
      await pump(tester, controller);

      recorder.clip = _clip(ms: 200);
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pumpAndSettle();
      expect(uploads, isEmpty);
      expect(find.text('Too short to hear.'), findsOneWidget);

      recorder.clip = _clip(peak: 0.01);
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pumpAndSettle();
      expect(uploads, isEmpty);
      expect(find.text('Nothing heard.'), findsOneWidget);
      expect(controller.text, isEmpty);
    });

    testWidgets('a refused mic says so', (tester) async {
      await pump(tester, TextEditingController());
      recorder.permission = false;
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pumpAndSettle();
      expect(find.text('Allow the microphone in Settings to talk.'), findsOneWidget);
      expect(recorder.calls, isEmpty);
    });

    testWidgets('Cancel discards the clip', (tester) async {
      final controller = TextEditingController();
      await pump(tester, controller);
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('voice-cancel-f')));
      await tester.pumpAndSettle();
      expect(recorder.calls, ['start', 'cancel']);
      expect(uploads, isEmpty);
    });

    testWidgets('one recording at a time', (tester) async {
      final container = await pump(tester, TextEditingController());
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      final second = await container.read(voiceProvider.notifier).start(
            'other',
            purpose: VoicePurpose.capture,
            onTranscript: (_) {},
          );
      expect(second, isFalse);
      await container.read(voiceProvider.notifier).cancel();
    });

    testWidgets('recording stops readback', (tester) async {
      final container = await pump(tester, TextEditingController());
      final speech = container.read(speechProvider.notifier);
      speech.readHesterAnswer('x'); // creates the speaker (toggle is off, so silent)
      await speech.setEnabled(true);
      speech.readHesterAnswer('Done.');
      expect(speaker.said, ['Done.']);
      await tester.tap(find.byKey(const ValueKey('voice-f')));
      await tester.pump();
      expect(speaker.stops, greaterThan(0));
      await container.read(voiceProvider.notifier).cancel();
    });
  });

  group('readback', () {
    test('an approval reads its title only, then "Approve or deny on screen."', () {
      final approval = AttentionItem.fromJson({
        'id': 'a1',
        'kind': 'approval',
        'title': 'Allow Bash: rm -rf build',
        'text': 'long details',
        'source': {'kind': 'agent', 'provider': 'claude', 'pty_id': 3, 'tab_label': 'api'},
        'actions': ['approve', 'deny'],
      });
      expect(readbackLine(approval), 'Claude, in api: Allow Bash: rm -rf build. Approve or deny on screen.');
    });

    test('anything else reads its text, sanitized', () {
      final item = AttentionItem.fromJson({
        'id': 'w1',
        'kind': 'waiting',
        'title': 'Tests pass',
        'text': 'I changed `lib/foo_bar.dart`. See https://github.com/x/y.',
        'source': {'kind': 'agent', 'provider': 'claude', 'pty_id': 3, 'tab_label': 'api'},
        'actions': ['reply'],
      });
      expect(readbackLine(item), 'Claude, in api: Tests pass. I changed foo bar.dart. See a link to github.com.');
    });

    test('only agents you replied to by voice, only with the toggle on, only in front', () async {
      final speaker = _FakeSpeaker();
      var front = true;
      final container = ProviderContainer(overrides: [
        speakerFactoryProvider.overrideWithValue(() => speaker),
        isForegroundProvider.overrideWithValue(() => front),
      ]);
      addTearDown(container.dispose);
      final speech = container.read(speechProvider.notifier);
      AttentionItem item(int pty) => AttentionItem.fromJson({
            'id': 'i$pty',
            'kind': 'waiting',
            'title': 'Done',
            'source': {'kind': 'agent', 'pty_id': pty},
            'actions': ['reply'],
          });

      speech.noteVoiceReply(3);
      speech.readAttentionItem(item(3));
      expect(speaker.said, isEmpty, reason: 'toggle off');

      speech.autoEnableFromVoice();
      await Future<void>.delayed(Duration.zero);
      speech.readAttentionItem(item(4));
      expect(speaker.said, isEmpty, reason: 'not replied to by voice');
      speech.readAttentionItem(item(3));
      expect(speaker.said, ['Claude: Done.']);

      front = false;
      speech.readAttentionItem(item(3));
      expect(speaker.said.length, 1, reason: 'never from the background');
    });
  });
}
