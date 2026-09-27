import 'package:flutter_test/flutter_test.dart';

import 'package:aeronaut/models/activity.dart';
import 'package:aeronaut/models/attention.dart';

/// The Dart port of `describeActivity`, `formatTokens` and `workLine`
/// (electron/src/shared/cockpit.ts, renderer/lib/cockpitModel.ts): the same
/// table, both tenses, and the cd-stripping for Bash.
void main() {
  group('describeActivity', () {
    String now(String tool, {String preview = '', List<String> files = const [], bool failed = false}) =>
        describeActivity(tool: tool, preview: preview, files: files, failed: failed);
    String past(String tool, {String preview = '', List<String> files = const []}) =>
        describeActivity(tool: tool, preview: preview, files: files, tense: ActivityTense.past);

    test('edits and reads name the file, or count several', () {
      expect(now('Edit', files: ['/repo/src/main.ts']), 'Editing main.ts');
      expect(now('Write', files: ['a.ts', 'b.ts', 'c.ts']), 'Editing 3 files');
      expect(past('MultiEdit', files: ['/x/y.dart']), 'Edited y.dart');
      expect(now('NotebookEdit', preview: '/x/nb.ipynb'), 'Editing nb.ipynb');
      expect(now('Read', files: ['/repo/README.md']), 'Reading README.md');
      expect(now('Read', files: ['a', 'b']), 'Reading 2 files');
      expect(past('Read', files: ['/repo/a.md']), 'Read a.md');
      expect(now('Edit'), 'Editing');
      expect(now('Read', preview: '/repo/dir/'), 'Reading dir');
    });

    test('search adds a short pattern, never a path or JSON', () {
      expect(now('Grep', preview: 'TODO'), 'Searching for TODO');
      expect(now('Glob', preview: '/repo/**/*.ts'), 'Searching');
      expect(now('Grep', preview: '{"pattern":"x"}'), 'Searching');
      expect(now('Grep', preview: 'x' * 31), 'Searching');
      expect(now('Grep', preview: 'Grep'), 'Searching');
      expect(past('Grep', preview: 'needle'), 'Searched for needle');
    });

    test('Bash: tests, builds, git, else the first word, after any leading cd', () {
      expect(now('Bash', preview: 'npm test'), 'Running tests');
      expect(now('Bash', preview: 'cd electron && npm run build'), 'Building');
      expect(now('Bash', preview: 'cd "/a b" && cd c; pytest -q'), 'Running tests');
      expect(now('Bash', preview: 'git status && npm test'), 'Using git');
      expect(now('Bash', preview: 'idf.py build'), 'Building');
      expect(now('Bash', preview: 'npx tsc --noEmit'), 'Building');
      expect(now('Bash', preview: 'FOO=1 /usr/bin/ls -la'), 'Running ls');
      expect(now('Bash', preview: ''), 'Running a command');
      expect(now('Bash', preview: 'cd /repo'), 'Running cd', reason: 'nothing follows the cd, so it stays');
      expect(past('Bash', preview: 'cd x && make smoke'), 'Ran tests');
      expect(past('Bash', preview: 'git push'), 'Used git');
      expect(past('Bash', preview: 'ls'), 'Ran ls');
      expect(past('Bash', preview: 'npm run dist'), 'Built');
    });

    test('stripLeadingCd', () {
      expect(stripLeadingCd('cd /a && cd b; npm test'), 'npm test');
      expect(stripLeadingCd("cd 'x y' && ls"), 'ls');
      expect(stripLeadingCd('cd /a'), 'cd /a');
      expect(stripLeadingCd('ls'), 'ls');
    });

    test('web, subagents, questions, anything else, and failures', () {
      expect(now('WebFetch'), 'Reading the web');
      expect(past('WebSearch'), 'Read the web');
      expect(now('Task'), 'Working with a subagent');
      expect(past('Agent'), 'Worked with a subagent');
      expect(now('AskUserQuestion'), 'Asking you a question');
      expect(past('AskUserQuestion'), 'Asked you a question');
      expect(now('mcp__foo'), 'mcp__foo');
      expect(now('Edit', files: ['a.ts'], failed: true), 'Editing a.ts (failed)');
    });

    test('describeNow and describePast read the snapshot shapes', () {
      expect(describeNow(const AgentNow(tool: 'Edit', files: ['/r/x.py'])), 'Editing x.py');
      expect(describePast(const AgentActivity(tool: 'Bash', preview: 'pytest', failed: true)), 'Ran tests (failed)');
    });
  });

  group('formatTokens', () {
    test('matches the TypeScript label', () {
      expect(formatTokens(0), '0 tok');
      expect(formatTokens(999), '999 tok');
      expect(formatTokens(1000), '1k tok');
      expect(formatTokens(412345), '412k tok');
      expect(formatTokens(1234567), '1.2M tok');
      expect(formatTokens(12345678), '12M tok');
      expect(formatTokens(-1), '');
    });

    test('usageLine: tokens for a subscription, dollars only for billed or estimated', () {
      expect(usageLine(null), isNull);
      expect(usageLine(const AgentUsage(shownTokens: 0)), isNull);
      expect(usageLine(const AgentUsage(shownTokens: 412000, costUsd: 3.1)), '412k tokens');
      expect(
        usageLine(const AgentUsage(shownTokens: 412000, costBasis: CostBasis.billed, costUsd: 3.1)),
        r'412k tokens · $3.10',
      );
      expect(usageLine(const AgentUsage(shownTokens: 2000, costBasis: CostBasis.estimate)), '2k tokens');
    });
  });

  group('workLine', () {
    test('number words, capitalised, else working, else all clear', () {
      expect(workLine(waiting: 1), 'One thing needs you.');
      expect(workLine(waiting: 2, working: 3), 'Two things need you.');
      expect(workLine(waiting: 12), 'Twelve things need you.');
      expect(workLine(waiting: 13), '13 things need you.');
      expect(workLine(waiting: 0, working: 1), 'Working on it.');
      expect(workLine(waiting: 0), 'All clear.');
      expect(workLine(waiting: -1), 'All clear.');
    });
  });

  group('snapshot fields', () {
    test('agents carry now, recent, updates and usage; the snapshot carries deep and limits', () {
      final snap = AttentionSnapshot.fromJson({
        'items': <dynamic>[],
        'mode': 'deep',
        'deep': {'exploration_id': 'exp_1', 'title': 'Caching'},
        'limits': {
          'five_hour': {'used_pct': 62, 'resets_at': '2026-09-27T15:40:00Z'},
          'as_of': '2026-09-27T12:00:00Z',
        },
        'agents': [
          {
            'pty_id': 3,
            'state': 'busy',
            'now': {'tool': 'Edit', 'preview': 'a.ts', 'files': ['a.ts'], 'since': '2026-09-27T12:00:00Z'},
            'recent': [
              {'at': '2026-09-27T11:59:00Z', 'tool': 'Read', 'preview': 'b.ts', 'files': ['b.ts'], 'writes': false, 'phase': 'post'},
            ],
            'updates': [
              {'at': '2026-09-27T11:50:00Z', 'summary': 'Did it.', 'lee_status': {'status': 'done', 'next': 'Ship'}},
            ],
            'usage': {'tokens': {'input': 10}, 'shown_tokens': 412000, 'cost_basis': 'subscription', 'cost_usd': 3.1},
          },
        ],
      });
      expect(snap.mode, 'deep');
      expect(snap.deep, const DeepSession(explorationId: 'exp_1', title: 'Caching'));
      expect(snap.limits!.fiveHour!.usedPct, 62);
      final a = snap.agents.single;
      expect(a.now!.tool, 'Edit');
      expect(a.recent.single.tool, 'Read');
      expect(a.updates.single.leeStatus!.next, 'Ship');
      expect(a.usage!.shownTokens, 412000);
      expect(a.usage!.costBasis, CostBasis.subscription);
      expect(a.usage!.showsDollars, isFalse);
    });

    test('an older Lee without the new fields still parses', () {
      final snap = AttentionSnapshot.fromJson({
        'agents': [
          {'pty_id': 1, 'state': 'idle', 'now': null, 'usage': null},
        ],
      });
      expect(snap.deep, isNull);
      expect(snap.limits, isNull);
      expect(snap.agents.single.now, isNull);
      expect(snap.agents.single.recent, isEmpty);
      expect(snap.agents.single.usage, isNull);
    });
  });
}
