import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/services/speech_sanitizer.dart';

/// The readback sanitizer's vectors (docs/plans/2026-09-28-tether-review-voice.md §5.5).
void main() {
  group('1. code fences', () {
    test('a fence becomes "a N-line <Language> snippet"', () {
      const md = 'Try this:\n\n```python\nimport os\n\nprint(os.getcwd())\n```\n\nThen run it.';
      expect(sanitizeForSpeech(md), 'Try this: a 2-line Python snippet. Then run it.');
    });

    test('no language, and "an" before 8', () {
      const md = '```\n1\n2\n3\n4\n5\n6\n7\n8\n```';
      expect(sanitizeForSpeech(md), 'an 8-line snippet.');
    });

    test('an unknown language is named as written; ts and sh are spoken', () {
      expect(sanitizeForSpeech('```zig\nconst x = 1;\n```'), 'a 1-line Zig snippet.');
      expect(sanitizeForSpeech('```ts\nlet a = 1;\nlet b = 2;\n```'), 'a 2-line TypeScript snippet.');
      expect(sanitizeForSpeech('```bash\nls\n```'), 'a 1-line shell snippet.');
    });

    test('an unclosed fence (a cut-off answer) still reads as a snippet', () {
      expect(sanitizeForSpeech('Here:\n```js\nfoo();\nbar();'), 'Here: a 2-line JavaScript snippet.');
    });
  });

  group('2. tables, links and URLs', () {
    test('a table becomes "a table with N rows"', () {
      const md = 'Results:\n\n| name | ok |\n|---|:---:|\n| a | yes |\n| b | no |\n| c | yes |\n\nDone.';
      expect(sanitizeForSpeech(md), 'Results: a table with 3 rows. Done.');
    });

    test('one row', () {
      expect(sanitizeForSpeech('| a | b |\n| --- | --- |\n| 1 | 2 |'), 'a table with 1 row.');
    });

    test('a link keeps its text', () {
      expect(sanitizeForSpeech('See [the design notes](https://example.com/notes) first.'), 'See the design notes first.');
    });

    test('a bare URL becomes "a link to <host>"', () {
      expect(sanitizeForSpeech('It is at https://www.github.com/anthropics/foo/pull/12.'), 'It is at a link to github.com.');
      expect(sanitizeForSpeech('Docs: <https://docs.flutter.dev/x>'), 'Docs: a link to docs.flutter.dev.');
    });

    test('an image says so', () {
      expect(sanitizeForSpeech('![the sketch](assets/a1.png)'), 'an image, the sketch.');
    });
  });

  group('3. inline code, paths and identifiers', () {
    test('inline code loses its backticks', () {
      expect(sanitizeForSpeech('Run `flutter test` now.'), 'Run flutter test now.');
    });

    test('paths become basenames', () {
      expect(sanitizeForSpeech('I changed `lib/services/speech_service.dart` and /Users/ben/.lee/api-token.'),
          'I changed speech service.dart and api-token.');
      expect(sanitizeForSpeech('Open ~/Development/Lee/GOALS.md'), 'Open GOALS.md.');
    });

    test('two plain words with a slash are left alone', () {
      expect(sanitizeForSpeech('Use client/server here.'), 'Use client/server here.');
    });

    test('camelCase and snake_case are split', () {
      expect(sanitizeForSpeech('Call appendTranscript from useVoiceInput.'), 'Call append Transcript from use Voice Input.');
      expect(sanitizeForSpeech('Set max_seconds and HESTER_VOICE_ENABLED.'), 'Set max seconds and HESTER VOICE ENABLED.');
      expect(sanitizeForSpeech('The SpeechService queues it.'), 'The Speech Service queues it.');
    });
  });

  group('4. markdown syntax', () {
    test('headings, lists, emphasis and rules are stripped; lines become sentences', () {
      const md = '## Summary\n\n- **Fixed** the *race*\n- Added _two_ tests\n\n---\n\n> Quoted ~~old~~ note';
      expect(sanitizeForSpeech(md), 'Summary. Fixed the race. Added two tests. Quoted old note.');
    });

    test('numbered lists and task boxes', () {
      expect(sanitizeForSpeech('1. First\n2) Second\n- [x] Done thing'), 'First. Second. Done thing.');
    });

    test('plain prose passes through', () {
      expect(sanitizeForSpeech('All clear. Nothing needs you.'), 'All clear. Nothing needs you.');
    });
  });

  group('5. the cut', () {
    test('long text is cut at a sentence boundary and ends "More on screen."', () {
      const sentence = 'This sentence is exactly fifty characters long ok. ';
      final md = List.filled(20, sentence).join();
      final out = sanitizeForSpeech(md);
      expect(out.endsWith(' More on screen.'), isTrue);
      final body = out.substring(0, out.length - ' More on screen.'.length);
      expect(body.endsWith('ok.'), isTrue, reason: 'ends on a whole sentence');
      expect(body.length, lessThanOrEqualTo(speechLimit));
      expect(body.length, greaterThan(speechLimit - sentence.length));
    });

    test('with no sentence end in reach, cut at a word', () {
      final md = List.filled(200, 'word').join(' ');
      final out = sanitizeForSpeech(md);
      expect(out.endsWith('word. More on screen.'), isTrue);
      expect(out.length, lessThanOrEqualTo(speechLimit + ' More on screen.'.length + 1));
    });

    test('short text is never cut', () {
      expect(sanitizeForSpeech('Done.'), 'Done.');
    });
  });
}
